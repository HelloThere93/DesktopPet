import WebSocket from 'ws';
import { OperationCancelledError, throwIfAborted } from '../abort';
import { getValidTokens } from '../auth/oauth';
import { boundedWebSocketText, parseJsonRecord, readBoundedResponseText } from './response-bounds';
import { redactSecrets } from '../redaction';

/**
 * Feature-detects a realtime voice endpoint reachable with the user's ChatGPT
 * subscription token.
 *
 * The public Realtime API on api.openai.com requires a platform API key, but
 * Codex clients have their own realtime path gated on a paid ChatGPT plan, and
 * the documentation does not say which hosts that lives on. Rather than guess,
 * ask each candidate and report exactly what it says — a 101 means voice is
 * possible, a 401/403 means the token is not accepted there, and a 404 means
 * the path is wrong.
 */

/** [url, whether to send the deprecated beta shape header] */
const WS_CANDIDATES: [string, boolean][] = [
  // GA shape first: the beta shape was sunset 2026-06-03 and now refuses with
  // beta_api_shape_disabled even when the token itself is accepted.
  ['wss://api.openai.com/v1/realtime?model=gpt-realtime', false],
  ['wss://api.openai.com/v1/realtime?model=gpt-realtime-2', false],
  ['wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', false],
  ['wss://chatgpt.com/backend-api/codex/realtime', false],
];

/** Endpoints that might mint a short-lived session for a realtime connection. */
const SESSION_CANDIDATES = [
  'https://api.openai.com/v1/audio/speech',
  'https://api.openai.com/v1/audio/transcriptions',
];

export const MAX_REALTIME_PROBE_DETAIL_CHARS = 2_000;

export function normaliseRealtimeProbeDetail(value: unknown, fallback = 'Realtime probe failed.'): string {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : fallback;
  return redactSecrets(text).replace(/\s+/g, ' ').slice(0, MAX_REALTIME_PROBE_DETAIL_CHARS);
}

export function realtimeMessageType(text: string): string {
  const parsed = parseJsonRecord(text);
  return typeof parsed?.type === 'string' ? parsed.type.slice(0, 120) : '';
}

export interface RealtimeProbe {
  url: string;
  kind: 'websocket' | 'session';
  status: string;
  detail: string;
}

function closeProbeSocket(ws: WebSocket | null): void {
  try {
    ws?.close();
  } catch {
    /* already closing */
  }
}

function destroyProbeResponse(response: { destroy?: () => void } | null): void {
  try {
    response?.destroy?.();
  } catch {
    /* the HTTP response may already be closed */
  }
}

function probeSocket(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<RealtimeProbe> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let onAbort: () => void = () => {};
    let pendingResponse: { destroy?: () => void } | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      destroyProbeResponse(pendingResponse);
      pendingResponse = null;
      closeProbeSocket(ws);
    };
    const finish = (status: string, detail: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        url,
        kind: 'websocket',
        status: normaliseRealtimeProbeDetail(status, 'error').slice(0, 80),
        detail: normaliseRealtimeProbeDetail(detail),
      });
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OperationCancelledError());
    };
    onAbort = cancel;
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }

    const armTimeout = (durationMs: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => finish('timeout', 'no response in ' + Math.round(durationMs / 1000) + 's'),
        durationMs,
      );
    };

    try {
      ws = new WebSocket(url, { headers, handshakeTimeout: 12_000 });
    } catch (error) {
      finish('error', normaliseRealtimeProbeDetail(error));
      return;
    }

    // A 101 alone proves nothing: the server can accept the upgrade and then
    // immediately send an auth error. Wait for what it actually says.
    ws.on('open', () => {
      if (!settled) armTimeout(6_000);
    });
    ws.on('message', (raw) => {
      if (settled) return;
      try {
        const text = boundedWebSocketText(raw, 2_000) ?? '';
        const type = realtimeMessageType(text);
        const ok = type === 'session.created' || type === 'session.updated';
        finish(ok ? 'READY' : '101-error', (type || 'message') + ': ' + text.slice(0, 400));
      } catch (error) {
        finish('error', normaliseRealtimeProbeDetail(error));
      }
    });
    // ws surfaces the HTTP status when the upgrade is refused.
    ws.on('unexpected-response', (_req, res) => {
      pendingResponse = res;
      let body = '';
      res.on('data', (c: Buffer) => {
        const remaining = 2_000 - body.length;
        if (remaining > 0) body += c.subarray(0, remaining).toString('utf8');
      });
      res.on('end', () => {
        pendingResponse = null;
        finish(String(res.statusCode), body.slice(0, 180).replace(/\s+/g, ' '));
      });
      res.on('error', (error) => {
        pendingResponse = null;
        finish('error', normaliseRealtimeProbeDetail(error));
      });
    });
    ws.on('error', (error) => finish('error', normaliseRealtimeProbeDetail(error)));
    ws.on('close', () => {
      if (!settled) finish('closed', 'connection closed before a realtime response');
    });
    armTimeout(13_000);
  });
}
export function probeRealtimeSocket(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<RealtimeProbe> {
  return probeSocket(url, headers, signal);
}

export async function probeRealtime(signal?: AbortSignal): Promise<RealtimeProbe[]> {
  throwIfAborted(signal);
  const tokens = await getValidTokens(signal);
  throwIfAborted(signal);
  if (!tokens) return [{ url: '-', kind: 'websocket', status: 'no-auth', detail: 'Not signed in.' }];

  const base: Record<string, string> = {
    Authorization: 'Bearer ' + tokens.accessToken,
    originator: 'codex_cli_rs',
  };
  if (tokens.accountId) base['chatgpt-account-id'] = tokens.accountId;

  const websocketResults = Promise.all(
    WS_CANDIDATES.map(([url, beta]) => {
      throwIfAborted(signal);
      const headers = beta ? { ...base, 'OpenAI-Beta': 'realtime=v1' } : base;
      return probeSocket(url, headers, signal);
    }),
  );
  const sessionResults = Promise.all(
    SESSION_CANDIDATES.map(async (url): Promise<RealtimeProbe> => {
      throwIfAborted(signal);
      try {
        const timeout = AbortSignal.timeout(12_000);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const res = await fetch(url, {
          method: 'POST',
          headers: { ...base, 'Content-Type': 'application/json' },
          signal: requestSignal,
          body: JSON.stringify(
            url.endsWith('/speech')
              ? { model: 'gpt-4o-mini-tts', voice: 'marin', input: 'hello' }
              : { model: 'whisper-1' },
          ),
        });
        const text = await readBoundedResponseText(res, 4_000, requestSignal);
        return {
          url,
          kind: 'session',
          status: String(res.status),
          detail: text.slice(0, 180).replace(/\s+/g, ' '),
        };
      } catch (error) {
        throwIfAborted(signal);
        return { url, kind: 'session', status: 'error', detail: normaliseRealtimeProbeDetail(error) };
      }
    }),
  );

  const [websockets, sessions] = await Promise.all([websocketResults, sessionResults]);
  return [...websockets, ...sessions];
}
