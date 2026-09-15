import { randomUUID } from 'node:crypto';
import { copyFile, open, rename, stat, unlink } from 'node:fs/promises';
import { throwIfAborted } from './abort';

/**
 * Commits a binary file in one rename, so readers see either the old complete
 * file or the new complete file, never a partially written destination.
 */
/**
 * Copies a file into a private sibling before replacing the destination.
 * A failed copy is removed, so an interrupted copy cannot leave a partial
 * destination or destroy the previous complete file.
 */
export async function copyFileAtomically(
  sourcePath: string,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (sourcePath === destinationPath) {
    await copyFile(sourcePath, destinationPath);
    throwIfAborted(signal);
    return;
  }
  const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
  let ownsTemporary = true;
  try {
    await copyFile(sourcePath, temporaryPath);
    const [sourceInfo, temporaryInfo] = await Promise.all([stat(sourcePath), stat(temporaryPath)]);
    if (!sourceInfo.isFile() || !temporaryInfo.isFile() || sourceInfo.size !== temporaryInfo.size) {
      throw new Error('The source changed while it was being copied.');
    }
    throwIfAborted(signal);
    await rename(temporaryPath, destinationPath);
    ownsTemporary = false;
  } finally {
    if (ownsTemporary) await unlink(temporaryPath).catch(() => undefined);
  }
}
export async function writeBufferAtomically(
  filePath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let ownsTemporary = false;
  try {
    const handle = await open(temporaryPath, 'wx');
    ownsTemporary = true;
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close().catch(() => undefined);
    }
    throwIfAborted(signal);
    await rename(temporaryPath, filePath);
    ownsTemporary = false;
  } finally {
    if (ownsTemporary) await unlink(temporaryPath).catch(() => undefined);
  }
}
