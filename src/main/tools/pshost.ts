import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { AUDIO, USER32, WIN32 } from './interop';
import { throwIfAborted, waitWithAbort } from '../abort';

/**
 * One long-lived PowerShell process that every built-in tool talks to.
 *
 * Spawning powershell.exe costs about 130ms before a single line of the script
 * runs, and any tool using P/Invoke or COM paid another 150ms compiling the same
 * C# again — so a click was ~300ms of overhead around 1ms of actual work, and a
 * computer-use loop spent nearly all its time starting processes. Keeping one
 * session alive removes both: the process is already there, and the compiled
 * types stay compiled.
 *
 * Two things this deliberately does not do. It does not run arbitrary scripts —
 * run_powershell and the agent's own tools still get a fresh process each time,
 * because an unknown script may set variables, change directory, hang or call
 * exit, and none of that should leak into the next tool call. And it does not
 * run commands concurrently: one stdin, one stdout, so calls are queued.
 */

const START_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 30_000;

let child: ChildProcessWithoutNullStreams | null = null;
let buffer = '';
let pending: {
  sentinel: string;
  resolve: (out: string) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
} | null = null;

/** Commands are queued, because there is only one pipe to write to. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Interop compiled once, at startup, instead of once per call.
 *
 * These are the same definitions the tools carry inline. The tools keep their
 * `if (-not ('AdiInput' -as [type]))` guard, so they still work in a one-shot
 * process; here the guard simply finds the type already present.
 */
const PRELUDE = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Drawing, System.Windows.Forms | Out-Null',
  USER32,
  WIN32,
  AUDIO,
].join('\n');

function start(): ChildProcessWithoutNullStreams {
  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    // A killed host can deliver buffered bytes after a replacement starts.
    if (child === proc) onData(chunk);
  });
  // stderr is merged into stdout by the wrapper, but the pipe still has to be
  // drained or a noisy command blocks on a full buffer.
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', () => {});
  proc.on('exit', () => {
    // A killed host may finish emitting its exit event after a replacement host
    // has started; it must not reject the replacement host's pending command.
    if (child !== proc) return;
    child = null;
    // Anything waiting will never be answered by a dead process.
    if (pending) {
      clearTimeout(pending.timer);
      const p = pending;
      pending = null;
      p.cleanup();
      p.resolve('FAILED: the PowerShell host exited mid-command.');
    }
  });
  proc.on('error', () => {
    if (child === proc) child = null;
  });

  try {
    proc.stdin.write(PRELUDE + '\n');
  } catch (error) {
    try {
      proc.kill();
    } catch {
      /* already stopped */
    }
    throw error;
  }
  return proc;
}

function onData(chunk: string): void {
  buffer += chunk;
  if (!pending) {
    // Output with nobody waiting for it is prelude noise; keep the tail only.
    if (buffer.length > 4000) buffer = buffer.slice(-1000);
    return;
  }
  const at = buffer.indexOf(pending.sentinel);
  if (at < 0) {
    // Keep the command prefix for the normal output cap and the sentinel tail
    // so a marker split across stdout chunks can still be detected.
    const keepTail = Math.max(1, pending.sentinel.length - 1);
    const maxLiveBuffer = MAX_OUTPUT + pending.sentinel.length;
    if (buffer.length > maxLiveBuffer) {
      buffer = buffer.slice(0, MAX_OUTPUT) + buffer.slice(-keepTail);
    }
    return;
  }

  const output = buffer.slice(0, at);
  buffer = buffer.slice(at + pending.sentinel.length);
  clearTimeout(pending.timer);
  const p = pending;
  pending = null;
  p.cleanup();
  p.resolve(output.trim());
}

function ensure(): ChildProcessWithoutNullStreams {
  if (!child || child.exitCode !== null || child.killed) {
    buffer = '';
    child = start();
  }
  return child;
}

/** Opens the session ahead of the first tool call, so it is warm on arrival. */
export async function warmUp(signal?: AbortSignal): Promise<void> {
  try {
    await runFast('1', START_TIMEOUT_MS, signal);
  } catch {
    /* the next real call will try again */
  }
}

