import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { throwIfAborted } from '../abort';
import { readBoundedTextFile } from '../bounded-file';
import { writeTextFileAtomic } from '../durable-store';
import { stringifyJsonWithinLimit } from '../bounded-json';

const MAX_DATA_READ_BYTES = 500_000;
export const MAX_DATA_HASH_BYTES = 50_000_000;
const MAX_DATA_REPLACE_FILE_BYTES = 5_000_000;
const MAX_DATA_OUTPUT_CHARS = 40_000;
const MAX_DATA_TREE_ENTRIES = 400;
const MAX_DATA_WALK_ENTRIES = 20_000;
const MAX_DATA_MATCHES = 500;
const MAX_DATA_FIND_CHARS = 10_000;
const MAX_DATA_REPLACEMENT_CHARS = 100_000;
const MAX_DATA_PATTERN_CHARS = 300;
const MAX_DATA_BASE64_CHARS = 1_000_000;

function boundedOutput(text: string, limit = MAX_DATA_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const marker = '\n…[output truncated at ' + limit.toLocaleString() + ' characters]';
  return text.slice(0, Math.max(0, limit - marker.length)) + marker;
}

function boundedJsonResult(value: unknown): string {
  try {
    return stringifyJsonWithinLimit(value, MAX_DATA_OUTPUT_CHARS, 'JSON query result');
  } catch {
    return '[JSON result omitted because it exceeds the ' + MAX_DATA_OUTPUT_CHARS.toLocaleString() + '-character output limit]';
  }
}

function normaliseLimit(value: number, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), maximum) : fallback;
}

async function readDataText(path: string, signal?: AbortSignal, limit = MAX_DATA_READ_BYTES): Promise<string> {
  throwIfAborted(signal);
  const abs = resolve(path);
  const info = await stat(abs);
  if (info.size > limit) {
    throw new Error(abs + ' is ' + info.size.toLocaleString() + ' bytes; data tools accept at most ' + limit.toLocaleString() + ' bytes.');
  }
  const bounded = await readBoundedTextFile(abs, limit, signal);
  if (bounded.truncated) {
    throw new Error(abs + ' exceeds the ' + limit.toLocaleString() + '-byte data-tool limit while it was being read.');
  }
  throwIfAborted(signal);
  if (bounded.text.length > limit) {
    throw new Error(abs + ' exceeds the ' + limit.toLocaleString() + '-character data-tool limit.');
  }
  return bounded.text;
}
async function readSourceText(source: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const trimmed = source.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    if (source.length > MAX_DATA_READ_BYTES) throw new Error('JSON input exceeded the ' + MAX_DATA_READ_BYTES.toLocaleString() + '-character safety limit.');
    return source;
  }
  return readDataText(source, signal);
}

/**
 * Working on data rather than on the machine.
 *
 * All of it is doable with a shell command and enough cleverness; the point of
 * naming them is that the agent stops writing brittle one-liners for jobs it
 * does constantly, and the user approving a call can see what it means.
 */

export async function hashFile(path: string, algorithm = 'sha256', signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const abs = resolve(path);
  const algo = ['md5', 'sha1', 'sha256', 'sha512'].includes(algorithm.toLowerCase())
    ? algorithm.toLowerCase()
    : 'sha256';
  const before = await stat(abs);
  if (!before.isFile()) throw new Error(abs + ' is not a regular file.');
  if (before.size > MAX_DATA_HASH_BYTES) {
    throw new Error(abs + ' is ' + before.size.toLocaleString() + ' bytes; hash tools accept at most ' + MAX_DATA_HASH_BYTES.toLocaleString() + ' bytes.');
  }

  const hash = createHash(algo);
  let bytesRead = 0;
  let oversized = false;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(abs, { signal, end: MAX_DATA_HASH_BYTES });
      stream.on('data', (chunk) => {
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        const remaining = MAX_DATA_HASH_BYTES - bytesRead;
        if (data.length > remaining) {
          if (remaining > 0) hash.update(data.subarray(0, remaining));
          bytesRead = MAX_DATA_HASH_BYTES;
          oversized = true;
          return;
        }
        hash.update(data);
        bytesRead += data.length;
      });
      stream.on('end', () => {
        if (oversized) {
          reject(new Error(abs + ' exceeded the ' + MAX_DATA_HASH_BYTES.toLocaleString() + '-byte hash-tool limit while it was being read.'));
        } else {
          resolvePromise();
        }
      });
      stream.on('error', reject);
    });
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  throwIfAborted(signal);
  const after = await stat(abs);
  if (!after.isFile() || after.size !== bytesRead) {
    throw new Error(abs + ' changed while it was being hashed; retry with a stable file.');
  }
  return `${algo}  ${hash.digest('hex')}\n${abs}  (${after.size.toLocaleString()} bytes)`;
}
/**
 * A line diff of two files.
 *
 * Deliberately the simple longest-common-subsequence walk rather than shelling
 * out: fc.exe formats for humans in ways that are hard to read back, and this
 * has to be parsed by a model.
 */
