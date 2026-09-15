import { runFast, runFastStrict } from './pshost';
import { throwIfAborted } from '../abort';
import { WIN32 } from './interop';

/**
 * Where windows are and what they are doing.
 *
 * This is what makes clicking reliable. A coordinate read off a screenshot is
 * only valid until something moves; a coordinate computed from a window's real
 * bounds survives the window being dragged, and tells the agent immediately
 * when the thing it meant to click is not on screen at all.
 */

function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}



/** Every visible window with its position and size. */
export async function listWindowBounds(signal?: AbortSignal): Promise<string> {
  return runFast(`
${WIN32}
$rows = [AdiWin]::List()
if ($rows.Count -eq 0) { 'No visible windows.' }
else {
  "handle    pid         position      size      state title"
  foreach ($r in $rows) { Format-Win $r }
}
`, undefined, signal);
}

/** Where one window is, matched on part of its title. */
export async function windowBounds(title: string, signal?: AbortSignal): Promise<string> {
  return runFast(`
${WIN32}
$h = [AdiWin]::Find(${psLiteral(title)})
if ($h -eq [IntPtr]::Zero) { "No visible window matching ${title.replace(/"/g, '')}." }
else {
  $r = New-Object AdiWin+RECT
  [void][AdiWin]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $t = $r.Bottom - $r.Top
  "'$([AdiWin]::Title($h))'"
  "position: $($r.Left), $($r.Top)"
  "size:     $w x $t"
  "centre:   $($r.Left + [int]($w/2)), $($r.Top + [int]($t/2))"
}
`, undefined, signal);
}

export async function activeWindow(signal?: AbortSignal): Promise<string> {
  return runFast(`
${WIN32}
$h = [AdiWin]::GetForegroundWindow()
$r = New-Object AdiWin+RECT
[void][AdiWin]::GetWindowRect($h, [ref]$r)
$pid2 = 0
[void][AdiWin]::GetWindowThreadProcessId($h, [ref]$pid2)
$proc = try { (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch { 'unknown' }
"'$([AdiWin]::Title($h))'  ($proc, pid $pid2)"
"position: $($r.Left), $($r.Top)   size: $($r.Right - $r.Left) x $($r.Bottom - $r.Top)"
`, undefined, signal);
}

export async function moveWindow(
  title: string,
  x: number,
  y: number,
  width?: number,
  height?: number,
  signal?: AbortSignal
): Promise<string> {
  const requestedTitle = title.trim();
  if (!requestedTitle) throw new Error('A window title is required.');
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Window coordinates must be finite numbers.');
  if (width !== undefined && (!Number.isFinite(width) || width <= 0)) throw new Error('Window width must be a positive finite number.');
  if (height !== undefined && (!Number.isFinite(height) || height <= 0)) throw new Error('Window height must be a positive finite number.');
  const requestedX = Math.round(x);
  const requestedY = Math.round(y);
  const requestedWidth = width === undefined ? undefined : Math.round(width);
  const requestedHeight = height === undefined ? undefined : Math.round(height);
  return runFastStrict(`
${WIN32}
$h = [AdiWin]::Find(${psLiteral(requestedTitle)})
if ($h -eq [IntPtr]::Zero) { throw "No visible window matching '${requestedTitle.replace(/"/g, '')}'." }
$r = New-Object AdiWin+RECT
if (-not [AdiWin]::GetWindowRect($h, [ref]$r)) { throw 'Windows did not return the current window bounds.' }
$w = ${requestedWidth === undefined ? '$r.Right - $r.Left' : requestedWidth}
$t = ${requestedHeight === undefined ? '$r.Bottom - $r.Top' : requestedHeight}
$ok = [AdiWin]::MoveWindow($h, ${requestedX}, ${requestedY}, $w, $t, $true)
if (-not $ok) { throw 'Windows rejected the window move.' }
$after = New-Object AdiWin+RECT
if (-not [AdiWin]::GetWindowRect($h, [ref]$after)) { throw 'Window move could not be read back.' }
if ($after.Left -ne ${requestedX} -or $after.Top -ne ${requestedY} -or ($after.Right - $after.Left) -ne $w -or ($after.Bottom - $after.Top) -ne $t) { throw 'Window move read-back did not match.' }
"Moved '$([AdiWin]::Title($h))' to ${requestedX}, ${requestedY} at $w x $t."
`, undefined, signal);
}

