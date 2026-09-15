import { MAX_CLIPBOARD_DRAFT_CHARS } from '../shared/clipboard';
import { assertJsonWithinLimit } from './bounded-json';
import type { JobRecord } from './jobs';
import type { MutationRecord } from './mutation-journal';
import type { DiagnosticsSnapshot } from './diagnostics';
import type { Goal } from './goals';
import type { LessonListView } from './lessons';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_DATA_URL_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_ATTACHMENT_TEXT_CHARS,
  MAX_TURN_IMAGE_DATA_URL_CHARS,
  type AssignmentSummary,
  type AuthStatus,
  type ChatMessage,
  type Attachment,
  type ConversationFolder,
  type ConversationReference,
  type ConversationReferenceKind,
  type ConversationSummary,
  type LocalSearchResult,
  type McpServerStatus,
  type McpToolSummary,
  type ProjectSummary,
  type ProviderId,
  type PermissionGrant,
  type PermissionDecision,
  type PermissionRequest,
  type Settings,
  type StreamEvent,
  type ToolCall,
  type ToolErrorCode,
  type ToolResult,
  type ToolStudioDefinition,
  type ToolStudioParam,
  type ToolStudioSummary,
  type ToolStudioToolCandidate,
  type ToolStudioTestResult,
  type ToolStudioWorkflowStep,
  type VoiceEvent,
} from '../shared/types';
export {
  MAX_ATTACHMENT_DATA_URL_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_ATTACHMENT_TEXT_CHARS,
} from '../shared/types';
/**
 * Runtime guards for values that arrive from the renderer.
 *
 * Renderer TypeScript annotations are not a security boundary: a compromised
 * page can call the exposed bridge with arbitrary JavaScript values. Keep
 * protocol checks small, pure, and testable instead of relying on downstream
 * APIs to reject malformed input.
 */

/** A normal renderer frame is roughly 5-6k base64 characters. */
export const MAX_PROVIDER_KEY_CHARS = 4_096;
export const MAX_IPC_IDENTIFIER_CHARS = 512;
export const MAX_CHAT_TEXT_CHARS = 100_000;
export const MAX_CHAT_HISTORY_MESSAGES = 10_000;
export const MAX_CHAT_HISTORY_CONTENT_CHARS = 2_000_000;
export const MAX_CHAT_TOOL_CALLS = 64;
export const MAX_MODEL_NAME_CHARS = 500;
export const MAX_CONVERSATION_SUMMARIES = 100;
export const MAX_CONVERSATION_FOLDERS = 64;
export const MAX_ATTACHMENT_IMAGE_DATA_URL_TOTAL_CHARS = MAX_TURN_IMAGE_DATA_URL_CHARS;
export const MAX_CONVERSATION_REFERENCES = 32;
export const MAX_CONVERSATION_TITLE_CHARS = 240;
export const MAX_CONVERSATION_FOLDER_NAME_CHARS = 80;
export const MAX_CONVERSATION_SUMMARY_CHARS = 360;
export const MAX_CONVERSATION_REFERENCE_CHARS = 1_000;
export const MAX_CONVERSATION_REFERENCE_LABEL_CHARS = 240;
export const MAX_PROVIDER_VIEWS = 32;
export const MAX_PROVIDER_NOTE_CHARS = 2_000;
export const MAX_PROVIDER_KEY_HINT_CHARS = 16;
export const MAX_MODEL_OPTIONS = 200;
export const MAX_MODEL_NOTE_CHARS = 2_000;
export const MAX_MODEL_PROBE_DETAIL_CHARS = 20_000;
export const MAX_AUTH_PROBE_TRIES = 8;
export const MAX_AUTH_DETAIL_CHARS = 20_000;
export const MAX_AUTH_ACCOUNT_ID_CHARS = 512;
export const MAX_AUTH_EMAIL_CHARS = 320;
export const MAX_REALTIME_PROBE_RESULTS = 8;
export const MAX_REALTIME_PROBE_URL_CHARS = 512;
export const MAX_REALTIME_PROBE_DETAIL_CHARS = 2_000;
export const MAX_CHROME_PROFILES = 100;
export const MAX_CHROME_PROFILE_DIR_CHARS = 256;
export const MAX_CHROME_PROFILE_NAME_CHARS = 240;
export const MAX_CHROME_PROFILE_EMAIL_CHARS = 320;
export const MAX_WORKSPACE_ROOT_CHARS = 1_000;
export const MAX_WORKSPACE_ERROR_CHARS = 2_000;
export const MAX_LOCAL_SEARCH_RESULTS = 40;
export const MAX_LOCAL_SEARCH_ID_CHARS = 120;
export const MAX_LOCAL_SEARCH_TITLE_CHARS = 240;
export const MAX_LOCAL_SEARCH_SNIPPET_CHARS = 400;
export const MAX_PROJECT_SUMMARIES = 100;
export const MAX_PROJECT_ID_CHARS = 80;
export const MAX_PROJECT_NAME_CHARS = 240;
export const MAX_PROJECT_DESCRIPTION_CHARS = 320;
export const MAX_ASSIGNMENT_SUMMARIES = 100;
export const MAX_ASSIGNMENT_ID_CHARS = 80;
export const MAX_ASSIGNMENT_TITLE_CHARS = 240;
export const MAX_ASSIGNMENT_TEXT_CHARS = 240;
export const MAX_HOTKEY_CHARS = 256;
export const MAX_VOICE_AUDIO_CHUNK_CHARS = 16_384;
export const MAX_PERMISSION_TEXT_CHARS = 50_000;
export const MAX_VOICE_TEXT_CHARS = 20_000;
export const MAX_VOICE_MODEL_CHARS = 256;
export const MAX_GOAL_TITLE_CHARS = 240;
export const MAX_VOICE_MODELS = 32;
export const MAX_HOTKEY_MESSAGE_CHARS = 2_000;
export const MAX_PERMISSION_GRANTS = 200;
export const MAX_PERMISSION_TOOL_NAME_CHARS = 200;
export const MAX_PERMISSION_SAMPLE_CHARS = 1_000;
export const MAX_GOAL_RECORDS = 100;
export const MAX_GOAL_ID_CHARS = 80;
export const MAX_GOAL_DETAIL_CHARS = 4_000;
export const MAX_GOAL_PROGRESS = 40;
export const MAX_GOAL_PROGRESS_NOTE_CHARS = 1_000;
export const MAX_GOAL_WATCH_INTERVAL_MINUTES = 365 * 24 * 60;
export const MAX_GOAL_LOOKS_AT_CHARS = 240;
export const MAX_MEMORY_ENTRIES = 60;
export const MAX_MEMORY_ENTRY_INDEX = 100_000;
export const MAX_MEMORY_ENTRY_TEXT_CHARS = 24_000;
export const MAX_MEMORY_TOTAL_TEXT_CHARS = 24_000;
export const MAX_MEMORY_WARNING_CHARS = 240;
export const MAX_SETTINGS_MODEL_CHARS = 500;
export const MAX_SETTINGS_URL_CHARS = 4_000;
export const MAX_SETTINGS_PROVIDER_MODELS_CHARS = 100_000;
export const MAX_SETTINGS_VOICE_NAME_CHARS = 100;
export const MAX_SETTINGS_MIC_DEVICE_CHARS = 500;
export const MAX_SETTINGS_HOTKEY_CHARS = 200;
export const MAX_SETTINGS_PROFILE_DIR_CHARS = 500;
export const MAX_SETTINGS_PATH_CHARS = 1_000;
export const MAX_SETTINGS_CUSTOM_MODELS_CHARS = 60_000;
export const MAX_CLIPBOARD_RESULT_CHARS = MAX_CLIPBOARD_DRAFT_CHARS;
export const MAX_DIAGNOSTIC_CHECKS = 32;
export const MAX_DIAGNOSTIC_FAILURES = 12;
export const MAX_DIAGNOSTIC_ID_CHARS = 200;
export const MAX_DIAGNOSTIC_LABEL_CHARS = 240;
export const MAX_DIAGNOSTIC_DETAIL_CHARS = 500;
export const MAX_DIAGNOSTIC_FAILURE_DETAIL_CHARS = 4_000;
export const MAX_DIAGNOSTIC_ERROR_CODE_CHARS = 120;
export const MAX_DIAGNOSTIC_COUNTS = 1_000_000;
export const MAX_DIAGNOSTIC_DURATION_MS = 86_400_000;
export const MAX_JOB_UPDATE_RECORDS = 100;
export const MAX_MUTATION_UPDATE_RECORDS = 100;
export const MAX_JOB_UPDATE_TEXT_CHARS = 20_000;
export const MAX_MUTATION_UPDATE_ARTIFACTS = 8;
export const MAX_MUTATION_UPDATE_PATH_CHARS = 1_000;
export const MAX_MUTATION_UPDATE_EFFECTS = 8;
export const MAX_STREAM_CONTENT_CHARS = 200_000;
export const MAX_STREAM_DISPLAY_ARGS_CHARS = 12_000;
export const MAX_STREAM_TOOL_JSON_CHARS = 200_000;
export const MAX_STREAM_IMAGE_DATA_URL_CHARS = 20_000_000;
export const MAX_STREAM_IMAGE_DATA_URL_TOTAL_CHARS = 24_000_000;
export const MAX_STREAM_MCP_SERVERS = 100;
export const MAX_TOOL_STUDIO_TOOLS = 200;
export const MAX_TOOL_STUDIO_NAME_CHARS = 80;
export const MAX_TOOL_STUDIO_DESCRIPTION_CHARS = 2_000;
export const MAX_TOOL_STUDIO_PARAMS = 40;
export const MAX_TOOL_STUDIO_CHOICES = 40;
export const MAX_TOOL_STUDIO_SCRIPT_CHARS = 500_000;
export const MAX_TOOL_STUDIO_URL_CHARS = 8_000;
export const MAX_TOOL_STUDIO_BODY_CHARS = 100_000;
export const MAX_TOOL_STUDIO_HEADERS = 40;
export const MAX_TOOL_STUDIO_WORKFLOW_STEPS = 40;
export const MAX_TOOL_STUDIO_WORKFLOW_ARGS_BYTES = 200_000;
export const MAX_TOOL_STUDIO_RESULT_CHARS = MAX_STREAM_CONTENT_CHARS;
export const MAX_TOOL_STUDIO_PATH_CHARS = 2_000;
export const MAX_TOOL_STUDIO_META_CHARS = 2_000;
export const MAX_TOOL_STUDIO_CANDIDATES = 512;
export const MAX_STREAM_MCP_TOOLS = 200;

