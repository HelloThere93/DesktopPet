import { readFile, readdir, stat, rename, mkdir, rm } from 'node:fs/promises';
import { throwIfAborted } from '../abort';
import { copyFileAtomically } from '../atomic-file';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

async function pathExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }

}
/**
 * Finding things on disk, and moving them once found.
 *
 * Deliberately implemented in Node rather than shelling out: `dir /s` and
 * `Select-String` return output that has to be re-parsed, and every generated
 * command is another arbitrary string for the permission classifier to judge.
 * A named tool with typed arguments is both safer and easier to reason about.
 */

/** Never walked into: huge, uninteresting, and usually not what was meant. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '$RECYCLE.BIN',
  'System Volume Information',
  'AppData',
  'Windows',
  '.cache',
  'dist',
  'build',
  'Temp',
]);

const BINARY_EXT = new Set([
  '.exe', '.dll', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf',
  '.zip', '.7z', '.rar', '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ttf', '.otf',
  '.sqlite', '.db', '.bin', '.obj', '.pdb', '.lib', '.pyc',
]);

/** Glob subset: * within a segment, ** across segments, ? for one character. */
function globToRegExp(pattern: string): RegExp {
  const portablePattern = pattern.replace(/\\/g, '/');
  const escaped = portablePattern
    .split('**')
    .map((segment) => segment
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

interface WalkOptions {
  maxDepth: number;
  maxResults: number;
  signal?: AbortSignal;
  onFile: (path: string) => boolean | Promise<boolean>;
}

async function walk(dir: string, depth: number, opts: WalkOptions): Promise<boolean> {
  if (depth > opts.maxDepth) return true;
  throwIfAborted(opts.signal);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throwIfAborted(opts.signal);
    // Permission denied on a system folder is normal; keep going elsewhere.
    return true;
  }

  for (const entry of entries) {
    throwIfAborted(opts.signal);
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      if (!(await walk(full, depth + 1, opts))) return false;
    } else if (entry.isFile()) {
      if (!(await opts.onFile(full))) return false;
    }
  }
  return true;
}

export async function searchFiles(
  root: string,
  pattern: string,
  maxResults = 60,
  maxDepth = 8,
  signal?: AbortSignal,
): Promise<string> {
  const base = resolve(root);
  const re = globToRegExp(pattern.includes('/') || pattern.includes('\\') ? pattern : `*${pattern}*`);
  const hits: string[] = [];

  await walk(base, 0, {
    maxDepth,
    maxResults,
    signal,
    onFile: (path) => {
      const relativePath = relative(base, path).replace(/\\/g, '/');
      const portablePath = path.replace(/\\/g, '/');
      if (re.test(basename(path)) || re.test(relativePath) || re.test(portablePath)) hits.push(path);
      return hits.length < maxResults;
    },
  });
  throwIfAborted(signal);

  if (!hits.length) return `No files matching "${pattern}" under ${base}.`;
  return (
    `${hits.length}${hits.length === maxResults ? '+' : ''} match(es) under ${base}:\n` +
    hits.join('\n')
  );
}

export async function searchText(
  root: string,
  query: string,
  filePattern = '*',
  maxResults = 40,
  maxDepth = 8,
  signal?: AbortSignal,
): Promise<string> {
  const base = resolve(root);
  const nameRe = globToRegExp(filePattern);
  const needle = query.toLowerCase();
  const hits: string[] = [];

  await walk(base, 0, {
    maxDepth,
    maxResults,
    signal,
    onFile: async (path) => {
      throwIfAborted(signal);
      const relativePath = relative(base, path).replace(/\\/g, '/');
      const portablePath = path.replace(/\\/g, '/');
      if (!nameRe.test(basename(path)) && !nameRe.test(relativePath) && !nameRe.test(portablePath)) return true;
      if (BINARY_EXT.has(extname(path).toLowerCase())) return true;
      try {
        const info = await stat(path);
        throwIfAborted(signal);
        // Skip anything too large to be worth grepping line by line.
        if (info.size > 3_000_000) return true;
        const text = await readFile(path, 'utf8');
        throwIfAborted(signal);
        if (!text.toLowerCase().includes(needle)) return true;

        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
          throwIfAborted(signal);
          const line = lines[i];
          if (line?.toLowerCase().includes(needle)) {
            hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        }
      } catch {
        throwIfAborted(signal);
        /* unreadable or not text */
      }
      return hits.length < maxResults;
    },
  });
  throwIfAborted(signal);

  if (!hits.length) return `No matches for "${query}" under ${base}.`;
  return `${hits.length}${hits.length === maxResults ? '+' : ''} match(es):\n${hits.join('\n')}`;
}

export async function fileInfo(path: string): Promise<string> {
  const abs = resolve(path);
  const info = await stat(abs);
  const kb = info.size / 1024;
  const size = kb > 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(1)} KB`;
  return [
    abs,
    `${info.isDirectory() ? 'Folder' : 'File'} · ${size}`,
    `Created  ${info.birthtime.toLocaleString()}`,
    `Modified ${info.mtime.toLocaleString()}`,
  ].join('\n');
}

export async function moveItem(from: string, to: string, signal?: AbortSignal): Promise<string> {
  const src = resolve(from);
  const dest = resolve(to);
  throwIfAborted(signal);
  await mkdir(dirname(dest), { recursive: true });
  throwIfAborted(signal);
  await rename(src, dest);
  if ((await pathExists(src)) || !(await pathExists(dest))) {
    throw new Error('Verification failed after move: ' + src + ' -> ' + dest);
  }
  return `Moved ${src} -> ${dest}`;
}

export async function copyItem(from: string, to: string, signal?: AbortSignal): Promise<string> {
  const src = resolve(from);
  const dest = resolve(to);
  throwIfAborted(signal);
  await mkdir(dirname(dest), { recursive: true });
  throwIfAborted(signal);
  await copyFileAtomically(src, dest, signal);
  const copied = await stat(dest);
  const original = await stat(src);
  if (copied.size !== original.size) {
    throw new Error('Verification failed after copy: ' + src + ' -> ' + dest);
  }
  return `Copied ${src} -> ${dest}`;
}

/**
 * Deletes to the recycle bin rather than permanently — the difference between
 * a mistake you can undo and one you cannot.
 */
export async function deleteItem(path: string, permanent = false, signal?: AbortSignal): Promise<string> {
  const requested = path.trim();
  if (!requested) throw new Error('A path is required for deletion.');
  const abs = resolve(requested);
  throwIfAborted(signal);
  if (!(await pathExists(abs))) throw new Error('Nothing exists at ' + abs + '.');
  throwIfAborted(signal);
  if (permanent) {
    await rm(abs, { recursive: true, force: true });
    if (await pathExists(abs)) throw new Error('Verification failed after delete: ' + abs);
    return `Permanently deleted ${abs}`;
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        `if (Test-Path -PathType Container '${abs.replace(/'/g, "''")}') { ` +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${abs.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin') } else { ` +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${abs.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin') }`,
    ],
    { windowsHide: true, timeout: 30_000, signal },
  );
  if (await pathExists(abs)) throw new Error('Verification failed after recycle-bin delete: ' + abs);
  return `Sent ${abs} to the recycle bin.`;
}
