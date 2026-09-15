import { throwIfAborted } from '../abort';
import * as browserSemantic from './browser-semantic';
import * as chrome from './chrome';

const MAX_CHROME_SEQUENCE_STEPS = 24;
const MAX_CHROME_SEQUENCE_RUNTIME_MS = 60_000;
const MAX_CHROME_SEQUENCE_WAIT_MS = 8_000;
const DEFAULT_CHROME_SEQUENCE_WAIT_MS = 4_000;
const MAX_SEQUENCE_OUTPUT_CHARS = 36_000;
const MAX_STEP_OUTPUT_CHARS = 4_000;
const MAX_URL_CHARS = 4_000;
const MAX_SELECTOR_CHARS = 2_000;
const MAX_QUERY_CHARS = 500;
const MAX_INPUT_CHARS = 100_000;
const MAX_KEY_CHARS = 40;

export type ChromeSequenceAction =
  | 'navigate'
  | 'click'
  | 'click_text'
  | 'type'
  | 'fill'
  | 'set_value'
  | 'select_option'
  | 'wait_text'
  | 'wait_selector'
  | 'scroll'
  | 'key'
  | 'back'
  | 'reload'
  | 'page_context'
  | 'snapshot';

export interface ChromeSequenceStep {
  action: ChromeSequenceAction;
  url?: string;
  selector?: string;
  text?: string;
  label?: string;
  value?: string;
  role?: string;
  exact?: boolean;
  key?: string;
  timeoutMs?: number;
  caseSensitive?: boolean;
  amount?: number;
  limit?: number;
}

export interface ChromeSequenceArgs {
  steps: ChromeSequenceStep[];
  tabId?: string;
  includeFinalContext: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(label + ' must be a string.');
  const clean = value.trim();
  if (!allowEmpty && !clean) throw new Error(label + ' is required.');
  if (clean.length > maximum) throw new Error(label + ' exceeds the safety limit.');
  return allowEmpty ? value.slice(0, maximum) : clean;
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maximum);
}

function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(label + ' must be a boolean.');
  return value;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(label + ' must be a finite number.');
  }
  if (value < minimum || value > maximum) {
    throw new Error(label + ' must be between ' + minimum + ' and ' + maximum + '.');
  }
  return Number.isInteger(value) ? value : Math.round(value);
}

function boundedWaitTimeout(value: unknown, label: string): number {
  if (value === undefined) return DEFAULT_CHROME_SEQUENCE_WAIT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(label + ' must be a non-negative finite number.');
  }
  // Models commonly ask for 15–30 second text waits. A stale label then burns
  // most of the request. Clamp it and let the next page snapshot drive recovery.
  return Math.min(MAX_CHROME_SEQUENCE_WAIT_MS, Math.round(value));
}

function normaliseAction(value: unknown): ChromeSequenceAction {
  if (typeof value !== 'string') throw new Error('Each Chrome sequence step needs an action.');
  const action = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  const aliases: Record<string, ChromeSequenceAction> = {
    clicktext: 'click_text',
    click_by_text: 'click_text',
    fill_field: 'fill',
    wait_for_text: 'wait_text',
    wait_for: 'wait_selector',
    press: 'key',
    page: 'page_context',
    context: 'page_context',
  };
  const normalised = aliases[action] ?? action;
  if (
    normalised !== 'navigate' &&
    normalised !== 'click' &&
    normalised !== 'click_text' &&
    normalised !== 'type' &&
    normalised !== 'fill' &&
    normalised !== 'set_value' &&
    normalised !== 'select_option' &&
    normalised !== 'wait_text' &&
    normalised !== 'wait_selector' &&
    normalised !== 'scroll' &&
    normalised !== 'key' &&
    normalised !== 'back' &&
    normalised !== 'reload' &&
    normalised !== 'page_context' &&
    normalised !== 'snapshot'
  ) {
    throw new Error(
      'Unknown Chrome sequence action "' +
        value +
        '". Use navigate, click, click_text, type, fill, set_value, select_option, wait_text, ' +
        'wait_selector, scroll, key, back, reload, page_context, or snapshot.',
    );
  }
  return normalised;
}

