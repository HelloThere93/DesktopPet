import { randomUUID } from 'node:crypto';
import { desktopCapturer, screen as electronScreen, app } from 'electron';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { throwIfAborted } from '../abort';
import { normaliseImageDataUrl } from '../attachments';
import { getSettings } from '../db';
import { MAX_IMAGE_INPUT_BYTES } from './file-bounds';

/**
 * Captures the desktop so the model can answer "what's on my screen?".
 *
 * The image is both written to disk (so the user keeps it) and returned as a
 * data URL, which the agent attaches to the conversation as real visual input —
 * a file path alone would tell the model nothing about the contents.
 */

/** Width the model actually sees; the saved file keeps full resolution. */
const MODEL_IMAGE_WIDTH = 1280;
export const MAX_SCREENSHOT_FILE_BYTES = MAX_IMAGE_INPUT_BYTES;

export function assertScreenshotBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SCREENSHOT_FILE_BYTES) {
    throw new Error('Screenshot output exceeded the ' + MAX_SCREENSHOT_FILE_BYTES.toLocaleString() + '-byte safety limit.');
  }
}

export function screenshotDir(): string {
  const configured = getSettings().screenshotDir;
  if (configured && configured.trim()) return resolve(configured);
  return join(app.getPath('pictures'), 'AdiPet');
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(
    d.getMinutes(),
  )}-${p(d.getSeconds())}`;
}

export interface Capture {
  path: string;
  dataUrl: string;
  label: string;
}
async function writeVerifiedScreenshot(path: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  let owned = false;
  try {
    const handle = await open(path, 'wx');
    owned = true;
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close().catch(() => undefined);
    }
    throwIfAborted(signal);
    const written = await stat(path);
    if (!written.isFile() || written.size !== bytes.length) {
      throw new Error(`Screen capture output could not be verified: ${path}`);
    }
  } catch (error) {
    if (owned) await unlink(path).catch(() => undefined);
    throw error;
  }
}


/**
 * @param which  'primary', 'all', or a 1-based display index as a string.
 */
export async function captureScreen(which = 'primary', signal?: AbortSignal): Promise<Capture[]> {
  throwIfAborted(signal);
  const requestedWhich = which.trim().toLowerCase();
  if (requestedWhich !== 'primary' && requestedWhich !== 'all' && !/^\d+$/.test(requestedWhich)) {
    throw new Error('Screen selection must be primary, all, or a positive display index.');
  }
  const displays = electronScreen.getAllDisplays();
  if (!displays.length) throw new Error('Windows reported no available displays.');
  // Ask for thumbnails at full resolution; the default is a tiny preview.
  const maxW = Math.max(...displays.map((d) => d.size.width * d.scaleFactor));
  const maxH = Math.max(...displays.map((d) => d.size.height * d.scaleFactor));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH },
  });
  throwIfAborted(signal);
  if (!sources.length) throw new Error('No screen sources available.');

  let chosen = sources;
  if (requestedWhich !== 'all') {
    const index = requestedWhich === 'primary' ? 1 : Number.parseInt(requestedWhich, 10);
    if (!Number.isSafeInteger(index) || index < 1 || index > sources.length) {
      throw new Error(`No captured screen matches display index ${requestedWhich === 'primary' ? '1' : index}.`);
    }
    const source = sources[index - 1];
    if (!source) throw new Error(`No captured screen matches display index ${index}.`);
    chosen = [source];
  }

  const dir = screenshotDir();
  await mkdir(dir, { recursive: true });

  const out: Capture[] = [];
  const captureId = randomUUID().slice(0, 8);
  for (const [i, src] of chosen.entries()) {
    throwIfAborted(signal);
    const png = src.thumbnail.toPNG();
    assertScreenshotBytes(png.length);
    const path = join(dir, `screen_${stamp()}_${captureId}${chosen.length > 1 ? `_${i + 1}` : ''}.png`);
    // Keep the full-resolution capture on disk for the user...
    await writeVerifiedScreenshot(path, png, signal);

    // ...but send the model a downscaled copy. A 1920px PNG is ~340KB of
    // base64, which is a lot of tokens for no extra legibility.
    const size = src.thumbnail.getSize();
    const longEdge = Math.max(size.width, size.height);
    const scale = longEdge > MODEL_IMAGE_WIDTH ? MODEL_IMAGE_WIDTH / longEdge : 1;
    const forModel =
      scale < 1
        ? src.thumbnail.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: 'good',
          })
        : src.thumbnail;
    const dataUrl = normaliseImageDataUrl(`data:image/png;base64,${forModel.toPNG().toString('base64')}`) ?? '';

    out.push({
      path,
      dataUrl,
      label: src.name || `Screen ${i + 1}`,
    });
  }
  return out;
}

export function listScreens(): string {
  return electronScreen
    .getAllDisplays()
    .map(
      (d, i) =>
        `${i + 1}. ${d.size.width}x${d.size.height} at ${d.bounds.x},${d.bounds.y}` +
        `${d.id === electronScreen.getPrimaryDisplay().id ? ' (primary)' : ''}`,
    )
    .join('\n');
}
