import { clipboard, Notification, shell } from 'electron';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NotificationGate } from '../notification-center';
import { throwIfAborted } from '../abort';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 30_000;
const MAX_BUFFER_BYTES = 1_000_000;
const notificationGate = new NotificationGate();

function truncate(value: string): string {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n…[truncated]` : value;
}

/**
 * The parts of Windows that are awkward to reach through a raw shell command:
 * processes, the clipboard, notifications, media keys, and opening things the
 * way a double-click would.
 *
 * These exist so the agent stops writing bespoke PowerShell for jobs it does
 * constantly — every hand-written command is another string for the permission
 * classifier to judge, and a named tool is easier to reason about than a fresh
 * incantation each time.
 */

async function ps(command: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { timeout: 60_000, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true, signal },
  );
  throwIfAborted(signal);
  return truncate([stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)');
}

/* -------------------------------------------------------------- processes */

export async function listProcesses(filter = '', top = 25, signal?: AbortSignal): Promise<string> {
  const where = filter
    ? `| Where-Object { $_.ProcessName -like '*${filter.replace(/'/g, "''")}*' }`
    : '';
  const out = await ps(
    `Get-Process ${where} | Sort-Object WorkingSet64 -Descending | Select-Object -First ${Math.min(
      Math.max(top, 1),
      100,
    )} Id, ProcessName, @{n='MemoryMB';e={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String -Width 200`,
    signal,
  );
  return out || '(no matching processes)';
}

export async function killProcess(target: string, signal?: AbortSignal): Promise<string> {
  const requested = target.trim();
  if (!requested) throw new Error('A process name or PID is required.');
  const byId = /^[1-9]\d*$/.test(requested);
  const t = requested.replace(/'/g, "''");
  const out = await ps(
    byId
      ? `$ErrorActionPreference = 'Stop'
$p = Get-Process -Id ${requested} -ErrorAction Stop
Stop-Process -Id $p.Id -Force -ErrorAction Stop
if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) { throw 'The process is still running.' }
"Stopped PID ${requested}"`
      : `$ErrorActionPreference = 'Stop'
$processes = @(Get-Process -Name '${t}' -ErrorAction Stop)
$ids = @($processes | Select-Object -ExpandProperty Id)
$processes | Stop-Process -Force -ErrorAction Stop
$remaining = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
if ($remaining.Count -gt 0) { throw 'One or more process instances are still running.' }
"Stopped {0} process(es) named {1}" -f $ids.Count, '${t}'`
    , signal
  );
  return out || 'Done.';
}

/* --------------------------------------------------------------- clipboard */

export function readClipboard(signal?: AbortSignal): string {
  throwIfAborted(signal);
  const text = clipboard.readText();
  return text ? text.slice(0, 100_000) : '(clipboard is empty or holds non-text data)';
}

export function writeClipboard(text: string, signal?: AbortSignal): string {
  throwIfAborted(signal);
  clipboard.writeText(text);
  return `Copied ${text.length} characters to the clipboard.`;
}

/* ----------------------------------------------------------- notifications */

export function notify(title: string, body: string, priority = 'normal', cooldownSeconds?: number, signal?: AbortSignal): string {
  throwIfAborted(signal);
  if (!Notification.isSupported()) return 'Notifications are not available on this system.';
  const cleanTitle = title.trim().slice(0, 120);
  const cleanBody = body.trim().slice(0, 400);
  const decision = notificationGate.decide(cleanTitle, cleanBody, priority, cooldownSeconds);
  if (!decision.show) {
    const seconds = Math.max(1, Math.ceil((decision.suppressedForMs ?? 0) / 1000));
    return 'Notification suppressed by cooldown (' + seconds + 's remaining).';
  }
  new Notification({ title: cleanTitle, body: cleanBody }).show();
  return 'Notification shown.';
}

/* ---------------------------------------------------------------- opening */

/**
 * Opens a path the way double-clicking would: a folder in Explorer, a document
 * in its default app, an executable directly.
 */
export async function openPath(target: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const requested = target.trim();
  if (!requested) throw new Error('A path or URL is required to open.');
  if (/^https?:\/\//i.test(requested)) {
    throwIfAborted(signal);
    await shell.openExternal(requested);
    return `Open request sent for ${requested} to your default browser.`;
  }
  throwIfAborted(signal);
  const err = await shell.openPath(requested);
  return err ? `Could not open ${requested}: ${err}` : `Open request sent for ${requested}.`;
}

/** Reveals a file in Explorer with it selected, rather than opening it. */
export function revealPath(target: string, signal?: AbortSignal): string {
  throwIfAborted(signal);
  const requested = target.trim();
  if (!requested) throw new Error('A path is required to reveal in Explorer.');
  if (!existsSync(requested)) throw new Error(`The path to reveal does not exist: ${requested}`);
  try {
    shell.showItemInFolder(requested);
  } catch (error) {
    throw new Error(`Could not reveal ${requested}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `Reveal request sent for ${requested} in Explorer.`;
}

/* ------------------------------------------------------------ media/volume */

const MEDIA_KEYS: Record<string, number> = {
  mute: 173,
  volumedown: 174,
  volumeup: 175,
  next: 176,
  previous: 177,
  stop: 178,
  playpause: 179,
};

/**
 * Media and volume keys. Windows exposes no simple "set volume to 40%" API
 * without a third-party binary, so this presses the same keys a keyboard would
 * — each step is roughly 2%.
 */
export async function mediaKey(key: string, times = 1, signal?: AbortSignal): Promise<string> {
  const requested = key.trim().toLowerCase().replace(/[\s_-]/g, '');
  const code = MEDIA_KEYS[requested];
  if (!code) throw new Error(`Unknown media key "${key}". Try: ${Object.keys(MEDIA_KEYS).join(', ')}.`);
  if (!Number.isFinite(times) || times <= 0) throw new Error('Media-key repeat count must be a finite positive number.');
  const count = Math.min(Math.max(times, 1), 50);
  await ps(
    `$w = New-Object -ComObject WScript.Shell; 1..${count} | ForEach-Object { $w.SendKeys([char]${code}) }`,
    signal,
  );
  return `Sent ${requested} ${count > 1 ? `${count} times` : ''}`.trim();
}

/* -------------------------------------------------------------- windows */

export async function listWindows(signal?: AbortSignal): Promise<string> {
  const out = await ps(
    `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200`,
    signal,
  );
  return out || '(no windows with titles)';
}

/** Brings a window to the front by process name or window title. */
export async function focusWindow(target: string, signal?: AbortSignal): Promise<string> {
  const requested = target.trim();
  if (!requested) throw new Error('A window target is required.');
  const t = requested.replace(/'/g, "''");
  const out = await ps(`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${t}*' -or $_.ProcessName -like '*${t}*' } | Select-Object -First 1
if (-not $p) { throw "No window matching '$t'." }
[Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
$focused = [Win]::SetForegroundWindow($p.MainWindowHandle)
if (-not $focused) { throw "Windows did not accept focus for '$($p.MainWindowTitle)'." }
"Focused: $($p.MainWindowTitle)"`, signal);
  return out || 'Done.';
}
