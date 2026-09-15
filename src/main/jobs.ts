import { randomUUID } from 'node:crypto';
import { isOperationCancellation } from './abort';
import type { BulkProgress, BulkRunStatus } from './bulk';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'waiting-for-user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobMutationManifest {
  mutationId: string;
  scope: 'powershell-batch';
  planned: number;
  completed: number;
  failed: number;
  skipped: number;
  remaining: number;
  verification: 'not-verified';
}

export interface JobRecord {
  id: string;
  kind: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  operationId?: string;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  remaining: number;
  summary?: string;
  error?: string;
  mutationManifest?: JobMutationManifest;
}

export interface JobPersistence {
  load(): JobRecord[];
  save(records: readonly JobRecord[]): void;
}

export interface JobResult {
  status: BulkRunStatus;
  summary?: string;
  error?: string;
  progress?: Partial<Pick<JobRecord, 'total' | 'completed' | 'failed' | 'skipped' | 'remaining'>>;
}

export interface JobContext {
  signal: AbortSignal;
  report(progress: BulkProgress): void;
  setStatus(status: 'running' | 'waiting' | 'waiting-for-user'): void;
}

export type JobExecutor = (context: JobContext) => Promise<JobResult>;
export type JobListener = (jobs: readonly JobRecord[]) => void;

export const MAX_JOBS = 100;
const MAX_TEXT = 20_000;
const MAX_KIND = 120;
const MAX_ID = 120;
const MAX_COUNT = 10_000_000;

