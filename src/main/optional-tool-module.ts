import { setTimeout as delay } from 'node:timers/promises';
import { throwIfAborted } from './abort';

const RETRY_DELAYS_MS = [100, 250, 500] as const;

/**
 * Only for side-effect-free, optional module imports. Never put a tool action
 * or the application entrypoint in this callback: those must not be replayed.
 * CommonJS caches successful imports, but removes a module when loading fails.
 */
export async function loadOptionalToolModule<T>(load: () => T, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try {
      return load();
    } catch (error) {
      const failure = error as NodeJS.ErrnoException | null;
      if (!failure || !['EPERM', 'EBUSY'].includes(failure.code ?? '') ||
          !['open', 'read'].includes(failure.syscall ?? '')) {
        throw error;
      }
      const waitMs = RETRY_DELAYS_MS[attempt];
      if (waitMs === undefined) {
        throw new Error(
          'The document reader could not be loaded because Windows is blocking an Adi application file' +
          (failure.path ? ': ' + failure.path : '.') +
          ' (' + failure.code + '). Other tools are still available. Retry after the file becomes accessible; ' +
          'if this persists, repair or rebuild Adi. Restarting Chrome will not help.',
          { cause: error },
        );
      }
      await delay(waitMs, undefined, { signal });
    }
  }
}
