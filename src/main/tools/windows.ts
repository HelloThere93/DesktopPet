import { randomUUID } from 'node:crypto';
import { rename, rm, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { throwIfAborted } from '../abort';
import { runFast, runFastStrict } from './pshost';
import { AUDIO } from './interop';
import { isSensitiveName, redactSecrets } from '../redaction';

/**
 * The rest of the machine: hardware, services, startup, packages, power.
 *
 * All of it is reachable through run_powershell already — the point of naming
 * these is that a named tool states its intent to the user approving it, and
 * the agent stops having to remember the incantation. The read-only ones are
 * auto-tier precisely because they are read-only.
 */

function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const MAX_ARCHIVE_INPUT_BYTES = 50_000_000;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_ENTRY_BYTES = 50_000_000;
const MAX_ARCHIVE_OUTPUT_BYTES = 200_000_000;
export async function systemInfo(signal?: AbortSignal): Promise<string> {
  // Win32_Processor alone took 1.2 seconds of this tool's 1.4 — it wakes a WMI
  // provider that interrogates the CPU. The same two facts sit in the registry
  // and an environment variable, where they cost nothing.
  return runFast(`
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpuName = (Get-ItemProperty 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0' -ErrorAction SilentlyContinue).ProcessorNameString
$gpu = Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name
$up = (Get-Date) - $os.LastBootUpTime
"Computer:  $($cs.Name)  ($($cs.Manufacturer) $($cs.Model))"
"OS:        $($os.Caption) build $($os.BuildNumber)"
"CPU:       $(if ($cpuName) { $cpuName.Trim() } else { 'unknown' })  ($env:NUMBER_OF_PROCESSORS logical processors)"
"GPU:       $($gpu -join ', ')"
"Memory:    {0:N1} GB total, {1:N1} GB free" -f ($cs.TotalPhysicalMemory/1GB), ($os.FreePhysicalMemory/1MB)
"Uptime:    $([int]$up.TotalDays)d $($up.Hours)h $($up.Minutes)m"
"User:      $env:USERNAME"
`, undefined, signal);
}

export async function diskUsage(signal?: AbortSignal): Promise<string> {
  return runFast(`
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $pct = if ($_.Size) { [math]::Round(($_.Size - $_.FreeSpace) / $_.Size * 100) } else { 0 }
  "{0}  {1,7:N1} GB free of {2,7:N1} GB  ({3}% used)  {4}" -f $_.DeviceID, ($_.FreeSpace/1GB), ($_.Size/1GB), $pct, $_.VolumeName
}
`, undefined, signal);
}

export async function networkInfo(signal?: AbortSignal): Promise<string> {
  return runFast(`
"--- adapters"
Get-NetAdapter | Where-Object Status -eq 'Up' |
  Format-Table -AutoSize Name, InterfaceDescription, LinkSpeed | Out-String
"--- addresses"
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' } |
  Format-Table -AutoSize InterfaceAlias, IPAddress, PrefixOrigin | Out-String
"--- wi-fi"
try { (netsh wlan show interfaces | Select-String 'SSID|Signal|State') -join [char]10 } catch { 'no wireless adapter' }
`, undefined, signal);
}

export async function listServices(filter = '', signal?: AbortSignal): Promise<string> {
  const where = filter
    ? `| Where-Object { $_.Name -like '*${filter.replace(/'/g, "''")}*' -or $_.DisplayName -like '*${filter.replace(/'/g, "''")}*' }`
    : '| Where-Object Status -eq Running';
  return runFast(
    `Get-Service ${where} | Sort-Object DisplayName |
       Format-Table -AutoSize Status, Name, DisplayName | Out-String -Width 200`, undefined, signal
  );
}

export async function serviceControl(name: string, action: string, signal?: AbortSignal): Promise<string> {
  const serviceName = name.trim();
  const requestedAction = action.trim().toLowerCase();
  const verbs: Record<string, string> = { start: 'Start-Service', stop: 'Stop-Service', restart: 'Restart-Service' };
  const verb = verbs[requestedAction];
  if (!serviceName) throw new Error('A service name is required.');
  if (!verb) throw new Error('Unsupported service action. Use start, stop, or restart.');
  const expectedStatus = requestedAction === 'stop' ? 'Stopped' : 'Running';
  return runFastStrict(`
$service = Get-Service -Name ${psLiteral(serviceName)} -ErrorAction Stop
${verb} -Name ${psLiteral(serviceName)} -ErrorAction Stop
$after = Get-Service -Name ${psLiteral(serviceName)} -ErrorAction Stop
if ([string]$after.Status -ne '${expectedStatus}') { throw 'Service did not reach the expected state.' }
$after | Format-List Status, Name, DisplayName | Out-String
  `, undefined, signal);
}

export async function listStartupApps(signal?: AbortSignal): Promise<string> {
  return runFast(`
Get-CimInstance Win32_StartupCommand |
  Format-Table -AutoSize Name, Location, Command | Out-String -Width 250
`, undefined, signal);
}

export async function installedApps(filter = '', signal?: AbortSignal): Promise<string> {
  const clause = filter
    ? `$_.DisplayName -and $_.DisplayName -like '*${filter.replace(/'/g, "''")}*'`
    : '$_.DisplayName';
  return runFast(`
$keys = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $keys -ErrorAction SilentlyContinue |
  Where-Object { ${clause} } |
  Sort-Object DisplayName -Unique |
  Format-Table -AutoSize DisplayName, DisplayVersion, Publisher | Out-String -Width 200
`, undefined, signal);
}

export async function listScheduledTasks(filter = '', signal?: AbortSignal): Promise<string> {
  const where = filter
    ? `| Where-Object { $_.TaskName -like '*${filter.replace(/'/g, "''")}*' }`
    : "| Where-Object { $_.State -ne 'Disabled' -and $_.TaskPath -notlike '\\Microsoft\\*' }";
  return runFast(
    `Get-ScheduledTask ${where} |
       Format-Table -AutoSize State, TaskName, TaskPath | Out-String -Width 200`, undefined, signal
  );
}

export async function batteryStatus(signal?: AbortSignal): Promise<string> {
  return runFast(`
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
if (-not $b) { 'No battery — this machine runs on mains power.' }
else {
  $states = @{1='discharging';2='on mains';3='fully charged';4='low';5='critical';6='charging';7='charging (high)';8='charging (low)';9='charging (critical)'}
  "Charge: $($b.EstimatedChargeRemaining)%  ($($states[[int]$b.BatteryStatus]))"
  if ($b.EstimatedRunTime -and $b.EstimatedRunTime -lt 71582788) { "Estimated runtime: $($b.EstimatedRunTime) minutes" }
}
`, undefined, signal);
}

/** Interop for the endpoint volume, so a level can be set rather than nudged. */


export async function getVolume(signal?: AbortSignal): Promise<string> {
  return runFast(
    `${AUDIO}
"Volume is $([math]::Round([AdiAudio]::Get() * 100))%$(if ([AdiAudio]::GetMute()) { ' (muted)' })"`, undefined, signal
  );
}

export async function setVolume(percent: number, mute?: boolean, signal?: AbortSignal): Promise<string> {
  const hasLevel = Number.isFinite(percent);
  if (!hasLevel && mute === undefined) throw new Error('A volume percentage or mute value is required.');
  if (hasLevel && (percent < 0 || percent > 100)) throw new Error('Volume percentage must be between 0 and 100.');
  const level = hasLevel ? Math.round(percent) / 100 : 0;
  const setLine = hasLevel ? `[AdiAudio]::Set(${level})` : '';
  const muteLine = mute === undefined ? '' : `[AdiAudio]::SetMute($${mute ? 'true' : 'false'})`;
  const verifyLevel = hasLevel ? `if ([math]::Abs([AdiAudio]::Get() - ${level}) -gt 0.02) { throw 'Volume read-back did not match.' }` : '';
  const verifyMute = mute === undefined ? '' : `if ([AdiAudio]::GetMute() -ne $${mute ? 'true' : 'false'}) { throw 'Mute state read-back did not match.' }`;
  return runFastStrict(
    `${AUDIO}
${setLine}
${muteLine}
${verifyLevel}
${verifyMute}
"Volume is now $([math]::Round([AdiAudio]::Get() * 100))%$(if ([AdiAudio]::GetMute()) { ' (muted)' })"`, undefined, signal
  );
}

export async function setBrightness(percent: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('Brightness percentage must be between 0 and 100.');
  }
  const p = Math.round(percent);
  return runFastStrict(`
$methods = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop
$methods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Brightness = ${p}; Timeout = 1 } -ErrorAction Stop | Out-Null
$state = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop
if ([int]$state.CurrentBrightness -ne ${p}) { throw 'Brightness read-back did not match.' }
"Brightness set to ${p}%."
`, undefined, signal);
}

