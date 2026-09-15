import { createHash } from 'node:crypto';
import type { ToolCall, ToolResult } from '../shared/types';

export interface ToolLoopGuardOptions {
  capabilityManagementRequested?: boolean;
  /** Number of consecutive identical successful observations before replanning. */
  repeatedCallLimit?: number;
  repeatedFailureLimit?: number;
  /** Related failures may be separated by harmless calls and still be one failed tactic. */
  strategyFailureLimit?: number;
  strategyFailureWindow?: number;
  consecutiveFailureLimit?: number;
  discoveryCallLimit?: number;
  /** Number of automatic replans allowed before the circuit opens. */
  maxReplans?: number;
}

const DISCOVERY_AND_DEBUG_TOOLS = new Set([
  'find_tools',
  'list_tools',
  'inspect_tool',
  'test_tool',
]);

function stableValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => stableValue(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 100)
      .map(([key, entry]) => [key, stableValue(entry, depth + 1)]),
  );
}

export function toolCallFingerprint(call: ToolCall): string {
  return call.name + ':' + JSON.stringify(stableValue(call.args)).slice(0, 8_000);
}

function normalizedResultContent(result: ToolResult, ignoreVolatileFailureData = false): string {
  // Duration and call ids are deliberately excluded. Whitespace-only DOM
  // churn is not progress, while any changed readable page/result is. Hash the
  // whole bounded tool result: the old 64K prefix made later Classroom pages
  // look identical when only content near the end changed.
  let content = String(result.content ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (ignoreVolatileFailureData) {
    content = content
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[uuid]')
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '[timestamp]')
      .replace(
        /\b(?:request|operation|trace|target|tab)[-_ ]?id\s*[:=]\s*[\w.-]+/gi,
        (match) => match.replace(/([:=]\s*)[\w.-]+$/i, '$1[id]'),
      )
      .replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, '[duration]');
  }
  return content;
}

function resultFingerprint(result: ToolResult, ignoreVolatileFailureData = false): string {
  const content = normalizedResultContent(result, ignoreVolatileFailureData);
  const images = (result.imageDataUrls ?? []).slice(0, 4).map((value) => {
    const image = String(value);
    return image.length + ':' + image.slice(0, 128) + ':' + image.slice(-128);
  });
  return createHash('sha256')
    .update(JSON.stringify({ ok: result.ok, errorCode: result.errorCode ?? '', content, images }))
    .digest('hex');
}

function failureFingerprint(call: ToolCall, result: ToolResult): string {
  return toolCallFingerprint(call) + ':' + String(result.errorCode ?? '') + ':' + resultFingerprint(result, true);
}

interface FailureStrategy {
  key: string;
  label: string;
}

/**
 * Groups failures by tactic instead of guessed text or selector. Models often
 * retry the same broken browser plan with a slightly different label, timeout,
 * or selector; exact fingerprints cannot recognize that as one loop.
 */
function failureStrategy(call: ToolCall, result: ToolResult): FailureStrategy | undefined {
  const content = String(result.content ?? '');
  if (call.name === 'chrome_sequence') {
    const action = content.match(/chrome sequence stopped at step\s+\d+\/\d+\s+\(([^)]+)\)/i)?.[1]?.toLowerCase();
    if (action === 'wait_text' || action === 'wait_selector') {
      return { key: 'chrome-sequence:wait', label: 'browser wait condition' };
    }
    if (action && ['click', 'click_text', 'fill', 'set_value', 'select_option'].includes(action)) {
      return { key: 'chrome-sequence:target:' + action, label: 'browser ' + action.replace(/_/g, ' ') + ' target' };
    }
  }
  if (
    /^chrome_(?:click|click_text|fill|set_value|select_option)$/.test(call.name) &&
    /no (?:element|unique visible element).*match|not found|could not find|no native (?:html )?(?:<select> )?(?:element|option)|not a native html <select>/i.test(content)
  ) {
    return { key: 'browser-target:' + call.name, label: call.name.replace(/_/g, ' ') + ' target' };
  }
  if (/^chrome_/.test(call.name) && /chrome target became unavailable|stale tab|no tab matches/i.test(content)) {
    return { key: 'browser-target:stale', label: 'stale browser target' };
  }
  if (call.name === 'read_classroom' && /could not verify|sign[ -]?in|classroom.*unavailable|target became unavailable/i.test(content)) {
    return { key: 'classroom:unavailable', label: 'account-locked Classroom access' };
  }
  return undefined;
}

