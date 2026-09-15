import { app } from 'electron';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationId } from './operations';
import { redactSecrets } from './redaction';

export type RuntimeErrorKind =
  | 'turn-error'
  | 'goal-checkin-error'
  | 'uncaught-exception'
  | 'unhandled-rejection'
  | 'integration-error'
  | 'attachment-audit-error';

const MAX_RUNTIME_ERROR_MESSAGE_CHARS = 4_000;
const MAX_RUNTIME_ERROR_STACK_CHARS = 12_000;
const MAX_OBSERVABILITY_LABEL_CHARS = 240;
const MAX_OBSERVABILITY_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_OBSERVABILITY_PERCENT = 100;
const MAX_OBSERVABILITY_LOG_BYTES = 2 * 1024 * 1024;

function boundedText(value: unknown, maximum: number, fallback: string): string {
  try {
    const text = redactSecrets(typeof value === 'string' ? value : String(value ?? '')).trim();
    return text ? text.slice(0, maximum).trimEnd() : fallback;
  } catch {
    return fallback;
  }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_OBSERVABILITY_NUMBER, Math.floor(value))
    : 0;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_OBSERVABILITY_NUMBER, value)
    : 0;
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function retainJsonlTail(buffer: Buffer, maximumBytes = MAX_OBSERVABILITY_LOG_BYTES): Buffer {
  if (!Buffer.isBuffer(buffer) || buffer.length <= maximumBytes) return buffer;
  const start = Math.max(0, buffer.length - Math.max(1, maximumBytes));
  const newline = buffer.indexOf(0x0a, start);
  return newline >= 0 ? buffer.subarray(newline + 1) : buffer.subarray(start);
}

function appendBoundedJsonl(filePath: string, record: string): void {
  appendFileSync(filePath, record, 'utf8');
  let fd: number | undefined;
  try {
    const size = statSync(filePath).size;
    if (size <= MAX_OBSERVABILITY_LOG_BYTES) return;
    const start = Math.max(0, size - MAX_OBSERVABILITY_LOG_BYTES);
    const length = size - start;
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset);
      if (!read) break;
      offset += read;
    }
    writeFileSync(filePath, retainJsonlTail(buffer.subarray(0, offset)), 'utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function describe(error: unknown): { message: string; stack?: string } {
  try {
    if (error instanceof Error) return { message: error.message, stack: error.stack };
    return { message: String(error) };
  } catch {
    return { message: 'Unknown runtime error.' };
  }
}

/** Formats one redacted JSONL record; kept pure so it can be regression-tested. */
export function formatRuntimeError(
  kind: RuntimeErrorKind,
  error: unknown,
  operationId?: OperationId,
  at = Date.now(),
): string {
  const detail = describe(error);
  return (
    JSON.stringify({
      at: timestamp(at, Date.now()),
      kind,
      operationId: operationId ? boundedText(operationId, MAX_OBSERVABILITY_LABEL_CHARS, '') || null : null,
      message: boundedText(detail.message, MAX_RUNTIME_ERROR_MESSAGE_CHARS, 'Unknown runtime error.'),
      stack: detail.stack ? boundedText(detail.stack, MAX_RUNTIME_ERROR_STACK_CHARS, '') || undefined : undefined,
    }) + '\n'
  );

}
export type ModelRequestSelectionMode = 'all' | 'selected' | 'none';

export interface ModelRequestMetricInput {
  provider: string;
  shape: string;
  model: string;
  operationId?: OperationId;
  selectionMode: ModelRequestSelectionMode;
  availableToolCount: number;
  selectedToolCount: number;
  availableToolBytes: number;
  selectedToolBytes: number;
  savedToolBytes: number;
  savedToolPercent: number;
  requestBytes: number;
  retry?: boolean;
}

export function formatModelRequestMetric(
  input: ModelRequestMetricInput,
  at = Date.now(),
): string {
  return (
    JSON.stringify({
      at: timestamp(at, Date.now()),
      kind: 'model-request',
      operationId: input.operationId ? boundedText(input.operationId, MAX_OBSERVABILITY_LABEL_CHARS, '') || null : null,
      provider: boundedText(input.provider, MAX_OBSERVABILITY_LABEL_CHARS, 'unknown'),
      shape: boundedText(input.shape, MAX_OBSERVABILITY_LABEL_CHARS, 'unknown'),
      model: boundedText(input.model, MAX_OBSERVABILITY_LABEL_CHARS, 'unknown'),
      selectionMode: ['all', 'selected', 'none'].includes(input.selectionMode) ? input.selectionMode : 'none',
      availableToolCount: nonNegativeInteger(input.availableToolCount),
      selectedToolCount: nonNegativeInteger(input.selectedToolCount),
      availableToolBytes: nonNegativeInteger(input.availableToolBytes),
      selectedToolBytes: nonNegativeInteger(input.selectedToolBytes),
      savedToolBytes: nonNegativeInteger(input.savedToolBytes),
      savedToolPercent: Math.min(MAX_OBSERVABILITY_PERCENT, nonNegativeNumber(input.savedToolPercent)),
      requestBytes: nonNegativeInteger(input.requestBytes),
      retry: input.retry === true,
    }) +
    '\n'
  );
}

export function logModelRequestMetric(input: ModelRequestMetricInput): void {
  try {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    appendBoundedJsonl(join(dir, 'model-requests.jsonl'), formatModelRequestMetric(input));
  } catch {
    /* request metrics must never prevent the model request from running */
  }
}

/**
 * Writes diagnostics without allowing logging itself to become a second crash.
 * uncaughtExceptionMonitor keeps Node's default fatal behavior intact.
 */
export function logRuntimeError(
  kind: RuntimeErrorKind,
  error: unknown,
  operationId?: OperationId,
): void {
  try {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    appendBoundedJsonl(join(dir, 'runtime-errors.jsonl'), formatRuntimeError(kind, error, operationId));
  } catch {
    /* diagnostics must never prevent the original failure from surfacing */
  }
}

