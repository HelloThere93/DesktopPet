import { randomUUID } from 'node:crypto';
import { acquireTab, evaluateInTab, navigate, type BrowserProfile } from './chrome';
import { throwIfAborted, waitWithAbort } from '../abort';
import { runGoogleTabTask } from './google-tab';
import {
  bindGoogleAccount,
  sameGoogleIdentity,
  selectedGoogleAccountLock,
  verifyGoogleAccount,
  type GoogleTabSession,
} from './google';

/**
 * Reading Google Docs, Slides and Sheets properly.
 *
 * Scraping the rendered page is the obvious approach and a bad one: Docs paints
 * to a canvas, Slides only builds the slide you are looking at, and Sheets
 * virtualises rows — so the DOM holds a fraction of the document and you have
 * to scroll to collect the rest, slowly and unreliably.
 *
 * Every one of them has an export endpoint that returns the whole thing as
 * text in a single request. Those need the user's cookies, so the request is
 * issued from inside a logged-in tab rather than from the main process, where
 * it would be anonymous. Same-origin, so the cookies go automatically.
 */

const MAX_INPUT_CHARS = 2_000;
const MAX_QUERY_CHARS = 500;
const MAX_RAW_EXPORT_CHARS = 100_000;
const MAX_RESULTS = 30;
const ABORT_PAGE_TIMEOUT_MS = 2_000;

type DocKind = 'document' | 'presentation' | 'spreadsheets';

interface Target {
  kind: DocKind;
  id: string;
  /** Sheets only: the specific tab, when the URL names one. */
  gid?: string;
}

export interface DriveSearchItem {
  name: string;
  id: string;
}

const MAX_DRIVE_NAME_CHARS = 160;
const MAX_DRIVE_ID_CHARS = 200;

export function normaliseDriveSearchItems(
  value: unknown,
  limit = MAX_RESULTS,
): DriveSearchItem[] {
  if (!Array.isArray(value)) return [];
  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), MAX_RESULTS)
    : MAX_RESULTS;
  return value
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const raw = candidate as { name?: unknown; id?: unknown };
      const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_DRIVE_NAME_CHARS) : '';
      const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, MAX_DRIVE_ID_CHARS) : '';
      const safeId = id && /^[A-Za-z0-9_-]+$/.test(id) ? id : '';
      return name ? [{ name, id: safeId }] : [];
    })
    .slice(0, safeLimit);
}

/** Pulls the document type and id out of a URL, or accepts a bare id. */
export function parseTarget(urlOrId: string, hint?: DocKind): Target | null {
  const s = urlOrId.trim();
  if (s.length > MAX_INPUT_CHARS) return null;

  const m = /docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([\w-]{10,})/i.exec(s);
  if (m) {
    const gid = /[#&?]gid=(\d+)/.exec(s)?.[1];
    const kind = m[1]?.toLowerCase();
    const id = m[2];
    if (!kind || !id) return null;
    return { kind: kind as DocKind, id, gid };
  }

  // A bare id gives no hint about which product it belongs to.
  if (/^[\w-]{20,}$/.test(s)) return { kind: hint && ['document', 'presentation', 'spreadsheets'].includes(hint) ? hint : 'document', id: s };
  return null;
}

function exportUrl({ kind, id, gid }: Target): string {
  switch (kind) {
    case 'presentation':
      // Slides exposes txt rather than the format= parameter the others use.
      return `https://docs.google.com/presentation/d/${id}/export/txt`;
    case 'spreadsheets':
      return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${
        gid ? `&gid=${gid}` : ''
      }`;
    default:
      return `https://docs.google.com/document/d/${id}/export?format=txt`;
  }
}

export { createSerialTaskRunner } from './google-tab';

const runDocsTabTask = runGoogleTabTask;

let docsSession: GoogleTabSession | undefined;

export function isDocsOrigin(value: unknown): boolean {
  return value === 'https://docs.google.com';
}

/** Poll a page readiness expression so fast pages do not pay a fixed sleep. */
async function waitForPageReady(
  expression: string,
  tabId: string,
  profile: BrowserProfile,
  timeoutMs = 12_000,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      if ((await evaluateInTab(expression, tabId, profile, signal)) === true) return true;
    } catch {
      /* The tab may still be changing documents. */
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await waitWithAbort(new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining))), signal);
  }
  return false;
}
/**
 * Issues a request from inside a docs.google.com tab.
 *
 * Same-origin is the point: the export endpoints answer only for a signed-in
 * session, and a fetch from the main process carries no cookies at all.
 */
