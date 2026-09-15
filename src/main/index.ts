import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, screen, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  Attachment,
  ConversationKind,
  ConversationReferenceKind,
  PermissionDecision,
  PermissionRequest,
  ProviderId,
  ToolCall,
  ToolStudioDefinition,
  TurnKind,
} from '../shared/types';
import { runTurn, type ConfirmBridge } from './agent';
import { throwIfAborted } from './abort';
import { MAX_CLIPBOARD_DRAFT_CHARS } from '../shared/clipboard';
import { cancelCredentialRefresh, cancelSignIn, signIn, signOut } from './auth/oauth';
import { loadTokens } from './auth/store';
import {
  autoTitleConversation,
  closeDb,
  createConversation,
  branchConversation,
  currentQuickConversation,
  deleteConversation,
  getAllMessages,
  getSettings,
  initDb,
  latestConversationId,
  listConversations,
  listAllowlist,
  logAudit,
  purgeExpiredQuickChats,
  removeFromAllowlist,
  setConversationStarred,
  setConversationArchived,
  setConversationTitle,
  listConversationFolders,
  createConversationFolder,
  renameConversationFolder,
  deleteConversationFolder,
  setConversationFolder,
  addConversationReference,
  listConversationReferences,
  removeConversationReference,
  setSetting,
  setSettings,
} from './db';
import { runDiagnostics } from './diagnostics';
import * as goals from './goals';
import * as assignments from './assignments';
import * as projects from './projects';
import * as mcp from './mcp/client';
import { PendingConfirmationRegistry, PendingTurnRegistry } from './turn-state';
import { clearTaskAllowlist } from './permissions';
import { logRuntimeError } from './observability';
import { redactSecrets } from './redaction';
import { createOperationId } from './operations';
import {
  haveCredentials,
  probeEndpoint,
  probeModels,
  selectableModels,
  setDiscoveredModels,
} from './model/client';
import { MAX_CUSTOM_MODELS, normaliseCustomModelIds, normaliseModelId } from './model/catalog';
import { normaliseProviderModels, validateSettingUpdate, workspaceConsentScopeMatches } from './settings-validation';
import {
  PROVIDERS,
  clearApiKey,
  keyStatus,
  providerInfo,
  saveApiKey,
} from './model/providers';
import { captureScreen } from './tools/screen';
import { setRemindersPaused } from './tools/reminders';
import { notify as showNotification } from './tools/system';
import { probeRealtime } from './model/realtime-probe';
import * as voice from './model/voice';
import { listProfiles, releaseBrowserRequestLock, shutdownChrome } from './tools/chrome';
import * as gdocs from './tools/gdocs';
import * as google from './tools/google';
import * as custom from './tools/custom';
import { shutdownHost, warmUp } from './tools/pshost';
import { getJobManager, shutdownJobs } from './job-runtime';
import { acquireMutationLock } from './mutation-lock';
import { getMutationJournal, undoMutation } from './mutation-runtime';
import { executeToolCall, invalidateToolCatalog, listToolStudioCandidates, TOOL_SCHEMAS } from './tools/registry';
import { validateWorkspaceRoot } from './workspace';
import { attachmentPathDecision, boundedAttachmentPaths, isAttachmentConfirmationAccepted, normaliseAttachments, readAttachmentsFromPaths } from './attachments';
import { searchLocalWorkspace } from './local-search';
import {
  isAllowedRendererNavigation,
  isBoundedString,
  isFiniteWindowCoordinate,
  isKnownString,
  isNonEmptyBoundedString,
  isPermissionDecision,
  isPcm16Base64Chunk,
  isTrustedIpcEvent,
  isToolStudioDefinition,
  isToolStudioTestArgs,
  MAX_CHAT_TEXT_CHARS,
  MAX_HOTKEY_CHARS,
  MAX_IPC_IDENTIFIER_CHARS,
  MAX_PROVIDER_KEY_CHARS,
  MAX_STREAM_CONTENT_CHARS,
  MAX_VOICE_TEXT_CHARS,
} from './ipc-validation';

process.on('uncaughtExceptionMonitor', (error) => logRuntimeError('uncaught-exception', error));
process.on('unhandledRejection', (reason) => logRuntimeError('unhandled-rejection', reason));

/**
 * A transparent, always-on-top window is composited over the desktop
 * continuously — measured at ~45% of a core with nothing animating at all. For
 * flat 2D art this small, the GPU path costs far more than it saves.
 */
app.disableHardwareAcceleration();

const PET_SIZE = { width: 180, height: 200 };
/** Pet mode plus room for a confirmation bubble, which the pet size would clip. */
const BUBBLE_SIZE = { width: 380, height: 360 };
/** Room for the quick-ask field under the pet. */
const QUICK_SIZE = { width: 340, height: 250 };
/** Room for the pet plus a speech bubble above it. */
/* Pet (200) + the bubble's 208px offset and 200px cap, plus a little headroom.
   Any taller and the window captures clicks over empty transparent space. */
const QUICK_ANSWER_SIZE = { width: 380, height: 424 };
const CHAT_SIZE = { width: 940, height: 660 };

let win: BrowserWindow | null = null;
let shutdownStarted = false;
let expanded = false;
let bubbleOpen = false;
let quickMode: 'off' | 'ask' | 'answer' = 'off';
let unsubscribeMutationUpdates: (() => void) | null = null;
let currentAbort: AbortController | null = null;
const activeScreenCaptures = new Map<AbortController, Promise<unknown>>();
const activeWorkspaceSearches = new Map<AbortController, Promise<unknown>>();

function cancelActiveScreenCaptures(): void {
  for (const controller of activeScreenCaptures.keys()) controller.abort();
}

async function drainActiveScreenCaptures(): Promise<void> {
  await Promise.allSettled([...activeScreenCaptures.values()]);
}

function cancelActiveWorkspaceSearches(): void {
  for (const controller of activeWorkspaceSearches.keys()) controller.abort();
}

async function drainActiveWorkspaceSearches(): Promise<void> {
  await Promise.allSettled([...activeWorkspaceSearches.values()]);
}

const activeLiveProbes = new Map<AbortController, Promise<unknown>>();

function cancelActiveLiveProbes(): void {
  for (const controller of activeLiveProbes.keys()) controller.abort();
}

async function drainActiveLiveProbes(): Promise<void> {
  await Promise.allSettled([...activeLiveProbes.values()]);
}

async function runCancellableLiveProbe<T>(
  action: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertPrivacyOff(action);
  const controller = new AbortController();
  const running = operation(controller.signal);
  activeLiveProbes.set(controller, running);
  try {
    const result = await running;
    throwIfAborted(controller.signal);
    if (shutdownStarted) throw new Error('Application is shutting down.');
    if (getSettings().privacyMode) {
      controller.abort();
      throwIfAborted(controller.signal);
    }
    return result;
  } finally {
    activeLiveProbes.delete(controller);
  }
}

const activeDiagnostics = new Map<AbortController, Promise<unknown>>();

function cancelActiveDiagnostics(): void {
  for (const controller of activeDiagnostics.keys()) controller.abort();
}

async function drainActiveDiagnostics(): Promise<void> {
  await Promise.allSettled([...activeDiagnostics.values()]);
}

const activeUndos = new Map<AbortController, Promise<unknown>>();

function cancelActiveUndos(): void {
  for (const controller of activeUndos.keys()) controller.abort();
}

async function drainActiveUndos(): Promise<void> {
  await Promise.allSettled([...activeUndos.values()]);
}

const activeToolStudioTests = new Map<AbortController, Promise<unknown>>();

function cancelActiveToolStudioTests(): void {
  for (const controller of activeToolStudioTests.keys()) controller.abort();
}

async function drainActiveToolStudioTests(): Promise<void> {
  await Promise.allSettled([...activeToolStudioTests.values()]);
}
const activeMcpOperations = new Map<AbortController, Promise<unknown>>();

function cancelActiveMcpOperations(): void {
  for (const controller of activeMcpOperations.keys()) controller.abort();
}

async function drainActiveMcpOperations(): Promise<void> {
  await Promise.allSettled([...activeMcpOperations.values()]);
}

const activeAttachmentOperations = new Map<AbortController, Promise<unknown>>();

function cancelActiveAttachmentOperations(): void {
  for (const controller of activeAttachmentOperations.keys()) controller.abort();
}

const activeHostWarmups = new Map<AbortController, Promise<unknown>>();

function cancelActiveHostWarmups(): void {
  for (const controller of activeHostWarmups.keys()) controller.abort();
}

async function drainActiveHostWarmups(): Promise<void> {
  await Promise.allSettled([...activeHostWarmups.values()]);
}

function startHostWarmup(): void {
  const controller = new AbortController();
  const operation = warmUp(controller.signal);
  activeHostWarmups.set(controller, operation);
  void operation.then(
    () => {
      if (activeHostWarmups.get(controller) === operation) activeHostWarmups.delete(controller);
    },
    () => {
      if (activeHostWarmups.get(controller) === operation) activeHostWarmups.delete(controller);
    },
  );
}

