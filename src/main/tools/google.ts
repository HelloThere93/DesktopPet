import {
  acquireTab,
  browserIdentityForRequest,
  evaluateInTab,
  maskBrowserAccountEmail,
  navigate,
  tabCandidatesForHost,
  type BrowserProfile,
  type SelectedBrowserIdentity,
} from './chrome';
import { throwIfAborted, waitWithAbort } from '../abort';
import { runGoogleTabTask } from './google-tab';

/**
 * One-step readers for Gmail and Classroom.
 *
 * Driving these page by page — navigate, click a thread, read, go back — costs a
 * tool round each and exhausts a request's step budget before the work is done.
 * These navigate and extract in a single call instead.
 *
 * Google's markup is obfuscated and changes, so every extractor falls back to
 * the page's readable text rather than failing outright: a slightly messy answer
 * beats "no results" when the selectors drift.
 */

const MAX_GMAIL_ROWS = 50;
const MAX_GMAIL_BODY = 20_000;
const MAX_CLASSROOM_ITEMS = 40;
const MAX_CLASSROOM_CLASSES = 60;
const MAX_CLASSROOM_RAW_CHARS = 60_000;
const MAX_CLASSROOM_URL = 2_000;
const MAX_CLASSROOM_ATTACHMENTS = 6;
const MAX_CLASSROOM_TOPIC_CLASSES = 12;
const MAX_CLASSROOM_TOPIC_HEADINGS = 12;
const MAX_CLASSROOM_TOPIC_ITEMS = 20;
const MAX_CLASSROOM_TOPIC_TEXT = 2_400;

type GmailRow = {
  n: number;
  id?: string;
  unread: boolean;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  hasAttachment: boolean;
};

type GmailMessage = {
  subject: string;
  from: string;
  date: string;
  body: string;
};

export type ClassroomItem = {
  title: string;
  due: string;
  context: string;
  assignmentUrl?: string;
  attachmentUrls: string[];
};

export type ClassroomClass = {
  name: string;
  context: string;
  url?: string;
};

export type ClassroomClassworkItem = {
  title: string;
  topic: string;
  kind: 'assignment' | 'material' | 'question' | 'item';
  context: string;
  url?: string;
  attachmentUrls: string[];
};

export interface ClassroomClassworkSnapshot {
  headings: string[];
  items: ClassroomClassworkItem[];
  text: string;
}

export type ClassroomScope = 'upcoming' | 'all';

export interface ClassroomReadOptions {
  scope?: ClassroomScope;
  daysAhead?: number;
  limit?: number;
  /** Active-course cohort hint, for example "MYP5 26/27". */
  classFilter?: string;
  maxClasses?: number;
}

export interface ClassroomSelection {
  items: ClassroomItem[];
  omitted: number;
  scope: ClassroomScope;
  daysAhead: number;
  limit: number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function boundedString(value: unknown, maximum: number, fallback = ''): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : fallback;
}

export function normaliseGmailRows(value: unknown): GmailRow[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_GMAIL_ROWS).flatMap((candidate, index) => {
    if (!isRecord(candidate)) return [];
    const subject = boundedString(candidate.subject, 260, '(no subject)') || '(no subject)';
    const id = boundedString(candidate.id, 200);
    return [{
      n: index + 1,
      ...(id ? { id } : {}),
      unread: candidate.unread === true,
      from: boundedString(candidate.from, 180),
      subject,
      snippet: boundedString(candidate.snippet, 220),
      date: boundedString(candidate.date, 120),
      hasAttachment: candidate.hasAttachment === true,
    }];
  });
}

export function normaliseGmailMessage(value: unknown): GmailMessage | null {
  if (!isRecord(value)) return null;
  const message = {
    subject: boundedString(value.subject, 260),
    from: boundedString(value.from, 180),
    date: boundedString(value.date, 120),
    body: boundedString(value.body, MAX_GMAIL_BODY),
  };
  return message.subject || message.from || message.date || message.body ? message : null;
}

function safeHttpUrl(value: unknown): string {
  const candidate = boundedString(value, MAX_CLASSROOM_URL);
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href.slice(0, MAX_CLASSROOM_URL) : '';
  } catch {
    return '';
  }
}
export function normaliseClassroomItems(value: unknown): ClassroomItem[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.length > MAX_CLASSROOM_RAW_CHARS) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, MAX_CLASSROOM_ITEMS).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const title = boundedString(candidate.title, 160);
    if (!title) return [];
    const assignmentUrl = safeHttpUrl(candidate.assignmentUrl ?? candidate.link);
    const rawAttachments = Array.isArray(candidate.attachmentUrls)
      ? candidate.attachmentUrls
      : Array.isArray(candidate.attachments)
        ? candidate.attachments
        : [];
    const attachmentUrls = [...new Set(
      rawAttachments.map((attachment) => safeHttpUrl(attachment)).filter(Boolean),
    )].slice(0, MAX_CLASSROOM_ATTACHMENTS);
    return [{
      title,
      due: boundedString(candidate.due, 120),
      context: boundedString(candidate.context, 220),
      ...(assignmentUrl ? { assignmentUrl } : {}),
      attachmentUrls,
    }];
  });
}

export function normaliseClassroomClasses(value: unknown): ClassroomClass[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.length > MAX_CLASSROOM_RAW_CHARS) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  return parsed.slice(0, MAX_CLASSROOM_CLASSES).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const name = boundedString(candidate.name ?? candidate.title, 180);
    const url = safeHttpUrl(candidate.url ?? candidate.link);
    const key = url || name.toLocaleLowerCase();
    if (!name || !key || seen.has(key)) return [];
    seen.add(key);
    return [{
      name,
      context: boundedString(candidate.context, 260),
      ...(url ? { url } : {}),
    }];
  });
}

export function normaliseClassroomClasswork(value: unknown): ClassroomClassworkSnapshot {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.length > MAX_CLASSROOM_RAW_CHARS) return { headings: [], items: [], text: '' };
    try {
      parsed = JSON.parse(value);
    } catch {
      return { headings: [], items: [], text: '' };
    }
  }
  if (!isRecord(parsed)) return { headings: [], items: [], text: '' };
  const headings = [...new Set(
    (Array.isArray(parsed.headings) ? parsed.headings : [])
      .map((heading) => boundedString(heading, 180))
      .filter(Boolean),
  )].slice(0, MAX_CLASSROOM_TOPIC_HEADINGS);
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .slice(0, MAX_CLASSROOM_TOPIC_ITEMS)
    .flatMap((candidate): ClassroomClassworkItem[] => {
      if (!isRecord(candidate)) return [];
      const title = boundedString(candidate.title, 180);
      if (!title) return [];
      const rawKind = boundedString(candidate.kind, 20).toLowerCase();
      const kind = ['assignment', 'material', 'question'].includes(rawKind)
        ? rawKind as ClassroomClassworkItem['kind']
        : 'item';
      const url = safeHttpUrl(candidate.url ?? candidate.link);
      const rawAttachments = Array.isArray(candidate.attachmentUrls)
        ? candidate.attachmentUrls
        : Array.isArray(candidate.attachments)
          ? candidate.attachments
          : [];
      const attachmentUrls = [...new Set(
        rawAttachments.map((attachment) => safeHttpUrl(attachment)).filter(Boolean),
      )].slice(0, MAX_CLASSROOM_ATTACHMENTS);
      return [{
        title,
        topic: boundedString(candidate.topic, 180),
        kind,
        context: boundedString(candidate.context, 360),
        ...(url ? { url } : {}),
        attachmentUrls,
      }];
    });
  return {
    headings,
    items,
    text: boundedString(parsed.text, MAX_CLASSROOM_TOPIC_TEXT),
  };
}