export async function powerAction(action: string, signal?: AbortSignal): Promise<string> {
  const requested = action.trim().toLowerCase();
  switch (requested) {
    case 'lock':
      return runFastStrict('rundll32.exe user32.dll,LockWorkStation; "Workstation locked."', undefined, signal);
    case 'sleep':
      return runFastStrict(
        'Add-Type -AssemblyName System.Windows.Forms; ' +
          '[System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false); "Sleeping."', undefined, signal
      );
    case 'screen-off':
      return runFastStrict(
        '(Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);\' ' +
          '-Name Scr -Namespace AdiPwr -PassThru)::SendMessage(-1, 0x0112, 0xF170, 2); "Display off."', undefined, signal
      );
    default:
      throw new Error('Unknown power action. Use lock, sleep, or screen-off.');
  }
}

export async function envVars(name = '', signal?: AbortSignal): Promise<string> {
  if (name && isSensitiveName(name)) return `${name}=[REDACTED]`;
  if (name) {
    return runFast(
      `$v = [Environment]::GetEnvironmentVariable(${psLiteral(name)});
       if ($null -eq $v) { "{0} is not set." -f ${psLiteral(name)} } else { "{0}={1}" -f ${psLiteral(name)}, $v }`, undefined, signal
    ).then(redactSecrets);
  }
  return runFast('Get-ChildItem Env: | Sort-Object Name | ForEach-Object { "{0}={1}" -f $_.Name, $_.Value }', undefined, signal).then(redactSecrets);
}