let turnQueue: Promise<void> = Promise.resolve();
let queuedTurnCount = 0;
const pendingTurnConversations = new PendingTurnRegistry();
let turnGeneration = 0;
let unsubscribeJobUpdates: (() => void) | null = null;
let unsubscribeMcpStatus: (() => void) | null = null;
let unsubscribeToolUpdates: (() => void) | null = null;


/** Pending confirmation prompts, keyed by request id. */
const pendingConfirms = new PendingConfirmationRegistry<PermissionDecision>();

/**
 * Bridges the permission bubble to the agent without leaving an abandoned
 * promise behind when the current operation is cancelled. The AbortSignal is
 * deliberately stripped before crossing IPC; Electron cannot clone it and the
 * renderer only needs the public request fields.
 */
function requestConfirmation(req: Parameters<ConfirmBridge>[0]): Promise<PermissionDecision> {
  return new Promise((resolve) => {
    const id = req.id || randomUUID();
    let settled = false;

    const finish = (decision: PermissionDecision) => {
      if (settled) return;
      settled = true;
      pendingConfirms.delete(id);
      req.signal?.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    const onAbort = () => finish({ action: 'deny' });

    if (req.signal?.aborted) {
      onAbort();
      return;
    }

    pendingConfirms.set(id, finish);
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const { signal: _signal, ...publicRequest } = req;
    win?.webContents.send('permission:request', {
      ...publicRequest,
      id,
      tier: 'confirm',
    } as PermissionRequest);
  });
}

function cancelActiveTurns(): void {
  turnGeneration += 1;
  const controller = currentAbort;
  currentAbort = null;
  controller?.abort();
  pendingConfirms.resolveAll({ action: 'deny' });
}

function assertPrivacyOff(action: string): void {
  if (getSettings().privacyMode) {
    throw new Error('Privacy pause is on; ' + action + ' is disabled.');
  }
}

function recordAttachmentDecision(
  count: number,
  tier: 'confirm' | 'never',
  decision: string,
  ok: boolean,
  result: string,
): void {
  try {
    logAudit({
      operationId: createOperationId(),
      toolName: 'attachment_read',
      args: { count },
      tier,
      decision,
      ok,
      result,
    });
  } catch (error) {
    logRuntimeError('attachment-audit-error', error);
  }
}

async function readRendererAttachmentPaths(value: unknown, signal?: AbortSignal): Promise<Attachment[]> {
  throwIfAborted(signal);
  assertPrivacyOff('file attachments');
  const paths = boundedAttachmentPaths(value);
  if (!paths.length) return [];

  const decisions = paths.map(attachmentPathDecision);
  const denied = decisions.find((decision) => decision.tier === 'deny');
  if (denied) {
    const result = 'Attachment blocked because it matched a protected private-data policy.';
    recordAttachmentDecision(paths.length, 'never', 'blocked-sensitive-path', false, result);
    throw new Error(result);
  }

  const confirmations = decisions.filter((decision) => decision.tier === 'confirm');
  if (confirmations.length) {
    if (!win || win.isDestroyed()) {
      const result = 'Sensitive attachments require an active app window for confirmation.';
      recordAttachmentDecision(paths.length, 'confirm', 'confirmation-unavailable', false, result);
      throw new Error(result);
    }
    const reasons = Array.from(
      new Set(
        confirmations
          .map((decision) => decision.reason)
          .filter((reason): reason is string => typeof reason === 'string'),
      ),
    )
      .slice(0, 3)
      .join(' ');
    const response = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Attach'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Review sensitive attachment',
      message: 'One or more selected files may contain private data.',
      detail:
        'This file will be sent to the AI if you continue. ' +
        (reasons || 'Review the selected files before attaching them.'),
    });
    throwIfAborted(signal);
    assertPrivacyOff('file attachments');
    if (!isAttachmentConfirmationAccepted(response)) {
      recordAttachmentDecision(paths.length, 'confirm', 'user-cancelled', true, 'User declined the sensitive attachment.');
      return [];
    }
    recordAttachmentDecision(paths.length, 'confirm', 'user-approved', true, 'User approved the sensitive attachment.');
  }

  throwIfAborted(signal);
  assertPrivacyOff('file attachments');
  return readAttachmentsFromPaths(paths);
}

async function runTrackedAttachmentOperation<T>(
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const operation = action(controller.signal);
  activeAttachmentOperations.set(controller, operation);
  try {
    return await operation;
  } finally {
    activeAttachmentOperations.delete(controller);
  }
}

/**
 * Runs turns one at a time. Aborting a model/tool call is cooperative, so the
 * next request must wait for the old promise to settle before it can mutate the
 * same conversation or publish UI events.
 */
function enqueueTurn(
  kind: TurnKind,
  run: (signal: AbortSignal, operationId: string) => Promise<void>,
): Promise<void> {
  if (shutdownStarted) return Promise.reject(new Error('Application is shutting down.'));
  const previous = turnQueue;
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  turnQueue = previous.then(() => slot);
  queuedTurnCount += 1;
  const generation = ++turnGeneration;
  currentAbort?.abort();

  return (async () => {
    let controller: AbortController | null = null;
    let operationId: string | undefined;
    try {
      await previous;
      if (generation !== turnGeneration) return;
      if (!win || win.isDestroyed()) return;

      controller = new AbortController();
      currentAbort = controller;
      operationId = createOperationId();
      win.webContents.send('stream', { type: 'started', operationId, kind });
      await run(controller.signal, operationId);
    } finally {
      if (operationId) clearTaskAllowlist(operationId);
      if (operationId) releaseBrowserRequestLock(operationId);
      if (controller && currentAbort === controller) currentAbort = null;
      queuedTurnCount = Math.max(0, queuedTurnCount - 1);
      release();
    }
  })();
}

/** Queues an interactive chat or quick turn behind any cancelled predecessor. */
async function runManagedTurn(
  conversationId: number,
  text: string,
  attachments: Attachment[],
  kind: 'chat' | 'quick',
): Promise<void> {
  pendingTurnConversations.retain(conversationId);
  try {
    await enqueueTurn(kind, async (signal, operationId) => {
      if (!win || win.isDestroyed()) return;
      await runTurn(win, conversationId, text, attachments, requestConfirmation, signal, operationId);
    });
  } finally {
    pendingTurnConversations.release(conversationId);
  }
}

function createWindow() {
  const display = screen.getPrimaryDisplay().workAreaSize;
  const saved = getSettings();

  // Restore where the pet was last dragged, clamped back onto a visible
  // display in case the monitor layout changed since.
  const defaultX = display.width - PET_SIZE.width - 40;
  const defaultY = display.height - PET_SIZE.height - 40;

  win = new BrowserWindow({
    ...PET_SIZE,
    x: saved.petX ?? defaultX,
    y: saved.petY ?? defaultY,
    frame: false,
    transparent: true,
    resizable: false,
    // Size the web contents, not the frame, so DPI changes cannot compound.
    useContentSize: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');

  // If the saved position landed off every display, fall back to the corner.
  const b = win.getBounds();
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + b.width > a.x && b.x < a.x + a.width && b.y + b.height > a.y && b.y < a.y + a.height;
  });
  if (!visible) win.setPosition(defaultX, defaultY);

  const rendererPath = join(__dirname, '../renderer/index.html');
  const rendererUrl = pathToFileURL(rendererPath).toString();
  win.webContents.on('will-navigate', (event) => {
    if (!isAllowedRendererNavigation(event.url, rendererUrl)) event.preventDefault();
  });
  win.webContents.on('will-frame-navigate', (event) => {
    if (!isAllowedRendererNavigation(event.url, rendererUrl)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event) => {
    if (!isAllowedRendererNavigation(event.url, rendererUrl)) event.preventDefault();
  });
  void win.loadFile(rendererPath).catch((error) => logRuntimeError('integration-error', error));

  // Links in chat open in the user's real browser, not inside the pet.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (shutdownStarted) return { action: 'deny' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { action: 'deny' };
    void shell.openExternal(parsed.toString()).catch((error) => logRuntimeError('integration-error', error));
    return { action: 'deny' };
  });

  win.on('resize', enforceCollapsedSize);

  win.on('closed', () => {
    cancelSignIn();
    cancelActiveLiveProbes();
    cancelActiveDiagnostics();
    cancelCredentialRefresh();
    cancelActiveScreenCaptures();
    cancelActiveWorkspaceSearches();
    cancelActiveAttachmentOperations();
    cancelActiveUndos();
    cancelActiveMcpOperations();
    cancelActiveTurns();
    runNonCritical(() => voice.close());
    win = null;
  });
}

/** Guards the resize listener against reacting to its own corrections. */
let applyingSize = false;

/**
 * Pulls a rect fully inside the nearest display. Used when expanding to chat:
 * a window whose centre is on-screen can still have its header off the top
 * edge, and then the close/collapse buttons are unreachable.
 */
function clampStrict(x: number, y: number, width: number, height: number) {
  const a = screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  }).workArea;
  return {
    x: Math.round(Math.max(a.x, Math.min(x, a.x + a.width - width))),
    y: Math.round(Math.max(a.y, Math.min(y, a.y + a.height - height))),
  };
}