export async function diffFiles(a: string, b: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const [leftInfo, rightInfo] = await Promise.all([stat(resolve(a)), stat(resolve(b))]);
  if (leftInfo.size > MAX_DATA_READ_BYTES || rightInfo.size > MAX_DATA_READ_BYTES) {
    return `Files are too large to diff safely (limits are ${MAX_DATA_READ_BYTES.toLocaleString()} bytes): ${a} is ${leftInfo.size.toLocaleString()} bytes; ${b} is ${rightInfo.size.toLocaleString()} bytes.`;
  }
  const [left, right] = await Promise.all([
    readDataText(a, signal),
    readDataText(b, signal),
  ]);
  throwIfAborted(signal);
  const A = left.split(/\r?\n/);
  const B = right.split(/\r?\n/);

  if (left === right) return `${a} and ${b} are identical (${A.length} lines).`;

  // Guard the quadratic table; huge files get a summary instead of a diff.
  if (A.length * B.length > 4_000_000) {
    return `Both files are too large to diff line by line (${A.length} and ${B.length} lines). They differ.`;
  }

  // A typed table keeps the worst allowed 4M-cell diff near 16 MB instead of
  // allocating millions of boxed JavaScript numbers.
  const lcs = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) {
    const row = lcs[i];
    const nextRow = lcs[i + 1];
    const leftLine = A[i];
    if (!row || !nextRow || leftLine === undefined) throw new Error('Diff table bounds became inconsistent.');
    for (let j = B.length - 1; j >= 0; j--) {
      if (((i + j) & 1023) === 0) throwIfAborted(signal);
      row[j] = leftLine === B[j]
        ? (nextRow[j + 1] ?? 0) + 1
        : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    throwIfAborted(signal);
    const leftLine = A[i];
    const rightLine = B[j];
    if (leftLine === undefined || rightLine === undefined) break;
    if (leftLine === rightLine) {
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push(`-${i + 1}  ${leftLine}`);
      i++;
    } else {
      out.push(`+${j + 1}  ${rightLine}`);
      j++;
    }
  }
  while (i < A.length) {
    const line = A[i];
    if (line !== undefined) out.push(`-${i + 1}  ${line}`);
    i++;
  }
  while (j < B.length) {
    const line = B[j];
    if (line !== undefined) out.push(`+${j + 1}  ${line}`);
    j++;
  }

  const shown = out.slice(0, 400);
  return boundedOutput(
    `--- ${a}\n+++ ${b}\n${shown.join('\n')}` +
      (out.length > shown.length ? `\n…and ${out.length - shown.length} more changed lines` : ''),
  );
}

/**
 * Reads a CSV into aligned rows.
 *
 * Handles quoted fields and embedded commas, which is the whole reason not to
 * just split on a comma and hope.
 */
export async function readCsv(path: string, limit = 50, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const text = await readDataText(path, signal);
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return '(empty file)';

  const shown = rows.slice(0, normaliseLimit(limit, 50, 500));
  const shownHeader = shown[0] ?? header;
  const widths = shownHeader.map((_, col) =>
    Math.min(40, Math.max(...shown.map((r) => (r[col] ?? '').length))),
  );
  const line = (r: string[]) =>
    r.map((cell, k) => (cell ?? '').slice(0, 40).padEnd(widths[k] ?? 0)).join('  ');

  return boundedOutput(
    `${rows.length} rows x ${header.length} columns\n\n` +
      `${line(shownHeader)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}\n` +
      shown.slice(1).map(line).join('\n') +
      (rows.length > shown.length ? `\n…and ${rows.length - shown.length} more rows` : ''),
  );
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ''));
}

/**
 * Pulls a value out of JSON by dotted path — `data.items[0].name`.
 *
 * The alternative is reading a 2MB API response into the conversation to find
 * one field in it.
 */
