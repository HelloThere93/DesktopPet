import { contextBridge, ipcRenderer } from 'electron';
import {
  assertValidIpcResult,
  isAssignmentSummaryList,
  isAttachmentList,
  isAuthProbeResult,
  isAuthStatus,
  isBooleanResponse,
  isChatHistoryResult,
  isChromeProfileList,
  isClipboardText,
  isConversationFolderList,
  isConversationFolderResult,
  isConversationReferenceListFor,
  isConversationSummaryList,
  isToolStudioDefinitionOrNull,
  isToolStudioSummaryList,
  isToolStudioCandidateList,
  isToolStudioTestResult,
  isConfigPath,
  isDiagnosticsSnapshot,
  isGoalCheckin,
  isGoalList,
  isHotkeyResult,
  isJobUpdateList,
  isLessonListView,
  isLocalSearchResultList,
  isMcpServerStatusList,
  isModelOptionList,
  isModelProbeList,
  isPermissionGrantList,
  isProjectSummaryList,
  isProviderKeyStatus,
  isProviderViewList,
  isQuickWindowMode,
  isRealtimeProbeList,
  isSettings,
  isUndefinedResponse,
  isVoiceModelList,
  isWorkspacePickRootResult,
  isWindowPosition,
  isMutationUpdateList,
  isPermissionRequest,
  isPetLook,
  isPetProximity,
  isStreamEvent,
  isVoiceEvent,
} from './ipc-validation';
import type { Goal } from './goals';
import type { JobRecord } from './jobs';
import type { MutationRecord } from './mutation-journal';
import type { DiagnosticsSnapshot } from './diagnostics';
import type { LessonListView } from './lessons';
import type {
  Attachment,
  AuthStatus,
  ChatMessage,
  ConversationKind,
  ConversationReference,
  ConversationFolder,
  ConversationReferenceKind,
  ConversationSummary,
  LocalSearchResult,
  McpServerStatus,
  PermissionDecision,
  PermissionRequest,
  PermissionGrant,
  ProviderId,
  Settings,
  AssignmentSummary,
  ProjectSummary,
  StreamEvent,
  ToolStudioDefinition,
  ToolStudioSummary,
  ToolStudioToolCandidate,
  ToolStudioTestResult,
  VoiceEvent,
} from '../shared/types';

/** What the settings pane may know about an access point. Never the key. */
export interface ProviderView {
  id: ProviderId;
  label: string;
  shape: string;
  needsKey: boolean;
  keyUrl?: string;
  note?: string;
  models: { id: string; label: string; note?: string }[];
  set: boolean;
  hint: string;
}

function invokeValidated<T>(
  channel: string,
  guard: (value: unknown) => value is T,
  ...args: unknown[]
): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((value: unknown) =>
    assertValidIpcResult(value, guard, channel),
  );
}

function conversationReferenceListGuard(conversationId: number) {
  return (value: unknown): value is ConversationReference[] =>
    isConversationReferenceListFor(value, conversationId);
}

/**
 * The renderer gets exactly this surface and nothing else — no Node, no direct
 * IPC. Every OS-touching capability is a named method reviewed on this line.
 */