/**
 * Resizes in place, anchoring to whichever corner the window already sits
 * nearest so growing never pushes it off the screen edge it is hugging.
 *
 * Sizes are content sizes (the window is frameless and `useContentSize` is on),
 * which keeps them stable across DPI changes — plain setBounds measures the
 * frame, and on a scaled display each correction compounded the last, growing
 * the pet from 180px to over 500.
 */
function applySize(size: { width: number; height: number }) {
  if (!win) return;
  applyingSize = true;

  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds).workArea;

  const nearRight = bounds.x + bounds.width / 2 > display.x + display.width / 2;
  const nearBottom = bounds.y + bounds.height / 2 > display.y + display.height / 2;

  const x = nearRight ? bounds.x + bounds.width - size.width : bounds.x;
  const y = nearBottom ? bounds.y + bounds.height - size.height : bounds.y;

  win.setContentSize(size.width, size.height);
  const p = clampStrict(x, y, size.width, size.height);
  win.setPosition(p.x, p.y);
  applyingSize = false;

  // Windows can shift the window again while settling a size change, so
  // re-assert the clamped position once that has finished.
  setImmediate(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const q = clampStrict(b.x, b.y, size.width, size.height);
    if (q.x !== b.x || q.y !== b.y) win.setPosition(q.x, q.y);
  });
}

/**
 * The pet's size is authoritative, not advisory. Windows rescales the frame on
 * DPI-change events, so anything that resizes it while collapsed gets snapped
 * straight back.
 */
/**
 * How far the real content size may drift before it is corrected.
 *
 * Exact comparison is a trap: on a scaled display the size that comes back is
 * rounded (asking for 180 yields 183), so an exact check never matches, every
 * correction fires another resize event, and the main process spins forever —
 * which also stops it serving anything else. Only genuine drift is worth
 * fixing, and only a bounded number of times in a row.
 */
const SIZE_TOLERANCE = 8;
const MAX_CONSECUTIVE_CORRECTIONS = 3;

let corrections = 0;
let lastCorrectionAt = 0;

function enforceCollapsedSize() {
  if (!win || expanded || applyingSize) return;

  const want = collapsedSize();
  const [w = want.width, h = want.height] = win.getContentSize();
  const drift = Math.max(Math.abs(w - want.width), Math.abs(h - want.height));
  if (drift <= SIZE_TOLERANCE) {
    corrections = 0;
    return;
  }

  // A resize the user or the OS caused deliberately restarts the budget.
  const now = Date.now();
  if (now - lastCorrectionAt > 1000) corrections = 0;
  if (corrections >= MAX_CONSECUTIVE_CORRECTIONS) return;

  corrections += 1;
  lastCorrectionAt = now;
  applyingSize = true;
  win.setContentSize(want.width, want.height);
  applyingSize = false;
}

function collapsedSize() {
  // A pending confirmation outranks quick chat: it is blocking a real action.
  if (bubbleOpen) return BUBBLE_SIZE;
  if (quickMode === 'answer') return QUICK_ANSWER_SIZE;
  if (quickMode === 'ask') return QUICK_SIZE;
  return PET_SIZE;
}

/* ------------------------------------------------------------ click-through */

let interactive = true;
let dragging = false;
let cursorNear = false;
let lastLook = { x: 0, y: 0 };
let cursorTimer: NodeJS.Timeout | null = null;

function setInteractive(next: boolean) {
  if (!win || win.isDestroyed() || next === interactive) return;
  interactive = next;
  win.setIgnoreMouseEvents(!next, { forward: true });
}

/**
 * Decides click-through from the main process by polling the real cursor
 * position.
 *
 * The obvious alternative — letting the renderer report hover from forwarded
 * mouse events — is a trap: once the window is click-through, it depends on
 * those forwarded events to ever become clickable again. Miss one and the pet
 * is permanently dead to the mouse with no way to recover. Main can always read
 * the cursor, so this cannot strand the window.
 */
function startCursorTracking() {
  cursorTimer = setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return;
    // Expanded chat, a pending confirmation, or an in-progress drag all need
    // the whole window live.
    if (expanded || bubbleOpen || dragging) {
      setInteractive(true);
      return;
    }
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();

    // Measure from the creature, not the window. The window grows for quick
    // chat and the bubble, and deriving the radius from its size made the
    // "nearby" zone grow with it — so approaching opened the quick field, which
    // enlarged the zone, and the cursor could never get far enough away to
    // close it again. The pet always sits at the bottom, PET_SIZE tall.
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height - PET_SIZE.height / 2;
    const radius = Math.min(PET_SIZE.width, PET_SIZE.height) / 2;
    const distance = Math.hypot(p.x - cx, p.y - cy);

    // While the window is showing something interactive, all of it is live.
    setInteractive(quickMode !== 'off' || distance <= radius);

    // Also tell the renderer when the cursor is merely nearby, so the pet can
    // wake up as you approach and doze off when ignored.
    const near = distance <= radius * 2.2;
    if (near !== cursorNear) {
      cursorNear = near;
      if (!win.isDestroyed()) win.webContents.send('pet:proximity', near);
    }

    // Where to look. Sent only while the cursor is in sight and only when it
    // has moved appreciably — this poll runs ~16 times a second, and shipping
    // every tick across IPC to nudge two eyes would be a poor trade.
    if (!cursorNear) return;
    const look = {
      x: Math.max(-1, Math.min(1, (p.x - cx) / (radius * 3))),
      y: Math.max(-1, Math.min(1, (p.y - cy) / (radius * 3))),
    };
    if (Math.abs(look.x - lastLook.x) > 0.06 || Math.abs(look.y - lastLook.y) > 0.06) {
      lastLook = look;
      if (!win.isDestroyed()) win.webContents.send('pet:look', look);
    }
    } catch (error) {
      logRuntimeError('integration-error', error);
    }
  }, 60);
}

function setExpanded(next: boolean) {
  if (!win || next === expanded) return;
  expanded = next;
  applySize(next ? CHAT_SIZE : collapsedSize());
  win.setResizable(next);
  if (next) setInteractive(true);
}

/**
 * A confirmation bubble does not fit inside the pet-sized window, so pet mode
 * grows while one is pending and shrinks back once it is answered.
 */
function setBubbleOpen(next: boolean) {
  if (!win || next === bubbleOpen) return;
  bubbleOpen = next;
  if (!expanded) applySize(collapsedSize());
}

/**
 * Summons the pet from anywhere.
 *
 * Registration can fail when another app already owns the combination, and
 * Electron reports that by returning false rather than throwing — so the result
 * is surfaced to the user instead of the shortcut silently doing nothing.
 */