export async function jsonQuery(source: string, path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (path.length > 4_000) throw new Error('JSON query paths must be 4,000 characters or fewer.');
  const text = await readSourceText(source, signal);

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }

  if (!path || path === '.') return boundedJsonResult(value);

  const steps = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cursor: unknown = value;
  const walked: string[] = [];
  for (const step of steps) {
    throwIfAborted(signal);
    if (cursor === null || cursor === undefined) {
      throw new Error(`Path stops at "${walked.join('.') || 'the root'}" — nothing beyond it.`);
    }
    const next = (cursor as Record<string, unknown>)[step];
    if (next === undefined) {
      const keys = typeof cursor === 'object' ? Object.keys(cursor as object).slice(0, 20) : [];
      throw new Error(
        `No "${step}" at ${walked.join('.') || 'the root'}.` +
          (keys.length ? ` Available: ${keys.join(', ')}` : ''),
      );
    }
    cursor = next;
    walked.push(step);
  }
  const output = typeof cursor === 'string' ? cursor : boundedJsonResult(cursor);
  throwIfAborted(signal);
  return boundedOutput(output);
}

/** Runs a regular expression over a file or a string and returns the matches. */
export async function regexExtract(
  source: string,
  pattern: string,
  flags = 'g',
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (pattern.length > MAX_DATA_PATTERN_CHARS) throw new Error('Regular-expression patterns must be 300 characters or fewer.');
  if (flags.length > 30) throw new Error('Regular-expression flags are too long.');
  let text: string;
  if (source.includes('\n') || !/[\\/.]/.test(source)) {
    if (source.length > MAX_DATA_READ_BYTES) throw new Error('Regex input exceeded the data-tool safety limit.');
    text = source;
  } else {
    try {
      await stat(resolve(source));
      text = await readDataText(source, signal);
    } catch (error) {
      throwIfAborted(signal);
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code !== 'ENOENT') throw error;
      if (source.length > MAX_DATA_READ_BYTES) throw new Error('Regex input exceeded the data-tool safety limit.');
      text = source;
    }
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  } catch (e) {
    throw new Error(`Bad pattern: ${(e as Error).message}`);
  }

  const found = [...text.matchAll(re)].slice(0, MAX_DATA_MATCHES);
  if (!found.length) return 'No matches.';
  throwIfAborted(signal);
  return boundedOutput(found
    .map((m) => (m.length > 1 ? m.slice(1).join('\t') : m[0]))
    .join('\n'));
}

/* ------------------------------------------------------------------ files */

