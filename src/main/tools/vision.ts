import { desktopCapturer, clipboard, nativeImage, screen as electronScreen } from 'electron';
import { randomUUID } from 'node:crypto';
import { rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { throwIfAborted } from '../abort';
import { readBoundedBufferFile } from '../bounded-file';
import { normaliseImageDataUrl } from '../attachments';
import { MAX_IMAGE_INPUT_BYTES, verifyInputFile } from './file-bounds';
import { WIN32 } from './interop';
import { runFastStrict } from './pshost';

/**
 * Everything to do with pictures: reading them, cropping the screen down to the
 * part that matters, and pulling text out without spending a vision round trip.
 */

function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function runImageMutation(
  destination: string,
  buildScript: (staging: string) => string,
  signal?: AbortSignal,
): Promise<string> {
  const output = resolve(destination);
  const staging = `${output}.${randomUUID()}.tmp`;
  try {
    const result = await runFastStrict(buildScript(staging), 60_000, signal);
    const staged = await stat(staging);
    if (!staged.isFile() || staged.size <= 0) throw new Error(`Image output was not a non-empty file: ${output}`);
    throwIfAborted(signal);
    await rename(staging, output);
    const written = await stat(output);
    if (!written.isFile() || written.size !== staged.size) throw new Error(`Image output verification failed: ${output}`);
    throwIfAborted(signal);
    return result.replaceAll(staging, output);
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** Width the model actually sees. Beyond this is tokens spent on nothing. */
const MODEL_WIDTH = 1280;
const MAX_CAPTURE_PIXELS = 12_000_000;

export interface ImageResult {
  text: string;
  dataUrls: string[];
}

type NativeImageValue = ReturnType<typeof nativeImage.createFromBuffer>;

function fitForModel(image: NativeImageValue): NativeImageValue {
  const size = image.getSize();
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= MODEL_WIDTH) return image;
  const scale = MODEL_WIDTH / longEdge;
  return image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  });
}

function safeImageDataUrls(image: NativeImageValue): string[] {
  const dataUrl = normaliseImageDataUrl(image.toDataURL());
  return dataUrl ? [dataUrl] : [];
}

function previewNote(dataUrls: string[]): string {
  return dataUrls.length ? '' : '\n[image preview omitted because its encoded output exceeded the safety limit.]';
}

/**
 * Loads an image file so the model can look at it.
 *
 * Until now it could only see the screen and what the user attached — a picture
 * sitting on disk was a path it could describe but not read.
 */
export async function viewImage(path: string, signal?: AbortSignal): Promise<ImageResult> {
  const input = await verifyInputFile(path, MAX_IMAGE_INPUT_BYTES, 'Image', signal);
  const abs = input.abs;
  const ext = extname(abs).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new Error(`${abs} is not an image this can read (${Object.keys(IMAGE_MIME).join(', ')}).`);
  }

  const bounded = await readBoundedBufferFile(abs, MAX_IMAGE_INPUT_BYTES, signal);
  if (bounded.truncated) throw new Error(abs + ' exceeded the ' + MAX_IMAGE_INPUT_BYTES.toLocaleString() + '-byte image limit while it was being read.');
  const buf = bounded.data;
  throwIfAborted(signal);
  const image = nativeImage.createFromBuffer(buf);
  if (image.isEmpty()) throw new Error(`${abs} could not be decoded as an image.`);

  const size = image.getSize();
  // Downscale for the model, but say what the real dimensions were.
  const shown = fitForModel(image);
  const dataUrls = safeImageDataUrls(shown);

  return {
    text: `${abs}\n${size.width}x${size.height}, ${(buf.length / 1024).toFixed(1)} KB${previewNote(dataUrls)}`,
    dataUrls,
  };
}

/**
 * Captures one rectangle of the screen rather than the whole thing.
 *
 * A full 4K screenshot spends most of its tokens on wallpaper. When the agent
 * already knows roughly where to look — from window_bounds, or from a previous
 * capture — this is both cheaper and sharper, because nothing is scaled down.
 */
