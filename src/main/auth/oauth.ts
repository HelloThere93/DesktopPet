import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readBoundedResponseText } from '../model/response-bounds';
import { isOperationCancellation, throwIfAborted, waitWithAbort } from '../abort';
import { shell } from 'electron';
import { loadTokens, saveTokens, clearTokens, type StoredTokens } from './store';

/**
 * ChatGPT-subscription OAuth, matching the Codex CLI's public client.
 *
 * This is the flow that lets the app run against the user's existing ChatGPT
 * plan instead of a separately-billed platform API key. The client is public
 * (no secret), so PKCE is what actually secures the code exchange.
 */
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPES = 'openid profile email offline_access';

/** Refresh this long before nominal expiry so a slow request never races it. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_TOKEN_FIELD_CHARS = 16_000;
const MAX_JWT_PAYLOAD_CHARS = 32_000;
const MAX_CLAIM_CHARS = 1_000;
const MAX_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

export class TokenPersistenceError extends Error {
  constructor() {
    super('Refreshed credentials could not be persisted; existing credentials were retained.');
    this.name = 'TokenPersistenceError';
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedClaimString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= MAX_CLAIM_CHARS ? text : undefined;
}

/** Decode a JWT payload without verifying — we only read claims we already trust. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part || part.length > MAX_JWT_PAYLOAD_CHARS) return {};
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (json.length > MAX_JWT_PAYLOAD_CHARS) return {};
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The account id lives in a namespaced auth claim rather than at the top level.
 * Fall back across the shapes seen in the wild so a claim rename doesn't hard-fail.
 */
function extractAccountId(accessToken: string): string | undefined {
  const p = decodeJwtPayload(accessToken);
  const authValue = p['https://api.openai.com/auth'] ?? p['auth'];
  const auth = isRecord(authValue) ? authValue : undefined;
  const candidates = [
    auth?.['chatgpt_account_id'],
    auth?.['account_id'],
    p['chatgpt_account_id'],
    p['account_id'],
  ];
  for (const candidate of candidates) {
    const value = boundedClaimString(candidate);
    if (value) return value;
  }
  return undefined;
}

function extractEmail(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const p = decodeJwtPayload(idToken);
  return boundedClaimString(p.email);
}

/**
 * The plan on the token decides which models the Codex backend will serve, so
 * surfacing it turns "model not supported" into an answerable question.
 */
