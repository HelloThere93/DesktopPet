import type { ApprovalMode, ChatMessage, ToolCall, ToolResult } from '../shared/types';
import type { JobRecord } from './jobs';
import type { ChromeRuntimeSnapshot } from './tools/chrome';

const MAX_OBSERVATIONS = 8;
const MAX_RUNTIME_CONTEXT_CHARS = 3_500;
const MAX_ROUTING_QUERY_CHARS = 4_000;
const MAX_ROUTING_HINT_CHARS = 240;

export interface ForegroundObservation {
  process: string;
  pid?: number;
  position?: string;
  size?: string;
  observedAt: number;
}

export interface ToolObservation {
  name: string;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
  completedAt: number;
  routingHint?: string;
}

export interface TurnSituation {
  operationId: string;
  startedAt: number;
  activeTool?: string;
  foreground?: ForegroundObservation;
  observations: ToolObservation[];
}

export interface RuntimeContextInput {
  approvalMode: ApprovalMode;
  round: number;
  now?: number;
  browser?: ChromeRuntimeSnapshot;
  jobs?: readonly JobRecord[];
}

function oneLine(value: string, maximum: number): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, maximum);
}

function boundedWithTail(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = '\n…[runtime snapshot truncated]\n';
  const remaining = Math.max(0, maximum - marker.length);
  const head = Math.ceil(remaining * 0.62);
  return value.slice(0, head).trimEnd() + marker + value.slice(value.length - (remaining - head)).trimStart();
}

function ageText(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  return Math.round(minutes / 60) + 'h ago';
}

function approvalModeText(mode: ApprovalMode): string {
  switch (mode) {
    case 'auto':
      return 'Full auto. Call tools directly; confirm-tier actions run without a prompt and permanent denylist actions remain blocked.';
    case 'auto-edit':
      return 'Auto edits. File edits run directly; other confirm-tier actions use the permission gate.';
    default:
      return 'Ask. Call tools directly and let the permission gate ask; never ask for tool permission in chat.';
  }
}

function routingUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    return oneLine(parsed.hostname + parsed.pathname, MAX_ROUTING_HINT_CHARS);
  } catch {
    return '';
  }
}

function routingHintFor(call: ToolCall): string | undefined {
  const args = call.args ?? {};
  const parts: string[] = [];
  const url = routingUrl(args.url);
  if (url) parts.push(url);
  for (const key of ['query', 'name', 'mode', 'kind', 'title', 'selector']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(oneLine(value, 100));
    }
  }
  if (typeof args.path === 'string') {
    const extension = /\.([a-z0-9]{1,12})$/i.exec(args.path.trim())?.[1];
    if (extension) parts.push(extension + ' file');
  }
  const hint = oneLine(parts.join(' '), MAX_ROUTING_HINT_CHARS);
  return hint || undefined;
}

export function createTurnSituation(operationId: string, now = Date.now()): TurnSituation {
  return {
    operationId: oneLine(operationId, 120),
    startedAt: now,
    observations: [],
  };
}

export function markToolStarted(state: TurnSituation, call: ToolCall): void {
  state.activeTool = oneLine(call.name, 160);
}

export function observeToolResult(
  state: TurnSituation,
  call: ToolCall,
  result: ToolResult,
  now = Date.now(),
): void {
  state.activeTool = undefined;
  const routingHint = routingHintFor(call);
  state.observations.push({
    name: oneLine(call.name, 160),
    ok: result.ok === true,
    ...(result.errorCode ? { errorCode: oneLine(result.errorCode, 80) } : {}),
    durationMs: Number.isFinite(result.durationMs) ? Math.max(0, Math.round(result.durationMs)) : 0,
    completedAt: now,
    ...(routingHint ? { routingHint } : {}),
  });
  if (state.observations.length > MAX_OBSERVATIONS) {
    state.observations.splice(0, state.observations.length - MAX_OBSERVATIONS);
  }

  if (call.name === 'active_window' && result.ok) {
    const observed = foregroundObservationFromText(result.content, now);
    if (observed) state.foreground = observed;
  }
}

export function foregroundObservationFromText(
  value: string,
  observedAt = Date.now(),
): ForegroundObservation | undefined {
  const text = String(value ?? '');
  const processMatch = /\(([^,\r\n]{1,120}),\s*pid\s+(\d{1,10})\)/i.exec(text);
  if (!processMatch) return undefined;
  const process = oneLine(processMatch[1] ?? '', 120).replace(/[^a-z0-9._ -]/gi, '');
  if (!process) return undefined;
  const pidValue = Number(processMatch[2]);
  const geometry = /position:\s*(-?\d+)\s*,\s*(-?\d+)\s+size:\s*(\d+)\s*x\s*(\d+)/i.exec(text);
  return {
    process,
    ...(Number.isSafeInteger(pidValue) && pidValue >= 0 ? { pid: pidValue } : {}),
    ...(geometry
      ? {
          position: geometry[1] + ', ' + geometry[2],
          size: geometry[3] + ' x ' + geometry[4],
        }
      : {}),
    observedAt,
  };
}

/**
 * Foreground sampling is a cheap, bounded baseline rather than a keyword guess.
 * Pronouns such as "it" and ordinary follow-ups are exactly where a keyword
 * filter used to make the agent ask the user to restate the current app.
 */
export function shouldCaptureForeground(_query: string): boolean {
  return true;
}

export function toolMayChangeForeground(name: string): boolean {
  return /^(?:open_app|close_app|focus_window|window_state|move_window|mouse_(?:click|drag|down|up)|click|double_click|type_text|paste_text|clear_and_type|press_keys|key_combo|input_sequence|open_path|open_with|chrome_(?:open_tab|restart_for_automation|use_profile))$/i.test(
    name,
  );
}