export async function captureRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<ImageResult> {
  throwIfAborted(signal);
  if (![x, y, width, height].every(Number.isFinite)) throw new Error('Capture coordinates and dimensions must be finite numbers.');
  if (width <= 0 || height <= 0) throw new Error('Capture dimensions must be positive.');
  const displays = electronScreen.getAllDisplays();
  const primary = electronScreen.getPrimaryDisplay();

  // Capture at full device resolution, then crop in the same coordinate space
  // the caller is using — which is the DPI-independent one Windows reports.
  const scale = primary.scaleFactor || 1;
  const requestedWidth = Math.max(1, Math.round(width));
  const requestedHeight = Math.max(1, Math.round(height));
  if (requestedWidth * requestedHeight * scale * scale > MAX_CAPTURE_PIXELS) {
    throw new Error(`Capture region is too large; keep it below ${MAX_CAPTURE_PIXELS.toLocaleString()} pixels.`);
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(primary.size.width * scale),
      height: Math.round(primary.size.height * scale),
    },
  });
  throwIfAborted(signal);
  const source = sources[0];
  if (!source) throw new Error('No screen sources available.');

  const full = source.thumbnail;
  const cropped = full.crop({
    x: Math.max(0, Math.round(x * scale)),
    y: Math.max(0, Math.round(y * scale)),
    width: Math.max(1, Math.round(requestedWidth * scale)),
    height: Math.max(1, Math.round(requestedHeight * scale)),
  });
  if (cropped.isEmpty()) {
    throw new Error(
      `That region is off screen. The primary display is ${primary.size.width}x${primary.size.height}` +
        (displays.length > 1 ? `, and there are ${displays.length} displays.` : '.'),
    );
  }

  const shown = fitForModel(cropped);
  const dataUrls = safeImageDataUrls(shown);
  return {
    text: `Region ${Math.round(x)},${Math.round(y)} ${requestedWidth}x${requestedHeight} of the primary display.${previewNote(dataUrls)}`,
    dataUrls,
  };
}

/**
 * Reads an image out of the clipboard.
 *
 * Windows' own Shift+Win+S screenshot goes to the clipboard and nowhere else,
 * so this is the natural way to hand something over: snip it, then ask.
 */
export function clipboardImage(signal?: AbortSignal): ImageResult {
  throwIfAborted(signal);
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    const text = clipboard.readText().trim();
    throw new Error(
      text
        ? 'The clipboard holds text, not an image. Use read_clipboard for that.'
        : 'The clipboard is empty.',
    );
  }
  const size = image.getSize();
  const shown = fitForModel(image);
  const dataUrls = safeImageDataUrls(shown);
  return {
    text: `Clipboard image, ${size.width}x${size.height}.${previewNote(dataUrls)}`,
    dataUrls,
  };
}

/**
 * Windows' built-in OCR, via WinRT.
 *
 * Reading text off a picture with the vision model works but costs a round trip
 * and a lot of tokens, and it paraphrases. This returns the literal characters,
 * which is what you want for an error message, a serial number or a wall of
 * text in a screenshot.
 *
 * PowerShell 5.1 cannot await a WinRT IAsyncOperation on its own, hence the
 * reflected AsTask below — that is the whole trick, and without it every call
 * returns an unresolved operation object.
 */
export async function ocrImage(path: string, signal?: AbortSignal): Promise<string> {
  const input = await verifyInputFile(path, MAX_IMAGE_INPUT_BYTES, 'Image', signal);
  return runFastStrict(`
$ErrorActionPreference = 'Stop'
try {
  [void][System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime')
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]

  function Await($op, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    [void]$task.Wait(-1)
    $task.Result
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync(${psLiteral(input.abs)})) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { 'No OCR language pack is installed for your Windows display languages.'; return }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = $result.Lines | ForEach-Object { $_.Text }
  if (-not $lines) { '(no text found in the image)' } else { $lines -join [char]10 }
} catch {
  throw "OCR failed: $($_.Exception.Message)"
}
`, 60_000, signal);
}

/* --------------------------------------------------------- image handling */

export async function imageInfo(path: string, signal?: AbortSignal): Promise<string> {
  const input = await verifyInputFile(path, MAX_IMAGE_INPUT_BYTES, 'Image', signal);
  return runFastStrict(`
Add-Type -AssemblyName System.Drawing
$f = Get-Item ${psLiteral(input.abs)}
$img = [System.Drawing.Image]::FromFile($f.FullName)
$f.FullName
"{0} x {1} px, {2:N1} KB, {3}, {4} dpi" -f $img.Width, $img.Height, ($f.Length/1KB), $img.PixelFormat, [int]$img.HorizontalResolution
$img.Dispose()
`, 60_000, signal);
}