const CLASS_FILTER_STOP_WORDS = new Set([
  'all', 'my', 'the', 'a', 'an', 'class', 'classes', 'course', 'courses',
  'google', 'classroom', 'read', 'scan', 'check', 'first', 'next', 'current',
  'unit', 'units', 'topic', 'topics', 'subject', 'subjects', 'year',
]);

/** Selects active course cards by stable cohort hints while preserving dashboard order. */
export function selectClassroomClasses(
  classes: readonly ClassroomClass[],
  classFilter = '',
  maxClasses = MAX_CLASSROOM_TOPIC_CLASSES,
): ClassroomClass[] {
  const limit = Math.min(
    MAX_CLASSROOM_TOPIC_CLASSES,
    Math.max(1, Number.isFinite(maxClasses) ? Math.floor(maxClasses) : MAX_CLASSROOM_TOPIC_CLASSES),
  );
  const query = boundedString(classFilter, 120);
  if (!query) return classes.slice(0, limit);

  const compact = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '');
  const mypLevel = /\bmyp\s*[- ]?\s*(\d{1,2})\b/i.exec(query)?.[1];
  const year = /\b(?:20)?(\d{2})\s*[\/–—-]\s*(?:20)?(\d{2})\b/i.exec(query);
  const yearStart = year?.[1];
  const yearEnd = year?.[2];
  const yearPair = yearStart && yearEnd ? [yearStart, yearEnd] as const : undefined;
  const candidates = classes.map((course) => {
    const text = (course.name + ' ' + course.context).toLocaleLowerCase();
    return { course, text, compact: compact(text) };
  });
  const anyYearMatch = Boolean(yearPair && candidates.some((candidate) =>
    candidate.text.includes(yearPair[0]) && candidate.text.includes(yearPair[1])));
  const residual = query
    .replace(/\bmyp\s*[- ]?\s*\d{1,2}\b/ig, ' ')
    .replace(/\b(?:20)?\d{2}\s*[\/–—-]\s*(?:20)?\d{2}\b/ig, ' ');
  const tokens = (residual.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 1 && !CLASS_FILTER_STOP_WORDS.has(token));

  return candidates.filter((candidate) => {
    if (mypLevel && !candidate.compact.includes('myp' + mypLevel)) return false;
    if (anyYearMatch && yearPair && !(candidate.text.includes(yearPair[0]) && candidate.text.includes(yearPair[1]))) {
      return false;
    }
    if (tokens.length && !tokens.every((token) =>
      candidate.text.includes(token) || candidate.compact.includes(compact(token)))) {
      return false;
    }
    return true;
  }).slice(0, limit).map((candidate) => candidate.course);
}

/** Converts a dashboard /c/:course card URL into its same-course Classwork URL. */
export function classroomClassworkUrl(classUrl: string, accountEmail = ''): string {
  try {
    const parsed = new URL(classUrl);
    if (parsed.hostname.toLowerCase() !== 'classroom.google.com') return '';
    const path = removeNumericGoogleAccountSlot(parsed.pathname);
    const courseId = /^\/c\/([a-z0-9_-]{3,200})\/?$/i.exec(path)?.[1];
    if (!courseId) return '';
    return bindGoogleAccount(
      'https://classroom.google.com/w/' + courseId + '/t/all',
      accountEmail,
    );
  } catch {
    return '';
  }
}

const DEFAULT_CLASSROOM_DAYS_AHEAD = 90;
const MAX_CLASSROOM_DAYS_AHEAD = 365;
const DEFAULT_CLASSROOM_OUTPUT_LIMIT = 20;
const MAX_UPCOMING_UNDATED_ITEMS = 5;

const CLASSROOM_MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function startOfLocalDay(now: number): number {
  const date = new Date(Number.isFinite(now) ? now : Date.now());
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function localDateTimestamp(year: number, month: number, day: number): number | undefined {
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return undefined;
  }
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Parses the stable English due-date forms currently rendered by Classroom. */
export function classroomDueTimestamp(item: ClassroomItem, now = Date.now()): number | undefined {
  const source = (item.due + ' ' + item.context).replace(/\s+/g, ' ').trim();
  const dueIndex = source.search(/\bdue\b/i);
  if (dueIndex < 0 || /\bno due date\b/i.test(source)) return undefined;
  const fragment = source.slice(dueIndex).slice(0, 120);
  const today = startOfLocalDay(now);
  if (/\bdue\b[^.;|]{0,24}\btoday\b/i.test(fragment)) return today;
  if (/\bdue\b[^.;|]{0,24}\btomorrow\b/i.test(fragment)) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.getTime();
  }

  const iso = /\bdue\b[^0-9]{0,16}(20\d{2})-(\d{1,2})-(\d{1,2})/i.exec(fragment);
  if (iso) return localDateTimestamp(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const monthName = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const monthFirst = new RegExp(
    '\\bdue\\b[^a-z0-9]{0,16}' + monthName + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?',
    'i',
  ).exec(fragment);
  const dayFirst = new RegExp(
    '\\bdue\\b[^a-z0-9]{0,16}(\\d{1,2})(?:st|nd|rd|th)?\\s+' + monthName + '\\.?(?:,?\\s+(20\\d{2}))?',
    'i',
  ).exec(fragment);

  let month: number | undefined;
  let day: number | undefined;
  let explicitYear: number | undefined;
  if (monthFirst) {
    month = CLASSROOM_MONTHS[(monthFirst[1] ?? '').slice(0, 3).toLowerCase()];
    day = Number(monthFirst[2]);
    explicitYear = monthFirst[3] ? Number(monthFirst[3]) : undefined;
  } else if (dayFirst) {
    day = Number(dayFirst[1]);
    month = CLASSROOM_MONTHS[(dayFirst[2] ?? '').slice(0, 3).toLowerCase()];
    explicitYear = dayFirst[3] ? Number(dayFirst[3]) : undefined;
  }
  if (month === undefined || !day) return undefined;

  const current = new Date(now);
  let year = explicitYear ?? current.getFullYear();
  let parsed = localDateTimestamp(year, month, day);
  if (
    parsed !== undefined &&
    explicitYear === undefined &&
    parsed < today &&
    current.getMonth() >= 10 &&
    month <= 1
  ) {
    year += 1;
    parsed = localDateTimestamp(year, month, day);
  }
  return parsed;
}

function boundedClassroomInteger(value: unknown, fallback: number, maximum: number): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(1, Math.floor(number)))
    : fallback;
}

/** Applies the future-first, nearest-deadline-first default without crawling history. */
export function selectClassroomItems(
  items: readonly ClassroomItem[],
  options: ClassroomReadOptions = {},
  now = Date.now(),
): ClassroomSelection {
  const scope: ClassroomScope = options.scope === 'all' ? 'all' : 'upcoming';
  const daysAhead = boundedClassroomInteger(
    options.daysAhead,
    DEFAULT_CLASSROOM_DAYS_AHEAD,
    MAX_CLASSROOM_DAYS_AHEAD,
  );
  const limit = boundedClassroomInteger(
    options.limit,
    DEFAULT_CLASSROOM_OUTPUT_LIMIT,
    MAX_CLASSROOM_ITEMS,
  );
  if (scope === 'all') {
    return {
      items: items.slice(0, limit),
      omitted: Math.max(0, items.length - limit),
      scope,
      daysAhead,
      limit,
    };
  }

  const start = startOfLocalDay(now);
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + daysAhead);
  const end = endDate.getTime();
  const ranked = items
    .map((item, index) => ({
      item,
      index,
      dueAt: classroomDueTimestamp(item, now),
      staleStatus: /\b(?:missing|overdue|late|turned in|graded|returned)\b/i.test(item.due + ' ' + item.context),
    }))
    .filter((candidate) =>
      !candidate.staleStatus &&
      (
        candidate.dueAt === undefined ||
        (candidate.dueAt >= start && candidate.dueAt <= end)
      ),
    )
    .sort(
      (a, b) =>
        Number(a.dueAt === undefined) - Number(b.dueAt === undefined) ||
        (a.dueAt ?? 0) - (b.dueAt ?? 0) ||
        a.index - b.index,
    );
  let undated = 0;
  const selected = ranked
    .filter((candidate) =>
      candidate.dueAt !== undefined ||
      undated++ < MAX_UPCOMING_UNDATED_ITEMS,
    )
    .slice(0, limit)
    .map((candidate) => candidate.item);

  return {
    items: selected,
    omitted: Math.max(0, items.length - selected.length),
    scope,
    daysAhead,
    limit,
  };
}
export interface GoogleTabSession extends SelectedBrowserIdentity {
  tabId: string;
  expectedHost: string;
}

