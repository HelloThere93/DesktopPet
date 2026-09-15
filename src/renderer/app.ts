import { buildSelectionActionDraft, MAX_SELECTION_ACTION_CHARS, mergeClipboardIntoDraft } from '../shared/clipboard';
import { createLatestTaskQueue, createSerialTaskQueue, createSingleFlightGate } from '../shared/latest-task';
import { APPROVAL_MODES, REASONING_LEVELS, VOICE_NAMES } from '../shared/types';
import { browserRecoveryGuidance } from '../shared/browser-recovery';
import { assistantClipboardText } from '../shared/assistant-format';
import {
  appendSegmentedStreamText,
  isBubbleTurnKind,
  isTerminalStreamEvent,
  mayDismissQuickAnswer,
  mayPetSleep,
  quickEscapeAction,
} from '../shared/stream-lifecycle';
import { renderMarkdown } from './markdown';
import { listMicrophones, SpeechPlayer, startMic, type MicHandle } from './voice';
import type {
  AuthStatus,
  VoiceEvent,
  ChatMessage,
  ConversationReference,
  ConversationReferenceKind,
  LocalSearchResult,
  PermissionDecision,
  PermissionRequest,
  PetMood,
  ProviderId,
  StreamEvent,
  ToolResult,
  TurnKind,
} from '../shared/types';

declare global {
  interface Window {
    adi: import('../main/preload').AdiApi;
  }
}

const adi = window.adi;

type QuickWindowMode = 'off' | 'ask' | 'answer';
const quickWindowWrites = createLatestTaskQueue();

function setQuickWindowMode(mode: QuickWindowMode): Promise<void> {
  return quickWindowWrites.enqueue(async () => {
    await adi.window.setQuick(mode);
  });
}

type BubbleWindowState = boolean;
const bubbleWindowWrites = createLatestTaskQueue();

function setBubbleWindow(open: BubbleWindowState): Promise<void> {
  return bubbleWindowWrites.enqueue(async () => {
    await adi.window.setBubble(open);
  });
}
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const petStage = $('pet-stage');
const pet = $('pet');
const petBadge = $('pet-badge');
const privacyBadge = $('privacy-badge');
const petStatus = $('pet-status');
const petStatusText = $('pet-status-text');
const bubble = $('bubble');
const bubbleReason = $('bubble-reason');
const bubbleCmd = $('bubble-cmd');
const bubbleDetail = $('bubble-detail');
const bubbleTask = $<HTMLButtonElement>('bubble-task');
const bubbleSession = $<HTMLButtonElement>('bubble-session');
const bubbleAlways = $<HTMLButtonElement>('bubble-always');
const chat = $('chat');
const messagesEl = $('messages');
const toolStudioPanel = $('tool-studio');
const studioApproval = $('studio-approval');
const composer = $('composer');
const input = $<HTMLTextAreaElement>('input');
const statusDot = $('status-dot');
const clipboardButton = $<HTMLButtonElement>('btn-clipboard');
const selectionActions = $('selection-actions');
const attachments = $('attachments');
const statusText = $('status-text');
const btnSend = $<HTMLButtonElement>('btn-send');
const btnStop = $<HTMLButtonElement>('btn-stop');
const modelSelect = $<HTMLSelectElement>('model-select');
const effortSelect = $<HTMLSelectElement>('effort-select');
const modeSelect = $<HTMLSelectElement>('mode-select');
const autoPill = $('auto-pill');
const privacyPill = $('privacy-pill');
const permissionList = $('permission-list');
const permissionsNote = $('permissions-note');
const permissionsRefreshButton = $<HTMLButtonElement>('btn-permissions-refresh');
const profileSelect = $<HTMLSelectElement>('profile-select');
const profileRefreshButton = $<HTMLButtonElement>('btn-browser-profiles-refresh');
const browserProfileNote = $('browser-profile-note');
const convoList = $('convo-list');
const workspaceSearch = $<HTMLInputElement>('workspace-search');
const workspaceSearchClear = $<HTMLButtonElement>('workspace-search-clear');
const conversationFolderFilter = $<HTMLSelectElement>('conversation-folder-filter');
const folderNewButton = $<HTMLButtonElement>('btn-folder-new');
const folderRenameButton = $<HTMLButtonElement>('btn-folder-rename');
const folderDeleteButton = $<HTMLButtonElement>('btn-folder-delete');
const searchResults = $('search-results');
const archiveNote = $('archive-note');
const convoTitle = $('convo-title');
const sidebar = $('sidebar');
const settingsPanel = $('settings');
const activityPanel = $('activity');
const activityState = $('activity-state');
const activityList = $('activity-list');
const activityButton = $<HTMLButtonElement>('btn-activity');
const referencesPanel = $('references');
const referencesList = $('conversation-references-list');
const referencesNote = $('conversation-references-note');
const referencesButton = $<HTMLButtonElement>('btn-references');
const branchButton = $<HTMLButtonElement>('btn-branch');
const referencesCloseButton = $<HTMLButtonElement>('btn-references-close');
const activityCloseButton = $<HTMLButtonElement>('btn-activity-close');
const activityCancelButton = $<HTMLButtonElement>('btn-activity-cancel');
const modelBadge = $('model-badge');
const quickBar = $('quick');
const quickInput = $<HTMLInputElement>('quick-input');
const quickStatus = $('quick-status');
const quickOpenButton = $<HTMLButtonElement>('btn-quick-open');
const quickStopButton = $<HTMLButtonElement>('btn-quick-stop');
const quickAnswer = $('quick-answer');
const quickAnswerBody = $('quick-answer-body');
const quickTimer = $('quick-timer');
const quickNote = $('quick-note');
const providerSelect = $<HTMLSelectElement>('provider-select');
const providerNote = $('provider-note');
const keyField = $('key-field');
const keyInput = $<HTMLInputElement>('key-input');
const keyNote = $('key-note');
const baseUrlField = $('baseurl-field');
const baseUrlInput = $<HTMLInputElement>('baseurl-input');
const workspaceRootInput = $<HTMLInputElement>('workspace-root-input');
const workspacePickButton = $<HTMLButtonElement>('btn-workspace-pick');
const workspaceClearButton = $<HTMLButtonElement>('btn-workspace-clear');
const workspaceRootNote = $('workspace-root-note');
const projectList = $('project-list');
const projectsRefreshButton = $<HTMLButtonElement>('btn-projects-refresh');
const assignmentList = $('assignment-list');
const assignmentsRefreshButton = $<HTMLButtonElement>('btn-assignments-refresh');
const lessonList = $('lesson-list');
const lessonsNote = $('lessons-note');
const lessonsRefreshButton = $<HTMLButtonElement>('btn-lessons-refresh');
const workspaceContextEnabled = $<HTMLInputElement>('workspace-context-enabled');
const workspaceFileSearchEnabled = $<HTMLInputElement>('workspace-file-search-enabled');
const goalContextEnabled = $<HTMLInputElement>('goal-context-enabled');
const learningMemoryEnabled = $<HTMLInputElement>('learning-memory-enabled');
const privacyMode = $<HTMLInputElement>('privacy-mode');
const mcpList = $('mcp-list');
const jobsList = $('jobs-list');
const jobsRefreshButton = $<HTMLButtonElement>('btn-jobs-refresh');
const mutationsList = $('mutations-list');
const mutationsRefreshButton = $<HTMLButtonElement>('btn-mutations-refresh');
const diagnosticsSummary = $('diagnostics-summary');
const diagnosticsMetrics = $('diagnostics-metrics');
const diagnosticsList = $('diagnostics-list');
const diagnosticsRunButton = $<HTMLButtonElement>('btn-diagnostics-run');
const voiceBar = $('voice-bar');
const voiceLevel = $('voice-level');
const voiceStatus = $('voice-status');
const micSelect = $<HTMLSelectElement>('mic-select');
const voiceSelect = $<HTMLSelectElement>('voice-select');
const voiceModelSelect = $<HTMLSelectElement>('voice-model-select');
const hotkeySelect = $<HTMLSelectElement>('hotkey-select');
const commandPalette = $('command-palette');
const commandPaletteInput = $<HTMLInputElement>('command-palette-input');
const commandPaletteList = $('command-palette-list');
const textDialog = $('text-dialog');
const textDialogForm = $<HTMLFormElement>('text-dialog-form');
const textDialogTitle = $('text-dialog-title');
const textDialogInput = $<HTMLTextAreaElement>('text-dialog-input');
const textDialogCancel = $<HTMLButtonElement>('text-dialog-cancel');
let studioTestInFlight = false;
interface ToolStudioController {
  load: (force?: boolean) => Promise<void>;
  destroy: () => void;
}
let toolStudioPromise: Promise<ToolStudioController> | null = null;

function ensureToolStudio(): Promise<ToolStudioController> {
  if (toolStudioPromise) return toolStudioPromise;
  const loading = import('./tool-studio').then(({ createToolStudio }) => createToolStudio({
    root: $('tool-studio-mount'),
    onNotice: (text) => addNotice(text),
    onError: (text) => addErrorEl(text),
    onTestState: (running) => {
      studioTestInFlight = running;
    },
  }));
  toolStudioPromise = loading.catch((error) => {
    toolStudioPromise = null;
    throw error;
  });
  return toolStudioPromise;
}

let conversationId = 0;
let expanded = false;
let expandedMutationGeneration = 0;
let streaming = false;
let chatSubmitInFlight = false;
const chatSubmitGate = createSingleFlightGate();
let currentAssistantEl: HTMLElement | null = null;
let streamBuffer = '';
/** Files the user attached to the next message. */
let pendingAttachments: { name: string; kind: 'image' | 'text'; dataUrl?: string; text?: string; source?: 'screen' }[] = [];
const composerAttachmentQueue = createSerialTaskQueue();
let activityOperationId: string | undefined;
let activeStream: { operationId: string; kind: TurnKind } | null = null;
let activityTask = 'Idle';
let activityTool = '';
let referenceLoadGeneration = 0;
let referenceMutationGeneration = 0;
let selectedTranscriptText = '';
let activityApproval = '';
let activityFailure = '';
let activityGoal = '';
let activityCancelling = false;
let activityEvents: string[] = [];
let activityJobs: Awaited<ReturnType<typeof adi.jobs.list>> = [];
let jobsLoadGeneration = 0;
let mutationLoadGeneration = 0;
let conversationLoadGeneration = 0;
let conversationOpenGeneration = 0;
let conversationFolders: Awaited<ReturnType<typeof adi.chat.folders>> = [];
let folderLoadGeneration = 0;
let folderMutationInFlight = false;
let providerLoadGeneration = 0;
let providerMutationGeneration = 0;
let settingsMutationGeneration = 0;
let modelLoadGeneration = 0;
let modelMutationGeneration = 0;
let profileLoadGeneration = 0;
let profileMutationGeneration = 0;
let workspaceMutationGeneration = 0;
let workspaceMutationInFlight = false;
const workspaceScopeWrites = createSerialTaskQueue();
let mcpLoadGeneration = 0;
let searchLoadGeneration = 0;
let activeHotkey = '';
let authLoadGeneration = 0;
let authMutationInFlight = false;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let projectLoadGeneration = 0;
let assignmentLoadGeneration = 0;
let projectNames = new Map<string, string>();
let goalLoadGeneration = 0;
let goalMutationGeneration = 0;
let goalMutationInFlight = false;
let lessonLoadGeneration = 0;
let lessonMutationGeneration = 0;
let permissionLoadGeneration = 0;
let permissionMutationGeneration = 0;
let modeLoadGeneration = 0;
let effortLoadGeneration = 0;
let effortMutationGeneration = 0;
let microphoneLoadGeneration = 0;
let microphoneMutationGeneration = 0;
let voiceSettingsLoadGeneration = 0;
let voiceSettingsMutationGeneration = 0;
let hotkeyLoadGeneration = 0;
let hotkeyMutationGeneration = 0;

/* ------------------------------------------------------------------ mood */

function setMood(mood: PetMood) {
  pet.dataset.mood = mood;
  chat.dataset.mood = mood;
  document.body.dataset.mood = mood;
  renderPetStatus();
}

/**
 * The pet dozes off when left alone.
 *
 * This is not only cosmetic: the window is transparent and always on top, so
 * every animated frame is composited over the desktop. Asleep nothing animates,
 * the compositor goes quiet, and an idle pet stops costing CPU all day.
 */
const SLEEP_AFTER_MS = 20_000;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;

function wake(resetTimer = true) {
  if (pet.dataset.mood === 'sleeping') setMood('idle');
  if (sleepTimer) clearTimeout(sleepTimer);
  if (!resetTimer) return;
  sleepTimer = setTimeout(() => {
    // Never nod off mid-task or with a decision pending.
    if (!mayPetSleep({
      streaming: streaming || chatSubmitInFlight,
      quickActive,
      quickSubmitInFlight,
      streamActive: Boolean(activeStream),
      approvalPending: Boolean(activeRequest),
      chatOpen: !chat.hidden,
    })) return;
    setMood('sleeping');
  }, SLEEP_AFTER_MS);
}


/* ==========================================================================
   Idle life
   ==========================================================================

   What makes a desktop pet feel alive is not constant motion — that reads as a
   loading spinner, and on a transparent always-on-top window it costs real CPU.
   It is reacting: looking at the cursor, blinking irregularly, occasionally
   doing something unprompted. All of these are brief and then stop.
   ========================================================================== */

/** Eyes drift toward the cursor while it is nearby. */
adi.window.onLook(({ x, y }) => {
  if (pet.dataset.mood === 'sleeping') return;
  // A couple of pixels is plenty at this size; more looks cross-eyed.
  pet.style.setProperty('--look-x', `${(x * 2.4).toFixed(2)}px`);
  pet.style.setProperty('--look-y', `${(y * 1.8).toFixed(2)}px`);
});

/**
 * Blinks at irregular intervals, sometimes twice.
 *
 * A fixed CSS interval is the giveaway that something is a loop rather than a
 * creature — the eye lands on the rhythm within a few seconds. Scheduling each
 * blink separately costs one timer and removes the tell.
 */
function scheduleBlink() {
  const delay = 2200 + Math.random() * 5200;
  setTimeout(() => {
    if (pet.dataset.mood !== 'sleeping') {
      blinkOnce();
      // Occasionally a double blink, which is what real eyes do.
      if (Math.random() < 0.22) setTimeout(blinkOnce, 260);
    }
    scheduleBlink();
  }, delay);
}

function blinkOnce() {
  pet.classList.add('blinking');
  setTimeout(() => pet.classList.remove('blinking'), 130);
}

/** Every so often, an unprompted stretch. Never while busy. */
function scheduleStretch() {
  const delay = 18_000 + Math.random() * 32_000;
  setTimeout(() => {
    const idle = pet.dataset.mood === 'idle' && !streaming && !activeRequest && chat.hidden;
    if (idle) {
      pet.classList.add('stretching');
      setTimeout(() => pet.classList.remove('stretching'), 1200);
    }
    scheduleStretch();
  }, delay);
}

scheduleBlink();
scheduleStretch();

/* ------------------------------------------- click-through in pet mode */

/*
 * Click-through is decided in the main process, which polls the real cursor
 * position — see startCursorTracking() in main/index.ts. The renderer only
 * reports when a drag is in progress, so tracking can hold the window live.
 */

/* --------------------------------------------------- pet click vs. drag */

interface DragState {
  startX: number;
  startY: number;
  winX: number;
  winY: number;
  moved: number;
  startedAt: number;
  pointerId: number;
}

let drag: DragState | null = null;

/** Past this many pixels the gesture is a drag, not a click. */
const DRAG_THRESHOLD = 4;

pet.addEventListener('pointerdown', (e) => {
  if (expanded || e.button !== 0) return;
  // Must stay synchronous. Awaiting the window position here would let a quick
  // pointerup land before `drag` exists — the click would be dropped, and the
  // leftover state would then drag the window on the next stray pointermove.
  // window.screenX/screenY give the same value with no IPC round-trip.
  pet.setPointerCapture(e.pointerId);
  pet.classList.add('grabbed');
  adi.window.setDragging(true);
  drag = {
    startX: e.screenX,
    startY: e.screenY,
    winX: window.screenX,
    winY: window.screenY,
    moved: 0,
    startedAt: Date.now(),
    pointerId: e.pointerId,
  };
});

pet.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.screenX - drag.startX;
  const dy = e.screenY - drag.startY;
  drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
  if (drag.moved > DRAG_THRESHOLD) {
    adi.window.moveTo(drag.winX + dx, drag.winY + dy);
  }
});

function endDrag(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const wasClick = drag.moved <= DRAG_THRESHOLD && Date.now() - drag.startedAt < 600;
  if (pet.hasPointerCapture(drag.pointerId)) pet.releasePointerCapture(drag.pointerId);
  const wasDragged = drag.moved > DRAG_THRESHOLD;
  drag = null;
  adi.window.setDragging(false);

  pet.classList.remove('grabbed');
  if (wasDragged) {
    // Land with a wobble, as something soft would.
    pet.classList.add('dropped');
    setTimeout(() => pet.classList.remove('dropped'), 460);
  }
  if (wasClick) fireAndReport(toggleExpanded(true), 'Could not open chat: ');
  else fireAndReport(adi.window.savePosition(), 'Could not save pet position: ');
}

pet.addEventListener('pointerup', endDrag);
pet.addEventListener('pointercancel', endDrag);

pet.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  fireAndReport(toggleExpanded(true), 'Could not open chat: ');
});

async function toggleExpanded(next: boolean) {
  // Quick and goal streams only have a bubble renderer. Hiding that stage
  // mid-turn would let the operation finish successfully with no visible answer.
  if (next && (quickActive || isBubbleTurnKind(activeStream?.kind))) {
    quickAnswer.hidden = false;
    await setQuickWindowMode('answer');
    return;
  }
  const generation = ++expandedMutationGeneration;
  const actual = await adi.window.setExpanded(next);
  if (generation !== expandedMutationGeneration) return;
  expanded = actual;
  pet.setAttribute('aria-label', expanded ? 'Close chat' : 'Open chat');
  petStage.hidden = expanded;
  chat.hidden = !expanded;
  // A pending confirmation must move with the user, or it becomes unreachable.
  if (activeRequest) renderPermission();
  if (expanded) {
    quickBar.hidden = true;
    quickAnswer.hidden = true;
    fireAndReport(setQuickWindowMode('off'), 'Could not hide quick bar: ');
    fireAndReport(refreshModeIndicator(), 'Could not refresh approval mode: ');
    input.focus();
    scrollToBottom();
  }
}

$('btn-collapse').addEventListener('click', () => fireAndReport(toggleExpanded(false), 'Could not close chat: '));

/* --------------------------------------------------------- command palette */

interface PaletteCommand {
  id: string;
  label: string;
  detail: string;
  keywords: string;
  run: () => void | Promise<void>;
}

let paletteActiveIndex = 0;
let paletteOpening: Promise<void> | null = null;
const paletteCommandGate = createSingleFlightGate();

function setChatDraft(text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input'));
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

async function openChatWithDraft(text = ''): Promise<void> {
  await toggleExpanded(true);
  if (sidebarTab === 'studio') {
    sidebarTab = 'chat';
    await loadConversations();
  }
  if (text) setChatDraft(text);
  else input.focus();
}

const paletteCommands: PaletteCommand[] = [
  {
    id: 'ask',
    label: 'Ask AI',
    detail: 'Open a full conversation',
    keywords: 'ask chat question conversation',
    run: () => openChatWithDraft(),
  },
  {
    id: 'screenshot',
    label: 'Screenshot',
    detail: 'Attach the current screen to your next message',
    keywords: 'screen capture image picture',
    run: async () => {
      await openChatWithDraft();
      if (!(await captureScreenForComposer())) return;
    },
  },
  {
    id: 'explain-screen',
    label: 'Explain screen',
    detail: 'Attach the current screen with an explanation prompt',
    keywords: 'screen explain look error picture',
    run: async () => {
      await openChatWithDraft();
      if (!(await captureScreenForComposer())) return;
      setChatDraft('Explain what is on this screen.');
    },
  },
  {
    id: 'summarise',
    label: 'Summarise',
    detail: 'Draft a summary of this conversation',
    keywords: 'summarize summarise conversation notes',
    run: () => openChatWithDraft('Summarise this conversation so far.'),
  },
  {
    id: 'search-computer',
    label: 'Search computer',
    detail: 'Ask Adi to find something on the computer',
    keywords: 'search find computer files folders',
    run: () => openChatWithDraft('Search my computer for '),
  },
  {
    id: 'open-app',
    label: 'Open app',
    detail: 'Draft a request to open an application',
    keywords: 'launch start program application',
    run: () => openChatWithDraft('Open the app '),
  },
  {
    id: 'run-workflow',
    label: 'Run workflow',
    detail: 'Draft a request to run a saved workflow',
    keywords: 'workflow automation saved process',
    run: () => openChatWithDraft('Run the workflow '),
  },
  {
    id: 'create-reminder',
    label: 'Create reminder',
    detail: 'Draft a reminder with its timing',
    keywords: 'reminder alarm later notification',
    run: () => openChatWithDraft('Create a reminder: '),
  },
  {
    id: 'ask-file',
    label: 'Ask about file',
    detail: 'Choose a file and ask a question about it',
    keywords: 'file attach document pdf image question',
    run: async () => {
      await openChatWithDraft();
      if (await attachFilesToComposer()) setChatDraft('Tell me about the attached file: ');
    },
  },
  {
    id: 'study',
    label: 'Start study mode',
    detail: 'Draft a focused study request',
    keywords: 'study learn revision quiz flashcards school',
    run: () => openChatWithDraft('Start study mode for '),
  },
  {
    id: 'diagnostics',
    label: 'Diagnose computer',
    detail: 'Run the local diagnostics checks',
    keywords: 'diagnose diagnostics health check problems',
    run: async () => {
      await openChatWithDraft();
      settingsPanel.hidden = false;
      activityPanel.hidden = true;
      await runDiagnostics();
    },
  },
  {
    id: 'goals',
    label: 'View goals',
    detail: 'Open the goals panel',
    keywords: 'goals progress projects focus',
    run: async () => {
      await openChatWithDraft();
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      searchLoadGeneration += 1;
      workspaceSearch.value = '';
      workspaceSearchClear.hidden = true;
      sidebarTab = 'goals';
      await loadConversations();
    },
  },  {
    id: 'tool-studio',
    label: 'Tool Studio',
    detail: 'Build, preview, and test repeatable tools',
    keywords: 'tools builder studio script api workflow automation',
    run: async () => {
      await toggleExpanded(true);
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      searchLoadGeneration += 1;
      workspaceSearch.value = '';
      workspaceSearchClear.hidden = true;
      sidebarTab = 'studio';
      await loadConversations();
    },
  },
];

function filteredPaletteCommands(): PaletteCommand[] {
  const query = commandPaletteInput.value.trim().toLowerCase();
  if (!query) return paletteCommands;
  return paletteCommands.filter((command) =>
    (command.label + ' ' + command.detail + ' ' + command.keywords).toLowerCase().includes(query),
  );
}

function renderCommandPalette(): void {
  const matches = filteredPaletteCommands();
  paletteActiveIndex = Math.max(0, Math.min(paletteActiveIndex, matches.length - 1));
  commandPaletteList.innerHTML = '';

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'command-palette-empty';
    empty.textContent = 'No matching command.';
    commandPaletteList.appendChild(empty);
    commandPaletteInput.removeAttribute('aria-activedescendant');
    return;
  }

  matches.forEach((command, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'command-option' + (index === paletteActiveIndex ? ' active' : '');
    button.id = 'command-option-' + command.id;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === paletteActiveIndex));

    const copy = document.createElement('span');
    copy.className = 'command-option-copy';
    const title = document.createElement('span');
    title.className = 'command-option-title';
    title.textContent = command.label;
    const detail = document.createElement('span');
    detail.className = 'command-option-detail';
    detail.textContent = command.detail;
    copy.append(title, detail);

    const arrow = document.createElement('span');
    arrow.className = 'command-option-arrow';
    arrow.textContent = '↵';
    button.append(copy, arrow);
    button.addEventListener('mouseenter', () => {
      paletteActiveIndex = index;
      renderCommandPalette();
    });
    button.addEventListener('click', () => fireAndReport(runPaletteCommand(command), 'Could not run command: '));
    commandPaletteList.appendChild(button);
  });

  const activeMatch = matches[paletteActiveIndex];
  if (activeMatch) commandPaletteInput.setAttribute('aria-activedescendant', 'command-option-' + activeMatch.id);
}

