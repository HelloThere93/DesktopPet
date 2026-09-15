import type { StreamEvent, TurnKind } from './types';

/** Only these events surrender ownership of an operation in the renderer. */
export function isTerminalStreamEvent(event: StreamEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}

export function isBubbleTurnKind(kind: TurnKind | undefined): boolean {
  return kind === 'quick' || kind === 'goal';
}

/** Keeps model text from separate tool rounds from running together. */
export function appendSegmentedStreamText(
  current: string,
  delta: string,
  boundaryPending: boolean,
): string {
  if (!boundaryPending || !current || !delta) return current + delta;
  const trailingNewlines = current.match(/\n*$/)?.[0].length ?? 0;
  const cleanDelta = delta.replace(/^\n+/, '');
  return current + '\n'.repeat(Math.max(0, 2 - trailingNewlines)) + cleanDelta;
}

export function quickEscapeAction(turnActive: boolean): 'cancel' | 'dismiss' {
  return turnActive ? 'cancel' : 'dismiss';
}

export function mayDismissQuickAnswer(expectedGeneration: number, currentGeneration: number): boolean {
  return expectedGeneration === currentGeneration;
}

export interface PetSleepState {
  streaming: boolean;
  quickActive: boolean;
  quickSubmitInFlight: boolean;
  streamActive: boolean;
  approvalPending: boolean;
  chatOpen: boolean;
}

/** An ambient pet may sleep only when no user-visible work can still progress. */
export function mayPetSleep(state: PetSleepState): boolean {
  return !(
    state.streaming ||
    state.quickActive ||
    state.quickSubmitInFlight ||
    state.streamActive ||
    state.approvalPending ||
    state.chatOpen
  );
}
