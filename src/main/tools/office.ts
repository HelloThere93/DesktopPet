import { throwIfAborted } from '../abort';
import { runFastStrict } from './pshost';
import { MAX_DOCUMENT_INPUT_BYTES, verifyInputFile } from './file-bounds';

/**
 * Reads Word, PowerPoint and Excel files without Office installed.
 *
 * All three formats are zip archives of XML, so the text is reachable by
 * unpacking the one part that holds it and stripping the markup — no COM
 * automation, no launching Word in the background, and it works on files the
 * user only has locally. read_google_doc covers the same job for anything
 * living in Drive.
 */

function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Shared preamble: open the archive and pull one entry out as text. */
const MAX_OFFICE_ENTRY_BYTES = 25_000_000;
const MAX_OFFICE_RESULT_CHARS = 200_000;
const MAX_OFFICE_ENTRIES = 500;
const MAX_OFFICE_SHARED_STRINGS = 10_000;
const MAX_OFFICE_ROWS = 10_000;
const ZIP_HELPERS = `Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-EntryText($zip, $name, $maxBytes) {
  $e = $zip.Entries | Where-Object { $_.FullName -eq $name } | Select-Object -First 1
  if (-not $e) { return '' }
  if ($e.Length -gt $maxBytes) {
    throw "Office archive entry '$name' exceeds the $maxBytes-byte safety limit."
  }
  $r = New-Object System.IO.StreamReader($e.Open())
  $t = $r.ReadToEnd()
  $r.Close()
  return $t
}
function Get-LimitedEntries($zip, $pattern, $maxEntries) {
  $list = New-Object 'System.Collections.Generic.List[object]'
  foreach ($entry in $zip.Entries) {
    if ($entry.FullName -match $pattern) {
      [void]$list.Add($entry)
      if ($list.Count -ge $maxEntries) { break }
    }
  }
  return $list
}
function Add-BoundedText($out, $text, $maxChars, [ref]$used, [ref]$truncated) {
  if ($truncated.Value -or $null -eq $text) { return }
  $separator = if ($out.Count -gt 0) { [char]10 } else { '' }
  $available = $maxChars - $used.Value - $separator.Length
  if ($available -le 0) {
    $truncated.Value = $true
    return
  }
  if ($text.Length -gt $available) {
    [void]$out.Add($separator + $text.Substring(0, $available))
    $used.Value = $maxChars
    $truncated.Value = $true
    return
  }
  [void]$out.Add($separator + $text)
  $used.Value += $separator.Length + $text.Length
}
function Strip-Xml($xml) {
  $t = [System.Text.RegularExpressions.Regex]::Replace($xml, '<[^>]+>', '')
  return [System.Net.WebUtility]::HtmlDecode($t)
}
function Limit-OfficeText($text, $maxChars) {
  if ($null -eq $text) { return '' }
  if ($text.Length -gt $maxChars) { return $text.Substring(0, $maxChars) + [char]10 + '…[truncated]' }
  return $text
}`;

/**
 * @param path  A .docx, .pptx or .xlsx file. Older .doc/.ppt/.xls are a
 *              different, binary format and are not readable this way.
 */
