import { throwIfAborted, waitWithAbort } from '../abort';
import {
  evaluateInTab,
  isRetryableBrowserError,
  selectedBrowserProfile,
  type BrowserProfile,
} from './chrome';

const MAX_INTERACTIVE_ITEMS = 250;
const DEFAULT_INTERACTIVE_ITEMS = 120;
const MAX_SCANNED_ELEMENTS = 5_000;
const MAX_SELECTOR_CHARS = 2_000;
const MAX_NAME_CHARS = 500;
const MAX_URL_CHARS = 2_000;
const MAX_QUERY_CHARS = 500;
const MAX_ROLE_CHARS = 80;
const MAX_FIELD_VALUE_CHARS = 100_000;
const MAX_SNAPSHOT_OUTPUT_CHARS = 80_000;
const MAX_ACTION_CANDIDATES = 10;
const MAX_WAIT_TIMEOUT_MS = 60_000;

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  'label[for]',
  '[contenteditable="true"]',
  '[onclick]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="menuitem"]',
].join(',');

const FIELD_SELECTOR = [
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="image"])',
  'textarea',
  '[contenteditable="true"]',
  '[role="textbox"]',
].join(',');

export interface InteractiveElementSnapshot {
  name: string;
  role: string;
  tag: string;
  selector: string;
  type?: string;
  disabled: boolean;
  checked?: boolean;
  value?: string;
  href?: string;
  sensitive?: boolean;
}

export interface InteractiveSnapshot {
  title: string;
  url: string;
  profile: BrowserProfile;
  candidateCount: number;
  scanned: number;
  truncated: boolean;
  items: InteractiveElementSnapshot[];
}

export interface SemanticActionCandidate {
  name: string;
  role: string;
  tag: string;
  selector: string;
}

