export interface LatestTaskQueue {
  enqueue(task: () => Promise<void>): Promise<void>;
  invalidate(): void;
}

export interface SerialTaskQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export interface SingleFlightGate {
  tryEnter(): boolean;
  leave(): void;
}

export function createSingleFlightGate(): SingleFlightGate {
  let active = false;
  return {
    tryEnter(): boolean {
      if (active) return false;
      active = true;
      return true;
    },
    leave(): void {
      active = false;
    },
  };
}

/** Serializes every task in submission order while isolating failures. */
export function createSerialTaskQueue(): SerialTaskQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const next: Promise<T> = tail.then(
        () => task(),
        () => task(),
      );
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

/** Serializes async writes while skipping queued work superseded by a newer write. */
export function createLatestTaskQueue(): LatestTaskQueue {
  let generation = 0;
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue(task): Promise<void> {
      const taskGeneration = ++generation;
      const next = tail.then(
        async () => {
          if (taskGeneration !== generation) return;
          await task();
        },
        async () => {
          if (taskGeneration !== generation) return;
          await task();
        },
      );
      tail = next.catch(() => undefined);
      return next;
    },
    invalidate(): void {
      generation += 1;
    },
  };
}