function resultReportsVerifiedStateChange(call: ToolCall, result: ToolResult): boolean {
  if (!result.ok || !/^chrome_(?:click|click_text|sequence)$/.test(call.name)) return false;
  return /["'](?:changed|verified)["']\s*:\s*true\b/i.test(result.content) ||
    /observable (?:page )?change was detected/i.test(result.content);
}

function repeatedCycleLength(events: readonly string[], repeats = 3, maxCycleLength = 6): number {
  const maximum = Math.min(maxCycleLength, Math.floor(events.length / repeats));
  for (let length = 2; length <= maximum; length += 1) {
    let matches = true;
    for (let offset = 0; offset < length && matches; offset += 1) {
      const latest = events.length - 1 - offset;
      for (let repeat = 1; repeat < repeats; repeat += 1) {
        if (events[latest] !== events[latest - repeat * length]) {
          matches = false;
          break;
        }
      }
    }
    if (matches) return length;
  }
  return 0;
}

export interface ToolLoopDecision {
  kind: 'replan' | 'stop';
  reason: string;
  toolName: string;
  callFingerprint: string;
}

export interface ToolLoopGuard {
  /** Rejects an exact call the model was just told not to replay. */
  preflight(call: ToolCall): ToolLoopDecision | undefined;
  observe(call: ToolCall, result: ToolResult): ToolLoopDecision | undefined;
  /** True once after a different successful action recovered from a replan. */
  consumeRecovery(): boolean;
}

/**
 * Detects no-progress loops without treating repeated readers as loops merely
 * because their names and arguments match. A reader may legitimately inspect
 * the same tab after scrolling, loading, or navigation; changed output is
 * progress, and any intervening different call starts a new sequence.
 */
export function createToolLoopGuard(options: ToolLoopGuardOptions = {}): ToolLoopGuard {
  const unchangedResultLimit = Math.max(2, options.repeatedCallLimit ?? 3);
  const repeatedFailureLimit = Math.max(2, options.repeatedFailureLimit ?? 2);
  const strategyFailureLimit = Math.max(2, options.strategyFailureLimit ?? 2);
  const strategyFailureWindow = Math.max(2, options.strategyFailureWindow ?? 8);
  const consecutiveFailureLimit = Math.max(2, options.consecutiveFailureLimit ?? 3);
  const discoveryCallLimit = Math.max(2, options.discoveryCallLimit ?? 5);
  const maxReplans = Math.max(0, options.maxReplans ?? 2);
  const failureCounts = new Map<string, number>();
  const strategyFailures = new Map<string, { count: number; lastEvent: number }>();
  let eventIndex = 0;
  let previousCallKey = '';
  let previousResultKey = '';
  let unchangedSuccesses = 0;
  let consecutiveFailures = 0;
  let consecutiveDiscoveryCalls = 0;
  let replans = 0;
  let blockedCallKey = '';
  let recoveryPending = false;
  let recoveredSinceLastCheck = false;
  const recentEvents: string[] = [];

  const intervene = (call: ToolCall, reason: string): ToolLoopDecision => {
    replans += 1;
    previousCallKey = '';
    previousResultKey = '';
    unchangedSuccesses = 0;
    consecutiveFailures = 0;
    consecutiveDiscoveryCalls = 0;
    failureCounts.clear();
    strategyFailures.clear();
    recentEvents.length = 0;
    const kind = replans <= maxReplans ? 'replan' : 'stop';
    blockedCallKey = kind === 'replan' ? toolCallFingerprint(call) : '';
    recoveryPending = kind === 'replan';
    recoveredSinceLastCheck = false;
    return {
      kind,
      reason,
      toolName: call.name,
      callFingerprint: toolCallFingerprint(call),
    };
  };

  const completeRecovery = (callKey: string, ok: boolean): void => {
    if (!ok || !recoveryPending || !blockedCallKey || callKey === blockedCallKey) return;
    blockedCallKey = '';
    recoveryPending = false;
    recoveredSinceLastCheck = true;
    // Replan limits apply to an ignored recovery, not to unrelated loops in a
    // long autonomous task hours later.
    replans = 0;
  };

  return {
    preflight(call) {
      const callKey = toolCallFingerprint(call);
      if (!recoveryPending || !blockedCallKey || callKey !== blockedCallKey) return undefined;
      return intervene(
        call,
        'the blocked ' + call.name + ' call was replayed immediately without an intervening state change',
      );
    },
    observe(call, result) {
      eventIndex += 1;
      const callKey = toolCallFingerprint(call);
      for (const [key, entry] of strategyFailures) {
        if (eventIndex - entry.lastEvent > strategyFailureWindow) strategyFailures.delete(key);
      }

      if (DISCOVERY_AND_DEBUG_TOOLS.has(call.name)) {
        consecutiveDiscoveryCalls += 1;
        if (!options.capabilityManagementRequested && consecutiveDiscoveryCalls >= discoveryCallLimit) {
          return intervene(
            call,
            'tool discovery/debugging repeated ' + consecutiveDiscoveryCalls +
              ' times without executing a task capability',
          );
        }
      } else {
        consecutiveDiscoveryCalls = 0;
      }

      if (result.ok) {
        consecutiveFailures = 0;
        failureCounts.clear();
        const currentResultKey = resultFingerprint(result);
        if (resultReportsVerifiedStateChange(call, result)) {
          // Semantic browser actions already compared before/after state. A
          // repeated "Next" click may return the same summary while each page
          // genuinely changed, so its verified signal resets loop history.
          previousCallKey = '';
          previousResultKey = '';
          unchangedSuccesses = 0;
          recentEvents.length = 0;
          strategyFailures.clear();
          completeRecovery(callKey, true);
          return undefined;
        }
        if (call.name === 'chrome_sequence') {
          for (const key of strategyFailures.keys()) {
            if (key.startsWith('chrome-sequence:')) strategyFailures.delete(key);
          }
        } else {
          strategyFailures.delete('browser-target:' + call.name);
          if (call.name === 'read_classroom') strategyFailures.delete('classroom:unavailable');
        }
        if (callKey === previousCallKey && currentResultKey === previousResultKey) {
          unchangedSuccesses += 1;
        } else {
          // A different call, or the same reader returning changed content, is
          // concrete progress and starts a fresh observation sequence.
          unchangedSuccesses = 1;
        }
        previousCallKey = callKey;
        previousResultKey = currentResultKey;
        if (unchangedSuccesses >= unchangedResultLimit) {
          return intervene(
            call,
            'the same ' + call.name + ' observation returned unchanged output ' +
              unchangedSuccesses + ' times consecutively',
          );
        }
        recentEvents.push(callKey + ':' + currentResultKey);
        if (recentEvents.length > 36) recentEvents.splice(0, recentEvents.length - 36);
        const cycleLength = repeatedCycleLength(recentEvents);
        if (cycleLength) {
          return intervene(
            call,
            'the same ' + cycleLength + '-step tool/result sequence repeated 3 times without changed output',
          );
        }
        completeRecovery(callKey, true);
        return undefined;
      }

      recentEvents.length = 0;
      previousCallKey = '';
      previousResultKey = '';
      unchangedSuccesses = 0;
      consecutiveFailures += 1;
      const failureKey = failureFingerprint(call, result);
      const failureCount = (failureCounts.get(failureKey) ?? 0) + 1;
      failureCounts.set(failureKey, failureCount);
      const strategy = failureStrategy(call, result);
      if (strategy) {
        const previous = strategyFailures.get(strategy.key);
        const strategyCount = previous && eventIndex - previous.lastEvent <= strategyFailureWindow
          ? previous.count + 1
          : 1;
        strategyFailures.set(strategy.key, { count: strategyCount, lastEvent: eventIndex });
        if (strategyCount >= strategyFailureLimit) {
          return intervene(
            call,
            'the same ' + strategy.label + ' strategy failed ' + strategyCount +
              ' times despite changed arguments or intervening calls',
          );
        }
      }
      if (failureCount >= repeatedFailureLimit) {
        return intervene(call, 'the same ' + call.name + ' failure repeated ' + failureCount + ' times');
      }
      if (consecutiveFailures >= consecutiveFailureLimit) {
        return intervene(call, consecutiveFailures + ' tools failed consecutively');
      }
      return undefined;
    },
    consumeRecovery() {
      const recovered = recoveredSinceLastCheck;
      recoveredSinceLastCheck = false;
      return recovered;
    },
  };
}