/** A directory tree, depth-limited so a deep folder cannot flood the answer. */
async function readDirectoryWindow(
  dir: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<{ entries: Dirent[]; hasMore: boolean }> {
  const entries: Dirent[] = [];
  const limit = Math.max(1, Math.floor(maximum));
  let hasMore = false;
  const directory = await opendir(dir);
  try {
    while (entries.length < limit) {
      throwIfAborted(signal);
      const entry = await directory.read();
      if (!entry) break;
      entries.push(entry);
    }
    if (entries.length === limit) {
      throwIfAborted(signal);
      hasMore = (await directory.read()) !== null;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { entries, hasMore };
}

/** A directory tree, depth-limited so a deep folder cannot flood the answer. */
export async function fileTree(root: string, depth = 3, maxEntries = 400, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const base = resolve(root);
  const lines: string[] = [base];
  let count = 0;
  const safeMaxEntries = normaliseLimit(maxEntries, 400, MAX_DATA_TREE_ENTRIES);
  const safeDepth = normaliseLimit(depth, 3, 8);
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv']);

  async function walk(dir: string, prefix: string, left: number): Promise<void> {
    throwIfAborted(signal);
    if (left <= 0 || count >= safeMaxEntries) return;
    let window;
    try {
      window = await readDirectoryWindow(dir, safeMaxEntries - count, signal);
    } catch {
      return;
    }
    const { entries, hasMore } = window;
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const [i, e] of entries.entries()) {
      throwIfAborted(signal);
      if (count >= safeMaxEntries) {
        lines.push(`${prefix}…(truncated at ${safeMaxEntries} entries)`);
        return;
      }
      const last = i === entries.length - 1 && !hasMore;
      const branch = last ? '└─ ' : '├─ ';
      if (e.isDirectory()) {
        lines.push(`${prefix}${branch}${e.name}/`);
        count++;
        if (!skip.has(e.name)) {
          await walk(join(dir, e.name), prefix + (last ? '   ' : '│  '), left - 1);
        } else {
          lines.push(`${prefix}${last ? '   ' : '│  '}…skipped`);
        }
      } else {
        lines.push(`${prefix}${branch}${e.name}`);
        count++;
      }
    }
    if (hasMore) {
      lines.push(
        count >= safeMaxEntries
          ? `${prefix}…(truncated at ${safeMaxEntries} entries)`
          : `${prefix}…(more entries omitted)`,
      );
    }
  }

  await walk(base, '', safeDepth);
  throwIfAborted(signal);
  return boundedOutput(lines.join('\n'));
}

/** Total size of a folder, with its largest children — "what is eating my disk". */
export async function dirSize(root: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const base = resolve(root);
  let visited = 0;
  let truncated = false;

  async function measure(dir: string): Promise<number> {
    throwIfAborted(signal);
    if (visited >= MAX_DATA_WALK_ENTRIES) {
      truncated = true;
      return 0;
    }
    let window;
    try {
      window = await readDirectoryWindow(dir, MAX_DATA_WALK_ENTRIES - visited, signal);
    } catch {
      return 0;
    }
    if (window.hasMore) truncated = true;
    let total = 0;
    for (const e of window.entries) {
      throwIfAborted(signal);
      if (visited >= MAX_DATA_WALK_ENTRIES) {
        truncated = true;
        break;
      }
      visited += 1;
      const full = join(dir, e.name);
      try {
        if (e.isDirectory()) total += await measure(full);
        else if (e.isFile()) total += (await stat(full)).size;
      } catch {
        /* locked or vanished mid-walk */
      }
    }
    return total;
  }

  const rootWindow = await readDirectoryWindow(base, MAX_DATA_WALK_ENTRIES, signal);
  if (rootWindow.hasMore) truncated = true;
  const sized: { name: string; size: number }[] = [];
  for (const e of rootWindow.entries) {
    throwIfAborted(signal);
    if (visited >= MAX_DATA_WALK_ENTRIES) {
      truncated = true;
      break;
    }
    visited += 1;
    const full = join(base, e.name);
    try {
      const size = e.isDirectory() ? await measure(full) : (await stat(full)).size;
      sized.push({ name: e.isDirectory() ? `${e.name}/` : e.name, size });
    } catch {
      sized.push({ name: e.name, size: 0 });
    }
  }

  const total = sized.reduce((n, c) => n + c.size, 0);
  const top = sized.sort((a, b) => b.size - a.size).slice(0, 25);
  throwIfAborted(signal);
  const note = truncated ? `\n\n[folder scan truncated after ${MAX_DATA_WALK_ENTRIES.toLocaleString()} entries]` : '';
  return boundedOutput(
    `${base}\ntotal: ${humanSize(total)}\n\n` +
      top.map((c) => `${humanSize(c.size).padStart(12)}  ${c.name}`).join('\n') + note,
  );
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Most recently modified files under a folder — "what was I just working on". */
export async function recentFiles(root: string, limit = 25, days = 7, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const base = resolve(root);
  const safeLimit = normaliseLimit(limit, 25, 200);
  const safeDays = normaliseLimit(days, 7, 3_650);
  const cutoff = Date.now() - safeDays * 86_400_000;
  const found: { path: string; mtime: number; size: number }[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'AppData']);
  let visited = 0;
  let truncated = false;

  async function walk(dir: string, left: number): Promise<void> {
    throwIfAborted(signal);
    if (left <= 0 || visited >= MAX_DATA_WALK_ENTRIES) return;
    let window;
    try {
      window = await readDirectoryWindow(dir, MAX_DATA_WALK_ENTRIES - visited, signal);
    } catch {
      return;
    }
    if (window.hasMore) truncated = true;
    for (const e of window.entries) {
      throwIfAborted(signal);
      if (visited >= MAX_DATA_WALK_ENTRIES) {
        truncated = true;
        return;
      }
      visited += 1;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith('.')) await walk(full, left - 1);
        continue;
      }
      try {
        const info = await stat(full);
        if (info.mtimeMs >= cutoff) found.push({ path: full, mtime: info.mtimeMs, size: info.size });
      } catch {
        /* gone */
      }
    }
  }

  await walk(base, 6);
  throwIfAborted(signal);
  const scanNote = truncated ? `\n\n[folder scan truncated after ${MAX_DATA_WALK_ENTRIES.toLocaleString()} entries]` : '';
  if (!found.length) return `Nothing under ${base} has changed in the last ${safeDays} days.${scanNote}`;

  return boundedOutput(found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, safeLimit)
    .map((f) => `${new Date(f.mtime).toLocaleString()}  ${humanSize(f.size).padStart(10)}  ${f.path}`)
    .join('\n') + scanNote);
}

/**
 * Find and replace across many files at once.
 *
 * Confirm-tier and deliberately literal — no regex — because a bad pattern here
 * rewrites a whole tree, and "it only matched what I expected" is exactly the
 * assumption that goes wrong.
 */
