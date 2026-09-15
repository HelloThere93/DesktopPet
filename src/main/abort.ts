/** Error used when an in-flight agent operation is cancelled by the user. */
export class OperationCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'AbortError';
  }
}

/** Recognizes both our cancellation error and abort-shaped integration errors. */
export function isOperationCancellation(error: unknown): boolean {
  return (
    error instanceof OperationCancelledError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** Throws consistently instead of allowing cancellation to look like a tool error. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationCancelledError();
}

/**
 * Waits for an operation without leaving the caller stuck when its signal fires.
 * The original promise still gets rejection handling attached, so cancelling
 * the wrapper cannot create an unhandled rejection when the underlying work
 * eventually finishes.
 */
export function waitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => finish(() => reject(new OperationCancelledError()));

    signal.addEventListener('abort', onAbort, { once: true });
    // The signal can fire between the initial check and listener registration.
    if (signal.aborted) {
      onAbort();
      return;
    }

    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