function hideCommandPalette(): void {
  if (commandPalette.hidden) return;
  commandPalette.hidden = true;
  paletteActiveIndex = 0;
  input.focus();
}

async function showCommandPalette(): Promise<void> {
  if (!commandPalette.hidden) {
    commandPaletteInput.focus();
    return;
  }
  if (paletteOpening) return paletteOpening;

  const opening = (async () => {
    if (chat.hidden) await toggleExpanded(true);
    commandPalette.hidden = false;
    paletteActiveIndex = 0;
    commandPaletteInput.value = '';
    renderCommandPalette();
    commandPaletteInput.focus();
  })();
  paletteOpening = opening;
  try {
    await opening;
  } finally {
    if (paletteOpening === opening) paletteOpening = null;
  }
}

async function runPaletteCommand(command: PaletteCommand): Promise<void> {
  if (!paletteCommandGate.tryEnter()) return;
  hideCommandPalette();
  try {
    await command.run();
  } catch (error) {
    reportAsyncError('Could not run command: ', error);
  } finally {
    paletteCommandGate.leave();
  }
}
commandPaletteInput.addEventListener('input', () => {
  paletteActiveIndex = 0;
  renderCommandPalette();
});

commandPaletteInput.addEventListener('keydown', (event) => {
  const matches = filteredPaletteCommands();
  if (event.key === 'Escape') {
    event.preventDefault();
    hideCommandPalette();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!matches.length) return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    paletteActiveIndex = (paletteActiveIndex + direction + matches.length) % matches.length;
    renderCommandPalette();
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    if (!matches.length) return;
    event.preventDefault();
    paletteActiveIndex = event.key === 'Home' ? 0 : matches.length - 1;
    renderCommandPalette();
    return;
  }
  if (event.key === 'Enter') {
    const command = matches[paletteActiveIndex];
    if (!command) return;
    event.preventDefault();
    fireAndReport(runPaletteCommand(command), 'Could not run command: ');
  }
});

commandPalette.addEventListener('click', (event) => {
  if (event.target === commandPalette) hideCommandPalette();
});

type TextDialogResolver = (value: string | null) => void;
let textDialogResolve: TextDialogResolver | null = null;
let textDialogPreviousFocus: HTMLElement | null = null;

function settleTextDialog(value: string | null): void {
  const resolve = textDialogResolve;
  if (!resolve) return;
  textDialogResolve = null;
  textDialog.hidden = true;
  const previous = textDialogPreviousFocus;
  textDialogPreviousFocus = null;
  if (previous?.isConnected) previous.focus();
  else input.focus();
  resolve(value);
}

function requestText(message: string, initialValue = ''): Promise<string | null> {
  if (textDialogResolve) settleTextDialog(null);
  if (!commandPalette.hidden) hideCommandPalette();
  textDialogPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textDialogTitle.textContent = message;
  textDialogInput.value = initialValue;
  textDialog.hidden = false;
  queueMicrotask(() => {
    textDialogInput.focus();
    textDialogInput.select();
  });
  return new Promise((resolve) => {
    textDialogResolve = resolve;
  });
}

textDialogForm.addEventListener('submit', (event) => {
  event.preventDefault();
  settleTextDialog(textDialogInput.value);
});
textDialogCancel.addEventListener('click', () => settleTextDialog(null));
textDialog.addEventListener('click', (event) => {
  if (event.target === textDialog) settleTextDialog(null);
});
textDialogInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    settleTextDialog(null);
  } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    textDialogForm.requestSubmit();
  }
});
// Ctrl+Space works while the app is focused even when no global shortcut is set.
document.addEventListener('keydown', (event) => {
  if (
    event.repeat ||
    event.code !== 'Space' ||
    !event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.metaKey ||
    (!commandPalette.hidden || !textDialog.hidden)
  ) {
    return;
  }
  event.preventDefault();
  fireAndReport(showCommandPalette(), 'Could not open command palette: ');
});

/* ------------------------------------------------------------ rendering */

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}


const assistantSources = new WeakMap<HTMLElement, string>();
const assistantCopyButtons = new WeakMap<HTMLElement, HTMLButtonElement>();

async function writeRendererClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', 'true');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand('copy');
  fallback.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

function updateAssistantSource(el: HTMLElement, text: string): void {
  assistantSources.set(el, text);
  const button = assistantCopyButtons.get(el);
  if (button) button.disabled = !text.trim();
}

async function copyAssistantMessage(el: HTMLElement, button: HTMLButtonElement): Promise<void> {
  const clean = assistantClipboardText(assistantSources.get(el) ?? '');
  if (!clean) return;
  const label = button.dataset.label ?? 'Copy clean';
  button.disabled = true;
  try {
    await writeRendererClipboard(clean);
    button.textContent = 'Copied';
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = label;
      button.disabled = false;
    }, 1_200);
  } catch (error) {
    button.textContent = label;
    button.disabled = false;
    addErrorEl('Could not copy answer: ' + errorMessage(error));
  }
}

async function copyToolOutput(text: string, button: HTMLButtonElement): Promise<void> {
  const clean = assistantClipboardText(text);
  if (!clean) return;
  const label = button.dataset.label ?? 'Copy output';
  button.disabled = true;
  try {
    await writeRendererClipboard(clean);
    button.textContent = 'Copied';
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = label;
      button.disabled = false;
    }, 1_200);
  } catch (error) {
    button.textContent = label;
    button.disabled = false;
    addErrorEl('Could not copy tool output: ' + errorMessage(error));
  }
}

function addMessageEl(
  role: string,
  text: string,
  opts: { summary?: boolean; inactive?: boolean; imageDataUrl?: string; scroll?: boolean } = {},
) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (opts.summary) el.classList.add('summary');
  if (opts.inactive) el.classList.add('inactive');

  const body = document.createElement('div');
  body.className = 'msg-body';
  // Assistant text is markdown; user text is shown verbatim so their own
  // asterisks and backticks are not silently reinterpreted.
  if (role === 'assistant') renderMarkdown(body, text);
  else body.textContent = text;
  el.appendChild(body);

  if (role === 'assistant' && !opts.summary && !opts.imageDataUrl) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'msg-action';
    copyButton.dataset.label = 'Copy clean';
    copyButton.textContent = 'Copy clean';
    copyButton.disabled = !text.trim();
    copyButton.setAttribute('aria-label', 'Copy clean answer to clipboard');
    copyButton.addEventListener('click', () => void copyAssistantMessage(el, copyButton));
    assistantCopyButtons.set(el, copyButton);
    assistantSources.set(el, text);
    actions.appendChild(copyButton);
    el.appendChild(actions);
  }

  if (opts.imageDataUrl) {
    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = opts.imageDataUrl;
    img.alt = role === 'user' ? 'Attached image' : 'Assistant-provided image';
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', 'Expand image');
    const toggleImage = () => {
      const expandedImage = img.classList.toggle('expanded');
      img.setAttribute('aria-label', expandedImage ? 'Collapse image' : 'Expand image');
    };
    img.addEventListener('click', toggleImage);
    img.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleImage();
    });
    el.appendChild(img);
  }

  messagesEl.appendChild(el);
  if (opts.scroll !== false) scrollToBottom();
  return el;
}

/** Streaming rewrites the markdown as text arrives, so partial syntax settles. */
function setStreamingText(el: HTMLElement, text: string) {
  const body = (el.querySelector('.msg-body') as HTMLElement) ?? el;
  renderMarkdown(body, text);
  updateAssistantSource(el, text);
}

interface PendingStreamRender {
  target: HTMLElement;
  text: string;
  assistantMessage: boolean;
  scroll: boolean;
}

let pendingStreamRender: PendingStreamRender | null = null;
let streamRenderFrame: number | null = null;

function applyPendingStreamRender(pending: PendingStreamRender): void {
  try {
    if (pending.assistantMessage) setStreamingText(pending.target, pending.text);
    else renderMarkdown(pending.target, pending.text);
  } catch (error) {
    const fallback = pending.assistantMessage
      ? ((pending.target.querySelector('.msg-body') as HTMLElement | null) ?? pending.target)
      : pending.target;
    fallback.textContent = pending.text;
    if (pending.assistantMessage) updateAssistantSource(pending.target, pending.text);
    console.error('Streaming Markdown render failed; showing plain text.', error);
  }
  if (pending.scroll) scrollToBottom();
}

function flushPendingStreamRender(): void {
  if (streamRenderFrame !== null) {
    cancelAnimationFrame(streamRenderFrame);
    streamRenderFrame = null;
  }
  const pending = pendingStreamRender;
  pendingStreamRender = null;
  if (pending) applyPendingStreamRender(pending);
}

function discardPendingStreamRender(): void {
  if (streamRenderFrame !== null) cancelAnimationFrame(streamRenderFrame);
  streamRenderFrame = null;
  pendingStreamRender = null;
}

function scheduleStreamRender(pending: PendingStreamRender): void {
  if (pendingStreamRender && pendingStreamRender.target !== pending.target) {
    flushPendingStreamRender();
  }
  pendingStreamRender = pending;
  if (streamRenderFrame !== null) return;
  streamRenderFrame = requestAnimationFrame(() => {
    streamRenderFrame = null;
    const next = pendingStreamRender;
    pendingStreamRender = null;
    if (next) applyPendingStreamRender(next);
  });
}

function addNotice(text: string) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function appendBrowserRecoveryGuidance(parent: HTMLElement, source: unknown): void {
  const guidance = browserRecoveryGuidance(source);
  if (!guidance) return;
  const hint = document.createElement('div');
  hint.className = 'recovery-guidance';
  hint.textContent = guidance;
  parent.appendChild(hint);
}

function addErrorEl(text: string) {
  const el = document.createElement('div');
  el.className = 'msg error';
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', 'assertive');
  el.setAttribute('aria-atomic', 'true');
  el.textContent = text;
  appendBrowserRecoveryGuidance(el, text);
  messagesEl.appendChild(el);
  scrollToBottom();
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return message.trim().slice(0, 500) || 'Unknown error';
}

function reportAsyncError(prefix: string, error: unknown): void {
  addErrorEl(prefix + errorMessage(error));
}

function fireAndReport(operation: Promise<unknown>, prefix: string): void {
  void operation.catch((error) => {
    try {
      reportAsyncError(prefix, error);
    } catch {
      /* The renderer may already be tearing down; never create a second rejection. */
    }
  });
}

type PetStatusState = 'idle' | 'thinking' | 'working' | 'approval' | 'cancelling' | 'paused' | 'error' | 'background';

function readableToolName(name: string): string {
  const plain = name
    .replace(/^mcp__[^_]+__/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return 'Working';
  return (plain[0]?.toUpperCase() ?? '') + plain.slice(1);
}

function renderPetStatus(pendingJobCount = activityJobs.filter((job) =>
  ['queued', 'running', 'waiting', 'waiting-for-user'].includes(job.status),
).length): boolean {
  const turnActive = streaming || quickActive || Boolean(activeStream);
  const dockBusy = turnActive || quickSubmitInFlight || chatSubmitInFlight;
  let state: PetStatusState = 'idle';
  let label = pet.dataset.mood === 'sleeping' ? 'Sleeping' : 'Ready';

  if (pet.dataset.privacy === 'on') {
    state = 'paused';
    label = 'Privacy paused';
  } else if (activeRequest) {
    state = 'approval';
    label = 'Needs approval';
  } else if (activityCancelling) {
    state = 'cancelling';
    label = 'Stopping task';
  } else if (activityTool) {
    state = 'working';
    label = readableToolName(activityTool);
  } else if (pet.dataset.mood === 'error') {
    state = 'error';
    label = 'Needs attention';
  } else if (dockBusy) {
    state = 'thinking';
    label = quickSubmitInFlight && !turnActive
      ? 'Getting ready'
      : activityTask === 'Idle' ? 'Thinking' : activityTask;
  } else if (pendingJobCount > 0) {
    state = 'background';
    label = pendingJobCount + (pendingJobCount === 1 ? ' background job' : ' background jobs');
  }

  petStatus.dataset.state = state;
  quickBar.dataset.state = state;
  petStatusText.textContent = label;
  quickStatus.textContent = label;
  petStatus.title = label;
  quickStopButton.hidden = !turnActive;
  quickStopButton.disabled = activityCancelling;
  quickOpenButton.disabled = dockBusy;
  quickOpenButton.title = dockBusy ? 'Stop or finish the current task before opening chat' : 'Open the full chat';
  quickInput.disabled = pet.dataset.privacy === 'on' || dockBusy;
  return turnActive;
}

function renderActivity() {
  const pendingJobs = activityJobs.filter((job) =>
    ['queued', 'running', 'waiting', 'waiting-for-user'].includes(job.status),
  );
  const task = convoTitle.textContent?.trim() || 'Current conversation';
  activityState.textContent = activityTask + ' · ' + task;
  const turnActive = renderPetStatus(pendingJobs.length);
  activityCancelButton.hidden = !turnActive;
  activityCancelButton.disabled = activityCancelling || !turnActive;
  activityCancelButton.textContent = activityCancelling ? 'Cancelling…' : 'Cancel';

  const lines: string[] = [];
  if (activityOperationId) lines.push('Operation: ' + activityOperationId);
  if (activityGoal) lines.push('Goal: ' + activityGoal);
  if (activityTool) lines.push('Tool: ' + activityTool);
  if (activityApproval) lines.push('Waiting for approval: ' + activityApproval);
  if (activityFailure) lines.push('Latest failure: ' + activityFailure);
  if (pendingJobs.length) {
    lines.push(
      'Background: ' +
        pendingJobs.length +
        ' pending job(s) · ' +
        pendingJobs.map((job) => job.title + ' (' + job.status + ')').join(', '),
    );
  }
  lines.push(...activityEvents.slice(0, 6));

  activityList.innerHTML = '';
  if (!lines.length) {
    const empty = document.createElement('div');
    empty.className = 'activity-row';
    empty.textContent = 'No active work.';
    activityList.appendChild(empty);
    return;
  }
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'activity-row';
    row.textContent = line;
    activityList.appendChild(row);
  }
}

function recordActivity(text: string) {
  activityEvents = [text, ...activityEvents.filter((entry) => entry !== text)].slice(0, 8);
  renderActivity();
}
/** Rejects late events from cancelled turns before they can touch the UI. */
function acceptStreamEvent(evt: StreamEvent): boolean {
  // MCP connection status is a process-level event, not a turn stream.
  if (evt.type === 'mcp' && !evt.operationId) return true;

  if (evt.type === 'started') {
    activeStream = { operationId: evt.operationId, kind: evt.kind };
    // A queued quick/goal turn takes ownership after the previous turn has
    // settled; do not leave the old full-chat controls looking active.
    if (evt.kind !== 'chat') {
      streaming = false;
      btnSend.hidden = false;
      btnStop.hidden = true;
      currentAssistantEl = null;
    }
    if (activeRequest) {
      activeRequest = null;
      renderPermission();
    }
    return true;
  }

  return Boolean(evt.operationId && activeStream?.operationId === evt.operationId);
}

function clearFinishedStream(evt: StreamEvent): void {
  if (isTerminalStreamEvent(evt)) {
    activeStream = null;
    activityCancelling = false;
    activityGoal = '';
    renderActivity();
  }
}


function updateActivityFromStream(evt: StreamEvent) {
  if (evt.operationId) activityOperationId = evt.operationId;

  switch (evt.type) {
    case 'started':
      activityTask = evt.kind === 'goal' ? 'Checking goal' : 'Starting';
      activityTool = '';
      activityApproval = '';
      activityFailure = '';
      activityGoal = '';
      activityCancelling = false;
      recordActivity('Started ' + evt.kind + ' turn');
      return;
    case 'delta':
      if (activityTask === 'Responding') return;
      activityTask = 'Responding';
      renderActivity();
      return;
    case 'tool-start':
      activityTask = 'Running tool';
      activityTool = evt.call.name;
      activityFailure = '';
      recordActivity('Started ' + evt.call.name);
      return;
    case 'tool-end': {
      const tool = activityTool || 'tool';
      activityTool = '';
      if (evt.result.ok) {
        activityTask = 'Tool completed';
        recordActivity('Completed ' + tool);
      } else {
        activityTask = 'Tool failed';
        activityFailure = evt.result.errorCode ?? 'execution-failed';
        recordActivity('Tool failed: ' + activityFailure);
      }
      return;
    }
    case 'compacted':
      activityTask = 'Compacting context';
      recordActivity('Compacted context');
      return;
    case 'notice':
      activityTask = 'Wrapping up';
      recordActivity(evt.message);
      return;
    case 'done':
      activityTask = 'Completed';
      activityTool = '';
      activityApproval = '';
      recordActivity('Completed response');
      return;
    case 'error':
      activityTask = 'Failed';
      activityTool = '';
      activityApproval = '';
      activityFailure = 'request failed';
      recordActivity('Request failed');
      return;
    case 'mcp':
      return;
  }
}

const toolEls = new Map<string, {
  body: HTMLElement;
  status: HTMLElement;
  wrap: HTMLElement;
  actions: HTMLElement;
  copy: HTMLButtonElement;
  output: string;
}>();

function addToolEl(callId: string, name: string, displayArgs?: string) {
  const wrap = document.createElement('div');
  wrap.className = 'tool';

  const head = document.createElement('div');
  head.className = 'tool-head';
  const label = document.createElement('span');
  label.textContent = '▸ ' + name;
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = 'running…';
  head.append(label, status);

  const body = document.createElement('div');
  body.className = 'tool-body';
  body.textContent = displayArgs ?? '(tool arguments unavailable)';
  body.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  actions.hidden = true;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'msg-action tool-copy';
  copy.dataset.label = 'Copy output';
  copy.textContent = 'Copy output';
  copy.setAttribute('aria-label', 'Copy ' + name + ' output to clipboard');
  copy.addEventListener('click', (event) => {
    event.stopPropagation();
    void copyToolOutput(entry.output, copy);
  });
  actions.appendChild(copy);

  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    head.firstElementChild!.textContent = (body.hidden ? '▸' : '▾') + ' ' + name;
  });

  wrap.append(head, body, actions);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  const entry = {
    body,
    status: head.lastElementChild as HTMLElement,
    wrap,
    actions,
    copy,
    output: '',
  };
  toolEls.set(callId, entry);
}

function finishToolEl(callId: string, result: ToolResult) {
  const entry = toolEls.get(callId);
  if (!entry) return;
  entry.status.textContent = result.ok
    ? `done · ${result.durationMs}ms`
    : `failed · ${result.errorCode ?? 'execution-failed'}`;
  entry.status.className = `status ${result.ok ? 'ok' : 'bad'}`;
  entry.output = result.content;
  entry.body.classList.add('tool-result');
  renderMarkdown(entry.body, result.content);
  entry.actions.hidden = !result.content.trim();
  entry.copy.disabled = !result.content.trim();
  appendBrowserRecoveryGuidance(entry.wrap, result.content);
  toolEls.delete(callId);
}

function renderHistory(messages: ChatMessage[]) {
  messagesEl.innerHTML = '';
  for (const m of messages) {
    if (m.isSummary) {
      addMessageEl('assistant', m.content, { summary: true, scroll: false });
      continue;
    }
    if (m.role === 'system') continue;
    if (m.role === 'tool') continue;
    if (m.role === 'assistant' && !m.content.trim() && !m.imageDataUrl) continue;
    addMessageEl(m.role, m.content, { inactive: !m.active, imageDataUrl: m.imageDataUrl, scroll: false });
  }
  scrollToBottom();
}

/* --------------------------------------------------------------- sending */

async function send() {
  const text = input.value.trim();
  if (!text || privacyMode.checked || streaming || !chatSubmitGate.tryEnter()) return;

  chatSubmitInFlight = true;
  const submittedConversationId = conversationId;
  const submittedGeneration = conversationOpenGeneration;
  try {
    if (!submittedConversationId) {
      addNotice('Wait for the conversation to load before sending. Your draft is still here.');
      return;
    }
    // The pill is a safety affordance; confirm it matches reality each turn.
    fireAndReport(refreshModeIndicator(), 'Could not refresh approval mode: ');

    const ok = await adi.auth.ensure();
    if (privacyMode.checked) return;
    if (submittedConversationId !== conversationId || submittedGeneration !== conversationOpenGeneration) {
      addNotice('The conversation changed before sending. Review your draft and send it again.');
      return;
    }
    if (!ok) {
      addErrorEl('Not signed in. Click "Sign in" to connect your ChatGPT account.');
      return;
    }

    input.value = '';
    input.style.height = 'auto';

    const attachments = pendingAttachments;
    pendingAttachments = [];
    renderAttachments();
    addMessageEl('user', text, { imageDataUrl: attachments.find((a) => a.kind === 'image')?.dataUrl });

    wake();
    activityOperationId = undefined;
    activityTask = 'Starting';
    activityTool = '';
    activityApproval = '';
    activityFailure = '';
    activityGoal = '';
    activityCancelling = false;
    activityEvents = [];
    renderActivity();
    streaming = true;
    btnSend.hidden = true;
    btnStop.hidden = false;
    setMood('thinking');
    currentAssistantEl = null;

    try {
      await adi.chat.send(conversationId, text, attachments);
    } catch (error) {
      streaming = false;
      btnSend.hidden = false;
      btnStop.hidden = true;
      currentAssistantEl = null;
      activeRequest = null;
      activeStream = null;
      activityApproval = '';
      activityCancelling = false;
      activityGoal = '';
      renderPermission();
      activityTask = 'Failed';
      activityFailure = 'request failed';
      recordActivity('Request failed');
      const message = error instanceof Error ? error.message : String(error);
      addErrorEl('Chat request failed: ' + message.slice(0, 500));
    }
  } finally {
    chatSubmitInFlight = false;
    chatSubmitGate.leave();
    renderPetStatus();
  }
}
function hideSelectionActions() {
  selectedTranscriptText = '';
  selectionActions.hidden = true;
}

