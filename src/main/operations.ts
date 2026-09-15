import { randomUUID } from 'node:crypto';

export type OperationId = string;

/** Creates the correlation key shared by one user turn and its tool calls. */
export function createOperationId(): OperationId {
  return randomUUID();
}