/**
 * @param maxWidth  The long edge to fit within; the aspect ratio is kept, and
 *                  an image already smaller than this is left alone.
 */
export async function resizeImage(
  source: string,
  destination: string,
  maxWidth: number,
  signal?: AbortSignal,
): Promise<string> {
  const requestedSource = source.trim();
  const requestedDestination = destination.trim();
  if (!requestedSource) throw new Error('An image source path is required.');
  if (!requestedDestination) throw new Error('An image destination path is required.');
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) throw new Error('Maximum image width must be a finite positive number.');
  const requestedMaxWidth = Math.round(maxWidth);
  const input = await verifyInputFile(requestedSource, MAX_IMAGE_INPUT_BYTES, 'Image', signal);
  return runImageMutation(
    requestedDestination,
    (staging) => `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${psLiteral(input.abs)})
$sourceWidth = $src.Width
$sourceHeight = $src.Height
$w = [Math]::Min([int]${requestedMaxWidth}, $src.Width)
$h = [int]($src.Height * ($w / $src.Width))
$out = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($out)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $w, $h)
$g.Dispose()
$out.Save(${psLiteral(staging)})
$out.Dispose(); $src.Dispose()
$written = Get-Item ${psLiteral(staging)} -ErrorAction Stop
if ($written.PSIsContainer -or $written.Length -le 0) { throw 'The resized image output was not a non-empty file.' }
"Resized $($sourceWidth)x$($sourceHeight) to $($w)x$($h): $($written.FullName)"
`,
    signal,
  );
}
/** Converts between png, jpg, bmp and gif by re-encoding. */
export async function convertImage(source: string, destination: string, signal?: AbortSignal): Promise<string> {
  const requestedSource = source.trim();
  const requestedDestination = destination.trim();
  if (!requestedSource) throw new Error('An image source path is required.');
  if (!requestedDestination) throw new Error('An image destination path is required.');
  const ext = extname(requestedDestination).toLowerCase().replace('.', '');
  const format = { png: 'Png', jpg: 'Jpeg', jpeg: 'Jpeg', bmp: 'Bmp', gif: 'Gif', tiff: 'Tiff' }[ext];
  if (!format) throw new Error('Image destination must use png, jpg, jpeg, bmp, gif, or tiff.');
  const input = await verifyInputFile(requestedSource, MAX_IMAGE_INPUT_BYTES, 'Image', signal);
  return runImageMutation(
    requestedDestination,
    (staging) => `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${psLiteral(input.abs)})
$src.Save(${psLiteral(staging)}, [System.Drawing.Imaging.ImageFormat]::${format})
$src.Dispose()
$written = Get-Item ${psLiteral(staging)} -ErrorAction Stop
if ($written.PSIsContainer -or $written.Length -le 0) { throw 'The converted image output was not a non-empty file.' }
"Wrote ${format} to $($written.FullName)"
`,
    signal,
  );
}
/** Crops a rectangle out of an image file. */
export async function cropImage(
  source: string,
  destination: string,
  x: number,
  y: number,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<string> {
  const requestedSource = source.trim();
  const requestedDestination = destination.trim();
  if (!requestedSource) throw new Error('An image source path is required.');
  if (!requestedDestination) throw new Error('An image destination path is required.');
  if (![x, y, width, height].every(Number.isFinite)) throw new Error('Crop coordinates and dimensions must be finite numbers.');
  if (x < 0 || y < 0) throw new Error('Crop coordinates must be non-negative.');
  if (width <= 0 || height <= 0) throw new Error('Crop dimensions must be positive.');
  const requestedX = Math.round(x);
  const requestedY = Math.round(y);
  const requestedWidth = Math.round(width);
  const requestedHeight = Math.round(height);
  if (requestedWidth <= 0 || requestedHeight <= 0) throw new Error('Crop dimensions must round to at least one pixel.');
  const input = await verifyInputFile(requestedSource, MAX_IMAGE_INPUT_BYTES, 'Image', signal);
  return runImageMutation(
    requestedDestination,
    (staging) => `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${psLiteral(input.abs)})
$rect = New-Object System.Drawing.Rectangle ${requestedX}, ${requestedY}, ${requestedWidth}, ${requestedHeight}
if ($rect.Right -gt $src.Width -or $rect.Bottom -gt $src.Height) {
  $src.Dispose(); throw "That rectangle falls outside the image, which is $($src.Width)x$($src.Height)."
}
$out = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
$g = [System.Drawing.Graphics]::FromImage($out)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $rect.Width, $rect.Height), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$out.Save(${psLiteral(staging)})
$out.Dispose(); $src.Dispose()
$written = Get-Item ${psLiteral(staging)} -ErrorAction Stop
if ($written.PSIsContainer -or $written.Length -le 0) { throw 'The cropped image output was not a non-empty file.' }
"Cropped to $($written.FullName)"
`,
    signal,
  );
}
/* ------------------------------------------------------ finding things */

/** Shared preamble: load WinRT and give PowerShell 5.1 a way to await it. */
const OCR_PRELUDE = `
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime')
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
if (-not $global:AdiAsTask) {
  $global:AdiAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
}
function Await($op, $type) {
  $task = $global:AdiAsTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(-1)
  $task.Result
}
function Get-OcrResult($path) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { return $null }
  return Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
}
`;

/**
 * Finds text on screen and says where to click it.
 *
 * This is the piece that turns "look at the screen" into "use the screen".
 * Reading a screenshot tells the model what a button says; it does not reliably
 * tell it where that button is, because estimating a pixel coordinate from an
 * image is exactly the thing vision models are worst at. Windows' OCR engine
 * returns a bounding box per word, which is an actual measurement.
 *
 * Words are joined into lines first, so a search for "Sign in" matches even
 * though OCR sees two separate words.
 */
export async function findOnScreen(text: string, signal?: AbortSignal): Promise<string> {
  const needle = text.trim();
  if (!needle) throw new Error('Nothing to look for.');
  const shot = join(tmpdir(), `adi-find-${randomUUID()}.png`);

  try {
    return await runFastStrict(
    `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save(${psLiteral(shot)}, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

${OCR_PRELUDE}

  $result = Get-OcrResult ${psLiteral(shot)}
  if (-not $result) { 'No OCR language pack is installed for your Windows display languages.'; return }

  $needle = ${psLiteral(needle.toLowerCase())}
  $hits = New-Object System.Collections.Generic.List[string]

  foreach ($line in $result.Lines) {
    $lineText = $line.Text
    if ($lineText.ToLower().Contains($needle)) {
      # Bound the whole line, then also the words that carry the match, so a
      # long line does not put the click point somewhere unrelated.
      $words = @($line.Words | Where-Object { $needle.Contains($_.Text.ToLower()) -or $_.Text.ToLower().Contains($needle) })
      if ($words.Count -eq 0) { $words = @($line.Words) }
      $left = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
      $top = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
      $right = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
      $bottom = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
      $cx = [int]($b.X + ($left + $right) / 2)
      $cy = [int]($b.Y + ($top + $bottom) / 2)
      $hits.Add(("click {0}, {1}   [{2},{3} {4}x{5}]   {6}" -f $cx, $cy, [int]($b.X + $left), [int]($b.Y + $top), [int]($right - $left), [int]($bottom - $top), $lineText))
    }
  }

  Remove-Item ${psLiteral(shot)} -ErrorAction SilentlyContinue

  if ($hits.Count -eq 0) {
    "No text matching '${needle.replace(/'/g, '')}' is on screen right now."
    "Lines the screen does show:"
    ($result.Lines | Select-Object -First 25 | ForEach-Object { '  ' + $_.Text }) -join [char]10
  } else {
    "$($hits.Count) match(es) for '${needle.replace(/'/g, '')}':"
    $hits -join [char]10
  }
} catch {
  Remove-Item ${psLiteral(shot)} -ErrorAction SilentlyContinue
  throw "Search failed: $($_.Exception.Message)"
}
`,
    60_000,
      signal,
    );
  } finally {
    await unlink(shot).catch(() => undefined);
  }
}

/** Every line of text currently on screen, with where each one is. */
export async function readScreenText(signal?: AbortSignal): Promise<string> {
  const shot = join(tmpdir(), `adi-screentext-${randomUUID()}.png`);
  try {
    return await runFastStrict(
    `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save(${psLiteral(shot)}, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

${OCR_PRELUDE}

  $result = Get-OcrResult ${psLiteral(shot)}
  Remove-Item ${psLiteral(shot)} -ErrorAction SilentlyContinue
  if (-not $result) { 'No OCR language pack is installed.'; return }
  if (-not $result.Lines) { '(no text found on screen)'; return }

  foreach ($line in $result.Lines) {
    $w = @($line.Words)
    if ($w.Count -eq 0) { continue }
    $left = ($w | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
    $top = ($w | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
    "{0,5},{1,-5}  {2}" -f [int]($b.X + $left), [int]($b.Y + $top), $line.Text
  }
} catch {
  Remove-Item ${psLiteral(shot)} -ErrorAction SilentlyContinue
  throw "Reading the screen failed: $($_.Exception.Message)"
}
`,
    60_000,
      signal,
    );
  } finally {
    await unlink(shot).catch(() => undefined);
  }
}

/**
 * Photographs one window rather than the whole desktop.
 *
 * Cleaner than working out a region by hand from window_bounds, and it follows
 * the window if it has moved since the last look.
 */
export async function captureWindow(title: string, signal?: AbortSignal): Promise<ImageResult> {
  throwIfAborted(signal);
  const shot = join(tmpdir(), `adi-window-${randomUUID()}.png`);
  const out = await runFastStrict(`
${WIN32}
$ErrorActionPreference = 'Stop'
$h = [AdiWin]::Find(${psLiteral(title)})
if ($h -eq [IntPtr]::Zero) { [pscustomobject]@{ status = 'not_found' } | ConvertTo-Json -Compress; return }
$r = New-Object AdiWin+RECT
[void][AdiWin]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $t = $r.Bottom - $r.Top
if ($w -lt 1 -or $t -lt 1) { [pscustomobject]@{ status = 'not_found' } | ConvertTo-Json -Compress; return }
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $t
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save(${psLiteral(shot)}, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[pscustomobject]@{ status = 'ok'; title = [AdiWin]::Title($h); left = $r.Left; top = $r.Top; width = $w; height = $t } | ConvertTo-Json -Compress
`, 15_000, signal).catch(async (error) => {
  await unlink(shot).catch(() => undefined);
  throw error;
});

  const metadata = parseWindowCaptureMetadata(out);
  if (!metadata) {
    await unlink(shot).catch(() => undefined);
    throw new Error(`No visible window matching "${title}".`);
  }
  try {
    const input = await verifyInputFile(shot, MAX_IMAGE_INPUT_BYTES, 'Captured image', signal);
    const bounded = await readBoundedBufferFile(input.abs, MAX_IMAGE_INPUT_BYTES, signal);
    if (bounded.truncated) throw new Error(input.abs + ' exceeded the ' + MAX_IMAGE_INPUT_BYTES.toLocaleString() + '-byte image limit while it was being read.');
    const buf = bounded.data;
    throwIfAborted(signal);
    const image = nativeImage.createFromBuffer(buf);
    if (image.isEmpty()) throw new Error('The window could not be captured.');
    const shown = fitForModel(image);
    const dataUrls = safeImageDataUrls(shown);
    return {
      text: `'${metadata.title}' at ${metadata.left}, ${metadata.top}  (${metadata.width}x${metadata.height})${previewNote(dataUrls)}`,
      dataUrls,
    };
  } finally {
    await unlink(shot).catch(() => undefined);
  }
}

export interface WindowCaptureMetadata {
  title: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function parseWindowCaptureMetadata(value: string): WindowCaptureMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '').trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const left = Number(record.left);
    const top = Number(record.top);
    const width = Number(record.width);
    const height = Number(record.height);
    if (
      record.status !== 'ok' || typeof record.title !== 'string' ||
      !Number.isSafeInteger(left) || !Number.isSafeInteger(top) ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 100_000 || height > 100_000
    ) return undefined;
    return { title: record.title.slice(0, 1_000), left, top, width, height };
  } catch {
    return undefined;
  }
}