const TERMINAL_STATUSES = new Set<JobStatus>(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set<JobStatus>([
  'queued',
  'running',
  'waiting',
  'waiting-for-user',
]);

const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['queued', 'running', 'failed', 'cancelled'],
  running: ['running', 'waiting', 'waiting-for-user', 'completed', 'failed', 'cancelled'],
  waiting: ['waiting', 'running', 'waiting-for-user', 'completed', 'failed', 'cancelled'],
  'waiting-for-user': ['waiting-for-user', 'running', 'completed', 'failed', 'cancelled'],
  completed: ['completed'],
  failed: ['failed'],
  cancelled: ['cancelled'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(JOB_TRANSITIONS, value);
}

function isJobMutationManifest(value: unknown): value is JobMutationManifest {
  return (
    isRecord(value) &&
    isBoundedString(value.mutationId, MAX_ID) &&
    value.scope === 'powershell-batch' &&
    isCount(value.planned) &&
    isCount(value.completed) &&
    isCount(value.failed) &&
    isCount(value.skipped) &&
    isCount(value.remaining) &&
    value.verification === 'not-verified'
  );
}

export function isJobRecord(value: unknown): value is JobRecord {
  return (
    isRecord(value) &&
    isBoundedString(value.id, MAX_ID) &&
    isBoundedString(value.kind, MAX_KIND) &&
    isBoundedString(value.title, MAX_TEXT) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    isJobStatus(value.status) &&
    (value.operationId === undefined || isBoundedString(value.operationId, MAX_ID)) &&
    isCount(value.total) &&
    isCount(value.completed) &&
    isCount(value.failed) &&
    isCount(value.skipped) &&
    isCount(value.remaining) &&
    (value.summary === undefined || isBoundedString(value.summary, MAX_TEXT, true)) &&
    (value.error === undefined || isBoundedString(value.error, MAX_TEXT, true)) &&
    (value.mutationManifest === undefined || isJobMutationManifest(value.mutationManifest))
  );
}

export function isJobList(value: unknown): value is JobRecord[] {
  return Array.isArray(value) && value.length <= MAX_JOBS && value.every(isJobRecord);
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

function boundedText(value: string, label: string, max = MAX_TEXT): string {
  const clean = value.trim();
  if (!clean) throw new Error(label + ' cannot be empty.');
  if (clean.length > max) throw new Error(label + ' exceeds the ' + max + '-character limit.');
  return clean;
}

function cloneJob(job: JobRecord): JobRecord {
  return {
    ...job,
    mutationManifest: job.mutationManifest ? { ...job.mutationManifest } : undefined,
  };
}

function interrupted(job: JobRecord, now: number): JobRecord {
  return {
    ...job,
    status: 'failed',
    updatedAt: now,
    error: 'Interrupted by application restart before the job finished.',
  };
}

function isCancellation(error: unknown): boolean {
  return isOperationCancellation(error);
}

type JobPatch = Partial<
  Pick<
    JobRecord,
    | 'status'
    | 'total'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'remaining'
  >
> & {
  summary?: string | null;
  error?: string | null;
};

export interface JobManagerOptions {
  persistence: JobPersistence;
  maxConcurrent?: number;
  now?: () => number;
}

export class JobManager {
  private readonly persistence: JobPersistence;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private records: JobRecord[];
  private readonly executors = new Map<string, JobExecutor>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private readonly listeners = new Set<JobListener>();
  private readonly idleResolvers = new Set<() => void>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: JobManagerOptions) {
    this.persistence = options.persistence;
    this.maxConcurrent = Math.max(1, Math.min(8, Math.floor(options.maxConcurrent ?? 2)));
    this.now = options.now ?? (() => Date.now());

    let loaded: JobRecord[] = [];
    try {
      const candidate = options.persistence.load();
      if (Array.isArray(candidate)) {
        loaded = candidate.filter(isJobRecord).slice(-MAX_JOBS);
      }
    } catch {
      loaded = [];
    }

    this.records = loaded.map((record) =>
      ACTIVE_STATUSES.has(record.status) ? interrupted(record, this.now()) : cloneJob(record),
    );
    try {
      this.persist();
    } catch {
      // Startup recovery remains available in memory; the next transition can retry the write.
    }
  }

  list(): JobRecord[] {
    return this.records
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneJob);
  }

  get(id: string): JobRecord | undefined {
    const record = this.records.find((item) => item.id === id);
    return record ? cloneJob(record) : undefined;
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enqueue(input: {
    kind: string;
    title: string;
    total: number;
    operationId?: string;
    mutationManifest?: JobMutationManifest;
  }, executor: JobExecutor): JobRecord {
    if (this.shuttingDown) throw new Error('Background jobs are shutting down.');
    const kind = boundedText(input.kind, 'Job kind', MAX_KIND);
    const title = boundedText(input.title, 'Job title');
    if (!Number.isInteger(input.total) || input.total < 0 || input.total > MAX_COUNT) {
      throw new Error('Job total must be a non-negative integer within the supported limit.');
    }
    if (
      input.mutationManifest &&
      (!isJobMutationManifest(input.mutationManifest) || input.mutationManifest.planned !== input.total)
    ) {
      throw new Error('The job mutation manifest must match the job total and supported schema.');
    }
    const operationId = input.operationId?.trim() || undefined;
    if (operationId && operationId.length > MAX_ID) {
      throw new Error('Job operation id is too long.');
    }

    const previousRecords = this.records.map(cloneJob);
    this.trimHistory();
    const now = this.now();
    const record: JobRecord = {
      id: randomUUID(),
      kind,
      title,
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      operationId,
      total: input.total,
      completed: 0,
      failed: 0,
      skipped: 0,
      remaining: input.total,
      mutationManifest: input.mutationManifest ? { ...input.mutationManifest } : undefined,
    };
    this.records.push(record);
    this.executors.set(record.id, executor);
    try {
      this.persistAndEmit(previousRecords);
    } catch (error) {
      this.executors.delete(record.id);
      this.controllers.delete(record.id);
      throw error;
    }
    this.pump();
    return cloneJob(this.records.find((item) => item.id === record.id) ?? record);
  }

  cancel(id: string): JobRecord | undefined {
    return this.cancelInternal(id);
  }

  /**
   * Stops every job that is currently queued or running without allowing a
   * queued job to start in between cancellations. Privacy mode uses this as a
   * hard boundary because a background PowerShell batch may also reach remote
   * services even when the original turn has already ended.
   */
  cancelAll(): void {
    const ids = this.records
      .filter((record) => ACTIVE_STATUSES.has(record.status))
      .map((record) => record.id);
    let firstError: unknown;
    for (const id of ids) {
      try {
        this.cancelInternal(id, 'Cancelled by privacy pause.', false);
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      this.pump();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  }

  private cancelInternal(id: string, reason?: string, pumpAfter = true): JobRecord | undefined {
    const record = this.records.find((item) => item.id === id);
    if (!record || TERMINAL_STATUSES.has(record.status)) return record ? cloneJob(record) : undefined;

    const wasQueued = record.status === 'queued';
    const controller = this.controllers.get(id);
    controller?.abort();
    try {
      this.update(id, {
        status: 'cancelled',
        error: reason ?? (wasQueued ? 'Cancelled before execution.' : 'Cancellation requested by user.'),
      });
    } catch (error) {
      if (!wasQueued) throw error;
      // A queued executor has no later promise settlement that can finish the
      // transition. Remove it now so a persistence outage cannot start work
      // the user explicitly cancelled; the next successful state write repairs
      // the durable record.
      this.executors.delete(id);
      this.markTerminalInMemory(
        id,
        'cancelled',
        reason
          ? reason + ' Job state could not be saved and will be treated as interrupted after a restart.'
          : 'Cancellation applied in memory; job state could not be saved and will be treated as interrupted after a restart.',
      );
      if (pumpAfter) {
        try {
          this.pump();
        } catch {
          // Other queued work must not make this cancellation path throw again.
        }
      }
      this.resolveIdleIfNeeded();
      return this.get(id);
    }
    if (wasQueued) this.executors.delete(id);
    if (pumpAfter) this.pump();
    return this.get(id);
  }

  hasPendingWork(): boolean {
    return this.running.size > 0 || this.records.some((record) => record.status === 'queued');
  }

  whenIdle(): Promise<void> {
    if (!this.hasPendingWork()) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    for (const record of this.records) {
      if (!ACTIVE_STATUSES.has(record.status)) continue;
      const wasQueued = record.status === 'queued';
      const error = wasQueued
        ? 'Not started because the application is shutting down.'
        : 'Interrupted by application shutdown.';
      this.controllers.get(record.id)?.abort();
      try {
        this.update(record.id, { status: 'failed', error });
      } catch {
        this.markTerminalInMemory(record.id, 'failed', error);
      }
      if (wasQueued) this.executors.delete(record.id);
    }
    const drain = this.whenIdle();
    this.shutdownPromise = drain;
    this.resolveIdleIfNeeded();
    return drain;
  }

  private trimHistory(): void {
    while (this.records.length >= MAX_JOBS) {
      const index = this.records.findIndex((record) => TERMINAL_STATUSES.has(record.status));
      if (index < 0) throw new Error('The background-job history is full of active work.');
      const removed = this.records.splice(index, 1)[0];
      if (!removed) throw new Error('The background-job history changed while it was being trimmed.');
      this.executors.delete(removed.id);
      this.controllers.delete(removed.id);
    }
  }

  private persist(): void {
    this.persistence.save(this.records.map(cloneJob));
  }

  private emitSnapshot(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers must not break persistence or job execution.
      }
    }
  }

  private persistAndEmit(previousRecords?: JobRecord[]): void {
    try {
      this.persist();
    } catch (error) {
      if (previousRecords) this.records = previousRecords;
      throw error;
    }
    this.emitSnapshot();
  }

  private update(id: string, patch: JobPatch): JobRecord | undefined {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return undefined;
    const current = this.records[index];
    if (!current) return undefined;

    if (patch.status !== undefined && !canTransitionJob(current.status, patch.status)) {
      throw new Error('Invalid background-job transition: ' + current.status + ' -> ' + patch.status + '.');
    }

    const next: JobRecord = {
      ...current,
      updatedAt: this.now(),
    };
    if (patch.status !== undefined) next.status = patch.status;

    for (const key of ['total', 'completed', 'failed', 'skipped', 'remaining'] as const) {
      const value = patch[key];
      if (value !== undefined) {
        if (!Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
          throw new Error('Invalid background-job progress for ' + key + '.');
        }
        next[key] = value;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'summary')) {
      next.summary = patch.summary == null ? undefined : boundedText(patch.summary, 'Job summary');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) {
      next.error = patch.error == null ? undefined : boundedText(patch.error, 'Job error');
    }

    const previousRecords = this.records.map(cloneJob);
    this.records[index] = next;
    if (next.mutationManifest) {
      next.mutationManifest = {
        ...next.mutationManifest,
        completed: next.completed,
        failed: next.failed,
        skipped: next.skipped,
        remaining: next.remaining,
      };
    }
    this.persistAndEmit(previousRecords);
    return cloneJob(next);
  }

  private report(id: string, progress: BulkProgress): void {
    const current = this.records.find((record) => record.id === id);
    if (!current || TERMINAL_STATUSES.has(current.status)) return;
    this.update(id, {
      total: progress.total,
      completed: progress.completed,
      failed: progress.failed,
      skipped: progress.skipped,
      remaining: progress.remaining,
    });
  }

  private setStatus(id: string, status: 'running' | 'waiting' | 'waiting-for-user'): void {
    const current = this.records.find((record) => record.id === id);
    if (!current || TERMINAL_STATUSES.has(current.status)) return;
    this.update(id, { status });
  }

  private markTerminalInMemory(id: string, status: 'failed' | 'cancelled', error: string): void {
    const record = this.records.find((item) => item.id === id);
    if (!record || TERMINAL_STATUSES.has(record.status)) return;
    record.status = status;
    record.updatedAt = this.now();
    record.error = error;
    // Persistence failed, but observers still need the terminal outcome so
    // mutation settlement and diagnostics are not stranded until restart.
    this.emitSnapshot();
  }

  private pump(): void {
    if (this.shuttingDown) {
      this.resolveIdleIfNeeded();
      return;
    }

    while (this.running.size < this.maxConcurrent) {
      const record = this.records.find((item) => item.status === 'queued');
      if (!record) break;
      const executor = this.executors.get(record.id);
      if (!executor) {
        try {
          this.update(record.id, {
            status: 'failed',
            error: 'Job executor was missing before the job started.',
          });
        } catch {
          this.markTerminalInMemory(record.id, 'failed', 'Job executor was missing and its failure state could not be persisted.');
        }
        continue;
      }

      this.running.add(record.id);
      this.controllers.set(record.id, new AbortController());
      try {
        this.update(record.id, { status: 'running', error: null });
      } catch {
        this.running.delete(record.id);
        this.controllers.delete(record.id);
        this.executors.delete(record.id);
        this.markTerminalInMemory(record.id, 'failed', 'Job could not be started because its running state could not be persisted.');
        continue;
      }
      void this.run(record.id, executor).catch((error) => {
        this.markTerminalInMemory(
          record.id,
          'failed',
          error instanceof Error ? error.message : 'Background job failed unexpectedly.',
        );
        this.resolveIdleIfNeeded();
      });
    }
    this.resolveIdleIfNeeded();
  }

  private async run(id: string, executor: JobExecutor): Promise<void> {
    const controller = this.controllers.get(id);
    if (!controller) return;

    const context: JobContext = {
      signal: controller.signal,
      report: (progress) => this.report(id, progress),
      setStatus: (status) => this.setStatus(id, status),
    };

    try {
      const result = await executor(context);
      const current = this.records.find((record) => record.id === id);
      if (current && !TERMINAL_STATUSES.has(current.status)) {
        const status: JobStatus =
          result.status === 'completed'
            ? 'completed'
            : result.status === 'cancelled'
              ? 'cancelled'
              : 'failed';
        try {
          this.update(id, {
            status,
            ...(result.progress ?? {}),
            summary: result.summary ?? null,
            error: status === 'failed'
              ? result.error ?? 'The job completed with one or more item failures.'
              : result.error ?? null,
          });
        } catch {
          this.markTerminalInMemory(id, 'failed', 'Job result could not be persisted; inspect the job outcome before retrying.');
        }
      }
    } catch (error) {
      const current = this.records.find((record) => record.id === id);
      if (current && !TERMINAL_STATUSES.has(current.status)) {
        const cancelled = controller.signal.aborted || isCancellation(error);
        try {
          this.update(id, {
            status: cancelled ? 'cancelled' : 'failed',
            error: cancelled
              ? 'Cancelled before the job finished.'
              : error instanceof Error
                ? error.message
                : String(error),
          });
        } catch {
          this.markTerminalInMemory(
            id,
            cancelled ? 'cancelled' : 'failed',
            cancelled ? 'Cancelled before the job finished.' : 'Job failure could not be persisted.',
          );
        }
      }
    } finally {
      this.running.delete(id);
      this.controllers.delete(id);
      this.executors.delete(id);
      try {
        this.pump();
      } catch (error) {
        this.markTerminalInMemory(
          id,
          'failed',
          error instanceof Error ? error.message : 'Background job cleanup failed unexpectedly.',
        );
        this.resolveIdleIfNeeded();
      }
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.hasPendingWork()) return;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers.clear();
  }
}

