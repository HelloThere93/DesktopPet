import { randomUUID } from 'node:crypto';
import { rename, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { throwIfAborted } from '../abort';
import { isRecord, readBoundedJson } from '../model/response-bounds';
import { runFast, runFastStrict } from './pshost';

/**
 * Diagnostics, devices and the small acts of maintenance that otherwise mean
 * opening five different Windows dialogs.
 *
 * Everything here that only reads is auto-tier; everything that changes the
 * machine goes through the gate like anything else.
 */

function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The model has no clock. Without this it guesses, and it guesses wrong. */
export async function currentTime(signal?: AbortSignal): Promise<string> {
  return runFast(`
$now = Get-Date
$tz = [System.TimeZoneInfo]::Local
"Local:    $($now.ToString('dddd d MMMM yyyy, HH:mm:ss'))"
"Timezone: $($tz.DisplayName)"
"UTC:      $($now.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')) UTC"
"ISO:      $($now.ToString('yyyy-MM-ddTHH:mm:sszzz'))"
# ISOWeek only exists in .NET Core; PowerShell 5.1 runs on the Framework, so
# the week comes from the calendar API that has been there all along.
$cal = [System.Globalization.CultureInfo]::InvariantCulture.Calendar
$week = $cal.GetWeekOfYear($now, [System.Globalization.CalendarWeekRule]::FirstFourDayWeek, [DayOfWeek]::Monday)
"Week:     ISO week $week, day $($now.DayOfYear) of the year"
`, undefined, signal);
}

/** Live CPU load, overall and by process. */
export async function cpuUsage(top = 10, signal?: AbortSignal): Promise<string> {
  return runFast(`
$total = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
"CPU load: $total%"
""
"Busiest processes (CPU seconds used since they started):"
Get-Process | Where-Object { $_.CPU } | Sort-Object CPU -Descending |
  Select-Object -First ${Math.max(1, Math.min(50, top))} |
  Format-Table -AutoSize @{n='CPU(s)';e={[math]::Round($_.CPU,1)}}, @{n='RAM(MB)';e={[math]::Round($_.WorkingSet64/1MB)}}, Id, ProcessName |
  Out-String -Width 120
`, undefined, signal);
}

export async function memoryUsage(top = 10, signal?: AbortSignal): Promise<string> {
  return runFast(`
$os = Get-CimInstance Win32_OperatingSystem
$totalGB = $os.TotalVisibleMemorySize / 1MB
$freeGB = $os.FreePhysicalMemory / 1MB
"Memory: {0:N1} GB used of {1:N1} GB ({2}%)" -f ($totalGB - $freeGB), $totalGB, [math]::Round((1 - $freeGB/$totalGB) * 100)
""
"Largest processes:"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${Math.max(1, Math.min(50, top))} |
  Format-Table -AutoSize @{n='RAM(MB)';e={[math]::Round($_.WorkingSet64/1MB)}}, Id, ProcessName |
  Out-String -Width 120
`, undefined, signal);
}

export async function gpuStatus(signal?: AbortSignal): Promise<string> {
  return runFast(`
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  $q = nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader
  foreach ($line in $q) {
    $f = $line -split ',\\s*'
    "GPU:         $($f[0])"
    "Utilisation: $($f[1])"
    "Memory:      $($f[2]) of $($f[3])"
    "Temperature: $($f[4])C"
    "Power draw:  $($f[5])"
  }
  ""
  "Processes using the GPU:"
  nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
} else {
  Get-CimInstance Win32_VideoController |
    Format-List Name, @{n='VRAM(GB)';e={[math]::Round($_.AdapterRAM/1GB,1)}}, DriverVersion, CurrentHorizontalResolution, CurrentVerticalResolution |
    Out-String
  "(nvidia-smi is not installed, so live utilisation is unavailable)"
}
`, undefined, signal);
}

/** Recent errors and warnings from the event log — the first stop for "why did that break". */
export async function eventLog(hours = 24, level = 'error', signal?: AbortSignal): Promise<string> {
  const levels = level.toLowerCase() === 'warning' ? '2,3' : '1,2';
  return runFast(`
$since = (Get-Date).AddHours(-${Math.max(1, Math.min(720, hours))})
try {
  Get-WinEvent -FilterHashtable @{ LogName='System','Application'; Level=${levels}; StartTime=$since } -MaxEvents 40 -ErrorAction Stop |
    ForEach-Object {
      "{0:HH:mm}  {1,-11} {2}" -f $_.TimeCreated, $_.ProviderName.Substring(0, [Math]::Min(11, $_.ProviderName.Length)), ($_.Message -split [char]10)[0]
    }
} catch {
  "Nothing logged at that level in the last ${hours} hours."
}
`, undefined, signal);
}

/* ------------------------------------------------------------- networking */

export async function pingHost(host: string, count = 4, signal?: AbortSignal): Promise<string> {
  return runFast(`
$r = Test-Connection -ComputerName ${psLiteral(host)} -Count ${Math.max(1, Math.min(10, count))} -ErrorAction SilentlyContinue
if (-not $r) { "No reply from ${host.replace(/"/g, '')} — it may be down, or blocking ping."; return }
$times = $r | ForEach-Object { if ($_.Latency -ne $null) { $_.Latency } else { $_.ResponseTime } }
"Replies from ${host.replace(/"/g, '')}: $($times.Count) of ${Math.max(1, Math.min(10, count))}"
"Round trip: min $(($times | Measure-Object -Minimum).Minimum)ms, avg $([math]::Round(($times | Measure-Object -Average).Average))ms, max $(($times | Measure-Object -Maximum).Maximum)ms"
`, undefined, signal);
}

export async function dnsLookup(name: string, signal?: AbortSignal): Promise<string> {
  return runFast(
    `Resolve-DnsName ${psLiteral(name)} -ErrorAction SilentlyContinue |
       Format-Table -AutoSize Name, Type, TTL, IPAddress, NameHost | Out-String -Width 160`, undefined, signal
  );
}

export async function portCheck(host: string, port: number, signal?: AbortSignal): Promise<string> {
  return runFast(`
$r = Test-NetConnection -ComputerName ${psLiteral(host)} -Port ${Math.round(port)} -WarningAction SilentlyContinue
if ($r.TcpTestSucceeded) { "${host.replace(/"/g, '')}:${Math.round(port)} is open (reached $($r.RemoteAddress))." }
else { "${host.replace(/"/g, '')}:${Math.round(port)} is closed or filtered." }
`, undefined, signal);
}

export async function networkConnections(filter = '', signal?: AbortSignal): Promise<string> {
  const where = filter
    ? `| Where-Object { $_.Process -like '*${filter.replace(/'/g, "''")}*' }`
    : '';
  return runFast(`
Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
  Select-Object -First 60 @{n='Process';e={ try { (Get-Process -Id $_.OwningProcess -ErrorAction Stop).ProcessName } catch { $_.OwningProcess } }},
    RemoteAddress, RemotePort, LocalPort ${where} |
  Sort-Object Process |
  Format-Table -AutoSize | Out-String -Width 140
`, undefined, signal);
}

export async function flushDns(signal?: AbortSignal): Promise<string> {
  return runFastStrict('Clear-DnsClientCache -ErrorAction Stop; "DNS resolver cache clear request completed."', undefined, signal);
}

/* ---------------------------------------------------------------- devices */

export async function listDevices(filter = '', signal?: AbortSignal): Promise<string> {
  const where = filter
    ? `| Where-Object { $_.FriendlyName -like '*${filter.replace(/'/g, "''")}*' -or $_.Class -like '*${filter.replace(/'/g, "''")}*' }`
    : "| Where-Object { $_.Class -in 'USB','Bluetooth','Media','Camera','Monitor','Mouse','Keyboard','Net','DiskDrive' }";
  return runFast(`
Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue ${where} |
  Sort-Object Class, FriendlyName |
  Format-Table -AutoSize Status, Class, FriendlyName | Out-String -Width 160
`, undefined, signal);
}

export async function listPrinters(signal?: AbortSignal): Promise<string> {
  return runFast(`
Get-Printer -ErrorAction SilentlyContinue |
  Format-Table -AutoSize Name, DriverName, PortName, @{n='Default';e={$_.Name -eq (Get-CimInstance Win32_Printer | Where-Object Default).Name}} |
  Out-String -Width 160
"--- queue"
Get-Printer -ErrorAction SilentlyContinue | ForEach-Object {
  $jobs = Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue
  if ($jobs) { "$($_.Name): $($jobs.Count) job(s) waiting" }
}
`, undefined, signal);
}

export async function printFile(path: string, printer = '', signal?: AbortSignal): Promise<string> {
  const requestedPath = path.trim();
  const requestedPrinter = printer.trim();
  if (!requestedPath) throw new Error('A file path is required for printing.');
  const printerLiteral = requestedPrinter ? psLiteral(requestedPrinter) : '$null';
  return runFastStrict(`
$f = Get-Item ${psLiteral(requestedPath)} -ErrorAction Stop
$printerName = ${printerLiteral}
if ($null -ne $printerName) {
  $printer = Get-Printer -Name $printerName -ErrorAction Stop
  Start-Process -FilePath $f.FullName -Verb PrintTo -ArgumentList $printer.Name -ErrorAction Stop | Out-Null
  "Print request submitted for $($f.Name) to '$($printer.Name)'. Queue acceptance is not verified."
} else {
  Start-Process -FilePath $f.FullName -Verb Print -ErrorAction Stop | Out-Null
  "Print request submitted for $($f.Name) via the default printer. Queue acceptance is not verified."
}
`, undefined, signal);
}

/* ------------------------------------------------------------ maintenance */

export async function restartExplorer(signal?: AbortSignal): Promise<string> {
  return runFastStrict(`
$existing = @(Get-Process -Name explorer -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) { $existing | Stop-Process -Force -ErrorAction Stop }
Start-Sleep -Milliseconds 800
Start-Process -FilePath explorer.exe -ErrorAction Stop | Out-Null
$verified = $false
for ($attempt = 0; $attempt -lt 8; $attempt++) {
  Start-Sleep -Milliseconds 250
  if (Get-Process -Name explorer -ErrorAction SilentlyContinue) { $verified = $true; break }
}
if (-not $verified) { throw 'Explorer did not return after the restart request.' }
"Explorer restart completed; a new Explorer process is running. Existing windows may have closed."
`, undefined, signal);
}

export async function defenderStatus(signal?: AbortSignal): Promise<string> {
  return runFast(`
try {
  $s = Get-MpComputerStatus -ErrorAction Stop
  "Real-time protection: $($s.RealTimeProtectionEnabled)"
  "Antivirus enabled:    $($s.AntivirusEnabled)"
  "Signatures:           $($s.AntivirusSignatureVersion), updated $($s.AntivirusSignatureLastUpdated)"
  "Last quick scan:      $($s.QuickScanStartTime)"
  ""
  $t = Get-MpThreatDetection -ErrorAction SilentlyContinue | Select-Object -First 5
  if ($t) { "Recent detections:"; $t | Format-Table -AutoSize InitialDetectionTime, ThreatID, ActionSuccess | Out-String }
  else { "No recent threat detections." }
} catch { "Windows Defender status is unavailable: $($_.Exception.Message)" }
`, undefined, signal);
}

export async function windowsUpdateStatus(signal?: AbortSignal): Promise<string> {
  return runFast(`
"Recently installed updates:"
Get-HotFix -ErrorAction SilentlyContinue | Sort-Object InstalledOn -Descending | Select-Object -First 10 |
  Format-Table -AutoSize HotFixID, Description, InstalledOn | Out-String
try {
  $s = New-Object -ComObject Microsoft.Update.AutoUpdate
  "Last search:  $($s.Results.LastSearchSuccessDate)"
  "Last install: $($s.Results.LastInstallationSuccessDate)"
} catch { }
`, undefined, signal);
}

/**
 * A restore point, which is the sensible thing to make before changing
 * anything structural. Needs administrator rights and System Protection on, so
 * it says which one is missing rather than failing silently.
 */
export async function createRestorePoint(description: string, signal?: AbortSignal): Promise<string> {
  const requested = description.trim();
  if (!requested) throw new Error('A restore-point description is required.');
  return runFastStrict(`
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Creating a restore point needs administrator rights, and Adi is not running elevated.' }
Checkpoint-Computer -Description ${psLiteral(requested)} -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
"Restore point created: {0}" -f ${psLiteral(requested)}
`, undefined, signal);
}

/* ------------------------------------------------------------ recycle bin */

export async function listRecycleBin(limit = 40, signal?: AbortSignal): Promise<string> {
  return runFast(`
$shell = New-Object -ComObject Shell.Application
$items = $shell.Namespace(10).Items()
if ($items.Count -eq 0) { 'The recycle bin is empty.'; return }
"$($items.Count) item(s) in the recycle bin:"
$n = 0
foreach ($i in $items) {
  $n++
  if ($n -gt ${Math.max(1, Math.min(200, limit))}) { "…and $($items.Count - ${Math.max(1, Math.min(200, limit))}) more"; break }
  "{0,3}. {1}  (from {2}, deleted {3})" -f $n, $i.Name, $shell.Namespace(10).GetDetailsOf($i, 1), $shell.Namespace(10).GetDetailsOf($i, 2)
}
`, undefined, signal);
}

/**
 * Puts something back where it came from.
 *
 * The counterpart to delete_item's recycle-by-default: deleting is reversible
 * only if something can actually reverse it, and until now nothing could.
 */
export async function restoreFromRecycleBin(name: string, signal?: AbortSignal): Promise<string> {
  const requested = name.trim();
  if (!requested) throw new Error('A recycle-bin item name is required.');
  return runFastStrict(`
$shell = New-Object -ComObject Shell.Application
$items = $shell.Namespace(10).Items()
$requested = ${psLiteral(requested)}
$candidates = @($items | Where-Object {
  [string]::Equals([string]$_.Name, $requested, [System.StringComparison]::OrdinalIgnoreCase)
})
if ($candidates.Count -eq 0) { throw "No recycle-bin item is named '$requested'." }
if ($candidates.Count -gt 1) { throw "Restore refused: multiple recycle-bin items are named '$requested'." }
$match = $candidates[0]
$verb = $null
foreach ($v in $match.Verbs()) { if ($v.Name -replace '&','' -eq 'Restore') { $verb = $v; break } }
if (-not $verb) { throw "Windows did not offer a Restore action for $($match.Name)." }
$matchName = [string]$match.Name
$verb.DoIt()
$verified = $false
for ($attempt = 0; $attempt -lt 5; $attempt++) {
  Start-Sleep -Milliseconds 250
  $remaining = @($shell.Namespace(10).Items() | Where-Object {
    [string]::Equals([string]$_.Name, $matchName, [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($remaining.Count -eq 0) { $verified = $true; break }
}
if (-not $verified) { throw "Restore could not be verified for '$matchName'." }
"Restored $matchName to its original location."
`, undefined, signal);
}

/* --------------------------------------------------------------- desktop */

export async function setWallpaper(path: string, signal?: AbortSignal): Promise<string> {
  const requestedPath = path.trim();
  if (!requestedPath) throw new Error('A wallpaper path is required.');
  return runFastStrict(`
$sig = @'
using System.Runtime.InteropServices;
public class AdiWall {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int SystemParametersInfo(int a, int u, string p, int w);
}
'@
if (-not ('AdiWall' -as [type])) { Add-Type -TypeDefinition $sig }
$f = Get-Item ${psLiteral(requestedPath)} -ErrorAction Stop
$result = [AdiWall]::SystemParametersInfo(20, 0, $f.FullName, 3)
if ($result -eq 0) { throw 'Windows did not accept the wallpaper change.' }
"Wallpaper set to $($f.Name)."
`, undefined, signal);
}

export async function createShortcut(
  target: string,
  shortcutPath: string,
  args = '',
  signal?: AbortSignal
): Promise<string> {
  const requestedTarget = target.trim();
  const requestedShortcutPath = shortcutPath.trim();
  if (!requestedTarget) throw new Error('A shortcut target is required.');
  if (!requestedShortcutPath) throw new Error('A shortcut path is required.');
  throwIfAborted(signal);

  const output = resolve(
    /\.lnk$/i.test(requestedShortcutPath) ? requestedShortcutPath : `${requestedShortcutPath}.lnk`,
  );
  const staging = `${output}.${randomUUID()}.tmp.lnk`;

  try {
    await runFastStrict(`
$ws = New-Object -ComObject WScript.Shell
$path = ${psLiteral(staging)}
$sc = $ws.CreateShortcut($path)
$sc.TargetPath = ${psLiteral(requestedTarget)}
${args ? '$sc.Arguments = ' + psLiteral(args) : ''}
$sc.Save()
$created = Get-Item $path -ErrorAction Stop
if ($created.PSIsContainer -or $created.Length -le 0) { throw 'The shortcut output was not a non-empty file.' }
"Created shortcut $path -> ${requestedTarget.replace(/"/g, '')}"
`, undefined, signal);

    const created = await stat(staging);
    if (!created.isFile() || created.size <= 0) throw new Error('The shortcut output was not a non-empty file.');
    throwIfAborted(signal);
    await rename(staging, output);
    const written = await stat(output);
    if (!written.isFile() || written.size !== created.size) throw new Error('Shortcut output verification failed.');
    throwIfAborted(signal);
    return `Created shortcut ${output} -> ${requestedTarget.replace(/"/g, '')}`;
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}

export async function openWith(path: string, program: string, signal?: AbortSignal): Promise<string> {
  const requestedPath = path.trim();
  const requestedProgram = program.trim();
  if (!requestedPath) throw new Error('A file path is required to launch a program.');
  if (!requestedProgram) throw new Error('A program path is required.');
  return runFastStrict(`
$f = Get-Item ${psLiteral(requestedPath)} -ErrorAction Stop
$programName = ${psLiteral(requestedProgram)}
$p = Start-Process -FilePath $programName -ArgumentList @($f.FullName) -PassThru -ErrorAction Stop
if ($p) {
  "Launch requested for $($f.FullName) with $programName (PID $($p.Id)). The downstream result is not verified."
} else {
  "Launch requested for $($f.FullName) with $programName. The downstream result is not verified."
}
`, undefined, signal);
}

/* ----------------------------------------------------------------- sound */

/**
 * Offline text to speech, separate from the realtime voice.
 *
 * The realtime socket is for conversation; this is for a pet that can say "your
 * build finished" without opening a network connection at all.
 */
export async function speakText(text: string, rate = 0, signal?: AbortSignal): Promise<string> {
  return runFastStrict(`
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = ${Math.max(-10, Math.min(10, Math.round(rate)))}
$s.Speak(${psLiteral(text)})
$s.Dispose()
"Said it."
`, undefined, signal);
}

export async function playSound(sound: string, signal?: AbortSignal): Promise<string> {
  const named: Record<string, string> = {
    beep: '[console]::beep(800, 200)',
    asterisk: '[System.Media.SystemSounds]::Asterisk.Play()',
    exclamation: '[System.Media.SystemSounds]::Exclamation.Play()',
    hand: '[System.Media.SystemSounds]::Hand.Play()',
    question: '[System.Media.SystemSounds]::Question.Play()',
  };
  const key = sound.toLowerCase();
  if (named[key]) {
    return runFastStrict(
      `Add-Type -AssemblyName System.Windows.Forms\n${named[key]}\nStart-Sleep -Milliseconds 400\n"Played ${key}."`, undefined, signal
    );
  }
  // Anything else is treated as a path to a .wav.
  return runFast(`
$p = ${psLiteral(sound)}
if (-not (Test-Path $p)) { "No sound named '${sound.replace(/"/g, '')}' and no file at that path. Try beep, asterisk, exclamation, hand or question."; return }
(New-Object System.Media.SoundPlayer $p).PlaySync()
"Played $p."
`, undefined, signal);
}

/* --------------------------------------------------------------- version */

export async function publicIp(signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const res = await fetch('https://api.ipify.org?format=json', {
    signal: requestSignal,
  });
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      /* preserve the diagnostic failure if cleanup is unavailable */
    }
    throw new Error(`Lookup failed: ${res.status}`);
  }
  const body = await readBoundedJson(res, 4_000, requestSignal);
  const ip = isRecord(body) && typeof body.ip === 'string' ? body.ip.slice(0, 100) : 'unknown';
  return `Public IP: ${ip}`;
}