export async function setEnvVar(name: string, value: string, scope = 'User', signal?: AbortSignal): Promise<string> {
  const requestedName = name.trim();
  if (!requestedName) throw new Error('An environment variable name is required.');
  if (!['User', 'Machine'].includes(scope)) throw new Error('Environment scope must be User or Machine.');
  return runFastStrict(`
[Environment]::SetEnvironmentVariable(${psLiteral(requestedName)}, ${psLiteral(value)}, ${psLiteral(scope)})
$actual = [Environment]::GetEnvironmentVariable(${psLiteral(requestedName)}, ${psLiteral(scope)})
if ([string]$actual -ne [string]${psLiteral(value)}) { throw 'The environment variable did not retain the requested value.' }
"Set {0} variable {1}. New shells will see it; existing ones will not." -f ${psLiteral(scope)}, ${psLiteral(requestedName)}
  `, undefined, signal);
}

export async function wingetSearch(query: string, signal?: AbortSignal): Promise<string> {
  return runFast(
    `winget search --query ${psLiteral(query)} --accept-source-agreements | Out-String -Width 200`, undefined, signal
  );
}

export async function wingetInstall(id: string, signal?: AbortSignal): Promise<string> {
  const requestedId = id.trim();
  if (!requestedId) throw new Error('A package id is required.');
  return runFastStrict(`
$lines = @(& winget install --id ${psLiteral(requestedId)} --silent --accept-package-agreements --accept-source-agreements 2>&1)
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) { throw "winget install failed with exit code $exitCode." }
$lines | Out-String -Width 200
"winget install completed for {0}." -f ${psLiteral(requestedId)}
`, 120_000, signal);
}

