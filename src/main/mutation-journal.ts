import { createHash, randomUUID } from 'node:crypto';
import { lstat, opendir, rename, rm } from 'node:fs/promises';
import { rmdir } from 'node:fs/promises';
import { readBoundedBufferFile } from './bounded-file';
import { dirname, resolve } from 'node:path';
import { mutationPathDecisionFor } from './path-safety';
import { redactSecrets } from './redaction';

const MAX_MUTATIONS = 100;
const MAX_SUMMARY = 360;
const MAX_HASH_BYTES = 8_000_000;
const MAX_ARTIFACTS = 8;
const MAX_ARTIFACT_PATH = 1_000;
const MAX_DECLARED_EFFECTS = 8;
const MAX_DECLARED_EFFECT = 600;

const JOURNALED_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'create_folder',
  'delete_item',
  'move_item',
  'copy_item',
  'compress',
  'extract',
  'download_file',
  'resize_image',
  'convert_image',
  'crop_image',
  'replace_in_files',
  'create_shortcut',
  'chrome_save_pdf',
  'run_batch',
]);

export type MutationStatus =
  | 'pending'
  | 'undoable'
  | 'undoing'
  | 'undone'
  | 'not-undoable'
  | 'stale'
  | 'failed'
  | 'uncertain';

export type DeferredMutationOutcome = 'completed' | 'failed' | 'cancelled';

export type MutationFailureOutcome = 'failed' | 'uncertain';

export interface MutationManifest {
  artifactPaths?: readonly string[];
  effects?: readonly string[];
  reason?: string;
}


export type MutationArtifactKind = 'file' | 'directory' | 'other' | 'missing' | 'unknown';

export interface MutationArtifact {
  path: string;
  kind: MutationArtifactKind;
  size?: number;
  sha256?: string;
  verified: boolean;
}

export interface FileFingerprint {
  kind: 'file';
  size: number;
  sha256: string;
}

export type UndoAction =
  | {
      kind: 'remove-created-folder';
      path: string;
    }
  | {
      kind: 'move-back';
      from: string;
      to: string;
      expected: FileFingerprint;
    }
  | {
      kind: 'remove-copy';
      path: string;
      expected: FileFingerprint;
    }
  | {
      kind: 'remove-created-file';
      path: string;
      expected: FileFingerprint;
    };

export interface MutationRecord {
  id: string;
  operationId?: string;
  toolName: string;
  summary: string;
  createdAt: number;
  completedAt?: number;
  undoneAt?: number;
  status: MutationStatus;
  undo?: UndoAction;
  reason?: string;
  errorCode?: string;
  artifacts?: MutationArtifact[];
  declaredOutputs?: string[];
  declaredEffects?: string[];
}

export interface MutationPersistence {
  load(): MutationRecord[];
  save(records: readonly MutationRecord[]): void;
}

export type MutationListener = (records: MutationRecord[]) => void;

export interface MutationHandle {
  id: string;
  plan: MutationPlan;
  artifactPaths: string[];
}

type MutationPlan =
  | {
      kind: 'remove-created-file';
      path: string;
    }
  | {
      kind: 'remove-created-folder';
      path: string;
    }
  | {
      kind: 'move-file';
      from: string;
      to: string;
      sourceBefore?: FileFingerprint;
      reason?: string;
    }
  | {
      kind: 'copy-file';
      to: string;
      sourceBefore?: FileFingerprint;
      reason?: string;
    }
  | {
      kind: 'none';
      reason: string;
    };

interface PathState {
  exists: boolean;
  kind?: 'file' | 'directory' | 'other';
  size?: number;
  sha256?: string;
}

interface CapturedPath {
  absolute: string;
  state: PathState;
}

const TERMINAL_STATUSES = new Set<MutationStatus>([
  'undoable',
  'undone',
  'not-undoable',
  'stale',
  'failed',
  'uncertain',
]);
function boundedManifestList(
  values: readonly unknown[] | undefined,
  maximum: number,
  itemMaximum: number,
): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => redactSecrets(value).replace(/[\r\n\0]/g, ' ').trim())
      .filter((value) => value.length > 0 && value.length <= itemMaximum),
  )].slice(0, maximum);
}

function manifestPaths(manifest: MutationManifest | undefined): string[] {
  return boundedManifestList(manifest?.artifactPaths, MAX_ARTIFACTS, MAX_ARTIFACT_PATH);
}