interface GoogleAccountProbe {
  host: string;
  emails: string[];
  authRequired?: boolean;
}

let googleSession: GoogleTabSession | undefined;
let lastGmailListing: {
  tabId: string;
  rows: GmailRow[];
  profile: BrowserProfile;
  profileDir: string;
  accountEmail?: string;
} | undefined;

export function normaliseGoogleAccountEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return '';
  return email;
}

export function bindGoogleAccount(url: string, accountEmail = ''): string {
  const parsed = new URL(url);
  const email = normaliseGoogleAccountEmail(accountEmail);
  if (email) parsed.searchParams.set('authuser', email);
  return parsed.href;
}

const GOOGLE_ACCOUNT_APP_HOSTS = new Set([
  'classroom.google.com',
  'mail.google.com',
  'drive.google.com',
  'docs.google.com',
]);

function removeNumericGoogleAccountSlot(pathname: string): string {
  return pathname
    .replace(/^\/u\/\d+(?=\/|$)/i, '')
    .replace(/^\/(mail|drive|document|presentation|spreadsheets)\/u\/\d+(?=\/|$)/i, '/$1');
}

/** Compares Google destinations while ignoring account-slot redirect syntax. */
export function sameGoogleDestination(left: string, right: string): boolean {
  const normalise = (value: string): string => {
    try {
      const parsed = new URL(value);
      let pathname = removeNumericGoogleAccountSlot(parsed.pathname) || '/';
      if (parsed.hostname.toLowerCase() === 'classroom.google.com' && /^\/h(?:\/st)?\/?$/i.test(pathname)) {
        pathname = '/h';
      } else if (pathname.length > 1) {
        pathname = pathname.replace(/\/+$/, '');
      }
      parsed.searchParams.delete('authuser');
      parsed.searchParams.sort();
      const query = parsed.searchParams.toString();
      return parsed.hostname.toLowerCase() + pathname + (query ? '?' + query : '') + parsed.hash;
    } catch {
      return '';
    }
  };
  const a = normalise(left);
  const b = normalise(right);
  return Boolean(a && b && a === b);
}

function googleAccountSlot(value: string): number | undefined {
  try {
    const parsed = new URL(value);
    const pathSlot = /^\/u\/(\d+)(?=\/|$)/i.exec(parsed.pathname)?.[1] ??
      /^\/(?:mail|drive|document|presentation|spreadsheets)\/u\/(\d+)(?=\/|$)/i.exec(parsed.pathname)?.[1];
    const raw = pathSlot ?? parsed.searchParams.get('authuser') ?? '';
    if (!/^\d{1,2}$/.test(raw)) return undefined;
    const slot = Number(raw);
    return Number.isInteger(slot) && slot >= 0 && slot <= 99 ? slot : undefined;
  } catch {
    return undefined;
  }
}

/** Rewrites an account-bound Google URL to a previously verified numeric slot. */
export function bindGoogleAccountSlot(url: string, slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > 99) throw new Error('Invalid Google account slot.');
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const path = removeNumericGoogleAccountSlot(parsed.pathname) || '/';
  parsed.searchParams.delete('authuser');
  if (host === 'classroom.google.com') {
    parsed.pathname = '/u/' + slot + (path === '/' ? '' : path);
  } else if (host === 'mail.google.com') {
    const mailPath = path.replace(/^\/mail(?=\/|$)/i, '') || '/';
    parsed.pathname = '/mail/u/' + slot + (mailPath.startsWith('/') ? mailPath : '/' + mailPath);
  } else {
    parsed.searchParams.set('authuser', String(slot));
  }
  return parsed.href;
}