export interface SemanticActionState {
  title: string;
  url: string;
  text: string;
  visible: boolean;
  expanded?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface SemanticActionResult {
  status: 'clicked' | 'filled' | 'not_found' | 'ambiguous';
  query: string;
  title: string;
  url: string;
  matched?: SemanticActionCandidate;
  candidates: SemanticActionCandidate[];
  before?: SemanticActionState;
  after?: SemanticActionState;
  changed?: boolean;
  verified?: boolean;
  sensitive?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clipped(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function boundedNumber(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function requiredQuery(value: string, label: string, maximum = MAX_QUERY_CHARS): string {
  const clean = value.trim();
  if (!clean) throw new Error(label + ' is required.');
  if (clean.length > maximum) throw new Error(label + ' exceeds the safety limit.');
  return clean;
}

function normaliseCandidate(value: unknown): SemanticActionCandidate | null {
  if (!isRecord(value)) return null;
  const selector = clipped(value.selector, MAX_SELECTOR_CHARS);
  if (!selector) return null;
  return {
    name: clipped(value.name, MAX_NAME_CHARS),
    role: clipped(value.role, MAX_ROLE_CHARS),
    tag: clipped(value.tag, 40),
    selector,
  };
}

function normaliseInteractiveItem(value: unknown): InteractiveElementSnapshot | null {
  if (!isRecord(value)) return null;
  const base = normaliseCandidate(value);
  if (!base) return null;
  const type = clipped(value.type, 80);
  const sensitive = value.sensitive === true || type.toLowerCase() === 'password';
  return {
    ...base,
    disabled: value.disabled === true,
    ...(type ? { type } : {}),
    ...(typeof value.checked === 'boolean' ? { checked: value.checked } : {}),
    ...(!sensitive && typeof value.value === 'string'
      ? { value: clipped(value.value, MAX_NAME_CHARS) }
      : {}),
    ...(clipped(value.href, MAX_URL_CHARS) ? { href: clipped(value.href, MAX_URL_CHARS) } : {}),
    ...(sensitive ? { sensitive: true } : {}),
  };
}

/** Validates and bounds page-provided snapshot data before it reaches the model. */
export function normaliseInteractiveSnapshot(
  value: unknown,
  profile: BrowserProfile = 'pet',
): InteractiveSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items = value.items
    .slice(0, MAX_INTERACTIVE_ITEMS)
    .map(normaliseInteractiveItem)
    .filter((item): item is InteractiveElementSnapshot => Boolean(item));
  return {
    title: clipped(value.title, 240),
    url: clipped(value.url, MAX_URL_CHARS),
    profile,
    candidateCount: boundedNumber(value.candidateCount, 1_000_000),
    scanned: boundedNumber(value.scanned, MAX_SCANNED_ELEMENTS),
    truncated: value.truncated === true || value.items.length > MAX_INTERACTIVE_ITEMS,
    items,
  };
}

/** Validates and bounds the result of an in-page semantic action. */
function normaliseActionState(value: unknown): SemanticActionState | null {
  if (!isRecord(value)) return null;
  const title = clipped(value.title, 240);
  const url = clipped(value.url, MAX_URL_CHARS);
  const text = clipped(value.text, 800);
  if (!title && !url && !text && typeof value.visible !== 'boolean') return null;
  return {
    title,
    url,
    text,
    visible: value.visible === true,
    ...(typeof value.expanded === 'string' ? { expanded: clipped(value.expanded, 40) } : {}),
    ...(typeof value.checked === 'boolean' ? { checked: value.checked } : {}),
    ...(typeof value.disabled === 'boolean' ? { disabled: value.disabled } : {}),
  };
}
export function normaliseSemanticActionResult(value: unknown): SemanticActionResult | null {
  if (!isRecord(value)) return null;
  if (!['clicked', 'filled', 'not_found', 'ambiguous'].includes(String(value.status))) return null;
  const candidates = Array.isArray(value.candidates)
    ? value.candidates
        .slice(0, MAX_ACTION_CANDIDATES)
        .map(normaliseCandidate)
        .filter((item): item is SemanticActionCandidate => Boolean(item))
    : [];
  const matched = normaliseCandidate(value.matched);
  return {
    status: value.status as SemanticActionResult['status'],
    query: clipped(value.query, MAX_QUERY_CHARS),
    title: clipped(value.title, 240),
    url: clipped(value.url, MAX_URL_CHARS),
    ...(matched ? { matched } : {}),
    candidates,
    ...(normaliseActionState(value.before) ? { before: normaliseActionState(value.before)! } : {}),
    ...(normaliseActionState(value.after) ? { after: normaliseActionState(value.after)! } : {}),
    ...(typeof value.changed === 'boolean' ? { changed: value.changed } : {}),
    ...(typeof value.verified === 'boolean' ? { verified: value.verified } : {}),
    ...(value.sensitive === true ? { sensitive: true } : {}),
  };
}

function parsePageJson(value: unknown, label: string): unknown {
  if (typeof value !== 'string') throw new Error('Chrome returned invalid ' + label + ' data.');
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Chrome returned malformed ' + label + ' data.');
  }
}

function pageHelpers(): string {
  return `
    const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const clip = (value, maximum) => norm(value).slice(0, maximum);
    const visible = (element) => {
      if (!(element instanceof Element) || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
    };
    const cssEscape = (value) => globalThis.CSS && typeof CSS.escape === 'function'
      ? CSS.escape(String(value))
      : String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '\\\\' + char.codePointAt(0).toString(16) + ' ');
    const unique = (selector) => {
      try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
    };
    const selectorFor = (element) => {
      if (element.id) {
        const byId = '#' + cssEscape(element.id);
        if (unique(byId)) return byId;
      }
      const tag = (element.localName || '*').toLowerCase();
      for (const attribute of ['data-testid', 'data-test', 'data-qa', 'name']) {
        const value = element.getAttribute(attribute);
        if (!value || value.length > 200) continue;
        const candidate = tag + '[' + attribute + '="' + cssEscape(value) + '"]';
        if (unique(candidate)) return candidate;
      }
      const parts = [];
      let cursor = element;
      while (cursor instanceof Element && parts.length < 8) {
        const localName = (cursor.localName || '*').toLowerCase();
        if (cursor.id) {
          parts.unshift('#' + cssEscape(cursor.id));
          break;
        }
        const parent = cursor.parentElement;
        if (!parent) {
          parts.unshift(localName);
          break;
        }
        const siblings = [...parent.children].filter((child) => child.localName === cursor.localName);
        const position = siblings.indexOf(cursor) + 1;
        parts.unshift(localName + (siblings.length > 1 ? ':nth-of-type(' + position + ')' : ''));
        const candidate = parts.join(' > ');
        if (unique(candidate)) return candidate;
        cursor = parent;
      }
      return parts.join(' > ').slice(0, ${MAX_SELECTOR_CHARS});
    };
    const labelledByText = (element) => norm((element.getAttribute('aria-labelledby') || '')
      .split(/\\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => node.innerText || node.textContent || '')
      .join(' '));
    const labelText = (element) => {
      const labels = element.labels ? [...element.labels] : [];
      const closest = element.closest && element.closest('label');
      if (closest && !labels.includes(closest)) labels.push(closest);
      return norm(labels.map((label) => label.innerText || label.textContent || '').join(' '));
    };
    const accessibleName = (element) => clip(
      element.getAttribute('aria-label') ||
      labelledByText(element) ||
      labelText(element) ||
      ((element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) ? element.value : '') ||
      element.innerText ||
      element.getAttribute('alt') ||
      element.getAttribute('placeholder') ||
      element.getAttribute('title') ||
      element.getAttribute('name') ||
      '',
      ${MAX_NAME_CHARS},
    );
    const roleFor = (element) => {
      const explicit = norm(element.getAttribute('role')).toLowerCase();
      if (explicit) return explicit.slice(0, ${MAX_ROLE_CHARS});
      const tag = (element.localName || '').toLowerCase();
      if (tag === 'a' && element.hasAttribute('href')) return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = String(element.type || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        return 'textbox';
      }
      if (element.isContentEditable) return 'textbox';
      return tag || 'element';
    };
    const disabled = (element) => Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true';
    const candidate = (element) => ({
      name: accessibleName(element),
      role: roleFor(element),
      tag: (element.localName || '').toLowerCase().slice(0, 40),
      selector: selectorFor(element),
    });
    const chooseMatches = (elements, query, exact, requestedRole) => {
      const needle = norm(query).toLowerCase();
      const roleNeedle = norm(requestedRole).toLowerCase();
      const rows = [];
      for (let index = 0; index < elements.length && index < ${MAX_SCANNED_ELEMENTS}; index += 1) {
        const element = elements[index];
        if (!visible(element) || disabled(element)) continue;
        const item = candidate(element);
        if (!item.name || !item.selector || (roleNeedle && item.role !== roleNeedle)) continue;
        const name = norm(item.name).toLowerCase();
        if (exact ? name === needle : name.includes(needle)) rows.push({ element, item, exact: name === needle });
        if (rows.length >= 100) break;
      }
      if (!exact) {
        const exactRows = rows.filter((row) => row.exact);
        if (exactRows.length) return exactRows;
      }
      return rows;
    };
  `;
}

async function evaluateReadWithRecovery(
  expression: string,
  tabId: string | undefined,
  profile: BrowserProfile,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await evaluateInTab(expression, tabId, profile, signal);
  } catch (error) {
    if (!isRetryableBrowserError(error) || signal?.aborted) throw error;
    throwIfAborted(signal);
    return evaluateInTab(expression, tabId, profile, signal);
  }
}

function formatSnapshot(snapshot: InteractiveSnapshot): string {
  const originalCount = snapshot.items.length;
  let items = snapshot.items;
  let rendered = '';
  while (true) {
    rendered = JSON.stringify({
      ...snapshot,
      returnedItems: items.length,
      omittedItems: originalCount - items.length,
      truncated: snapshot.truncated || items.length < originalCount,
      items,
    }, null, 2);
    if (rendered.length <= MAX_SNAPSHOT_OUTPUT_CHARS || items.length === 0) return rendered;
    items = items.slice(0, Math.max(0, Math.floor(items.length * 0.75)));
  }
}

export async function snapshotInteractivePage(
  tabId?: string,
  limit = DEFAULT_INTERACTIVE_ITEMS,
  signal?: AbortSignal,
): Promise<string> {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(MAX_INTERACTIVE_ITEMS, Math.max(1, Math.floor(limit)))
    : DEFAULT_INTERACTIVE_ITEMS;
  const profile = selectedBrowserProfile();
  const expression = `(() => {
    ${pageHelpers()}
    const elements = document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)});
    const items = [];
    let scanned = 0;
    for (let index = 0; index < elements.length && scanned < ${MAX_SCANNED_ELEMENTS}; index += 1) {
      scanned += 1;
      const element = elements[index];
      if (!visible(element)) continue;
      const item = candidate(element);
      if (!item.selector) continue;
      const type = element instanceof HTMLInputElement ? String(element.type || 'text').toLowerCase() : '';
      const sensitive = type === 'password';
      const checkable = ['checkbox', 'radio', 'switch'].includes(item.role);
      const rawValue = sensitive
        ? ''
        : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? element.value
          : element.isContentEditable
            ? element.innerText || element.textContent || ''
            : '';
      const href = element instanceof HTMLAnchorElement && /^https?:/i.test(element.href || '')
        ? String(element.href).slice(0, ${MAX_URL_CHARS})
        : '';
      items.push({
        ...item,
        type: type || undefined,
        disabled: disabled(element),
        checked: checkable ? Boolean(element.checked || element.getAttribute('aria-checked') === 'true') : undefined,
        value: rawValue ? clip(rawValue, ${MAX_NAME_CHARS}) : undefined,
        href: href || undefined,
        sensitive: sensitive || undefined,
      });
      if (items.length >= ${safeLimit}) break;
    }
    return JSON.stringify({
      title: clip(document.title, 240),
      url: String(location.href || '').slice(0, ${MAX_URL_CHARS}),
      candidateCount: Math.min(elements.length, 1000000),
      scanned,
      truncated: elements.length > scanned || items.length >= ${safeLimit},
      items,
    });
  })()`;
  const raw = await evaluateReadWithRecovery(expression, tabId, profile, signal);
  const snapshot = normaliseInteractiveSnapshot(parsePageJson(raw, 'interactive-page'), profile);
  if (!snapshot) throw new Error('Chrome returned an invalid interactive-page snapshot.');
  throwIfAborted(signal);
  return formatSnapshot(snapshot);
}

function actionFailureMessage(action: 'click' | 'fill', result: SemanticActionResult): string {
  if (result.status === 'not_found') {
    return 'No unique visible element matched "' + result.query + '". Take a fresh chrome_snapshot and try a more specific name.';
  }
  const candidates = result.candidates
    .map((item) => '- ' + (item.name || '(unnamed)') + ' [' + item.role + '] ' + item.selector)
    .join('\n');
  return 'Refused to ' + action + ' because "' + result.query + '" matched multiple visible elements. Use a more specific name or role.\n' + candidates;
}

function parseActionResult(value: unknown, action: 'click' | 'fill'): SemanticActionResult {
  const result = normaliseSemanticActionResult(parsePageJson(value, 'semantic-action'));
  if (!result) throw new Error('Chrome returned an invalid semantic-action result.');
  if (result.status === 'not_found' || result.status === 'ambiguous') {
    throw new Error(actionFailureMessage(action, result));
  }
  return result;
}

function uncertainActionError(action: string, error: unknown): never {
  if (isRetryableBrowserError(error)) {
    throw new Error('Chrome lost the page while trying to ' + action + '. The outcome is uncertain, so the action was not replayed. Inspect the page before retrying.');
  }
  throw error;
}

async function readActionPageState(
  tabId: string | undefined,
  profile: BrowserProfile,
  selector: string | undefined,
  signal?: AbortSignal,
): Promise<SemanticActionState | null> {
  const raw = await evaluateReadWithRecovery(
    [
      '(() => {',
      '  const selector = ' + JSON.stringify(selector || '') + ';',
      '  const element = selector ? document.querySelector(selector) : null;',
      '  const style = element ? getComputedStyle(element) : null;',
      '  const rect = element ? element.getBoundingClientRect() : null;',
      '  const visible = Boolean(element && !element.hidden && element.getAttribute("aria-hidden") !== "true" &&',
      '    style && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&',
      '    element.getClientRects().length > 0 && rect && rect.width > 0 && rect.height > 0);',
      '  return JSON.stringify({',
      '    title: String(document.title || "").slice(0, 240),',
      '    url: String(location.href || "").slice(0, ' + MAX_URL_CHARS + '),',
      '    text: (document.body ? document.body.innerText || "" : "").replace(/\\s+/g, " ").trim().slice(0, 800),',
      '    visible,',
      '    expanded: element ? element.getAttribute("aria-expanded") || undefined : undefined,',
      '    checked: element && typeof element.checked === "boolean"',
      '      ? Boolean(element.checked)',
      '      : element && ["true", "false"].includes(element.getAttribute("aria-checked"))',
      '        ? element.getAttribute("aria-checked") === "true" : undefined,',
      '    disabled: element ? Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true" : undefined,',
      '  });',
      '})()',
    ].join('\n'),
    tabId,
    profile,
    signal,
  );
  return normaliseActionState(parsePageJson(raw, 'semantic-page-state'));
}
function actionStateChanged(
  before: SemanticActionState,
  after: SemanticActionState,
): boolean {
  return before.title !== after.title ||
    before.url !== after.url ||
    before.text !== after.text ||
    before.visible !== after.visible ||
    before.expanded !== after.expanded ||
    before.checked !== after.checked ||
    before.disabled !== after.disabled;
}

export async function clickByText(
  text: string,
  exact = false,
  role?: string,
  tabId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const query = requiredQuery(text, 'Visible text or accessible name');
  const requestedRole = role ? requiredQuery(role, 'Role', MAX_ROLE_CHARS).toLowerCase() : '';
  const profile = selectedBrowserProfile();
  const expression = [
    '(async () => {',
    pageHelpers(),
    '    const pageState = (element) => ({',
    '      title: clip(document.title, 240),',
    '      url: String(location.href || "").slice(0, ' + MAX_URL_CHARS + '),',
    '      text: clip(document.body ? document.body.innerText || "" : "", 800),',
    '      visible: visible(element),',
    '      expanded: element.getAttribute("aria-expanded") || undefined,',
    '      checked: typeof element.checked === "boolean" ? Boolean(element.checked) : ["true", "false"].includes(element.getAttribute("aria-checked")) ? element.getAttribute("aria-checked") === "true" : undefined,',
    '      disabled: disabled(element),',
    '    });',
    '    const matches = chooseMatches(',
    '      document.querySelectorAll(' + JSON.stringify(INTERACTIVE_SELECTOR) + '),',
    '      ' + JSON.stringify(query) + ',',
    '      ' + String(exact === true) + ',',
    '      ' + JSON.stringify(requestedRole) + ',',
    '    );',
    '    const basics = {',
    '      query: ' + JSON.stringify(query) + ',',
    '      title: clip(document.title, 240),',
    '      url: String(location.href || "").slice(0, ' + MAX_URL_CHARS + '),',
    '      candidates: matches.slice(0, ' + MAX_ACTION_CANDIDATES + ').map((row) => row.item),',
    '    };',
    '    if (matches.length === 0) return JSON.stringify({ ...basics, status: "not_found" });',
    '    if (matches.length !== 1) return JSON.stringify({ ...basics, status: "ambiguous" });',
    '    const target = matches[0];',
    '    target.element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });',
    '    try { target.element.focus({ preventScroll: true }); } catch { target.element.focus(); }',
    '    const before = pageState(target.element);',
    '    target.element.click();',
    '    return JSON.stringify({ ...basics, status: "clicked", matched: target.item, candidates: [], before });',
    '  })()',
  ].join('\n');
  try {
    const raw = await evaluateInTab(expression, tabId, profile, signal);
    const result = parseActionResult(raw, 'click');
    throwIfAborted(signal);
    let after: SemanticActionState | null = null;
    const verificationDeadline = Date.now() + 350;
    let delayMs = 0;
    while (Date.now() <= verificationDeadline) {
      throwIfAborted(signal);
      if (delayMs > 0) {
        const remaining = verificationDeadline - Date.now();
        if (remaining <= 0) break;
        await waitWithAbort(
          new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining))),
          signal,
        );
      }
      try {
        after = await readActionPageState(tabId, profile, result.matched?.selector, signal);
        if (result.before && after && actionStateChanged(result.before, after)) break;
      } catch {
        throwIfAborted(signal);
        // Navigation can briefly replace the JavaScript context. Keep polling
        // the resulting page, but never replay the click.
      }
      delayMs = delayMs === 0 ? 40 : Math.min(160, delayMs * 2);
    }    const changed = result.before && after ? actionStateChanged(result.before, after) : false;
    const verified = Boolean(after && changed);
    return JSON.stringify({
      status: result.status,
      clicked: result.matched,
      verified,
      changed,
      pageTitle: after?.title || result.title,
      pageUrlBeforeClick: result.before?.url || result.url,
      pageUrlAfterClick: after?.url || result.url,
      note: after
        ? changed
          ? 'Click executed once and an observable page change was detected. Inspect the resulting page before another consequential action.'
          : 'Click was issued once, but no observable state change was detected. Take a fresh snapshot before continuing.'
        : 'Click was issued once, but its resulting page state could not be verified. Take a fresh snapshot before continuing.',
    }, null, 2);
  } catch (error) {
    uncertainActionError('click "' + query + '"', error);
  }
}
export async function fillFieldByLabel(
  label: string,
  value: string,
  tabId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const query = requiredQuery(label, 'Field label');
  if (value.length > MAX_FIELD_VALUE_CHARS) throw new Error('Field value exceeds the safety limit.');
  const profile = selectedBrowserProfile();
  const expression = `(async () => {
    ${pageHelpers()}
    const matches = chooseMatches(
      document.querySelectorAll(${JSON.stringify(FIELD_SELECTOR)}),
      ${JSON.stringify(query)},
      false,
      '',
    ).filter((row) => !row.element.readOnly);
    const basics = {
      query: ${JSON.stringify(query)},
      title: clip(document.title, 240),
      url: String(location.href || '').slice(0, ${MAX_URL_CHARS}),
      candidates: matches.slice(0, ${MAX_ACTION_CANDIDATES}).map((row) => row.item),
    };
    if (matches.length === 0) return JSON.stringify({ ...basics, status: 'not_found' });
    if (matches.length !== 1) return JSON.stringify({ ...basics, status: 'ambiguous' });
    const target = matches[0];
    const element = target.element;
    const nextValue = ${JSON.stringify(value)};
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    try { element.focus({ preventScroll: true }); } catch { element.focus(); }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) throw new Error('This field does not expose a writable value.');
      setter.call(element, nextValue);
    } else if (element.isContentEditable || element.getAttribute('role') === 'textbox') {
      element.textContent = nextValue;
    } else {
      throw new Error('The matched element is not a writable field.');
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const actualValue = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value
      : element.innerText || element.textContent || '';
    const sensitive = element instanceof HTMLInputElement && element.type === 'password';
    return JSON.stringify({
      ...basics,
      status: 'filled',
      matched: target.item,
      candidates: [],
      verified: actualValue === nextValue,
      sensitive,
    });
  })()`;
  try {
    const raw = await evaluateInTab(expression, tabId, profile, signal);
    const result = parseActionResult(raw, 'fill');
    throwIfAborted(signal);
    return JSON.stringify({
      status: result.status,
      field: result.matched,
      verified: result.verified === true,
      sensitive: result.sensitive === true,
      pageTitle: result.title,
      pageUrl: result.url,
      note: result.verified
        ? 'Field value was set and verified without returning its contents.'
        : 'The page changed the value after input. Inspect the field before continuing.',
    }, null, 2);
  } catch (error) {
    uncertainActionError('fill "' + query + '"', error);
  }
}