function manifestEffects(manifest: MutationManifest | undefined): string[] {
  return boundedManifestList(manifest?.effects, MAX_DECLARED_EFFECTS, MAX_DECLARED_EFFECT);
}

function hasManifest(manifest: MutationManifest | undefined): boolean {
  return manifestPaths(manifest).length > 0 || manifestEffects(manifest).length > 0;
}

function bounded(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function operationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? bounded(text, 120) : undefined;
}

function pathArgument(args: Record<string, unknown>, key: string): string {
  return bounded(redactSecrets(String(args[key] ?? '').trim()), 260);
}

function mutationSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'write_file':
      return 'Write file: ' + pathArgument(args, 'path');
    case 'edit_file':
      return 'Edit file: ' + pathArgument(args, 'path');
    case 'append_file':
      return 'Append file: ' + pathArgument(args, 'path');
    case 'create_folder':
      return 'Create folder: ' + pathArgument(args, 'path');
    case 'delete_item':
      return (Boolean(args.permanent) ? 'Permanently delete: ' : 'Recycle: ') + pathArgument(args, 'path');
    case 'move_item':
      return 'Move ' + pathArgument(args, 'from') + ' -> ' + pathArgument(args, 'to');
    case 'copy_item':
      return 'Copy ' + pathArgument(args, 'from') + ' -> ' + pathArgument(args, 'to');
    case 'replace_in_files':
      return 'Replace text under ' + pathArgument(args, 'root');
    case 'compress':
      return 'Compress ' + pathArgument(args, 'source') + ' -> ' + pathArgument(args, 'destination');
    case 'extract':
      return 'Extract ' + pathArgument(args, 'archive') + ' -> ' + pathArgument(args, 'destination');
    case 'download_file':
      return 'Download to ' + pathArgument(args, 'destination');
    case 'resize_image':
    case 'convert_image':
    case 'crop_image':
      return toolName + ' ' + pathArgument(args, 'source') + ' -> ' + pathArgument(args, 'destination');
    case 'create_shortcut':
      return 'Create shortcut: ' + pathArgument(args, 'shortcutPath');
    case 'chrome_save_pdf':
      return 'Save PDF: ' + pathArgument(args, 'destination');
    case 'run_batch':
      return 'PowerShell batch (no automatic undo candidate).';
    default:
      return 'Mutation: ' + bounded(toolName, 120);
  }
}

function normaliseShortcutPath(path: string): string {
  return /\.lnk$/i.test(path) ? path : path + '.lnk';
}

function artifactPathsFor(toolName: string, args: Record<string, unknown>, manifest?: MutationManifest): string[] {
  const declared = manifestPaths(manifest);
  const keys =
    toolName === 'write_file' || toolName === 'edit_file' || toolName === 'append_file' || toolName === 'create_folder'
      ? ['path']
      : toolName === 'move_item' || toolName === 'copy_item'
        ? ['to']
        : toolName === 'compress' || toolName === 'extract' || toolName === 'download_file'
          ? ['destination']
          : toolName === 'resize_image' || toolName === 'convert_image' || toolName === 'crop_image'
            ? ['destination']
            : toolName === 'create_shortcut'
              ? ['shortcutPath']
              : toolName === 'chrome_save_pdf'
                ? ['destination']
                : [];
  const dynamic = keys
    .map((key) => String(args[key] ?? '').trim())
    .map((path) => toolName === 'create_shortcut' ? normaliseShortcutPath(path) : path)
    .filter((path) => path.length > 0);
  return [...new Set([...declared, ...dynamic])].slice(0, MAX_ARTIFACTS);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? bounded(code, 80) : undefined;
}

function isFileFingerprint(value: unknown): value is FileFingerprint {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as FileFingerprint).kind === 'file' &&
      typeof (value as FileFingerprint).size === 'number' &&
      Number.isFinite((value as FileFingerprint).size) &&
      typeof (value as FileFingerprint).sha256 === 'string' &&
      /^[a-f0-9]{64}$/i.test((value as FileFingerprint).sha256),
  );
}