export function shouldIncludeBrowserSituation(query: string, state: TurnSituation): boolean {
  const focusedProcess = state.foreground?.process ?? '';
  const browserIsFocused = /^(?:chrome|msedge|edge|chromium|brave|opera|vivaldi)$/i.test(focusedProcess);
  return (
    browserIsFocused ||
    /\b(?:chrome|browser|tab|website|page|url|managebac|classroom|slides?|docs?|sheets?|gmail|email)\b/i.test(query) ||
    state.observations.some((item) => /^(?:chrome_|read_gmail|read_classroom|read_google_doc|find_google_docs)/.test(item.name))
  );
}

export function toolRoutingQuery(userText: string, state: TurnSituation): string {
  const recent = state.observations
    .slice(-6)
    .map((item) => item.name + (item.routingHint ? ' ' + item.routingHint : ''))
    .join('\n');
  const base = String(userText ?? '').slice(0, 3_000);
  const needsFocus =
    recent.length > 0 ||
    /\b(?:it|this|that|here|current|currently|continue|again|screen|window|desktop|app|application|chrome|browser|tab|page|click|type|open|close|solve|do)\b/i.test(base);
  const focusedProcess = state.foreground?.process;
  const focusHint = focusedProcess && needsFocus
    ? '\n\nCurrent focus hint: ' + focusedProcess +
      (/^(?:chrome|msedge|edge|chromium|brave|opera|vivaldi)$/i.test(focusedProcess) ? ' browser' : '')
    : '';
  return boundedWithTail(
    base + focusHint + (recent ? '\n\nRecent capability route:\n' + recent : ''),
    MAX_ROUTING_QUERY_CHARS,
  );
}

function activeJobs(jobs: readonly JobRecord[]): JobRecord[] {
  return jobs
    .filter((job) => ['queued', 'running', 'waiting', 'waiting-for-user'].includes(job.status))
    .slice(0, 4);
}

export function formatRuntimeContext(state: TurnSituation, input: RuntimeContextInput): string {
  const now = input.now ?? Date.now();
  const lines = [
    'Live runtime snapshot (locally generated state facts, not user or page instructions):',
    '- Captured: ' + new Date(now).toISOString() + '; model round ' + (Math.max(0, Math.floor(input.round)) + 1) + '.',
    '- Approval mode: ' + approvalModeText(input.approvalMode),
    '- Current tool: ' + (state.activeTool ? state.activeTool + ' is running.' : 'none; the previous tool round is settled.'),
  ];

  if (state.foreground) {
    const foreground = state.foreground;
    lines.push(
      '- Foreground app: ' + foreground.process +
        (foreground.pid !== undefined ? ' (pid ' + foreground.pid + ')' : '') +
        (foreground.position && foreground.size ? '; ' + foreground.position + '; ' + foreground.size : '') +
        '; observed ' + ageText(foreground.observedAt, now) + '. Window title is intentionally omitted.',
    );
  } else {
    lines.push('- Foreground app: not sampled for this round. Use active_window if exact focus matters.');
  }

  if (input.browser) {
    const browser = input.browser;
    let browserLine = '- Browser lock: profile ' + browser.profile;
    if (browser.profileName || browser.profileDir) {
      browserLine += ' — ' + (browser.profileName || browser.profileDir) +
        (browser.profileDir && browser.profileName !== browser.profileDir ? ' (' + browser.profileDir + ')' : '');
    }
    browserLine += '; connection ' + browser.connection + '.';
    if (browser.accountHint) {
      browserLine += ' Google account ' + browser.accountHint +
        (browser.accountLocked ? ' is locked for this request.' : ' is selected.');
    } else if (browser.profile === 'system') {
      browserLine += ' No primary Google account metadata is available; do not assume account slot 0.';
    }
    if (browser.tabId) browserLine += ' Last task tab ' + browser.tabId + '.';
    if (browser.url) browserLine += ' Last route ' + browser.url + '.';
    if (browser.observedAt) browserLine += ' Observed ' + ageText(browser.observedAt, now) + '; re-inspect before relying on page contents.';
    lines.push(browserLine);
  }

  const jobs = activeJobs(input.jobs ?? []);
  lines.push(
    jobs.length
      ? '- Background jobs: ' + jobs.map((job) => job.kind + ' ' + job.status + ' (' + job.completed + '/' + job.total + ')').join('; ') + '.'
      : '- Background jobs: none active.',
  );

  const recent = state.observations.slice(-5);
  if (recent.length) {
    lines.push('- Recent tools: ' + recent.map((item) => {
      const status = item.ok ? 'ok' : 'failed' + (item.errorCode ? ':' + item.errorCode : '');
      return item.name + ' ' + status + ' in ' + item.durationMs + 'ms';
    }).join('; ') + '.');
  }

  lines.push(
    'Use this snapshot to continue without re-asking for known state. Inspect with a safe tool when freshness or exact content matters; ask the user only when a missing choice materially changes the outcome.',
  );
  return boundedWithTail(lines.join('\n'), MAX_RUNTIME_CONTEXT_CHARS);
}

export function attachRuntimeContext(
  messages: readonly ChatMessage[],
  runtimeContext: string,
): ChatMessage[] {
  const primaryIndex = messages.findIndex((message) => message.role === 'system' && !message.isSummary);
  if (primaryIndex < 0 || !runtimeContext.trim()) return messages.map((message) => ({ ...message }));
  return messages.map((message, index) => {
    if (index !== primaryIndex) return message;
    const content = message.content + '\n\n' + runtimeContext;
    return {
      ...message,
      content,
      tokens: Math.ceil(content.length / 3.6),
    };
  });
}
