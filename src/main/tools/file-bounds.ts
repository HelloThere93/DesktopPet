import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { throwIfAborted } from '../abort';

/** Maximum on-disk input accepted by document readers before parsing begins. */
export const MAX_DOCUMENT_INPUT_BYTES = 50_000_000;

/** Maximum on-disk input accepted by image decoders and OCR. */
export const MAX_IMAGE_INPUT_BYTES = 30_000_000;

export interface VerifiedInputFile {
  abs: string;
  bytes: number;
}

/**
 * Performs the cheap, deterministic part of a binary read before a parser or
 * decoder can allocate memory for it. The check is intentionally shared by
 * PDF, Office and image tools so a new entry point cannot silently omit it.
 */
export async function verifyInputFile(
  path: string,
  maximumBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<VerifiedInputFile> {
  const abs = resolve(path);
  throwIfAborted(signal);
  const info = await stat(abs);
  throwIfAborted(signal);
  if (!info.isFile()) throw new Error(`${label} must be a regular file: ${abs}`);
  if (info.size > maximumBytes) {
    throw new Error(
      `${label} exceeds the ${maximumBytes.toLocaleString()}-byte safety limit ` +
        `(${info.size.toLocaleString()} bytes): ${abs}`,
    );
  }
  return { abs, bytes: info.size };
}