function isMutationArtifact(value: unknown): value is MutationArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<MutationArtifact>;
  return (
    typeof artifact.path === 'string' &&
    artifact.path.length > 0 &&
    artifact.path.length <= MAX_ARTIFACT_PATH &&
    ['file', 'directory', 'other', 'missing', 'unknown'].includes(artifact.kind as string) &&
    (artifact.size === undefined ||
      (typeof artifact.size === 'number' && Number.isSafeInteger(artifact.size) && artifact.size >= 0)) &&
    (artifact.sha256 === undefined || /^[a-f0-9]{64}$/i.test(artifact.sha256)) &&
    typeof artifact.verified === 'boolean'
  );
}

function isUndoAction(value: unknown): value is UndoAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as Partial<UndoAction>;
  if (action.kind === 'remove-created-folder') {
    return typeof action.path === 'string' && action.path.length > 0;
  }
  if (action.kind === 'move-back') {
    return (
      typeof action.from === 'string' &&
      typeof action.to === 'string' &&
      isFileFingerprint(action.expected)
    );
  }
  if (action.kind === 'remove-copy') {
    return typeof action.path === 'string' && isFileFingerprint(action.expected);
  }
  if (action.kind === 'remove-created-file') {
    return typeof action.path === 'string' && isFileFingerprint(action.expected);
  }
  return false;
}

export function isMutationRecord(value: unknown): value is MutationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<MutationRecord>;
  const statuses: MutationStatus[] = [
    'pending',
    'undoable',
    'undoing',
    'undone',
    'not-undoable',
    'stale',
    'failed',
    'uncertain',
  ];
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    (record.operationId === undefined || typeof record.operationId === 'string') &&
    typeof record.toolName === 'string' &&
    typeof record.summary === 'string' &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    statuses.includes(record.status as MutationStatus) &&
    (record.completedAt === undefined || typeof record.completedAt === 'number') &&
    (record.undoneAt === undefined || typeof record.undoneAt === 'number') &&
    (record.undo === undefined || isUndoAction(record.undo)) &&
    (record.reason === undefined || typeof record.reason === 'string') &&
    (record.errorCode === undefined || typeof record.errorCode === 'string') &&
    (record.declaredOutputs === undefined ||
      (Array.isArray(record.declaredOutputs) &&
        record.declaredOutputs.length <= MAX_ARTIFACTS &&
        record.declaredOutputs.every(
          (path) => typeof path === 'string' && path.length > 0 && path.length <= MAX_ARTIFACT_PATH,
        ))) &&
    (record.declaredEffects === undefined ||
      (Array.isArray(record.declaredEffects) &&
        record.declaredEffects.length <= MAX_DECLARED_EFFECTS &&
        record.declaredEffects.every(
          (effect) => typeof effect === 'string' && effect.length > 0 && effect.length <= MAX_DECLARED_EFFECT,
        ))) &&
    (record.artifacts === undefined ||
      (Array.isArray(record.artifacts) &&
        record.artifacts.length <= MAX_ARTIFACTS &&
        record.artifacts.every(isMutationArtifact)))
  );
}

export function isMutationList(value: unknown): value is MutationRecord[] {
  return Array.isArray(value) && value.every(isMutationRecord);
}

function cloneUndo(action: UndoAction | undefined): UndoAction | undefined {
  if (!action) return undefined;
  if (action.kind === 'remove-created-folder') {
    return { ...action };
  }
  if (action.kind === 'remove-copy') {
    return { ...action, expected: { ...action.expected } };
  }
  if (action.kind === 'remove-created-file') {
    return { ...action, expected: { ...action.expected } };
  }
  return { ...action, expected: { ...action.expected } };
}

function cloneRecord(record: MutationRecord): MutationRecord {
  return {
    ...record,
    undo: cloneUndo(record.undo),
    artifacts: record.artifacts?.map((artifact) => ({ ...artifact })),
    declaredOutputs: record.declaredOutputs ? [...record.declaredOutputs] : undefined,
    declaredEffects: record.declaredEffects ? [...record.declaredEffects] : undefined,
  };
}

async function capturePath(path: string): Promise<CapturedPath> {
  const absolute = resolve(path);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      return { absolute, state: { exists: true, kind: 'other' } };
    }
    if (info.isDirectory()) {
      return { absolute, state: { exists: true, kind: 'directory' } };
    }
    if (!info.isFile()) {
      return { absolute, state: { exists: true, kind: 'other' } };
    }

    const state: PathState = {
      exists: true,
      kind: 'file',
      size: info.size,
    };
    if (info.size <= MAX_HASH_BYTES) {
      try {
        const bounded = await readBoundedBufferFile(absolute, MAX_HASH_BYTES);
        if (!bounded.truncated) state.sha256 = createHash('sha256').update(bounded.data).digest('hex');
      } catch {
        // A file that cannot be hashed is still safe to record, but not to undo.
      }
    }
    return { absolute, state };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { absolute, state: { exists: false } };
    throw error;
  }
}