const MAX_STREAM_COUNT = 1_000_000;
const MAX_STREAM_DURATION_MS = 86_400_000;

const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/** Accepts one bounded, even-byte PCM16 base64 frame for the realtime API. */
export function isPcm16Base64Chunk(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_VOICE_AUDIO_CHUNK_CHARS ||
    value.length % 4 !== 0 ||
    !BASE64_CHARS.test(value)
  ) {
    return false;
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  return decodedBytes > 0 && decodedBytes % 2 === 0;
}

/** Rejects NaN and infinities before they reach Electron window geometry APIs. */
export function isFiniteWindowCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Accepts text only while it remains inside a declared IPC contract. */
export function isBoundedString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    Number.isInteger(maxChars) &&
    maxChars >= 0 &&
    value.length <= maxChars
  );
}

/** Accepts an identifier-like string with useful content and a hard ceiling. */
export function isNonEmptyBoundedString(value: unknown, maxChars: number): value is string {
  return isBoundedString(value, maxChars) && value.trim().length > 0;
}

/** Checks a string against a finite runtime option list. */
export function isKnownString(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value);
}

/** Validates the small approval object returned by the renderer. */
export function isPermissionDecision(value: unknown): value is PermissionDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = (value as { action?: unknown }).action;
  return (
    action === 'allow-once' ||
    action === 'allow-task' ||
    action === 'allow-session' ||
    action === 'allow-always' ||
    action === 'deny'
  );
}

/** Converts a runtime guard into a payload-free invoke failure. */
export function assertValidIpcResult<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  label: string,
): T {
  if (!guard(value)) throw new Error('Invalid ' + label + ' response.');
  return value;
}

export interface ModelOptionResponse {
  id: string;
  label: string;
  note?: string;
}

export interface ModelProbeResponse {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ProviderViewResponse {
  id: ProviderId;
  label: string;
  shape: string;
  needsKey: boolean;
  keyUrl?: string;
  note?: string;
  models: ModelOptionResponse[];
  set: boolean;
  hint: string;
}

export interface AuthProbeResponse {
  ok: boolean;
  base: string;
  model?: string;
  detail: string;
  tried: { model: string; status: number; detail: string }[];
}

export interface RealtimeProbeResponse {
  url: string;
  kind: 'websocket' | 'session';
  status: string;
  detail: string;
}

export interface ChromeProfileResponse {
  dir: string;
  name: string;
  email: string;
}

export interface WorkspacePickRootResponse {
  canceled: boolean;
  root?: string;
  error?: string;
}

const PROVIDER_IDS = [
  'chatgpt',
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'xai',
  'groq',
  'deepseek',
  'mistral',
  'together',
  'ollama',
  'lmstudio',
  'custom',
] as const satisfies readonly ProviderId[];
const PROVIDER_SHAPES = ['responses', 'chat', 'anthropic'] as const;
const AUTH_MODES = ['subscription', 'apikey'] as const;
const REALTIME_PROBE_KINDS = ['websocket', 'session'] as const;
const SEARCH_KINDS = [
  'conversation',
  'memory',
  'goal',
  'assignment',
  'research',
  'project',
  'file',
  'workflow',
] as const;
const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const;
const ASSIGNMENT_STATUSES = ['active', 'done', 'archived'] as const;

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isOptionalBoundedString(value: unknown, maximum: number, nonEmpty = false): boolean {
  return value === undefined || (nonEmpty ? isNonEmptyBoundedString(value, maximum) : isBoundedString(value, maximum));
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_IDS.includes(value as ProviderId);
}

function isModelOption(value: unknown): value is ModelOptionResponse {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.id, MAX_MODEL_NAME_CHARS) &&
    isNonEmptyBoundedString(value.label, MAX_MODEL_NAME_CHARS) &&
    isOptionalBoundedString(value.note, MAX_MODEL_NOTE_CHARS)
  );
}

/** Validates selectable model metadata before model selectors render it. */
export function isModelOptionList(value: unknown): value is ModelOptionResponse[] {
  return Array.isArray(value) && value.length <= MAX_MODEL_OPTIONS && value.every(isModelOption);
}

function isModelProbe(value: unknown): value is ModelProbeResponse {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.id, MAX_MODEL_NAME_CHARS) &&
    typeof value.ok === 'boolean' &&
    isBoundedString(value.detail, MAX_MODEL_PROBE_DETAIL_CHARS)
  );
}

/** Validates model availability results before the selector marks options. */
export function isModelProbeList(value: unknown): value is ModelProbeResponse[] {
  return Array.isArray(value) && value.length <= MAX_MODEL_OPTIONS && value.every(isModelProbe);
}

function isProviderKeyHint(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_PROVIDER_KEY_HINT_CHARS) &&
    (value === '' || (value.length === 5 && value.charCodeAt(0) === 0x2026))
  );
}

function isProviderKeyState(set: unknown, hint: unknown): boolean {
  return (
    typeof set === 'boolean' &&
    isProviderKeyHint(hint) &&
    (set ? hint !== '' : hint === '')
  );
}

/** Validates the renderer-safe key status returned after save and clear. */
export function isProviderKeyStatus(value: unknown): value is { set: boolean; hint: string } {
  return isRecord(value) && isProviderKeyState(value.set, value.hint);
}

function isProviderView(value: unknown): value is ProviderViewResponse {
  return (
    isRecord(value) &&
    isProviderId(value.id) &&
    isNonEmptyBoundedString(value.label, MAX_PROVIDER_NOTE_CHARS) &&
    isKnownString(value.shape, PROVIDER_SHAPES) &&
    typeof value.needsKey === 'boolean' &&
    isOptionalBoundedString(value.keyUrl, MAX_PROVIDER_NOTE_CHARS, true) &&
    isOptionalBoundedString(value.note, MAX_PROVIDER_NOTE_CHARS) &&
    Array.isArray(value.models) &&
    value.models.length <= MAX_MODEL_OPTIONS &&
    value.models.every(isModelOption) &&
    isProviderKeyState(value.set, value.hint)
  );
}

/** Validates the provider settings catalog without allowing key material. */
export function isProviderViewList(value: unknown): value is ProviderViewResponse[] {
  return Array.isArray(value) && value.length <= MAX_PROVIDER_VIEWS && value.every(isProviderView);
}

/** Validates account status without accepting token-shaped fields. */
export function isAuthStatus(value: unknown): value is AuthStatus {
  if (
    !isRecord(value) ||
    typeof value.signedIn !== 'boolean' ||
    !isOptionalBoundedString(value.accountId, MAX_AUTH_ACCOUNT_ID_CHARS, true) ||
    !isOptionalBoundedString(value.email, MAX_AUTH_EMAIL_CHARS, true) ||
    (value.expiresAt !== undefined && !isFiniteNonNegativeNumber(value.expiresAt)) ||
    (value.mode !== undefined && !isKnownString(value.mode, AUTH_MODES))
  ) {
    return false;
  }
  if (!value.signedIn) {
    return (
      value.accountId === undefined &&
      value.email === undefined &&
      value.expiresAt === undefined &&
      value.mode === undefined
    );
  }
  return true;
}

function isAuthProbeAttempt(value: unknown): value is AuthProbeResponse['tried'][number] {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.model, MAX_MODEL_NAME_CHARS) &&
    isBoundedCount(value.status, 999) &&
    isBoundedString(value.detail, MAX_AUTH_DETAIL_CHARS)
  );
}

/** Validates account probe output and bounds all remote error details. */
export function isAuthProbeResult(value: unknown): value is AuthProbeResponse {
  return (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    isBoundedString(value.base, MAX_REALTIME_PROBE_URL_CHARS) &&
    isOptionalBoundedString(value.model, MAX_MODEL_NAME_CHARS, true) &&
    isBoundedString(value.detail, MAX_AUTH_DETAIL_CHARS) &&
    Array.isArray(value.tried) &&
    value.tried.length <= MAX_AUTH_PROBE_TRIES &&
    value.tried.every(isAuthProbeAttempt)
  );
}