/** minimize | maximize | restore | close | front */
export async function windowState(title: string, state: string, signal?: AbortSignal): Promise<string> {
  const requestedTitle = title.trim();
  const requestedState = state.trim().toLowerCase();
  if (!requestedTitle) throw new Error('A window title is required.');
  const SW: Record<string, number> = { minimize: 6, maximize: 3, restore: 9, hide: 0, show: 5 };
  const cmd = SW[requestedState];

  if (requestedState === 'close') {
    return runFastStrict(`
${WIN32}
$h = [AdiWin]::Find(${psLiteral(requestedTitle)})
if ($h -eq [IntPtr]::Zero) { throw "No visible window matching '${requestedTitle.replace(/"/g, '')}'." }
$name = [AdiWin]::Title($h)
[void][AdiWin]::SendMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
$stillOpen = $true
for ($attempt = 0; $attempt -lt 6; $attempt++) {
  Start-Sleep -Milliseconds 250
  if ([AdiWin]::Find(${psLiteral(requestedTitle)}) -eq [IntPtr]::Zero) { $stillOpen = $false; break }
}
if ($stillOpen) { "Close request sent to '$name'; the window remains visible, likely prompting about unsaved work." }
else { "Closed '$name'." }
`, undefined, signal);
  }

  if (requestedState === 'front') {
    return runFastStrict(`
${WIN32}
$h = [AdiWin]::Find(${psLiteral(requestedTitle)})
if ($h -eq [IntPtr]::Zero) { throw "No visible window matching '${requestedTitle.replace(/"/g, '')}'." }
[void][AdiWin]::ShowWindow($h, 9)
$focused = [AdiWin]::SetForegroundWindow($h)
if (-not $focused) { throw "Windows did not accept focus for '$([AdiWin]::Title($h))'." }
"Focus request sent for '$([AdiWin]::Title($h))'."
`, undefined, signal);
  }

  if (cmd === undefined) {
    throw new Error(`Unknown window state "${state}". Use minimize, maximize, restore, front, or close.`);
  }

  return runFastStrict(`
${WIN32}
$h = [AdiWin]::Find(${psLiteral(requestedTitle)})
if ($h -eq [IntPtr]::Zero) { throw "No visible window matching '${requestedTitle.replace(/"/g, '')}'." }
[void][AdiWin]::ShowWindow($h, ${cmd})
$verified = switch ('${requestedState}') {
  'minimize' { [AdiWin]::IsIconic($h) }
  'maximize' { [AdiWin]::IsZoomed($h) }
  'restore' { -not [AdiWin]::IsIconic($h) -and -not [AdiWin]::IsZoomed($h) }
  'hide' { -not [AdiWin]::IsWindowVisible($h) }
  'show' { [AdiWin]::IsWindowVisible($h) }
  default { $false }
}
if (-not [bool]$verified) { throw "Window state read-back did not match '${requestedState}'." }
"Window state ${requestedState} verified for '$([AdiWin]::Title($h))'."
`, undefined, signal);
}

/* ------------------------------------------------------------ launching */

/**
 * Opens an application by name.
 *
 * Takes what a person would say — "notepad", "chrome", "spotify" — and tries
 * the ways Windows actually resolves that: an app execution alias, something on
 * PATH, then a Start Menu shortcut. open_path is for documents; this is for
 * programs, and it says which one it found rather than failing silently.
 */
