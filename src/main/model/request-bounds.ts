import { assertJsonWithinLimit, estimateJsonBytes } from '../bounded-json';

/** Hard ceiling for one serialized provider request before transport. */
export const MAX_MODEL_REQUEST_BYTES = 32_000_000;

export function estimateModelRequestBytes(value: unknown): number {
  return estimateJsonBytes(value);
}

export function assertModelRequestWithinLimit(
  value: unknown,
  maxBytes = MAX_MODEL_REQUEST_BYTES,
  label = 'Model request',
): void {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error('Model request limit is invalid.');
  assertJsonWithinLimit(value, Math.floor(maxBytes), label);
}