function isRealtimeProbe(value: unknown): value is RealtimeProbeResponse {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.url, MAX_REALTIME_PROBE_URL_CHARS) &&
    isKnownString(value.kind, REALTIME_PROBE_KINDS) &&
    isNonEmptyBoundedString(value.status, MAX_REALTIME_PROBE_DETAIL_CHARS) &&
    isBoundedString(value.detail, MAX_REALTIME_PROBE_DETAIL_CHARS)
  );
}

/** Validates realtime endpoint diagnostics before they reach voice settings UI. */
export function isRealtimeProbeList(value: unknown): value is RealtimeProbeResponse[] {
  return Array.isArray(value) && value.length <= MAX_REALTIME_PROBE_RESULTS && value.every(isRealtimeProbe);
}

function isChromeProfileDir(value: unknown): value is string {
  return (
    isNonEmptyBoundedString(value, MAX_CHROME_PROFILE_DIR_CHARS) &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/:*?"<>|]/.test(value)
  );
}

function isChromeProfile(value: unknown): value is ChromeProfileResponse {
  return (
    isRecord(value) &&
    isChromeProfileDir(value.dir) &&
    isNonEmptyBoundedString(value.name, MAX_CHROME_PROFILE_NAME_CHARS) &&
    isBoundedString(value.email, MAX_CHROME_PROFILE_EMAIL_CHARS)
  );
}

/** Validates browser profile metadata and rejects path-like directory values. */
export function isChromeProfileList(value: unknown): value is ChromeProfileResponse[] {
  return Array.isArray(value) && value.length <= MAX_CHROME_PROFILES && value.every(isChromeProfile);
}

/** Validates the user-picker result used to choose a workspace root. */
export function isWorkspacePickRootResult(value: unknown): value is WorkspacePickRootResponse {
  if (!isRecord(value) || typeof value.canceled !== 'boolean') return false;
  if (value.canceled) return value.root === undefined && value.error === undefined;
  return (
    (isNonEmptyBoundedString(value.root, MAX_WORKSPACE_ROOT_CHARS) && value.error === undefined) ||
    (value.root === undefined && isNonEmptyBoundedString(value.error, MAX_WORKSPACE_ERROR_CHARS))
  );
}

function isLocalSearchResult(value: unknown): value is LocalSearchResult {
  return (
    isRecord(value) &&
    isKnownString(value.kind, SEARCH_KINDS) &&
    isNonEmptyBoundedString(value.id, MAX_LOCAL_SEARCH_ID_CHARS) &&
    isNonEmptyBoundedString(value.title, MAX_LOCAL_SEARCH_TITLE_CHARS) &&
    isBoundedString(value.snippet, MAX_LOCAL_SEARCH_SNIPPET_CHARS) &&
    isFiniteNonNegativeNumber(value.updatedAt) &&
    (value.conversationKind === undefined || isKnownString(value.conversationKind, ['chat', 'quick'])) &&
    (value.archived === undefined || typeof value.archived === 'boolean')
  );
}

/** Validates bounded workspace and local-search results before DOM rendering. */
export function isLocalSearchResultList(value: unknown): value is LocalSearchResult[] {
  return Array.isArray(value) && value.length <= MAX_LOCAL_SEARCH_RESULTS && value.every(isLocalSearchResult);
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.id, MAX_PROJECT_ID_CHARS) &&
    isNonEmptyBoundedString(value.name, MAX_PROJECT_NAME_CHARS) &&
    isOptionalBoundedString(value.description, MAX_PROJECT_DESCRIPTION_CHARS) &&
    isOptionalBoundedString(value.workspaceRoot, MAX_WORKSPACE_ROOT_CHARS, true) &&
    isFiniteNonNegativeNumber(value.createdAt) &&
    isKnownString(value.status, PROJECT_STATUSES) &&
    isBoundedCount(value.assignmentCount) &&
    isBoundedCount(value.activeAssignmentCount) &&
    value.activeAssignmentCount <= value.assignmentCount &&
    isBoundedCount(value.researchCount) &&
    isBoundedCount(value.verifiedArtifactCount)
  );
}

/** Validates bounded project summaries before project UI renders paths and counts. */
export function isProjectSummaryList(value: unknown): value is ProjectSummary[] {
  return Array.isArray(value) && value.length <= MAX_PROJECT_SUMMARIES && value.every(isProjectSummary);
}

function isAssignmentSummary(value: unknown): value is AssignmentSummary {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.id, MAX_ASSIGNMENT_ID_CHARS) &&
    isNonEmptyBoundedString(value.title, MAX_ASSIGNMENT_TITLE_CHARS) &&
    isOptionalBoundedString(value.subject, MAX_ASSIGNMENT_TEXT_CHARS) &&
    (value.dueAt === undefined || isFiniteNonNegativeNumber(value.dueAt)) &&
    isKnownString(value.status, ASSIGNMENT_STATUSES) &&
    isOptionalBoundedString(value.projectId, MAX_ASSIGNMENT_ID_CHARS, true) &&
    isOptionalBoundedString(value.goalId, MAX_ASSIGNMENT_ID_CHARS, true) &&
    isBoundedCount(value.checklistTotal) &&
    isBoundedCount(value.checklistDone) &&
    value.checklistDone <= value.checklistTotal &&
    isBoundedCount(value.notesCount) &&
    isBoundedCount(value.researchCount) &&
    isBoundedCount(value.citationCount) &&
    isBoundedCount(value.artifactCount) &&
    isFiniteNonNegativeNumber(value.createdAt) &&
    isFiniteNonNegativeNumber(value.updatedAt)
  );
}

/** Validates bounded assignment summaries before student-work UI renders them. */
export function isAssignmentSummaryList(value: unknown): value is AssignmentSummary[] {
  return Array.isArray(value) && value.length <= MAX_ASSIGNMENT_SUMMARIES && value.every(isAssignmentSummary);
}

const PERMISSION_TIERS = ['auto', 'confirm', 'never'] as const;
const VOICE_EVENT_TYPES = ['open', 'listening', 'user-transcript', 'speaking', 'audio', 'closed', 'error'] as const;

/** Validates the approval request shown before a tool can run. */
export function isPermissionRequest(value: unknown): value is PermissionRequest {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.id, MAX_IPC_IDENTIFIER_CHARS) ||
    !isNonEmptyBoundedString(value.toolName, MAX_IPC_IDENTIFIER_CHARS) ||
    !isBoundedString(value.summary, MAX_PERMISSION_TEXT_CHARS) ||
    !isBoundedString(value.detail, MAX_PERMISSION_TEXT_CHARS) ||
    !isKnownString(value.tier, PERMISSION_TIERS) ||
    !isBoundedString(value.reason, MAX_PERMISSION_TEXT_CHARS)
  ) {
    return false;
  }
  if (
    value.operationId !== undefined &&
    !isNonEmptyBoundedString(value.operationId, MAX_IPC_IDENTIFIER_CHARS)
  ) {
    return false;
  }
  if (value.canAllowTask !== undefined && typeof value.canAllowTask !== 'boolean') return false;
  if (value.canAllowSession !== undefined && typeof value.canAllowSession !== 'boolean') return false;
  if (value.canAlwaysAllow !== undefined && typeof value.canAlwaysAllow !== 'boolean') return false;
  return true;
}

/** Validates events emitted by the realtime voice session before UI/audio use. */
export function isVoiceEvent(value: unknown): value is VoiceEvent {
  if (!isRecord(value) || !isKnownString(value.type, VOICE_EVENT_TYPES)) return false;
  switch (value.type) {
    case 'open':
      return isNonEmptyBoundedString(value.model, MAX_VOICE_MODEL_CHARS);
    case 'listening':
    case 'speaking':
      return typeof value.on === 'boolean';
    case 'user-transcript':
      return isBoundedString(value.text, MAX_VOICE_TEXT_CHARS);
    case 'audio':
      return isPcm16Base64Chunk(value.base64);
    case 'closed':
      return isBoundedString(value.reason, MAX_VOICE_TEXT_CHARS);
    case 'error':
      return isBoundedString(value.message, MAX_VOICE_TEXT_CHARS);
    default:
      return false;
  }
}