export function shutdownHost(): void {
  const proc = child;
  child = null;
  buffer = '';
  if (pending) {
    clearTimeout(pending.timer);
    const p = pending;
    pending = null;
    p.cleanup();
    p.resolve('FAILED: the PowerShell host was shut down before the command finished.');
  }
  try {
    proc?.kill();
  } catch {
    /* already stopped */
  }
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated]` : s;
}

export function shellFailureMessage(output: string): string | null {
  const clean = output.trim();
  if (/^(?:FAILED:|Command timed out\b|Command failed\b)/i.test(clean)) return clean;
  const hasFailureLine = clean.split(/\r?\n/).some((line) =>
    /^(?:FAILED:|Command timed out\b|Command failed\b)/i.test(line.trim()),
  );
  return hasFailureLine ? clean : null;
}

/**
 * Runs one of our own scripts in the shared session.
 *
 * The script is base64'd and rebuilt into a script block on the other side.
 * That is not obfuscation — it means a multi-line script with quotes, here-
 * strings and braces arrives exactly as written, where feeding it down stdin
 * line by line would have PowerShell trying to execute each line on its own.
 */
export async function runFast(script: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  let started = false;
  let expiredWhileQueued = false;
  const run = async (): Promise<string> => {
    // A call can be cancelled while waiting behind another command. Do not start or replace the host for work that is already stale.
    throwIfAborted(signal);
    if (expiredWhileQueued || Date.now() >= deadline) {
      return 'FAILED: the command did not start within ' + Math.round(timeout / 1000) + 's because the shared PowerShell host was busy.';
    }
    started = true;
    const remainingMs = Math.max(1, deadline - Date.now());
    const proc = ensure();
    const sentinel = `__ADI_${randomBytes(8).toString('hex')}__`;
    const encoded = Buffer.from(script, 'utf8').toString('base64');

    // & { ... } gives the script its own scope, so `return` inside it ends the
    // script rather than the session — the difference between a tool bailing
    // out early and the host dying.
    const line =
      `& { $s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ` +
      `try { & ([ScriptBlock]::Create($s)) } catch { "FAILED: $($_.Exception.Message)" } } ` +
      `*>&1 | Out-String -Width 200; ` +
      `[Console]::Out.Write("${sentinel}")\n`;

    return new Promise<string>((resolve) => {
      let abortHandler: (() => void) = () => {};
      const cleanup = () => signal?.removeEventListener('abort', abortHandler);
      const timer = setTimeout(() => {
        if (pending?.sentinel !== sentinel) return;
        pending = null;
        cleanup();
        // A wedged command owns the pipe forever; the only cure is a new host.
        shutdownHost();
        resolve('FAILED: the command did not finish within its ' + Math.round(timeout / 1000) + 's total queue-and-run budget.');
      }, remainingMs);

      const abort = () => {
        if (pending?.sentinel !== sentinel) return;
        clearTimeout(timer);
        pending = null;
        cleanup();
        shutdownHost();
        resolve('FAILED: the command was cancelled.');
      };
      abortHandler = abort;
      pending = { sentinel, resolve, timer, cleanup };
      signal?.addEventListener('abort', abortHandler, { once: true });
      if (signal?.aborted) abortHandler();

      const fail = (message: string) => {
        if (pending?.sentinel !== sentinel) return;
        clearTimeout(timer);
        pending = null;
        cleanup();
        shutdownHost();
        resolve('FAILED: ' + message + '.');
      };

      if (pending?.sentinel !== sentinel) return;
      try {
        proc.stdin.write(line, (err) => {
          if (err) fail('could not reach the PowerShell host (' + err.message + ')');
        });
      } catch (error) {
        fail('could not reach the PowerShell host (' + (error instanceof Error ? error.message : String(error)) + ')');
      }
    });
  };

  // Queue behind whatever is already running, and never let one rejection
  // poison the chain for everything after it.
  const result = chain.then(run, run);
  chain = result.catch(() => undefined);
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  const queueDeadline = new Promise<string>((resolve) => {
    queueTimer = setTimeout(() => {
      if (started) return;
      expiredWhileQueued = true;
      resolve('FAILED: the command did not start within ' + Math.round(timeout / 1000) + 's because the shared PowerShell host was busy.');
    }, timeout);
  });
  try {
    const out = await waitWithAbort(Promise.race([result, queueDeadline]), signal);
    return truncate(out) || '(no output)';
  } finally {
    if (queueTimer) clearTimeout(queueTimer);
  }
}

/**
 * Same session, but the script must fail loudly.
 *
 * PowerShell's default is to print an error and carry on, so a script ending in
 * "Resized the image" says exactly that when the file was never found.
 */
export async function runFastStrict(script: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  const out = await runFast(
    `$ErrorActionPreference = 'Stop'
${script}`,
    timeoutMs,
    signal,
  );
  const failure = shellFailureMessage(out);
  if (failure) throw new Error(failure);
  return out;
}