function normaliseStep(value: unknown, index: number): ChromeSequenceStep {
  if (!isRecord(value)) throw new Error('Chrome sequence step ' + (index + 1) + ' must be an object.');
  const action = normaliseAction(value.action);
  const step: ChromeSequenceStep = { action };

  switch (action) {
    case 'navigate':
      step.url = requiredString(value.url, 'Step ' + (index + 1) + ' URL', MAX_URL_CHARS);
      break;
    case 'click':
      step.selector = requiredString(value.selector, 'Step ' + (index + 1) + ' selector', MAX_SELECTOR_CHARS);
      break;
    case 'click_text':
      step.text = requiredString(value.text, 'Step ' + (index + 1) + ' visible text', MAX_QUERY_CHARS);
      step.exact = optionalBoolean(value.exact, 'Step ' + (index + 1) + ' exact', false);
      step.role = optionalString(value.role, 'Step ' + (index + 1) + ' role', 80);
      break;
    case 'type':
      step.selector = requiredString(value.selector, 'Step ' + (index + 1) + ' selector', MAX_SELECTOR_CHARS);
      step.text = requiredString(value.text, 'Step ' + (index + 1) + ' text', MAX_INPUT_CHARS, true);
      break;
    case 'fill':
      step.label = requiredString(value.label, 'Step ' + (index + 1) + ' field label', MAX_QUERY_CHARS);
      step.value = requiredString(value.value, 'Step ' + (index + 1) + ' value', MAX_INPUT_CHARS, true);
      break;
    case 'set_value':
      step.selector = requiredString(value.selector, 'Step ' + (index + 1) + ' selector', MAX_SELECTOR_CHARS);
      step.value = requiredString(value.value, 'Step ' + (index + 1) + ' value', MAX_INPUT_CHARS, true);
      break;
    case 'select_option':
      step.selector = requiredString(value.selector, 'Step ' + (index + 1) + ' selector', MAX_SELECTOR_CHARS);
      step.value = requiredString(value.value, 'Step ' + (index + 1) + ' option', MAX_QUERY_CHARS);
      break;
    case 'wait_text':
      step.text = requiredString(value.text, 'Step ' + (index + 1) + ' visible text', MAX_QUERY_CHARS);
      step.timeoutMs = boundedWaitTimeout(value.timeoutMs, 'Step ' + (index + 1) + ' timeoutMs');
      step.caseSensitive = optionalBoolean(value.caseSensitive, 'Step ' + (index + 1) + ' caseSensitive', false);
      break;
    case 'wait_selector':
      step.selector = requiredString(value.selector, 'Step ' + (index + 1) + ' selector', MAX_SELECTOR_CHARS);
      step.timeoutMs = boundedWaitTimeout(value.timeoutMs, 'Step ' + (index + 1) + ' timeoutMs');
      break;
    case 'scroll':
      step.amount = boundedNumber(value.amount, 'Step ' + (index + 1) + ' amount', -50, 50, 1);
      break;
    case 'key':
      step.key = requiredString(value.key, 'Step ' + (index + 1) + ' key', MAX_KEY_CHARS);
      break;
    case 'snapshot':
      step.limit = boundedNumber(value.limit, 'Step ' + (index + 1) + ' limit', 1, 250, 120);
      break;
    case 'back':
    case 'reload':
    case 'page_context':
      break;
  }
  return step;
}

