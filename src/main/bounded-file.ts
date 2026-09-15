import { closeSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { throwIfAborted } from './abort';

export interface BoundedTextRead {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

function checkedMaximumBytes(maximumBytes: number): number {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('A positive bounded-file read limit is required.');
  }
  return maximumBytes;
}

export async function readBoundedTextFile(
  filePath: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<BoundedTextRead> {
  const limit = checkedMaximumBytes(maximumBytes);
  throwIfAborted(signal);
  const handle = await open(filePath, 'r');
  const buffer = Buffer.alloc(limit + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      throwIfAborted(signal);
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  throwIfAborted(signal);
  return {
    text: buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8'),
    bytesRead,
    truncated: bytesRead > limit,
  };
}

export function readBoundedTextFileSync(filePath: string, maximumBytes: number): BoundedTextRead {
  const limit = checkedMaximumBytes(maximumBytes);
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.alloc(limit + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(fd);
  }
  return {
    text: buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8'),
    bytesRead,
    truncated: bytesRead > limit,
  };
}
export interface BoundedBufferRead {
  data: Buffer;
  bytesRead: number;
  truncated: boolean;
}

export async function readBoundedBufferFile(
  filePath: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<BoundedBufferRead> {
  const limit = checkedMaximumBytes(maximumBytes);
  throwIfAborted(signal);
  const handle = await open(filePath, 'r');
  const buffer = Buffer.alloc(limit + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      throwIfAborted(signal);
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  throwIfAborted(signal);
  return {
    data: buffer.subarray(0, Math.min(bytesRead, limit)),
    bytesRead,
    truncated: bytesRead > limit,
  };
}

export function readBoundedBufferFileSync(filePath: string, maximumBytes: number): BoundedBufferRead {
  const limit = checkedMaximumBytes(maximumBytes);
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.alloc(limit + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(fd);
  }
  return {
    data: buffer.subarray(0, Math.min(bytesRead, limit)),
    bytesRead,
    truncated: bytesRead > limit,
  };
}