export async function openApp(name: string, signal?: AbortSignal): Promise<string> {
  const requestedName = name.trim();
  if (!requestedName) throw new Error('An application name is required.');
  return runFastStrict(`
$requested = ${psLiteral(requestedName)}
$cmd = Get-Command $requested -ErrorAction SilentlyContinue
if ($cmd -and $cmd.Source) {
  $p = Start-Process -FilePath $cmd.Source -PassThru -ErrorAction Stop
  if (-not $p) { throw "Windows did not return a process for '$($cmd.Source)'." }
  "Launch request sent for $($cmd.Source) (PID $($p.Id)). The downstream result is not verified."
  return
}
$roots = @(
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:AppData\\Microsoft\\Windows\\Start Menu\\Programs"
)
$match = Get-ChildItem -Path $roots -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.BaseName -like "*$requested*" } |
  Sort-Object { $_.BaseName.Length } |
  Select-Object -First 1
if ($match) {
  $p = Start-Process -FilePath $match.FullName -PassThru -ErrorAction Stop
  if (-not $p) { throw "Windows did not return a process for '$($match.BaseName)'." }
  "Launch request sent for $($match.BaseName) from the Start Menu (PID $($p.Id)). The downstream result is not verified."
  return
}
throw "Could not find an app called '$requested'. Try installed_apps to see what is here."
`, undefined, signal);
}

/** Closes an application by process name, asking its windows to shut down first. */
export async function closeApp(name: string, force = false, signal?: AbortSignal): Promise<string> {
  const requestedName = name.trim().replace(/\.exe$/i, '');
  if (!requestedName) throw new Error('An application name is required to close.');
  return runFastStrict(`
$ErrorActionPreference = 'Stop'
$name = ${psLiteral(requestedName)}
$procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { "No running process is named '$name'."; return }
$closed = 0
foreach ($p in $procs) {
  if ($p.CloseMainWindow()) { $closed++ }
}
Start-Sleep -Milliseconds 900
$left = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
${force
  ? `if ($left.Count -gt 0) { $left | Stop-Process -Force -ErrorAction Stop; $remaining = @(Get-Process -Name $name -ErrorAction SilentlyContinue); if ($remaining.Count -gt 0) { throw "Process '$name' remained after force-close." }; "Closed $($procs.Count) process(es) named '$name'." } else { "Closed $($procs.Count) process(es) named '$name'." }`
  : `if ($left.Count -gt 0) { "Close request sent to $closed window(s); $($left.Count) process(es) remain, probably prompting about unsaved work." } else { "Closed $($procs.Count) process(es) named '$name'." }`}
`, undefined, signal);
}

/**
 * Waits for a window to appear.
 *
 * Launching something and immediately reaching for it is the commonest way a
 * GUI sequence goes wrong — the app is still starting, so the click lands on
 * whatever was underneath.
 */
export async function waitForWindow(title: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const requestedTitle = title.trim();
  if (!requestedTitle) throw new Error('A window title is required to wait for.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Window wait timeout must be a finite non-negative number.');
  const budget = Math.min(120_000, Math.max(500, Math.round(timeoutMs)));
  return runFastStrict(
    `
${WIN32}
$deadline = (Get-Date).AddMilliseconds(${budget})
while ((Get-Date) -lt $deadline) {
  $h = [AdiWin]::Find(${psLiteral(requestedTitle)})
  if ($h -ne [IntPtr]::Zero) {
    $r = New-Object AdiWin+RECT
    [void][AdiWin]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left; $t = $r.Bottom - $r.Top
    "'$([AdiWin]::Title($h))' appeared."
    "position: $($r.Left), $($r.Top)"
    "size:     $w x $t"
    "centre:   $($r.Left + [int]($w/2)), $($r.Top + [int]($t/2))"
    return
  }
  Start-Sleep -Milliseconds 250
}
"No window matching '${requestedTitle.replace(/'/g, '')}' appeared within ${Math.round(budget / 1000)}s."
`,
    budget + 15_000,
    signal,
  );
}