/** Validates and normalizes one browser plan before it reaches the approval gate. */
export function normalizeChromeSequenceArguments(rawArgs: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(rawArgs.steps)) throw new Error('Chrome sequence steps must be an array.');
  if (rawArgs.steps.length < 1 || rawArgs.steps.length > MAX_CHROME_SEQUENCE_STEPS) {
    throw new Error(
      'Chrome sequence must contain between 1 and ' + MAX_CHROME_SEQUENCE_STEPS + ' steps.',
    );
  }
  const tabId =
    rawArgs.tabId === undefined
      ? undefined
      : requiredString(rawArgs.tabId, 'Chrome sequence tabId', 240);
  const includeFinalContext = optionalBoolean(
    rawArgs.includeFinalContext,
    'Chrome sequence includeFinalContext',
    false,
  );
  const steps = rawArgs.steps.map(normaliseStep);
  return {
    steps,
    ...(tabId ? { tabId } : {}),
    includeFinalContext,
  };
}

function clip(value: unknown, maximum: number): string {
  const text = String(value ?? '').trim();
  if (text.length <= maximum) return text;
  return text.slice(0, Math.max(0, maximum - 32)).trimEnd() + '\n…[sequence output truncated]';
}

function describeStep(step: ChromeSequenceStep): string {
  switch (step.action) {
    case 'navigate':
      return 'Navigate the current tab to ' + clip(step.url, 240);
    case 'click':
      return 'Click selector ' + clip(step.selector, 240);
    case 'click_text':
      return (
        'Click visible "' +
        clip(step.text, 160) +
        '"' +
        (step.role ? ' [' + clip(step.role, 60) + ']' : '') +
        (step.exact ? ' exactly' : '')
      );
    case 'type':
      return 'Type into selector ' + clip(step.selector, 240) + ' (text is shown in approval details)';
    case 'fill':
      return 'Fill field "' + clip(step.label, 160) + '" (value is shown in approval details)';
    case 'set_value':
      return 'Set selector ' + clip(step.selector, 240) + ' (value is shown in approval details)';
    case 'select_option':
      return 'Choose "' + clip(step.value, 160) + '" in ' + clip(step.selector, 200);
    case 'wait_text':
      return 'Wait for visible "' + clip(step.text, 160) + '" (up to ' + step.timeoutMs + 'ms)';
    case 'wait_selector':
      return 'Wait for selector ' + clip(step.selector, 240) + ' (up to ' + step.timeoutMs + 'ms)';
    case 'scroll':
      return 'Scroll the current tab ' + (Number(step.amount) >= 0 ? 'down' : 'up');
    case 'key':
      return 'Press ' + clip(step.key, 40) + ' in the current tab';
    case 'back':
      return 'Go back one page in the current tab';
    case 'reload':
      return 'Reload the current tab';
    case 'page_context':
      return 'Read the live page context';
    case 'snapshot':
      return 'Inspect visible controls';
  }
}

/** Produces the exact readable plan shown before a sequence is approved. */
export function describeChromeSequence(rawArgs: Record<string, unknown>): string {
  let args: ChromeSequenceArgs;
  try {
    args = normalizeChromeSequenceArguments(rawArgs) as unknown as ChromeSequenceArgs;
  } catch {
    args = {
      steps: Array.isArray(rawArgs.steps)
        ? rawArgs.steps.map((step) => ({
            action: isRecord(step) && typeof step.action === 'string'
              ? (step.action as ChromeSequenceAction)
              : 'page_context',
          }))
        : [],
      includeFinalContext: rawArgs.includeFinalContext === true,
    };
  }
  const lines = [
    'Run ' +
      args.steps.length +
      ' browser step(s) in the current tab' +
      (args.tabId ? ' [' + clip(args.tabId, 120) + ']' : '') +
      (args.includeFinalContext ? ', then read the final page context' : '') +
      ':',
  ];
  args.steps.forEach((step, index) => {
    lines.push('  ' + (index + 1) + '. ' + clip(describeStep(step), 1_200));
  });
  lines.push('No tab is opened and Chrome is not restarted by this operation.');
  return clip(lines.join('\n'), 12_000);
}