function updateSelectionActions() {
  if (chat.hidden) {
    hideSelectionActions();
    return;
  }
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  const focus = selection?.focusNode;
  if (
    !selection ||
    selection.isCollapsed ||
    !anchor ||
    !focus ||
    !messagesEl.contains(anchor) ||
    !messagesEl.contains(focus)
  ) {
    hideSelectionActions();
    return;
  }
  const selected = selection.toString().trim();
  if (!selected) {
    hideSelectionActions();
    return;
  }
  selectedTranscriptText = selected.slice(0, MAX_SELECTION_ACTION_CHARS);
  selectionActions.hidden = false;
}

function putTextIntoDraft(text: string, notice: string, sourceTruncated = false) {
  const draft = mergeClipboardIntoDraft(input.value, text);
  input.value = draft.text;
  input.dispatchEvent(new Event('input'));
  input.focus();
  addNotice(
    sourceTruncated || draft.truncated
      ? notice + ' Some text was truncated to the safe limit; review it before sending.'
      : notice,
  );
}

function applySelectionAction(action: unknown) {
  const draft = buildSelectionActionDraft(action, selectedTranscriptText);
  if (!draft.text) {
    hideSelectionActions();
    return;
  }
  putTextIntoDraft(draft.text, 'Selection action added a reviewable draft.', draft.truncated);
  hideSelectionActions();
}

selectionActions.addEventListener('mousedown', (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('button')) event.preventDefault();
});
for (const button of Array.from(selectionActions.querySelectorAll<HTMLButtonElement>('[data-selection-action]'))) {
  button.addEventListener('click', () => applySelectionAction(button.dataset.selectionAction));
}
document.addEventListener('selectionchange', updateSelectionActions);

/* ------------------------------------------------------------ attachments */