export async function replaceInFiles(
  root: string,
  find: string,
  replaceWith: string,
  filePattern = '*',
  signal?: AbortSignal,
): Promise<string> {
  if (!find) throw new Error('Nothing to find.');
  throwIfAborted(signal);
  if (find.length > MAX_DATA_FIND_CHARS) throw new Error('The replacement target is too long.');
  if (replaceWith.length > MAX_DATA_REPLACEMENT_CHARS) throw new Error('The replacement text is too long.');
  if (filePattern.length > MAX_DATA_PATTERN_CHARS) throw new Error('The file pattern is too long.');
  const base = resolve(root);
  const slash = String.fromCharCode(92);
  const escapedPattern = filePattern
    .split('')
    .map((char) => '.+^${}()|[]'.includes(char) || char === slash ? slash + char : char)
    .join('');
  const re = new RegExp(
    `^${escapedPattern.split('*').join('.*').split('?').join('.')}$`,
    'i',
  );
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv']);
  const changed: string[] = [];
  const failed: string[] = [];
  let failures = 0;
  let replacements = 0;
  let visited = 0;
  let truncated = false;

  async function walk(dir: string, left: number): Promise<void> {
    throwIfAborted(signal);
    if (left <= 0 || changed.length + failures >= 500 || visited >= MAX_DATA_WALK_ENTRIES) return;
    let window;
    try {
      window = await readDirectoryWindow(dir, MAX_DATA_WALK_ENTRIES - visited, signal);
    } catch {
      return;
    }
    if (window.hasMore) truncated = true;
    for (const e of window.entries) {
      throwIfAborted(signal);
      if (changed.length + failures >= 500) return;
      if (visited >= MAX_DATA_WALK_ENTRIES) {
        truncated = true;
        return;
      }
      visited += 1;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(full, left - 1);
        continue;
      }
      if (!re.test(e.name)) continue;
      try {
        const info = await stat(full);
        if (info.size > MAX_DATA_REPLACE_FILE_BYTES) continue;
        throwIfAborted(signal);
        const boundedSource = await readBoundedTextFile(full, MAX_DATA_REPLACE_FILE_BYTES, signal);
        if (boundedSource.truncated) continue;
        const text = boundedSource.text;
        const hits = text.split(find).length - 1;
        if (!hits) continue;
        const projectedSize = text.length + hits * (replaceWith.length - find.length);
        if (projectedSize > MAX_DATA_REPLACE_FILE_BYTES) continue;
        const updated = text.split(find).join(replaceWith);
        try {
          throwIfAborted(signal);
          writeTextFileAtomic(full, updated);
          const boundedVerified = await readBoundedTextFile(full, MAX_DATA_REPLACE_FILE_BYTES, signal);
          if (boundedVerified.truncated) throw new Error('post-write verification file exceeded the safety limit while it was being read');
          const verified = boundedVerified.text;
          throwIfAborted(signal);
          if (verified !== updated) throw new Error('post-write verification did not match the requested content');
          changed.push(full + '  (' + hits + ')');
          replacements += hits;
        } catch (error) {
          if (signal?.aborted) throw error;
          failures += 1;
          const reason = error instanceof Error ? error.message : String(error);
          failed.push(full + '  (' + reason.replace(/\s+/g, ' ').slice(0, 180) + ')');
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        /* binary or locked */
      }
    }
  }

  await walk(base, 8);
  throwIfAborted(signal);
  const scanNote = truncated ? '\n[scan truncated after ' + MAX_DATA_WALK_ENTRIES.toLocaleString() + ' entries]' : '';
  if (!changed.length && !failures) return `No file under ${base} matching ${filePattern} contained that text.${scanNote}`;
  const summary = `Replaced ${replacements} occurrence(s) across ${changed.length} file(s):\n${changed.join('\n')}`;
  return boundedOutput(failures
    ? summary + '\nFailed ' + failures + ' file(s):\n' + failed.join('\n') + scanNote
    : summary + scanNote);
}
/* ---------------------------------------------------------------- encoding */

export function base64Encode(text: string, signal?: AbortSignal): string {
  throwIfAborted(signal);
  if (text.length > MAX_DATA_BASE64_CHARS) throw new Error('Base64 input exceeded the safety limit.');
  return boundedOutput(Buffer.from(text, 'utf8').toString('base64'));
}

export function base64Decode(text: string, signal?: AbortSignal): string {
  throwIfAborted(signal);
  if (text.length > MAX_DATA_BASE64_CHARS) throw new Error('Base64 input exceeded the safety limit.');
  return boundedOutput(Buffer.from(text.trim(), 'base64').toString('utf8'));
}
