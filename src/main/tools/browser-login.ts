import { throwIfAborted, waitWithAbort } from '../abort';
import * as chrome from './chrome';

const MAX_LOGIN_CONTROLS = 100;
const MAX_LOGIN_TEXT = 5_000;
const MAX_LOGIN_RUNTIME_MS = 30_000;
const MAX_LOGIN_TRANSITIONS = 8;
const LOGIN_SETTLE_MS = 2_500;

export interface LoginControl {
  name: string;
  role: string;
  tag: string;
  selector: string;
  type?: string;
  autocomplete?: string;
  disabled: boolean;
  filled: boolean;
  sensitive: boolean;
}

export interface LoginPageState {
  title: string;
  url: string;
  text: string;
  humanChallenge: boolean;
  controls: LoginControl[];
}

export type LoginDecision =
  | { kind: 'complete'; reason: string }
  | { kind: 'click'; selector: string; label: string }
  | { kind: 'fill-account'; selector: string; label: string }
  | { kind: 'focus-password'; selector: string; label: string }
  | {
      kind: 'user-action';
      code: 'credential' | 'verification' | 'challenge' | 'consent' | 'identity';
      reason: string;
    }
  | { kind: 'wait'; reason: string };

const DIRECT_LOGIN_REQUEST =
  /\b(?:log[ -]?in|sign[ -]?in|authenticate|continue (?:the )?(?:log[ -]?in|sign[ -]?in)|finish (?:the )?(?:log[ -]?in|sign[ -]?in))\b/i;