function artifactFor(captured: CapturedPath): MutationArtifact {
  const kind: MutationArtifactKind = captured.state.exists
    ? captured.state.kind ?? 'unknown'
    : 'missing';
  return {
    path: bounded(redactSecrets(captured.absolute), MAX_ARTIFACT_PATH),
    kind,
    ...(typeof captured.state.size === 'number' ? { size: captured.state.size } : {}),
    ...(captured.state.sha256 ? { sha256: captured.state.sha256 } : {}),
    verified: kind === 'file' || kind === 'directory',
  };
}

async function captureArtifacts(paths: readonly string[]): Promise<MutationArtifact[]> {
  const artifacts: MutationArtifact[] = [];
  for (const path of paths.slice(0, MAX_ARTIFACTS)) {
    try {
      artifacts.push(artifactFor(await capturePath(path)));
    } catch {
      artifacts.push({
        path: bounded(redactSecrets(resolve(path)), MAX_ARTIFACT_PATH),
        kind: 'unknown',
        verified: false,
      });
    }
  }
  return artifacts;
}

function asFingerprint(state: PathState | undefined): FileFingerprint | undefined {
  if (
    state?.exists &&
    state.kind === 'file' &&
    typeof state.size === 'number' &&
    typeof state.sha256 === 'string'
  ) {
    return { kind: 'file', size: state.size, sha256: state.sha256 };
  }
  return undefined;
}

function sameFile(state: PathState, expected: FileFingerprint): boolean {
  return (
    state.exists === true &&
    state.kind === 'file' &&
    state.size === expected.size &&
    state.sha256 === expected.sha256
  );
}

async function planFor(
  toolName: string,
  args: Record<string, unknown>,
  manifest?: MutationManifest,
): Promise<MutationPlan> {
  switch (toolName) {
    case 'create_folder': {
      const target = await capturePath(String(args.path ?? ''));
      return target.state.exists
        ? { kind: 'none', reason: 'The target folder already existed before the call.' }
        : { kind: 'remove-created-folder', path: target.absolute };
    }
    case 'move_item': {
      const from = await capturePath(String(args.from ?? ''));
      const to = await capturePath(String(args.to ?? ''));
      if (!from.state.exists) return { kind: 'none', reason: 'The source was not present before the call.' };
      if (to.state.exists) return { kind: 'none', reason: 'The destination already existed before the call.' };
      const sourceBefore = asFingerprint(from.state);
      if (!sourceBefore) {
        return { kind: 'none', reason: 'Only hashed regular files receive an automatic move-back candidate.' };
      }
      return { kind: 'move-file', from: from.absolute, to: to.absolute, sourceBefore };
    }
    case 'copy_item': {
      const from = await capturePath(String(args.from ?? ''));
      const to = await capturePath(String(args.to ?? ''));
      if (!from.state.exists) return { kind: 'none', reason: 'The source was not present before the call.' };
      if (to.state.exists) return { kind: 'none', reason: 'The destination already existed before the call.' };
      const sourceBefore = asFingerprint(from.state);
      if (!sourceBefore) {
        return { kind: 'none', reason: 'Only hashed regular files receive an automatic copy-removal candidate.' };
      }
      return { kind: 'copy-file', to: to.absolute, sourceBefore };
    }
    case 'write_file':
    case 'edit_file':
    case 'append_file':
    case 'compress':
    case 'download_file':
    case 'resize_image':
    case 'convert_image':
    case 'crop_image':
    case 'create_shortcut':
    case 'chrome_save_pdf': {
      const output = artifactPathsFor(toolName, args)[0];
      if (!output) {
        return { kind: 'none', reason: 'The output path was missing before the call.' };
      }
      const target = await capturePath(output);
      return target.state.exists
        ? { kind: 'none', reason: 'The output path already existed before the call.' }
        : { kind: 'remove-created-file', path: target.absolute };
    }
    case 'replace_in_files':
      return {
        kind: 'none',
        reason: 'Bulk replacement discovers its affected files during execution; no identity-safe inverse is available.',
      };
    case 'delete_item':
      return {
        kind: 'none',
        reason: 'Recycle-bin restore remains manual because a name alone is not a safe identity.',
      };
    case 'run_batch':
      return {
        kind: 'none',
        reason: 'Batch commands may have heterogeneous side effects; no automatic inverse is available.',
      };
    default:
      return {
        kind: 'none',
        reason: manifest?.reason?.trim() || 'This mutation has no verified inverse operation in the journal yet.',
      };
  }
}