const STREAM_EVENT_TYPES = ['started', 'delta', 'tool-start', 'tool-end', 'compacted', 'notice', 'done', 'mcp', 'error'] as const;
const TURN_KINDS = ['chat', 'quick', 'goal'] as const;
const TOOL_ERROR_CODES: readonly ToolErrorCode[] = [
  'policy-blocked',
  'permission-denied',
  'execution-failed',
  'tool-not-loaded',
  'invalid-arguments',
  'bulk-partial-failure',
];
const MCP_TRANSPORTS = ['stdio', 'http'] as const;
const MCP_PERMISSIONS = ['confirm-every-time', 'disabled'] as const;
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,([A-Za-z0-9+/]*={0,2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validates the bounded look vector emitted by the cursor tracker. */
export function isPetLook(value: unknown): value is { x: number; y: number } {
  return (
    isRecord(value) &&
    isFiniteWindowCoordinate(value.x) &&
    isFiniteWindowCoordinate(value.y) &&
    value.x >= -1 &&
    value.x <= 1 &&
    value.y >= -1 &&
    value.y <= 1
  );
}

/** Validates the proximity flag emitted by the cursor tracker. */
export function isPetProximity(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Validates the goal check-in announcement correlated to a running turn. */
export function isGoalCheckin(
  value: unknown,
): value is { id: string; title: string; operationId: string } {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.id, MAX_IPC_IDENTIFIER_CHARS) &&
    isNonEmptyBoundedString(value.title, MAX_GOAL_TITLE_CHARS) &&
    isNonEmptyBoundedString(value.operationId, MAX_IPC_IDENTIFIER_CHARS)
  );
}

const JOB_UPDATE_STATUSES = ['queued', 'running', 'waiting', 'waiting-for-user', 'completed', 'failed', 'cancelled'] as const;
const MUTATION_UPDATE_STATUSES = ['pending', 'undoable', 'undoing', 'undone', 'not-undoable', 'stale', 'failed', 'uncertain'] as const;
const MUTATION_ARTIFACT_KINDS = ['file', 'directory', 'other', 'missing', 'unknown'] as const;
const MAX_UPDATE_IDENTIFIER_CHARS = 120;
const MAX_UPDATE_COUNT = 10_000_000;
const MAX_MUTATION_UPDATE_SUMMARY_CHARS = 360;
const MAX_MUTATION_UPDATE_EFFECT_CHARS = 600;
const MAX_MUTATION_UPDATE_ERROR_CODE_CHARS = 80;

function isUpdateCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_UPDATE_COUNT;
}

function isUpdateTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isJobMutationManifestUpdate(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.mutationId, MAX_UPDATE_IDENTIFIER_CHARS) &&
    value.scope === 'powershell-batch' &&
    isUpdateCount(value.planned) &&
    isUpdateCount(value.completed) &&
    isUpdateCount(value.failed) &&
    isUpdateCount(value.skipped) &&
    isUpdateCount(value.remaining) &&
    value.verification === 'not-verified'
  );
}

function isJobUpdateRecord(value: unknown): value is JobRecord {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.id, MAX_UPDATE_IDENTIFIER_CHARS) &&
    isNonEmptyBoundedString(value.kind, MAX_UPDATE_IDENTIFIER_CHARS) &&
    isNonEmptyBoundedString(value.title, MAX_JOB_UPDATE_TEXT_CHARS) &&
    isUpdateTimestamp(value.createdAt) &&
    isUpdateTimestamp(value.updatedAt) &&
    isKnownString(value.status, JOB_UPDATE_STATUSES) &&
    (value.operationId === undefined ||
      isNonEmptyBoundedString(value.operationId, MAX_UPDATE_IDENTIFIER_CHARS)) &&
    isUpdateCount(value.total) &&
    isUpdateCount(value.completed) &&
    isUpdateCount(value.failed) &&
    isUpdateCount(value.skipped) &&
    isUpdateCount(value.remaining) &&
    (value.summary === undefined || isBoundedString(value.summary, MAX_JOB_UPDATE_TEXT_CHARS)) &&
    (value.error === undefined || isBoundedString(value.error, MAX_JOB_UPDATE_TEXT_CHARS)) &&
    (value.mutationManifest === undefined || isJobMutationManifestUpdate(value.mutationManifest))
  );
}

/** Validates bounded background-job records before the renderer sees updates. */
export function isJobUpdateList(value: unknown): value is JobRecord[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_JOB_UPDATE_RECORDS &&
    value.every(isJobUpdateRecord)
  );
}

function isMutationFileFingerprintUpdate(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === 'file' &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.sha256)
  );
}

function isMutationArtifactUpdate(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.path, MAX_MUTATION_UPDATE_PATH_CHARS) &&
    isKnownString(value.kind, MUTATION_ARTIFACT_KINDS) &&
    (value.size === undefined ||
      (typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0)) &&
    (value.sha256 === undefined ||
      (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256))) &&
    typeof value.verified === 'boolean'
  );
}

function isMutationUndoUpdate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'remove-created-folder') {
    return isNonEmptyBoundedString(value.path, MAX_MUTATION_UPDATE_PATH_CHARS);
  }
  if (value.kind === 'move-back') {
    return (
      isNonEmptyBoundedString(value.from, MAX_MUTATION_UPDATE_PATH_CHARS) &&
      isNonEmptyBoundedString(value.to, MAX_MUTATION_UPDATE_PATH_CHARS) &&
      isMutationFileFingerprintUpdate(value.expected)
    );
  }
  if (value.kind === 'remove-copy' || value.kind === 'remove-created-file') {
    return (
      isNonEmptyBoundedString(value.path, MAX_MUTATION_UPDATE_PATH_CHARS) &&
      isMutationFileFingerprintUpdate(value.expected)
    );
  }
  return false;
}

function isMutationUpdateRecord(value: unknown): value is MutationRecord {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.id, MAX_UPDATE_IDENTIFIER_CHARS) &&
    (value.operationId === undefined ||
      isNonEmptyBoundedString(value.operationId, MAX_UPDATE_IDENTIFIER_CHARS)) &&
    isNonEmptyBoundedString(value.toolName, MAX_UPDATE_IDENTIFIER_CHARS) &&
    isNonEmptyBoundedString(value.summary, MAX_MUTATION_UPDATE_SUMMARY_CHARS) &&
    isUpdateTimestamp(value.createdAt) &&
    (value.completedAt === undefined || isUpdateTimestamp(value.completedAt)) &&
    (value.undoneAt === undefined || isUpdateTimestamp(value.undoneAt)) &&
    isKnownString(value.status, MUTATION_UPDATE_STATUSES) &&
    (value.undo === undefined || isMutationUndoUpdate(value.undo)) &&
    (value.reason === undefined || isBoundedString(value.reason, MAX_JOB_UPDATE_TEXT_CHARS)) &&
    (value.errorCode === undefined ||
      isBoundedString(value.errorCode, MAX_MUTATION_UPDATE_ERROR_CODE_CHARS)) &&
    (value.declaredOutputs === undefined ||
      (Array.isArray(value.declaredOutputs) &&
        value.declaredOutputs.length <= MAX_MUTATION_UPDATE_ARTIFACTS &&
        value.declaredOutputs.every((path) => isNonEmptyBoundedString(path, MAX_MUTATION_UPDATE_PATH_CHARS)))) &&
    (value.declaredEffects === undefined ||
      (Array.isArray(value.declaredEffects) &&
        value.declaredEffects.length <= MAX_MUTATION_UPDATE_EFFECTS &&
        value.declaredEffects.every((effect) => isNonEmptyBoundedString(effect, MAX_MUTATION_UPDATE_EFFECT_CHARS)))) &&
    (value.artifacts === undefined ||
      (Array.isArray(value.artifacts) &&
        value.artifacts.length <= MAX_MUTATION_UPDATE_ARTIFACTS &&
        value.artifacts.every(isMutationArtifactUpdate)))
  );
}

/** Validates bounded mutation-journal records before the renderer sees updates. */
export function isMutationUpdateList(value: unknown): value is MutationRecord[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MUTATION_UPDATE_RECORDS &&
    value.every(isMutationUpdateRecord)
  );
}

function isBoundedCount(value: unknown, maximum = MAX_STREAM_COUNT): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const HOTKEY_RESULT_KEYS = ['ok', 'message'] as const;
const PERMISSION_GRANT_KEYS = ['signature', 'toolName', 'sample', 'createdAt'] as const;
const GOAL_KEYS = ['id', 'title', 'detail', 'createdAt', 'dueAt', 'status', 'progress', 'watch'] as const;
const GOAL_PROGRESS_KEYS = ['at', 'note'] as const;
const GOAL_WATCH_KEYS = ['everyMinutes', 'looksAt', 'lastCheckedAt'] as const;
const MEMORY_VIEW_KEYS = ['entries', 'editable', 'warning'] as const;
const MEMORY_ENTRY_KEYS = ['index', 'date', 'text'] as const;
const DIAGNOSTICS_SNAPSHOT_KEYS = ['checkedAt', 'checks', 'recentFailures', 'metrics'] as const;
const DIAGNOSTIC_CHECK_KEYS = ['id', 'label', 'status', 'detail'] as const;
const DIAGNOSTIC_FAILURE_KEYS = ['source', 'label', 'detail', 'at', 'errorCode'] as const;
const DIAGNOSTIC_METRICS_KEYS = [
  'recentAuditEntries',
  'recentRuntimeErrors',
  'recentModelRequests',
  'averageToolMs',
  'slowestToolMs',
] as const;
const SETTINGS_KEYS = [
  'model',
  'provider',
  'customBaseUrl',
  'providerModels',
  'voiceModel',
  'voiceName',
  'micDeviceId',
  'speakReplies',
  'privacyMode',
  'hotkey',
  'approvalMode',
  'reasoningEffort',
  'chromeMode',
  'chromeProfileDir',
  'screenshotDir',
  'workspaceRoot',
  'workspaceContextEnabled',
  'workspaceFileSearchEnabled',
  'goalContextEnabled',
  'learningMemoryEnabled',
  'customModels',
  'compactionThreshold',
  'contextWindow',
  'petScale',
  'launchOnStartup',
  'petX',
  'petY',
] as const;
const SETTINGS_APPROVAL_MODES = ['ask', 'auto-edit', 'auto'] as const;
const SETTINGS_REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const SETTINGS_CHROME_MODES = ['pet', 'system'] as const;
const DIAGNOSTIC_STATUSES = ['ok', 'warning', 'error'] as const;
const DIAGNOSTIC_FAILURE_SOURCES = ['audit', 'runtime'] as const;