function registerHotkey(accelerator: string): { ok: boolean; message: string } {
  globalShortcut.unregisterAll();
  if (!accelerator.trim()) return { ok: true, message: 'No shortcut set.' };

  try {
    const ok = globalShortcut.register(accelerator, () => {
      if (!win || win.isDestroyed()) return;
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
      win.focus();
      win.webContents.send('hotkey');
    });
    return ok
      ? { ok: true, message: `${accelerator} is listening.` }
      : { ok: false, message: `${accelerator} is already taken by another app.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

}

function registerConfiguredHotkey(): void {
  const result = registerHotkey(getSettings().hotkey);
  if (result.ok) return;
  const message =
    'Configured summon shortcut could not be registered: ' +
    result.message +
    ' Choose another shortcut in Settings.';
  logRuntimeError('integration-error', new Error(message));
  runNonCritical(() => showNotification('Adi: summon shortcut unavailable', message, 'high'));
}

/**
 * Scheduled goal check-ins.
 *
 * A watched goal means Adi looks at the screen every so often and says one
 * short thing about how it is going. Three rules keep that from being
 * obnoxious: it never interrupts something already in flight, it never fires
 * while a decision is pending, and it always announces itself in the bubble
 * rather than doing anything quietly in the background.
 */
let goalTimer: ReturnType<typeof setInterval> | null = null;

function startGoalWatcher(): void {
  goalTimer = setInterval(() => {
    try {
      if (shutdownStarted) return;
      if (getSettings().privacyMode) return;
      if (!win || win.isDestroyed()) return;
      const due = goals.goalsDueForCheck();
      if (!due.length) return;

      const goal = due[0];
      if (goal) beginGoalCheckin(goal);
    } catch (error) {
      logRuntimeError('goal-checkin-error', error);
    }
  }, 60_000);
}

function beginGoalCheckin(goal: goals.Goal): boolean {
  if (shutdownStarted) return false;
  if (!win || win.isDestroyed()) return false;
  if (getSettings().privacyMode) return false;
  // Shared by the timer and the manual button: never replace the abort
  // controller for a chat or approval that is already in flight.
  if (queuedTurnCount > 0 || currentAbort || pendingConfirms.size > 0) return false;

  void runQueuedGoalCheckin(goal).catch((error) => {
    logRuntimeError('goal-checkin-error', error);
  });
  return true;
}


async function runQueuedGoalCheckin(goal: goals.Goal): Promise<void> {
  await enqueueTurn('goal', async (signal, operationId) => {
    if (!win || win.isDestroyed()) return;
    try {
      goals.markChecked(goal.id);
    } catch (error) {
      logRuntimeError('goal-checkin-error', error);
      if (!win.isDestroyed()) {
        win.webContents.send('stream', {
          type: 'error',
          operationId,
          message: 'Goal check-in could not start. Try again.',
        });
      }
      return;
    }
    win.webContents.send('goal:checkin', { id: goal.id, title: goal.title, operationId });
    const conversationId = currentQuickConversation();
    const prompt =
      'Scheduled check-in on the goal "' + goal.title + '" [' + goal.id + ']. Call check_goal on it, ' +
      'look at the picture, and say one short line about how it is going. If they are ' +
      'clearly working on it, say so and leave them alone.';
    try {
      await runTurn(win, conversationId, prompt, [], requestConfirmation, signal, operationId);
    } catch (e) {
      if (!signal.aborted) logRuntimeError('goal-checkin-error', e, operationId);
      if (!win.isDestroyed()) {
        win.webContents.send('stream', {
          type: 'error',
          operationId,
          message: signal.aborted ? 'Cancelled.' : 'Goal check-in failed. Try again.',
        });
      }
    }
  });
}
function customModelIds(): string[] {
  try {
    return normaliseCustomModelIds(JSON.parse(getSettings().customModels || '[]'));
  } catch {
    return [];
  }
}

function applyCustomModelIds(ids = customModelIds()): string[] {
  const safe = normaliseCustomModelIds(ids);
  setDiscoveredModels(safe.map((id) => ({ id, label: id, note: 'Added by you' })));
  return safe;
}

app.whenReady().then(() => {
  initDb();
  // Restore model ids added by hand in a previous session.
  applyCustomModelIds();
  createWindow();
  runNonCritical(() => reconcileLaunchOnStartup());
  unsubscribeMcpStatus?.();
  unsubscribeMcpStatus = mcp.subscribeStatus((servers) => {
    const window = win;
    if (!window || window.isDestroyed()) return;
    invalidateToolCatalog();
    runNonCritical(() => window.webContents.send('stream', { type: 'mcp', servers }));
  });

  unsubscribeToolUpdates?.();
  unsubscribeToolUpdates = custom.subscribeToolUpdates(() => broadcastToolStudioUpdate());
  invalidateToolCatalog();
  const jobManager = getJobManager();
  const knownJobStatuses = new Map(jobManager.list().map((job) => [job.id, job.status]));
  unsubscribeJobUpdates?.();
  unsubscribeJobUpdates = jobManager.subscribe((records) => {
    for (const job of records) {
      const previous = knownJobStatuses.get(job.id);
      if (
        previous !== job.status &&
        (job.status === 'completed' || job.status === 'failed')
      ) {
        const counts =
          job.completed +
          ' completed · ' +
          job.failed +
          ' failed · ' +
          job.skipped +
          ' skipped';
        runNonCritical(() => {
          showNotification(
            job.status === 'completed' ? 'Adi: background task complete' : 'Adi: background task failed',
            job.title + ' · ' + counts,
            job.status === 'failed' ? 'high' : 'normal',
          );
        });
      }
      knownJobStatuses.set(job.id, job.status);
    }
    runNonCritical(() => {
      if (!win?.isDestroyed()) win?.webContents.send('jobs:updated', records);
    });
  });
  const mutationJournal = getMutationJournal();
  unsubscribeMutationUpdates?.();
  unsubscribeMutationUpdates = mutationJournal.subscribe((records) => {
    runNonCritical(() => {
      if (!win?.isDestroyed()) win?.webContents.send('mutations:updated', records);
    });
  });
  startCursorTracking();
  runNonCritical(registerConfiguredHotkey);

  // Keep the on-disk reference copies of the built-in tools current.
  try {
    custom.writeBuiltinManifests(TOOL_SCHEMAS);
  } catch {
    /* the folder is documentation, never load-bearing */
  }

  setRemindersPaused(getSettings().privacyMode);

  // Opening the shared PowerShell session now, and compiling its interop, means
  // the first tool call costs 20ms rather than half a second.
  startHostWarmup();

  // MCP servers are separate processes and can take seconds to come up. Doing
  // it in the background means a slow or broken server delays its own tools
  // rather than the pet appearing.
  if (!getSettings().privacyMode) {
    beginBackgroundMcpConnect();
  }

  // Quick chats expire on a wall-clock deadline, so the sweep has to happen
  // while the app is running, not only when the list is opened.
  quickSweep = setInterval(() => {
    try {
      purgeExpiredQuickChats();
    } catch (error) {
      logRuntimeError('integration-error', error);
    }
  }, 10 * 60 * 1000);
  startGoalWatcher();

  app.on('activate', () => {
    runNonCritical(() => {
      if (shutdownStarted) return;
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}).catch((error) => {
  logRuntimeError('integration-error', error);
  requestShutdown();
});

let quickSweep: ReturnType<typeof setInterval> | null = null;

let shutdownPromise: Promise<void> | null = null;
let allowProcessQuit = false;

async function shutdownStep(action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    logRuntimeError('integration-error', error);
  }
}

function runNonCritical(action: () => void): void {
  try {
    action();
  } catch (error) {
    logRuntimeError('integration-error', error);
  }
}
function reconcileLaunchOnStartup(enabled = getSettings().launchOnStartup): void {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: [] });
  } catch (error) {
    const message =
      'Could not apply the launch-at-startup preference: ' +
      (error instanceof Error ? error.message : String(error));
    logRuntimeError('integration-error', new Error(message));
    runNonCritical(() => showNotification('Adi: launch-at-startup unavailable', message, 'high'));
  }
}

function stopLifecycleTimers(): void {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  if (quickSweep) {
    clearInterval(quickSweep);
    quickSweep = null;
  }
  if (goalTimer) {
    clearInterval(goalTimer);
    goalTimer = null;
  }
}

async function shutdownAfterTurns(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownStarted = true;
  shutdownPromise = (async () => {
    await shutdownStep(() => stopLifecycleTimers());
    await shutdownStep(() => setRemindersPaused(true));
    await shutdownStep(() => cancelActiveTurns());
    await shutdownStep(() => cancelActiveScreenCaptures());
    await shutdownStep(() => cancelActiveWorkspaceSearches());
    await shutdownStep(() => cancelActiveAttachmentOperations());
    await shutdownStep(() => cancelActiveHostWarmups());
    await shutdownStep(() => cancelActiveLiveProbes());
    await shutdownStep(() => cancelActiveDiagnostics());
    await shutdownStep(() => cancelActiveUndos());
    await shutdownStep(() => cancelActiveToolStudioTests());
    await shutdownStep(() => cancelActiveMcpOperations());
    await shutdownStep(() => cancelCredentialRefresh());
    await shutdownStep(() => drainActiveScreenCaptures());
    await shutdownStep(() => drainActiveWorkspaceSearches());
    await shutdownStep(() => drainActiveLiveProbes());
    await shutdownStep(() => drainActiveDiagnostics());
    await shutdownStep(() => drainActiveUndos());
    await shutdownStep(() => drainActiveToolStudioTests());
    await shutdownStep(() => drainActiveMcpOperations());
    await shutdownStep(() => drainActiveHostWarmups());
    await shutdownStep(() => cancelSignIn());
    try {
      await turnQueue;
    } catch (error) {
      logRuntimeError('integration-error', error);
    }
    await shutdownStep(() => shutdownJobs());
    await shutdownStep(() => voice.close());
    await shutdownStep(() => shutdownChrome());
    await shutdownStep(() => shutdownHost());
    await shutdownStep(() => {
      unsubscribeMutationUpdates?.();
      unsubscribeMutationUpdates = null;
      unsubscribeMcpStatus?.();
      unsubscribeMcpStatus = null;
      unsubscribeToolUpdates?.();
      unsubscribeToolUpdates = null;
    });
    await shutdownStep(() => mcp.shutdown());
    await shutdownStep(() => closeDb());
    if (!allowProcessQuit) {
      allowProcessQuit = true;
      app.quit();
    }
  })();
  return shutdownPromise;
}

function requestShutdown(): void {
  void shutdownAfterTurns().catch((error) => logRuntimeError('integration-error', error));
}

app.on('before-quit', (event) => {
  if (allowProcessQuit) return;
  event.preventDefault();
  requestShutdown();
});

app.on('will-quit', () => {
  runNonCritical(() => cancelActiveTurns());
  runNonCritical(() => globalShortcut.unregisterAll());
});

app.on('window-all-closed', () => {
  // macOS keeps the application alive after the last window closes; do not
  // tear down reusable services until the user explicitly quits.
  if (process.platform !== 'darwin') requestShutdown();
});

/* -------------------------------------------------------------------- IPC */

function assertTrustedRenderer(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const current = win;
  if (
    !current ||
    current.isDestroyed() ||
    !isTrustedIpcEvent(event, current.webContents)
  ) {
    throw new Error('IPC request came from an untrusted renderer.');
  }
}

function registerIpcHandler<Args extends unknown[], Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRenderer(event);
    if (shutdownStarted) throw new Error('Application is shutting down.');
    return handler(event, ...(args as Args));
  });
}

function registerIpcEvent<Args extends unknown[]>(
  channel: string,
  handler: (event: IpcMainEvent, ...args: Args) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    const current = win;
    if (
      !current ||
      current.isDestroyed() ||
      !isTrustedIpcEvent(event, current.webContents)
    ) {
      return;
    }
    if (shutdownStarted) return;
    try {
      handler(event, ...(args as Args));
    } catch (error) {
      logRuntimeError('integration-error', error);
    }
  });
}
registerIpcHandler('window:set-expanded', (_e, next: boolean) => {
  if (typeof next !== 'boolean') throw new Error('Expanded state must be boolean.');
  setExpanded(next);
  return expanded;
});

registerIpcHandler('window:get-position', () => win?.getPosition() ?? [0, 0]);

/**
 * Dragging is driven from the renderer rather than a CSS drag region, because
 * -webkit-app-region: drag makes an element unclickable — the OS consumes the
 * mouse events before any handler sees them.
 */
registerIpcEvent('window:move-to', (_e, x: number, y: number) => {
  try {
    if (!isFiniteWindowCoordinate(x) || !isFiniteWindowCoordinate(y)) return;
    if (!win || expanded) return;
    const size = collapsedSize();
    const p = clampStrict(x, y, size.width, size.height);
    win.setPosition(p.x, p.y);
  } catch (error) {
    logRuntimeError('integration-error', error);
  }
});

registerIpcHandler('window:save-position', () => {
  if (!win || expanded) return;
  const [x, y] = win.getPosition();
  setSettings([
    { key: 'petX', value: x },
    { key: 'petY', value: y },
  ]);
});

/**
 * Grows the pet window for quick chat and shrinks it back afterwards.
 *
 * The window is anchored to whichever corner it already hugs, so growing
 * upward keeps the creature where it is and the speech bubble opens above it.
 */
registerIpcHandler('window:set-quick', (_e, next: 'off' | 'ask' | 'answer') => {
  if (!isKnownString(next, ['off', 'ask', 'answer'])) throw new Error('Quick window mode is invalid.');
  if (next === quickMode) return quickMode;
  quickMode = next;
  if (!expanded) applySize(collapsedSize());
  return quickMode;
});

registerIpcHandler('window:set-bubble', (_e, next: boolean) => {
  if (typeof next !== 'boolean') throw new Error('Bubble state must be boolean.');
  setBubbleOpen(next);
  return bubbleOpen;
});

registerIpcHandler('window:quit', () => {
  app.quit();
});

registerIpcEvent('window:set-dragging', (_e, active: boolean) => {
  try {
    if (typeof active !== 'boolean') return;
    dragging = active;
    if (active) setInteractive(true);
  } catch (error) {
    logRuntimeError('integration-error', error);
  }
});

registerIpcHandler('auth:status', async () => {
  const stored = loadTokens();
  if (!stored) return { signedIn: false };
  return {
    signedIn: true,
    accountId: stored.accountId,
    email: stored.email,
    expiresAt: stored.expiresAt,
    mode: 'subscription' as const,
  };
});

registerIpcHandler('auth:sign-in', async () => {
  assertPrivacyOff('sign-in and account access');
  const t = await signIn();
  return { signedIn: true, accountId: t.accountId, email: t.email, expiresAt: t.expiresAt };
});

registerIpcHandler('auth:sign-out', () => {
  cancelActiveLiveProbes();
  cancelActiveDiagnostics();
  signOut();
  return { signedIn: false };
});

registerIpcHandler('realtime:probe', () =>
  runCancellableLiveProbe('realtime probing', (signal) => probeRealtime(signal)),
);

registerIpcHandler('auth:probe', async () => {
  const result = await runCancellableLiveProbe('account probing', (signal) => probeEndpoint(signal));
  if (shutdownStarted) throw new Error('Application is shutting down.');
  // Remember the model this account can actually use, so later runs skip the
  // sweep and never fall back to an id the plan rejects.
  if (result.ok && result.model) setSetting('model', result.model);
  return result;
});

// "Can we send a request at all" — which an API key satisfies just as well as
// being signed in, so this is no longer a question about OAuth.
registerIpcHandler('auth:ensure', async () =>
  runCancellableLiveProbe('account access', (signal) => haveCredentials(signal)),
);

function requireIpcIdentifier(value: unknown, label: string): string {
  if (!isNonEmptyBoundedString(value, MAX_IPC_IDENTIFIER_CHARS)) {
    throw new Error(label + ' must be non-empty text of ' + MAX_IPC_IDENTIFIER_CHARS + ' characters or fewer.');
  }
  return value.trim();
}

const CONVERSATION_REFERENCE_KINDS: readonly ConversationReferenceKind[] = [
  'file',
  'goal',
  'assignment',
  'project',
];

function isConversationReferenceKind(value: unknown): value is ConversationReferenceKind {
  return typeof value === 'string' && CONVERSATION_REFERENCE_KINDS.includes(value as ConversationReferenceKind);
}

function requireConversationId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('A valid conversation id is required.');
  }
  return value;
}

function optionalConversationFolderId(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('Folder filter must be a non-negative integer.');
  }
  return value;
}
function requireConversationFolderId(value: unknown): number {
  const id = optionalConversationFolderId(value);
  if (id === undefined || id < 1) throw new Error('A valid conversation folder id is required.');
  return id;
}

function requireConversationFolderName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A conversation folder name is required.');
  return value;
}


function resolveConversationReference(
  kindValue: unknown,
  targetValue: unknown,
): { kind: ConversationReferenceKind; reference: string; label: string } {
  if (!isConversationReferenceKind(kindValue)) throw new Error('Unknown conversation reference kind.');
  if (typeof targetValue !== 'string' || !targetValue.trim()) {
    throw new Error('A reference target is required.');
  }
  const target = targetValue.trim();

  if (kindValue === 'project') {
    const project = projects.findProject(target);
    if (!project) throw new Error('No matching project was found.');
    return { kind: kindValue, reference: project.id, label: project.name };
  }
  if (kindValue === 'goal') {
    const goal = goals.findGoal(target);
    if (!goal) throw new Error('No matching goal was found.');
    return { kind: kindValue, reference: goal.id, label: goal.title };
  }
  if (kindValue === 'assignment') {
    const assignment = assignments.findAssignment(target);
    if (!assignment) throw new Error('No matching assignment was found.');
    return { kind: kindValue, reference: assignment.id, label: assignment.title };
  }

  if (!isAbsolute(target)) throw new Error('File references must use an absolute path.');
  const filePath = resolve(target);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(filePath);
  } catch {
    throw new Error('The file reference does not exist.');
  }
  if (!stats.isFile()) throw new Error('File references must point to a regular file.');
  return { kind: 'file', reference: filePath, label: basename(filePath) || filePath };
}

registerIpcHandler('chat:history', () => {
  const id = latestConversationId();
  return { conversationId: id, messages: getAllMessages(id) };
});

registerIpcHandler('chat:list', (_e, kind?: ConversationKind, archived?: unknown, folderId?: unknown) => {
  // Sweeping on read as well as on a timer means the list is never showing a
  // quick chat that is already past its four hours.
  if (kind !== undefined && !isKnownString(kind, ['chat', 'quick'])) throw new Error('Conversation kind is invalid.');
  if (kind === 'quick') purgeExpiredQuickChats();
  if (archived !== undefined && typeof archived !== 'boolean') throw new Error('Archive filter must be boolean.');
  if (archived === true && kind !== 'chat') throw new Error('Only regular conversations can be archived.');
  return listConversations(100, kind, archived === true, optionalConversationFolderId(folderId));
});

registerIpcHandler('chat:folders:list', () => listConversationFolders());

registerIpcHandler('chat:folders:create', (_e, name: unknown) =>
  createConversationFolder(requireConversationFolderName(name)),
);

registerIpcHandler('chat:folders:rename', (_e, id: unknown, name: unknown) =>
  renameConversationFolder(requireConversationFolderId(id), requireConversationFolderName(name)),
);

registerIpcHandler('chat:folders:delete', (_e, id: unknown) => {
  deleteConversationFolder(requireConversationFolderId(id));
  return listConversationFolders();
});

registerIpcHandler('chat:folder:set', (_e, id: unknown, folderId: unknown) => {
  const conversationId = requireConversationId(id);
  const nextFolderId = folderId === null ? null : optionalConversationFolderId(folderId);
  if (nextFolderId === undefined) throw new Error('A folder id or null is required.');
  setConversationFolder(conversationId, nextFolderId);
  return listConversations(100);
});

registerIpcHandler('workspace:search', async (_e, query: unknown) => {
  if (typeof query !== 'string') throw new Error('A search query is required.');
  const settings = getSettings();
  const controller = new AbortController();
  const operation = searchLocalWorkspace(query, {
    includeWorkspaceFiles: settings.workspaceFileSearchEnabled,
    workspaceRoot: settings.workspaceRoot,
    signal: controller.signal,
  });
  activeWorkspaceSearches.set(controller, operation);
  try {
    const results = await operation;
    if (controller.signal.aborted || shutdownStarted) return [];
    const latestSettings = getSettings();
    const fileScopeChanged =
      settings.workspaceFileSearchEnabled &&
      (latestSettings.privacyMode ||
        !latestSettings.workspaceFileSearchEnabled ||
        latestSettings.workspaceRoot.trim() !== settings.workspaceRoot.trim());
    return fileScopeChanged ? results.filter((result) => result.kind !== 'file') : results;
  } catch (error) {
    if (controller.signal.aborted || shutdownStarted) return [];
    throw error;
  } finally {
    activeWorkspaceSearches.delete(controller);
  }
});
registerIpcHandler('chat:star', (_e, id: unknown, starred: unknown) => {
  const conversationId = requireConversationId(id);
  if (typeof starred !== 'boolean') throw new Error('Star state must be boolean.');
  setConversationStarred(conversationId, starred);
  return listConversations(100);
});

registerIpcHandler('chat:archive', (_e, id: unknown, archived: unknown) => {
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw new Error('A valid conversation id is required.');
  if (typeof archived !== 'boolean') throw new Error('Archive state must be boolean.');
  setConversationArchived(id, archived);
  return listConversations(100, 'chat', archived);
});

registerIpcHandler('chat:references:list', (_e, id: unknown) => {
  return listConversationReferences(requireConversationId(id));
});

registerIpcHandler('chat:references:add', (_e, id: unknown, kind: unknown, target: unknown) => {
  const conversationId = requireConversationId(id);
  const resolved = resolveConversationReference(kind, target);
  addConversationReference(conversationId, resolved.kind, resolved.reference, resolved.label);
  return listConversationReferences(conversationId);
});

registerIpcHandler('chat:references:remove', (_e, id: unknown, referenceId: unknown) => {
  const conversationId = requireConversationId(id);
  if (typeof referenceId !== 'number' || !Number.isInteger(referenceId) || referenceId < 1) {
    throw new Error('A valid reference id is required.');
  }
  removeConversationReference(conversationId, referenceId);
  return listConversationReferences(conversationId);
});

registerIpcHandler('chat:branch', (_e, id: unknown, title?: unknown) => {
  const sourceId = requireConversationId(id);
  if (title !== undefined && typeof title !== 'string') throw new Error('Branch title must be text.');
  const branchId = branchConversation(sourceId, title as string | undefined);
  return { conversationId: branchId, messages: getAllMessages(branchId) };
});

registerIpcHandler('chat:open', (_e, id: unknown) => {
  const conversationId = requireConversationId(id);
  return {
    conversationId,
    messages: getAllMessages(conversationId),
  };
});

registerIpcHandler('chat:rename', (_e, id: unknown, title: unknown) => {
  const conversationId = requireConversationId(id);
  if (!isBoundedString(title, MAX_CHAT_TEXT_CHARS)) throw new Error('Conversation title is too long or not text.');
  setConversationTitle(conversationId, title);
  return listConversations();
});

registerIpcHandler('chat:delete', (_e, id: unknown) => {
  const conversationId = requireConversationId(id);
  if (pendingTurnConversations.has(conversationId)) {
    throw new Error('Cannot delete a conversation while a turn is active or queued; stop it first.');
  }
  deleteConversation(conversationId);
  return listConversations();
});

registerIpcHandler('chat:new', () => {
  const id = createConversation();
  return { conversationId: id, messages: [] };
});

registerIpcHandler('chat:send', async (
  _e,
  conversationId: unknown,
  text: unknown,
  attachments: unknown = [],
) => {
  const safeConversationId = requireConversationId(conversationId);
  if (!isBoundedString(text, MAX_CHAT_TEXT_CHARS)) throw new Error('Chat text is too long or not text.');
  const safeAttachments = normaliseAttachments(attachments);
  if (!win) return;

  try {
    await runManagedTurn(safeConversationId, text, safeAttachments, 'chat');
  } finally {
    // runTurn stores the user message; title only after that point so new
    // regular chats become discoverable even when the model turn fails.
    if (!shutdownStarted) {
      try {
        autoTitleConversation(safeConversationId);
      } catch (error) {
        logRuntimeError('turn-error', error);
      }
    }
  }
});

/**
 * A quick question from the hover bar.
 *
 * Same agent, same permission gate, but its own kind of conversation: kept
 * afterwards so you can find the answer again, swept four hours later unless
 * you starred it. Asking again within a few minutes continues the same thread,
 * which is what makes "and the other one?" work.
 */
registerIpcHandler('chat:quick', async (_e, text: unknown, attachments: unknown = []) => {
  if (!isBoundedString(text, MAX_CHAT_TEXT_CHARS)) throw new Error('Chat text is too long or not text.');
  const safeAttachments = normaliseAttachments(attachments);
  if (!win) return;
  const conversationId = currentQuickConversation();
  try {
    await runManagedTurn(conversationId, text, safeAttachments, 'quick');
  } finally {
    if (!shutdownStarted) {
      try {
        autoTitleConversation(conversationId);
      } catch (error) {
        logRuntimeError('turn-error', error);
      }
    }
  }
});

/**
 * Grabs the screen for the composer, so "look at my screen" is a button rather
 * than a tool call the model has to think of first.
 */
registerIpcHandler('screen:capture', async (): Promise<Attachment[]> => {
  if (getSettings().privacyMode) throw new Error('Privacy pause is on; screen capture is disabled.');
  const controller = new AbortController();
  const operation = captureScreen('primary', controller.signal);
  activeScreenCaptures.set(controller, operation);
  try {
    const shots = await operation;
    if (shutdownStarted) return [];
    if (controller.signal.aborted || getSettings().privacyMode) {
      throw new Error('Privacy pause is on; screen capture was cancelled.');
    }
    return normaliseAttachments(shots.map((s, i) => ({
      name: shots.length > 1 ? `screen-${i + 1}.png` : 'screen.png',
      kind: 'image' as const,
      dataUrl: s.dataUrl,
    })));
  } finally {
    activeScreenCaptures.delete(controller);
  }
});

registerIpcHandler('chat:cancel', () => {
  cancelActiveTurns();
});

registerIpcHandler('permission:respond', (_e, id: unknown, decision: unknown) => {
  const requestId = requireIpcIdentifier(id, 'Permission request id');
  if (!isPermissionDecision(decision)) throw new Error('Permission decision is invalid.');
  pendingConfirms.resolve(requestId, decision);
});

registerIpcHandler('models:list', () => selectableModels());

/** Remembers a model id the user typed in, so it survives restarts. */
registerIpcHandler('models:add', (_e, id: string) => {
  if (typeof id !== 'string') throw new Error('A model id is required.');
  const clean = id.trim();
  if (!clean) return selectableModels();
  if (!normaliseModelId(clean)) throw new Error('Model ids must be 500 characters or fewer.');
  const custom = customModelIds();
  if (!custom.includes(clean)) {
    if (custom.length >= MAX_CUSTOM_MODELS) throw new Error('The custom model list is full; remove an old id before adding another.');
    custom.push(clean);
    setSetting('customModels', JSON.stringify(custom));
  }
  applyCustomModelIds(custom);
  return selectableModels();
});

registerIpcHandler('chrome:profiles', () => {
  assertPrivacyOff('browser profile discovery');
  return listProfiles();
});

/** Checks each selectable model against the live account. */
registerIpcHandler('models:probe', async () => {
  const custom = customModelIds();
  return runCancellableLiveProbe('model availability checks', (signal) => probeModels(custom, signal));
});

registerIpcHandler('workspace:pick-root', async () => {
  if (!win) return { canceled: true as const };
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a workspace folder',
    properties: ['openDirectory'],
  });
  if (shutdownStarted || res.canceled || !res.filePaths[0]) return { canceled: true as const };

  try {
    const root = validateWorkspaceRoot(res.filePaths[0]);
    logAudit({
      operationId: createOperationId(),
      toolName: 'workspace_pick_root',
      args: {},
      tier: 'auto',
      decision: 'user-picker',
      ok: true,
      result: 'Workspace root selected.',
    });
    return { canceled: false as const, root };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAudit({
      operationId: createOperationId(),
      toolName: 'workspace_pick_root',
      args: {},
      tier: 'never',
      decision: 'validation-failed',
      ok: false,
      result: message,
    });
    return { canceled: false as const, error: message };
  }
});

registerIpcHandler('clipboard:read-text', () => {
  assertPrivacyOff('clipboard draft');
  return clipboard.readText().slice(0, MAX_CLIPBOARD_DRAFT_CHARS);
});


registerIpcHandler('files:pick', async () => {
  return runTrackedAttachmentOperation(async (signal) => {
    assertPrivacyOff('file attachments');
    if (!win) return [];
    const res = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'Text', extensions: ['txt', 'md', 'json', 'csv', 'log', 'ts', 'js', 'py', 'lua', 'html', 'css', 'xml', 'yml', 'yaml'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (shutdownStarted || signal.aborted || res.canceled) return [];
    return readRendererAttachmentPaths(res.filePaths, signal);
  });
});

registerIpcHandler('files:read', (_e, paths: unknown) =>
  runTrackedAttachmentOperation((signal) => readRendererAttachmentPaths(paths, signal)),
);

registerIpcHandler('voice:dictate-start', async () => (getSettings().privacyMode ? false : (win ? voice.startDictation(win) : false)));

registerIpcHandler('voice:dictate-stop', () => {
  voice.stopDictation();
  return false;
});

/** Microphone audio, base64 PCM16 at 24kHz mono. */
registerIpcEvent('voice:audio', (_e, base64: string) => {
  try {
    if (!isPcm16Base64Chunk(base64)) return;
    if (!getSettings().privacyMode) voice.pushAudio(base64);
  } catch (error) {
    logRuntimeError('integration-error', error);
  }
});

registerIpcHandler('voice:speak', async (_e, text: unknown) => {
  if (!isBoundedString(text, MAX_VOICE_TEXT_CHARS)) throw new Error('Voice text is too long or not text.');
  assertPrivacyOff('voice output');
  if (win) await voice.speak(win, text);
});

registerIpcEvent('voice:stop-speaking', () => {
  try {
    voice.stopSpeaking();
  } catch (error) {
    logRuntimeError('integration-error', error);
  }
});

registerIpcHandler('voice:close', () => {
  voice.close();
  return false;
});

registerIpcHandler('voice:models', () => voice.VOICE_MODELS);

/** Opens the socket ahead of the first press, so dictation starts instantly. */
registerIpcHandler('voice:prewarm', async () => {
  if (getSettings().privacyMode) return false;
  if (win) await voice.prewarm(win);
  return voice.isOpen();
});

registerIpcHandler('hotkey:set', (_e, accelerator: unknown) => {
  if (!isBoundedString(accelerator, MAX_HOTKEY_CHARS)) throw new Error('Hotkey must be text of 256 characters or fewer.');
  const previous = getSettings().hotkey;
  const result = registerHotkey(accelerator);
  if (!result.ok) {
    runNonCritical(() => {
      const restored = registerHotkey(previous);
      if (!restored.ok && previous) throw new Error('The previous hotkey could not be restored: ' + restored.message);
    });
    return result;
  }
  try {
    setSetting('hotkey', accelerator);
  } catch (error) {
    runNonCritical(() => registerHotkey(previous));
    throw error;
  }
  return result;
});

registerIpcHandler('settings:get', () => getSettings());

registerIpcHandler('settings:set', (_e, key: unknown, value: unknown, expectedWorkspaceRoot: unknown) => {
  const update = validateSettingUpdate(key, value, PROVIDERS.map((provider) => provider.id));
  let nextValue = update.value;
  if (update.key === 'workspaceRoot') {
    const requested = String(update.value ?? '').trim();
    nextValue = requested ? validateWorkspaceRoot(requested) : '';
  }
  const settingsBefore = getSettings();
  if (!workspaceConsentScopeMatches(update.key, settingsBefore.workspaceRoot, expectedWorkspaceRoot)) {
    // A consent request from the previous folder must not re-enable sharing on a new root.
    return settingsBefore;
  }
  const durableUpdates: Array<Parameters<typeof setSettings>[0][number]> = [
    { key: update.key, value: nextValue as never },
  ];
  if (update.key === 'provider') {
    const remembered = rememberedModelForProvider(String(nextValue) as ProviderId, settingsBefore.providerModels);
    if (remembered) durableUpdates.push({ key: 'model', value: remembered });
  }
  // A model chosen for one provider is remembered so switching back restores it.
  if (update.key === 'model') {
    const map = normaliseProviderModels(settingsBefore.providerModels);
    map[settingsBefore.provider] = String(nextValue);
    durableUpdates.push({ key: 'providerModels', value: JSON.stringify(map) });
  }
  const browserProfileChanged =
    (update.key === 'chromeMode' && settingsBefore.chromeMode !== nextValue) ||
    (update.key === 'chromeProfileDir' && settingsBefore.chromeMode === 'system' && settingsBefore.chromeProfileDir !== nextValue);
  setSettings(durableUpdates);
  if (browserProfileChanged) {
    // A profile switch is a security and session boundary: stop work that
    // could still be talking to the previous browser profile and invalidate
    // the parked Google Docs tab before the next call reacquires Chrome.
    runNonCritical(() => cancelActiveTurns());
    runNonCritical(() => shutdownChrome());
    runNonCritical(() => gdocs.resetDocsSession());
    runNonCritical(() => google.resetGoogleSession());
  }
  if (update.key === 'provider' || update.key === 'customBaseUrl') {
    runNonCritical(() => cancelActiveLiveProbes());
    runNonCritical(() => cancelActiveDiagnostics());
  }
  if (
    update.key === 'workspaceRoot' ||
    (update.key === 'workspaceFileSearchEnabled' && update.value === false) ||
    (update.key === 'privacyMode' && update.value === true)
  ) {
    runNonCritical(() => cancelActiveWorkspaceSearches());
  }
  if (update.key === 'privacyMode' && update.value === true) {
    runNonCritical(() => cancelActiveTurns());
    // Background batches are detached from the original turn. Privacy mode
    // must stop them too because PowerShell can reach remote services.
    runNonCritical(() => getJobManager().cancelAll());
    runNonCritical(() => setRemindersPaused(true));
    runNonCritical(() => cancelActiveScreenCaptures());
    runNonCritical(() => cancelActiveLiveProbes());
    runNonCritical(() => cancelActiveDiagnostics());
    runNonCritical(() => cancelActiveToolStudioTests());
    runNonCritical(() => cancelActiveAttachmentOperations());
    runNonCritical(() => cancelActiveMcpOperations());
    runNonCritical(() => cancelCredentialRefresh());
    runNonCritical(() => cancelSignIn());
    runNonCritical(() => voice.stopDictation());
    runNonCritical(() => voice.close());
    runNonCritical(() => mcp.shutdown());
    for (const goal of goals.loadGoals()) {
      if (!goal.watch) continue;
      try {
        goals.stopWatching(goal.id);
      } catch (error) {
        logRuntimeError('integration-error', error);
      }
    }
  }
  if (update.key === 'privacyMode' && update.value === false) {
    runNonCritical(() => setRemindersPaused(false));
    beginBackgroundMcpConnect();
  }
  if (update.key === 'launchOnStartup') {
    runNonCritical(() => reconcileLaunchOnStartup(Boolean(update.value)));
  }
  return getSettings();
});

const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);

function requireProviderId(value: unknown): ProviderId {
  if (!isKnownString(value, PROVIDER_IDS)) throw new Error('A valid provider id is required.');
  return value as ProviderId;
}

function safeJson(text: string): Record<string, string> {
  return normaliseProviderModels(text);
}

/**
 * Points `model` at something the new provider actually serves.
 *
 * Carrying "gpt-5.6-sol" across to Anthropic would fail on the next message
 * with an unhelpful 404, so a switch restores whatever was last used there, or
 * falls back to that provider's first model.
 */
function rememberedModelForProvider(next: ProviderId, providerModels: string): string | undefined {
  const info = providerInfo(next);
  const remembered = safeJson(providerModels)[next];
  const known = info.models.map((m) => m.id);
  return remembered ?? known[0];
}

/* ---------------------------------------------------------- access points */

registerIpcHandler('providers:list', () =>
  PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    shape: p.shape,
    needsKey: p.needsKey,
    keyUrl: p.keyUrl,
    note: p.note,
    models: p.models,
    ...keyStatus(p.id),
  })),
);

registerIpcHandler('providers:set-key', (_e, id: unknown, key: unknown) => {
  const providerId = requireProviderId(id);
  if (!isBoundedString(key, MAX_PROVIDER_KEY_CHARS)) {
    throw new Error('Provider keys must be text of ' + MAX_PROVIDER_KEY_CHARS + ' characters or fewer.');
  }
  saveApiKey(providerId, key);
  runNonCritical(() => cancelActiveLiveProbes());
  runNonCritical(() => cancelActiveDiagnostics());
  return keyStatus(providerId);
});

registerIpcHandler('providers:clear-key', (_e, id: unknown) => {
  const providerId = requireProviderId(id);
  clearApiKey(providerId);
  runNonCritical(() => cancelActiveLiveProbes());
  runNonCritical(() => cancelActiveDiagnostics());
  return keyStatus(providerId);
});

/* --------------------------------------------------------------- MCP */

registerIpcHandler('goals:list', () => goals.loadGoals());

registerIpcHandler('goals:finish', (_e, id: unknown, dropped: unknown) => {
  const goalId = requireIpcIdentifier(id, 'Goal id');
  if (typeof dropped !== 'boolean') throw new Error('Goal completion state must be boolean.');
  goals.setStatus(goalId, dropped ? 'dropped' : 'done');
  return goals.loadGoals();
});

registerIpcHandler('goals:stop-watch', (_e, id: unknown) => {
  goals.stopWatching(requireIpcIdentifier(id, 'Goal id'));
  return goals.loadGoals();
});

registerIpcHandler('goals:check-now', (_e, id: unknown) => {
  if (getSettings().privacyMode) return false;
  const goal = goals.findGoal(requireIpcIdentifier(id, 'Goal id'));
  if (!goal) return false;
  return beginGoalCheckin(goal);
});

registerIpcHandler('jobs:list', () => getJobManager().list());

registerIpcHandler('jobs:cancel', (_e, id: unknown) => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('A background-job id is required.');
  }
  getJobManager().cancel(id);
  return getJobManager().list();
});

registerIpcHandler('mutations:list', () => getMutationJournal().list());

registerIpcHandler('mutations:undo', async (_e, id: unknown) => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('A mutation journal id is required.');
  }
  const controller = new AbortController();
  const operation = (async () => {
    await undoMutation(id, controller.signal);
    if (shutdownStarted) throw new Error('Application is shutting down.');
    return getMutationJournal().list();
  })();
  activeUndos.set(controller, operation);
  try {
    return await operation;
  } finally {
    activeUndos.delete(controller);
  }
});

registerIpcHandler('projects:list', () => projects.listProjectSummaries());
registerIpcHandler('assignments:list', () => assignments.listAssignmentSummaries());

function requireMemoryIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('A saved-lesson index must be a positive integer.');
  }
  return value;
}

registerIpcHandler('memory:list', () => custom.listLessonEntries());

registerIpcHandler('memory:edit', (_e, index: unknown, lesson: unknown) => {
  if (typeof lesson !== 'string') throw new Error('A replacement lesson is required.');
  custom.editLesson(requireMemoryIndex(index), lesson);
  return custom.listLessonEntries();
});

registerIpcHandler('memory:remove', (_e, index: unknown) => {
  custom.deleteLesson(requireMemoryIndex(index));
  return custom.listLessonEntries();
});

function requirePermissionSignature(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/i.test(value.trim())) {
    throw new Error('A valid saved-approval signature is required.');
  }
  return value.trim();
}

function studioSaveInput(definition: ToolStudioDefinition): Omit<custom.CustomTool, 'createdAt'> {
  if (!isToolStudioDefinition(definition)) throw new Error('Invalid Tool Studio definition.');
  const normalized = custom.normaliseStoredTool({ ...definition, createdAt: definition.createdAt ?? '' });
  if (!normalized) throw new Error('Tool definition failed schema validation.');
  const { createdAt: _createdAt, source: _source, path: _path, skillId: _skillId, ...safe } = normalized;
  return safe;
}

function broadcastToolStudioUpdate(): void {
  const current = win;
  if (!current || current.isDestroyed()) return;
  try {
    current.webContents.send('tools:updated', custom.listToolStudioTools());
  } catch (error) {
    logRuntimeError('integration-error', error);
  }
}

registerIpcHandler('tools:list', () => custom.listToolStudioTools());
registerIpcHandler('tools:candidates', () => listToolStudioCandidates());

registerIpcHandler('tools:get', (_e, name: unknown) => {
  const toolName = requireIpcIdentifier(name, 'Tool name');
  const tool = custom.findCustomTool(toolName);
  return tool ? custom.toolStudioDefinitionFor(tool) : null;
});

registerIpcHandler('tools:save', (_e, definition: unknown, existingName: unknown) => {
  if (!isToolStudioDefinition(definition)) throw new Error('Invalid Tool Studio definition.');
  const previousName = existingName === undefined ? undefined : requireIpcIdentifier(existingName, 'Existing tool name');
  const safe = studioSaveInput(definition);
  if (previousName !== undefined) {
    if (definition.name !== previousName) throw new Error('Tool names cannot change while editing; create a new tool instead.');
    const existing = custom.findCustomTool(previousName);
    if (!existing) throw new Error('No tool named ' + previousName + '.');
    if (existing.source !== 'agent') {
      throw new Error('This tool is managed by ' + (existing.source === 'skill' ? 'an installed skill.' : 'the tools folder.') + ' and is read-only here.');
    }
    custom.updateCustomTool(previousName, safe);
  } else {
    if (custom.findCustomTool(definition.name)) {
      throw new Error('A tool named ' + definition.name + ' already exists. Select it to edit.');
    }
    custom.saveCustomTool(safe);
  }
  const result = custom.listToolStudioTools();
  broadcastToolStudioUpdate();
  return result;
});

registerIpcHandler('tools:delete', (_e, name: unknown) => {
  custom.deleteCustomTool(requireIpcIdentifier(name, 'Tool name'));
  const result = custom.listToolStudioTools();
  broadcastToolStudioUpdate();
  return result;
});

registerIpcHandler('tools:test', async (_e, name: unknown, rawArgs: unknown): Promise<import('../shared/types').ToolStudioTestResult> => {
  const toolName = requireIpcIdentifier(name, 'Tool name');
  if (!isToolStudioTestArgs(rawArgs)) throw new Error('Tool test arguments must be a JSON object within the safety limit.');
  assertPrivacyOff('custom tool testing');
  const controller = new AbortController();
  const operationId = createOperationId();
  const call: ToolCall = {
    id: 'studio-test-' + operationId,
    name: 'test_tool',
    args: { name: toolName, args: rawArgs },
  };
  const startedAt = Date.now();
  const operation = executeToolCall(call, requestConfirmation, 0, controller.signal, operationId);
  activeToolStudioTests.set(controller, operation);
  try {
    const result = await operation;
    return {
      name: toolName,
      ok: result.ok,
      content: result.content.slice(0, MAX_STREAM_CONTENT_CHARS),
      durationMs: Math.max(0, result.durationMs),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) throw error;
    return {
      name: toolName,
      ok: false,
      content: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, MAX_STREAM_CONTENT_CHARS),
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: 'execution-failed',
    };
  } finally {
    activeToolStudioTests.delete(controller);
    releaseBrowserRequestLock(operationId);
  }
});
registerIpcHandler('permissions:list', () => listAllowlist());

registerIpcHandler('permissions:remove', (_e, signature: unknown) => {
  removeFromAllowlist(requirePermissionSignature(signature));
  return listAllowlist();
});

registerIpcHandler('diagnostics:run', async () => {
  const controller = new AbortController();
  const operation = runDiagnostics(controller.signal);
  activeDiagnostics.set(controller, operation);
  try {
    return await operation;
  } finally {
    activeDiagnostics.delete(controller);
  }
});

registerIpcHandler('mcp:status', () => mcp.status());

async function withMcpOperationLock<T>(
  signal: AbortSignal,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const release = await acquireMutationLock(signal);
  try {
    throwIfAborted(signal);
    return await action(signal);
  } finally {
    release();
  }
}

async function runTrackedMcpOperation<T>(
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const operation = action(controller.signal);
  activeMcpOperations.set(controller, operation);
  try {
    return await operation;
  } finally {
    activeMcpOperations.delete(controller);
  }
}

function beginBackgroundMcpConnect(): void {
  void runTrackedMcpOperation((signal) => mcp.connectAll(signal)).catch((error) => {
    if (shutdownStarted) return;
    try {
      if (getSettings().privacyMode) return;
    } catch {
      /* the database may already be closing */
    }
    logRuntimeError('integration-error', error);
  });
}

registerIpcHandler('mcp:set-disabled', async (_e, name: unknown, disabled: unknown) => {
  if (typeof name !== 'string' || !name.trim()) throw new Error('An MCP server name is required.');
  if (typeof disabled !== 'boolean') throw new Error('The MCP disabled state must be a boolean.');
  return runTrackedMcpOperation((signal) => withMcpOperationLock(signal, async (operationSignal) => {
    if (getSettings().privacyMode) throw new Error('Privacy pause is on; turn it off before changing connected services.');
    mcp.setServerDisabled(name, disabled);
    return mcp.connectAll(operationSignal);
  }));
});

registerIpcHandler('mcp:set-tool-disabled', async (_e, server: unknown, tool: unknown, disabled: unknown) => {
  if (typeof server !== 'string' || !server.trim()) throw new Error('An MCP server name is required.');
  if (typeof tool !== 'string' || !tool.trim()) throw new Error('An MCP tool name is required.');
  if (typeof disabled !== 'boolean') throw new Error('The MCP tool disabled state must be a boolean.');
  return runTrackedMcpOperation((signal) => withMcpOperationLock(signal, async (operationSignal) => {
    if (getSettings().privacyMode) throw new Error('Privacy pause is on; turn it off before changing connected services.');
    mcp.setServerToolDisabled(server, tool, disabled);
    return mcp.connectAll(operationSignal);
  }));
});

registerIpcHandler('mcp:reload', async () => {
  return runTrackedMcpOperation((signal) => withMcpOperationLock(signal, async (operationSignal) => {
    if (getSettings().privacyMode) throw new Error('Privacy pause is on; connected services are disabled.');
    return mcp.connectAll(operationSignal);
  }));
});

registerIpcHandler('mcp:open-config', async () => {
  // Reading it first creates the annotated starter file if it is missing, so
  // the editor never opens on "file not found".
  try {
    mcp.readConfig();
  } catch {
    /* invalid JSON is exactly what they are about to fix */
  }
  const config = mcp.configPath();
  const error = await shell.openPath(config);
  if (error) throw new Error(`Could not open ${config}: ${error}`);
  return config;
});