function googleSignInTargetsHost(url: string, expectedHost: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'accounts.google.com') return false;
    return ['continue', 'followup'].some((key) => {
      const target = parsed.searchParams.get(key);
      if (!target) return false;
      try {
        return new URL(target).hostname.toLowerCase() === expectedHost;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function bindGoogleUrlToAccount(url: string, accountEmail = ''): string {
  const parsed = new URL(url);
  if (!GOOGLE_ACCOUNT_APP_HOSTS.has(parsed.hostname.toLowerCase())) return parsed.href;
  const email = normaliseGoogleAccountEmail(accountEmail);
  if (!email) return parsed.href;
  parsed.pathname = removeNumericGoogleAccountSlot(parsed.pathname) || '/';
  parsed.searchParams.set('authuser', email);
  return parsed.href;
}

/** Binds generic Chrome navigation to the request's locked Google account. */
export function bindGoogleRequestUrl(url: string, operationId?: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (!GOOGLE_ACCOUNT_APP_HOSTS.has(host)) return parsed.href;

  const originalPath = parsed.pathname;
  const withoutSlot = removeNumericGoogleAccountSlot(originalPath);
  const hadNumericSlot = withoutSlot !== originalPath;
  const identity = browserIdentityForRequest(operationId);
  const accountEmail = normaliseGoogleAccountEmail(identity.accountEmail);
  if (!accountEmail) {
    if (hadNumericSlot) selectedGoogleAccountLock(operationId);
    return parsed.href;
  }
  return bindGoogleUrlToAccount(parsed.href, accountEmail);
}

export function selectedGoogleAccountLock(operationId?: string): SelectedBrowserIdentity {
  const identity = browserIdentityForRequest(operationId);
  const accountEmail = normaliseGoogleAccountEmail(identity.accountEmail);
  if (identity.profile === 'system' && !accountEmail) {
    throw new Error(
      'GOOGLE_ACCOUNT_LOCK_UNAVAILABLE: Chrome profile ' + identity.profileName + ' (' + identity.profileDir +
        ') has no primary Google account metadata. Adi refused to guess Google account slot /u/0.',
    );
  }
  return { ...identity, ...(accountEmail ? { accountEmail } : {}) };
}

export function sameGoogleIdentity(left: SelectedBrowserIdentity, right: SelectedBrowserIdentity): boolean {
  return left.profile === right.profile &&
    left.profileDir === right.profileDir &&
    normaliseGoogleAccountEmail(left.accountEmail) === normaliseGoogleAccountEmail(right.accountEmail);
}

async function verifiedExistingGoogleTab(
  url: string,
  identity: SelectedBrowserIdentity,
  signal?: AbortSignal,
): Promise<GoogleTabSession | undefined> {
  const expected = normaliseGoogleAccountEmail(identity.accountEmail);
  if (!expected) return undefined;
  const expectedHost = new URL(url).hostname.toLowerCase();
  const candidates = await tabCandidatesForHost(expectedHost, identity.profile, signal);
  const probes = await Promise.all(candidates.slice(0, 8).map(async (candidate) => {
    const probeSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(1_500)])
      : AbortSignal.timeout(1_500);
    try {
      const probe = normaliseGoogleAccountProbe(
        await evaluateInTab(GOOGLE_ACCOUNT_PROBE, candidate.id, identity.profile, probeSignal),
      );
      return { candidate, probe, exact: sameGoogleDestination(candidate.url, url) };
    } catch {
      throwIfAborted(signal);
      return undefined;
    }
  }));
  throwIfAborted(signal);
  const match = probes
    .filter((value): value is NonNullable<typeof value> =>
      Boolean(value && value.probe.host === expectedHost && value.probe.emails.includes(expected)))
    .sort((left, right) => Number(right.exact) - Number(left.exact))[0];
  if (!match) {
    // Reuse a stable sign-in page for this exact account and destination rather
    // than opening another duplicate on every retry.
    const signInCandidates = (await tabCandidatesForHost('accounts.google.com', identity.profile, signal))
      .filter((candidate) => googleSignInTargetsHost(candidate.url, expectedHost))
      .slice(0, 8);
    if (signInCandidates.length) {
      throw new Error(
        'GOOGLE_SIGN_IN_REQUIRED: Google needs ' + maskBrowserAccountEmail(expected) +
          ' to sign in again in ' + identity.profileName + ' (' + identity.profileDir +
          '). Adi reused the existing sign-in tab instead of opening another one.',
      );
    }
    const conflictingEmails = [...new Set(probes.flatMap((value) =>
      value?.probe.host === expectedHost ? value.probe.emails : []))]
      .filter((email) => email !== expected);
    if (conflictingEmails.length) {
      throw new Error(
        'GOOGLE_ACCOUNT_MISMATCH: Adi stopped before reading the page. This request is locked to ' +
          identity.profileName + ' (' + identity.profileDir + ') / ' +
          maskBrowserAccountEmail(expected) + ', but the existing ' + expectedHost + ' tab shows ' +
          conflictingEmails.map(maskBrowserAccountEmail).join(', ') + '.',
      );
    }
    if (candidates.length) {
      throw new Error(
        'GOOGLE_ACCOUNT_UNVERIFIED: Adi found an existing ' + expectedHost +
          ' tab but could not verify ' + maskBrowserAccountEmail(expected) +
          '. It did not open or switch to another account.',
      );
    }
    return undefined;
  }

  const slot = googleAccountSlot(match.candidate.url);
  const destination = slot === undefined ? url : bindGoogleAccountSlot(url, slot);
  if (!sameGoogleDestination(match.candidate.url, destination)) {
    await navigate(destination, match.candidate.id, identity.profile, signal);
  }
  return { ...identity, tabId: match.candidate.id, expectedHost };
}

async function googleTabFor(
  url: string,
  identity: SelectedBrowserIdentity,
  signal?: AbortSignal,
): Promise<GoogleTabSession> {
  const expectedHost = new URL(url).hostname.toLowerCase();
  lastGmailListing = undefined;
  if (googleSession && sameGoogleIdentity(googleSession, identity)) {
    try {
      let currentUrl = '';
      try {
        currentUrl = String(await evaluateInTab(
          'String(location.href || "")',
          googleSession.tabId,
          identity.profile,
          signal,
        ));
      } catch {
        throwIfAborted(signal);
      }
      const slot = googleAccountSlot(currentUrl);
      const destination = slot === undefined ? url : bindGoogleAccountSlot(url, slot);
      if (!sameGoogleDestination(currentUrl, destination)) {
        await navigate(destination, googleSession.tabId, identity.profile, signal);
      }
      googleSession = { ...googleSession, expectedHost };
      return googleSession;
    } catch (error) {
      throwIfAborted(signal);
      googleSession = undefined;
    }
  } else {
    googleSession = undefined;
  }
  const existing = await verifiedExistingGoogleTab(url, identity, signal);
  if (existing) {
    googleSession = existing;
    return googleSession;
  }
  // The exact destination is the tab identity: acquire it directly so first use
  // does not create a Google home tab and immediately navigate it again.
  const acquired = await acquireTab(url, identity.profile, signal);
  googleSession = { ...identity, tabId: acquired.id, expectedHost };

  return googleSession;
}
/** Polls an expression in the tab until it reports ready, or gives up. */
async function waitFor(
  expression: string,
  tabId: string,
  profile: BrowserProfile,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      if ((await evaluateInTab(expression, tabId, profile, signal)) === true) return true;
    } catch {
      /* page still navigating */
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await waitWithAbort(new Promise((r) => setTimeout(r, Math.min(100, remaining))), signal);
  }
  return false;
}

const GOOGLE_ACCOUNT_PROBE = `(() => {
  const selectors = [
    'a[href*="accounts.google.com/SignOutOptions"][aria-label]',
    'a[aria-label*="Google Account"]',
    'button[aria-label*="Google Account"]',
    '[role="banner"] a[aria-label*="@"]',
    'header a[aria-label*="@"]',
    '[data-email]',
    '[data-identifier]',
    'img[alt*="@"]',
  ];
  const values = [];
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      values.push(
        node.getAttribute('aria-label') || '',
        node.getAttribute('title') || '',
        node.getAttribute('data-email') || '',
        node.getAttribute('data-identifier') || '',
        node.getAttribute('alt') || '',
      );
    }
  }
  const emails = [];
  const seen = new Set();
  const pattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig;
  for (const value of values.slice(0, 40)) {
    for (const match of String(value).match(pattern) || []) {
      const email = match.toLowerCase();
      if (!seen.has(email)) { seen.add(email); emails.push(email); }
      if (emails.length >= 8) break;
    }
    if (emails.length >= 8) break;
  }
  const host = location.hostname.toLowerCase();
  const authRequired = host === 'accounts.google.com' &&
    /\/(?:signin|ServiceLogin)|choose an account|sign in/i.test(location.pathname + ' ' + document.title);
  return JSON.stringify({ host, emails, authRequired });
})()`;

export function normaliseGoogleAccountProbe(value: unknown): GoogleAccountProbe {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return { host: '', emails: [] }; }
  }
  if (!isRecord(parsed)) return { host: '', emails: [] };
  const host = boundedString(parsed.host, 253).toLowerCase();
  const candidates = Array.isArray(parsed.emails) ? parsed.emails : [];
  const emails = [...new Set(candidates.map(normaliseGoogleAccountEmail).filter(Boolean))].slice(0, 8);
  return { host, emails, ...(parsed.authRequired === true ? { authRequired: true } : {}) };
}

export function googleAccountEvidenceMatches(value: unknown, expectedEmail: string): boolean {
  const expected = normaliseGoogleAccountEmail(expectedEmail);
  return Boolean(expected && normaliseGoogleAccountProbe(value).emails.includes(expected));
}

export async function verifyGoogleAccount(session: GoogleTabSession, signal?: AbortSignal): Promise<void> {
  const expected = normaliseGoogleAccountEmail(session.accountEmail);
  if (!expected) return;
  const deadline = Date.now() + 5_000;
  let lastProbe: GoogleAccountProbe = { host: '', emails: [] };
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      lastProbe = normaliseGoogleAccountProbe(
        await evaluateInTab(GOOGLE_ACCOUNT_PROBE, session.tabId, session.profile, signal),
      );
      if (lastProbe.host === session.expectedHost && lastProbe.emails.includes(expected)) return;
      if (lastProbe.authRequired) break;
    } catch {
      throwIfAborted(signal);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await waitWithAbort(new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining))), signal);
  }

  const expectedLabel = maskBrowserAccountEmail(expected);
  const profileLabel = session.profileName + ' (' + session.profileDir + ')';
  if (lastProbe.authRequired) {
    throw new Error(
      'GOOGLE_SIGN_IN_REQUIRED: Google needs ' + expectedLabel + ' to sign in again in ' +
        profileLabel + ' before Adi can read this page.',
    );
  }
  if (lastProbe.host === session.expectedHost && lastProbe.emails.length) {
    const actual = lastProbe.emails.map(maskBrowserAccountEmail).join(', ');
    throw new Error(
      'GOOGLE_ACCOUNT_MISMATCH: Adi stopped before reading the page. This request is locked to ' +
        profileLabel + ' / ' + expectedLabel + ', but Google shows ' + actual + '. Adi will not silently switch accounts.',
    );
  }
  throw new Error(
    'GOOGLE_ACCOUNT_UNVERIFIED: Adi stopped before reading the page. This request is locked to ' +
      profileLabel + ' / ' + expectedLabel + ', but that account could not be verified on ' + session.expectedHost + '.',
  );
}

