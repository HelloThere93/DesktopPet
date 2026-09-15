import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { throwIfAborted } from '../abort';
import { shellFailureMessage } from './pshost';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 30_000;
const TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 1_000_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated]` : s;
}

/**
 * PowerShell writes stdout in the console's legacy codepage, which is not UTF-8
 * on any normal Windows install — so every accent, dash and non-Latin character
 * arrived here as a replacement character. Switching the output encoding first
 * is the whole fix, and it matters well beyond cosmetics: document text, file
 * contents and names all come back through this pipe.
 */
const UTF8_PREFIX = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';

/**
 * Commands are passed as a single argument to the interpreter rather than
 * through a shell, so nothing here re-parses or re-expands the string.
 */
export async function runPowerShell(command: string, cwd?: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        UTF8_PREFIX + command,
      ],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_CAPTURE_BYTES, windowsHide: true, signal },
    );
    return truncate([stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)');
  } catch (e) {
    throwIfAborted(signal);
    const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (err.killed) return `Command timed out after ${TIMEOUT_MS / 1000}s.`;
    return truncate(
      [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim() || 'Command failed.',
    );
  }
}

/**
 * Runs a script that must fail loudly.
 *
 * PowerShell's default is to print an error and carry on, so a script ending in
 * a cheerful "Resized the image" says exactly that even when the file was never
 * found — and the agent then reports success to the user. Anything that writes,
 * converts or changes something goes through here instead, where the first
 * error aborts before the success line is ever reached.
 */
export async function runPowerShellStrict(script: string, cwd?: string, signal?: AbortSignal): Promise<string> {
  const wrapped = `$ErrorActionPreference = 'Stop'
try {
${script}
} catch {
  "FAILED: $($_.Exception.Message)"
}`;
  const out = await runPowerShell(wrapped, cwd, signal);
  const failure = shellFailureMessage(out);
  if (failure) throw new Error(failure);
  return out;
}

export async function runCmd(command: string, cwd?: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  try {
    // Same story as PowerShell: without chcp 65001 the output arrives in the
    // OEM codepage and every non-ASCII character is destroyed on the way here.
    // This fixes what programs print and what `type` reads; a non-ASCII literal
    // typed into the command line itself is still mangled, because cmd parses
    // the line before chcp runs. PowerShell has no such limitation, which is
    // one more reason it is the recommended path.
    const { stdout, stderr } = await execFileAsync(
      'cmd.exe',
      ['/d', '/s', '/c', `chcp 65001>nul & ${command}`],
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_CAPTURE_BYTES,
        windowsHide: true,
        signal,
      },
    );
    return truncate([stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)');
  } catch (e) {
    throwIfAborted(signal);
    const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (err.killed) return `Command timed out after ${TIMEOUT_MS / 1000}s.`;
    return truncate(
      [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim() || 'Command failed.',
    );
  }
}

/** Same command runner, but turns nonzero exits and known failure markers into errors. */
export async function runCmdStrict(command: string, cwd?: string, signal?: AbortSignal): Promise<string> {
  const out = await runCmd(command, cwd, signal);
  const failure = shellFailureMessage(out);
  if (failure) throw new Error(failure);
  return out;
}

/* --------------------------------------------------------------- registry */

export async function registryRead(key: string, name?: string, signal?: AbortSignal): Promise<string> {
  const args = name ? `-Name '${name.replace(/'/g, "''")}'` : '';
  return runPowerShell(
    `Get-ItemProperty -Path '${key.replace(/'/g, "''")}' ${args} | Format-List | Out-String`,
    undefined,
    signal,
  );
}

export async function registryWrite(
  key: string,
  name: string,
  value: string,
  type = 'String',
  signal?: AbortSignal,
): Promise<string> {
  const requestedKey = key.trim();
  const requestedName = name.trim();
  const requestedType = type.trim();
  if (!requestedKey || !requestedName) throw new Error('Registry key and value name are required.');
  const supportedTypes = new Set(['String', 'DWord', 'QWord', 'ExpandString', 'Binary']);
  if (!supportedTypes.has(requestedType)) throw new Error('Unsupported registry value type.');
  const k = requestedKey.replace(/'/g, "''");
  const n = requestedName.replace(/'/g, "''");
  const v = value.replace(/'/g, "''");
  return runPowerShellStrict(
    `if (-not (Test-Path '${k}')) { New-Item -Path '${k}' -Force | Out-Null }; ` +
      `Set-ItemProperty -Path '${k}' -Name '${n}' -Value '${v}' -Type ${requestedType} -ErrorAction Stop; ` +
      `Get-ItemProperty -Path '${k}' -Name '${n}' -ErrorAction Stop | Format-List | Out-String`,
    undefined,
    signal,
  );
}