function isSafeChromeProfileDirSetting(value: unknown): value is string {
  return (
    isNonEmptyBoundedString(value, MAX_SETTINGS_PROFILE_DIR_CHARS) &&
    value !== '.' &&
    value !== '..' &&
    !/[\0\r\n\\/:*?"<>|]/.test(value)
  );
}

function isSettingsPosition(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= -1_000_000 &&
      value <= 1_000_000)
  );
}

/** Validates the complete settings snapshot without allowing secret-shaped extras. */
export function isSettings(value: unknown): value is Settings {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, SETTINGS_KEYS) &&
    isNonEmptyBoundedString(value.model, MAX_SETTINGS_MODEL_CHARS) &&
    isProviderId(value.provider) &&
    isBoundedString(value.customBaseUrl, MAX_SETTINGS_URL_CHARS) &&
    isBoundedString(value.providerModels, MAX_SETTINGS_PROVIDER_MODELS_CHARS) &&
    isNonEmptyBoundedString(value.voiceModel, MAX_SETTINGS_MODEL_CHARS) &&
    isBoundedString(value.voiceName, MAX_SETTINGS_VOICE_NAME_CHARS) &&
    isBoundedString(value.micDeviceId, MAX_SETTINGS_MIC_DEVICE_CHARS) &&
    typeof value.speakReplies === 'boolean' &&
    typeof value.privacyMode === 'boolean' &&
    isBoundedString(value.hotkey, MAX_SETTINGS_HOTKEY_CHARS) &&
    isKnownString(value.approvalMode, SETTINGS_APPROVAL_MODES) &&
    isKnownString(value.reasoningEffort, SETTINGS_REASONING_LEVELS) &&
    isKnownString(value.chromeMode, SETTINGS_CHROME_MODES) &&
    isSafeChromeProfileDirSetting(value.chromeProfileDir) &&
    isBoundedString(value.screenshotDir, MAX_SETTINGS_PATH_CHARS) &&
    isBoundedString(value.workspaceRoot, MAX_SETTINGS_PATH_CHARS) &&
    typeof value.workspaceContextEnabled === 'boolean' &&
    typeof value.workspaceFileSearchEnabled === 'boolean' &&
    typeof value.goalContextEnabled === 'boolean' &&
    typeof value.learningMemoryEnabled === 'boolean' &&
    isBoundedString(value.customModels, MAX_SETTINGS_CUSTOM_MODELS_CHARS) &&
    typeof value.compactionThreshold === 'number' &&
    Number.isFinite(value.compactionThreshold) &&
    value.compactionThreshold >= 0.2 &&
    value.compactionThreshold <= 0.95 &&
    typeof value.contextWindow === 'number' &&
    Number.isSafeInteger(value.contextWindow) &&
    value.contextWindow >= 8_000 &&
    value.contextWindow <= 2_000_000 &&
    typeof value.petScale === 'number' &&
    Number.isFinite(value.petScale) &&
    value.petScale >= 0.25 &&
    value.petScale <= 4 &&
    typeof value.launchOnStartup === 'boolean' &&
    isSettingsPosition(value.petX) &&
    isSettingsPosition(value.petY)
  );
}

const QUICK_WINDOW_MODES = ['off', 'ask', 'answer'] as const;

/** Validates the two-coordinate window position returned by Electron. */
export function isWindowPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteWindowCoordinate(value[0]) &&
    isFiniteWindowCoordinate(value[1])
  );
}

/** Validates boolean acknowledgements returned by state-changing IPC calls. */
export function isBooleanResponse(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Validates an IPC call whose contract deliberately returns no payload. */
export function isUndefinedResponse(value: unknown): value is undefined {
  return value === undefined;
}

/** Accepts only the active app window's top-level renderer frame. */
export function isTrustedIpcEvent(
  event: { sender: unknown; senderFrame: unknown } | null | undefined,
  expectedSender: { mainFrame: unknown } | null | undefined,
): boolean {
  if (!event || !expectedSender || event.sender !== expectedSender) return false;
  const sender = event.sender as { mainFrame: unknown };
  return event.senderFrame === sender.mainFrame;
}

/** Allows navigation only to the exact local document that owns the preload bridge. */
export function isAllowedRendererNavigation(url: unknown, expectedUrl: unknown): boolean {
  if (typeof url !== 'string' || typeof expectedUrl !== 'string' || url !== expectedUrl) return false;
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

/** Validates the finite quick-window state returned by the main process. */
export function isQuickWindowMode(value: unknown): value is 'off' | 'ask' | 'answer' {
  return isKnownString(value, QUICK_WINDOW_MODES);
}

/** Validates bounded clipboard text before it becomes renderer draft state. */
export function isClipboardText(value: unknown): value is string {
  return isBoundedString(value, MAX_CLIPBOARD_RESULT_CHARS) && !/\0/.test(value);
}

/** Validates the path returned after opening the MCP configuration file. */
export function isConfigPath(value: unknown): value is string {
  return isNonEmptyBoundedString(value, MAX_SETTINGS_PATH_CHARS) && !/[\0\r\n]/.test(value);
}

const TOOL_STUDIO_KINDS = ['script', 'http', 'workflow'] as const;
const TOOL_STUDIO_LANGUAGES = ['powershell', 'python', 'node'] as const;
const TOOL_STUDIO_PARAM_TYPES = ['string', 'number', 'boolean'] as const;
const TOOL_STUDIO_SOURCES = ['agent', 'folder', 'skill'] as const;
const TOOL_STUDIO_DEFINITION_KEYS = [
  'name', 'description', 'kind', 'language', 'params', 'script', 'method', 'url',
  'headers', 'body', 'steps', 'sideEffectManifest', 'source', 'createdAt', 'path', 'skillId',
] as const;
const TOOL_STUDIO_PARAM_KEYS = ['name', 'description', 'type', 'required', 'default', 'choices'] as const;
const TOOL_STUDIO_STEP_KEYS = ['tool', 'args'] as const;
const TOOL_STUDIO_MANIFEST_KEYS = ['outputs', 'effects', 'reason'] as const;
const TOOL_STUDIO_SUMMARY_KEYS = [
  'name', 'description', 'kind', 'language', 'params', 'source', 'createdAt', 'path', 'skillId',
  'method', 'url', 'stepTools', 'scriptChars', 'bodyChars', 'headerCount',
] as const;
const TOOL_STUDIO_TEST_RESULT_KEYS = ['name', 'ok', 'content', 'durationMs', 'errorCode'] as const;
const TOOL_STUDIO_CANDIDATE_PROVIDERS = ['builtin', 'custom', 'mcp'] as const;
const TOOL_STUDIO_CANDIDATE_AVAILABILITY = ['available', 'unavailable', 'disabled', 'degraded'] as const;
const TOOL_STUDIO_CANDIDATE_KEYS = ['name', 'description', 'provider', 'availability', 'callable', 'permissionTier', 'parameterNames', 'dependency'] as const;

function isToolStudioParam(value: unknown): value is ToolStudioParam {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, TOOL_STUDIO_PARAM_KEYS) ||
    !isNonEmptyBoundedString(value.name, 80) ||
    !isBoundedString(value.description, MAX_TOOL_STUDIO_DESCRIPTION_CHARS) ||
    (value.type !== undefined && !isKnownString(value.type, TOOL_STUDIO_PARAM_TYPES)) ||
    (value.required !== undefined && typeof value.required !== 'boolean') ||
    (value.choices !== undefined && (
      !Array.isArray(value.choices) ||
      value.choices.length > MAX_TOOL_STUDIO_CHOICES ||
      !value.choices.every((choice) => isBoundedString(choice, 500))
    ))
  ) return false;
  if (value.default !== undefined && !(
    typeof value.default === 'string' ||
    typeof value.default === 'boolean' ||
    (typeof value.default === 'number' && Number.isFinite(value.default))
  )) return false;
  return !/[\0\r\n]/.test(String(value.name)) && !/[\0]/.test(String(value.description));
}

function isToolStudioManifest(value: unknown): value is ToolStudioDefinition['sideEffectManifest'] {
  if (!isRecord(value) || !hasOnlyKeys(value, TOOL_STUDIO_MANIFEST_KEYS)) return false;
  for (const key of ['outputs', 'effects'] as const) {
    const entries = value[key];
    if (entries !== undefined && (
      !Array.isArray(entries) ||
      entries.length > 40 ||
      !entries.every((entry) => isBoundedString(entry, MAX_TOOL_STUDIO_META_CHARS) && !/[\0\r\n]/.test(entry))
    )) return false;
  }
  return value.reason === undefined || (
    isBoundedString(value.reason, MAX_TOOL_STUDIO_META_CHARS) &&
    value.reason.trim().length > 0 &&
    !/[\0\r\n]/.test(value.reason)
  );
}