/* ----------------------------------------------------------------- gmail */

const GMAIL_EXTRACT = `(() => {
  const rows = [...document.querySelectorAll('tr.zA')].slice(0, LIMIT);
  if (!rows.length) return null;
  return rows.map((r, i) => {
    const senderEl = r.querySelector('.yW span[email], .yW span[name], .yX span');
    const subjectEl = r.querySelector('.bog, .y6 span');
    const snippetEl = r.querySelector('.y2');
    const dateEl = r.querySelector('.xW span[title], .xW span');
    const attach = r.querySelector('.brg, [aria-label*="ttachment"]');
    return {
      n: i + 1,
      id: r.getAttribute('data-legacy-thread-id') || r.getAttribute('data-legacy-message-id') || '',
      unread: r.classList.contains('zE'),
      from: (senderEl && (senderEl.getAttribute('email') || senderEl.getAttribute('name') || senderEl.textContent) || '').trim().slice(0, 180),
      subject: (subjectEl && subjectEl.textContent || '(no subject)').trim().slice(0, 260),
      snippet: (snippetEl && snippetEl.textContent || '').replace(/^\\s*-\\s*/, '').trim().slice(0, 220),
      date: (dateEl && (dateEl.getAttribute('title') || dateEl.textContent) || '').trim().slice(0, 120),
      hasAttachment: !!attach,
    };
  });
})()`;

export function gmailUrl(query: string, accountEmail = ''): string {
  const hash = query.trim() ? '#search/' + encodeURIComponent(query.trim()) : '#inbox';
  return bindGoogleAccount('https://mail.google.com/mail/' + hash, accountEmail);
}

/**
 * Lists recent messages, optionally filtered by a Gmail search query
 * (`is:unread`, `from:someone`, `subject:"…"`, and so on).
 */
export async function readGmail(
  query = '',
  limit = 15,
  signal?: AbortSignal,
  operationId?: string,
): Promise<string> {
  const cleanQuery = query.trim();
  if (cleanQuery.length > 500) throw new Error('Gmail search queries must be 500 characters or fewer.');
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 50) : 15;
  return runGoogleTabTask(async () => {
  const identity = selectedGoogleAccountLock(operationId);
  const session = await googleTabFor(gmailUrl(cleanQuery, identity.accountEmail), identity, signal);
  await verifyGoogleAccount(session, signal);

  const ready = await waitFor(
    `!!document.querySelector('tr.zA') || /No messages|no conversations/i.test(document.body.innerText)`,
    session.tabId,
    session.profile,
    15_000,
    signal,
  );

  const raw = await evaluateInTab(
    GMAIL_EXTRACT.replace('LIMIT', String(safeLimit)),
    session.tabId,
    session.profile,
    signal,
  );
  if (!raw) {
    if (!ready) {
      return 'Gmail did not finish loading. If it is showing a sign-in page, the browser profile may be the wrong one.';
    }
    const text = String(await evaluateInTab(
      `document.body.innerText.slice(0, 4000)`,
      session.tabId,
      session.profile,
      signal,
    ));
    return `Could not read the message list. Page text:\n\n${text}`;
  }

  const rows = normaliseGmailRows(raw);
  if (!rows.length) {
    if (!ready) return 'Gmail did not finish loading. If it is showing a sign-in page, the browser profile may be the wrong one.';
    const text = String(await evaluateInTab(
      `document.body.innerText.slice(0, 4000)`,
      session.tabId,
      session.profile,
      signal,
    ));
    return `Could not read the message list. Page text:\n\n${text}`;
  }

  lastGmailListing = {
    tabId: session.tabId,
    rows,
    profile: session.profile,
    profileDir: session.profileDir,
    ...(session.accountEmail ? { accountEmail: session.accountEmail } : {}),
  };
  const header = cleanQuery ? `Gmail search "${cleanQuery}" — ${rows.length} message(s)` : `Inbox — ${rows.length} message(s)`;
  const account = session.accountEmail
    ? 'Account lock: ' + maskBrowserAccountEmail(session.accountEmail) + ' (verified)'
    : 'Profile lock: ' + session.profileName + ' (' + session.profileDir + ')';
  return [
    header,
    account,
    ...rows.map(
      (m) =>
        `${m.n}. ${m.unread ? '[UNREAD] ' : ''}${m.from} — ${m.subject}${m.hasAttachment ? ' 📎' : ''}\n` +
        `   ${m.date}\n   ${m.snippet}`,
    ),
  ].join('\n');
  }, signal);
}

/** Opens one message by its position in the last listing and returns its body. */
export async function readGmailMessage(
  index: number,
  signal?: AbortSignal,
  operationId?: string,
): Promise<string> {
  if (!Number.isInteger(index) || index < 1 || index > 50) throw new Error('Gmail message index must be an integer from 1 to 50.');
  return runGoogleTabTask(async () => {
    const session = googleSession;
    const listing = lastGmailListing;
    if (!session || !listing || listing.tabId !== session.tabId) {
      return 'List Gmail messages first so Adi has a retained, unchanged Gmail listing.';
    }
    const identity = selectedGoogleAccountLock(operationId);
    if (!sameGoogleIdentity(session, identity) ||
        listing.profile !== identity.profile ||
        listing.profileDir !== identity.profileDir ||
        normaliseGoogleAccountEmail(listing.accountEmail) !== normaliseGoogleAccountEmail(identity.accountEmail)) {
      return 'The browser account changed after the Gmail list was read. Read Gmail again in the intended account.';
    }
    await verifyGoogleAccount(session, signal);
    const expected = listing.rows[index - 1];
    if (!expected) return 'There is no message ' + index + ' in the last Gmail list. Read Gmail again.';
    const guardExpression = [
      '(() => {',
      '  const rows = [...document.querySelectorAll("tr.zA")];',
      '  const row = rows[' + (index - 1) + '];',
      '  if (!row) return JSON.stringify({ status: "missing" });',
      '  const senderEl = row.querySelector(".yW span[email], .yW span[name], .yX span");',
      '  const subjectEl = row.querySelector(".bog, .y6 span");',
      '  const dateEl = row.querySelector(".xW span[title], .xW span");',
      '  const current = {',
      '    id: row.getAttribute("data-legacy-thread-id") || row.getAttribute("data-legacy-message-id") || "",',
      '    from: (senderEl && (senderEl.getAttribute("email") || senderEl.getAttribute("name") || senderEl.textContent) || "").trim().slice(0, 180),',
      '    subject: (subjectEl && subjectEl.textContent || "(no subject)").trim().slice(0, 260),',
      '    date: (dateEl && (dateEl.getAttribute("title") || dateEl.textContent) || "").trim().slice(0, 120),',
      '  };',
      '  const expected = ' + JSON.stringify({ id: expected.id || '', from: expected.from, subject: expected.subject, date: expected.date }) + ';',
      '  const sameIdentity = expected.id && current.id',
      '    ? expected.id === current.id',
      '    : expected.from === current.from && expected.subject === current.subject && (!expected.date || !current.date || expected.date === current.date);',
      '  if (!sameIdentity) return JSON.stringify({ status: "changed", current });',
      '  row.click();',
      '  return JSON.stringify({ status: "opened" });',
      '})()',
    ].join('\n');
    const openedRaw = await evaluateInTab(guardExpression, session.tabId, session.profile, signal);
    let opened: unknown = openedRaw;
    if (typeof openedRaw === 'string') {
      try { opened = JSON.parse(openedRaw); } catch { opened = undefined; }
    }
    if (!isRecord(opened) || opened.status === 'missing') {
      return 'The Gmail list changed or is no longer open. Read Gmail again before opening a message.';
    }
    if (opened.status === 'changed') {
      return 'The Gmail list changed since the last listing. Read Gmail again before opening a message.';
    }

    await waitFor("!!document.querySelector('.a3s')", session.tabId, session.profile, 15_000, signal);
    const bodyExpression = [
      '(() => {',
      '  const subject = document.querySelector("h2.hP");',
      '  const from = document.querySelector(".gD");',
      '  const date = document.querySelector(".g3");',
      '  const body = document.querySelector(".a3s");',
      '  return JSON.stringify({',
      '    subject: subject ? subject.textContent.trim().slice(0, 260) : "",',
      '    from: from ? (from.getAttribute("email") || from.textContent).trim().slice(0, 180) : "",',
      '    date: date ? (date.getAttribute("title") || date.textContent).trim().slice(0, 120) : "",',
      '    body: body ? body.innerText.trim().slice(0, 20000) : document.body.innerText.slice(0, 8000),',
      '  });',
      '})()',
    ].join('\n');
    const body = await evaluateInTab(bodyExpression, session.tabId, session.profile, signal);
    let m: GmailMessage | null = null;
    try {
      m = normaliseGmailMessage(JSON.parse(String(body)));
    } catch {
      /* malformed page result */
    }
    if (!m) return 'Could not read the selected Gmail message safely.';
    return 'From: ' + m.from + '\nDate: ' + m.date + '\nSubject: ' + m.subject + '\n\n' + m.body;
  }, signal);
}
/* ------------------------------------------------------------ classroom */