export function inspectToken(accessToken: string): Record<string, unknown> {
  const p = decodeJwtPayload(accessToken);
  const authValue = p['https://api.openai.com/auth'] ?? p['auth'];
  const auth = isRecord(authValue) ? authValue : undefined;
  const planType = boundedClaimString(auth?.['chatgpt_plan_type'] ?? auth?.['plan_type']);
  const subscriptionPlan = boundedClaimString(auth?.['chatgpt_subscription_plan']);
  const accountId = boundedClaimString(auth?.['chatgpt_account_id'] ?? auth?.['account_id']);
  return {
    planType: planType ?? null,
    subscriptionPlan: subscriptionPlan ?? null,
    accountId: accountId ?? null,
    authClaimKeys: auth ? Object.keys(auth).slice(0, 100) : [],
    topLevelClaimKeys: Object.keys(p).slice(0, 100),
    scope: boundedClaimString(p.scope) ?? null,
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

function tokenField(value: unknown, label: string, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error('Token endpoint did not return an access token.');
    return undefined;
  }
  if (typeof value !== 'string') throw new Error('Token endpoint returned an invalid ' + label + '.');
  const text = value.trim();
  if (!text || text.length > MAX_TOKEN_FIELD_CHARS) throw new Error('Token endpoint returned an invalid ' + label + '.');
  return text;
}

export function normaliseTokenResponse(value: unknown): TokenResponse {
  if (!isRecord(value)) throw new Error('Token endpoint returned malformed token data.');
  const access_token = tokenField(value.access_token, 'access token', true)!;
  const refresh_token = tokenField(value.refresh_token, 'refresh token', false);
  const id_token = tokenField(value.id_token, 'id token', false);
  let expires_in: number | undefined;
  const rawExpires = value.expires_in;
  if (rawExpires !== undefined && rawExpires !== null) {
    if (typeof rawExpires !== 'number' || !Number.isFinite(rawExpires) || rawExpires <= 0 || rawExpires > MAX_TOKEN_LIFETIME_SECONDS) {
      throw new Error('Token endpoint returned an invalid expiration.');
    }
    expires_in = Math.max(1, Math.floor(rawExpires));
  }
  const token_type = tokenField(value.token_type, 'token type', false);
  const result: TokenResponse = { access_token };
  if (refresh_token !== undefined) result.refresh_token = refresh_token;
  if (id_token !== undefined) result.id_token = id_token;
  if (expires_in !== undefined) result.expires_in = expires_in;
  if (token_type !== undefined) result.token_type = token_type;
  return result;
}

async function exchange(body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: requestSignal,
    body: new URLSearchParams(body).toString(),
  });
  const text = await readBoundedResponseText(res, 20_000, requestSignal);
  if (!res.ok) {
    throw new Error(`Token endpoint returned ${res.status}: ${text.slice(0, 500)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Token endpoint returned invalid JSON.');
  }
  return normaliseTokenResponse(parsed);
}

function toStored(t: TokenResponse, previousRefresh?: string): StoredTokens {
  const refresh = t.refresh_token ?? previousRefresh;
  if (!refresh) {
    // Without a refresh token the session dies in an hour with no way back.
    throw new Error('No refresh token returned — cannot maintain a session.');
  }
  return {
    accessToken: t.access_token,
    refreshToken: refresh,
    idToken: t.id_token,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(t.access_token),
    email: extractEmail(t.id_token),
  };
}


export function escapeHtml(value: string): string {
  return value.replace(/[&<>"\']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}
/** Minimal success/failure pages so the browser tab isn't left blank. */
function resultPage(ok: boolean, detail = ''): string {
  const title = ok ? 'Signed in' : 'Sign-in failed';
  const body = ok
    ? 'You can close this tab and go back to your pet.'
    : `Something went wrong: ${escapeHtml(detail.slice(0, 500))}`;
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;
background:#111;color:#eee"><div style="text-align:center">
<h1 style="font-size:20px">${title}</h1><p style="opacity:.7">${body}</p></div></body>`;
}

export function canCommitOAuthCallback(settled: boolean, responseEnded: boolean): boolean {
  return !settled && !responseEnded;
}

export function canCommitCredentialRefresh(startGeneration: number, currentGeneration: number): boolean {
  return startGeneration === currentGeneration;
}

class SupersededTokenRefreshError extends Error {
  constructor() {
    super('Token refresh was superseded by a credential change.');
    this.name = 'SupersededTokenRefreshError';
  }
}

let credentialGeneration = 0;
let inFlightRefresh: Promise<StoredTokens> | null = null;
let activeServer: Server | null = null;
let serverClosing: Promise<void> | null = null;
let cancelActiveSignIn: (() => void) | null = null;

function closeCallbackServer(server: Server): void {
  if (activeServer === server) activeServer = null;
  if (!server.listening) return;

  let resolveClosing!: () => void;
  const closing = new Promise<void>((resolve) => {
    resolveClosing = resolve;
  });
  serverClosing = closing;
  const finishClosing = () => {
    resolveClosing();
    if (serverClosing === closing) serverClosing = null;
  };
  try {
    server.close(finishClosing);
  } catch {
    finishClosing();
  }
}

/**
 * Runs the full interactive login. Opens the system browser, waits for the
 * loopback callback, exchanges the code, and persists encrypted tokens.
 */
export async function signIn(): Promise<StoredTokens> {
  if (activeServer || serverClosing) {
    throw new Error('A sign-in is already in progress.');
  }

  const { verifier, challenge } = makePkce();
  const state = base64url(randomBytes(32));

  const tokens = await new Promise<StoredTokens>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error('Sign-in timed out after 5 minutes.')),
      5 * 60 * 1000,
    );
    const cancelController = new AbortController();
    let settled = false;

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);
      res.setHeader('Connection', 'close');
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404).end('Not found');
        return;
      }

      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      // Reject before touching the code: a mismatched state means this
      // callback did not originate from the request we just made.
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(resultPage(false, 'state mismatch'));
        finish(new Error('OAuth state mismatch — aborting.'));
        return;
      }
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(resultPage(false, err));
        finish(new Error(`Authorization denied: ${err}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(resultPage(false, 'no code'));
        finish(new Error('No authorization code in callback.'));
        return;
      }

      try {
        const t = await exchange({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }, cancelController.signal);
        if (!canCommitOAuthCallback(settled, res.writableEnded)) {
          if (!res.writableEnded) res.writeHead(409, { 'Content-Type': 'text/html' }).end(resultPage(false, 'sign-in cancelled'));
          return;
        }
        const stored = toStored(t);
        credentialGeneration += 1;
        inFlightRefresh = null;
        saveTokens(stored);
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(resultPage(true));
        finish(null, stored);
      } catch (e) {
        if (settled) {
          if (!res.writableEnded) res.writeHead(409, { 'Content-Type': 'text/html' }).end(resultPage(false, 'sign-in cancelled'));
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(500, { 'Content-Type': 'text/html' }).end(resultPage(false, msg));
        finish(e instanceof Error ? e : new Error(msg));
      }
    });

    function finish(error: Error | null, value?: StoredTokens) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancelActiveSignIn = null;
      if (error && !cancelController.signal.aborted) cancelController.abort(error);
      closeCallbackServer(server);
      if (error) reject(error);
      else resolve(value!);
    }

    cancelActiveSignIn = () => {
      cancelController.abort(new Error('Sign-in cancelled.'));
      finish(new Error('Sign-in cancelled.'));
    };
    activeServer = server;
    server.on('error', (e) => finish(e));
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      if (settled) return;
      const auth = new URL(AUTHORIZE_URL);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('client_id', CLIENT_ID);
      auth.searchParams.set('redirect_uri', REDIRECT_URI);
      auth.searchParams.set('scope', SCOPES);
      auth.searchParams.set('code_challenge', challenge);
      auth.searchParams.set('code_challenge_method', 'S256');
      auth.searchParams.set('state', state);
      // Asks the consent screen to surface org/plan selection where relevant.
      auth.searchParams.set('id_token_add_organizations', 'true');
      void shell.openExternal(auth.toString()).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  });

  return tokens;
}

export function cancelSignIn(): void {
  cancelActiveSignIn?.();
  if (activeServer) closeCallbackServer(activeServer);
}

async function refresh(current: StoredTokens, startGeneration: number): Promise<StoredTokens> {
  const t = await exchange({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: current.refreshToken,
    scope: SCOPES,
  });
  if (!canCommitCredentialRefresh(startGeneration, credentialGeneration)) {
    throw new SupersededTokenRefreshError();
  }
  const next = toStored(t, current.refreshToken);
  try {
    saveTokens(next);
  } catch {
    throw new TokenPersistenceError();
  }
  return next;
}

function beginRefresh(current: StoredTokens, startGeneration: number): Promise<StoredTokens> {
  if (inFlightRefresh) return inFlightRefresh;
  const promise = refresh(current, startGeneration);
  inFlightRefresh = promise;
  void promise.then(
    () => {
      if (inFlightRefresh === promise) inFlightRefresh = null;
    },
    () => {
      if (inFlightRefresh === promise) inFlightRefresh = null;
    },
  );
  return promise;
}

/**
 * Returns a token guaranteed usable right now, refreshing ahead of expiry.
 * Concurrent callers share one in-flight refresh rather than racing.
 */
export async function getValidTokens(signal?: AbortSignal): Promise<StoredTokens | null> {
  throwIfAborted(signal);
  const current = loadTokens();
  if (!current) return null;

  if (Date.now() < current.expiresAt - REFRESH_SKEW_MS) return current;

  const startGeneration = credentialGeneration;
  const refreshPromise = beginRefresh(current, startGeneration);
  try {
    return await waitWithAbort(refreshPromise, signal);
  } catch (error) {
    if (error instanceof SupersededTokenRefreshError) return null;
    if (isOperationCancellation(error) || error instanceof TokenPersistenceError) throw error;
    if (!canCommitCredentialRefresh(startGeneration, credentialGeneration)) return null;
    // Refresh token itself is dead (revoked, or session went stale after
    // ~8 days idle). Drop it so the UI prompts for a clean re-auth.
    clearTokens();
    return null;
  }
}
/** Called after a 401 to force a refresh even if we thought the token was fine. */
export async function forceRefresh(signal?: AbortSignal): Promise<StoredTokens | null> {
  throwIfAborted(signal);
  const current = loadTokens();
  if (!current) return null;
  const startGeneration = credentialGeneration;
  try {
    return await waitWithAbort(beginRefresh(current, startGeneration), signal);
  } catch (error) {
    if (error instanceof SupersededTokenRefreshError) return null;
    if (isOperationCancellation(error)) throw error;
    if (error instanceof TokenPersistenceError) throw error;
    if (!canCommitCredentialRefresh(startGeneration, credentialGeneration)) return null;
    clearTokens();
    return null;
  }
}
/**
 * Invalidates a shared token refresh without deleting the stored credential.
 * The underlying request may finish, but its result can no longer be persisted.
 */
export function cancelCredentialRefresh(): void {
  credentialGeneration += 1;
  inFlightRefresh = null;
}

export function signOut(): void {
  cancelCredentialRefresh();
  cancelSignIn();
  clearTokens();
}