const LOGIN_CONTINUATION =
  /^(?:done|continue|go ahead|try again|retry|approved|verified|entered it|i did it|that(?:'s| is) done)[.! ]*$/i;
const LOGIN_HANDOFF = /\bLOGIN_(?:CREDENTIAL|VERIFICATION|HUMAN_CHECK|CONSENT|IDENTITY)_REQUIRED\b/;

/**
 * Keeps a short “done” follow-up on the login tool only when the immediately
 * preceding result explicitly handed a sign-in step to the user.
 */
export function browserLoginRequestForTurn(
  userText: string,
  history: readonly { role: string; content: string }[],
): boolean {
  const text = String(userText ?? '').trim();
  if (DIRECT_LOGIN_REQUEST.test(text)) return true;
  if (!LOGIN_CONTINUATION.test(text) || text.length > 80) return false;
  for (let index = history.length - 1, inspected = 0; index >= 0 && inspected < 8; index -= 1) {
    const message = history[index];
    if (!message) continue;
    if (!['assistant', 'tool'].includes(message.role)) continue;
    inspected += 1;
    if (LOGIN_HANDOFF.test(message.content)) return true;
    if (message.role === 'assistant' && message.content.trim()) return false;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clip(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maximum) : '';
}

function safeUrl(value: unknown): string {
  const raw = clip(value, 4_000);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.username = '';
    parsed.password = '';
    return parsed.href.slice(0, 4_000);
  } catch {
    return '';
  }
}

function normaliseLoginControl(value: unknown): LoginControl | null {
  if (!isRecord(value)) return null;
  const selector = clip(value.selector, 2_000);
  if (!selector) return null;
  const type = clip(value.type, 80).toLowerCase();
  return {
    name: clip(value.name, 500),
    role: clip(value.role, 80).toLowerCase(),
    tag: clip(value.tag, 40).toLowerCase(),
    selector,
    ...(type ? { type } : {}),
    ...(clip(value.autocomplete, 120)
      ? { autocomplete: clip(value.autocomplete, 120).toLowerCase() }
      : {}),
    disabled: value.disabled === true,
    filled: value.filled === true,
    sensitive: value.sensitive === true || type === 'password',
  };
}

/** Validates login-page data before it can drive any browser action. */
export function normaliseLoginPageState(value: unknown): LoginPageState | null {
  if (!isRecord(value) || !Array.isArray(value.controls)) return null;
  const url = safeUrl(value.url);
  if (!url) return null;
  return {
    title: clip(value.title, 240),
    url,
    text: clip(value.text, MAX_LOGIN_TEXT),
    humanChallenge: value.humanChallenge === true,
    controls: value.controls
      .slice(0, MAX_LOGIN_CONTROLS)
      .map(normaliseLoginControl)
      .filter((item): item is LoginControl => Boolean(item)),
  };
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[\s\u00a0]+/g, ' ').trim();
}

function isAction(control: LoginControl): boolean {
  return (
    !control.disabled &&
    (['button', 'link', 'option', 'radio'].includes(control.role) ||
      ['button', 'a'].includes(control.tag) ||
      (control.tag === 'input' && ['button', 'submit'].includes(control.type ?? '')))
  );
}

function isField(control: LoginControl): boolean {
  return (
    !control.disabled &&
    (control.role === 'textbox' ||
      control.tag === 'textarea' ||
      (control.tag === 'input' &&
        !['button', 'submit', 'hidden', 'checkbox', 'radio', 'file'].includes(control.type ?? 'text')))
  );
}

function actionMatching(
  controls: readonly LoginControl[],
  names: readonly RegExp[],
): LoginControl | undefined {
  const actions = controls.filter(isAction);
  for (const pattern of names) {
    const exact = actions.find((control) => pattern.test(normalizedName(control.name)));
    if (exact) return exact;
  }
  return undefined;
}

function fieldMatching(
  controls: readonly LoginControl[],
  predicate: (control: LoginControl, name: string) => boolean,
): LoginControl | undefined {
  return controls.find((control) => isField(control) && predicate(control, normalizedName(control.name)));
}

function looksLikeLoginSurface(state: LoginPageState): boolean {
  const route = (() => {
    try {
      const parsed = new URL(state.url);
      return parsed.hostname + parsed.pathname;
    } catch {
      return state.url;
    }
  })();
  return (
    state.controls.some(isField) ||
    /(?:^|[./_-])(login|log-in|signin|sign-in|auth|sso|oauth)(?:[./_-]|$)/i.test(route) ||
    /\b(sign in|log in|verify your identity|authentication)\b/i.test(state.title)
  );
}

const PRIMARY_ACTIONS = [
  /^next$/,
  /^continue$/,
  /^sign in$/,
  /^log in$/,
  /^login$/,
  /^verify$/,
  /^submit$/,
  /^use this account$/,
  /^send (?:a )?(?:notification|code)$/,
  /^approve sign[ -]?in$/,
];

/** Chooses one reversible login step from a bounded, already-observed page state. */
export function decideLoginStep(state: LoginPageState, account = ''): LoginDecision {
  const text = normalizedName(state.text);
  const configuredAccount = normalizedName(account);
  const actions = state.controls.filter(isAction);

  if (
    state.humanChallenge ||
    /\b(captcha|recaptcha|hcaptcha|verify (?:that )?you(?:'| a)?re human|security puzzle)\b/i.test(text)
  ) {
    return {
      kind: 'user-action',
      code: 'challenge',
      reason: 'The site is asking for a human verification challenge.',
    };
  }

  if (
    /\b(wants to access|allow access to|permissions requested|grant access|review permissions|will be able to)\b/i.test(text)
  ) {
    return {
      kind: 'user-action',
      code: 'consent',
      reason: 'The page is asking for new account permissions, not only authentication.',
    };
  }

  if (configuredAccount) {
    const accountChoice = actions.find((control) =>
      normalizedName(control.name).includes(configuredAccount),
    );
    if (accountChoice) {
      return {
        kind: 'click',
        selector: accountChoice.selector,
        label: 'configured account',
      };
    }
  }

  const oneTimeCode = fieldMatching(
    state.controls,
    (control, name) =>
      control.autocomplete === 'one-time-code' ||
      /\b(one[ -]?time|verification|security|authenticator|otp|passcode|code)\b/i.test(name),
  );
  if (oneTimeCode) {
    if (!oneTimeCode.filled) {
      return {
        kind: 'user-action',
        code: 'verification',
        reason: 'A one-time verification code is required.',
      };
    }
    const action = actionMatching(state.controls, PRIMARY_ACTIONS);
    return action
      ? { kind: 'click', selector: action.selector, label: action.name || 'verify' }
      : { kind: 'wait', reason: 'The verification code is filled but no unique submit control is visible yet.' };
  }

  const password = fieldMatching(
    state.controls,
    (control, name) =>
      control.type === 'password' ||
      control.autocomplete === 'current-password' ||
      control.autocomplete === 'new-password' ||
      /\bpassword\b/i.test(name),
  );
  if (password) {
    if (!password.filled) {
      return {
        kind: 'focus-password',
        selector: password.selector,
        label: password.name || 'Password',
      };
    }
    const action = actionMatching(state.controls, PRIMARY_ACTIONS);
    return action
      ? { kind: 'click', selector: action.selector, label: action.name || 'sign in' }
      : { kind: 'wait', reason: 'The saved password is filled but no unique submit control is visible yet.' };
  }

  const identity = fieldMatching(
    state.controls,
    (control, name) =>
      control.type === 'email' ||
      control.autocomplete === 'username' ||
      /\b(email|e-mail|username|user name|account)\b/i.test(name),
  );
  if (identity) {
    if (!identity.filled) {
      return configuredAccount
        ? {
            kind: 'fill-account',
            selector: identity.selector,
            label: identity.name || 'Account',
          }
        : {
            kind: 'user-action',
            code: 'identity',
            reason: 'The sign-in page needs an account name that is not configured for this browser profile.',
          };
    }
    const action = actionMatching(state.controls, PRIMARY_ACTIONS);
    return action
      ? { kind: 'click', selector: action.selector, label: action.name || 'next' }
      : { kind: 'wait', reason: 'The account field is filled but no unique next control is visible yet.' };
  }

  if (/\bstay signed in\b/i.test(text)) {
    const yes = actionMatching(state.controls, [/^yes$/, /^continue$/]);
    if (yes) return { kind: 'click', selector: yes.selector, label: yes.name || 'yes' };
  }

  if (/\b(check|approve|open).{0,30}\b(phone|device|authenticator)\b/i.test(text)) {
    const action = actionMatching(state.controls, PRIMARY_ACTIONS);
    return action
      ? { kind: 'click', selector: action.selector, label: action.name || 'continue verification' }
      : {
          kind: 'user-action',
          code: 'verification',
          reason: 'The site is waiting for approval on a trusted device.',
        };
  }

  const primary = actionMatching(state.controls, PRIMARY_ACTIONS);
  if (primary && (looksLikeLoginSurface(state) || /^(sign in|log in|login)$/.test(normalizedName(primary.name)))) {
    return { kind: 'click', selector: primary.selector, label: primary.name || 'continue' };
  }

  if (!looksLikeLoginSurface(state)) {
    return { kind: 'complete', reason: 'No sign-in controls remain on the current page.' };
  }

  return { kind: 'wait', reason: 'The sign-in page has no unique safe next action yet.' };
}

const LOGIN_PAGE_EXPRESSION = `(() => {
  const clip = (value, maximum) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, maximum);
  const visible = (element) => {
    if (!(element instanceof Element) || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 &&
      rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
  };
  const css = (value) => {
    if (globalThis.CSS && typeof CSS.escape === 'function') return CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => '\\\\' + character);
  };
  const selectorFor = (element) => {
    if (element.id) return '#' + css(element.id);
    const dataAttribute = element.hasAttribute('data-testid')
      ? 'data-testid'
      : element.hasAttribute('data-test')
        ? 'data-test'
        : '';
    const dataTest = dataAttribute ? element.getAttribute(dataAttribute) : '';
    if (dataAttribute && dataTest) {
      return element.tagName.toLowerCase() + '[' + dataAttribute + '="' + css(dataTest) + '"]';
    }
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1) {
      let part = current.tagName.toLowerCase();
      const name = current.getAttribute('name');
      if (name) part += '[name="' + css(name) + '"]';
      else {
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter((candidate) => candidate.tagName === current.tagName)
          : [];
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ').slice(0, 2000);
  };
  const nameFor = (element) => {
    const label = element.labels && element.labels.length
      ? Array.from(element.labels).map((item) => item.innerText || item.textContent || '').join(' ')
      : '';
    return clip(
      element.getAttribute('aria-label') ||
      element.getAttribute('data-email') ||
      element.getAttribute('data-identifier') ||
      label ||
      element.innerText ||
      element.textContent ||
      element.getAttribute('placeholder') ||
      element.getAttribute('name') ||
      element.getAttribute('value') ||
      element.getAttribute('title'),
      500,
    );
  };
  const selector = [
    'input:not([type="hidden"])', 'textarea', 'button', 'a[href]', '[role="button"]',
    '[role="link"]', '[role="option"]', '[role="radio"]', '[data-email]', '[data-identifier]'
  ].join(',');
  const controls = [];
  const elements = document.querySelectorAll(selector);
  for (let index = 0; index < elements.length && controls.length < ${MAX_LOGIN_CONTROLS}; index += 1) {
    const element = elements[index];
    if (!visible(element)) continue;
    const tag = element.tagName.toLowerCase();
    const type = element instanceof HTMLInputElement ? String(element.type || 'text').toLowerCase() : '';
    const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    const role = element.getAttribute('role') ||
      (tag === 'a' ? 'link' : tag === 'button' || ['button', 'submit'].includes(type) ? 'button' : field ? 'textbox' : '');
    controls.push({
      name: nameFor(element),
      role: clip(role, 80),
      tag,
      selector: selectorFor(element),
      type: type || undefined,
      autocomplete: field ? clip(element.getAttribute('autocomplete'), 120) || undefined : undefined,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      filled: field ? Boolean(String(element.value || '')) : false,
      sensitive: type === 'password',
    });
  }
  const bodyText = clip(document.body ? document.body.innerText || '' : '', ${MAX_LOGIN_TEXT});
  const challengeSelector = [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]',
    '[data-sitekey]', 'input[name*="captcha" i]', '[class*="captcha" i]', '[id*="captcha" i]'
  ].join(',');
  return JSON.stringify({
    title: clip(document.title, 240),
    url: String(location.href || '').slice(0, 4000),
    text: bodyText,
    humanChallenge: Boolean(document.querySelector(challengeSelector)),
    controls,
  });
})()`;

function parseLoginState(value: unknown): LoginPageState {
  if (typeof value !== 'string') throw new Error('Chrome returned invalid login-page data.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Chrome returned malformed login-page data.');
  }
  const state = normaliseLoginPageState(parsed);
  if (!state) throw new Error('Chrome returned an unsafe login-page snapshot.');
  return state;
}

async function inspectLoginPage(
  tabId: string,
  profile: chrome.BrowserProfile,
  signal?: AbortSignal,
): Promise<LoginPageState> {
  return parseLoginState(await chrome.evaluateInTab(LOGIN_PAGE_EXPRESSION, tabId, profile, signal));
}

function stateSignature(state: LoginPageState): string {
  return [
    state.url,
    state.title,
    state.humanChallenge ? 'challenge' : '',
    ...state.controls.map((control) =>
      [control.selector, control.name, control.type ?? '', control.filled ? 'filled' : 'empty', control.disabled ? 'disabled' : ''].join('|'),
    ),
  ].join('\n');
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'the current site';
  }
}

async function shortWait(ms: number, signal?: AbortSignal): Promise<void> {
  await waitWithAbort(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

async function waitForLoginChange(
  before: LoginPageState,
  tabId: string,
  profile: chrome.BrowserProfile,
  signal?: AbortSignal,
): Promise<LoginPageState> {
  const beforeSignature = stateSignature(before);
  const deadline = Date.now() + LOGIN_SETTLE_MS;
  let current = before;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    await shortWait(120, signal);
    try {
      current = await inspectLoginPage(tabId, profile, signal);
      if (stateSignature(current) !== beforeSignature) return current;
    } catch {
      // Navigation can briefly detach the old document. Keep the same tab and
      // sample again; never replay the completed click.
    }
  }
  return current;
}

function cleanAccount(value: unknown): string {
  const account = clip(value, 320);
  if (!account || /[\r\n\0]/.test(account)) return '';
  return account;
}

function maskedAccount(value: string): string {
  if (!value.includes('@')) return value ? value.slice(0, 2) + '…' : '';
  return chrome.maskBrowserAccountEmail(value);
}

function userActionResult(
  decision: Extract<LoginDecision, { kind: 'user-action' }>,
  state: LoginPageState,
  identity: chrome.SelectedBrowserIdentity,
): string {
  const code = {
    credential: 'LOGIN_CREDENTIAL_REQUIRED',
    verification: 'LOGIN_VERIFICATION_REQUIRED',
    challenge: 'LOGIN_HUMAN_CHECK_REQUIRED',
    consent: 'LOGIN_CONSENT_REQUIRED',
    identity: 'LOGIN_IDENTITY_REQUIRED',
  }[decision.code];
  const next = decision.code === 'credential'
    ? 'Use Chrome\'s saved-password prompt or enter the password in this existing tab once.'
    : decision.code === 'verification'
      ? 'Complete the requested code or trusted-device approval.'
      : decision.code === 'challenge'
        ? 'Complete the site\'s human verification in the existing tab.'
        : decision.code === 'consent'
          ? 'Review the requested permissions and choose whether to allow them.'
          : 'Enter or choose the intended account in the existing tab.';
  return (
    code + ': ' + decision.reason + ' ' + next +
    ' Then tell Adi “continue login”. Adi retained the same tab in ' +
    identity.profileName + ' (' + identity.profileDir + ') on ' + hostname(state.url) +
    '; Chrome does not need to restart.'
  );
}

/** Continues an ordinary sign-in flow adaptively in one locked existing tab. */
export async function continueBrowserLogin(
  rawArgs: Record<string, unknown>,
  operationId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const requestedTabId = clip(rawArgs.tabId, 240);
  const identity = chrome.browserIdentityForRequest(operationId);
  const requestedAccount = cleanAccount(rawArgs.account);
  const account = requestedAccount || identity.accountEmail || '';
  const runtimeSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(MAX_LOGIN_RUNTIME_MS)])
    : AbortSignal.timeout(MAX_LOGIN_RUNTIME_MS);
  const runtime = await chrome.chromeRuntimeSnapshotFresh(identity.profile, runtimeSignal, operationId);
  const tabId = requestedTabId || runtime.tabId;
  if (!tabId) {
    throw new Error('LOGIN_TAB_REQUIRED: No connected active Chrome tab is available. Open the sign-in page in the locked profile and try again.');
  }

  let state = await inspectLoginPage(tabId, identity.profile, runtimeSignal);
  if (
    /(^|\.)google\.com$/i.test(hostname(state.url)) &&
    identity.accountEmail &&
    requestedAccount &&
    identity.accountEmail.toLowerCase() !== requestedAccount.toLowerCase()
  ) {
    throw new Error(
      'LOGIN_ACCOUNT_MISMATCH: This request is locked to ' +
      maskedAccount(identity.accountEmail) + ' in ' + identity.profileName +
      ' (' + identity.profileDir + '). Adi will not silently switch Google accounts.',
    );
  }

  const actions: string[] = [];
  const attemptedPasswordFocus = new Set<string>();
  const actedStates = new Set<string>();

  for (let transition = 0; transition < MAX_LOGIN_TRANSITIONS; transition += 1) {
    throwIfAborted(runtimeSignal);
    const decision = decideLoginStep(state, account);

    if (decision.kind === 'complete') {
      return (
        'LOGIN_COMPLETE: ' + decision.reason + ' Verified ' + hostname(state.url) +
        ' in the same tab using ' + identity.profileName + ' (' + identity.profileDir + ')' +
        (account ? ' for ' + maskedAccount(account) : '') + '. ' +
        (actions.length ? 'Completed ' + actions.length + ' sign-in step(s): ' + actions.join(', ') + '. ' : '') +
        'Chrome was not restarted and no new tab was opened.'
      );
    }
    if (decision.kind === 'user-action') return userActionResult(decision, state, identity);

    const signature = stateSignature(state) + '\n' + decision.kind +
      ('selector' in decision ? '\n' + decision.selector : '');
    if (actedStates.has(signature)) {
      return (
        'LOGIN_STALLED: The sign-in page did not expose a new safe action after ' +
        actions.length + ' completed step(s). Inspect the existing tab on ' +
        hostname(state.url) + '; Adi did not replay any click or restart Chrome.'
      );
    }
    actedStates.add(signature);

    if (decision.kind === 'fill-account') {
      await chrome.setValue(decision.selector, account, tabId, runtimeSignal);
      actions.push('filled configured account');
      state = await waitForLoginChange(state, tabId, identity.profile, runtimeSignal);
      continue;
    }

    if (decision.kind === 'focus-password') {
      const focusKey = state.url + '|' + decision.selector;
      if (attemptedPasswordFocus.has(focusKey)) {
        return userActionResult(
          {
            kind: 'user-action',
            code: 'credential',
            reason: 'The password field is still empty after Chrome autofill was invited.',
          },
          state,
          identity,
        );
      }
      attemptedPasswordFocus.add(focusKey);
      await chrome.clickSelector(decision.selector, tabId, runtimeSignal);
      actions.push('focused saved-password field');
      state = await waitForLoginChange(state, tabId, identity.profile, runtimeSignal);
      continue;
    }

    if (decision.kind === 'click') {
      await chrome.clickSelector(decision.selector, tabId, runtimeSignal);
      actions.push(clip(decision.label, 80) || 'continued');
      state = await waitForLoginChange(state, tabId, identity.profile, runtimeSignal);
      continue;
    }

    await shortWait(350, runtimeSignal);
    const next = await inspectLoginPage(tabId, identity.profile, runtimeSignal);
    if (stateSignature(next) === stateSignature(state)) {
      return (
        'LOGIN_STALLED: ' + decision.reason + ' The existing tab on ' +
        hostname(state.url) + ' was left unchanged; inspect it once and tell Adi “continue login”.'
      );
    }
    state = next;
  }

  return (
    'LOGIN_STALLED: Reached the bounded ' + MAX_LOGIN_TRANSITIONS +
    '-transition login limit on ' + hostname(state.url) +
    '. The same tab and profile were retained; inspect the current page before continuing.'
  );
}