/**
 * Classroom's own class names are generated and change, so extraction keys off
 * the things that do not: assignment links have a stable URL shape, and their
 * attachments are ordinary Docs/Slides/Drive links.
 *
 * Capturing those attachment links matters more than the text around them —
 * "what do I have to do" is nearly always answered by the attached document,
 * and with the link in hand read_google_doc can fetch the whole thing in one
 * request instead of anyone scrolling a page.
 */
/*
 * Every backslash here is doubled on purpose. This is a template literal, so
 * the escape is consumed before the browser ever sees it: `[\w-]` arrives as
 * `[w-]`, which matches the letter w, and `/\s+/` arrives as `/s+/`, which
 * would strip every s in the page text.
 */
const CLASSROOM_EXTRACT = `(() => {
  const DOC_RE = /docs\\.google\\.com\\/(document|presentation|spreadsheets)\\/d\\/[\\w-]{10,}|drive\\.google\\.com\\/file\\/d\\/[\\w-]{10,}/i;
  const items = [];
  const seen = new Set();

  const links = [...document.querySelectorAll('a[href*="/a/"]')]
    .filter((a) => /\\/a\\/[\\w-]+/.test(a.getAttribute('href') || ''));

  for (const a of links) {
    const title = (a.innerText || a.textContent || '').trim();
    const key = a.href || title;
    if (!title || seen.has(key)) continue;
    seen.add(key);

    // Climb to the row that carries the due date, class name and attachments.
    let row = a;
    for (let i = 0; i < 5 && row.parentElement; i++) row = row.parentElement;
    const text = (row.innerText || '').replace(/\\s+/g, ' ').trim();

    const due = /(Due|Posted|Assigned|No due date)[^,;|]{0,44}/i.exec(text);
    const attachments = [...row.querySelectorAll('a[href]')]
      .map((x) => x.href)
      .filter((h) => DOC_RE.test(h));

    items.push({
      title: title.slice(0, 160),
      due: due ? due[0].trim() : '',
      context: text.slice(0, 220),
      link: a.href,
      attachments: [...new Set(attachments)].slice(0, 6),
    });
    if (items.length >= 40) break;
  }
  return items.length ? JSON.stringify(items) : null;
})()`;

const CLASSROOM_CLASSES_EXTRACT = `(() => {
  const classes = [];
  const seen = new Set();
  const anchors = [...document.querySelectorAll('a[href*="/c/"]')];
  for (const anchor of anchors) {
    let pathname = '';
    try { pathname = new URL(anchor.href, location.href).pathname.replace(/^\\/u\\/\\d+(?=\\/)/, ''); }
    catch { continue; }
    if (!/^\\/c\\/[^/]+\\/?$/.test(pathname)) continue;
    const key = pathname.replace(/\\/$/, '');
    if (seen.has(key)) continue;

    let card = anchor;
    for (let i = 0; i < 5 && card.parentElement; i++) {
      const parent = card.parentElement;
      card = parent;
      if (parent.matches('li, article, [role="listitem"]')) break;
    }
    const heading = card.querySelector('[role="heading"], h1, h2, h3');
    const name = (
      anchor.getAttribute('aria-label') ||
      anchor.getAttribute('title') ||
      anchor.innerText ||
      heading?.textContent ||
      ''
    ).replace(/\\s+/g, ' ').trim();
    if (!name) continue;
    seen.add(key);
    classes.push({
      name: name.slice(0, 180),
      context: (card.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 260),
      url: new URL(anchor.href, location.href).href,
    });
    if (classes.length >= 60) break;
  }
  return classes.length ? JSON.stringify(classes) : null;
})()`;