async function assertUndoPaths(
  toolName: 'delete_item' | 'move_item',
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const decision = await mutationPathDecisionFor(toolName, args, signal);
  if (decision?.tier === 'never') throw new Error('Undo path is protected by the mutation policy.');
}

async function directoryHasEntries(absolute: string): Promise<boolean> {
  const directory = await opendir(absolute);
  try {
    return (await directory.read()) !== null;
  } finally {
    await directory.close().catch(() => undefined);
  }
}
function staleUndo(): Error {
  return new Error('Undo refused because the target changed or is no longer in the expected state.');
}

export class MutationJournal {
  private readonly persistence: MutationPersistence;
  private readonly now: () => number;
  private records: MutationRecord[];
  private readonly listeners = new Set<MutationListener>();

  constructor(options: { persistence: MutationPersistence; now?: () => number }) {
    this.persistence = options.persistence;
    this.now = options.now ?? (() => Date.now());

    let loaded: MutationRecord[] = [];
    try {
      loaded = options.persistence.load().filter(isMutationRecord).slice(-MAX_MUTATIONS);
    } catch {
      loaded = [];
    }

    let recovered = false;
    this.records = loaded.map((record) => {
      if (record.status !== 'pending' && record.status !== 'undoing') return cloneRecord(record);
      recovered = true;
      const restarted = cloneRecord(record);
      if (!restarted.artifacts?.length && restarted.declaredOutputs?.length) {
        restarted.artifacts = restarted.declaredOutputs.map((path) => ({
          path,
          kind: 'unknown' as const,
          verified: false,
        }));
      }
      return {
        ...restarted,
        status: 'uncertain',
        completedAt: record.completedAt ?? this.now(),
        errorCode: 'interrupted-outcome-unknown',
        reason: 'The application stopped before the journal could confirm this mutation. Inspect recorded outputs before retrying.',
      };
    });
    if (recovered) {
      try {
        this.persist();
      } catch {
        // Keep the recovered uncertain state in memory; a later transition or restart can retry the write.
      }
    }
  }

  list(): MutationRecord[] {
    return this.records
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(cloneRecord);
  }

  subscribe(listener: MutationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    this.persistence.save(this.records.map(cloneRecord));
  }