async function runStep(
  step: ChromeSequenceStep,
  tabId: string | undefined,
  profile: chrome.BrowserProfile,
  signal: AbortSignal,
): Promise<string> {
  switch (step.action) {
    case 'navigate':
      return chrome.navigateWithOptionalContext(step.url!, tabId, profile, signal, false);
    case 'click':
      return chrome.clickSelector(step.selector!, tabId, signal);
    case 'click_text':
      return browserSemantic.clickByText(step.text!, step.exact, step.role, tabId, signal);
    case 'type':
      return chrome.typeText(step.selector!, step.text!, tabId, signal);
    case 'fill':
      return browserSemantic.fillFieldByLabel(step.label!, step.value!, tabId, signal);
    case 'set_value':
      return chrome.setValue(step.selector!, step.value!, tabId, signal);
    case 'select_option':
      return chrome.selectOption(step.selector!, step.value!, tabId, signal);
    case 'wait_text':
      return browserSemantic.waitForVisibleText(
        step.text!,
        step.timeoutMs,
        step.caseSensitive,
        tabId,
        signal,
      );
    case 'wait_selector':
      return chrome.waitForSelector(step.selector!, step.timeoutMs, tabId, signal);
    case 'scroll':
      return chrome.scrollPage(step.amount, tabId, signal);
    case 'key':
      return chrome.pressKey(step.key!, tabId, signal);
    case 'back':
      return chrome.goBack(tabId, signal);
    case 'reload':
      return chrome.reloadTab(tabId, signal);
    case 'page_context':
      return (
        (await chrome.readCurrentPageContext(profile, tabId, signal)) ??
        'Live page context was unavailable; the tab may still be loading.'
      );
    case 'snapshot':
      return browserSemantic.snapshotInteractivePage(tabId, step.limit, signal);
  }
}

/** Executes a bounded browser plan serially on one retained tab. */
export async function runChromeSequence(
  rawArgs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const args = normalizeChromeSequenceArguments(rawArgs) as unknown as ChromeSequenceArgs;
  const profile = chrome.selectedBrowserProfile();
  const tabId = args.tabId;
  const sequenceSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(MAX_CHROME_SEQUENCE_RUNTIME_MS)])
    : AbortSignal.timeout(MAX_CHROME_SEQUENCE_RUNTIME_MS);
  const output: string[] = [];
  let completed = 0;

  for (let index = 0; index < args.steps.length; index += 1) {
    const step = args.steps[index];
    if (!step) continue;
    try {
      throwIfAborted(sequenceSignal);
      const result = await runStep(step, tabId, profile, sequenceSignal);
      output.push('[' + (index + 1) + '] ' + describeStep(step) + '\n' + clip(result, MAX_STEP_OUTPUT_CHARS));
      completed = index + 1;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (sequenceSignal.aborted) {
        throw new Error(
          'Chrome sequence exceeded its ' +
            MAX_CHROME_SEQUENCE_RUNTIME_MS / 1_000 +
            's time budget after ' +
            completed +
            ' completed step(s). Inspect the current tab before retrying; completed actions were not replayed.',
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        'Chrome sequence stopped at step ' +
          (index + 1) +
          '/' +
          args.steps.length +
          ' (' +
          step.action +
          ') after ' +
          completed +
          ' completed step(s). Inspect the current tab before retrying; completed actions were not replayed.\n' +
          clip(reason, 2_000),
      );
    }
  }

  if (args.includeFinalContext) {
    try {
      throwIfAborted(sequenceSignal);
      const context = await chrome.readCurrentPageContext(profile, tabId, sequenceSignal);
      output.push(
        'Final page context:\n' +
          clip(context ?? 'Live page context was unavailable after the sequence.', 16_000),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      output.push('Final page context was unavailable after the sequence; no action was replayed.');
    }
  }

  return clip(output.join('\n\n') || '(the browser sequence had no steps)', MAX_SEQUENCE_OUTPUT_CHARS);
}
