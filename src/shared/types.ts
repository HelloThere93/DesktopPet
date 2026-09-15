/** Types crossing the main <-> renderer IPC boundary. */

export const MAX_CHAT_INPUT_CHARS = 100_000;
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_NAME_CHARS = 240;
export const MAX_ATTACHMENT_TEXT_CHARS = 200_000;
export const MAX_ATTACHMENT_DATA_URL_CHARS = 20_000_000;
export const MAX_TURN_IMAGE_DATA_URL_CHARS = 24_000_000;

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A file the user attached to a message. */
export interface Attachment {
  name: string;
  kind: 'image' | 'text';
  /** Images: a data: URL the model can look at. */
  dataUrl?: string;
  /** Text-ish files: their contents, inlined into the message. */
  text?: string;
}

/** A conversation as shown in the sidebar. */
export interface ConversationSummary {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** 'quick' threads come from the hover bar and expire; 'chat' are kept. */
  kind: ConversationKind;
  /** Quick chats use this to opt out of sweeping; regular chats use it as a pin. */
  starred: boolean;
  archived: boolean;
  referenceCount: number;
  /** Latest bounded compaction summary, kept for local discoverability only. */
  summary?: string;
  folderId?: number;
  folderName?: string;
  /** Quick chats only: when this thread is due to be swept, in ms. */
  expiresAt?: number;
}

export type ConversationReferenceKind = 'file' | 'goal' | 'assignment' | 'project';

export interface ConversationReference {
  id: number;
  conversationId: number;
  kind: ConversationReferenceKind;
  reference: string;
  label: string;
  createdAt: number;
}

export interface ConversationFolder {
  id: number;
  name: string;
  conversationCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AssignmentSummary {
  id: string;
  title: string;
  subject?: string;
  dueAt?: number;
  status: 'active' | 'done' | 'archived';
  projectId?: string;
  goalId?: string;
  checklistTotal: number;
  checklistDone: number;
  notesCount: number;
  researchCount: number;
  citationCount: number;
  artifactCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  workspaceRoot?: string;
  createdAt: number;
  status: 'active' | 'paused' | 'done' | 'archived';
  assignmentCount: number;
  activeAssignmentCount: number;
  researchCount: number;
  verifiedArtifactCount: number;
}

export interface ConversationSearchHit {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  kind: ConversationKind;
  starred: boolean;
  archived: boolean;
  referenceCount: number;
  folderId?: number;
  folderName?: string;
  /** Latest bounded compaction summary, kept for local search only. */
  summary?: string;
  snippet: string;
}

export type LocalSearchKind =
  | 'conversation'
  | 'memory'
  | 'goal'
  | 'assignment'
  | 'research'
  | 'project'
  | 'file'
  | 'workflow';

export interface LocalSearchResult {
  kind: LocalSearchKind;
  id: string;
  title: string;
  snippet: string;
  updatedAt: number;
  conversationKind?: ConversationKind;
  archived?: boolean;
}

export type ConversationKind = 'chat' | 'quick';

/**
 * How long an unstarred quick chat survives after its last message.
 *
 * Measured from last activity rather than creation, so a thread you are still
 * using is never swept out from under you mid-conversation.
 */
export const QUICK_CHAT_TTL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_COMPACTION_THRESHOLD = 0.7;
export const MIN_COMPACTION_THRESHOLD = 0.2;
export const MAX_COMPACTION_THRESHOLD = 0.95;
export const DEFAULT_CONTEXT_WINDOW = 272_000;
export const MIN_CONTEXT_WINDOW = 8_000;
export const MAX_CONTEXT_WINDOW = 2_000_000;
export function isValidCompactionThreshold(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_COMPACTION_THRESHOLD &&
    value <= MAX_COMPACTION_THRESHOLD
  );
}
export function normaliseCompactionThreshold(value: unknown): number {
  return isValidCompactionThreshold(value) ? value : DEFAULT_COMPACTION_THRESHOLD;
}
export function isValidContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CONTEXT_WINDOW && value <= MAX_CONTEXT_WINDOW;
}
export function normaliseContextWindow(value: unknown): number {
  return isValidContextWindow(value) ? value : DEFAULT_CONTEXT_WINDOW;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: Role;
  content: string;
  /** Tool calls the assistant requested on this turn, if any. */
  toolCalls?: ToolCall[];
  /** For role==='tool': which call this is answering. */
  toolCallId?: string;
  /** Compaction marks superseded messages inactive rather than deleting them. */
  active: boolean;
  /** True for the synthetic summary rows compaction writes. */
  isSummary: boolean;
  /** An image attached to this message, sent to the model as visual input. */
  imageDataUrl?: string;
  tokens: number;
  createdAt: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  ok: boolean;
  content: string;
  durationMs: number;
  errorCode?: ToolErrorCode;
  /** Set by tools that produce images the model should actually look at. */
  imageDataUrls?: string[];
}

