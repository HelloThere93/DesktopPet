import { throwIfAborted, waitWithAbort } from '../abort';

/** Serializes work that shares one browser tab while keeping queued callers cancellable. */
export function createSerialTaskRunner(): <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = tail;
    const operation = previous.then(() => {
      throwIfAborted(signal);
      return task();
    });
    // Keep the queue alive after either success or failure. A caller that
    // cancels while waiting must not strand the next task behind a rejected
    // promise, and the underlying operation still gets a rejection handler.
    tail = operation.then(() => undefined, () => undefined);
    return waitWithAbort(operation, signal);
  };
}

// The pet browser and the user's selected Google tab are separate profiles.
// Each gets its own coordinator so independent profiles can still work at once.
export const runGoogleTabTask = createSerialTaskRunner();
export const runWebTabTask = createSerialTaskRunner();