function renderAttachments() {
  const bar = $('attachments');
  bar.innerHTML = '';
  bar.hidden = pendingAttachments.length === 0;
  for (const [i, a] of pendingAttachments.entries()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${a.kind === 'image' ? '🖼' : '📄'} ${a.name}`;
    const x = document.createElement('button');
    x.className = 'chip-x';
    x.textContent = '×';
    x.title = 'Remove';
    x.setAttribute('aria-label', 'Remove attachment ' + a.name);
    x.addEventListener('click', () => {
      pendingAttachments.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    bar.appendChild(chip);
  }
}

async function attachFilesToComposer(): Promise<boolean> {
  return composerAttachmentQueue.enqueue(async () => {
    const picked = await adi.files.pick();
    if (!picked.length) return false;
    if (privacyMode.checked) return false;
    pendingAttachments.push(...picked);
    renderAttachments();
    return true;
  });
}
async function captureScreenForComposer(): Promise<boolean> {
  return composerAttachmentQueue.enqueue(async () => {
    const captures = await adi.screen.capture();
    if (privacyMode.checked || !captures.length) return false;
    pendingAttachments.push(...captures.map((capture) => ({ ...capture, source: 'screen' as const })));
    renderAttachments();
    return true;
  });
}
$('btn-attach').addEventListener('click', async () => {
  try {
    await attachFilesToComposer();
  } catch (error) {
    reportAsyncError('Could not attach files: ', error);
  }
});

/**
 * Attaches a shot of the screen to the next message.
 *
 * Adi can already call screen_capture itself, but only if it works out that it
 * should — and "why is this broken" reads as a question, not as a request to
 * look. Pressing the button removes the guesswork: the picture is simply there
 * with the message.
 */
$('btn-screen').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-screen');
  btn.disabled = true;
  try {
    if (!(await captureScreenForComposer())) return;
  } catch (error) {
    reportAsyncError('Could not capture the screen: ', error);
  } finally {
    btn.disabled = privacyMode.checked;
  }
});

// Drag files or text onto the chat, or paste an image from the clipboard.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const dataTransfer = e.dataTransfer;
  const paths: string[] = [];
  for (const f of Array.from(dataTransfer?.files ?? [])) {
    const p = (f as File & { path?: string }).path;
    if (p) paths.push(p);
  }
  if (!paths.length) {
    const droppedText = dataTransfer?.getData('text/plain') ?? '';
    if (!droppedText.trim()) return;
    if (privacyMode.checked) {
      addNotice('Privacy Pause is on; dropped text was not added to the draft.');
      return;
    }
    putTextIntoDraft(droppedText, 'Dropped text was added to the draft. Review it before sending.');
    return;
  }
  try {
    await composerAttachmentQueue.enqueue(async () => {
      const picked = await adi.files.read(paths);
      if (privacyMode.checked) {
        addNotice('Privacy Pause is on; dropped files were not added to the draft.');
        return;
      }
      pendingAttachments.push(...picked);
      renderAttachments();
    });
  } catch (error) {
    reportAsyncError('Could not attach dropped files: ', error);
  }
});

document.addEventListener('paste', (e) => {
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (!item.type.startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const reader = new FileReader();
    reader.onload = () => {
      void composerAttachmentQueue.enqueue(async () => {
        if (privacyMode.checked) return;
        pendingAttachments.push({
          name: 'pasted image',
          kind: 'image',
          dataUrl: String(reader.result),
        });
        renderAttachments();
      }).catch((error) => reportAsyncError('Could not attach pasted image: ', error));
    };
    reader.readAsDataURL(blob);
  }
});

btnSend.addEventListener('click', () => fireAndReport(send(), 'Could not send chat: '));
clipboardButton.addEventListener('click', async () => {
  clipboardButton.disabled = true;
  try {
    const clipboardText = await adi.clipboard.readText();
    if (privacyMode.checked) {
      addNotice('Privacy Pause is on; clipboard text was not added to the draft.');
      return;
    }
    if (!clipboardText.trim()) {
      addNotice('The clipboard has no text to add to the draft.');
      return;
    }
    putTextIntoDraft(clipboardText, 'Clipboard text was added to the draft. Review it before sending.');
  } catch (error) {
    reportAsyncError('Could not read clipboard text: ', error);
  } finally {
    clipboardButton.disabled = privacyMode.checked;
  }
});
btnStop.addEventListener('click', () => fireAndReport(adi.chat.cancel(), 'Could not cancel the chat: '));

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    fireAndReport(send(), 'Could not send chat: ');
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});

/* --------------------------------------------------------------- streams */

adi.chat.onStream((evt: StreamEvent) => {
  let streamKind = activeStream?.kind;
  try {
    if (!acceptStreamEvent(evt)) return;
    if (evt.type !== 'delta') flushPendingStreamRender();
    streamKind = activeStream?.kind;
    updateActivityFromStream(evt);
    // A quick question renders into the speech bubble, not the transcript.
    const quickStream = isBubbleTurnKind(streamKind);
  if (quickStream) {
    switch (evt.type) {
      case 'mcp':
        fireAndReport(loadMcp(evt.servers), 'Could not refresh MCP status: ');
        break;
      case 'delta':
        appendQuickStreamDelta(evt.text);
        scheduleStreamRender({
          target: quickAnswerBody,
          text: quickBuffer,
          assistantMessage: false,
          scroll: false,
        });
        break;
      case 'tool-start':
        setMood('working');
        quickSegmentBoundaryPending = Boolean(quickBuffer.trim());
        if (!quickBuffer) quickAnswerBody.textContent = `…${evt.call.name}`;
        break;
      case 'tool-end':
        setMood('thinking');
        break;
      case 'notice':
        if (!quickBuffer) quickAnswerBody.textContent = evt.message;
        quickAnswer.hidden = false;
        fireAndReport(setQuickWindowMode('answer'), 'Could not show quick progress: ');
        break;
      case 'done':
        quickActive = false;
        quickSegmentBoundaryPending = false;
        setMood('idle');
        renderMarkdown(quickAnswerBody, quickBuffer || '(no answer)');
        // Asking out loud means expecting an answer out loud.
        const readableQuickAnswer = assistantClipboardText(quickBuffer);
        if ((speakReplies || quickWasSpoken) && readableQuickAnswer.trim()) speakText(readableQuickAnswer);
        quickWasSpoken = false;
        startQuickCountdown(readingTime(readableQuickAnswer));
        break;
      case 'error':
        quickActive = false;
        quickSegmentBoundaryPending = false;
        quickWasSpoken = false;
        setMood('error');
        setTimeout(() => setMood('idle'), 2000);
        quickAnswer.hidden = false;
        quickAnswerBody.textContent = evt.message;
        fireAndReport(setQuickWindowMode('answer'), 'Could not show quick error: ');
        startQuickCountdown(9000);
        break;
    }
    clearFinishedStream(evt);
    return;
  }

  switch (evt.type) {
    case 'delta':
      if (!currentAssistantEl) {
        currentAssistantEl = addMessageEl('assistant', '');
        streamBuffer = '';
      }
      streamBuffer += evt.text;
      scheduleStreamRender({
        target: currentAssistantEl,
        text: streamBuffer,
        assistantMessage: true,
        scroll: true,
      });
      break;

    case 'tool-start':
      setMood('working');
      currentAssistantEl = null;
      addToolEl(evt.call.id, evt.call.name, evt.displayArgs);
      break;

    case 'tool-end':
      finishToolEl(evt.result.toolCallId, evt.result);
      for (const url of evt.result.imageDataUrls ?? []) {
        addMessageEl('assistant', '', { imageDataUrl: url });
      }
      currentAssistantEl = null;
      setMood('thinking');
      break;

    case 'compacted':
      addNotice(`Compacted older messages — freed ~${evt.freedTokens.toLocaleString()} tokens`);
      break;

    case 'notice':
      addNotice(evt.message);
      break;

    // Servers finish connecting a second or two after launch, so the settings
    // list is filled in when they do rather than showing an empty pane.
    case 'mcp':
       fireAndReport(loadMcp(evt.servers), 'Could not refresh MCP status: ');
      break;

    case 'done':
       fireAndReport(loadConversations(), 'Could not refresh conversations: ');
      if (speakReplies && streamBuffer.trim()) speakText(streamBuffer);
      streaming = false;
      btnSend.hidden = false;
      btnStop.hidden = true;
      currentAssistantEl = null;
      setMood('idle');
      break;

    case 'error':
      streaming = false;
      btnSend.hidden = false;
      btnStop.hidden = true;
      currentAssistantEl = null;
      activeRequest = null;
      renderPermission();
      addErrorEl(evt.message);
      setMood('error');
      setTimeout(() => setMood('idle'), 2500);
      break;
  }
    clearFinishedStream(evt);
  } catch (error) {
    discardPendingStreamRender();
    const failedQuick = isBubbleTurnKind(streamKind);
    streaming = false;
    quickActive = false;
    quickSegmentBoundaryPending = false;
    quickWasSpoken = false;
    btnSend.hidden = false;
    btnStop.hidden = true;
    currentAssistantEl = null;
    activeRequest = null;
    activeStream = null;
    activityCancelling = false;
    activityGoal = '';
    renderPermission();
    renderActivity();
    if (failedQuick) {
      quickAnswer.hidden = false;
      quickAnswerBody.textContent = 'The response could not be displayed. Start again.';
      startQuickCountdown(7000);
    }
    reportAsyncError('Could not render response: ', error);
    setMood('error');
    setTimeout(() => setMood('idle'), 2500);
  }
});

/* ----------------------------------------------------------- permissions */

let activeRequest: PermissionRequest | null = null;
let inlineApproval: HTMLElement | null = null;
let permissionResponseInFlight = false;
const MAX_PERMISSION_DETAIL_DISPLAY = 12_000;

function displayPermissionDetail(detail: string): string {
  const bounded = detail.slice(0, MAX_PERMISSION_DETAIL_DISPLAY);
  return detail.length > MAX_PERMISSION_DETAIL_DISPLAY
    ? bounded + '\n…[details truncated]'
    : bounded;
}

function populateApprovalCard(target: HTMLElement, req: PermissionRequest, heading?: string): void {
  target.replaceChildren();
  if (heading) {
    const title = document.createElement('div');
    title.className = 'approval-title';
    title.textContent = heading;
    target.append(title);
  }

  const reason = document.createElement('div');
  reason.className = 'approval-reason';
  reason.textContent = req.reason;

  const cmd = document.createElement('div');
  cmd.className = 'approval-cmd';
  cmd.textContent = req.summary;

  const detail = document.createElement('details');
  detail.className = 'approval-detail';
  const detailSummary = document.createElement('summary');
  detailSummary.textContent = 'Details';
  const detailText = document.createElement('pre');
  detailText.textContent = displayPermissionDetail(req.detail);
  detail.append(detailSummary, detailText);

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const mk = (label: string, cls: string, decision: PermissionDecision) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.type = 'button';
    b.textContent = label;
    b.disabled = permissionResponseInFlight;
    b.addEventListener('click', () => fireAndReport(respond(decision), 'Could not record the approval response: '));
    return b;
  };
  actions.append(mk('Allow once', 'btn-primary', { action: 'allow-once' }));
  if (req.canAllowTask) actions.append(mk('This request', '', { action: 'allow-task' }));
  if (req.canAllowSession) actions.append(mk('This session', '', { action: 'allow-session' }));
  if (req.canAlwaysAllow) actions.append(mk('Always allow', '', { action: 'allow-always' }));
  actions.append(mk('Deny', 'btn-ghost', { action: 'deny' }));

  target.append(reason, cmd, detail, actions);
}

/**
 * Confirmations follow the user: inline in the transcript when the chat is
 * open, in the bubble beside the pet when it is collapsed.
 *
 * The bubble is a child of the pet stage, which is hidden while the chat is
 * expanded — so routing everything through it left an expanded chat showing
 * "waiting for your approval" with no buttons anywhere, and the turn could
 * never continue.
 */
function renderPermission() {
  const req = activeRequest;

  if (!req) {
    if (activityApproval) {
      activityApproval = '';
      renderActivity();
    }
    bubble.hidden = true;
    bubbleDetail.textContent = '';
    petBadge.hidden = true;
    bubbleTask.hidden = true;
    bubbleSession.hidden = true;
    bubbleAlways.hidden = true;
    petStage.classList.remove('has-bubble');
    inlineApproval?.remove();
    inlineApproval = null;
    studioApproval.hidden = true;
    studioApproval.replaceChildren();
    fireAndReport(setBubbleWindow(false), 'Could not update approval bubble: ');
    return;
  }

  bubbleTask.hidden = req.canAllowTask !== true;
  bubbleTask.disabled = permissionResponseInFlight;
  bubbleSession.hidden = req.canAllowSession !== true;
  bubbleSession.disabled = permissionResponseInFlight;
  bubbleAlways.hidden = req.canAlwaysAllow !== true;
  bubbleAlways.disabled = permissionResponseInFlight;
  $<HTMLButtonElement>('bubble-allow').disabled = permissionResponseInFlight;
  $<HTMLButtonElement>('bubble-deny').disabled = permissionResponseInFlight;

  // Ask the DOM what is actually on screen rather than trusting a cached flag;
  // if the two ever disagree, the confirmation lands where the user is not.
  const studioOpen = !toolStudioPanel.hidden;
  if (studioOpen) {
    // Studio owns its test request. Keep the approval beside the builder so a
    // test never waits on a hidden chat transcript or a collapsed pet bubble.
    bubble.hidden = true;
    petStage.classList.remove('has-bubble');
    fireAndReport(setBubbleWindow(false), 'Could not update approval bubble: ');
    inlineApproval?.remove();
    inlineApproval = null;
    studioApproval.hidden = false;
    populateApprovalCard(
      studioApproval,
      req,
      studioTestInFlight && req.toolName === 'test_tool'
        ? 'Studio test needs your approval'
        : 'Approval needed to continue',
    );
    return;
  }

  if (!chat.hidden) {
    // Chat is open: put it in the transcript, and keep the pet window small.
    bubble.hidden = true;
    petStage.classList.remove('has-bubble');
    fireAndReport(setBubbleWindow(false), 'Could not update approval bubble: ');

    studioApproval.hidden = true;
    studioApproval.replaceChildren();
    if (!inlineApproval) {
      inlineApproval = document.createElement('div');
      inlineApproval.className = 'approval';
      messagesEl.appendChild(inlineApproval);
    }
    populateApprovalCard(inlineApproval, req);
    scrollToBottom();
    return;
  }

  // Collapsed: show the bubble and grow the pet window to fit it.
  inlineApproval?.remove();
  inlineApproval = null;
  studioApproval.hidden = true;
  studioApproval.replaceChildren();
  bubbleReason.textContent = req.reason;
  bubbleCmd.textContent = req.summary;
  bubbleDetail.textContent = displayPermissionDetail(req.detail);
  bubble.hidden = false;
  petBadge.hidden = false;
  petBadge.textContent = '!';
  petStage.classList.add('has-bubble');
  fireAndReport(setBubbleWindow(true), 'Could not update approval bubble: ');
}

adi.permission.onRequest((req) => {
  try {
    const studioTestRequest =
      studioTestInFlight && req.toolName === 'test_tool';
    if (!req.operationId || (!studioTestRequest && activeStream?.operationId !== req.operationId)) return;

    activeRequest = req;
    setMood('thinking');
    activityTask = 'Waiting for approval';
    activityApproval = req.toolName + ' (' + req.tier + ')';
    renderActivity();
    renderPermission();
  } catch (error) {
    activeRequest = null;
    activityApproval = '';
    try {
      renderPermission();
    } catch {
      /* Keep the stream alive even if an approval surface cannot be rebuilt. */
    }
    reportAsyncError('Could not show the approval request: ', error);
  }
});

async function respond(decision: PermissionDecision): Promise<void> {
  const req = activeRequest;
  if (!req || permissionResponseInFlight) return;
  permissionResponseInFlight = true;
  renderPermission();
  try {
    await adi.permission.respond(req.id, decision);
    if (activeRequest?.id !== req.id) return;
    if (decision.action === 'allow-always') {
      fireAndReport(loadSavedPermissions(), 'Could not refresh saved approvals: ');
    }
    activeRequest = null;
    activityApproval = '';
    activityTask = decision.action === 'deny' ? 'Approval denied' : 'Continuing';
    recordActivity(decision.action === 'deny' ? 'Approval denied' : 'Approval granted');
  } catch (error) {
    reportAsyncError('Could not record the approval response: ', error);
  } finally {
    permissionResponseInFlight = false;
    renderPermission();
  }
}
$('bubble-allow').addEventListener('click', () => fireAndReport(respond({ action: 'allow-once' }), 'Could not record the approval response: '));
$('bubble-task').addEventListener('click', () => fireAndReport(respond({ action: 'allow-task' }), 'Could not record the approval response: '));
$('bubble-session').addEventListener('click', () => fireAndReport(respond({ action: 'allow-session' }), 'Could not record the approval response: '));
$('bubble-always').addEventListener('click', () => fireAndReport(respond({ action: 'allow-always' }), 'Could not record the approval response: '));
$('bubble-deny').addEventListener('click', () => fireAndReport(respond({ action: 'deny' }), 'Could not record the approval response: '));

/* ------------------------------------------------------- access points */

/**
 * Where requests go, and the key that gets them there.
 *
 * The key itself never comes back across the bridge — only whether one is
 * stored and its last four characters, which is enough to tell two keys apart
 * and worthless to anyone who reads it.
 */
function reflectWorkspaceRoot(root: string) {
  workspaceRootInput.value = root;
  workspaceRootNote.textContent = root
    ? 'Selected folder. Only opted-in new chats receive bounded names and project markers.'
    : 'No folder selected. Choose one to use bounded workspace metadata.';
}

async function loadProviders() {
  const generation = ++providerLoadGeneration;
  const settingsGeneration = settingsMutationGeneration;
  const [providers, settings] = await Promise.all([adi.providers.list(), adi.settings.get()]);
  if (generation !== providerLoadGeneration || settingsGeneration !== settingsMutationGeneration) return;
  providerSelect.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.needsKey && !p.set ? `${p.label} — no key` : p.label;
    if (p.note) opt.title = p.note;
    providerSelect.appendChild(opt);
  }
  providerSelect.value = settings.provider;
  baseUrlInput.value = settings.customBaseUrl;
  reflectWorkspaceRoot(settings.workspaceRoot);
  workspaceContextEnabled.checked = settings.workspaceContextEnabled;
  workspaceFileSearchEnabled.checked = settings.workspaceFileSearchEnabled;
  goalContextEnabled.checked = settings.goalContextEnabled;
  learningMemoryEnabled.checked = settings.learningMemoryEnabled;
  privacyMode.checked = settings.privacyMode;
  reflectPrivacyMode(settings.privacyMode);
  reflectProvider(providers, settings.provider);
}

function reflectProvider(
  providers: Awaited<ReturnType<typeof adi.providers.list>>,
  id: string,
) {
  const p = providers.find((x) => x.id === id);
  if (!p) return;
  providerNote.textContent = p.note ?? '';
  keyField.hidden = !p.needsKey;
  baseUrlField.hidden = p.id !== 'custom';
  keyInput.value = '';
  keyInput.placeholder = p.set ? `saved ${p.hint}` : 'paste key…';
  keyNote.textContent = p.set
    ? 'Stored encrypted by Windows. Paste a new one to replace it.'
    : p.keyUrl
      ? `Get one at ${p.keyUrl}`
      : p.needsKey
        ? 'Paste the API key required by this server.'
        : 'No key needed.';
}

function setProviderControlsBusy(busy: boolean): void {
  providerSelect.disabled = busy;
  $<HTMLButtonElement>('btn-key-save').disabled = busy;
  $<HTMLButtonElement>('btn-key-clear').disabled = busy;
  baseUrlInput.disabled = busy;
}
providerSelect.addEventListener('change', async () => {
  const generation = ++providerMutationGeneration;
  settingsMutationGeneration += 1;
  const provider = providerSelect.value as ProviderId;
  modelMutationGeneration += 1;
  const modelWasDisabled = modelSelect.disabled;
  setProviderControlsBusy(true);
  modelSelect.disabled = true;
  try {
    await adi.settings.set('provider', provider);
    if (generation !== providerMutationGeneration) return;
    await loadProviders();
    if (generation !== providerMutationGeneration) return;
    // The model list belongs to the provider, so it has to be rebuilt too.
    await loadModels();
    if (generation !== providerMutationGeneration) return;
    addNotice('Now using ' + (providerSelect.options[providerSelect.selectedIndex]?.textContent ?? provider) + '.');
  } catch (error) {
    if (generation !== providerMutationGeneration) return;
    reportAsyncError('Could not change provider: ', error);
    fireAndReport(loadProviders(), 'Could not restore provider selection: ');
    fireAndReport(loadModels(), 'Could not restore model selection: ');
  } finally {
    if (generation === providerMutationGeneration) setProviderControlsBusy(false);
    modelSelect.disabled = modelWasDisabled;
  }
});

$('btn-key-save').addEventListener('click', async () => {
  const key = keyInput.value.trim();
  if (!key) return;
  const generation = ++providerMutationGeneration;
  settingsMutationGeneration += 1;
  const provider = providerSelect.value as ProviderId;
  setProviderControlsBusy(true);
  try {
    await adi.providers.setKey(provider, key);
    if (generation !== providerMutationGeneration) return;
    keyInput.value = '';
    await loadProviders();
    if (generation !== providerMutationGeneration) return;
    addNotice('Key saved.');
  } catch (error) {
    if (generation !== providerMutationGeneration) return;
    reportAsyncError('Could not save the provider key: ', error);
  } finally {
    if (generation === providerMutationGeneration) setProviderControlsBusy(false);
  }
});

$('btn-key-clear').addEventListener('click', async () => {
  const generation = ++providerMutationGeneration;
  settingsMutationGeneration += 1;
  const provider = providerSelect.value as ProviderId;
  setProviderControlsBusy(true);
  try {
    await adi.providers.clearKey(provider);
    if (generation !== providerMutationGeneration) return;
    await loadProviders();
    if (generation !== providerMutationGeneration) return;
    addNotice('Key removed.');
  } catch (error) {
    if (generation !== providerMutationGeneration) return;
    reportAsyncError('Could not remove the provider key: ', error);
  } finally {
    if (generation === providerMutationGeneration) setProviderControlsBusy(false);
  }
});

baseUrlInput.addEventListener('change', async () => {
  const generation = ++providerMutationGeneration;
  settingsMutationGeneration += 1;
  const value = baseUrlInput.value.trim();
  setProviderControlsBusy(true);
  try {
    await adi.settings.set('customBaseUrl', value);
    baseUrlInput.value = value;
  } catch (error) {
    if (generation !== providerMutationGeneration) return;
    reportAsyncError('Could not save the custom base URL: ', error);
    fireAndReport(loadProviders(), 'Could not restore the custom base URL: ');
  } finally {
    if (generation === providerMutationGeneration) setProviderControlsBusy(false);
  }
});

function setWorkspaceMutationBusy(busy: boolean): void {
  workspaceMutationInFlight = busy;
  workspacePickButton.disabled = busy;
  workspaceClearButton.disabled = busy;
}
workspacePickButton.addEventListener('click', () => {
  if (workspaceMutationInFlight) return;
  const generation = ++workspaceMutationGeneration;
  settingsMutationGeneration += 1;
  setWorkspaceMutationBusy(true);
  workspaceContextEnabled.disabled = true;
  workspaceFileSearchEnabled.disabled = true;
  fireAndReport(workspaceScopeWrites.enqueue(async () => {
    try {
      const result = await adi.workspace.pickRoot();
      if (result.canceled) return;
      if (result.error || !result.root) {
        addErrorEl(result.error ?? 'The selected folder could not be validated.');
        return;
      }
      await adi.settings.set('workspaceRoot', result.root);
      if (generation !== workspaceMutationGeneration) return;
      reflectWorkspaceRoot(result.root);
      workspaceContextEnabled.checked = false;
      workspaceFileSearchEnabled.checked = false;
      addNotice('Workspace folder selected. Enable metadata sharing or file search separately if you want them.');
    } catch (error) {
      addErrorEl('Workspace folder selection failed: ' + (error as Error).message);
      fireAndReport(loadProviders(), 'Could not restore workspace settings: ');
    } finally {
      setWorkspaceMutationBusy(false);
      workspaceContextEnabled.disabled = false;
      workspaceFileSearchEnabled.disabled = false;
    }
  }), 'Workspace folder selection failed: ');
});

workspaceClearButton.addEventListener('click', () => {
  if (workspaceMutationInFlight) return;
  const generation = ++workspaceMutationGeneration;
  settingsMutationGeneration += 1;
  setWorkspaceMutationBusy(true);
  workspaceContextEnabled.disabled = true;
  workspaceFileSearchEnabled.disabled = true;
  fireAndReport(workspaceScopeWrites.enqueue(async () => {
    try {
      await adi.settings.set('workspaceRoot', '');
      if (generation !== workspaceMutationGeneration) return;
      reflectWorkspaceRoot('');
      workspaceContextEnabled.checked = false;
      workspaceFileSearchEnabled.checked = false;
      addNotice('Workspace folder cleared.');
    } catch (error) {
      addErrorEl('Workspace folder could not be cleared: ' + (error as Error).message);
      fireAndReport(loadProviders(), 'Could not restore workspace settings: ');
    } finally {
      setWorkspaceMutationBusy(false);
      workspaceContextEnabled.disabled = false;
      workspaceFileSearchEnabled.disabled = false;
    }
  }), 'Workspace folder clear failed: ');
});
type ConsentKey = 'privacyMode' | 'workspaceContextEnabled' | 'workspaceFileSearchEnabled' | 'goalContextEnabled' | 'learningMemoryEnabled';

async function persistConsent(
  input: HTMLInputElement,
  key: ConsentKey,
  enabledNotice: string,
  disabledNotice: string,
): Promise<void> {
  const desired = input.checked;
  const workspaceScoped = key === 'workspaceContextEnabled' || key === 'workspaceFileSearchEnabled';
  const expectedWorkspaceRoot = workspaceScoped ? workspaceRootInput.value.trim() : undefined;
  settingsMutationGeneration += 1;
  if (key === 'privacyMode') {
    modeLoadGeneration += 1;
    profileLoadGeneration += 1;
    mcpLoadGeneration += 1;
  }

  const save = async (): Promise<void> => {
    input.disabled = true;
    try {
      const saved = await adi.settings.set(key, desired, expectedWorkspaceRoot);
      if (workspaceScoped && saved.workspaceRoot.trim() !== expectedWorkspaceRoot) {
        // The folder changed while this request was in flight; use the current
        // snapshot and do not carry the old folder's consent forward.
        reflectWorkspaceRoot(saved.workspaceRoot);
        workspaceContextEnabled.checked = saved.workspaceContextEnabled;
        workspaceFileSearchEnabled.checked = saved.workspaceFileSearchEnabled;
        return;
      }
      input.checked = saved[key];
      if (key === 'privacyMode') {
        reflectPrivacyMode(saved.privacyMode);
        fireAndReport(loadProfiles(), 'Could not refresh browser profiles: ');
        fireAndReport(loadMcp(), 'Could not refresh MCP status: ');
      }
      addNotice(saved[key] ? enabledNotice : disabledNotice);
    } catch (error) {
      input.checked = !desired;
      if (key === 'privacyMode') {
        reflectPrivacyMode(input.checked);
        fireAndReport(loadProfiles(), 'Could not refresh browser profiles: ');
        fireAndReport(loadMcp(), 'Could not refresh MCP status: ');
      }
      addErrorEl('Could not save this setting: ' + (error as Error).message);
    } finally {
      if (!workspaceScoped || !workspaceMutationInFlight) input.disabled = false;
    }
  };

  if (workspaceScoped) {
    await workspaceScopeWrites.enqueue(save);
  } else {
    await save();
  }
}
privacyMode.addEventListener('change', () => {
  fireAndReport(persistConsent(
    privacyMode,
    'privacyMode',
    'Privacy pause enabled. New AI turns, connected access, background jobs, and reminders are stopped.',
    'Privacy pause disabled.',
  ), 'Could not save this setting: ');
});

workspaceContextEnabled.addEventListener('change', () => {
  fireAndReport(persistConsent(
    workspaceContextEnabled,
    'workspaceContextEnabled',
    'Workspace metadata sharing enabled for new chats.',
    'Workspace metadata sharing disabled.',
  ), 'Could not save this setting: ');
});
goalContextEnabled.addEventListener('change', () => {
  fireAndReport(persistConsent(
    goalContextEnabled,
    'goalContextEnabled',
    'Active-goal context enabled for new chats.',
    'Active-goal context disabled.',
  ), 'Could not save this setting: ');
});
workspaceFileSearchEnabled.addEventListener('change', () => {
  fireAndReport(persistConsent(
    workspaceFileSearchEnabled,
    'workspaceFileSearchEnabled',
    'Workspace file search enabled for the selected folder.',
    'Workspace file search disabled.',
  ), 'Could not save this setting: ');
});
learningMemoryEnabled.addEventListener('change', () => {
  fireAndReport(persistConsent(
    learningMemoryEnabled,
    'learningMemoryEnabled',
    'Saved-lesson context enabled for new chats.',
    'Saved-lesson context disabled.',
  ), 'Could not save this setting: ');
});

type StoredProject = Awaited<ReturnType<typeof adi.projects.list>>[number];

function renderProjects(projects: StoredProject[]) {
  projectNames = new Map(projects.map((project) => [project.id, project.name]));
  projectList.innerHTML = '';
  if (!projects.length) {
    const empty = document.createElement('div');
    empty.className = 'field-note';
    empty.textContent = 'No projects yet. Create one through chat when you are ready.';
    projectList.appendChild(empty);
    return;
  }

  for (const project of projects.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'project-row';

    const name = document.createElement('div');
    name.className = 'project-name';
    name.textContent = project.name;

    const meta = document.createElement('div');
    meta.className = 'project-meta';
    meta.textContent = project.status + (project.workspaceRoot ? ' · ' + project.workspaceRoot : '');
    meta.title = project.workspaceRoot ?? '';

    const details = document.createElement('div');
    details.className = 'project-detail';
    const counts = [
      project.assignmentCount + ' assignment(s)' + (project.activeAssignmentCount ? ' · ' + project.activeAssignmentCount + ' active' : ''),
      project.researchCount + ' research record(s)',
      project.verifiedArtifactCount + ' verified artifact(s)',
    ];
    details.textContent = [project.description, counts.join(' · ')].filter(Boolean).join(' · ');

    row.append(name, meta, details);
    projectList.appendChild(row);
  }
}

async function loadProjects(projects?: StoredProject[]) {
  const generation = ++projectLoadGeneration;
  try {
    const list = projects ?? (await adi.projects.list());
    if (generation !== projectLoadGeneration) return;
    renderProjects(list);
  } catch (error) {
    if (generation !== projectLoadGeneration) return;
    addErrorEl('Could not load projects: ' + (error as Error).message);
  }
}

type StoredAssignmentSummary = Awaited<ReturnType<typeof adi.assignments.list>>[number];

function renderAssignments(assignments: readonly StoredAssignmentSummary[]): void {
  assignmentList.innerHTML = '';
  if (!assignments.length) {
    const empty = document.createElement('div');
    empty.className = 'field-note';
    empty.textContent = 'No assignments yet. Create one through chat when you are ready.';
    assignmentList.appendChild(empty);
    return;
  }

  for (const assignment of assignments.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'assignment-row';
    const head = document.createElement('div');
    head.className = 'assignment-head';
    const title = document.createElement('span');
    title.className = 'assignment-title';
    title.textContent = assignment.title;
    const status = document.createElement('span');
    status.className = 'assignment-status ' + assignment.status;
    status.textContent = assignment.status;
    head.append(title, status);

    const meta = document.createElement('div');
    meta.className = 'assignment-meta';
    const due = assignment.dueAt ? 'due ' + new Date(assignment.dueAt).toLocaleDateString() : 'no deadline';
    const subject = assignment.subject ? assignment.subject : 'general';
    meta.textContent = subject + ' · ' + due + ' · updated ' + relativeTime(assignment.updatedAt);

    const detail = document.createElement('div');
    detail.className = 'assignment-detail';
    const links = [
      assignment.projectId ? 'project ' + (projectNames.get(assignment.projectId) ?? 'linked') : '',
      assignment.goalId ? 'goal linked' : '',
    ].filter(Boolean);
    const counts = [
      assignment.checklistTotal ? assignment.checklistDone + '/' + assignment.checklistTotal + ' checklist' : '',
      assignment.notesCount ? assignment.notesCount + ' notes' : '',
      assignment.researchCount ? assignment.researchCount + ' research' : '',
      assignment.citationCount ? assignment.citationCount + ' citations' : '',
      assignment.artifactCount ? assignment.artifactCount + ' verified artifacts' : '',
      ...links,
    ].filter(Boolean);
    detail.textContent = counts.length ? counts.join(' · ') : 'No checklist or linked material yet.';
    row.append(head, meta, detail);
    assignmentList.appendChild(row);
  }
}

async function loadAssignments(view?: readonly StoredAssignmentSummary[]): Promise<void> {
  const generation = ++assignmentLoadGeneration;
  try {
    const next = view ?? (await adi.assignments.list());
    if (generation !== assignmentLoadGeneration) return;
    renderAssignments(next);
  } catch (error) {
    if (generation !== assignmentLoadGeneration) return;
    addErrorEl('Could not load assignments: ' + (error as Error).message);
  }
}
type LessonView = Awaited<ReturnType<typeof adi.memory.list>>;

function renderLessons(view: LessonView) {
  lessonList.innerHTML = '';
  lessonsNote.textContent = view.warning
    ? view.warning + (view.editable ? ' Older entries are still editable.' : ' Editing and deletion are disabled until the file is reduced.')
    : 'Inspect the notes Adi has saved. Editing redacts secret-like values; deletion asks first.';

  if (!view.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'field-note';
    empty.textContent = view.warning ? 'No safely editable lesson entries are available.' : 'No saved lessons yet.';
    lessonList.appendChild(empty);
    return;
  }

  for (const entry of view.entries) {
    const row = document.createElement('div');
    row.className = 'lesson-row';

    const head = document.createElement('div');
    head.className = 'lesson-head';
    const label = document.createElement('span');
    label.className = 'lesson-label';
    label.textContent = '#' + entry.index;
    const date = document.createElement('span');
    date.className = 'lesson-date';
    date.textContent = entry.date;
    head.append(label, date);

    const body = document.createElement('div');
    body.className = 'lesson-text';
    body.textContent = entry.text;

    const actions = document.createElement('div');
    actions.className = 'lesson-actions';
    const edit = document.createElement('button');
    edit.className = 'btn btn-ghost';
    edit.textContent = 'Edit';
    edit.disabled = !view.editable;
    edit.addEventListener('click', async () => {
      const next = await requestText('Replace saved lesson #' + entry.index, entry.text);
      if (next === null) return;
      const mutationGeneration = ++lessonMutationGeneration;
      edit.disabled = true;
      try {
        const updated = await adi.memory.edit(entry.index, next);
        if (mutationGeneration !== lessonMutationGeneration) {
          if (edit.isConnected) edit.disabled = !view.editable;
          fireAndReport(loadLessons(), 'Could not reconcile saved memory: ');
          return;
        }
        lessonLoadGeneration += 1;
        renderLessons(updated);
        addNotice('Saved lesson updated.');
      } catch (error) {
        if (mutationGeneration !== lessonMutationGeneration) {
          if (edit.isConnected) edit.disabled = !view.editable;
          fireAndReport(loadLessons(), 'Could not reconcile saved memory: ');
          return;
        }
        addErrorEl('Could not update saved lesson: ' + (error as Error).message);
        edit.disabled = !view.editable;
      }
    });

    const remove = document.createElement('button');
    remove.className = 'btn btn-ghost lesson-remove';
    remove.textContent = 'Delete';
    remove.disabled = !view.editable;
    remove.addEventListener('click', async () => {
      if (!window.confirm('Delete saved lesson #' + entry.index + '?\n\n' + entry.text)) return;
      const mutationGeneration = ++lessonMutationGeneration;
      edit.disabled = true;
      remove.disabled = true;
      try {
        const updated = await adi.memory.remove(entry.index);
        if (mutationGeneration !== lessonMutationGeneration) {
          if (remove.isConnected) {
            edit.disabled = !view.editable;
            remove.disabled = !view.editable;
          }
          fireAndReport(loadLessons(), 'Could not reconcile saved memory: ');
          return;
        }
        lessonLoadGeneration += 1;
        renderLessons(updated);
        addNotice('Saved lesson deleted.');
      } catch (error) {
        if (mutationGeneration !== lessonMutationGeneration) {
          if (remove.isConnected) {
            edit.disabled = !view.editable;
            remove.disabled = !view.editable;
          }
          fireAndReport(loadLessons(), 'Could not reconcile saved memory: ');
          return;
        }
        addErrorEl('Could not delete saved lesson: ' + (error as Error).message);
        edit.disabled = !view.editable;
        remove.disabled = !view.editable;
      }
    });
    actions.append(edit, remove);
    row.append(head, body, actions);
    lessonList.appendChild(row);
  }
}

async function loadLessons(view?: LessonView) {
  const generation = ++lessonLoadGeneration;
  try {
    const next = view ?? (await adi.memory.list());
    if (generation !== lessonLoadGeneration) return;
    renderLessons(next);
  } catch (error) {
    if (generation !== lessonLoadGeneration) return;
    addErrorEl('Could not load saved memory: ' + (error as Error).message);
  }
}

lessonsRefreshButton.addEventListener('click', () =>
  fireAndReport(loadLessons(), 'Could not load saved memory: '),
);
type DiagnosticView = Awaited<ReturnType<typeof adi.diagnostics.run>>;
const diagnosticsGate = createSingleFlightGate();

function renderDiagnostics(snapshot: DiagnosticView) {
  const attention = snapshot.checks.filter((item) => item.status !== 'ok').length;
  diagnosticsSummary.textContent =
    'Checked ' +
    new Date(snapshot.checkedAt).toLocaleTimeString() +
    ' · ' +
    (attention ? String(attention) + ' item(s) need attention' : 'all checks passed') +
    ' · ' +
    String(snapshot.metrics.recentAuditEntries) +
    ' recent audit entries inspected.';
  const averageToolMs =
    snapshot.metrics.averageToolMs === undefined ? 'n/a' : snapshot.metrics.averageToolMs + 'ms';
  const slowestToolMs =
    snapshot.metrics.slowestToolMs === undefined ? 'n/a' : snapshot.metrics.slowestToolMs + 'ms';
  diagnosticsMetrics.textContent =
    String(snapshot.metrics.recentRuntimeErrors) +
    ' recent runtime error(s) · ' +
    String(snapshot.metrics.recentModelRequests) +
    ' recent model request(s) · tool time avg ' +
    averageToolMs +
    ' / slowest ' +
    slowestToolMs;
  diagnosticsList.innerHTML = '';

  for (const item of snapshot.checks) {
    const row = document.createElement('div');
    row.className = 'diagnostic-row';

    const head = document.createElement('div');
    head.className = 'diagnostic-head';
    const label = document.createElement('span');
    label.className = 'diagnostic-label';
    label.textContent = item.label;
    const status = document.createElement('span');
    status.className = 'diagnostic-status ' + item.status;
    status.textContent = item.status;
    head.append(label, status);

    const detail = document.createElement('div');
    detail.className = 'diagnostic-detail';
    detail.textContent = item.detail;
    row.append(head, detail);
    diagnosticsList.appendChild(row);
  }

  if (snapshot.recentFailures.length) {
    const latestFailure = snapshot.recentFailures[0];
    if (!latestFailure) return;
    const failures = document.createElement('div');
    failures.className = 'diagnostic-failures';
    failures.textContent =
      'Latest failure: ' +
      latestFailure.label +
      ' · ' +
      latestFailure.detail;
    diagnosticsList.appendChild(failures);
  }
}

async function runDiagnostics() {
  if (!diagnosticsGate.tryEnter()) return;
  diagnosticsRunButton.disabled = true;
  diagnosticsRunButton.textContent = 'Checking…';
  try {
    const snapshot = await adi.diagnostics.run();
    renderDiagnostics(snapshot);
    addNotice('Diagnostics complete.');
  } catch (error) {
    addErrorEl('Diagnostics failed: ' + (error as Error).message);
  } finally {
    diagnosticsGate.leave();
    diagnosticsRunButton.disabled = false;
    diagnosticsRunButton.textContent = 'Run Diagnostics';
  }
}

projectsRefreshButton.addEventListener('click', () => void loadProjects());
assignmentsRefreshButton.addEventListener('click', () => void loadAssignments());
diagnosticsRunButton.addEventListener('click', () => void runDiagnostics());


/* ------------------------------------------------------------------ MCP */

async function loadMcp(servers?: Awaited<ReturnType<typeof adi.mcp.status>>) {
  const generation = ++mcpLoadGeneration;
  if (privacyMode.checked) {
    mcpList.innerHTML = '';
    const paused = document.createElement('div');
    paused.className = 'field-note';
    paused.textContent = 'Paused by privacy mode. Connected-service status is not queried.';
    mcpList.appendChild(paused);
    return;
  }
  try {
  const list = servers ?? (await adi.mcp.status());
  if (generation !== mcpLoadGeneration || privacyMode.checked) return;
  mcpList.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'field-note';
    empty.textContent = 'None configured.';
    mcpList.appendChild(empty);
    return;
  }
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    const dot = document.createElement('span');
    dot.className = `dot ${s.connected && !s.toolError ? 'ok' : s.disabled ? '' : 'bad'}`;
    const name = document.createElement('span');
    name.className = 'mcp-name';
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'mcp-meta';
    const disabledToolCount = s.disabledToolCount ?? 0;
    const counts = s.toolCount + ' tools' + (disabledToolCount ? ' · ' + disabledToolCount + ' disabled' : '') + ' · ' + s.resourceCount + ' resources';
    meta.textContent = s.toolError
      ? 'degraded: ' + s.toolError + ' · ' + counts
      : s.connected
        ? s.transport + ' · ' + counts
        : s.disabled
          ? 'disabled · ' + counts
          : (s.error ?? 'not connected');
    meta.title = s.toolError ?? s.error ?? s.target;
    const actionButton = document.createElement('button');
    actionButton.className = 'btn btn-ghost mcp-toggle';
    actionButton.textContent = s.disabled ? 'Enable' : 'Disable';
    actionButton.title = s.disabled ? 'Enable this MCP server' : 'Disable this MCP server';
    actionButton.disabled = privacyMode.checked;
    actionButton.addEventListener('click', async () => {
      const target = s.target ? '\n\nTarget: ' + s.target : '';
      const question = s.disabled
        ? 'Enable MCP server ' + s.name + '? This may launch a local program or connect to a remote service.'
        : 'Disable MCP server ' + s.name + '? Its tools and resources will stop being available.';
      if (!window.confirm(question + target)) return;
      actionButton.disabled = true;
      try {
        const updated = await adi.mcp.setDisabled(s.name, !s.disabled);
        addNotice((s.disabled ? 'Enabled ' : 'Disabled ') + s.name + '.');
        await loadMcp(updated);
      } catch (error) {
        addErrorEl('Could not change MCP server state: ' + (error as Error).message);
        actionButton.disabled = privacyMode.checked;
      }
    });
    row.append(dot, name, meta);
    if (s.name !== 'mcp.json') row.append(actionButton);
    const exposedTools = s.tools ?? [];
    if (exposedTools.length) {
      const details = document.createElement('details');
      details.className = 'mcp-tools';
      const summary = document.createElement('summary');
      summary.textContent = 'Inspect exposed tools (' + exposedTools.length + ')';
      const toolList = document.createElement('div');
      toolList.className = 'mcp-tools-list';
      for (const tool of exposedTools) {
        const item = document.createElement('div');
        item.className = 'mcp-tool';
        const head = document.createElement('div');
        head.className = 'mcp-tool-head';
        const toolName = document.createElement('span');
        toolName.className = 'mcp-tool-name';
        toolName.textContent = tool.qualifiedName;
        const permission = document.createElement('span');
        permission.className = 'mcp-tool-permission';
        permission.textContent = tool.disabled ? 'Disabled' : 'Confirm every time';
        const toolToggle = document.createElement('button');
        toolToggle.className = 'btn btn-ghost mcp-tool-toggle';
        toolToggle.textContent = tool.disabled ? 'Enable' : 'Disable';
        toolToggle.title = tool.disabled ? 'Enable this MCP tool' : 'Disable this MCP tool';
        toolToggle.disabled = privacyMode.checked || s.disabled;
        toolToggle.addEventListener('click', async () => {
          const action = tool.disabled ? 'Enable' : 'Disable';
          const question = tool.disabled
            ? 'Enable MCP tool ' + tool.qualifiedName + '? It will become available to Adi and still require confirmation.'
            : 'Disable MCP tool ' + tool.qualifiedName + '? It will no longer be advertised or callable until re-enabled.';
          if (!window.confirm(question)) return;
          toolToggle.disabled = true;
          try {
            const updated = await adi.mcp.setToolDisabled(s.name, tool.name, !tool.disabled);
            addNotice(action + 'd MCP tool ' + tool.qualifiedName + '.');
            await loadMcp(updated);
          } catch (error) {
            addErrorEl('Could not change MCP tool state: ' + (error as Error).message);
            toolToggle.disabled = privacyMode.checked || s.disabled;
          }
        });
        head.append(toolName, permission, toolToggle);
        const description = document.createElement('div');
        description.className = 'mcp-tool-description';
        description.textContent = tool.description || 'No description supplied.';
        item.append(head, description);
        toolList.appendChild(item);
      }
      details.append(summary, toolList);
      row.append(details);
    }
    mcpList.appendChild(row);
  }
  } catch (error) {
    addErrorEl('Could not load MCP status: ' + (error as Error).message);
  }
}

type JobView = Awaited<ReturnType<typeof adi.jobs.list>>[number];

function isActiveJobStatus(status: string): boolean {
  return ['queued', 'running', 'waiting', 'waiting-for-user'].includes(status);
}

function renderJobs(jobs: JobView[]) {
  activityJobs = jobs;
  renderActivity();
  jobsList.innerHTML = '';
  if (!jobs.length) {
    const empty = document.createElement('div');
    empty.className = 'field-note';
    empty.textContent = 'No background work has been queued.';
    jobsList.appendChild(empty);
    return;
  }

  for (const job of jobs.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'job-row';

    const head = document.createElement('div');
    head.className = 'job-head';
    const title = document.createElement('span');
    title.className = 'job-title';
    title.textContent = job.title;
    const status = document.createElement('span');
    status.className = 'job-status ' + job.status;
    status.textContent = job.status;
    head.append(title, status);

    const progress = document.createElement('div');
    progress.className = 'job-progress';
    progress.textContent =
      String(job.completed) +
      '/' +
      String(job.total) +
      ' complete · ' +
      String(job.failed) +
      ' failed · ' +
      String(job.skipped) +
      ' skipped';
    row.append(head, progress);

    const detail = job.error ?? job.summary;
    if (detail) {
      const summary = document.createElement('div');
      summary.className = 'job-summary';
      summary.textContent = detail.slice(0, 280);
      row.appendChild(summary);
    }
    if (job.mutationManifest) {
      const manifest = document.createElement('div');
      manifest.className = 'job-manifest';
      manifest.textContent =
        'Mutation manifest: ' +
        String(job.mutationManifest.planned) +
        ' planned · ' +
        String(job.mutationManifest.completed) +
        ' completed · ' +
        String(job.mutationManifest.failed) +
        ' failed · side effects not individually verified';
      row.appendChild(manifest);
    }


    if (isActiveJobStatus(job.status)) {
      const cancel = document.createElement('button');
      cancel.className = 'job-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        cancel.textContent = 'Cancelling…';
        const requestGeneration = jobsLoadGeneration;
        try {
          const next = await adi.jobs.cancel(job.id);
          if (requestGeneration !== jobsLoadGeneration) {
            if (cancel.isConnected) {
              cancel.disabled = false;
              cancel.textContent = 'Cancel';
            }
            return;
          }
          jobsLoadGeneration += 1;
          renderJobs(next);
          addNotice('Cancellation requested for ' + job.title + '.');
        } catch (error) {
          if (requestGeneration !== jobsLoadGeneration) {
            if (cancel.isConnected) {
              cancel.disabled = false;
              cancel.textContent = 'Cancel';
            }
            return;
          }
          addErrorEl('Could not cancel background work: ' + (error as Error).message);
          cancel.disabled = false;
          cancel.textContent = 'Cancel';
        }
      });
      row.appendChild(cancel);
    }

    jobsList.appendChild(row);
  }
}

async function loadJobs(jobs?: JobView[]) {
  const generation = ++jobsLoadGeneration;
  try {
    const next = jobs ?? (await adi.jobs.list());
    if (generation !== jobsLoadGeneration) return;
    renderJobs(next);
  } catch (error) {
    if (generation !== jobsLoadGeneration) return;
    addErrorEl('Could not load background work: ' + (error as Error).message);
  }
}

jobsRefreshButton.addEventListener('click', () => void loadJobs());
adi.jobs.onUpdate((jobs) => {
  jobsLoadGeneration += 1;
  try {
    renderJobs(jobs);
  } catch (error) {
    reportAsyncError('Could not refresh background work: ', error);
  }
});


type MutationView = Awaited<ReturnType<typeof adi.mutations.list>>[number];

function renderMutations(records: MutationView[]) {
  mutationsList.innerHTML = '';
  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'field-note';
    empty.textContent = 'No mutation journal entries yet.';
    mutationsList.appendChild(empty);
    return;
  }

  for (const record of records.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'mutation-row';

    const head = document.createElement('div');
    head.className = 'mutation-head';
    const summary = document.createElement('span');
    summary.className = 'mutation-summary';
    summary.textContent = record.summary;
    const status = document.createElement('span');
    status.className = 'mutation-status ' + record.status;
    status.textContent = record.status;
    head.append(summary, status);

    const meta = document.createElement('div');
    meta.className = 'mutation-meta';
    meta.textContent =
      new Date(record.createdAt).toLocaleString() +
      ' · ' +
      record.id.slice(0, 8);

    row.append(head, meta);
    if (record.reason) {
      const reason = document.createElement('div');
      reason.className = 'mutation-reason';
      reason.textContent = record.reason.slice(0, 280);
      row.appendChild(reason);
    }

    if (record.artifacts?.length) {
      const outputs = document.createElement('div');
      outputs.className = 'mutation-artifacts';
      outputs.textContent =
        'Outputs: ' +
        record.artifacts
          .map((artifact) => artifact.kind + ' · ' + artifact.path + (artifact.verified ? ' · verified' : ' · not verified'))
          .join(' · ')
          .slice(0, 700);
      row.appendChild(outputs);
    }

    if (record.status === 'undoable') {
      const undo = document.createElement('button');
      undo.className = 'mutation-undo';
      undo.textContent = 'Undo';
      undo.addEventListener('click', async () => {
        if (!window.confirm('Undo this verified mutation?' + '\n\n' + record.summary)) return;
        undo.disabled = true;
        undo.textContent = 'Undoing…';
        const requestGeneration = mutationLoadGeneration;
        try {
          const next = await adi.mutations.undo(record.id);
          if (requestGeneration !== mutationLoadGeneration) {
            if (undo.isConnected) {
              undo.disabled = false;
              undo.textContent = 'Undo';
            }
            return;
          }
          mutationLoadGeneration += 1;
          renderMutations(next);
          addNotice('Mutation undone: ' + record.summary);
        } catch (error) {
          if (requestGeneration !== mutationLoadGeneration) {
            if (undo.isConnected) {
              undo.disabled = false;
              undo.textContent = 'Undo';
            }
            return;
          }
          addErrorEl('Undo was not applied: ' + (error as Error).message);
          undo.disabled = false;
          undo.textContent = 'Undo';
        }
      });
      row.appendChild(undo);
    }

    mutationsList.appendChild(row);
  }
}

async function loadMutations(records?: MutationView[]) {
  const generation = ++mutationLoadGeneration;
  try {
    const next = records ?? (await adi.mutations.list());
    if (generation !== mutationLoadGeneration) return;
    renderMutations(next);
  } catch (error) {
    if (generation !== mutationLoadGeneration) return;
    addErrorEl('Could not load the recovery journal: ' + (error as Error).message);
  }
}

mutationsRefreshButton.addEventListener('click', () => void loadMutations());
adi.mutations.onUpdate((records) => {
  mutationLoadGeneration += 1;
  try {
    renderMutations(records);
  } catch (error) {
    reportAsyncError('Could not refresh the recovery journal: ', error);
  }
});

$('btn-mcp-edit').addEventListener('click', async () => {
  try {
    const path = await adi.mcp.openConfig();
    addNotice(`Opened ${path}. Press Reload after saving.`);
  } catch (error) {
    addErrorEl('MCP config could not be opened: ' + (error as Error).message);
  }
});

$('btn-mcp-reload').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-mcp-reload');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const servers = await adi.mcp.reload();
    await loadMcp(servers);
    const up = servers.filter((s) => s.connected).length;
    addNotice(`MCP: ${up} of ${servers.length} server(s) connected.`);
  } catch (error) {
    addErrorEl('MCP reload failed: ' + (error as Error).message);
  } finally {
    btn.disabled = privacyMode.checked;
    btn.textContent = 'Reload';
  }
});

/* ---------------------------------------------------------------- models */

async function loadModels() {
  const generation = ++modelLoadGeneration;
  const mutationGeneration = modelMutationGeneration;
  const [models, settings] = await Promise.all([adi.models.list(), adi.settings.get()]);
  if (generation !== modelLoadGeneration || mutationGeneration !== modelMutationGeneration) return;
  modelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.note) opt.title = m.note;
    modelSelect.appendChild(opt);
  }
  const add = document.createElement('option');
  add.value = '__add__';
  add.textContent = '+ Add model…';
  add.title = 'Use a model id that is not in this list yet';
  modelSelect.appendChild(add);

  modelBadge.textContent = settings.model;
  modelSelect.value = settings.model;
  // A model saved from a previous session may not be in the list any more.
  if (!modelSelect.value) {
    const opt = document.createElement('option');
    opt.value = settings.model;
    opt.textContent = settings.model;
    modelSelect.insertBefore(opt, add);
    modelSelect.value = settings.model;
  }
}

/**
 * Approval mode. Auto-approval is easy to switch on and easy to forget, so the
 * state is shown permanently in the header and on the pet itself rather than
 * living only in a dropdown.
 */
async function loadMode() {
  const generation = ++modeLoadGeneration;
  const settings = await adi.settings.get();
  if (generation !== modeLoadGeneration) return;
  modeSelect.innerHTML = '';
  for (const m of APPROVAL_MODES) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    opt.title = m.note;
    modeSelect.appendChild(opt);
  }
  modeSelect.value = settings.approvalMode;
  privacyMode.checked = settings.privacyMode;
  reflectMode(settings.approvalMode);
  reflectPrivacyMode(settings.privacyMode);
}

/** Re-reads the real setting, so the indicator cannot drift from the truth. */
async function refreshModeIndicator() {
  const generation = ++modeLoadGeneration;
  const settings = await adi.settings.get();
  if (generation !== modeLoadGeneration) return;
  if (modeSelect.value !== settings.approvalMode) modeSelect.value = settings.approvalMode;
  privacyMode.checked = settings.privacyMode;
  reflectMode(settings.approvalMode);
  reflectPrivacyMode(settings.privacyMode);
}

type SavedPermission = Awaited<ReturnType<typeof adi.permissions.list>>[number];

function renderSavedPermissions(grants: SavedPermission[]) {
  permissionList.innerHTML = '';
  permissionsNote.textContent = grants.length
    ? 'Exact “Always allow” rules are listed here. Remove one to make Adi ask again.'
    : 'No saved approvals. “Always allow” is only available for safe, exact-match actions.';
  if (!grants.length) {
    const empty = document.createElement('div');
    empty.className = 'field-note';
    empty.textContent = 'No saved approvals.';
    permissionList.appendChild(empty);
    return;
  }

  for (const grant of grants) {
    const row = document.createElement('div');
    row.className = 'permission-row';

    const head = document.createElement('div');
    head.className = 'permission-head';
    const tool = document.createElement('span');
    tool.className = 'permission-tool';
    tool.textContent = grant.toolName;
    const date = document.createElement('span');
    date.className = 'permission-date';
    const when = new Date(grant.createdAt);
    date.textContent = Number.isFinite(when.getTime()) ? when.toLocaleString() : 'Unknown time';
    head.append(tool, date);

    const sample = document.createElement('div');
    sample.className = 'permission-sample';
    sample.textContent = grant.sample || 'No action summary recorded.';

    const remove = document.createElement('button');
    remove.className = 'btn btn-ghost permission-remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Remove this saved approval?\n\n' + grant.toolName + ': ' + grant.sample)) return;
      remove.disabled = true;
      const mutationGeneration = ++permissionMutationGeneration;
      try {
        const updated = await adi.permissions.remove(grant.signature);
        if (mutationGeneration !== permissionMutationGeneration) {
          if (remove.isConnected) {
            remove.disabled = false;
            remove.textContent = 'Remove';
          }
          fireAndReport(loadSavedPermissions(), 'Could not reconcile saved approvals: ');
          return;
        }
        permissionLoadGeneration += 1;
        renderSavedPermissions(updated);
        addNotice('Saved approval removed.');
      } catch (error) {
        if (mutationGeneration !== permissionMutationGeneration) {
          if (remove.isConnected) {
            remove.disabled = false;
            remove.textContent = 'Remove';
          }
          fireAndReport(loadSavedPermissions(), 'Could not reconcile saved approvals: ');
          return;
        }
        addErrorEl('Could not remove saved approval: ' + (error as Error).message);
        remove.disabled = false;
        remove.textContent = 'Remove';
      }
    });

    row.append(head, sample, remove);
    permissionList.appendChild(row);
  }
}

async function loadSavedPermissions(view?: SavedPermission[]) {
  const generation = ++permissionLoadGeneration;
  try {
    const next = view ?? (await adi.permissions.list());
    if (generation !== permissionLoadGeneration) return;
    renderSavedPermissions(next);
  } catch (error) {
    if (generation !== permissionLoadGeneration) return;
    addErrorEl('Could not load saved approvals: ' + (error as Error).message);
  }
}

permissionsRefreshButton.addEventListener('click', () =>
  fireAndReport(loadSavedPermissions(), 'Could not load saved approvals: '),
);

function reflectMode(mode: string) {
  const note = APPROVAL_MODES.find((m) => m.id === mode)?.note ?? '';
  const noteEl = document.getElementById('mode-note');
  if (noteEl) noteEl.textContent = note;
  const auto = mode !== 'ask';
  autoPill.hidden = !auto;
  autoPill.textContent = mode === 'auto' ? 'FULL AUTO' : 'AUTO EDITS';
  autoPill.className = `auto-pill${mode === 'auto' ? ' full' : ''}`;
  // Carries the mode itself, so the pet can distinguish them like the pill does.
  pet.dataset.auto = auto ? mode : 'off';
}

function reflectPrivacyMode(enabled: boolean) {
  privacyPill.hidden = !enabled;
  privacyPill.title = enabled ? 'Privacy pause is on' : '';
  privacyPill.setAttribute('aria-label', enabled ? 'Privacy pause is on' : '');
  privacyBadge.hidden = !enabled;
  privacyBadge.title = enabled ? 'Privacy pause is on' : '';
  pet.dataset.privacy = enabled ? 'on' : 'off';
  pet.setAttribute('aria-label', enabled ? 'Open chat — privacy pause is on' : 'Open chat');
  input.disabled = enabled;
  quickInput.disabled = enabled;
  btnSend.disabled = enabled;
  $<HTMLButtonElement>('btn-attach').disabled = enabled;
  $<HTMLButtonElement>('btn-screen').disabled = enabled;
  $<HTMLButtonElement>('btn-quick-screen').disabled = enabled;
  clipboardButton.disabled = enabled;
  $<HTMLButtonElement>('btn-mcp-reload').disabled = enabled;
  $<HTMLButtonElement>('btn-check').disabled = enabled;
  profileSelect.disabled = enabled;
  btnVoice.disabled = enabled;
  btnQuickVoice.disabled = enabled;
  btnSpeak.disabled = enabled;
  btnQuickSpeak.disabled = enabled;
  if (enabled) {
    quickScreenshot = [];
    setQuickScreenState();
    const kept = pendingAttachments.filter((attachment) => attachment.source !== 'screen');
    if (kept.length !== pendingAttachments.length) {
      pendingAttachments = kept;
      renderAttachments();
    }
    if (dictating) fireAndReport(stopDictation(), 'Could not stop dictation: ');
    speech.stop();
    adi.voice.stopSpeaking();
  }
  renderPetStatus();
}

modeSelect.addEventListener('change', async () => {
  const generation = ++modeLoadGeneration;
  const mode = modeSelect.value;
  try {
    await adi.settings.set('approvalMode', mode);
    if (generation !== modeLoadGeneration) return;
    reflectMode(mode);
    if (mode === 'auto') {
      addNotice(
        'Full auto enabled: every confirm-tier action runs without asking. ' +
          'Permanently blocked actions stay blocked.',
      );
    } else if (mode === 'auto-edit') {
      addNotice('Auto edits: file changes run without asking; shell and settings still ask.');
    } else {
      addNotice('Back to asking before anything that changes your machine.');
    }
  } catch (error) {
    if (generation !== modeLoadGeneration) return;
    reportAsyncError('Could not save approval mode: ', error);
    fireAndReport(refreshModeIndicator(), 'Could not restore approval mode: ');
  }
});

/** Reasoning effort: how hard the model thinks before answering. */
async function loadEffort() {
  const generation = ++effortLoadGeneration;
  const mutationGeneration = effortMutationGeneration;
  const settings = await adi.settings.get();
  if (generation !== effortLoadGeneration || mutationGeneration !== effortMutationGeneration) return;
  effortSelect.innerHTML = '';
  for (const level of REASONING_LEVELS) {
    const opt = document.createElement('option');
    opt.value = level.id;
    opt.textContent = level.label;
    opt.title = level.note;
    effortSelect.appendChild(opt);
  }
  effortSelect.value = settings.reasoningEffort;
}

effortSelect.addEventListener('change', async () => {
  const generation = ++effortMutationGeneration;
  const value = effortSelect.value;
  const label = effortSelect.options[effortSelect.selectedIndex]?.textContent ?? value;
  effortSelect.disabled = true;
  try {
    await adi.settings.set('reasoningEffort', value);
    if (generation !== effortMutationGeneration) return;
    addNotice(`Reasoning effort: ${label}`);
  } catch (error) {
    if (generation !== effortMutationGeneration) return;
    reportAsyncError('Could not save reasoning effort: ', error);
    fireAndReport(loadEffort(), 'Could not restore reasoning effort: ');
  } finally {
    if (generation === effortMutationGeneration) effortSelect.disabled = privacyMode.checked;
  }
});

/**
 * Which browser the agent drives. The isolated pet profile is the default; the
 * real profiles carry the user's logins, which is what Classroom/ManageBac need.
 */
async function loadProfiles() {
  const generation = ++profileLoadGeneration;
  const mutationGeneration = profileMutationGeneration;
  const settings = await adi.settings.get();
  if (generation !== profileLoadGeneration || mutationGeneration !== profileMutationGeneration) return;

  if (privacyMode.checked || settings.privacyMode) {
    profileSelect.innerHTML = '';
    const paused = document.createElement('option');
    paused.value = 'pet';
    paused.textContent = 'Browser profiles paused';
    paused.title = 'Privacy pause is on; real browser profile metadata is not read.';
    profileSelect.appendChild(paused);
    profileSelect.value = 'pet';
    profileSelect.disabled = true;
    browserProfileNote.textContent = 'Privacy pause is on; real browser profile metadata is not read.';
    return;
  }

  const profiles = await adi.chrome.profiles();
  if (generation !== profileLoadGeneration || mutationGeneration !== profileMutationGeneration || privacyMode.checked) return;
  profileSelect.disabled = false;
  profileSelect.innerHTML = '';

  const petProfile = document.createElement('option');
  petProfile.value = 'pet';
  petProfile.textContent = 'Pet browser';
  petProfile.title = 'Isolated profile with none of your logins';
  profileSelect.appendChild(petProfile);

  for (const profile of profiles) {
    const opt = document.createElement('option');
    opt.value = `system:${profile.dir}`;
    opt.textContent = profile.email ? `${profile.name} (${profile.email})` : profile.name;
    opt.title = `Your real Chrome profile ${profile.dir} — reused when connected; switching may require Chrome to be closed`;
    profileSelect.appendChild(opt);
  }

  profileSelect.value =
    settings.chromeMode === 'system' ? `system:${settings.chromeProfileDir}` : 'pet';
  if (!profileSelect.value) profileSelect.value = 'pet';
  browserProfileNote.textContent = profiles.length
    ? 'Real profiles carry your logins. Adi reuses a connected session; only switching profiles or attaching to a non-automated session may require closing Chrome once.'
    : 'No real Chrome profiles were found. Refresh after opening Chrome once.';
}

profileSelect.addEventListener('change', async () => {
  const generation = ++profileMutationGeneration;
  const value = profileSelect.value;
  const wasDisabled = profileSelect.disabled;
  profileSelect.disabled = true;
  profileRefreshButton.disabled = true;
  try {
    if (value === 'pet') {
      await adi.settings.set('chromeMode', 'pet');
      if (generation !== profileMutationGeneration) return;
      addNotice('Browsing with the isolated pet profile.');
    } else {
      const dir = value.slice('system:'.length);
      // Save the directory while still in pet mode, then cross the browser
      // boundary once. The old order caused two shutdowns for one selection.
      await adi.settings.set('chromeProfileDir', dir);
      await adi.settings.set('chromeMode', 'system');
      if (generation !== profileMutationGeneration) return;
      addNotice(
        `Browsing with your real Chrome profile "${dir}". Adi will reuse it if automation is connected; if it is open without automation, close Chrome once before the first browser action.`,
      );
    }
  } catch (error) {
    if (generation !== profileMutationGeneration) return;
    reportAsyncError('Could not save browser profile: ', error);
    fireAndReport(loadProfiles(), 'Could not restore browser profile: ');
  } finally {
    if (generation === profileMutationGeneration) {
      profileSelect.disabled = privacyMode.checked || wasDisabled;
      profileRefreshButton.disabled = privacyMode.checked;
    }
  }
});

profileRefreshButton.addEventListener('click', () =>
  fireAndReport(loadProfiles().then(() => addNotice('Browser profiles refreshed.')), 'Could not refresh browser profiles: '),
);

modelSelect.addEventListener('change', async () => {
  const generation = ++modelMutationGeneration;
  const value = modelSelect.value;
  const label = modelSelect.options[modelSelect.selectedIndex]?.textContent ?? value;
  const wasDisabled = modelSelect.disabled;
  modelSelect.disabled = true;
  try {
    if (value === '__add__') {
      const id = await requestText(
        'Model id to add (e.g. a newly released one). Press Check afterwards to test it against your account.',
      );
      await loadModels();
      if (generation !== modelMutationGeneration) return;
      if (id && id.trim()) {
        const trimmed = id.trim();
        await adi.models.add(trimmed);
        if (generation !== modelMutationGeneration) return;
        await loadModels();
        if (generation !== modelMutationGeneration) return;
        modelSelect.value = trimmed;
        await adi.settings.set('model', trimmed);
        if (generation !== modelMutationGeneration) return;
        addNotice(`Added ${trimmed}. Press Check to confirm your plan allows it.`);
      }
      return;
    }
    await adi.settings.set('model', value);
    if (generation !== modelMutationGeneration) return;
    modelBadge.textContent = value;
    addNotice(`Model set to ${label}`);
  } catch (error) {
    if (generation !== modelMutationGeneration) return;
    reportAsyncError('Could not save the model: ', error);
    fireAndReport(loadModels(), 'Could not restore the model list: ');
  } finally {
    if (generation === modelMutationGeneration) modelSelect.disabled = wasDisabled;
  }
});

/** Availability depends on the plan, so ask the account directly. */
$('btn-check').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('btn-check');
  const generation = ++modelMutationGeneration;
  const wasDisabled = modelSelect.disabled;
  button.disabled = true;
  modelSelect.disabled = true;
  button.textContent = 'Checking…';
  try {
    const results = await adi.models.probe();
    const models = await adi.models.list();
    if (generation !== modelMutationGeneration) return;
    for (const result of results) {
      let option = [...modelSelect.options].find((candidate) => candidate.value === result.id);
      const label = models.find((model) => model.id === result.id)?.label ?? result.id;
      if (!option && result.ok) {
        option = document.createElement('option');
        option.value = result.id;
        option.textContent = label;
        const add = [...modelSelect.options].find((candidate) => candidate.value === '__add__');
        modelSelect.insertBefore(option, add ?? null);
      }
      if (option) {
        option.textContent = result.ok ? `${label} ✓` : `${label} — unavailable`;
        option.disabled = !result.ok;
        option.title = result.detail;
      }
    }
    const usable = results.filter((result) => result.ok);
    if (usable.length) {
      addNotice(`Available on your plan: ${usable.map((result) => result.id).join(', ')}`);
      if (modelSelect.selectedOptions[0]?.disabled) {
        const next = usable[0]?.id;
        if (!next) return;
        modelSelect.value = next;
        await adi.settings.set('model', next);
        if (generation !== modelMutationGeneration) return;
        modelBadge.textContent = next;
        addNotice(`Switched to ${next}.`);
      }
    } else {
      addErrorEl('No model was accepted. First reason: ' + (results[0]?.detail ?? 'unknown'));
    }
  } catch (error) {
    if (generation !== modelMutationGeneration) return;
    addErrorEl('Model check failed: ' + errorMessage(error));
  } finally {
    if (generation === modelMutationGeneration) {
      modelSelect.disabled = wasDisabled;
      button.disabled = privacyMode.checked;
      button.textContent = 'Check';
    }
  }
});


/* --------------------------------------------------------- conversations */

function relativeTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function timeLeft(expiresAt: number): string {
  const minutes = Math.round((expiresAt - Date.now()) / 60_000);
  if (minutes <= 0) return 'expiring now';
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

type SidebarTab = 'chat' | 'quick' | 'goals' | 'archived' | 'studio';

function setStudioVisible(visible: boolean): void {
  toolStudioPanel.hidden = !visible;
  messagesEl.hidden = visible;
  composer.hidden = visible;
  selectionActions.hidden = visible || !selectedTranscriptText;
  attachments.hidden = visible || pendingAttachments.length === 0;
  if (visible) voiceBar.hidden = true;
  else voiceBar.hidden = !dictating || dictationTarget !== 'chat';
  chat.classList.toggle('studio-mode', visible);
  sidebar.classList.toggle('studio-mode', visible);
  if (activeRequest) renderPermission();
}
let sidebarTab: SidebarTab = 'chat';

const SEARCH_KIND_LABELS: Record<LocalSearchResult['kind'], string> = {
  conversation: 'Conversation',
  memory: 'Saved note',
  goal: 'Goal',
  assignment: 'Assignment',
  research: 'Research',
  project: 'Project',
  file: 'Local file',
  workflow: 'Workflow',
};

const REFERENCE_KIND_LABELS: Record<ConversationReferenceKind, string> = {
  file: 'File',
  goal: 'Goal',
  assignment: 'Assignment',
  project: 'Project',
};

function selectedFolderId(): number | undefined {
  const value = conversationFolderFilter.value;
  if (!value) return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : undefined;
}

function updateFolderControls(): void {
  const hasFolder = conversationFolderFilter.value !== '' && conversationFolderFilter.value !== '0';
  folderNewButton.disabled = folderMutationInFlight;
  folderRenameButton.disabled = folderMutationInFlight || !hasFolder;
  folderDeleteButton.disabled = folderMutationInFlight || !hasFolder;
}

async function loadConversationFolders(): Promise<void> {
  const generation = ++folderLoadGeneration;
  const selected = conversationFolderFilter.value;
  const folders = await adi.chat.folders();
  if (generation !== folderLoadGeneration) return;
  conversationFolders = folders;
  conversationFolderFilter.innerHTML = '';

  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All folders';
  conversationFolderFilter.appendChild(all);

  const unfiled = document.createElement('option');
  unfiled.value = '0';
  unfiled.textContent = 'Unfiled';
  conversationFolderFilter.appendChild(unfiled);

  for (const folder of folders) {
    const option = document.createElement('option');
    option.value = String(folder.id);
    option.textContent = `${folder.name} (${folder.conversationCount})`;
    conversationFolderFilter.appendChild(option);
  }

  const stillExists = selected === '' || selected === '0' || folders.some((folder) => String(folder.id) === selected);
  conversationFolderFilter.value = stillExists ? selected : '';
  updateFolderControls();
}

function renderSearchResults(query: string, results: LocalSearchResult[]): void {
  searchResults.innerHTML = '';
  searchResults.hidden = false;
  if (query.trim().length < 2) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'Type at least 2 characters to search.';
    searchResults.appendChild(empty);
    return;
  }
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent =
      'No matches in chats, notes, goals, assignments, research, projects, workflows, or enabled local files.';
    searchResults.appendChild(empty);
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'search-summary';
  summary.textContent = `${results.length} ${results.length === 1 ? 'result' : 'results'}`;
  searchResults.appendChild(summary);

  for (const result of results) {
    const row = document.createElement('div');
    row.className = 'search-result';
    const isConversation = result.kind === 'conversation';
    if (isConversation) {
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = 'Open conversation';
    }

    const title = document.createElement('div');
    title.className = 'search-result-title';
    title.textContent = result.title;
    const meta = document.createElement('div');
    meta.className = 'search-result-meta';
    const kind = isConversation
      ? result.conversationKind === 'quick'
        ? 'Quick chat'
        : result.archived
          ? 'Archived conversation'
          : 'Conversation'
      : SEARCH_KIND_LABELS[result.kind];
    meta.textContent = [kind, result.updatedAt > 0 ? relativeTime(result.updatedAt) : ''].filter(Boolean).join(' · ');
    const snippet = document.createElement('div');
    snippet.className = 'search-result-snippet';
    snippet.textContent = result.snippet;

    const actions = document.createElement('div');
    actions.className = 'search-result-actions';
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn btn-ghost search-result-use';
    use.textContent = 'Use excerpt';
    use.title = 'Add this bounded excerpt to the draft for review';
    use.addEventListener('click', (event) => {
      event.stopPropagation();
      fireAndReport(
        (async () => {
          await toggleExpanded(true);
          putTextIntoDraft(result.snippet, 'Local search excerpt added to the draft. Review it before sending.');
        })(),
        'Could not add the search excerpt to the draft: ',
      );
    });
    actions.appendChild(use);
    row.append(title, meta, snippet, actions);

    if (isConversation) {
      const open = () => {
        const id = Number(result.id);
        if (!Number.isInteger(id) || id < 1) return;
        workspaceSearch.value = '';
        workspaceSearchClear.hidden = true;
        sidebarTab = result.archived ? 'archived' : result.conversationKind === 'quick' ? 'quick' : 'chat';
        fireAndReport(openConversation(id), 'Could not open conversation: ');
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      });
    }
    searchResults.appendChild(row);
  }
}

async function runWorkspaceSearch(query: string): Promise<void> {
  const generation = ++searchLoadGeneration;
  const settingsGeneration = settingsMutationGeneration;
  const normalized = query.trim();
  if (normalized.length < 2) {
    renderSearchResults(normalized, []);
    return;
  }
  const results = await adi.workspace.search(normalized);
  if (
    generation !== searchLoadGeneration ||
    settingsGeneration !== settingsMutationGeneration ||
    workspaceSearch.value.trim() !== normalized
  ) return;
  renderSearchResults(normalized, results);
}

function clearWorkspaceSearch(): void {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  searchLoadGeneration += 1;
  workspaceSearch.value = '';
  workspaceSearchClear.hidden = true;
  fireAndReport(loadConversations(), 'Could not load conversations: ');
}

async function removeConversationReference(reference: ConversationReference): Promise<void> {
  const id = conversationId;
  const mutationGeneration = ++referenceMutationGeneration;
  try {
    const references = await adi.chat.removeReference(id, reference.id);
    if (mutationGeneration !== referenceMutationGeneration || id !== conversationId) return;
    renderConversationReferences(references);
    fireAndReport(loadConversations(), 'Could not refresh conversations: ');
  } catch (error) {
    if (mutationGeneration !== referenceMutationGeneration || id !== conversationId) return;
    reportAsyncError('Could not remove the reference: ', error);
  }
}

function renderConversationReferences(references: ConversationReference[]): void {
  referencesList.innerHTML = '';
  referencesButton.title = references.length
    ? `${references.length} linked reference${references.length === 1 ? '' : 's'} · Show conversation references`
    : 'Show conversation references';
  referencesButton.setAttribute('aria-label', referencesButton.title);
  referencesNote.textContent =
    'Explicit links stay as local metadata. File paths are shown here only; this panel never reads or sends file contents.';
  if (!references.length) {
    const empty = document.createElement('div');
    empty.className = 'reference-empty';
    empty.textContent = 'No references linked to this conversation yet.';
    referencesList.appendChild(empty);
    return;
  }

  for (const reference of references) {
    const row = document.createElement('div');
    row.className = 'reference-row';
    const head = document.createElement('div');
    head.className = 'reference-row-head';
    const kind = document.createElement('span');
    kind.className = 'reference-kind';
    kind.textContent = REFERENCE_KIND_LABELS[reference.kind] ?? reference.kind;
    const label = document.createElement('span');
    label.className = 'reference-label';
    label.textContent = reference.label;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn danger reference-remove';
    remove.textContent = '×';
    remove.title = 'Remove reference';
    remove.setAttribute('aria-label', 'Remove ' + reference.label);
    remove.addEventListener('click', () => {
      const expectedConversationId = conversationId;
      const expectedMutationGeneration = referenceMutationGeneration + 1;
      if (reference.conversationId !== expectedConversationId) return;
      remove.disabled = true;
      fireAndReport(
        removeConversationReference(reference).finally(() => {
          if (
            remove.isConnected &&
            conversationId === expectedConversationId &&
            referenceMutationGeneration === expectedMutationGeneration
          ) {
            remove.disabled = false;
          }
        }),
        'Could not remove the reference: ',
      );
    });
    head.append(kind, label, remove);

    const target = document.createElement('div');
    target.className = 'reference-target';
    target.textContent = reference.kind === 'file' ? reference.reference : `${reference.reference} · ${reference.label}`;
    row.append(head, target);
    referencesList.appendChild(row);
  }
}

async function loadConversationReferences(): Promise<void> {
  const generation = ++referenceLoadGeneration;
  const id = conversationId;
  if (!id) {
    renderConversationReferences([]);
    return;
  }
  try {
    const references = await adi.chat.references(id);
    if (generation !== referenceLoadGeneration || id !== conversationId) return;
    renderConversationReferences(references);
  } catch (error) {
    if (generation !== referenceLoadGeneration || id !== conversationId) return;
    referencesList.innerHTML = '';
    referencesNote.textContent = 'References are unavailable for this conversation.';
    reportAsyncError('Could not load conversation references: ', error);
  }
}

async function addConversationReference(kind: ConversationReferenceKind): Promise<void> {
  if (!conversationId) return;
  const label = REFERENCE_KIND_LABELS[kind];
  const prompt = kind === 'file'
    ? 'Enter an absolute file path to link (metadata only):'
    : `Enter a ${label.toLowerCase()} id or exact title:`;
  const target = await requestText(prompt);
  if (target === null || !target.trim()) return;
  const id = conversationId;
  const mutationGeneration = ++referenceMutationGeneration;
  try {
    const references = await adi.chat.addReference(id, kind, target.trim());
    if (mutationGeneration !== referenceMutationGeneration || id !== conversationId) return;
    renderConversationReferences(references);
    await loadConversations();
    if (mutationGeneration !== referenceMutationGeneration || id !== conversationId) return;
    addNotice(`Linked ${label.toLowerCase()} to this conversation.`);
  } catch (error) {
    if (mutationGeneration !== referenceMutationGeneration || id !== conversationId) return;
    reportAsyncError('Could not link the reference: ', error);
  }
}

async function moveConversation(conversation: Awaited<ReturnType<typeof adi.chat.list>>[number]): Promise<void> {
  if (conversation.kind !== 'chat' || folderMutationInFlight) return;
  const answer = await requestText(
    `Move to a folder. Enter an exact folder name, or leave blank for Unfiled.\n\nAvailable: ${
      conversationFolders.length ? conversationFolders.map((folder) => folder.name).join(', ') : '(none)'
    }`,
    conversation.folderName ?? '',
  );
  if (answer === null) return;
  const name = answer.trim();
  const folder = name
    ? conversationFolders.find((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    : undefined;
  if (name && !folder) {
    addNotice('No exact folder match. Create it first or leave the field blank for Unfiled.');
    return;
  }
  if (folderMutationInFlight) return;
  folderMutationInFlight = true;
  updateFolderControls();
  try {
    await adi.chat.setFolder(conversation.id, folder?.id ?? null);
    await loadConversationFolders();
    await loadConversations();
    addNotice(folder ? `Moved conversation to ${folder.name}.` : 'Conversation moved to Unfiled.');
  } catch (error) {
    reportAsyncError('Could not move the conversation: ', error);
  } finally {
    folderMutationInFlight = false;
    updateFolderControls();
  }
}

async function createConversationFolder(): Promise<void> {
  if (folderMutationInFlight) return;
  const name = await requestText('Create conversation folder');
  if (name === null || !name.trim()) return;
  folderMutationInFlight = true;
  updateFolderControls();
  try {
    const folder = await adi.chat.createFolder(name.trim());
    await loadConversationFolders();
    conversationFolderFilter.value = String(folder.id);
    updateFolderControls();
    await loadConversations();
    addNotice('Created folder: ' + folder.name);
  } catch (error) {
    reportAsyncError('Could not create the conversation folder: ', error);
  } finally {
    folderMutationInFlight = false;
    updateFolderControls();
  }
}

async function renameConversationFolder(): Promise<void> {
  if (folderMutationInFlight) return;
  const id = selectedFolderId();
  const folder = id === undefined ? undefined : conversationFolders.find((candidate) => candidate.id === id);
  if (!folder) return;
  const name = await requestText('Rename conversation folder', folder.name);
  if (name === null || !name.trim()) return;
  folderMutationInFlight = true;
  updateFolderControls();
  try {
    const updated = await adi.chat.renameFolder(folder.id, name.trim());
    await loadConversationFolders();
    conversationFolderFilter.value = String(updated.id);
    updateFolderControls();
    await loadConversations();
    addNotice('Renamed folder to: ' + updated.name);
  } catch (error) {
    reportAsyncError('Could not rename the conversation folder: ', error);
  } finally {
    folderMutationInFlight = false;
    updateFolderControls();
  }
}

async function deleteConversationFolder(): Promise<void> {
  if (folderMutationInFlight) return;
  const id = selectedFolderId();
  const folder = id === undefined ? undefined : conversationFolders.find((candidate) => candidate.id === id);
  if (!folder || !window.confirm(`Delete the folder "${folder.name}"? Conversations will become unfiled.`)) return;
  folderMutationInFlight = true;
  updateFolderControls();
  try {
    await adi.chat.removeFolder(folder.id);
    conversationFolderFilter.value = '';
    await loadConversationFolders();
    await loadConversations();
    addNotice('Deleted folder: ' + folder.name);
  } catch (error) {
    reportAsyncError('Could not delete the conversation folder: ', error);
  } finally {
    folderMutationInFlight = false;
    updateFolderControls();
  }
}

async function loadConversations(): Promise<void> {
  const generation = ++conversationLoadGeneration;
  const tab = sidebarTab;
  if (tab === 'studio') {
    searchResults.hidden = true;
    quickNote.hidden = true;
    archiveNote.hidden = true;
    $('goal-note').hidden = true;
    conversationFolderFilter.hidden = true;
    folderNewButton.hidden = true;
    folderRenameButton.hidden = true;
    folderDeleteButton.hidden = true;
    $('tab-chats').classList.toggle('active', false);
    $('tab-quick').classList.toggle('active', false);
    $('tab-goals').classList.toggle('active', false);
    $('tab-archived').classList.toggle('active', false);
    $('tab-studio').classList.toggle('active', true);
    $('tab-chats').setAttribute('aria-selected', 'false');
    $('tab-quick').setAttribute('aria-selected', 'false');
    $('tab-goals').setAttribute('aria-selected', 'false');
    $('tab-archived').setAttribute('aria-selected', 'false');
    $('tab-studio').setAttribute('aria-selected', 'true');
    convoList.hidden = true;
    $('goal-list').hidden = true;
    setStudioVisible(true);
    await (await ensureToolStudio()).load();
    if (generation !== conversationLoadGeneration || sidebarTab !== tab) return;
    return;
  }
  setStudioVisible(false);
  const query = workspaceSearch.value.trim();
  if (query) {
    await runWorkspaceSearch(query);
    return;
  }

  searchResults.hidden = true;
  quickNote.hidden = tab !== 'quick';
  archiveNote.hidden = tab !== 'archived';
  const goalTab = tab === 'goals';
  $('goal-note').hidden = !goalTab;
  $('tab-chats').classList.toggle('active', tab === 'chat');
  $('tab-quick').classList.toggle('active', tab === 'quick');
  $('tab-goals').classList.toggle('active', goalTab);
  $('tab-archived').classList.toggle('active', tab === 'archived');
  $('tab-chats').setAttribute('aria-selected', String(tab === 'chat'));
  $('tab-quick').setAttribute('aria-selected', String(tab === 'quick'));
  $('tab-goals').setAttribute('aria-selected', String(goalTab));
  $('tab-archived').setAttribute('aria-selected', String(tab === 'archived'));
  conversationFolderFilter.hidden = goalTab || tab === 'archived';
  folderNewButton.hidden = goalTab || tab === 'archived';
  folderRenameButton.hidden = goalTab || tab === 'archived';
  folderDeleteButton.hidden = goalTab || tab === 'archived';

  if (goalTab) {
    convoList.hidden = true;
    $('goal-list').hidden = false;
    await loadGoals();
    if (generation !== conversationLoadGeneration || sidebarTab !== tab) return;
    return;
  }

  convoList.hidden = false;
  $('goal-list').hidden = true;
  const conversations = await adi.chat.list(tab === 'archived' ? 'chat' : tab, tab === 'archived', selectedFolderId());
  if (generation !== conversationLoadGeneration || sidebarTab !== tab || workspaceSearch.value.trim()) return;

  convoList.innerHTML = '';
  if (!conversations.length) {
    const empty = document.createElement('div');
    empty.className = 'convo-empty';
    empty.textContent = tab === 'quick'
      ? 'Nothing asked from the pet yet.'
      : tab === 'archived'
        ? 'No archived conversations yet.'
        : 'No conversations yet.';
    convoList.appendChild(empty);
    return;
  }

  for (const conversation of conversations) {
    const row = document.createElement('div');
    row.className = `convo${conversation.id === conversationId ? ' active' : ''}`;

    const text = document.createElement('div');
    text.className = 'convo-text';
    const title = document.createElement('div');
    title.className = 'convo-title';
    title.textContent = conversation.title || 'New chat';
    text.appendChild(title);
    if (conversation.summary) {
      const summary = document.createElement('div');
      summary.className = 'convo-summary';
      summary.textContent = conversation.summary;
      summary.title = 'Stored compaction summary';
      text.appendChild(summary);
    }
    const meta = document.createElement('div');
    meta.className = 'convo-meta';
    const state = conversation.kind === 'quick'
      ? conversation.starred
        ? 'kept'
        : conversation.expiresAt
          ? timeLeft(conversation.expiresAt)
          : ''
      : [
          conversation.archived ? 'archived' : '',
          conversation.starred ? 'pinned' : '',
          conversation.folderName ? 'folder: ' + conversation.folderName : '',
          conversation.referenceCount
            ? `${conversation.referenceCount} reference${conversation.referenceCount === 1 ? '' : 's'}`
            : '',
        ].filter(Boolean).join(' · ');
    meta.textContent =
      `${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'} · ${relativeTime(conversation.updatedAt)}` +
      (state ? ` · ${state}` : '');
    text.appendChild(meta);
    text.addEventListener('click', () => fireAndReport(openConversation(conversation.id), 'Could not open conversation: '));

    const actions = document.createElement('div');
    actions.className = 'convo-actions';

    const star = document.createElement('button');
    star.className = `icon-btn star${conversation.starred ? ' on' : ''}`;
    star.textContent = conversation.starred ? '★' : '☆';
    star.title = conversation.kind === 'quick'
      ? conversation.starred ? 'Kept — click to let it expire' : 'Keep this one'
      : conversation.starred ? 'Pinned — click to unpin' : 'Pin this conversation';
    star.setAttribute('aria-label', star.title);
    star.addEventListener('click', (event) => {
      event.stopPropagation();
      star.disabled = true;
      fireAndReport(
        adi.chat.star(conversation.id, !conversation.starred).then(() => loadConversations()).finally(() => {
          if (star.isConnected) star.disabled = false;
        }),
        'Could not update the conversation: ',
      );
    });
    actions.appendChild(star);

    if (conversation.kind === 'chat') {
      const archive = document.createElement('button');
      archive.className = 'icon-btn';
      archive.textContent = conversation.archived ? '↩' : '🗄';
      archive.title = conversation.archived ? 'Restore conversation' : 'Archive conversation';
      archive.setAttribute('aria-label', archive.title);
      archive.addEventListener('click', (event) => {
        event.stopPropagation();
        archive.disabled = true;
        fireAndReport(
          adi.chat.archive(conversation.id, !conversation.archived).then(() => loadConversations()).finally(() => {
            if (archive.isConnected) archive.disabled = false;
          }),
          'Could not update the archived state: ',
        );
      });
      actions.appendChild(archive);
    }

    if (conversation.kind === 'chat' && !conversation.archived) {
      const folder = document.createElement('button');
      folder.className = 'icon-btn';
      folder.textContent = '📁';
      folder.title = conversation.folderName ? `Move from ${conversation.folderName}` : 'Move to folder';
      folder.setAttribute('aria-label', 'Move conversation to a folder');
      folder.addEventListener('click', (event) => {
        event.stopPropagation();
        fireAndReport(moveConversation(conversation), 'Could not move the conversation: ');
      });
      actions.appendChild(folder);
    }

    const rename = document.createElement('button');
    rename.className = 'icon-btn';
    rename.textContent = '✎';
    rename.title = 'Rename';
    rename.setAttribute('aria-label', 'Rename conversation');
    rename.addEventListener('click', async (event) => {
      event.stopPropagation();
      const next = await requestText('Rename conversation', conversation.title);
      if (!next || !next.trim()) return;
      rename.disabled = true;
      fireAndReport(
        adi.chat.rename(conversation.id, next.trim()).then(async () => {
          if (conversation.id === conversationId) convoTitle.textContent = next.trim();
          await loadConversations();
        }).finally(() => {
          if (rename.isConnected) rename.disabled = false;
        }),
        'Could not rename the conversation: ',
      );
    });

    const remove = document.createElement('button');
    remove.className = 'icon-btn danger';
    remove.textContent = '🗑';
    remove.title = 'Delete';
    remove.setAttribute('aria-label', 'Delete conversation');
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!window.confirm(`Delete "${conversation.title}"? This cannot be undone.`)) return;
      if (conversation.id === conversationId && blockConversationNavigation()) return;
      remove.disabled = true;
      fireAndReport(
        (async () => {
          await adi.chat.remove(conversation.id);
          if (conversation.id === conversationId) {
            const rest = await adi.chat.list(sidebarTab === 'archived' ? 'chat' : sidebarTab === 'quick' ? 'quick' : 'chat', sidebarTab === 'archived', selectedFolderId());
            const nextConversation = rest[0];
            if (nextConversation) await openConversation(nextConversation.id);
            else await newConversation();
          }
          await loadConversations();
        })().finally(() => {
          if (remove.isConnected) remove.disabled = false;
        }),
        'Could not delete the conversation: ',
      );
    });
    actions.append(rename, remove);
    row.append(text, actions);
    convoList.appendChild(row);
  }
}

