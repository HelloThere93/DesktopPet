import type { ToolResult } from '../shared/types';
import { BulkPartialFailure } from './bulk';
export function failureToolErrorCode(error: unknown): 'execution-failed' | 'bulk-partial-failure' {
  return error instanceof BulkPartialFailure ? 'bulk-partial-failure' : 'execution-failed';
}


export type UntimedToolResult = Omit<ToolResult, 'durationMs'>;

/** A bounded result used to close a tool-call exchange when a turn is cancelled. */
export function cancelledToolResult(toolCallId: string, started: boolean): ToolResult {
  return {
    toolCallId,
    ok: false,
    errorCode: 'execution-failed',
    content: started
      ? 'Cancelled before this tool completed.'
      : 'Cancelled before this tool was started.',
    durationMs: 0,
  };
}

/** Adds a monotonic wall-clock duration at the single registry boundary. */
export function withToolTiming(
  result: UntimedToolResult,
  startedAt: number,
  finishedAt = Date.now(),
): ToolResult {
  return {
    ...result,
    durationMs: Math.max(0, finishedAt - startedAt),
  };
}