export function buildDocsExportScript(url: string, abortKey: string): string {
  return `(() => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const key = ${JSON.stringify(abortKey)};
    window[key] = abort;
    const timer = setTimeout(() => controller.abort(), 30_000);
    return fetch(${JSON.stringify(url)}, { credentials: 'include', signal: controller.signal })
    .then(async r => {
      if (!r.ok) {
        try { await r.body?.cancel(); } catch {}
        return 'ADI_HTTP_' + r.status;
      }
      const reader = r.body && r.body.getReader();
      if (!reader) {
        try { await r.body?.cancel(); } catch {}
        return 'ADI_ERR_no response body';
      }
      const decoder = new TextDecoder();
      let text = '';
      let bytes = 0;
      let truncated = false;
      const maxBytes = ${MAX_RAW_EXPORT_CHARS} * 4;
      try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = decoder.decode();
          const remaining = ${MAX_RAW_EXPORT_CHARS} - text.length;
          if (tail.length > remaining) {
            text += tail.slice(0, Math.max(0, remaining));
            truncated = true;
          } else {
            text += tail;
          }
          break;
        }
        const remainingBytes = Math.max(0, maxBytes - bytes);
        const remainingChars = Math.max(0, ${MAX_RAW_EXPORT_CHARS} - text.length);
        const allowedBytes = Math.min(remainingBytes, remainingChars * 4);
        if (value.byteLength > allowedBytes) {
          if (allowedBytes > 0) text += decoder.decode(value.slice(0, allowedBytes), { stream: true });
          text += decoder.decode();
          truncated = true;
          await reader.cancel();
          break;
        }
        bytes += value.byteLength;
        const chunk = decoder.decode(value, { stream: true });
        text += chunk;
        if (text.length >= ${MAX_RAW_EXPORT_CHARS}) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
      return truncated
        ? text.slice(0, ${MAX_RAW_EXPORT_CHARS}) + '…[truncated]'
        : text;
      } catch (error) {
        try { await reader.cancel(); } catch {}
        throw error;
      } finally {
        try { reader.releaseLock?.(); } catch {}
      }
    })
    .catch(e => 'ADI_ERR_' + String(e.message).slice(0, 500))
    .finally(() => {
      clearTimeout(timer);
      if (window[key] === abort) delete window[key];
    });
  })()`;
}

export function createDocsAbortBridge(
  abortKey: string,
  evaluate: (expression: string, signal: AbortSignal) => Promise<unknown>,
  timeoutMs = ABORT_PAGE_TIMEOUT_MS,
): () => void {
  return () => {
    const bridge = new AbortController();
    const timer = setTimeout(() => bridge.abort(), timeoutMs);
    void evaluate(`window[${JSON.stringify(abortKey)}]?.()`, bridge.signal)
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  };
}

async function ensureDocsTab(operationId?: string, signal?: AbortSignal): Promise<GoogleTabSession> {
  const identity = selectedGoogleAccountLock(operationId);
  const homeUrl = bindGoogleAccount('https://docs.google.com/', identity.accountEmail);
  const expectedHost = 'docs.google.com';

  if (docsSession && sameGoogleIdentity(docsSession, identity)) {
    try {
      const origin = await evaluateInTab('location.origin', docsSession.tabId, docsSession.profile, signal);
      if (!isDocsOrigin(origin)) {
        await navigate(homeUrl, docsSession.tabId, docsSession.profile, signal);
        await waitForPageReady(
          "document.readyState === 'complete' && location.origin === 'https://docs.google.com'",
          docsSession.tabId,
          docsSession.profile,
          12_000,
          signal,
        );
      }
      docsSession = { ...docsSession, expectedHost };
      await verifyGoogleAccount(docsSession, signal);
      return docsSession;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof Error && /^GOOGLE_ACCOUNT_(?:MISMATCH|UNVERIFIED):/.test(error.message)) throw error;
      docsSession = undefined;
    }
  } else {
    docsSession = undefined;
  }

  const acquired = await acquireTab(homeUrl, identity.profile, signal);
  docsSession = { ...identity, tabId: acquired.id, expectedHost };
  if (!acquired.reused) {
    await waitForPageReady(
      "document.readyState === 'complete' && location.origin === 'https://docs.google.com'",
      docsSession.tabId,
      docsSession.profile,
      12_000,
      signal,
    );
  }
  await verifyGoogleAccount(docsSession, signal);
  return docsSession;
}

async function fetchAsUserUnlocked(url: string, operationId?: string, signal?: AbortSignal): Promise<string> {
  const session = await ensureDocsTab(operationId, signal);
  const abortKey = `__adiDocsAbort_${randomUUID().replace(/-/g, '')}`;
  const script = buildDocsExportScript(bindGoogleAccount(url, session.accountEmail), abortKey);

  throwIfAborted(signal);
  const abortPage = createDocsAbortBridge(
    abortKey,
    (expression, bridgeSignal) => evaluateInTab(expression, session.tabId, session.profile, bridgeSignal),
  );
  signal?.addEventListener('abort', abortPage, { once: true });
  let raw: string;
  try {
    const evaluated = await evaluateInTab(script, session.tabId, session.profile, signal);
    raw = typeof evaluated === 'string' ? evaluated : 'ADI_FAIL: browser returned malformed export data.';
  } finally {
    signal?.removeEventListener('abort', abortPage);
  }

  if (raw.startsWith('ADI_HTTP_')) {
    const status = raw.slice('ADI_HTTP_'.length);
    if (status === '401' || status === '403') {
      return (
        'ADI_FAIL: no access. Either this browser profile is not signed in to the ' +
        'account that owns the file, or the file is not shared with it.'
      );
    }
    if (status === '404') return 'ADI_FAIL: not found — check the link.';
    return `ADI_FAIL: the export request returned ${status}.`;
  }
  if (raw.startsWith('ADI_ERR_')) return `ADI_FAIL: ${raw.slice('ADI_ERR_'.length)}`;

  // A sign-in page comes back as HTML rather than the document.
  if (/^\s*<(!doctype|html)/i.test(raw)) {
    return 'ADI_FAIL: got a sign-in page instead of the document. This profile is signed out.';
  }
  return raw;
}
async function fetchAsUser(url: string, operationId?: string, signal?: AbortSignal): Promise<string> {
  return runDocsTabTask(() => fetchAsUserUnlocked(url, operationId, signal), signal);
}