function conversationTurnActive(): boolean {
  return chatSubmitInFlight || quickSubmitInFlight || streaming || quickActive || Boolean(activeStream);
}
function blockConversationNavigation(): boolean {
  if (!conversationTurnActive()) return false;
  addNotice('Wait for the current response to finish, or cancel it from Activity, before changing conversations.');
  return true;
}
async function openConversation(id: number): Promise<void> {
  if (blockConversationNavigation()) return;
  const generation = ++conversationOpenGeneration;
  branchButton.disabled = false;
  referenceLoadGeneration += 1;
  referenceMutationGeneration += 1;
  renderConversationReferences([]);
  const result = await adi.chat.open(id);
  if (generation !== conversationOpenGeneration) return;
  conversationId = result.conversationId;
  renderHistory(result.messages);
  const conversations = await adi.chat.list(sidebarTab === 'archived' ? 'chat' : sidebarTab === 'quick' ? 'quick' : 'chat', sidebarTab === 'archived', selectedFolderId());
  if (generation !== conversationOpenGeneration) return;
  convoTitle.textContent = conversations.find((conversation) => conversation.id === id)?.title ?? 'Adi';
  await loadConversations();
  if (generation === conversationOpenGeneration) await loadConversationReferences();
}

async function branchConversation(): Promise<void> {
  if (!conversationId || blockConversationNavigation()) return;
  const generation = ++conversationOpenGeneration;
  referenceLoadGeneration += 1;
  referenceMutationGeneration += 1;
  renderConversationReferences([]);
  const conversations = [
    ...(await adi.chat.list('chat', false)),
    ...(await adi.chat.list('chat', true)),
  ];
  if (generation !== conversationOpenGeneration) return;
  const current = conversations.find((conversation) => conversation.id === conversationId);
  if (!current) {
    addNotice('The current conversation could not be found.');
    return;
  }
  if (current.kind !== 'chat') {
    addNotice('Quick chats cannot be branched; keep one first if it should become a regular thread.');
    return;
  }
  const defaultTitle = 'Branch: ' + (current.title || 'Conversation');
  const title = await requestText('Name this conversation branch', defaultTitle);
  if (title === null) return;
  if (generation !== conversationOpenGeneration) return;
  branchButton.disabled = true;
  try {
    const sourceConversationId = conversationId;
    const result = await adi.chat.branch(sourceConversationId, title.trim() || defaultTitle);
    if (generation !== conversationOpenGeneration) return;
    conversationId = result.conversationId;
    renderHistory(result.messages);
    convoTitle.textContent = title.trim() || defaultTitle;
    await loadConversationFolders();
    if (generation !== conversationOpenGeneration) return;
    await loadConversations();
    if (generation !== conversationOpenGeneration) return;
    await loadConversationReferences();
    if (generation !== conversationOpenGeneration) return;
    input.focus();
    addNotice('Created a local branch. The original conversation is unchanged.');
  } finally {
    if (generation === conversationOpenGeneration) branchButton.disabled = streaming;
  }
}

