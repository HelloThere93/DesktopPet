import { OperationCancelledError, throwIfAborted } from './abort';

type Release = () => void;

type Waiter = {
  signal?: AbortSignal;
  resolve: (release: Release) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
};

let locked = false;
const waiters: Waiter[] = [];

function releaseLock(): void {
  if (!locked) return;
  locked = false;
  drain();
}

function drain(): void {
  if (locked) return;

  while (waiters.length) {
    const waiter = waiters.shift()!;
    if (waiter.signal?.aborted) {
      waiter.onAbort?.();
      continue;
    }

    locked = true;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(releaseLock);
    return;
  }
}

/**
 * Serializes known mutation tools within this process. The wait itself is
 * cancellable so a cancelled turn cannot leave a stale waiter in the queue.
 */
export function acquireMutationLock(signal?: AbortSignal): Promise<Release> {
  throwIfAborted(signal);

  if (!locked) {
    locked = true;
    return Promise.resolve(releaseLock);
  }

  return new Promise<Release>((resolve, reject) => {
    let settled = false;
    let waiter: Waiter;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      settled = true;
      cleanup();
      reject(new OperationCancelledError());
    };

    waiter = {
      signal,
      onAbort,
      resolve: (release) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(release);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);

    // The signal may have fired between the initial check and registration.
    if (signal?.aborted) onAbort();
  });
}