/**
 * The bounded, renderer-facing shape used by Tool Studio. Keep this separate
 * from the model's live tool schema: the editor needs source metadata and
 * editable definitions, while the model should only receive callable tools.
 */
export type ToolStudioKind = 'script' | 'http' | 'workflow';
export type ToolStudioCandidateProvider = 'builtin' | 'custom' | 'mcp';
export type ToolStudioCandidateAvailability = 'available' | 'unavailable' | 'disabled' | 'degraded';

export interface ToolStudioToolCandidate {
  name: string;
  description: string;
  provider: ToolStudioCandidateProvider;
  availability: ToolStudioCandidateAvailability;
  callable: boolean;
  permissionTier?: PermissionTier;
  parameterNames: string[];
  dependency?: string;
}
export type ToolStudioLanguage = 'powershell' | 'python' | 'node';

export interface ToolStudioParam {
  name: string;
  description: string;
  type?: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  choices?: string[];
}

export interface ToolStudioWorkflowStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolStudioSideEffectManifest {
  outputs?: string[];
  effects?: string[];
  reason?: string;
}

export interface ToolStudioSummary {
  name: string;
  description: string;
  kind: ToolStudioKind;
  language: ToolStudioLanguage;
  params: ToolStudioParam[];
  source: 'agent' | 'folder' | 'skill';
  createdAt: string;
  path?: string;
  skillId?: string;
  method?: string;
  url?: string;
  stepTools?: string[];
  scriptChars?: number;
  bodyChars?: number;
  headerCount?: number;
}

export interface ToolStudioDefinition {
  name: string;
  description: string;
  kind: ToolStudioKind;
  language: ToolStudioLanguage;
  params: ToolStudioParam[];
  script?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  steps?: ToolStudioWorkflowStep[];
  sideEffectManifest?: ToolStudioSideEffectManifest;
  source?: 'agent' | 'folder' | 'skill';
  createdAt?: string;
  path?: string;
  skillId?: string;
}

export interface ToolStudioTestResult {
  name: string;
  ok: boolean;
  content: string;
  durationMs: number;
  errorCode?: ToolErrorCode;
}
export type ToolErrorCode = 'policy-blocked' | 'permission-denied' | 'execution-failed' | 'tool-not-loaded' | 'invalid-arguments' | 'bulk-partial-failure';

/**
 * How much the agent may do without stopping to ask.
 *
 * The 'never' tier is unaffected by all of these: skipping confirmations is a
 * convenience, whereas the denylist exists precisely because a prompt is not
 * adequate protection for those actions.
 */
export type ApprovalMode = 'ask' | 'auto-edit' | 'auto';

export const APPROVAL_MODES: { id: ApprovalMode; label: string; note: string }[] = [
  { id: 'ask', label: 'Ask', note: 'Confirm anything that changes the machine (default)' },
  { id: 'auto-edit', label: 'Auto edits', note: 'File writes and folders run freely; shell and settings still ask' },
  { id: 'auto', label: 'Full auto', note: 'Runs every confirm-tier action without asking. Permanent denylist actions stay blocked' },
];

/** How dangerous a given tool invocation is judged to be. */
export type PermissionTier = 'auto' | 'confirm' | 'never';