async function newConversation(): Promise<void> {
  if (blockConversationNavigation()) return;
  const generation = ++conversationOpenGeneration;
  branchButton.disabled = false;
  referenceLoadGeneration += 1;
  referenceMutationGeneration += 1;
  renderConversationReferences([]);
  const result = await adi.chat.newChat();
  if (generation !== conversationOpenGeneration) return;
  conversationId = result.conversationId;
  renderHistory(result.messages);
  convoTitle.textContent = 'New chat';
  sidebarTab = 'chat';
  await loadConversations();
  if (generation !== conversationOpenGeneration) return;
  await loadConversationReferences();
  if (generation !== conversationOpenGeneration) return;
  input.focus();
}

$('btn-new').addEventListener('click', () => fireAndReport(newConversation(), 'Could not start a new conversation: '));
branchButton.addEventListener('click', () => fireAndReport(branchConversation(), 'Could not branch the conversation: '));

$('tab-chats').addEventListener('click', () => {
  sidebarTab = 'chat';
  fireAndReport(loadConversations(), 'Could not load conversations: ');
});
$('tab-quick').addEventListener('click', () => {
  sidebarTab = 'quick';
  fireAndReport(loadConversations(), 'Could not load conversations: ');
});
$('tab-goals').addEventListener('click', () => {
  sidebarTab = 'goals';
  fireAndReport(loadConversations(), 'Could not load goals: ');
});
$('tab-archived').addEventListener('click', () => {
  sidebarTab = 'archived';
  fireAndReport(loadConversations(), 'Could not load archived conversations: ');
});
$('tab-studio').addEventListener('click', () => {
  sidebarTab = 'studio';
  fireAndReport(loadConversations(), 'Could not load Tool Studio: ');
});