export async function readDocument(path: string, signal?: AbortSignal): Promise<string> {
  const lower = path.toLowerCase();
  const isZipOffice = /\.(docx|pptx|xlsx)$/.test(lower);
  const input = isZipOffice
    ? await verifyInputFile(path, MAX_DOCUMENT_INPUT_BYTES, 'Office document', signal)
    : undefined;
  throwIfAborted(signal);
  const p = psLiteral(input?.abs ?? path);

  if (lower.endsWith('.docx')) {
    return runFastStrict(`
${ZIP_HELPERS}
$zip = [System.IO.Compression.ZipFile]::OpenRead(${p})
$xml = Get-EntryText $zip 'word/document.xml' ${MAX_OFFICE_ENTRY_BYTES}
$zip.Dispose()
if (-not $xml) { 'Could not find the document body — is this really a .docx?'; return }
$xml = $xml -replace '<w:tab[^>]*/>', [char]9
$xml = $xml -replace '<w:br[^>]*/>', [char]10
$xml = $xml -replace '</w:p>', [char]10
Limit-OfficeText ((Strip-Xml $xml).Trim()) ${MAX_OFFICE_RESULT_CHARS}
`, 60_000, signal);
  }

  if (lower.endsWith('.pptx')) {
    return runFastStrict(`
${ZIP_HELPERS}
$zip = [System.IO.Compression.ZipFile]::OpenRead(${p})
$slides = @(Get-LimitedEntries $zip '^ppt/slides/slide[0-9]+\.xml$' ${MAX_OFFICE_ENTRIES} |
  Sort-Object { [int]([regex]::Match($_.FullName, '[0-9]+').Value) })
$out = New-Object 'System.Collections.Generic.List[string]'
$outChars = 0
$outTruncated = $false
$n = 0
foreach ($s in $slides) {
  $n++
  $xml = Get-EntryText $zip $s.FullName ${MAX_OFFICE_ENTRY_BYTES}
  $xml = $xml -replace '</a:p>', [char]10
  $text = (Strip-Xml $xml).Trim()
  Add-BoundedText $out ('--- Slide ' + $n + [char]10 + $text) ${MAX_OFFICE_RESULT_CHARS} ([ref]$outChars) ([ref]$outTruncated)
  if ($outTruncated) { break }
}
$zip.Dispose()
if ($out.Count -eq 0) { 'No slides found — is this really a .pptx?'; return }
$result = $out -join ''
if ($outTruncated) { $result += [char]10 + '…[truncated]' }
Limit-OfficeText $result ${MAX_OFFICE_RESULT_CHARS}
`, 60_000, signal);
  }
  if (lower.endsWith('.xlsx')) {
    return runFastStrict(`
${ZIP_HELPERS}
$zip = [System.IO.Compression.ZipFile]::OpenRead(${p})
$sharedXml = Get-EntryText $zip 'xl/sharedStrings.xml' ${MAX_OFFICE_ENTRY_BYTES}
$shared = New-Object 'System.Collections.Generic.List[string]'
if ($sharedXml) {
  $sharedMatches = [regex]::Matches($sharedXml, '(?s)<si>(.*?)</si>')
  $sharedLimit = [Math]::Min($sharedMatches.Count, ${MAX_OFFICE_SHARED_STRINGS})
  for ($i = 0; $i -lt $sharedLimit; $i++) {
    [void]$shared.Add((Strip-Xml $sharedMatches[$i].Groups[1].Value).Trim())
  }
}
$sheets = @(Get-LimitedEntries $zip '^xl/worksheets/sheet[0-9]+\.xml$' ${MAX_OFFICE_ENTRIES} |
  Sort-Object { [int]([regex]::Match($_.FullName, '[0-9]+').Value) })
$out = New-Object 'System.Collections.Generic.List[string]'
$outChars = 0
$outTruncated = $false
$rowCount = 0
foreach ($sheet in $sheets) {
  Add-BoundedText $out ('--- ' + $sheet.FullName) ${MAX_OFFICE_RESULT_CHARS} ([ref]$outChars) ([ref]$outTruncated)
  if ($outTruncated) { break }
  $xml = Get-EntryText $zip $sheet.FullName ${MAX_OFFICE_ENTRY_BYTES}
  foreach ($row in [regex]::Matches($xml, '(?s)<row[^>]*>(.*?)</row>')) {
    $rowCount++
    if ($rowCount -gt ${MAX_OFFICE_ROWS}) {
      $outTruncated = $true
      break
    }
    $cells = foreach ($c in [regex]::Matches($row.Groups[1].Value, '(?s)<c[^>]*>.*?</c>|<c[^>]*/>')) {
      $raw = $c.Value
      $v = [regex]::Match($raw, '(?s)<v>(.*?)</v>').Groups[1].Value
      if ($raw -match 't="s"') {
        $i = [int]$v
        if ($i -lt $shared.Count) { $shared[$i] } else { '' }
      } elseif ($raw -match 't="inlineStr"') {
        (Strip-Xml ([regex]::Match($raw, '(?s)<is>(.*?)</is>').Groups[1].Value)).Trim()
      } else { $v }
    }
    $line = ($cells -join [char]9).Trim()
    if ($line) {
      Add-BoundedText $out $line ${MAX_OFFICE_RESULT_CHARS} ([ref]$outChars) ([ref]$outTruncated)
    }
    if ($outTruncated) { break }
  }
  if ($outTruncated) { break }
}
$zip.Dispose()
if ($out.Count -eq 0) { 'No rows found — is this really a .xlsx?'; return }
$result = $out -join ''
if ($outTruncated) { $result += [char]10 + '…[truncated]' }
Limit-OfficeText $result ${MAX_OFFICE_RESULT_CHARS}
`, 60_000, signal);
  }
  if (/\.(doc|ppt|xls)$/.test(lower)) {
    return (
      `${path} is in the old binary Office format, which is not readable this way. ` +
      'Open it and save it as .docx/.pptx/.xlsx, or read it in Google Drive with read_google_doc.'
    );
  }

  return `${path} is not an Office file. Use read_file for text, or read_google_doc for Drive links.`;
}