export interface PermissionRequest {
  id: string;
  /** Correlates the approval with the turn that requested it. */
  operationId?: string;
  toolName: string;
  /** Human-readable one-liner, e.g. the exact command that will run. */
  summary: string;
  /** Longer detail shown when the user expands the bubble. */
  detail: string;
  tier: PermissionTier;
  /** Why it was classified this way — shown to the user. */
  reason: string;
  /** Whether a matching approval may cover later matching calls in this request only. */
  canAllowTask?: boolean;
  /** Whether a matching approval may be retained only until this app exits. */
  canAllowSession?: boolean;
  /** Whether a matching approval may be persisted as an always-allow rule. */
  canAlwaysAllow?: boolean;
}

export type PermissionDecision =
  | { action: 'allow-once' }
  | { action: 'allow-task' }
  | { action: 'allow-session' }
  | { action: 'allow-always' }
  | { action: 'deny' };

export interface PermissionGrant {
  signature: string;
  toolName: string;
  sample: string;
  createdAt: number;
}

export type PetMood = 'idle' | 'thinking' | 'working' | 'sleeping' | 'error';

export type TurnKind = 'chat' | 'quick' | 'goal';

/** Streaming events pushed from main to the renderer. */
export type StreamEvent = {
  operationId?: string;
} & (
  | { type: 'started'; operationId: string; kind: TurnKind }
  | { type: 'delta'; text: string }
  | { type: 'tool-start'; call: ToolCall; displayArgs?: string }
  | { type: 'tool-end'; result: ToolResult }
  | { type: 'compacted'; freedTokens: number; summaryId: number }
  /** Nonterminal progress/warning text. More stream events will follow. */
  | { type: 'notice'; message: string }
  | { type: 'done'; messageId: number }
  | { type: 'mcp'; servers: McpServerStatus[] }
  | { type: 'error'; message: string }
);

export interface AuthStatus {
  signedIn: boolean;
  accountId?: string;
  email?: string;
  expiresAt?: number;
  /** 'subscription' = ChatGPT OAuth, 'apikey' = platform key fallback. */
  mode?: 'subscription' | 'apikey';
}

/** How hard the model should think before answering. */
/**
 * Exactly the values the API accepts. Anything else is rejected outright with
 * `invalid_value` on reasoning.effort, so this list is the authority rather
 * than a guess at what the tiers might be called.
 */
export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export const REASONING_LEVELS: { id: ReasoningEffort; label: string; note: string }[] = [
  { id: 'none', label: 'None', note: 'No deliberation; fastest possible replies' },
  { id: 'minimal', label: 'Minimal', note: 'Barely thinks. Not offered by every model — falls back if refused' },
  { id: 'low', label: 'Low', note: 'Quick commands and simple questions' },
  { id: 'medium', label: 'Medium', note: 'Balanced default' },
  { id: 'high', label: 'High', note: 'Harder multi-step work' },
  { id: 'xhigh', label: 'Extra high', note: 'Slow but thorough' },
  { id: 'max', label: 'Max', note: 'Maximum deliberation; slowest' },
];

/** Coerces a stored or user-supplied value onto a level the API will accept. */
export function normaliseEffort(value: unknown): ReasoningEffort {
  const known = REASONING_LEVELS.map((l) => l.id) as string[];
  if (typeof value === 'string' && known.includes(value)) return value as ReasoningEffort;
  // 'ultra' shipped briefly and was never valid; treat it as the real ceiling.
  if (value === 'ultra') return 'max';
  return 'medium';
}

/** Voices offered by the realtime model. */
export const VOICE_NAMES = ['marin', 'cedar', 'alloy', 'echo', 'shimmer'];

export type VoiceEvent =
  | { type: 'open'; model: string }
  | { type: 'listening'; on: boolean }
  | { type: 'user-transcript'; text: string }
  | { type: 'speaking'; on: boolean }
  | { type: 'audio'; base64: string }
  | { type: 'closed'; reason: string }
  | { type: 'error'; message: string };

/**
 * Where requests are sent and how they are authenticated.
 *
 * 'chatgpt' is the ChatGPT-subscription OAuth path and needs no key. Everything
 * else is an API key you paste in, stored encrypted by the OS keystore like the
 * OAuth tokens are. Three request shapes cover all of them: the Responses API,
 * the OpenAI-compatible chat-completions API that most vendors now imitate, and
 * Anthropic's messages API.
 */
