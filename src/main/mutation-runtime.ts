import { app } from 'electron';
import { join } from 'node:path';
import { readJsonFile, writeJsonFileAtomic } from './durable-store';
import { acquireMutationLock } from './mutation-lock';
import {
  isMutationList,
  MutationJournal,
  type MutationHandle,
  type MutationFailureOutcome,
  type MutationManifest,
  type DeferredMutationOutcome,
  type MutationRecord,
} from './mutation-journal';

let journal: MutationJournal | null = null;

function storePath(): string {
  return join(app.getPath('userData'), 'mutations.json');
}

function persistence() {
  return {
    load: () => readJsonFile<MutationRecord[]>(storePath(), [], isMutationList),
    save: (records: readonly MutationRecord[]) => writeJsonFileAtomic(storePath(), records),
  };
}

export function getMutationJournal(): MutationJournal {
  if (!journal) {
    journal = new MutationJournal({ persistence: persistence() });
  }
  return journal;
}

export function beginMutation(
  toolName: string,
  args: Record<string, unknown>,
  operationId?: string,
  manifest?: MutationManifest,
): Promise<MutationHandle | null> {
  return getMutationJournal().begin(toolName, args, operationId, manifest);
}

export function completeMutation(handle: MutationHandle): Promise<MutationRecord | undefined> {
  return getMutationJournal().complete(handle);
}

export function failMutation(handle: MutationHandle, code?: string, outcome: MutationFailureOutcome = 'failed'): Promise<void> {
  return getMutationJournal().fail(handle, code, outcome);
}

export function settleMutation(
  id: string,
  outcome: DeferredMutationOutcome,
): Promise<MutationRecord | undefined> {
  return getMutationJournal().settleDeferred(id, outcome);
}

export function listMutations(): MutationRecord[] {
  return getMutationJournal().list();
}

/** Used by executeToolCallInner, which already owns the mutation lock. */
export function undoMutationUnlocked(
  id: string,
  signal?: AbortSignal,
): Promise<MutationRecord> {
  return getMutationJournal().undo(id, signal);
}

/** Used by direct UI actions, which do not pass through the tool lock. */
export async function undoMutation(id: string, signal?: AbortSignal): Promise<MutationRecord> {
  const release = await acquireMutationLock(signal);
  try {
    return await undoMutationUnlocked(id, signal);
  } finally {
    release();
  }
}