function isToolStudioStep(value: unknown): value is ToolStudioWorkflowStep {
  if (!isRecord(value) || !hasOnlyKeys(value, TOOL_STUDIO_STEP_KEYS)) return false;
  if (!isNonEmptyBoundedString(value.tool, 200) || /[\0\r\n]/.test(value.tool) || !isRecord(value.args)) return false;
  try {
    assertJsonWithinLimit(value.args, MAX_TOOL_STUDIO_WORKFLOW_ARGS_BYTES, 'Tool Studio workflow arguments');
    return true;
  } catch {
    return false;
  }
}

/** Validates one full definition crossing the renderer/main boundary. */
export function isToolStudioDefinition(value: unknown): value is ToolStudioDefinition {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, TOOL_STUDIO_DEFINITION_KEYS) ||
    !/^[a-z][a-z0-9_]{2,40}$/.test(String(value.name ?? '')) ||
    !isNonEmptyBoundedString(value.description, MAX_TOOL_STUDIO_DESCRIPTION_CHARS) ||
    !isKnownString(value.kind, TOOL_STUDIO_KINDS) ||
    !isKnownString(value.language, TOOL_STUDIO_LANGUAGES) ||
    !Array.isArray(value.params) ||
    value.params.length > MAX_TOOL_STUDIO_PARAMS ||
    !value.params.every(isToolStudioParam) ||
    (value.source !== undefined && !isKnownString(value.source, TOOL_STUDIO_SOURCES)) ||
    (value.createdAt !== undefined && !isBoundedString(value.createdAt, 80)) ||
    (value.path !== undefined && !isNonEmptyBoundedString(value.path, MAX_TOOL_STUDIO_PATH_CHARS)) ||
    (value.skillId !== undefined && !isNonEmptyBoundedString(value.skillId, MAX_TOOL_STUDIO_META_CHARS))
  ) return false;
  if (/[\0\r\n]/.test(String(value.name)) || /[\0]/.test(String(value.description))) return false;
  if (value.script !== undefined && (!isBoundedString(value.script, MAX_TOOL_STUDIO_SCRIPT_CHARS) || /[\0]/.test(value.script))) return false;
  if (value.method !== undefined && (!isNonEmptyBoundedString(value.method, 100) || /[\0\r\n]/.test(value.method))) return false;
  if (value.url !== undefined && (!isBoundedString(value.url, MAX_TOOL_STUDIO_URL_CHARS) || /[\0\r\n]/.test(value.url))) return false;
  if (value.body !== undefined && (!isBoundedString(value.body, MAX_TOOL_STUDIO_BODY_CHARS) || /[\0]/.test(value.body))) return false;
  if (value.headers !== undefined) {
    if (!isRecord(value.headers) || Object.keys(value.headers).length > MAX_TOOL_STUDIO_HEADERS) return false;
    if (!Object.entries(value.headers).every(([key, entry]) =>
      isBoundedString(key, 200) && !/[\0\r\n]/.test(key) &&
      isBoundedString(entry, 4_000) && !/[\0\r\n]/.test(entry)
    )) return false;
  }
  if (value.steps !== undefined && (
    !Array.isArray(value.steps) ||
    value.steps.length > MAX_TOOL_STUDIO_WORKFLOW_STEPS ||
    !value.steps.every(isToolStudioStep)
  )) return false;
  if (value.sideEffectManifest !== undefined && !isToolStudioManifest(value.sideEffectManifest)) return false;
  if (value.kind === 'script' && !isNonEmptyBoundedString(value.script, MAX_TOOL_STUDIO_SCRIPT_CHARS)) return false;
  if (value.kind === 'http' && !isNonEmptyBoundedString(value.url, MAX_TOOL_STUDIO_URL_CHARS)) return false;
  if (value.kind === 'workflow' && (!Array.isArray(value.steps) || value.steps.length === 0)) return false;
  return true;
}

export function isToolStudioDefinitionOrNull(value: unknown): value is ToolStudioDefinition | null {
  return value === null || isToolStudioDefinition(value);
}

export function isToolStudioTestArgs(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    assertJsonWithinLimit(value, MAX_TOOL_STUDIO_WORKFLOW_ARGS_BYTES, 'Tool Studio test arguments');
    return true;
  } catch {
    return false;
  }
}
function isToolStudioSummary(value: unknown): value is ToolStudioSummary {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, TOOL_STUDIO_SUMMARY_KEYS) ||
    !/^[a-z][a-z0-9_]{2,40}$/.test(String(value.name ?? '')) ||
    !isNonEmptyBoundedString(value.description, MAX_TOOL_STUDIO_DESCRIPTION_CHARS) ||
    !isKnownString(value.kind, TOOL_STUDIO_KINDS) ||
    !isKnownString(value.language, TOOL_STUDIO_LANGUAGES) ||
    !Array.isArray(value.params) ||
    value.params.length > MAX_TOOL_STUDIO_PARAMS ||
    !value.params.every(isToolStudioParam) ||
    !isKnownString(value.source, TOOL_STUDIO_SOURCES) ||
    !isBoundedString(value.createdAt, 80)
  ) return false;
  if (value.path !== undefined && !isNonEmptyBoundedString(value.path, MAX_TOOL_STUDIO_PATH_CHARS)) return false;
  if (value.skillId !== undefined && !isNonEmptyBoundedString(value.skillId, MAX_TOOL_STUDIO_META_CHARS)) return false;
  if (value.method !== undefined && !isNonEmptyBoundedString(value.method, 100)) return false;
  if (value.url !== undefined && !isBoundedString(value.url, MAX_TOOL_STUDIO_URL_CHARS)) return false;
  if (value.stepTools !== undefined && (
    !Array.isArray(value.stepTools) ||
    value.stepTools.length > MAX_TOOL_STUDIO_WORKFLOW_STEPS ||
    !value.stepTools.every((tool) => isNonEmptyBoundedString(tool, 200))
  )) return false;
  for (const key of ['scriptChars', 'bodyChars', 'headerCount'] as const) {
    if (value[key] !== undefined && !isBoundedCount(value[key], MAX_TOOL_STUDIO_SCRIPT_CHARS)) return false;
  }
  return true;
}

/** Validates the small metadata-only library response. */
export function isToolStudioSummaryList(value: unknown): value is ToolStudioSummary[] {
  return Array.isArray(value) && value.length <= MAX_TOOL_STUDIO_TOOLS && value.every(isToolStudioSummary);
}

function isToolStudioCandidate(value: unknown): value is ToolStudioToolCandidate {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, TOOL_STUDIO_CANDIDATE_KEYS) &&
    isNonEmptyBoundedString(value.name, 200) &&
    isBoundedString(value.description, 500) &&
    isKnownString(value.provider, TOOL_STUDIO_CANDIDATE_PROVIDERS) &&
    isKnownString(value.availability, TOOL_STUDIO_CANDIDATE_AVAILABILITY) &&
    typeof value.callable === 'boolean' &&
    (value.permissionTier === undefined || isKnownString(value.permissionTier, PERMISSION_TIERS)) &&
    Array.isArray(value.parameterNames) &&
    value.parameterNames.length <= MAX_TOOL_STUDIO_PARAMS &&
    value.parameterNames.every((name) => isNonEmptyBoundedString(name, 200)) &&
    (value.dependency === undefined || isNonEmptyBoundedString(value.dependency, MAX_TOOL_STUDIO_META_CHARS))
  );
}

/** Validates the bounded, metadata-only catalog used by the workflow editor. */
export function isToolStudioCandidateList(value: unknown): value is ToolStudioToolCandidate[] {
  return Array.isArray(value) && value.length <= MAX_TOOL_STUDIO_CANDIDATES && value.every(isToolStudioCandidate);
}

/** Validates a single central-permission test result. */
export function isToolStudioTestResult(value: unknown): value is ToolStudioTestResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, TOOL_STUDIO_TEST_RESULT_KEYS) &&
    isNonEmptyBoundedString(value.name, MAX_TOOL_STUDIO_NAME_CHARS) &&
    typeof value.ok === 'boolean' &&
    isBoundedString(value.content, MAX_TOOL_STUDIO_RESULT_CHARS) &&
    isFiniteNonNegativeNumber(value.durationMs) &&
    value.durationMs <= MAX_STREAM_DURATION_MS &&
    (value.errorCode === undefined || isKnownString(value.errorCode, TOOL_ERROR_CODES))
  );
}
function isPermissionGrant(value: unknown): value is PermissionGrant {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, PERMISSION_GRANT_KEYS) &&
    typeof value.signature === 'string' &&
    /^[a-f0-9]{32}$/i.test(value.signature) &&
    isNonEmptyBoundedString(value.toolName, MAX_PERMISSION_TOOL_NAME_CHARS) &&
    isBoundedString(value.sample, MAX_PERMISSION_SAMPLE_CHARS) &&
    isFiniteNonNegativeNumber(value.createdAt)
  );
}

/** Validates saved approval rows before permission-management UI renders them. */
export function isPermissionGrantList(value: unknown): value is PermissionGrant[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PERMISSION_GRANTS &&
    value.every(isPermissionGrant)
  );
}

