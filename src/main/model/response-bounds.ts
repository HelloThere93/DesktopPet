import { throwIfAborted, waitWithAbort } from '../abort';

export const MAX_PROVIDER_ERROR_CHARS = 4_000;
export const MAX_PROVIDER_CATALOGUE_CHARS = 500_000;
const RESPONSE_TRUNCATION = '\n…[provider response truncated]';

function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const room = Math.max(0, maximum - RESPONSE_TRUNCATION.length);
  return value.slice(0, room).trimEnd() + RESPONSE_TRUNCATION;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Converts a WebSocket frame only after checking its byte and character ceilings. */
export function boundedWebSocketText(raw: unknown, maximumChars: number): string | null {
  const limit = Number.isFinite(maximumChars) ? Math.max(1, Math.floor(maximumChars)) : 1;
  const maxBytes = limit * 4;
  if (typeof raw === 'string') {
    if (raw.length > limit || Buffer.byteLength(raw, 'utf8') > maxBytes) return null;
    return raw;
  }

  let buffer: Buffer;
  if (Buffer.isBuffer(raw)) {
    buffer = raw;
  } else if (raw instanceof ArrayBuffer) {
    if (raw.byteLength > maxBytes) return null;
    buffer = Buffer.from(raw);
  } else if (Array.isArray(raw) && raw.every((part) => Buffer.isBuffer(part))) {
    const parts = raw as Buffer[];
    const bytes = parts.reduce((total, part) => total + part.byteLength, 0);
    if (bytes > maxBytes) return null;
    buffer = Buffer.concat(parts, bytes);
  } else {
    return null;
  }
  if (buffer.byteLength > maxBytes) return null;
  const text = buffer.toString('utf8');
  return text.length <= limit ? text : null;
}

/** Closes a response that will be retried without consuming its body. */
export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* The provider may already have closed the stream. */
  }
}

/** Reads a provider response without allowing a failure or catalogue body to grow unbounded. */
export async function readBoundedResponseText(
  response: Response,
  maximum = MAX_PROVIDER_ERROR_CHARS,
  signal?: AbortSignal,
): Promise<string> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    await cancelResponseBody(response);
    throw error;
  }
  if (!response.body) {
    throwIfAborted(signal);
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const limit = Number.isFinite(maximum) ? Math.max(1, Math.floor(maximum)) : MAX_PROVIDER_ERROR_CHARS;
  const maxBytes = limit * 4;
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await waitWithAbort(reader.read(), signal);
      if (done) {
        text += decoder.decode();
        return clip(text, limit);
      }
      const remainingBytes = Math.max(0, maxBytes - bytes);
      if (value.byteLength > remainingBytes) {
        if (remainingBytes > 0) text += decoder.decode(value.slice(0, remainingBytes), { stream: true });
        text += decoder.decode();
        try {
          await reader.cancel();
        } catch {
          /* The provider may already have closed the stream. */
        }
        return clip(text, limit);
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (text.length >= limit) {
        try {
          await reader.cancel();
        } catch {
          /* The provider may already have closed the stream. */
        }
        return clip(text, limit);
      }
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      /* The provider may already have closed the stream. */
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJson(
  response: Response,
  maximum = MAX_PROVIDER_CATALOGUE_CHARS,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maximum, signal);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Provider returned invalid or oversized JSON.');
  }
}