conversationFolderFilter.addEventListener('change', () => {
  updateFolderControls();
  fireAndReport(loadConversations(), 'Could not filter conversations by folder: ');
});
folderNewButton.addEventListener('click', () => fireAndReport(createConversationFolder(), 'Could not create the conversation folder: '));
folderRenameButton.addEventListener('click', () => fireAndReport(renameConversationFolder(), 'Could not rename the conversation folder: '));
folderDeleteButton.addEventListener('click', () => fireAndReport(deleteConversationFolder(), 'Could not delete the conversation folder: '));

workspaceSearch.addEventListener('input', () => {
  const query = workspaceSearch.value.trim();
  workspaceSearchClear.hidden = !query;
  if (searchTimer) clearTimeout(searchTimer);
  if (!query) {
    searchLoadGeneration += 1;
    fireAndReport(loadConversations(), 'Could not load conversations: ');
    return;
  }
  searchTimer = setTimeout(() => {
    searchTimer = null;
    fireAndReport(runWorkspaceSearch(query), 'Could not search workspace: ');
  }, 180);
});
workspaceSearchClear.addEventListener('click', clearWorkspaceSearch);
workspaceSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    clearWorkspaceSearch();
  }
});

const narrowChatLayout = window.matchMedia('(max-width: 580px)');
function updateSidebarAccessibility(): void {
  const visible = narrowChatLayout.matches
    ? sidebar.classList.contains('mobile-open')
    : !sidebar.classList.contains('collapsed');
  $('btn-sidebar').setAttribute('aria-expanded', String(visible));
}
$('btn-sidebar').setAttribute('aria-controls', 'sidebar');
$('btn-sidebar').addEventListener('click', () => {
  sidebar.classList.toggle(narrowChatLayout.matches ? 'mobile-open' : 'collapsed');
  updateSidebarAccessibility();
});
narrowChatLayout.addEventListener('change', updateSidebarAccessibility);
updateSidebarAccessibility();

referencesButton.addEventListener('click', () => {
  referencesPanel.hidden = !referencesPanel.hidden;
  if (!referencesPanel.hidden) {
    settingsPanel.hidden = true;
    activityPanel.hidden = true;
    fireAndReport(loadConversationReferences(), 'Could not load conversation references: ');
  }
});
referencesCloseButton.addEventListener('click', () => {
  referencesPanel.hidden = true;
});
$('btn-reference-project').addEventListener('click', () => fireAndReport(addConversationReference('project'), 'Could not link the project: '));
$('btn-reference-goal').addEventListener('click', () => fireAndReport(addConversationReference('goal'), 'Could not link the goal: '));
$('btn-reference-assignment').addEventListener('click', () => fireAndReport(addConversationReference('assignment'), 'Could not link the assignment: '));
$('btn-reference-file').addEventListener('click', () => fireAndReport(addConversationReference('file'), 'Could not link the file: '));

$('btn-settings').addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  if (!settingsPanel.hidden) {
    activityPanel.hidden = true;
    referencesPanel.hidden = true;
    fireAndReport(refreshModeIndicator(), 'Could not refresh approval mode: ');
  }
});
$('btn-settings-close').addEventListener('click', () => {
  settingsPanel.hidden = true;
});
activityButton.addEventListener('click', () => {
  activityPanel.hidden = !activityPanel.hidden;
  if (!activityPanel.hidden) {
    settingsPanel.hidden = true;
    referencesPanel.hidden = true;
  }
  renderActivity();
});
activityCloseButton.addEventListener('click', () => {
  activityPanel.hidden = true;
});
async function cancelActiveTurn(): Promise<void> {
  if (activityCancelling || (!streaming && !quickActive && !activeStream)) return;
  activityCancelling = true;
  activityTask = 'Cancelling';
  recordActivity('Cancellation requested');
  try {
    await adi.chat.cancel();
  } catch (error) {
    activityCancelling = false;
    renderActivity();
    throw error;
  }
}

activityCancelButton.addEventListener('click', () =>
  fireAndReport(cancelActiveTurn(), 'Could not cancel the current turn: '),
);
quickStopButton.addEventListener('click', () =>
  fireAndReport(cancelActiveTurn(), 'Could not stop the current task: '),
);
quickOpenButton.addEventListener('click', () =>
  fireAndReport(toggleExpanded(true), 'Could not open the full chat: '),
);


/* ==========================================================================\n   Quick chat\n   ========================================================================== */

/** A one-line question answered in the speech bubble above the pet. */
let quickActive = false;
let quickBuffer = '';
let quickSegmentBoundaryPending = false;
let quickScreenshot: Awaited<ReturnType<typeof adi.screen.capture>> = [];
let quickHideTimer: ReturnType<typeof setTimeout> | null = null;
let quickDismissTimer: ReturnType<typeof setTimeout> | null = null;
let quickAnswerGeneration = 0;
const quickSubmitGate = createSingleFlightGate();
let quickSubmitInFlight = false;
let quickScreenCaptureInFlight: Promise<void> | null = null;

function readingTime(text: string): number {
  return Math.min(30_000, Math.max(6_000, text.length * 45));
}

function appendQuickStreamDelta(delta: string): void {
  quickBuffer = appendSegmentedStreamText(quickBuffer, delta, quickSegmentBoundaryPending);
  quickSegmentBoundaryPending = false;
}

function beginQuickAnswerPresentation(): void {
  quickAnswerGeneration += 1;
  if (quickDismissTimer) clearTimeout(quickDismissTimer);
  quickDismissTimer = null;
  quickAnswer.classList.remove('dismissing');
}

async function showQuickBar(): Promise<void> {
  if (expanded || !chat.hidden || activeRequest) return;
  if (quickHideTimer) clearTimeout(quickHideTimer);
  quickHideTimer = null;
  if (!quickBar.hidden) return;
  quickBar.hidden = false;
  await setQuickWindowMode(quickAnswer.hidden ? 'ask' : 'answer');
  wake();
}

async function hideQuickBar(): Promise<void> {
  if (quickActive || quickSubmitInFlight || quickBar.hidden) return;
  quickBar.hidden = true;
  quickInput.value = '';
  quickWasSpoken = false;
  if (quickAnswer.hidden) await setQuickWindowMode('off');
}

adi.window.onProximity((near) => {
  if (expanded || !chat.hidden) return;
  if (near) {
    fireAndReport(showQuickBar(), 'Could not show quick bar: ');
  } else {
    if (quickHideTimer) clearTimeout(quickHideTimer);
    quickHideTimer = setTimeout(() => fireAndReport(hideQuickBar(), 'Could not hide quick bar: '), 900);
  }
});

async function dismissQuickAnswer(expectedGeneration = quickAnswerGeneration): Promise<void> {
  if (!mayDismissQuickAnswer(expectedGeneration, quickAnswerGeneration)) return;
  if (quickDismissTimer) clearTimeout(quickDismissTimer);
  quickDismissTimer = null;
  if (quickAnswer.hidden) return;
  speech.stop();
  adi.voice.stopSpeaking();
  quickAnswer.classList.add('dismissing');
  await new Promise((resolve) => setTimeout(resolve, 280));
  if (!mayDismissQuickAnswer(expectedGeneration, quickAnswerGeneration)) {
    quickAnswer.classList.remove('dismissing');
    return;
  }
  quickAnswer.classList.remove('dismissing');
  quickAnswer.hidden = true;
  quickAnswerBody.textContent = '';
  await setQuickWindowMode(quickBar.hidden ? 'off' : 'ask');
}

function startQuickCountdown(milliseconds: number): void {
  if (quickDismissTimer) clearTimeout(quickDismissTimer);
  const generation = quickAnswerGeneration;
  quickTimer.style.transition = 'none';
  quickTimer.style.transform = 'scaleX(1)';
  requestAnimationFrame(() => {
    quickTimer.style.transition = `transform ${milliseconds}ms linear`;
    quickTimer.style.transform = 'scaleX(0)';
  });
  const timer = setTimeout(() => {
    if (quickDismissTimer === timer) quickDismissTimer = null;
    fireAndReport(dismissQuickAnswer(generation), 'Could not dismiss quick answer: ');
  }, milliseconds);
  quickDismissTimer = timer;
}

quickInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (quickEscapeAction(quickActive || isBubbleTurnKind(activeStream?.kind)) === 'cancel') {
      fireAndReport(cancelActiveTurn(), 'Could not cancel the quick response: ');
      return;
    }
    quickInput.value = '';
    quickWasSpoken = false;
    fireAndReport(dismissQuickAnswer(), 'Could not dismiss quick answer: ');
    fireAndReport(hideQuickBar(), 'Could not hide quick bar: ');
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const text = quickInput.value.trim();
  if (!text || privacyMode.checked || quickActive || !quickSubmitGate.tryEnter()) return;

  quickSubmitInFlight = true;
  renderPetStatus();
  fireAndReport((async () => {
    try {
      // A screenshot click may still be resolving. Let the send observe its final
      // result so the question cannot race an attachment mutation.
      if (quickScreenCaptureInFlight) await quickScreenCaptureInFlight;
      if (!(await adi.auth.ensure())) {
        beginQuickAnswerPresentation();
        quickWasSpoken = false;
        quickAnswerBody.textContent = 'Not signed in — open the chat and sign in first.';
        quickAnswer.hidden = false;
        await setQuickWindowMode('answer');
        startQuickCountdown(7_000);
        return;
      }

      const screenshot = quickScreenshot;
      quickScreenshot = [];
      setQuickScreenState();
      quickInput.value = '';
      quickActive = true;
      quickBuffer = '';
      quickSegmentBoundaryPending = false;
      setMood('thinking');
      beginQuickAnswerPresentation();
      quickAnswerBody.textContent = '…';
      quickAnswer.hidden = false;
      quickTimer.style.transition = 'none';
      quickTimer.style.transform = 'scaleX(1)';
      await setQuickWindowMode('answer');
      await adi.chat.quick(text, screenshot);
    } catch (error) {
      quickActive = false;
      quickSegmentBoundaryPending = false;
      quickWasSpoken = false;
      activeStream = null;
      activityCancelling = false;
      activityGoal = '';
      activityFailure = 'quick request failed';
      activityTask = 'Failed';
      renderActivity();
      beginQuickAnswerPresentation();
      quickAnswer.hidden = false;
      quickAnswerBody.textContent = 'Quick question failed: ' + errorMessage(error).slice(0, 500);
      startQuickCountdown(7_000);
      reportAsyncError('Quick request failed: ', error);
      setMood('error');
      setTimeout(() => setMood('idle'), 2_500);
    } finally {
      quickSubmitInFlight = false;
      quickSubmitGate.leave();
      renderPetStatus();
    }
  })(), 'Quick request failed: ');
});

function setQuickScreenState(): void {
  const armed = quickScreenshot.length > 0;
  $('btn-quick-screen').classList.toggle('armed', armed);
  quickInput.placeholder = armed ? 'Screen attached — ask about it…' : 'Quick question…';
}

$('btn-quick-screen').addEventListener('click', async () => {
  if (quickSubmitInFlight) return;
  if (quickScreenshot.length) {
    quickScreenshot = [];
    setQuickScreenState();
    return;
  }
  if (quickScreenCaptureInFlight) return;

  const button = $<HTMLButtonElement>('btn-quick-screen');
  button.disabled = true;
  const capture = (async () => {
    const captures = await adi.screen.capture();
    if (privacyMode.checked) return;
    quickScreenshot = captures;
    setQuickScreenState();
    quickInput.focus();
  })();
  quickScreenCaptureInFlight = capture;
  try {
    await capture;
  } catch (error) {
    reportAsyncError('Could not capture the screen for quick chat: ', error);
  } finally {
    if (quickScreenCaptureInFlight === capture) quickScreenCaptureInFlight = null;
    button.disabled = privacyMode.checked;
  }
});

// Clicking the bubble keeps it around; you are reading it.
quickAnswer.addEventListener('click', () => {
  if (quickDismissTimer) {
    clearTimeout(quickDismissTimer);
    quickDismissTimer = null;
    quickTimer.style.transition = 'none';
    quickTimer.style.transform = 'scaleX(0)';
  }
});


/* ==========================================================================
   Voice: dictation in, speech out
   ========================================================================== */

/**
 * Two independent switches rather than one voice mode.
 *
 * The microphone dictates: what you say is transcribed into the message box and
 * left there, so you read it, fix it and send it yourself. Nothing is sent on
 * your behalf — a mis-heard instruction that goes straight to an agent holding
 * shell access is not a small mistake.
 *
 * The speaker is separate, because wanting to dictate quietly and wanting to be
 * answered aloud are different wishes.
 */
let mic: MicHandle | null = null;
const speech = new SpeechPlayer();
let dictating = false;
let dictationActionGeneration = 0;
let dictationActionInFlight = false;
let speakMutationGeneration = 0;
let speakMutationInFlight = false;
let speakReplies = false;
let voiceMeterTimer: ReturnType<typeof setInterval> | null = null;

/** Which box dictation is filling: the chat composer, or quick chat. */
let dictationTarget: 'chat' | 'quick' = 'chat';
/** A quick question that was spoken gets spoken back. */
let quickWasSpoken = false;

const btnVoice = $<HTMLButtonElement>('btn-voice');
const btnSpeak = $<HTMLButtonElement>('btn-speak');
const btnQuickVoice = $<HTMLButtonElement>('btn-quick-voice');
const btnQuickSpeak = $<HTMLButtonElement>('btn-quick-speak');

function reflectVoiceButtons() {
  btnVoice.classList.toggle('on', dictating && dictationTarget === 'chat');
  btnQuickVoice.classList.toggle('on', dictating && dictationTarget === 'quick');
  btnSpeak.classList.toggle('on', speakReplies);
  btnQuickSpeak.classList.toggle('on', speakReplies);
  for (const button of [btnSpeak, btnQuickSpeak]) {
    button.setAttribute('aria-pressed', String(speakReplies));
    button.title = speakReplies ? 'Turn spoken replies off' : 'Read replies aloud';
    button.setAttribute('aria-label', button.title);
  }
  btnVoice.disabled = privacyMode.checked || dictationActionInFlight;
  btnQuickVoice.disabled = privacyMode.checked || dictationActionInFlight;
  btnSpeak.disabled = privacyMode.checked || speakMutationInFlight;
  btnQuickSpeak.disabled = privacyMode.checked || speakMutationInFlight;
}

