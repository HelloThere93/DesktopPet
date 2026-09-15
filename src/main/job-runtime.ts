import { app } from 'electron';
import { join } from 'node:path';
import { logAudit } from './db';
import { logRuntimeError } from './observability';
import { readJsonFile, writeJsonFileAtomic } from './durable-store';
import { runBulk } from './bulk';
import { acquireMutationLock } from './mutation-lock';
import { isJobList, JobManager, type JobMutationManifest, type JobRecord } from './jobs';
import { settleMutation } from './mutation-runtime';
import { runPowerShellStrict } from './tools/shell';

let manager: JobManager | null = null;
const settledMutationJobs = new Set<string>();
const auditedTerminalJobs = new Set<string>();
const auditRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const settlementPromises = new Map<string, Promise<void>>();
const settlementRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AUDIT_RETRY_DELAY_MS = 1_000;
const MUTATION_SETTLEMENT_RETRY_DELAY_MS = 1_000;
let settlementShutdown = false;

function storePath(): string {
  return join(app.getPath('userData'), 'jobs.json');
}

function persistence() {
  return {
    load: () => readJsonFile<JobRecord[]>(storePath(), [], isJobList),
    save: (records: readonly JobRecord[]) => writeJsonFileAtomic(storePath(), records),
  };
}

function auditTerminalJob(record: JobRecord): void {
  if (!['completed', 'failed', 'cancelled'].includes(record.status)) return;
  if (auditedTerminalJobs.has(record.id) || auditRetryTimers.has(record.id)) return;

  const result = record.summary ?? record.error ?? ('Job ' + record.status + '.');
  const persisted = logAudit({
    operationId: record.operationId,
    toolName: 'background_job',
    args: { jobId: record.id, kind: record.kind },
    tier: 'auto',
    decision: 'job-' + record.status,
    ok: record.status === 'completed',
    errorCode: record.status === 'failed' ? 'background-job-failed' : undefined,
    result,
  });
  if (persisted) {
    auditedTerminalJobs.add(record.id);
    return;
  }
  if (settlementShutdown) return;
  const timer = setTimeout(() => {
    auditRetryTimers.delete(record.id);
    auditTerminalJob(record);
  }, AUDIT_RETRY_DELAY_MS);
  auditRetryTimers.set(record.id, timer);
}
function settleJobMutation(record: JobRecord): void {
  if (!['completed', 'failed', 'cancelled'].includes(record.status)) return;
  const mutationId = record.mutationManifest?.mutationId;
  if (!mutationId || settledMutationJobs.has(record.id) || settlementPromises.has(record.id) || settlementRetryTimers.has(record.id)) return;

  const outcome = record.status === 'completed'
    ? 'completed'
    : record.status === 'cancelled'
      ? 'cancelled'
      : 'failed';
  const attempt = Promise.resolve()
    .then(() => settleMutation(mutationId, outcome))
    .then(() => {
      settledMutationJobs.add(record.id);
    })
    .catch((error) => {
      logRuntimeError('integration-error', error, record.operationId);
      if (settlementShutdown) return;
      const timer = setTimeout(() => {
        settlementRetryTimers.delete(record.id);
        settleJobMutation(record);
      }, MUTATION_SETTLEMENT_RETRY_DELAY_MS);
      settlementRetryTimers.set(record.id, timer);
    });
  settlementPromises.set(record.id, attempt);
  // Cleanup must observe both outcomes. A detached finally() would create a new
  // rejecting promise if an unexpected failure escaped the retry handler.
  void attempt.then(
    () => {
      if (settlementPromises.get(record.id) === attempt) settlementPromises.delete(record.id);
    },
    () => {
      if (settlementPromises.get(record.id) === attempt) settlementPromises.delete(record.id);
    },
  );
}

function observeJob(record: JobRecord): void {
  auditTerminalJob(record);
  settleJobMutation(record);
}

export function getJobManager(): JobManager {
  if (!manager) {
    manager = new JobManager({
      persistence: persistence(),
      maxConcurrent: 2,
    });
    manager.subscribe((jobs) => {
      for (const job of jobs) observeJob(job);
    });
    for (const job of manager.list()) observeJob(job);
  }
  return manager;
}

export function enqueuePowerShellBatch(
  commands: readonly string[],
  operationId?: string,
  mutationId?: string,
): JobRecord {
  return getJobManager().enqueue(
    {
      kind: 'powershell-batch',
      title: 'PowerShell batch',
      total: commands.length,
      operationId,
      mutationManifest: mutationId
        ? ({
            mutationId,
            scope: 'powershell-batch',
            planned: commands.length,
            completed: 0,
            failed: 0,
            skipped: 0,
            remaining: commands.length,
            verification: 'not-verified',
          } satisfies JobMutationManifest)
        : undefined,
    },
    async ({ signal, report }) => {
      const release = await acquireMutationLock(signal);
      try {
      const result = await runBulk(
        commands,
        (command) => runPowerShellStrict(command, undefined, signal),
        {
          signal,
          maxItems: 40,
          onProgress: report,
        },
      );
      const summary =
        'PowerShell batch ' +
        result.status +
        '. Completed: ' +
        result.completed +
        '; failed: ' +
        result.failed +
        '; skipped: ' +
        result.skipped +
        '.';
      return {
        status: result.status,
        summary,
        error:
          result.status === 'completed-with-errors'
            ? 'One or more batch commands failed.'
            : undefined,
        progress: result,
      };
      } finally {
        release();
      }
    },
  );
}

export async function shutdownJobs(): Promise<void> {
  settlementShutdown = true;
  for (const timer of auditRetryTimers.values()) clearTimeout(timer);
  auditRetryTimers.clear();
  for (const timer of settlementRetryTimers.values()) clearTimeout(timer);
  settlementRetryTimers.clear();
  if (manager) await manager.shutdown();
  await Promise.all([...settlementPromises.values()]);
}