const api = {
  window: {
    setExpanded: (next: boolean): Promise<boolean> =>
      invokeValidated('window:set-expanded', isBooleanResponse, next),
    setBubble: (next: boolean): Promise<boolean> =>
      invokeValidated('window:set-bubble', isBooleanResponse, next),
    setQuick: (next: 'off' | 'ask' | 'answer'): Promise<string> =>
      invokeValidated('window:set-quick', isQuickWindowMode, next),
    getPosition: (): Promise<[number, number]> =>
      invokeValidated('window:get-position', isWindowPosition),
    moveTo: (x: number, y: number): void => ipcRenderer.send('window:move-to', x, y),
    savePosition: (): Promise<void> => invokeValidated('window:save-position', isUndefinedResponse),
    setDragging: (active: boolean): void => ipcRenderer.send('window:set-dragging', active),
    onLook: (cb: (look: { x: number; y: number }) => void): (() => void) => {
      const handler = (_e: unknown, look: unknown) => {
        if (isPetLook(look)) cb(look);
      };
      ipcRenderer.on('pet:look', handler);
      return () => ipcRenderer.removeListener('pet:look', handler);
    },
    onProximity: (cb: (near: boolean) => void): (() => void) => {
      const handler = (_e: unknown, near: unknown) => {
        if (isPetProximity(near)) cb(near);
      };
      ipcRenderer.on('pet:proximity', handler);
      return () => ipcRenderer.removeListener('pet:proximity', handler);
    },
    quit: (): Promise<void> => invokeValidated('window:quit', isUndefinedResponse),
  },
  auth: {
    status: (): Promise<AuthStatus> => invokeValidated('auth:status', isAuthStatus),
    signIn: (): Promise<AuthStatus> => invokeValidated('auth:sign-in', isAuthStatus),
    signOut: (): Promise<AuthStatus> => invokeValidated('auth:sign-out', isAuthStatus),
    probe: (): Promise<{ ok: boolean; base: string; detail: string }> =>
      invokeValidated('auth:probe', isAuthProbeResult),
    ensure: (): Promise<boolean> => invokeValidated('auth:ensure', isBooleanResponse),
    probeRealtime: (): Promise<{ url: string; kind: string; status: string; detail: string }[]> =>
      invokeValidated('realtime:probe', isRealtimeProbeList),
  },
  chat: {
    history: (): Promise<{ conversationId: number; messages: ChatMessage[] }> =>
      invokeValidated('chat:history', isChatHistoryResult),
    newChat: (): Promise<{ conversationId: number; messages: ChatMessage[] }> =>
      invokeValidated('chat:new', isChatHistoryResult),
    list: (kind?: ConversationKind, archived = false, folderId?: number): Promise<ConversationSummary[]> =>
      invokeValidated('chat:list', isConversationSummaryList, kind, archived, folderId),
    folders: (): Promise<ConversationFolder[]> => invokeValidated('chat:folders:list', isConversationFolderList),
    createFolder: (name: string): Promise<ConversationFolder> =>
      invokeValidated('chat:folders:create', isConversationFolderResult, name),
    renameFolder: (id: number, name: string): Promise<ConversationFolder> =>
      invokeValidated('chat:folders:rename', isConversationFolderResult, id, name),
    removeFolder: (id: number): Promise<ConversationFolder[]> =>
      invokeValidated('chat:folders:delete', isConversationFolderList, id),
    setFolder: (conversationId: number, folderId: number | null): Promise<ConversationSummary[]> =>
      invokeValidated('chat:folder:set', isConversationSummaryList, conversationId, folderId),
    star: (id: number, starred: boolean): Promise<ConversationSummary[]> =>
      invokeValidated('chat:star', isConversationSummaryList, id, starred),
    archive: (id: number, archived: boolean): Promise<ConversationSummary[]> =>
      invokeValidated('chat:archive', isConversationSummaryList, id, archived),
    references: (conversationId: number): Promise<ConversationReference[]> =>
      invokeValidated('chat:references:list', conversationReferenceListGuard(conversationId), conversationId),
    addReference: (
      conversationId: number,
      kind: ConversationReferenceKind,
      target: string,
    ): Promise<ConversationReference[]> =>
      invokeValidated(
        'chat:references:add',
        conversationReferenceListGuard(conversationId),
        conversationId,
        kind,
        target,
      ),
    removeReference: (conversationId: number, referenceId: number): Promise<ConversationReference[]> =>
      invokeValidated(
        'chat:references:remove',
        conversationReferenceListGuard(conversationId),
        conversationId,
        referenceId,
      ),
    open: (id: number): Promise<{ conversationId: number; messages: ChatMessage[] }> =>
      invokeValidated('chat:open', isChatHistoryResult, id),
    branch: (id: number, title?: string): Promise<{ conversationId: number; messages: ChatMessage[] }> =>
      invokeValidated('chat:branch', isChatHistoryResult, id, title),
    rename: (id: number, title: string): Promise<ConversationSummary[]> =>
      invokeValidated('chat:rename', isConversationSummaryList, id, title),
    remove: (id: number): Promise<ConversationSummary[]> =>
      invokeValidated('chat:delete', isConversationSummaryList, id),
    send: (conversationId: number, text: string, attachments: Attachment[] = []): Promise<void> =>
      invokeValidated('chat:send', isUndefinedResponse, conversationId, text, attachments),
    cancel: (): Promise<void> => invokeValidated('chat:cancel', isUndefinedResponse),
    quick: (text: string, attachments: Attachment[] = []): Promise<void> =>
      invokeValidated('chat:quick', isUndefinedResponse, text, attachments),
    onStream: (cb: (e: StreamEvent) => void): (() => void) => {
      const handler = (_e: unknown, payload: unknown) => {
        if (isStreamEvent(payload)) cb(payload);
      };
      ipcRenderer.on('stream', handler);
      return () => ipcRenderer.removeListener('stream', handler);
    },
  },
  permission: {
    onRequest: (cb: (req: PermissionRequest) => void): (() => void) => {
      const handler = (_e: unknown, payload: unknown) => {
        if (isPermissionRequest(payload)) cb(payload);
      };
      ipcRenderer.on('permission:request', handler);
      return () => ipcRenderer.removeListener('permission:request', handler);
    },
    respond: (id: string, decision: PermissionDecision): Promise<void> =>
      invokeValidated('permission:respond', isUndefinedResponse, id, decision),
  },
  permissions: {
    list: (): Promise<PermissionGrant[]> => invokeValidated('permissions:list', isPermissionGrantList),
    remove: (signature: string): Promise<PermissionGrant[]> =>
      invokeValidated('permissions:remove', isPermissionGrantList, signature),
  },
  models: {
    list: (): Promise<{ id: string; label: string; note?: string }[]> =>
      invokeValidated('models:list', isModelOptionList),
    probe: (): Promise<{ id: string; ok: boolean; detail: string }[]> =>
      invokeValidated('models:probe', isModelProbeList),
    add: (id: string): Promise<{ id: string; label: string; note?: string }[]> =>
      invokeValidated('models:add', isModelOptionList, id),
  },
  voice: {
    startDictation: (): Promise<boolean> => invokeValidated('voice:dictate-start', isBooleanResponse),
    stopDictation: (): Promise<boolean> => invokeValidated('voice:dictate-stop', isBooleanResponse),
    push: (base64: string): void => ipcRenderer.send('voice:audio', base64),
    speak: (text: string): Promise<void> => invokeValidated('voice:speak', isUndefinedResponse, text),
    stopSpeaking: (): void => ipcRenderer.send('voice:stop-speaking'),
    close: (): Promise<boolean> => invokeValidated('voice:close', isBooleanResponse),
    prewarm: (): Promise<boolean> => invokeValidated('voice:prewarm', isBooleanResponse),
    models: (): Promise<string[]> => invokeValidated('voice:models', isVoiceModelList),
    onEvent: (cb: (e: VoiceEvent) => void): (() => void) => {
      const handler = (_e: unknown, payload: unknown) => {
        if (isVoiceEvent(payload)) cb(payload);
      };
      ipcRenderer.on('voice', handler);
      return () => ipcRenderer.removeListener('voice', handler);
    },
  },
  hotkey: {
    set: (accelerator: string): Promise<{ ok: boolean; message: string }> =>
      invokeValidated('hotkey:set', isHotkeyResult, accelerator),
    onPressed: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('hotkey', handler);
      return () => ipcRenderer.removeListener('hotkey', handler);
    },
  },
  clipboard: {
    readText: (): Promise<string> => invokeValidated('clipboard:read-text', isClipboardText),
  },
  files: {
    pick: (): Promise<Attachment[]> => invokeValidated('files:pick', isAttachmentList),
    read: (paths: string[]): Promise<Attachment[]> => invokeValidated('files:read', isAttachmentList, paths),
  },
  workspace: {
    pickRoot: (): Promise<{ canceled: boolean; root?: string; error?: string }> =>
      invokeValidated('workspace:pick-root', isWorkspacePickRootResult),
    search: (query: string): Promise<LocalSearchResult[]> =>
      invokeValidated('workspace:search', isLocalSearchResultList, query),
  },
  screen: {
    capture: (): Promise<Attachment[]> => invokeValidated('screen:capture', isAttachmentList),
  },
  providers: {
    list: (): Promise<ProviderView[]> => invokeValidated('providers:list', isProviderViewList),
    setKey: (id: ProviderId, key: string): Promise<{ set: boolean; hint: string }> =>
      invokeValidated('providers:set-key', isProviderKeyStatus, id, key),
    clearKey: (id: ProviderId): Promise<{ set: boolean; hint: string }> =>
      invokeValidated('providers:clear-key', isProviderKeyStatus, id),
  },
  goals: {
    list: (): Promise<Goal[]> => invokeValidated('goals:list', isGoalList),
    finish: (id: string, dropped: boolean): Promise<Goal[]> =>
      invokeValidated('goals:finish', isGoalList, id, dropped),
    stopWatch: (id: string): Promise<Goal[]> =>
      invokeValidated('goals:stop-watch', isGoalList, id),
    checkNow: (id: string): Promise<boolean> =>
      invokeValidated('goals:check-now', isBooleanResponse, id),
    onCheckin: (cb: (g: { id: string; title: string; operationId: string }) => void): (() => void) => {
      const handler = (_e: unknown, payload: unknown) => {
        if (isGoalCheckin(payload)) cb(payload);
      };
      ipcRenderer.on('goal:checkin', handler);
      return () => ipcRenderer.removeListener('goal:checkin', handler);
    },
  },
  jobs: {
    list: (): Promise<JobRecord[]> => invokeValidated('jobs:list', isJobUpdateList),
    cancel: (id: string): Promise<JobRecord[]> => invokeValidated('jobs:cancel', isJobUpdateList, id),
    onUpdate: (cb: (jobs: JobRecord[]) => void): (() => void) => {
      const handler = (_e: unknown, payload: unknown) => {
        if (isJobUpdateList(payload)) cb(payload);
      };
      ipcRenderer.on('jobs:updated', handler);
      return () => ipcRenderer.removeListener('jobs:updated', handler);
    },
  },
  mutations: {
    list: (): Promise<MutationRecord[]> => invokeValidated('mutations:list', isMutationUpdateList),
    undo: (id: string): Promise<MutationRecord[]> => invokeValidated('mutations:undo', isMutationUpdateList, id),
    onUpdate: (cb: (records: MutationRecord[]) => void): (() => void) => {
      const handler = (_e: unknown, payload: unknown) => {
        if (isMutationUpdateList(payload)) cb(payload);
      };
      ipcRenderer.on('mutations:updated', handler);
      return () => ipcRenderer.removeListener('mutations:updated', handler);
    },
  },

  projects: {
    list: (): Promise<ProjectSummary[]> => invokeValidated('projects:list', isProjectSummaryList),
  },
  assignments: {
    list: (): Promise<AssignmentSummary[]> => invokeValidated('assignments:list', isAssignmentSummaryList),
  },
  memory: {
    list: (): Promise<LessonListView> => invokeValidated('memory:list', isLessonListView),
    edit: (index: number, lesson: string): Promise<LessonListView> =>
      invokeValidated('memory:edit', isLessonListView, index, lesson),
    remove: (index: number): Promise<LessonListView> =>
      invokeValidated('memory:remove', isLessonListView, index),
  },
  diagnostics: {
    run: (): Promise<DiagnosticsSnapshot> =>
      invokeValidated('diagnostics:run', isDiagnosticsSnapshot),
  },
  tools: {
    list: (): Promise<ToolStudioSummary[]> => invokeValidated('tools:list', isToolStudioSummaryList),
    candidates: (): Promise<ToolStudioToolCandidate[]> => invokeValidated('tools:candidates', isToolStudioCandidateList),
    get: (name: string): Promise<ToolStudioDefinition | null> =>
      invokeValidated('tools:get', isToolStudioDefinitionOrNull, name),
    save: (definition: ToolStudioDefinition, existingName?: string): Promise<ToolStudioSummary[]> =>
      invokeValidated('tools:save', isToolStudioSummaryList, definition, existingName),
    delete: (name: string): Promise<ToolStudioSummary[]> =>
      invokeValidated('tools:delete', isToolStudioSummaryList, name),
    test: (name: string, args: Record<string, unknown>): Promise<ToolStudioTestResult> =>
      invokeValidated('tools:test', isToolStudioTestResult, name, args),
    onUpdate: (cb: (tools: ToolStudioSummary[]) => void): (() => void) => {
      const handler = (_e: unknown, payload: unknown) => {
        if (isToolStudioSummaryList(payload)) cb(payload);
      };
      ipcRenderer.on('tools:updated', handler);
      return () => ipcRenderer.removeListener('tools:updated', handler);
    },
  },
  mcp: {
    status: (): Promise<McpServerStatus[]> => invokeValidated('mcp:status', isMcpServerStatusList),
    setDisabled: (name: string, disabled: boolean): Promise<McpServerStatus[]> =>
      invokeValidated('mcp:set-disabled', isMcpServerStatusList, name, disabled),
    setToolDisabled: (server: string, tool: string, disabled: boolean): Promise<McpServerStatus[]> =>
      invokeValidated('mcp:set-tool-disabled', isMcpServerStatusList, server, tool, disabled),
    reload: (): Promise<McpServerStatus[]> => invokeValidated('mcp:reload', isMcpServerStatusList),
    openConfig: (): Promise<string> => invokeValidated('mcp:open-config', isConfigPath),
  },
  chrome: {
    profiles: (): Promise<{ dir: string; name: string; email: string }[]> =>
      invokeValidated('chrome:profiles', isChromeProfileList),
  },
  settings: {
    get: (): Promise<Settings> => invokeValidated('settings:get', isSettings),
    set: (key: keyof Settings, value: unknown, expectedWorkspaceRoot?: string): Promise<Settings> =>
      invokeValidated('settings:set', isSettings, key, value, expectedWorkspaceRoot),
  },
};

contextBridge.exposeInMainWorld('adi', api);

export type AdiApi = typeof api;