export async function compressPath(source: string, destination: string, signal?: AbortSignal): Promise<string> {
  const requestedSource = source.trim();
  const requestedDestination = destination.trim();
  if (!requestedSource) throw new Error('An archive source path is required.');
  if (!requestedDestination) throw new Error('An archive destination path is required.');

  const output = resolve(requestedDestination);
  const staging = `${output}.${randomUUID()}.tmp.zip`;
  try {
    await runFastStrict(`
$sourceItem = Get-Item ${psLiteral(requestedSource)} -ErrorAction Stop
Compress-Archive -Path $sourceItem.FullName -DestinationPath ${psLiteral(staging)} -Force -ErrorAction Stop
$archive = Get-Item ${psLiteral(staging)} -ErrorAction Stop
if ($archive.PSIsContainer -or $archive.Length -le 0) { throw 'The archive output was not a non-empty file.' }
`, 120_000, signal);

    const staged = await stat(staging);
    if (!staged.isFile() || staged.size <= 0) throw new Error('The archive output was not a non-empty file.');
    throwIfAborted(signal);
    await rename(staging, output);
    const written = await stat(output);
    if (!written.isFile() || written.size !== staged.size) throw new Error('Archive output verification failed.');
    throwIfAborted(signal);
    return `Compressed to ${output} (${(written.size / 1_048_576).toFixed(1)} MB).`;
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}
export async function extractArchive(archive: string, destination: string, signal?: AbortSignal): Promise<string> {
  const requestedArchive = archive.trim();
  const requestedDestination = destination.trim();
  if (!requestedArchive) throw new Error('An archive path is required.');
  if (!requestedDestination) throw new Error('An extraction destination path is required.');

  const output = resolve(requestedDestination);
  let destinationExists = false;
  try {
    await stat(output);
    destinationExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const staging = destinationExists ? output : `${output}.${randomUUID()}.tmp.extract`;
  let ownsStaging = !destinationExists;
  try {
    const result = await runFastStrict(`
$archive = Get-Item ${psLiteral(requestedArchive)} -ErrorAction Stop
if ($archive.PSIsContainer) { throw 'The extraction source must be a file.' }
if ($archive.Length -gt ${MAX_ARCHIVE_INPUT_BYTES}) { throw "The archive exceeds the ${MAX_ARCHIVE_INPUT_BYTES}-byte input safety limit." }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [System.IO.Path]::GetFullPath(${psLiteral(staging)})
$root = $root.TrimEnd([char]92, [char]47)
$prefix = $root + [char]92
$zip = $null
try {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive.FullName)
  if ($zip.Entries.Count -gt ${MAX_ARCHIVE_ENTRIES}) { throw "The archive contains more than ${MAX_ARCHIVE_ENTRIES} entries." }
  [int64]$expanded = 0
  foreach ($entry in $zip.Entries) {
    if ($entry.Length -gt ${MAX_ARCHIVE_ENTRY_BYTES}) { throw "Archive entry '$($entry.FullName)' exceeds the ${MAX_ARCHIVE_ENTRY_BYTES}-byte expanded-entry limit." }
    $expanded += [int64]$entry.Length
    if ($expanded -gt ${MAX_ARCHIVE_OUTPUT_BYTES}) { throw "The archive expands beyond the ${MAX_ARCHIVE_OUTPUT_BYTES}-byte output safety limit." }
    $target = [System.IO.Path]::GetFullPath((Join-Path -Path $root -ChildPath $entry.FullName))
    if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Archive entry '$($entry.FullName)' would leave the extraction destination."
    }
  }
} finally {
  if ($zip) { $zip.Dispose() }
}
Expand-Archive -Path $archive.FullName -DestinationPath $root -Force -ErrorAction Stop
$folder = Get-Item $root -ErrorAction Stop
if (-not $folder.PSIsContainer) { throw 'The extraction destination is not a directory.' }
"Extracted to $($folder.FullName)."
Get-ChildItem $folder.FullName | Select-Object -First 30 -ExpandProperty Name
`, 120_000, signal);

    if (destinationExists) return result;
    const extracted = await stat(staging);
    if (!extracted.isDirectory()) throw new Error('The extraction destination is not a directory.');
    throwIfAborted(signal);
    await rename(staging, output);
    ownsStaging = false;
    const committed = await stat(output);
    if (!committed.isDirectory()) throw new Error('The extraction destination is not a directory.');
    throwIfAborted(signal);
    return result.replaceAll(staging, output);
  } finally {
    if (ownsStaging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}