export type ProviderId =
  | 'chatgpt'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'google'
  | 'xai'
  | 'groq'
  | 'deepseek'
  | 'mistral'
  | 'together'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

export type ProviderShape = 'responses' | 'chat' | 'anthropic';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  shape: ProviderShape;
  baseUrl: string;
  /** False for local servers that accept anything as a key. */
  needsKey: boolean;
  /** Where to get a key, shown under the field. */
  keyUrl?: string;
  models: { id: string; label: string; note?: string }[];
  note?: string;
}

export interface Settings {
  model: string;
  /** Which access point requests go through. */
  provider: ProviderId;
  /** Base URL for provider 'custom'. Must be OpenAI-compatible. */
  customBaseUrl: string;
  /** JSON map of provider id -> last model chosen there. */
  providerModels: string;
  /** Realtime model used for spoken conversation. */
  voiceModel: string;
  /** Which voice it speaks in. */
  voiceName: string;
  /** deviceId of the microphone to listen on; empty means system default. */
  micDeviceId: string;
  /** Whether replies are read aloud. */
  speakReplies: boolean;
  /** Pauses new model turns, visual/audio capture, connected services, and goal watchers. */
  privacyMode: boolean;
  /** Global shortcut that summons the pet, e.g. "Control+Shift+Space". */
  hotkey: string;
  approvalMode: ApprovalMode;
  reasoningEffort: ReasoningEffort;
  /** 'pet' = isolated profile; 'system' = one of your real Chrome profiles. */
  chromeMode: 'pet' | 'system';
  /** Chrome profile directory name, e.g. "Profile 4". Only used in system mode. */
  chromeProfileDir: string;
  /** Where screen captures are written. Empty means Pictures/AdiPet. */
  screenshotDir: string;
  /** Optional project folder whose bounded metadata is included in new chats. */
  workspaceRoot: string;
  /** Explicitly permits bounded workspace metadata to be sent in new model prompts. */
  workspaceContextEnabled: boolean;
  /** Explicitly permits bounded filename and text matches from the selected workspace in local search. */
  workspaceFileSearchEnabled: boolean;
  /** Explicitly permits bounded, query-selected active goals in new model prompts. */
  goalContextEnabled: boolean;
  /** Explicitly permits bounded, query-selected saved lessons in new model prompts. */
  learningMemoryEnabled: boolean;
  /** JSON array of model ids the user added by hand. */
  customModels: string;
  /** Fraction of the context window at which compaction fires. */
  compactionThreshold: number;
  contextWindow: number;
  petScale: number;
  launchOnStartup: boolean;
  /** Last position the pet was dragged to; null means "default corner". */
  petX: number | null;
  petY: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  model: 'gpt-5.6-terra',
  provider: 'chatgpt',
  customBaseUrl: '',
  providerModels: '{}',
  voiceModel: 'gpt-realtime-2',
  voiceName: 'marin',
  micDeviceId: '',
  speakReplies: false,
  privacyMode: false,
  hotkey: 'Control+Shift+Space',
  approvalMode: 'ask',
  reasoningEffort: 'medium',
  chromeMode: 'pet',
  chromeProfileDir: 'Default',
  screenshotDir: '',
  workspaceRoot: '',
  workspaceContextEnabled: false,
  workspaceFileSearchEnabled: false,
  goalContextEnabled: false,
  learningMemoryEnabled: false,
  customModels: '[]',
  compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  petScale: 1,
  launchOnStartup: false,
  petX: null,
  petY: null,
};


/* ------------------------------------------------------------------- MCP */

export interface McpToolSummary {
  name: string;
  qualifiedName: string;
  description: string;
  disabled: boolean;
  permission: 'confirm-every-time' | 'disabled';
}

/** One configured MCP server and whether it is actually up. */
export interface McpServerStatus {
  name: string;
  /** 'stdio' servers are a local process; 'http' servers are a URL. */
  transport: 'stdio' | 'http';
  /** Command line or URL, for display. */
  target: string;
  connected: boolean;
  disabled: boolean;
  toolCount: number;
  resourceCount: number;
  disabledToolCount?: number;
  tools?: McpToolSummary[];
  error?: string;
  toolError?: string;
}