const CLASSROOM_CLASSWORK_EXTRACT = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const headingNodes = [...document.querySelectorAll('[role="heading"], h1, h2, h3, h4')]
    .filter((node) => clean(node.textContent));
  const headings = [];
  const seenHeadings = new Set();
  for (const node of headingNodes) {
    const value = clean(node.textContent).slice(0, 180);
    const key = value.toLowerCase();
    if (!value || seenHeadings.has(key) ||
        /^(?:classwork|stream|people|grades?|to-do|google classroom)$/i.test(value)) continue;
    seenHeadings.add(key);
    headings.push(value);
    if (headings.length >= 12) break;
  }

  const DOC_RE = /docs\\.google\\.com\\/(document|presentation|spreadsheets)\\/d\\/[\\w-]{10,}|drive\\.google\\.com\\/file\\/d\\/[\\w-]{10,}/i;
  const ITEM_RE = /\\/c\\/[^/]+\\/(a|m|p)\\/[^/?#]+/i;
  const items = [];
  const seenItems = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    let parsed;
    try { parsed = new URL(anchor.href, location.href); } catch { continue; }
    const path = parsed.pathname.replace(/^\\/u\\/\\d+(?=\\/)/, '');
    const match = ITEM_RE.exec(path);
    if (!match || seenItems.has(parsed.href)) continue;

    let row = anchor.closest('[role="listitem"], li, article');
    if (!row) {
      row = anchor;
      for (let i = 0; i < 5 && row.parentElement; i++) row = row.parentElement;
    }
    const localHeading = row.querySelector('[role="heading"], h1, h2, h3, h4');
    const title = clean(
      anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label') ||
      anchor.getAttribute('title') || localHeading?.textContent
    ).slice(0, 180);
    if (!title || /^(?:view|open|more|options?)$/i.test(title)) continue;

    let topic = '';
    for (let index = headingNodes.length - 1; index >= 0; index -= 1) {
      const candidate = clean(headingNodes[index].textContent).slice(0, 180);
      if (!candidate || candidate.toLowerCase() === title.toLowerCase()) continue;
      if (/^(?:classwork|stream|people|grades?|to-do|google classroom)$/i.test(candidate)) continue;
      if (headingNodes[index].compareDocumentPosition(anchor) & 4) {
        topic = candidate;
        break;
      }
    }
    const context = clean(row.innerText || row.textContent).slice(0, 360);
    const attachments = [...row.querySelectorAll('a[href]')]
      .map((entry) => entry.href)
      .filter((href) => DOC_RE.test(href));
    const kind = match[1].toLowerCase() === 'a'
      ? 'assignment'
      : match[1].toLowerCase() === 'm'
        ? 'material'
        : 'question';
    seenItems.add(parsed.href);
    items.push({
      title,
      topic,
      kind,
      context,
      url: parsed.href,
      attachments: [...new Set(attachments)].slice(0, 6),
    });
    if (items.length >= 20) break;
  }

  const text = clean(document.body && document.body.innerText).slice(0, 2400);
  return JSON.stringify({ headings, items, text });
})()`;

/** Exposed for syntax regression tests; production callers use readClassroom. */
export function classroomClassworkExtractExpression(): string {
  return CLASSROOM_CLASSWORK_EXTRACT;
}

export type ClassroomView = 'overview' | 'todo' | 'missing' | 'done' | 'classes' | 'topics';

const CLASSROOM_PAGE_READY_TIMEOUT_MS = 3_500;
const CLASSROOM_CLASSES_READY = `(() => {
  const text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  return !!document.querySelector('a[href*="/c/"]') ||
    /(?:no classes|join your first class|class cards could not)/i.test(text);
})()`;
const CLASSROOM_ITEMS_READY = `(() => {
  const text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  return !!document.querySelector('a[href*="/a/"]') ||
    /(?:no work|nothing due|all caught up|no assignments|no upcoming work)/i.test(text);
})()`;
const CLASSROOM_CLASSWORK_READY = `(() => {
  const text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  return !!document.querySelector(
    'a[href*="/a/"], a[href*="/m/"], a[href*="/p/"]'
  ) || /(?:no classwork|no work|nothing here|hasn't posted)/i.test(text);
})()`;

const CLASSROOM_ROUTES: Record<ClassroomView, string> = {
  overview: '/h',
  todo: '/a/not-turned-in/all',
  missing: '/a/missing/all',
  done: '/a/turned-in/all',
  classes: '/h',
  topics: '/h',
};

export function classroomUrl(view: ClassroomView, accountEmail = ''): string {
  if (!Object.prototype.hasOwnProperty.call(CLASSROOM_ROUTES, view)) {
    throw new Error('Unknown Classroom view.');
  }
  return bindGoogleAccount('https://classroom.google.com' + CLASSROOM_ROUTES[view], accountEmail);
}

export async function readClassroom(
  view: ClassroomView = 'todo',
  signal?: AbortSignal,
  options: ClassroomReadOptions = {},
  operationId?: string,
): Promise<string> {
  if (!Object.prototype.hasOwnProperty.call(CLASSROOM_ROUTES, view)) {
    throw new Error('Unknown Classroom view.');
  }
  if (options.scope !== undefined && !['upcoming', 'all'].includes(options.scope)) {
    throw new Error('Unknown Classroom scope.');
  }
  if (options.classFilter !== undefined && String(options.classFilter).length > 120) {
    throw new Error('Classroom classFilter must be 120 characters or fewer.');
  }
  if (
    options.maxClasses !== undefined &&
    (!Number.isInteger(options.maxClasses) || options.maxClasses < 1 || options.maxClasses > MAX_CLASSROOM_TOPIC_CLASSES)
  ) {
    throw new Error('Classroom maxClasses must be an integer from 1 to ' + MAX_CLASSROOM_TOPIC_CLASSES + '.');
  }
  const selectedView = view;
  const requestedOptions: ClassroomReadOptions = {
    scope: options.scope ?? 'upcoming',
    daysAhead: options.daysAhead,
    limit: options.limit,
    classFilter: boundedString(options.classFilter, 120),
    maxClasses: options.maxClasses ?? MAX_CLASSROOM_TOPIC_CLASSES,
  };

  return runGoogleTabTask(async () => {
    const identity = selectedGoogleAccountLock(operationId);
    if (selectedView === 'topics') {
      const dashboard = await googleTabFor(classroomUrl('classes', identity.accountEmail), identity, signal);
      await verifyGoogleAccount(dashboard, signal);
      let classes = normaliseClassroomClasses(
        await evaluateInTab(CLASSROOM_CLASSES_EXTRACT, dashboard.tabId, dashboard.profile, signal),
      );
      if (!classes.length) {
        await waitFor(
          CLASSROOM_CLASSES_READY,
          dashboard.tabId,
          dashboard.profile,
          CLASSROOM_PAGE_READY_TIMEOUT_MS,
          signal,
        );
        classes = normaliseClassroomClasses(
          await evaluateInTab(CLASSROOM_CLASSES_EXTRACT, dashboard.tabId, dashboard.profile, signal),
        );
      }

      const selected = selectClassroomClasses(
        classes,
        requestedOptions.classFilter,
        requestedOptions.maxClasses,
      );
      const account = dashboard.accountEmail
        ? 'Account lock: ' + maskBrowserAccountEmail(dashboard.accountEmail) + ' (verified)'
        : 'Profile lock: ' + dashboard.profileName + ' (' + dashboard.profileDir + ')';
      if (!selected.length) {
        const available = classes.length
          ? '\nActive classes found:\n' + classes.slice(0, 20).map((course) => '- ' + course.name).join('\n')
          : '';
        return 'No active Classroom classes matched' +
          (requestedOptions.classFilter ? ' "' + requestedOptions.classFilter + '"' : ' the request') +
          '.\n' + account + available;
      }

      const classSections: string[] = [];
      const failures: string[] = [];
      for (const [index, course] of selected.entries()) {
        throwIfAborted(signal);
        const workUrl = classroomClassworkUrl(course.url ?? '', identity.accountEmail);
        if (!workUrl) {
          failures.push(course.name + ': the dashboard did not expose a usable Classwork URL.');
          continue;
        }
        try {
          const session = await googleTabFor(workUrl, identity, signal);
          await verifyGoogleAccount(session, signal);
          let snapshot = normaliseClassroomClasswork(
            await evaluateInTab(CLASSROOM_CLASSWORK_EXTRACT, session.tabId, session.profile, signal),
          );
          if (!snapshot.items.length) {
            await waitFor(
              CLASSROOM_CLASSWORK_READY,
              session.tabId,
              session.profile,
              2_200,
              signal,
            );
            snapshot = normaliseClassroomClasswork(
              await evaluateInTab(CLASSROOM_CLASSWORK_EXTRACT, session.tabId, session.profile, signal),
            );
          }

          const headings = snapshot.headings
            .filter((heading) => heading.toLocaleLowerCase() !== course.name.toLocaleLowerCase())
            .slice(0, 4);
          const itemLines = snapshot.items.slice(0, 8).map((item) => {
            const topic = item.topic && item.topic.toLocaleLowerCase() !== item.title.toLocaleLowerCase()
              ? '[' + item.topic + '] '
              : '';
            const context = item.context && item.context.toLocaleLowerCase() !== item.title.toLocaleLowerCase()
              ? ' — ' + item.context
              : '';
            const attachments = item.attachmentUrls.length
              ? '\n      attachments: ' + item.attachmentUrls.slice(0, 2).join(', ')
              : '';
            return '   - ' + topic + item.title + ' (' + item.kind + ')' + context + attachments;
          });
          const fallback = !itemLines.length && snapshot.text
            ? ['   Visible page summary: ' + snapshot.text.slice(0, 700)]
            : ['   No visible classwork items were found.'];
          classSections.push([
            (index + 1) + '. ' + course.name +
              (course.context && course.context !== course.name ? ' — ' + course.context : ''),
            '   First visible topics: ' + (headings.length ? headings.join(' | ') : '(no topic headings exposed)'),
            ...(itemLines.length ? itemLines : fallback),
          ].join('\n'));
        } catch (error) {
          throwIfAborted(signal);
          const message = error instanceof Error ? error.message : String(error);
          if (/^GOOGLE_(?:ACCOUNT|SIGN_IN)/.test(message)) throw error;
          failures.push(course.name + ': ' + message.slice(0, 240));
        }
      }

      const omitted = Math.max(0, classes.length - selected.length);
      return [
        'Classroom first-unit scan — ' + classSections.length + ' class(es) read' +
          (requestedOptions.classFilter ? ' matching "' + requestedOptions.classFilter + '"' : ''),
        account,
        'One retained Classroom tab was reused sequentially; no per-class tabs were opened.',
        omitted ? omitted + ' non-matching or excess active class(es) were skipped.' : '',
        '',
        ...classSections,
        ...(failures.length ? ['', 'Classes that could not be read:', ...failures.map((failure) => '- ' + failure)] : []),
      ].filter(Boolean).join('\n');
    }
    if (selectedView === 'overview') {
      const classesSession = await googleTabFor(classroomUrl('classes', identity.accountEmail), identity, signal);
      await verifyGoogleAccount(classesSession, signal);
      let classes = normaliseClassroomClasses(
        await evaluateInTab(CLASSROOM_CLASSES_EXTRACT, classesSession.tabId, classesSession.profile, signal),
      );
      if (!classes.length) {
        await waitFor(
          CLASSROOM_CLASSES_READY,
          classesSession.tabId,
          classesSession.profile,
          CLASSROOM_PAGE_READY_TIMEOUT_MS,
          signal,
        );
        classes = normaliseClassroomClasses(
          await evaluateInTab(CLASSROOM_CLASSES_EXTRACT, classesSession.tabId, classesSession.profile, signal),
        );
      }

      const todoSession = await googleTabFor(classroomUrl('todo', identity.accountEmail), identity, signal);
      await verifyGoogleAccount(todoSession, signal);
      let items = normaliseClassroomItems(
        await evaluateInTab(CLASSROOM_EXTRACT, todoSession.tabId, todoSession.profile, signal),
      );
      let todoReady = items.length > 0;
      if (!todoReady) {
        todoReady = await waitFor(
          CLASSROOM_ITEMS_READY,
          todoSession.tabId,
          todoSession.profile,
          CLASSROOM_PAGE_READY_TIMEOUT_MS,
          signal,
        );
        items = normaliseClassroomItems(
          await evaluateInTab(CLASSROOM_EXTRACT, todoSession.tabId, todoSession.profile, signal),
        );
      }
      const selection = selectClassroomItems(items, requestedOptions);
      const account = todoSession.accountEmail
        ? 'Account lock: ' + maskBrowserAccountEmail(todoSession.accountEmail) + ' (verified)'
        : 'Profile lock: ' + todoSession.profileName + ' (' + todoSession.profileDir + ')';
      const classLines = classes.length
        ? classes.map((course, index) => {
            const context = course.context && course.context !== course.name
              ? ' — ' + course.context
              : '';
            return (index + 1) + '. ' + course.name + context;
          })
        : ['(Class cards could not be extracted from the current dashboard.)'];
      const itemLines = selection.items.length
        ? selection.items.map((item, index) => {
            const assignment = item.assignmentUrl ? '\n   assignment: ' + item.assignmentUrl : '';
            const attachments = item.attachmentUrls.length
              ? '\n   attachments:\n' + item.attachmentUrls.map((url) => '   - ' + url).join('\n')
              : '';
            return (index + 1) + '. ' + item.title + (item.due ? '\n   ' + item.due : '') +
              '\n   ' + item.context + assignment + attachments;
          })
        : [todoReady
            ? 'No upcoming work found in the next ' + selection.daysAhead + ' days.'
            : 'The upcoming-work page did not become readable within 3.5 seconds.'];
      const omitted = selection.omitted
        ? '\n' + selection.omitted + ' older, out-of-range, or excess item(s) omitted.'
        : '';
      return [
        'Classroom overview — ' + classes.length + ' active class(es), ' + selection.items.length +
          ' upcoming item(s) in the next ' + selection.daysAhead + ' days',
        account,
        '',
        'Classes:',
        ...classLines,
        '',
        'Upcoming work (all classes, nearest first):',
        ...itemLines,
      ].join('\n') + omitted;
    }

    if (selectedView === 'classes') {
      const session = await googleTabFor(classroomUrl('classes', identity.accountEmail), identity, signal);
      await verifyGoogleAccount(session, signal);
      let classes = normaliseClassroomClasses(
        await evaluateInTab(CLASSROOM_CLASSES_EXTRACT, session.tabId, session.profile, signal),
      );
      if (!classes.length) {
        await waitFor(
          CLASSROOM_CLASSES_READY,
          session.tabId,
          session.profile,
          CLASSROOM_PAGE_READY_TIMEOUT_MS,
          signal,
        );
        classes = normaliseClassroomClasses(
          await evaluateInTab(CLASSROOM_CLASSES_EXTRACT, session.tabId, session.profile, signal),
        );
      }
      const account = session.accountEmail
        ? 'Account lock: ' + maskBrowserAccountEmail(session.accountEmail) + ' (verified)'
        : 'Profile lock: ' + session.profileName + ' (' + session.profileDir + ')';
      return [
        'Classroom classes — ' + classes.length + ' active class(es)',
        account,
        ...(classes.length
          ? classes.map((course, index) =>
              (index + 1) + '. ' + course.name +
              (course.context && course.context !== course.name ? ' — ' + course.context : ''))
          : ['No active class cards were found.']),
      ].join('\n');
    }

    const session = await googleTabFor(classroomUrl(selectedView, identity.accountEmail), identity, signal);
    await verifyGoogleAccount(session, signal);
    let raw = await evaluateInTab(CLASSROOM_EXTRACT, session.tabId, session.profile, signal);
    let items = normaliseClassroomItems(raw);
    let ready = items.length > 0;
    if (!ready) {
      ready = await waitFor(
        CLASSROOM_ITEMS_READY,
        session.tabId,
        session.profile,
        CLASSROOM_PAGE_READY_TIMEOUT_MS,
        signal,
      );
      raw = await evaluateInTab(
        CLASSROOM_EXTRACT,
        session.tabId,
        session.profile,
        signal,
      );
      items = normaliseClassroomItems(raw);
    }
    if (!items.length) {
      const text = String(await evaluateInTab(
        'document.body.innerText.slice(0, 4000)',
        session.tabId,
        session.profile,
        signal,
      ));
      if (/sign in|choose an account/i.test(text)) {
        return 'Classroom is showing a sign-in page — the browser is not on the school profile.';
      }
      if (!ready) return 'Classroom did not finish loading in time.';
      return 'Nothing matched the assignment layout. Page text:\n\n' + text;
    }

    const effectiveOptions = selectedView === 'todo'
      ? requestedOptions
      : { ...requestedOptions, scope: 'all' as ClassroomScope };
    const selection = selectClassroomItems(items, effectiveOptions);
    if (!selection.items.length) {
      return 'No upcoming Classroom work was found in the next ' + selection.daysAhead +
        ' days. Older, overdue, completed, and out-of-range items were skipped.';
    }
    const label = selectedView === 'todo' && selection.scope === 'upcoming'
      ? 'todo, upcoming ' + selection.daysAhead + ' days'
      : selectedView;
    const omitted = selection.omitted
      ? '\n' + selection.omitted + ' older, out-of-range, or excess item(s) omitted.'
      : '';
    const account = session.accountEmail
      ? 'Account lock: ' + maskBrowserAccountEmail(session.accountEmail) + ' (verified)'
      : 'Profile lock: ' + session.profileName + ' (' + session.profileDir + ')';
    return [
      'Classroom (' + label + ') — ' + selection.items.length + ' item(s), nearest first',
      account,
      ...selection.items.map((item, index) => {
        const assignment = item.assignmentUrl ? '\n   assignment: ' + item.assignmentUrl : '';
        const attachments = item.attachmentUrls.length
          ? '\n   attachments:\n' + item.attachmentUrls.map((url) => '   - ' + url).join('\n')
          : '';
        return (index + 1) + '. ' + item.title + (item.due ? '\n   ' + item.due : '') +
          '\n   ' + item.context + assignment + attachments;
      }),
    ].join('\n') + omitted;
  }, signal);
}
/** Called when the selected browser profile changes. */
export function resetGoogleSession(): void {
  googleSession = undefined;
  lastGmailListing = undefined;
}