async function startDictation(target: 'chat' | 'quick') {
  if (privacyMode.checked || dictationActionInFlight) return;
  const generation = ++dictationActionGeneration;
  dictationActionInFlight = true;
  reflectVoiceButtons();

  try {
    if (dictating) {
      await stopDictation(generation);
      if (generation !== dictationActionGeneration) return;
      if (dictationTarget === target) return;
    }
    if (!(await adi.auth.ensure())) {
      if (generation !== dictationActionGeneration) return;
      addErrorEl('Not signed in — sign in before dictating.');
      return;
    }
    if (generation !== dictationActionGeneration) return;

    dictationTarget = target;
    voiceStatus.textContent = 'Connecting…';
    if (target === 'chat') voiceBar.hidden = false;

    const started = await adi.voice.startDictation();
    if (generation !== dictationActionGeneration) return;
    if (!started) {
      voiceBar.hidden = true;
      addErrorEl('Could not start dictation.');
      return;
    }

    try {
      const settings = await adi.settings.get();
      if (generation !== dictationActionGeneration) {
        return;
      }
      if (privacyMode.checked || settings.privacyMode) {
        await stopDictation(generation);
        return;
      }

      const handle = await startMic(settings.micDeviceId, (chunk) => adi.voice.push(chunk));
      if (generation !== dictationActionGeneration) {
        handle.stop();
        return;
      }
      mic = handle;
      // Device labels are blank until access has been granted once.
      fireAndReport(loadMicrophones(), 'Could not refresh microphone list: ');
    } catch (error) {
      if (generation !== dictationActionGeneration) return;
      addErrorEl('Microphone unavailable: ' + (error as Error).message);
      await stopDictation(generation);
      return;
    }

    if (generation !== dictationActionGeneration) return;
    dictating = true;
    reflectVoiceButtons();
    voiceStatus.textContent = 'Listening…';
    wake();

    voiceMeterTimer = setInterval(() => {
      if (mic) voiceLevel.style.transform = 'scaleX(' + mic.level().toFixed(3) + ')';
    }, 90);
  } finally {
    if (generation === dictationActionGeneration) {
      dictationActionInFlight = false;
      reflectVoiceButtons();
    }
  }
}

async function stopDictation(expectedGeneration?: number) {
  if (expectedGeneration !== undefined && expectedGeneration !== dictationActionGeneration) return;
  const generation = expectedGeneration ?? (dictationActionGeneration + 1);
  if (expectedGeneration === undefined) {
    dictationActionGeneration = generation;
    dictationActionInFlight = true;
  }
  dictating = false;
  mic?.stop();
  mic = null;
  if (voiceMeterTimer) clearInterval(voiceMeterTimer);
  voiceMeterTimer = null;
  voiceLevel.style.transform = 'scaleX(0)';
  voiceBar.hidden = true;
  reflectVoiceButtons();
  try {
    await adi.voice.stopDictation();
  } finally {
    if (generation === dictationActionGeneration) {
      dictationActionInFlight = false;
      reflectVoiceButtons();
    }
  }
}

btnVoice.addEventListener('click', () => fireAndReport(startDictation('chat'), 'Dictation failed: '));
btnQuickVoice.addEventListener('click', () => fireAndReport(startDictation('quick'), 'Dictation failed: '));

/**
 * Opening the socket takes a second or two, so it is opened on hover rather
 * than on click. By the time the button is actually pressed the connection is
 * usually already up, which is the difference between "clunky" and instant.
 */
let prewarmed = false;
function prewarmVoice() {
  if (prewarmed) return;
  prewarmed = true;
  fireAndReport(adi.voice.prewarm(), 'Could not prepare voice: ');
  // Allow another attempt later; the socket closes itself when unused.
  setTimeout(() => { prewarmed = false; }, 90_000);
}

btnVoice.addEventListener('pointerenter', prewarmVoice);
btnQuickVoice.addEventListener('pointerenter', prewarmVoice);
btnSpeak.addEventListener('pointerenter', prewarmVoice);
btnQuickSpeak.addEventListener('pointerenter', prewarmVoice);

async function toggleSpeak() {
  if (speakMutationInFlight) return;
  const generation = ++speakMutationGeneration;
  const next = !speakReplies;
  speakMutationInFlight = true;
  reflectVoiceButtons();
  try {
    await adi.settings.set('speakReplies', next);
    if (generation !== speakMutationGeneration) return;
    speakReplies = next;
    if (speakReplies) prewarmVoice();
    reflectVoiceButtons();
    if (!speakReplies) {
      speech.stop();
      adi.voice.stopSpeaking();
    }
  } catch (error) {
    if (generation === speakMutationGeneration) {
      reportAsyncError('Could not save speech setting: ', error);
    }
  } finally {
    if (generation === speakMutationGeneration) {
      speakMutationInFlight = false;
      reflectVoiceButtons();
    }
  }
}

btnSpeak.addEventListener('click', () => fireAndReport(toggleSpeak(), 'Could not change speech setting: '));
btnQuickSpeak.addEventListener('click', () => fireAndReport(toggleSpeak(), 'Could not change speech setting: '));

$('btn-voice-stop').addEventListener('click', () => fireAndReport(stopDictation(), 'Could not stop dictation: '));

/** Reads a reply aloud, stripping the parts that do not survive being spoken. */
function speakText(text: string) {
  const spoken = assistantClipboardText(text.replace(/```[\s\S]*?(?:```|$)/g, ' (code omitted) '))
    .replace(/\t+/g, ', ')
    .trim();
  if (spoken) fireAndReport(adi.voice.speak(spoken), 'Could not speak the reply: ');
}

adi.voice.onEvent((evt: VoiceEvent) => {
  try {
    switch (evt.type) {
    case 'listening':
      voiceStatus.textContent = evt.on ? 'Hearing you…' : 'Listening…';
      break;

    case 'user-transcript': {
      // Straight into the box, never straight to the model.
      const box = dictationTarget === 'quick' ? quickInput : input;
      box.value = box.value ? `${box.value.trim()} ${evt.text}` : evt.text;
      if (dictationTarget === 'quick') {
        quickWasSpoken = true;
      } else {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
      }
      box.focus();
      voiceStatus.textContent = 'Listening…';
      break;
    }

    case 'audio':
      if (speakReplies) speech.play(evt.base64);
      break;

    case 'speaking':
      if (evt.on) setMood('working');
      else if (!dictating) setMood('idle');
      break;

    case 'closed':
      if (dictating) fireAndReport(stopDictation(), 'Could not stop dictation: ');
      break;

    case 'error':
      addErrorEl(`Voice: ${evt.message}`);
      if (dictating) fireAndReport(stopDictation(), 'Could not stop dictation: ');
      break;
    }
  } catch (error) {
    reportAsyncError('Could not update voice state: ', error);
    if (dictating) fireAndReport(stopDictation(), 'Could not stop dictation: ');
  }
});

/* ------------------------------------------------------- voice settings */

async function loadMicrophones() {
  const generation = ++microphoneLoadGeneration;
  const mutationGeneration = microphoneMutationGeneration;
  const [mics, settings] = await Promise.all([listMicrophones(), adi.settings.get()]);
  if (generation !== microphoneLoadGeneration || mutationGeneration !== microphoneMutationGeneration) return;
  micSelect.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'System default';
  micSelect.appendChild(auto);

  for (const m of mics) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    micSelect.appendChild(opt);
  }
  micSelect.value = settings.micDeviceId;

  const note = document.getElementById('mic-note');
  if (note && !mics.some((m) => m.label && !/^Microphone \d+$/.test(m.label))) {
    note.textContent =
      'Device names appear once you have dictated at least once and granted access.';
  }
}

micSelect.addEventListener('change', async () => {
  const generation = ++microphoneMutationGeneration;
  const value = micSelect.value;
  const label = micSelect.options[micSelect.selectedIndex]?.textContent ?? value;
  const wasDisabled = micSelect.disabled;
  micSelect.disabled = true;
  try {
    await adi.settings.set('micDeviceId', value);
    if (generation !== microphoneMutationGeneration) return;
    micSelect.value = value;
    addNotice('Microphone: ' + label);
  } catch (error) {
    if (generation !== microphoneMutationGeneration) return;
    reportAsyncError('Could not save microphone setting: ', error);
    fireAndReport(loadMicrophones(), 'Could not restore microphone setting: ');
  } finally {
    if (generation === microphoneMutationGeneration) micSelect.disabled = wasDisabled;
  }
});

async function loadVoiceSettings() {
  const generation = ++voiceSettingsLoadGeneration;
  const mutationGeneration = voiceSettingsMutationGeneration;
  const [models, settings] = await Promise.all([adi.voice.models(), adi.settings.get()]);
  if (generation !== voiceSettingsLoadGeneration || mutationGeneration !== voiceSettingsMutationGeneration) return;

  voiceSelect.innerHTML = '';
  for (const v of VOICE_NAMES) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
    voiceSelect.appendChild(opt);
  }
  voiceSelect.value = settings.voiceName;

  voiceModelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    voiceModelSelect.appendChild(opt);
  }
  voiceModelSelect.value = settings.voiceModel;

  speakReplies = settings.speakReplies;
  reflectVoiceButtons();
  if (speakReplies) prewarmVoice();
}

function setVoiceSettingsBusy(busy: boolean): void {
  voiceSelect.disabled = busy;
  voiceModelSelect.disabled = busy;
}
voiceSelect.addEventListener('change', async () => {
  const generation = ++voiceSettingsMutationGeneration;
  const value = voiceSelect.value;
  const wasVoiceDisabled = voiceSelect.disabled;
  const wasModelDisabled = voiceModelSelect.disabled;
  setVoiceSettingsBusy(true);
  try {
    await adi.settings.set('voiceName', value);
    if (generation !== voiceSettingsMutationGeneration) return;
    voiceSelect.value = value;
    addNotice('Voice: ' + value + '. Applies to the next thing spoken.');
  } catch (error) {
    if (generation !== voiceSettingsMutationGeneration) return;
    reportAsyncError('Could not save voice setting: ', error);
    fireAndReport(loadVoiceSettings(), 'Could not restore voice setting: ');
  } finally {
    if (generation === voiceSettingsMutationGeneration) {
      voiceSelect.disabled = wasVoiceDisabled;
      voiceModelSelect.disabled = wasModelDisabled;
    }
  }
});

voiceModelSelect.addEventListener('change', async () => {
  const generation = ++voiceSettingsMutationGeneration;
  const value = voiceModelSelect.value;
  const wasVoiceDisabled = voiceSelect.disabled;
  const wasModelDisabled = voiceModelSelect.disabled;
  setVoiceSettingsBusy(true);
  try {
    await adi.settings.set('voiceModel', value);
    if (generation !== voiceSettingsMutationGeneration) return;
    voiceModelSelect.value = value;
  } catch (error) {
    if (generation !== voiceSettingsMutationGeneration) return;
    reportAsyncError('Could not save voice model setting: ', error);
    fireAndReport(loadVoiceSettings(), 'Could not restore voice model setting: ');
  } finally {
    if (generation === voiceSettingsMutationGeneration) {
      voiceSelect.disabled = wasVoiceDisabled;
      voiceModelSelect.disabled = wasModelDisabled;
    }
  }
});

/* ----------------------------------------------------------- summon key */

const HOTKEYS = [
  '',
  'Control+Space',
  'Control+Shift+Space',
  'Control+Shift+A',
  'Alt+Space',
  'Alt+A',
  'Control+Alt+A',
  'Super+A',
];

async function loadHotkey() {
  const generation = ++hotkeyLoadGeneration;
  const mutationGeneration = hotkeyMutationGeneration;
  const settings = await adi.settings.get();
  if (generation !== hotkeyLoadGeneration || mutationGeneration !== hotkeyMutationGeneration) return;
  activeHotkey = settings.hotkey;
  hotkeySelect.innerHTML = '';
  for (const h of HOTKEYS) {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = h || 'None';
    hotkeySelect.appendChild(opt);
  }
  hotkeySelect.value = settings.hotkey;
}

hotkeySelect.addEventListener('change', async () => {
  const generation = ++hotkeyMutationGeneration;
  const value = hotkeySelect.value;
  try {
    const res = await adi.hotkey.set(value);
    if (generation !== hotkeyMutationGeneration) return;
    const note = document.getElementById('hotkey-note');
    if (note) {
      note.textContent = res.message;
      note.style.color = res.ok ? '' : 'var(--stop)';
    }
    if (res.ok) {
      activeHotkey = value;
    } else {
      addErrorEl('Could not save hotkey: ' + res.message);
      await loadHotkey();
    }
  } catch (error) {
    if (generation !== hotkeyMutationGeneration) return;
    reportAsyncError('Could not save hotkey: ', error);
    fireAndReport(loadHotkey(), 'Could not restore hotkey: ');
  }
});

/** The shortcut brings the pet forward, ready for a question. */
adi.hotkey.onPressed(() => {
  if (activeHotkey === 'Control+Space') {
    wake();
    fireAndReport(showCommandPalette(), 'Could not open command palette: ');
    return;
  }
  wake();
  if (!chat.hidden) {
    input.focus();
    return;
  }
  quickBar.hidden = false;
  fireAndReport(setQuickWindowMode(quickAnswer.hidden ? 'ask' : 'answer'), 'Could not show quick bar: ');
  quickInput.focus();
});

/* ------------------------------------------------------------------ auth */

async function refreshAuth() {
  const generation = ++authLoadGeneration;
  const s: AuthStatus = await adi.auth.status();
  if (generation !== authLoadGeneration) return;
  const btn = $<HTMLButtonElement>('btn-signin');
  if (s.signedIn) {
    statusDot.className = 'dot ok';
    statusText.textContent = s.email ?? 'signed in';
    btn.textContent = 'Sign out';
  } else {
    statusDot.className = 'dot bad';
    statusText.textContent = 'signed out';
    btn.textContent = 'Sign in';
  }
}

$('btn-signin').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-signin');
  if (authMutationInFlight) return;
  authMutationInFlight = true;
  const generation = ++authLoadGeneration;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  try {
    const s = await adi.auth.status();
    if (generation !== authLoadGeneration) return;
    if (s.signedIn) {
      await adi.auth.signOut();
      if (generation !== authLoadGeneration) return;
      addNotice('Signed out.');
    } else {
      addNotice('Opening your browser to sign in with ChatGPT…');
      await adi.auth.signIn();
      if (generation !== authLoadGeneration) return;
      addNotice('Signed in.');
    }
  } catch (error) {
    if (generation === authLoadGeneration) {
      addErrorEl('Authentication action failed: ' + (error as Error).message);
    }
  } finally {
    authMutationInFlight = false;
    btn.disabled = wasDisabled;
    fireAndReport(refreshAuth(), 'Could not refresh sign-in status: ');
  }
});

/* ------------------------------------------------------------------ init */

async function runStartupStep(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    addErrorEl('Could not load ' + label + ': ' + errorMessage(error));
  }
}

async function loadModeForStartup(): Promise<void> {
  try {
    await loadMode();
  } catch (error) {
    // If settings cannot be read, connected access must remain paused until the
    // user can verify the real setting again.
    privacyMode.checked = true;
    reflectPrivacyMode(true);
    throw error;
  }
}

async function init() {
  const historyGeneration = conversationOpenGeneration;
  wake();
  // Privacy is the only startup dependency that must settle before connected
  // services may be queried. Everything else hydrates concurrently.
  await runStartupStep('privacy and approval mode', loadModeForStartup);
  performance.mark('adi:privacy-ready');

  const projectWork = runStartupStep('projects', loadProjects);
  const historyWork = runStartupStep(
    'conversation history',
    async () => {
      const res = await adi.chat.history();
      if (historyGeneration !== conversationOpenGeneration) return;
      conversationId = res.conversationId;
      renderHistory(res.messages);
    },
  );
  const steps: readonly [string, () => Promise<void>][] = [
    ['conversation folders', loadConversationFolders],
    ['conversations', loadConversations],
    ['providers', loadProviders],
    ['sign-in status', refreshAuth],
    ['models', loadModels],
    ['reasoning effort', loadEffort],
    ['saved approvals', loadSavedPermissions],
    ['microphones', loadMicrophones],
    ['voice settings', loadVoiceSettings],
    ['hotkey', loadHotkey],
    ['browser profiles', loadProfiles],
    ['saved memory', loadLessons],
    ['background work', loadJobs],
    ['recovery journal', loadMutations],
    ['connected services', loadMcp],
  ];
  await Promise.all([
    ...steps.map(([label, action]) => runStartupStep(label, action)),
    projectWork,
    projectWork.then(() => runStartupStep('assignments', loadAssignments)),
    historyWork,
    historyWork.then(() => runStartupStep('conversation references', loadConversationReferences)),
  ]);
  setMood('idle');
  performance.mark('adi:startup-ready');
}

/* ==========================================================================
   Goals
   ========================================================================== */

/**
 * What the user is working toward, listed beside their conversations.
 *
 * A goal is the one thing here that outlives a chat, so it needs somewhere it
 * can be seen and stopped without asking Adi to do it. Watching in particular
 * has to be one click to turn off — anything that takes screenshots on a timer
 * should be easier to stop than it was to start.
 */
const goalList = $('goal-list');

function goalDue(g: { dueAt?: number }): string {
  if (!g.dueAt) return '';
  const left = g.dueAt - Date.now();
  if (left < 0) return 'overdue';
  const hours = Math.round(left / 3_600_000);
  return hours < 24 ? `due in ${hours}h` : `due in ${Math.round(hours / 24)}d`;
}

function beginGoalMutation(): number | null {
  if (goalMutationInFlight) return null;
  goalMutationInFlight = true;
  return ++goalMutationGeneration;
}
async function loadGoals() {
  const generation = ++goalLoadGeneration;
  const mutationGeneration = goalMutationGeneration;
  const all = await adi.goals.list();
  if (generation !== goalLoadGeneration || mutationGeneration !== goalMutationGeneration) return;
  const active = all.filter((g) => g.status === 'active');
  goalList.innerHTML = '';

  if (!active.length) {
    const empty = document.createElement('div');
    empty.className = 'convo-empty';
    empty.textContent = 'Nothing set yet. Tell Adi what you are working toward.';
    goalList.appendChild(empty);
    return;
  }

  for (const g of active) {
    const row = document.createElement('div');
    row.className = 'convo goal';

    const text = document.createElement('div');
    text.className = 'convo-text';

    const title = document.createElement('div');
    title.className = 'convo-title';
    title.textContent = g.title;

    const meta = document.createElement('div');
    meta.className = 'convo-meta';
    const notes = g.progress.length;
    const bits = [goalDue(g), notes ? `${notes} note${notes === 1 ? '' : 's'}` : ''].filter(Boolean);
    meta.textContent = bits.join(' · ') || 'no deadline';

    text.append(title, meta);

    // Watching is stated plainly, because a timer taking screenshots should
    // never be something you have to remember is running.
    if (g.watch) {
      const watch = document.createElement('div');
      watch.className = 'goal-watch';
      const where = g.watch.looksAt === 'screen' ? 'the screen' : `“${g.watch.looksAt}”`;
      watch.textContent = `Watching ${where} · ${g.watch.everyMinutes}m`;

      const stop = document.createElement('button');
      stop.className = 'goal-stop';
      stop.textContent = 'Stop';
      stop.title = 'Stop checking in on this goal';
      stop.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mutationGeneration = beginGoalMutation();
        if (mutationGeneration === null) return;
        stop.disabled = true;
        try {
          await adi.goals.stopWatch(g.id);
          if (mutationGeneration !== goalMutationGeneration) return;
          await loadGoals();
          if (mutationGeneration !== goalMutationGeneration) return;
          addNotice('Stopped checking in on "' + g.title + '".');
        } catch (error) {
          if (mutationGeneration === goalMutationGeneration) {
            reportAsyncError('Could not stop goal checking: ', error);
            stop.disabled = false;
          }
        } finally {
          if (mutationGeneration === goalMutationGeneration) goalMutationInFlight = false;
        }
      });

      watch.appendChild(stop);
      text.appendChild(watch);
    }

    const actions = document.createElement('div');
    actions.className = 'convo-actions';

    if (g.watch) {
      const now = document.createElement('button');
      now.className = 'icon-btn';
      now.textContent = '👁';
      now.title = 'Check on this now';
      now.setAttribute('aria-label', 'Check on this goal now');
      now.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mutationGeneration = beginGoalMutation();
        if (mutationGeneration === null) return;
        now.disabled = true;
        try {
          const started = await adi.goals.checkNow(g.id);
          if (mutationGeneration !== goalMutationGeneration) return;
          if (!started) throw new Error('This goal is no longer available for a check-in.');
          addNotice('Check-in queued for "' + g.title + '".');
        } catch (error) {
          if (mutationGeneration === goalMutationGeneration) {
            reportAsyncError('Could not start the goal check-in: ', error);
            now.disabled = false;
          }
        } finally {
          if (mutationGeneration === goalMutationGeneration) goalMutationInFlight = false;
        }
      });
      actions.appendChild(now);
    }

    const done = document.createElement('button');
    done.className = 'icon-btn';
    done.textContent = '✓';
    done.title = 'Mark done';
    done.setAttribute('aria-label', 'Mark goal done');
    done.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mutationGeneration = beginGoalMutation();
      if (mutationGeneration === null) return;
      done.disabled = true;
      try {
        await adi.goals.finish(g.id, false);
        if (mutationGeneration !== goalMutationGeneration) return;
        await loadGoals();
        if (mutationGeneration !== goalMutationGeneration) return;
        addNotice('"' + g.title + '" marked done.');
      } catch (error) {
        if (mutationGeneration === goalMutationGeneration) {
          reportAsyncError('Could not finish the goal: ', error);
          done.disabled = false;
        }
      } finally {
        if (mutationGeneration === goalMutationGeneration) goalMutationInFlight = false;
      }
    });

    const drop = document.createElement('button');
    drop.className = 'icon-btn danger';
    drop.textContent = '🗑';
    drop.title = 'Drop this goal';
    drop.setAttribute('aria-label', 'Drop this goal');
    drop.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (goalMutationInFlight || !window.confirm('Drop "' + g.title + '"?')) return;
      const mutationGeneration = beginGoalMutation();
      if (mutationGeneration === null) return;
      drop.disabled = true;
      try {
        await adi.goals.finish(g.id, true);
        if (mutationGeneration !== goalMutationGeneration) return;
        await loadGoals();
        if (mutationGeneration !== goalMutationGeneration) return;
        addNotice('Dropped "' + g.title + '".');
      } catch (error) {
        if (mutationGeneration === goalMutationGeneration) {
          reportAsyncError('Could not drop the goal: ', error);
          drop.disabled = false;
        }
      } finally {
        if (mutationGeneration === goalMutationGeneration) goalMutationInFlight = false;
      }
    });

    actions.append(done, drop);
    row.append(text, actions);
    goalList.appendChild(row);
  }
}

/**
 * A scheduled check-in speaks in the same bubble a quick question does, so it
 * arrives as the pet saying something rather than as a notification from an app.
 */
adi.goals.onCheckin(({ title, operationId }) => {
  if (activeStream?.kind !== 'goal' || activeStream.operationId !== operationId) return;

  activityGoal = title;
  renderActivity();
  quickActive = true;
  quickBuffer = '';
  quickSegmentBoundaryPending = false;
  setMood('thinking');
  beginQuickAnswerPresentation();
  quickAnswerBody.textContent = `Checking in on “${title}”…`;
  quickAnswer.hidden = false;
  quickTimer.style.transition = 'none';
  quickTimer.style.transform = 'scaleX(1)';
  fireAndReport(setQuickWindowMode('answer'), 'Could not show goal check-in: ');
});

void init().catch((error) => {
  addErrorEl(`Startup failed: ${(error as Error).message}`);
  setMood('idle');
});