/** Validates the fixed list of realtime voice model identifiers. */
export function isVoiceModelList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_VOICE_MODELS &&
    value.every((model) => isNonEmptyBoundedString(model, MAX_VOICE_MODEL_CHARS))
  );
}

/** Validates the bounded result returned after registering the global hotkey. */
export function isHotkeyResult(value: unknown): value is { ok: boolean; message: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, HOTKEY_RESULT_KEYS) &&
    typeof value.ok === 'boolean' &&
    isBoundedString(value.message, MAX_HOTKEY_MESSAGE_CHARS)
  );
}

function isGoalProgress(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, GOAL_PROGRESS_KEYS) &&
    isFiniteNonNegativeNumber(value.at) &&
    isNonEmptyBoundedString(value.note, MAX_GOAL_PROGRESS_NOTE_CHARS)
  );
}

function isGoalWatch(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, GOAL_WATCH_KEYS) &&
    typeof value.everyMinutes === 'number' &&
    Number.isFinite(value.everyMinutes) &&
    value.everyMinutes >= 10 &&
    value.everyMinutes <= MAX_GOAL_WATCH_INTERVAL_MINUTES &&
    isNonEmptyBoundedString(value.looksAt, MAX_GOAL_LOOKS_AT_CHARS) &&
    (value.lastCheckedAt === undefined || isFiniteNonNegativeNumber(value.lastCheckedAt))
  );
}

function isGoalResponse(value: unknown): value is Goal {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, GOAL_KEYS) &&
    isNonEmptyBoundedString(value.id, MAX_GOAL_ID_CHARS) &&
    isNonEmptyBoundedString(value.title, MAX_GOAL_TITLE_CHARS) &&
    (value.detail === undefined || isBoundedString(value.detail, MAX_GOAL_DETAIL_CHARS)) &&
    isFiniteNonNegativeNumber(value.createdAt) &&
    (value.dueAt === undefined || isFiniteNonNegativeNumber(value.dueAt)) &&
    isKnownString(value.status, ['active', 'done', 'dropped']) &&
    Array.isArray(value.progress) &&
    value.progress.length <= MAX_GOAL_PROGRESS &&
    value.progress.every(isGoalProgress) &&
    (value.watch === undefined || isGoalWatch(value.watch))
  );
}

/** Validates goals returned by list, finish, and stop-watch operations. */
export function isGoalList(value: unknown): value is Goal[] {
  return Array.isArray(value) && value.length <= MAX_GOAL_RECORDS && value.every(isGoalResponse);
}

function isMemoryEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, MEMORY_ENTRY_KEYS) &&
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    value.index >= 1 &&
    value.index <= MAX_MEMORY_ENTRY_INDEX &&
    (value.date === '' || (typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date))) &&
    isBoundedString(value.text, MAX_MEMORY_ENTRY_TEXT_CHARS)
  );
}

/** Validates bounded saved-note rows and their aggregate renderer payload. */
export function isLessonListView(value: unknown): value is LessonListView {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, MEMORY_VIEW_KEYS) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_MEMORY_ENTRIES ||
    typeof value.editable !== 'boolean' ||
    !isOptionalBoundedString(value.warning, MAX_MEMORY_WARNING_CHARS)
  ) {
    return false;
  }
  let totalTextChars = 0;
  for (const entry of value.entries) {
    if (!isMemoryEntry(entry)) return false;
    totalTextChars += entry.text.length;
    if (totalTextChars > MAX_MEMORY_TOTAL_TEXT_CHARS) return false;
  }
  return true;
}

function isDiagnosticDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_DIAGNOSTIC_DURATION_MS
  );
}

function isDiagnosticCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, DIAGNOSTIC_CHECK_KEYS) &&
    isNonEmptyBoundedString(value.id, MAX_DIAGNOSTIC_ID_CHARS) &&
    isNonEmptyBoundedString(value.label, MAX_DIAGNOSTIC_LABEL_CHARS) &&
    isKnownString(value.status, DIAGNOSTIC_STATUSES) &&
    isBoundedString(value.detail, MAX_DIAGNOSTIC_DETAIL_CHARS)
  );
}

function isDiagnosticFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, DIAGNOSTIC_FAILURE_KEYS) &&
    isKnownString(value.source, DIAGNOSTIC_FAILURE_SOURCES) &&
    isNonEmptyBoundedString(value.label, MAX_DIAGNOSTIC_LABEL_CHARS) &&
    isBoundedString(value.detail, MAX_DIAGNOSTIC_FAILURE_DETAIL_CHARS) &&
    isFiniteNonNegativeNumber(value.at) &&
    isOptionalBoundedString(value.errorCode, MAX_DIAGNOSTIC_ERROR_CODE_CHARS)
  );
}

/** Validates diagnostics text, records, counters, and durations before DOM rendering. */
export function isDiagnosticsSnapshot(value: unknown): value is DiagnosticsSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, DIAGNOSTICS_SNAPSHOT_KEYS) ||
    !isFiniteNonNegativeNumber(value.checkedAt) ||
    !Array.isArray(value.checks) ||
    value.checks.length > MAX_DIAGNOSTIC_CHECKS ||
    !value.checks.every(isDiagnosticCheck) ||
    !Array.isArray(value.recentFailures) ||
    value.recentFailures.length > MAX_DIAGNOSTIC_FAILURES ||
    !value.recentFailures.every(isDiagnosticFailure) ||
    !isRecord(value.metrics) ||
    !hasOnlyKeys(value.metrics, DIAGNOSTIC_METRICS_KEYS) ||
    !isBoundedCount(value.metrics.recentAuditEntries, MAX_DIAGNOSTIC_COUNTS) ||
    !isBoundedCount(value.metrics.recentRuntimeErrors, MAX_DIAGNOSTIC_COUNTS) ||
    !isBoundedCount(value.metrics.recentModelRequests, MAX_DIAGNOSTIC_COUNTS) ||
    (value.metrics.averageToolMs !== undefined && !isDiagnosticDuration(value.metrics.averageToolMs)) ||
    (value.metrics.slowestToolMs !== undefined && !isDiagnosticDuration(value.metrics.slowestToolMs))
  ) {
    return false;
  }
  return true;
}

function isBoundedJsonRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    assertJsonWithinLimit(value, MAX_STREAM_TOOL_JSON_CHARS, 'Tool arguments');
    return true;
  } catch {
    return false;
  }
}

function isImageDataUrlWithinLimit(value: unknown, maxChars: number): value is string {
  if (!isBoundedString(value, maxChars)) return false;
  const match = IMAGE_DATA_URL.exec(value);
  return Boolean(match && match[2] && match[2].length % 4 !== 1);
}

function isStreamImageDataUrl(value: unknown): value is string {
  return isImageDataUrlWithinLimit(value, MAX_STREAM_IMAGE_DATA_URL_CHARS);
}

const ATTACHMENT_KINDS = ['image', 'text'] as const;

function isAttachment(value: unknown): value is Attachment {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.name, MAX_ATTACHMENT_NAME_CHARS) ||
    !isKnownString(value.kind, ATTACHMENT_KINDS)
  ) {
    return false;
  }
  if (value.kind === 'image') {
    return value.text === undefined && isImageDataUrlWithinLimit(value.dataUrl, MAX_ATTACHMENT_DATA_URL_CHARS);
  }
  return value.dataUrl === undefined && isBoundedString(value.text, MAX_ATTACHMENT_TEXT_CHARS);
}

/** Validates bounded attachment responses before the renderer stores or renders them. */
export function isAttachmentList(value: unknown): value is Attachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return false;
  let totalImageDataUrlChars = 0;
  for (const item of value) {
    if (!isAttachment(item)) return false;
    if (item.kind === 'image') {
      totalImageDataUrlChars += item.dataUrl?.length ?? 0;
      if (totalImageDataUrlChars > MAX_ATTACHMENT_IMAGE_DATA_URL_TOTAL_CHARS) return false;
    }
  }
  return true;
}

function isMcpToolSummary(value: unknown): value is McpToolSummary {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.name, MAX_IPC_IDENTIFIER_CHARS) &&
    isNonEmptyBoundedString(value.qualifiedName, MAX_IPC_IDENTIFIER_CHARS * 2) &&
    isBoundedString(value.description, MAX_STREAM_CONTENT_CHARS) &&
    typeof value.disabled === 'boolean' &&
    isKnownString(value.permission, MCP_PERMISSIONS)
  );
}

function isMcpServerStatus(value: unknown): value is McpServerStatus {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.name, MAX_IPC_IDENTIFIER_CHARS) ||
    !isKnownString(value.transport, MCP_TRANSPORTS) ||
    !isBoundedString(value.target, MAX_STREAM_CONTENT_CHARS) ||
    typeof value.connected !== 'boolean' ||
    typeof value.disabled !== 'boolean' ||
    !isBoundedCount(value.toolCount) ||
    !isBoundedCount(value.resourceCount)
  ) {
    return false;
  }
  if (value.disabledToolCount !== undefined && !isBoundedCount(value.disabledToolCount)) return false;
  if (
    value.tools !== undefined &&
    (!Array.isArray(value.tools) ||
      value.tools.length > MAX_STREAM_MCP_TOOLS ||
      !value.tools.every(isMcpToolSummary))
  ) {
    return false;
  }
  if (value.error !== undefined && !isBoundedString(value.error, MAX_STREAM_CONTENT_CHARS)) return false;
  if (value.toolError !== undefined && !isBoundedString(value.toolError, MAX_STREAM_CONTENT_CHARS)) return false;
  return true;
}

