import { mkdir, opendir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { throwIfAborted } from '../abort';
import { readBoundedTextFile } from '../bounded-file';
import { BulkPartialFailure } from '../bulk';
import { writeTextFileAtomic } from '../durable-store';

const MAX_READ = 400_000;
export const MAX_TEXT_WRITE_BYTES = 5_000_000;
const MAX_LINES = 500;
const MAX_LINE_CHARS = 8_000;
const MAX_DIR_ENTRIES = 500;
const MAX_DIR_OUTPUT = 30_000;
const MAX_MANY_OUTPUT = 120_000;

function boundedOutput(text: string, maximum: number, marker: string): string {
  if (text.length <= maximum) return text;
  const suffix = '\n' + marker;
  return text.slice(0, Math.max(0, maximum - suffix.length)).trimEnd() + suffix;
}

function textWriteBytes(content: string, label: string): number {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_TEXT_WRITE_BYTES) {
    throw new Error(`${label} exceeded the ${MAX_TEXT_WRITE_BYTES.toLocaleString()}-byte safety limit.`);
  }
  return bytes;
}

async function verifyText(abs: string, expected: string, action: string): Promise<void> {
  const maximumBytes = Math.min(MAX_TEXT_WRITE_BYTES, Buffer.byteLength(expected, 'utf8') + 1);
  const bounded = await readBoundedTextFile(abs, maximumBytes);
  if (bounded.truncated || bounded.text !== expected) {
    throw new Error('Verification failed after ' + action + ': ' + abs);
  }
}
async function verifyDirectory(abs: string, action: string): Promise<void> {
  const info = await stat(abs);
  if (!info.isDirectory()) {
    throw new Error('Verification failed after ' + action + ': ' + abs);
  }

}
export async function readTextFile(path: string, signal?: AbortSignal): Promise<string> {
  const abs = resolve(path);
  throwIfAborted(signal);
  const info = await stat(abs);
  if (info.isDirectory()) return listDir(abs, signal);
  const bounded = await readBoundedTextFile(abs, MAX_READ, signal);
  const oversized = info.size > MAX_READ || bounded.truncated;
  if (oversized) {
    const reportedSize = info.size > MAX_READ ? info.size : MAX_READ + 1;
    return bounded.text + '\n…[file is ' + reportedSize + ' bytes, truncated before full read]';
  }
  return bounded.text;
}
export async function listDir(path: string, signal?: AbortSignal): Promise<string> {
  const abs = resolve(path);
  throwIfAborted(signal);
  const entries = [];
  let hasMore = false;
  const directory = await opendir(abs);
  try {
    while (entries.length < MAX_DIR_ENTRIES) {
      throwIfAborted(signal);
      const entry = await directory.read();
      if (!entry) break;
      entries.push(entry);
    }
    if (entries.length === MAX_DIR_ENTRIES) {
      throwIfAborted(signal);
      hasMore = (await directory.read()) !== null;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  throwIfAborted(signal);
  const lines = entries.map((e) => (e.isDirectory() ? `${e.name.slice(0, 500)}/` : e.name.slice(0, 500)));
  const output = lines.length ? lines.join('\n') : '(empty directory)';
  return boundedOutput(output + (hasMore ? '\n…[additional directory entries omitted]' : ''), MAX_DIR_OUTPUT, '[directory listing truncated]');
}
export async function createFolder(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const abs = resolve(path);
  await mkdir(abs, { recursive: true });
  await verifyDirectory(abs, 'create folder');
  return `Created ${abs}`;
}

export async function writeTextFile(path: string, content: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  textWriteBytes(content, 'Text file content');
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  throwIfAborted(signal);
  writeTextFileAtomic(abs, content);
  await verifyText(abs, content, 'write file');
  return `Wrote ${content.length} chars to ${abs}`;
}

/**
 * Exact-string replacement. Refuses ambiguous edits rather than guessing which
 * occurrence was meant.
 */
export async function editTextFile(
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false,
  signal?: AbortSignal,
): Promise<string> {
  const abs = resolve(path);
  throwIfAborted(signal);
  if (typeof oldString !== 'string' || !oldString.length) {
    throw new Error('A non-empty target string is required for an exact file edit.');
  }
  textWriteBytes(newString, 'Replacement text');
  const info = await stat(abs);
  if (!info.isFile()) throw new Error('Text file must be a regular file: ' + abs);
  if (info.size > MAX_TEXT_WRITE_BYTES) throw new Error('Text file exceeds the write safety limit: ' + abs);
  const originalRead = await readBoundedTextFile(abs, MAX_TEXT_WRITE_BYTES, signal);
  if (originalRead.truncated) throw new Error('Text file exceeds the write safety limit: ' + abs);
  const original = originalRead.text;
  throwIfAborted(signal);
  const count = original.split(oldString).length - 1;

  if (count === 0) throw new Error('Target string not found in file.');
  if (count > 1 && !replaceAll) {
    throw new Error(`Target string appears ${count} times — pass replaceAll or use a longer match.`);
  }

  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, () => newString);
  textWriteBytes(updated, 'Edited file content');
  throwIfAborted(signal);
  writeTextFileAtomic(abs, updated);
  await verifyText(abs, updated, 'edit file');
  return `Replaced ${replaceAll ? count : 1} occurrence(s) in ${abs}`;
}

/**
 * Reads a slice of a file by line number.
 *
 * Whole-file reads are the usual thing, but a 40MB log answered in full costs
 * most of the context window to learn one stack trace, so line ranges exist for
 * exactly that case.
 */
export async function readLines(path: string, start = 1, end = 200, signal?: AbortSignal): Promise<string> {
  const abs = resolve(path);
  throwIfAborted(signal);
  const info = await stat(abs);
  const bounded = await readBoundedTextFile(abs, MAX_READ, signal);
  const oversized = info.size > MAX_READ || bounded.truncated;
  const text = bounded.text;
  throwIfAborted(signal);
  const lines = text.split(/\r?\n/);
  const from = Number.isFinite(start) ? Math.max(1, Math.floor(start)) : 1;
  const requestedEnd = Number.isFinite(end) ? Math.max(from, Math.floor(end)) : from + MAX_LINES - 1;
  const to = Math.min(lines.length, from + MAX_LINES - 1, requestedEnd);
  const slice = lines.slice(from - 1, to).map((line, i) => {
    const shown = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…[line truncated]' : line;
    return String(from + i) + '\t' + shown;
  });
  const total = oversized ? 'at least ' + lines.length : String(lines.length);
  const note = oversized ? '\n[file read was bounded before line extraction]' : '';
  return boundedOutput(
    slice.join('\n') + '\n\n[lines ' + from + '-' + to + ' of ' + total + ']' + note,
    MAX_MANY_OUTPUT,
    '[line output truncated]',
  );
}
export async function appendTextFile(path: string, content: string, signal?: AbortSignal): Promise<string> {
  const appendedBytes = textWriteBytes(content, 'Appended text');
  const abs = resolve(path);
  let before = '';
  try {
    throwIfAborted(signal);
    const info = await stat(abs);
    if (!info.isFile()) throw new Error('Text file must be a regular file: ' + abs);
    if (info.size > MAX_TEXT_WRITE_BYTES || info.size + appendedBytes > MAX_TEXT_WRITE_BYTES) {
      throw new Error('Appended text would exceed the ' + MAX_TEXT_WRITE_BYTES.toLocaleString() + '-byte safety limit.');
    }
    const bounded = await readBoundedTextFile(abs, MAX_TEXT_WRITE_BYTES, signal);
    if (bounded.truncated) throw new Error('Text file exceeds the write safety limit: ' + abs);
    before = bounded.text;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  throwIfAborted(signal);
  await mkdir(dirname(abs), { recursive: true });
  throwIfAborted(signal);
  writeTextFileAtomic(abs, before + content);
  await verifyText(abs, before + content, 'append file');
  return `Appended ${content.length} chars to ${abs}`;
}

/** Reads several files in one step, so N files cost one round trip, not N. */
export async function readManyFiles(paths: string[], signal?: AbortSignal): Promise<string> {
  const selected = (Array.isArray(paths) ? paths : []).slice(0, 20);
  if (!selected.length) return 'No paths given.';
  const outcomes = await Promise.all(
    selected.map(async (path) => {
      const displayPath = String(path).slice(0, 2_000);
      try {
        const body = await readTextFile(String(path), signal);
        return { failed: false, text: `--- ${displayPath}\n${body}` };
      } catch (error) {
        throwIfAborted(signal);
        return { failed: true, text: `--- ${displayPath}\n(could not read: ${(error as Error).message})` };
      }
    }),
  );
  throwIfAborted(signal);
  const omitted = (Array.isArray(paths) ? paths.length : 0) - selected.length;
  const note = omitted > 0 ? `\n\n…[${omitted} additional file(s) omitted]` : '';
  const output = boundedOutput(outcomes.map((entry) => entry.text).join('\n\n') + note, MAX_MANY_OUTPUT, '[multi-file output truncated]');
  const failures = outcomes.filter((entry) => entry.failed).length;
  if (failures > 0) {
    throw new BulkPartialFailure(
      output + '\n\n[' + failures + ' of ' + selected.length + ' file(s) could not be read.]',
    );
  }
  return output;
}
