import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { readBoundedTextFileSync } from './bounded-file';
import { stringifyJsonWithinLimit } from './bounded-json';

export type JsonGuard<T> = (value: unknown) => value is T;

export const MAX_JSON_STORE_BYTES = 5_000_000;

function temporaryPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
}

function removeTemporaryFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // The rename may already have consumed it.
  }
}

/**
 * Writes text by completing a private sibling file before replacing the target.
 *
 * The sibling is opened with wx so two concurrent writers cannot accidentally
 * share a temporary file. renameSync is the commit point: readers see either
 * the old complete file or the new complete file, never a partial write.
 */
export function writeTextFileAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempFile = temporaryPath(filePath);
  try {
    writeFileSync(tempFile, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(tempFile, filePath);
  } catch (error) {
    removeTemporaryFile(tempFile);
    throw error;
  }
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const serialized = stringifyJsonWithinLimit(
    value,
    MAX_JSON_STORE_BYTES - 1,
    'JSON store value (5 MB safety limit)',
    2,
  );
  if (serialized === undefined) {
    throw new TypeError('Cannot persist an undefined JSON value.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_STORE_BYTES) throw new Error('JSON store value exceeded the 5 MB safety limit.');
  writeTextFileAtomic(filePath, `${serialized}\n`);
}

function quarantineCorruptFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const backup = `${filePath}.corrupt-${Date.now()}-${randomBytes(6).toString('hex')}`;
  try {
    renameSync(filePath, backup);
  } catch {
    // Preserve the caller's fallback even if another process has the file open.
  }
}

/**
 * Loads a validated JSON value. A malformed or schema-invalid file is moved
 * aside before the fallback is returned, so a crash cannot silently erase the
 * only copy of the user's planning or memory state.
 */
export function readJsonFile<T>(
  filePath: string,
  fallback: T,
  isValid: JsonGuard<T>,
): T {
  let text: string;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) throw new Error('JSON store path must be a regular file.');
    if (stats.size > MAX_JSON_STORE_BYTES) {
      quarantineCorruptFile(filePath);
      return fallback;
    }
    const bounded = readBoundedTextFileSync(filePath, MAX_JSON_STORE_BYTES);
    if (bounded.truncated) {
      quarantineCorruptFile(filePath);
      return fallback;
    }
    text = bounded.text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isValid(parsed)) throw new Error('JSON store schema validation failed.');
    return parsed;
  } catch {
    quarantineCorruptFile(filePath);
    return fallback;
  }
}