export async function waitForVisibleText(
  text: string,
  timeoutMs = 10_000,
  caseSensitive = false,
  tabId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const query = requiredQuery(text, 'Visible text');
  const safeTimeout = Number.isFinite(timeoutMs)
    ? Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(0, Math.floor(timeoutMs)))
    : 10_000;
  const profile = selectedBrowserProfile();
  const started = Date.now();
  const expression = `(() => {
    const body = document.body ? document.body.innerText || '' : '';
    const haystack = ${caseSensitive === true} ? body : body.toLowerCase();
    const needle = ${caseSensitive === true ? JSON.stringify(query) : JSON.stringify(query.toLowerCase())};
    return JSON.stringify({
      found: haystack.includes(needle),
      title: String(document.title || '').slice(0, 240),
      url: String(location.href || '').slice(0, ${MAX_URL_CHARS}),
    });
  })()`;
  do {
    throwIfAborted(signal);
    const raw = await evaluateReadWithRecovery(expression, tabId, profile, signal);
    const result = parsePageJson(raw, 'text-wait');
    if (!isRecord(result) || typeof result.found !== 'boolean') {
      throw new Error('Chrome returned invalid text-wait data.');
    }
    if (result.found) {
      return JSON.stringify({
        found: true,
        text: query,
        elapsedMs: Date.now() - started,
        pageTitle: clipped(result.title, 240),
        pageUrl: clipped(result.url, MAX_URL_CHARS),
        profile,
      }, null, 2);
    }
    if (Date.now() - started >= safeTimeout) break;
    const remaining = safeTimeout - (Date.now() - started);
    if (remaining <= 0) break;
    await waitWithAbort(
      new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining))),
      signal,
    );
  } while (Date.now() - started <= safeTimeout);
  throwIfAborted(signal);
  throw new Error('Visible text "' + query + '" did not appear within ' + safeTimeout / 1_000 + 's.');
}