/** Validates direct MCP status responses before the renderer builds integration UI. */
export function isMcpServerStatusList(value: unknown): value is McpServerStatus[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_STREAM_MCP_SERVERS &&
    value.every(isMcpServerStatus)
  );
}

function isToolCall(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    isNonEmptyBoundedString(value.id, MAX_IPC_IDENTIFIER_CHARS) &&
    isNonEmptyBoundedString(value.name, MAX_IPC_IDENTIFIER_CHARS) &&
    isBoundedJsonRecord(value.args)
  );
}

const CHAT_ROLES = ['system', 'user', 'assistant', 'tool'] as const;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (
    !isRecord(value) ||
    !isPositiveSafeInteger(value.id) ||
    !isPositiveSafeInteger(value.conversationId) ||
    !isKnownString(value.role, CHAT_ROLES) ||
    !isBoundedString(value.content, MAX_CHAT_HISTORY_CONTENT_CHARS) ||
    typeof value.active !== 'boolean' ||
    typeof value.isSummary !== 'boolean' ||
    !isBoundedCount(value.tokens, 10_000_000) ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    return false;
  }
  if (
    value.toolCalls !== undefined &&
    (!Array.isArray(value.toolCalls) ||
      value.toolCalls.length > MAX_CHAT_TOOL_CALLS ||
      !value.toolCalls.every(isToolCall))
  ) {
    return false;
  }
  if (
    value.toolCallId !== undefined &&
    !isNonEmptyBoundedString(value.toolCallId, MAX_IPC_IDENTIFIER_CHARS)
  ) {
    return false;
  }
  if (value.imageDataUrl !== undefined && !isStreamImageDataUrl(value.imageDataUrl)) {
    return false;
  }
  return true;
}

export interface ChatHistoryResult {
  conversationId: number;
  messages: ChatMessage[];
}

/** Validates persisted transcript rows before the renderer rebuilds the chat UI. */
export function isChatHistoryResult(value: unknown): value is ChatHistoryResult {
  if (!isRecord(value) || !isPositiveSafeInteger(value.conversationId)) return false;
  if (
    !Array.isArray(value.messages) ||
    value.messages.length > MAX_CHAT_HISTORY_MESSAGES
  ) {
    return false;
  }
  return value.messages.every(
    (message) => isChatMessage(message) && message.conversationId === value.conversationId,
  );
}

const CONVERSATION_KINDS = ['chat', 'quick'] as const;
const CONVERSATION_REFERENCE_KINDS: readonly ConversationReferenceKind[] = [
  'file',
  'goal',
  'assignment',
  'project',
];

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isConversationSummary(value: unknown): value is ConversationSummary {
  if (
    !isRecord(value) ||
    !isPositiveSafeInteger(value.id) ||
    !isBoundedString(value.title, MAX_CONVERSATION_TITLE_CHARS) ||
    !isNonNegativeSafeInteger(value.createdAt) ||
    !isNonNegativeSafeInteger(value.updatedAt) ||
    !isBoundedCount(value.messageCount, 10_000_000) ||
    !isKnownString(value.kind, CONVERSATION_KINDS) ||
    typeof value.starred !== 'boolean' ||
    typeof value.archived !== 'boolean' ||
    !isBoundedCount(value.referenceCount, MAX_CONVERSATION_REFERENCES)
  ) {
    return false;
  }
  if (value.summary !== undefined && !isBoundedString(value.summary, MAX_CONVERSATION_SUMMARY_CHARS)) return false;
  if (value.folderId !== undefined && !isPositiveSafeInteger(value.folderId)) return false;
  if (
    value.folderName !== undefined &&
    !isNonEmptyBoundedString(value.folderName, MAX_CONVERSATION_FOLDER_NAME_CHARS)
  ) {
    return false;
  }
  if (value.expiresAt !== undefined && !isNonNegativeSafeInteger(value.expiresAt)) return false;
  return true;
}

/** Validates the bounded conversation summaries consumed by sidebar and archive UI. */
export function isConversationSummaryList(value: unknown): value is ConversationSummary[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CONVERSATION_SUMMARIES &&
    value.every(isConversationSummary)
  );
}

function isConversationFolder(value: unknown): value is ConversationFolder {
  return (
    isRecord(value) &&
    isPositiveSafeInteger(value.id) &&
    isNonEmptyBoundedString(value.name, MAX_CONVERSATION_FOLDER_NAME_CHARS) &&
    isBoundedCount(value.conversationCount, 10_000_000) &&
    isNonNegativeSafeInteger(value.createdAt) &&
    isNonNegativeSafeInteger(value.updatedAt)
  );
}

/** Validates a single folder record returned by folder create/rename calls. */
export function isConversationFolderResult(value: unknown): value is ConversationFolder {
  return isConversationFolder(value);
}

/** Validates the bounded folder list consumed by the conversation filter UI. */
export function isConversationFolderList(value: unknown): value is ConversationFolder[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CONVERSATION_FOLDERS &&
    value.every(isConversationFolder)
  );
}

function isConversationReference(value: unknown): value is ConversationReference {
  return (
    isRecord(value) &&
    isPositiveSafeInteger(value.id) &&
    isPositiveSafeInteger(value.conversationId) &&
    isKnownString(value.kind, CONVERSATION_REFERENCE_KINDS) &&
    isNonEmptyBoundedString(value.reference, MAX_CONVERSATION_REFERENCE_CHARS) &&
    isNonEmptyBoundedString(value.label, MAX_CONVERSATION_REFERENCE_LABEL_CHARS) &&
    isNonNegativeSafeInteger(value.createdAt)
  );
}

/** Validates a reference list and rejects mixed conversation owners. */
export function isConversationReferenceList(value: unknown): value is ConversationReference[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CONVERSATION_REFERENCES ||
    !value.every(isConversationReference)
  ) {
    return false;
  }
  const owner = value[0]?.conversationId;
  return owner === undefined || value.every((reference) => reference.conversationId === owner);
}

/** Validates that a reference response belongs to the conversation requested by the renderer. */
export function isConversationReferenceListFor(
  value: unknown,
  conversationId: unknown,
): value is ConversationReference[] {
  return (
    isPositiveSafeInteger(conversationId) &&
    isConversationReferenceList(value) &&
    value.every((reference) => reference.conversationId === conversationId)
  );
}

function isToolResult(value: unknown): value is ToolResult {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.toolCallId, MAX_IPC_IDENTIFIER_CHARS) ||
    typeof value.ok !== 'boolean' ||
    !isBoundedString(value.content, MAX_STREAM_CONTENT_CHARS) ||
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    value.durationMs > MAX_STREAM_DURATION_MS
  ) {
    return false;
  }
  if (value.errorCode !== undefined && !isKnownString(value.errorCode, TOOL_ERROR_CODES)) return false;
  if (value.imageDataUrls === undefined) return true;
  if (!Array.isArray(value.imageDataUrls) || value.imageDataUrls.length > MAX_ATTACHMENTS) return false;
  let total = 0;
  for (const image of value.imageDataUrls) {
    if (!isStreamImageDataUrl(image)) return false;
    total += image.length;
    if (total > MAX_STREAM_IMAGE_DATA_URL_TOTAL_CHARS) return false;
  }
  return true;
}

/** Validates the complete main-to-renderer stream contract before it reaches UI code. */
export function isStreamEvent(value: unknown): value is StreamEvent {
  if (!isRecord(value) || !isKnownString(value.type, STREAM_EVENT_TYPES)) return false;
  const operationId = value.operationId;
  if (operationId !== undefined && !isNonEmptyBoundedString(operationId, MAX_IPC_IDENTIFIER_CHARS)) return false;
  if (value.type === 'mcp') {
    return isMcpServerStatusList(value.servers);
  }
  if (!isNonEmptyBoundedString(operationId, MAX_IPC_IDENTIFIER_CHARS)) return false;
  switch (value.type) {
    case 'started':
      return isKnownString(value.kind, TURN_KINDS);
    case 'delta':
      return isBoundedString(value.text, MAX_STREAM_CONTENT_CHARS);
    case 'tool-start':
      return isToolCall(value.call) && (
        value.displayArgs === undefined || isBoundedString(value.displayArgs, MAX_STREAM_DISPLAY_ARGS_CHARS)
      );
    case 'tool-end':
      return isToolResult(value.result);
    case 'compacted':
      return (
        isBoundedCount(value.freedTokens) &&
        typeof value.summaryId === 'number' &&
        Number.isInteger(value.summaryId) &&
        value.summaryId >= -1 &&
        value.summaryId <= MAX_STREAM_COUNT
      );
    case 'notice':
      return isBoundedString(value.message, MAX_STREAM_CONTENT_CHARS);
    case 'done':
      return isBoundedCount(value.messageId);
    case 'error':
      return isBoundedString(value.message, MAX_STREAM_CONTENT_CHARS);
    default:
      return false;
  }
}
