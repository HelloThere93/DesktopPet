export const MAX_MODEL_TEXT_CHARS = 200_000;
export const MAX_MODEL_TOOL_ARGUMENT_CHARS = 100_000;
export const MAX_MODEL_SSE_BUFFER_CHARS = 1_000_000;
export const MAX_MODEL_SSE_CHUNK_BYTES = MAX_MODEL_SSE_BUFFER_CHARS * 4;
export const MAX_MODEL_NAME_CHARS = 500;
export const MAX_MODEL_TOOL_CALLS = 64;
export const MAX_MODEL_TOOL_ID_CHARS = 500;

/** Requires a non-empty, bounded provider identifier instead of fabricating one. */
export function streamIdentifier(
  value: unknown,
  label: string,
  limit = MAX_MODEL_TOOL_ID_CHARS,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(label + ' was missing.');
  }
  if (value.length > limit) {
    throw new Error(label + ' exceeded ' + limit.toLocaleString() + ' characters.');
  }
  return value;
}

/** Validates a provider's zero-based tool-block index before it addresses state. */
export function streamToolIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= MAX_MODEL_TOOL_CALLS) {
    throw new Error('Model tool block index was invalid.');
  }
  return value;
}

export function streamText(value: unknown, current: number, limit: number, label: string): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (current + text.length > limit) {
    throw new Error(label + ' exceeded ' + limit.toLocaleString() + ' characters.');
  }
  return text;
}

export function decodeModelStreamChunk(decoder: TextDecoder, chunk: Uint8Array): string {
  if (chunk.byteLength > MAX_MODEL_SSE_CHUNK_BYTES) {
    throw new Error('Model SSE chunk exceeded ' + MAX_MODEL_SSE_CHUNK_BYTES.toLocaleString() + ' bytes.');
  }
  return decoder.decode(chunk, { stream: true });
}

export function streamBuffer(current: string, chunk: Uint8Array | string): string {
  const text = typeof chunk === 'string' ? chunk : decodeModelStreamChunk(new TextDecoder(), chunk);
  const combined = current + text;
  if (combined.length > MAX_MODEL_SSE_BUFFER_CHARS) {
    throw new Error('Model SSE frame exceeded ' + MAX_MODEL_SSE_BUFFER_CHARS.toLocaleString() + ' characters.');
  }
  // Providers commonly use CRLF SSE framing. Normalize after joining chunks
  // so a CRLF split across two network reads is handled as one line ending.
  return combined.replace(/\r\n?/g, '\n');
}
