import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, opendirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { throwIfAborted } from '../abort';

const execFileAsync = promisify(execFile);

/**
 * Development tools: git, and running a snippet in a real language.
 *
 * Git gets named tools because "what changed" is asked constantly and parsing
 * porcelain output back out of a generic shell call is needless work. The
 * interpreters get one because some questions — parse this file, do this
 * calculation over 10,000 rows — are a few lines of code and an essay of
 * PowerShell.
 */

const MAX_OUTPUT = 30_000;
const MAX_CAPTURE_BYTES = 1_000_000;
const STALE_SCRIPT_DIRECTORY_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_SCRIPT_DIRECTORY_ENTRIES = 256;
const SCRIPT_DIRECTORY_NAME = /^adi-script-[A-Za-z0-9_-]{6}$/;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated]` : s;
}

async function run(cmd: string, args: string[], cwd?: string, timeout = 60_000, signal?: AbortSignal, strict = false): Promise<string> {
  throwIfAborted(signal);
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout,
      maxBuffer: MAX_CAPTURE_BYTES,
      windowsHide: true,
      encoding: 'utf8',
      signal,
    });
    return truncate([stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)');
  } catch (e) {
    throwIfAborted(signal);
    const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const failure = err.killed
      ? `Timed out after ${timeout / 1000}s.`
      : truncate(
          [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim() || 'Command failed.',
        );
    if (strict) throw new Error(failure);
    return failure;
  }
}

/* -------------------------------------------------------------------- git */

export async function gitStatus(repo: string, signal?: AbortSignal): Promise<string> {
  const cwd = resolve(repo);
  const [branch, status] = await Promise.all([
    run('git', ['-c', 'core.quotepath=false', 'status', '-sb'], cwd, undefined, signal),
    run('git', ['-c', 'core.quotepath=false', 'diff', '--stat'], cwd, undefined, signal),
  ]);
  return `${branch}\n\n--- unstaged changes\n${status}`;
}

export async function gitLog(repo: string, count = 15, signal?: AbortSignal): Promise<string> {
  return run(
    'git',
    ['log', `-${Math.max(1, Math.min(100, count))}`, '--pretty=format:%h  %ad  %an  %s', '--date=short'],
    resolve(repo),
    undefined,
    signal,
  );
}

/**
 * @param target  Optional: a path to limit to, or a revision range like
 *                "HEAD~3..HEAD". Empty means the working tree.
 */
export async function gitDiff(repo: string, target = '', staged = false, signal?: AbortSignal): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff'];
  if (staged) args.push('--cached');
  if (target) args.push(target);
  const out = await run('git', args, resolve(repo), undefined, signal);
  return out === '(no output)' ? 'No changes.' : out;
}

export async function gitBranches(repo: string, signal?: AbortSignal): Promise<string> {
  return run(
    'git',
    ['branch', '-a', '--sort=-committerdate', '--format=%(HEAD) %(refname:short)  %(committerdate:relative)'],
    resolve(repo),
    undefined,
    signal,
  );
}

/* ----------------------------------------------------------- interpreters */

/** Removes only old temporary directories that this module creates for snippets. */
export function sweepStaleScriptDirectories(tempDirectory = tmpdir(), now = Date.now()): number {
  const cutoff = (Number.isFinite(now) ? now : Date.now()) - STALE_SCRIPT_DIRECTORY_MAX_AGE_MS;
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(tempDirectory);
  } catch {
    return 0;
  }

  let removed = 0;
  try {
    let scanned = 0;
    while (scanned < MAX_SCRIPT_DIRECTORY_ENTRIES) {
      const entry = directory.readSync();
      if (!entry) break;
      scanned += 1;
      if (!entry.isDirectory() || !SCRIPT_DIRECTORY_NAME.test(entry.name)) continue;
      const target = join(tempDirectory, entry.name);
      try {
        if (statSync(target).mtimeMs > cutoff) continue;
        rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
        if (!existsSync(target)) removed += 1;
      } catch {
        /* A live or locked directory is left for a later sweep. */
      }
    }
  } finally {
    directory.closeSync();
  }
  return removed;
}
/**
 * Runs a snippet through a real interpreter.
 *
 * The script is written to a temp file rather than passed with -c or -e: a
 * command line mangles quotes and newlines, and the failure mode is a syntax
 * error in code that was correct when it was written.
 */
async function runScript(
  code: string,
  ext: string,
  cmd: string,
  cwd?: string,
  signal?: AbortSignal,
  strict = false,
): Promise<string> {
  sweepStaleScriptDirectories();
  const dir = mkdtempSync(join(tmpdir(), 'adi-script-'));
  try {
    const file = join(dir, `snippet${ext}`);
    writeFileSync(file, code, { encoding: 'utf8', mode: 0o600 });
    return await run(cmd, [file], cwd, 120_000, signal, strict);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      /* Best-effort cleanup must not hide the interpreter result. */
    }
  }
}

export async function runPython(code: string, cwd?: string, signal?: AbortSignal): Promise<string> {
  return runScript(code, '.py', 'python', cwd ? resolve(cwd) : undefined, signal);
}

export async function runNode(code: string, cwd?: string, signal?: AbortSignal): Promise<string> {
  return runScript(code, '.mjs', 'node', cwd ? resolve(cwd) : undefined, signal);
}

export async function runPythonStrict(code: string, cwd?: string, signal?: AbortSignal): Promise<string> {
  return runScript(code, '.py', 'python', cwd ? resolve(cwd) : undefined, signal, true);
}

export async function runNodeStrict(code: string, cwd?: string, signal?: AbortSignal): Promise<string> {
  return runScript(code, '.mjs', 'node', cwd ? resolve(cwd) : undefined, signal, true);
}