  private persistAndEmit(previousRecords?: MutationRecord[]): void {
    try {
      this.persist();
    } catch (error) {
      if (previousRecords) this.records = previousRecords;
      throw error;
    }
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers cannot interrupt a persisted journal transition.
      }
    }
  }

  async begin(
    toolName: string,
    args: Record<string, unknown>,
    operationIdValue?: string,
    manifest?: MutationManifest,
  ): Promise<MutationHandle | null> {
    const artifactPaths = artifactPathsFor(toolName, args, manifest);
    const declaredEffects = manifestEffects(manifest);
    if (!JOURNALED_TOOLS.has(toolName) && !hasManifest(manifest)) return null;
    if (toolName === 'run_batch' && args.preview === true) return null;
    const plan = await planFor(toolName, args, manifest);
    const previousRecords = this.records.map(cloneRecord);
    while (this.records.length >= MAX_MUTATIONS) {
      const index = this.records.findIndex((record) => TERMINAL_STATUSES.has(record.status));
      if (index < 0) throw new Error('Mutation journal is full of unresolved work.');
      this.records.splice(index, 1);
    }
    const record: MutationRecord = {
      id: randomUUID(),
      operationId: operationId(operationIdValue),
      toolName: bounded(toolName, 120),
      summary: bounded(mutationSummary(toolName, args), MAX_SUMMARY),
      createdAt: this.now(),
      status: 'pending',
      declaredOutputs: artifactPaths.length ? artifactPaths : undefined,
      declaredEffects: declaredEffects.length ? declaredEffects : undefined,
    };
    this.records.push(record);
    this.persistAndEmit(previousRecords);
    return { id: record.id, plan, artifactPaths };
  }

  async complete(handle: MutationHandle): Promise<MutationRecord | undefined> {
    const record = this.records.find((item) => item.id === handle.id);
    if (!record) return undefined;
    const previousRecords = this.records.map(cloneRecord);

    try {
      record.artifacts = await captureArtifacts(handle.artifactPaths);
      switch (handle.plan.kind) {
        case 'remove-created-folder': {
          const target = await capturePath(handle.plan.path);
          if (target.state.exists && target.state.kind === 'directory') {
            record.status = 'undoable';
            record.undo = { kind: 'remove-created-folder', path: target.absolute };
            record.reason = undefined;
          } else {
            record.status = 'not-undoable';
            record.reason = 'The created folder could not be verified after the call.';
          }
          break;
        }
        case 'remove-created-file': {
          const target = await capturePath(handle.plan.path);
          const expected = asFingerprint(target.state);
          if (expected) {
            record.status = 'undoable';
            record.undo = {
              kind: 'remove-created-file',
              path: target.absolute,
              expected,
            };
            record.reason = undefined;
          } else {
            record.status = 'not-undoable';
            record.reason = 'The newly created file could not be hashed after the call.';
          }
          break;
        }
        case 'move-file': {
          const target = await capturePath(handle.plan.to);
          const expected = asFingerprint(target.state);
          if (expected) {
            record.status = 'undoable';
            record.undo = {
              kind: 'move-back',
              from: handle.plan.to,
              to: handle.plan.from,
              expected,
            };
            record.reason = undefined;
          } else {
            record.status = 'not-undoable';
            record.reason = 'The moved file could not be hashed after the call.';
          }
          break;
        }
        case 'copy-file': {
          const target = await capturePath(handle.plan.to);
          const expected = asFingerprint(target.state);
          if (expected) {
            record.status = 'undoable';
            record.undo = { kind: 'remove-copy', path: handle.plan.to, expected };
            record.reason = undefined;
          } else {
            record.status = 'not-undoable';
            record.reason = 'The copied file could not be hashed after the call.';
          }
          break;
        }
        case 'none':
          record.status = 'not-undoable';
          record.reason = handle.plan.reason;
          break;
      }
    } catch {
      record.status = 'not-undoable';
      record.reason = 'The post-mutation state could not be safely verified.';
      record.errorCode = 'journal-verification-failed';
    }

    record.completedAt = this.now();
    this.persistAndEmit(previousRecords);
    return cloneRecord(record);
  }

  async fail(handle: MutationHandle, code = 'execution-failed', outcome: MutationFailureOutcome = 'failed'): Promise<void> {
    const record = this.records.find((item) => item.id === handle.id);
    if (!record) return;
    const previousRecords = this.records.map(cloneRecord);
    record.artifacts = await captureArtifacts(handle.artifactPaths);
    record.status = outcome;
    record.completedAt = this.now();
    record.errorCode = bounded(code, 80);
    record.reason = outcome === 'uncertain'
      ? 'The mutation stopped before its final state could be confirmed. Inspect recorded outputs before retrying.'
      : 'The mutation did not complete successfully.';
    record.undo = undefined;
    this.persistAndEmit(previousRecords);
  }

  async settleDeferred(
    id: string,
    outcome: DeferredMutationOutcome,
  ): Promise<MutationRecord | undefined> {
    const record = this.records.find((item) => item.id === id);
    if (!record) return undefined;
    if (record.status !== 'pending') return cloneRecord(record);
    const previousRecords = this.records.map(cloneRecord);

    record.completedAt = this.now();
    record.undo = undefined;
    if (outcome === 'completed') {
      record.status = 'not-undoable';
      record.errorCode = undefined;
      record.reason = 'Background batch completed; command side effects were not individually verified.';
    } else {
      record.status = 'uncertain';
      record.errorCode = 'background-job-' + outcome;
      record.reason = outcome === 'cancelled'
        ? 'Background batch was cancelled; some commands may have committed side effects. Inspect recorded outputs before retrying.'
        : 'Background batch failed; some commands may have committed side effects. Inspect recorded outputs before retrying.';
    }
    this.persistAndEmit(previousRecords);
    return cloneRecord(record);
  }

  async undo(id: string, signal?: AbortSignal): Promise<MutationRecord> {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error('No mutation journal entry matches that id.');
    if (record.status !== 'undoable' || !record.undo) {
      throw new Error('This journal entry has no currently safe undo candidate.');
    }

    const previousRecords = this.records.map(cloneRecord);
    record.status = 'undoing';
    try {
      this.persistAndEmit(previousRecords);
    } catch {
      throw new Error('The undo could not be started because its journal state was not persisted.');
    }

    try {
      const action = record.undo;
      if (action.kind === 'remove-created-folder') {
        await assertUndoPaths('delete_item', { path: action.path }, signal);
        const current = await capturePath(action.path);
        if (!current.state.exists || current.state.kind !== 'directory') throw staleUndo();
        if (await directoryHasEntries(current.absolute)) throw staleUndo();
        await rmdir(current.absolute);
        if ((await capturePath(current.absolute)).state.exists) throw staleUndo();
      } else if (action.kind === 'remove-copy' || action.kind === 'remove-created-file') {
        await assertUndoPaths('delete_item', { path: action.path }, signal);
        const current = await capturePath(action.path);
        if (!sameFile(current.state, action.expected)) throw staleUndo();
        await rm(current.absolute, { force: false });
        if ((await capturePath(current.absolute)).state.exists) throw staleUndo();
      } else {
        await assertUndoPaths('move_item', { from: action.from, to: action.to }, signal);
        const currentSource = await capturePath(action.from);
        const originalLocation = await capturePath(action.to);
        const parent = await capturePath(dirname(action.to));
        if (!sameFile(currentSource.state, action.expected)) throw staleUndo();
        if (originalLocation.state.exists || !parent.state.exists || parent.state.kind !== 'directory') {
          throw staleUndo();
        }
        await rename(currentSource.absolute, originalLocation.absolute);
        const restored = await capturePath(originalLocation.absolute);
        if (!sameFile(restored.state, action.expected) || (await capturePath(currentSource.absolute)).state.exists) {
          throw staleUndo();
        }
      }
    } catch (error) {
      record.status = 'stale';
      record.errorCode = error instanceof Error && error.message.startsWith('Undo refused')
        ? 'undo-stale'
        : 'undo-failed';
      record.reason =
        error instanceof Error && error.message.startsWith('Undo refused')
          ? error.message
          : 'Undo was not completed safely; inspect the target before trying again.';
      try {
        this.persistAndEmit();
      } catch {
        record.status = 'uncertain';
        record.errorCode = 'journal-persistence-failed';
        record.reason = 'Undo did not reach a durable terminal state; inspect the target before trying again.';
      }
      throw new Error(record.reason);
    }

    record.status = 'undone';
    record.undoneAt = this.now();
    record.reason = 'Verified inverse operation completed.';
    try {
      this.persistAndEmit();
    } catch {
      record.status = 'uncertain';
      record.undoneAt = undefined;
      record.undo = undefined;
      record.errorCode = 'journal-persistence-failed';
      record.reason = 'Undo committed, but its journal state could not be persisted; inspect the target before trying again.';
      throw new Error(record.reason);
    }
    return cloneRecord(record);
  }
}

export function describeMutations(records: readonly MutationRecord[], limit = 20): string {
  const shown = records.slice(0, Math.max(1, Math.min(20, Math.floor(limit))));
  if (!shown.length) return 'No mutation journal entries yet.';
  return shown
    .map((record) => {
      const suffix =
        record.status === 'undoable'
          ? ' · undo available'
          : record.status === 'uncertain'
            ? ' · outcome unconfirmed; inspect before retrying'
          : record.reason
            ? ' · ' + bounded(record.reason, 180)
            : '';
      const artifactSuffix = record.artifacts?.length
        ? ' · outputs: ' +
          bounded(record.artifacts.map((artifact) => artifact.kind + ' ' + artifact.path + (artifact.verified ? ' (verified)' : '')).join(', '), 180)
        : '';
      const effectSuffix = record.declaredEffects?.length
        ? ' · effects: ' + bounded(record.declaredEffects.join('; '), 180)
        : '';
      return '[' + record.id + '] ' + record.status + ' · ' + record.summary + suffix + artifactSuffix + effectSuffix;
    })
    .join('\n');
}