const MAX_CHARS = 90_000;

/** Slides exports one block per slide; numbering them keeps references usable. */
function formatSlides(text: string): string {
  const slides = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (slides.length < 2) return text;
  return slides.map((s, i) => `--- Slide ${i + 1} ---\n${s}`).join('\n\n');
}

export async function readGoogleDoc(
  urlOrId: string,
  hint?: DocKind,
  signal?: AbortSignal,
  operationId?: string,
): Promise<string> {
  const cleanInput = urlOrId.trim();
  if (cleanInput.length > MAX_INPUT_CHARS) throw new Error('Google document links or ids must be 2,000 characters or fewer.');
  const target = parseTarget(cleanInput, hint);
  if (!target) {
    return `Could not find a Google Docs, Slides or Sheets id in "${cleanInput.slice(0, 200)}".`;
  }

  const text = await fetchAsUser(exportUrl(target), operationId, signal);
  if (text.startsWith('ADI_FAIL:')) return text.slice('ADI_FAIL:'.length).trim();

  const label =
    target.kind === 'presentation' ? 'Slides' : target.kind === 'spreadsheets' ? 'Sheet' : 'Doc';
  const body = target.kind === 'presentation' ? formatSlides(text) : text;
  const clipped =
    body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n\n…[truncated]` : body;

  return `# ${label}: ${target.id}\n${cleanInput}\n\n${clipped.trim() || '(the file is empty)'}`;
}

/**
 * Lists the user's recent Drive files matching a query, so a document can be
 * found by name instead of needing its link.
 */
async function findGoogleDocsUnlocked(
  cleanQuery: string,
  safeLimit: number,
  operationId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const docs = await ensureDocsTab(operationId, signal);
  const url = bindGoogleAccount(
    `https://drive.google.com/drive/search?q=${encodeURIComponent(cleanQuery)}`,
    docs.accountEmail,
  );
  await navigate(url, docs.tabId, docs.profile, signal);
  docsSession = { ...docs, expectedHost: 'drive.google.com' };
  await waitForPageReady(
    `document.readyState === 'complete' && (!!document.querySelector('[data-id]') || document.querySelectorAll('[role="row"]').length > 0 || (((document.body && document.body.innerText) || '').length > 200) || /No results|No files|No items/i.test((document.body && document.body.innerText) || ''))`,
    docsSession.tabId,
    docsSession.profile,
    15_000,
    signal,
  );
  await verifyGoogleAccount(docsSession, signal);

  const raw = await evaluateInTab(
    `(() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('[data-id], [role="row"]')) {
        const name = (el.getAttribute('aria-label') || el.innerText || '').split('\\n')[0].trim();
        const id = el.getAttribute('data-id');
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({ name: name.slice(0, 160), id: id || '' });
        if (out.length >= ${safeLimit}) break;
      }
      return JSON.stringify(out);
    })()`,
    docsSession.tabId,
    docsSession.profile,
    signal,
  );

  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch {
    /* layout changed */
    parsed = undefined;
  }
  const items = normaliseDriveSearchItems(parsed, safeLimit);

  if (!items.length) {
    const fallback = await evaluateInTab(
      `document.body.innerText.slice(0, 2000)`,
      docsSession.tabId,
      docsSession.profile,
      signal,
    );
    const text = typeof fallback === 'string' ? fallback : 'The browser returned malformed page text.';
    return `Could not read the Drive results. Page text:\n\n${text}`;
  }

  return [
    `Drive search "${cleanQuery}" — ${items.length} item(s)`,
    ...items.map((f, i) => `${i + 1}. ${f.name}${f.id ? `\n   id: ${f.id}` : ''}`),
  ].join('\n');
}

export async function findGoogleDocs(
  query: string,
  limit = 12,
  signal?: AbortSignal,
  operationId?: string,
): Promise<string> {
  const cleanQuery = query.trim();
  if (!cleanQuery) throw new Error('A Drive search query is required.');
  if (cleanQuery.length > MAX_QUERY_CHARS) throw new Error('Drive search queries must be 500 characters or fewer.');
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), MAX_RESULTS) : 12;
  return runDocsTabTask(() => findGoogleDocsUnlocked(cleanQuery, safeLimit, operationId, signal), signal);
}

/** Called when the browser profile changes, since the parked tab is stale. */
export function resetDocsSession(): void {
  docsSession = undefined;
}
