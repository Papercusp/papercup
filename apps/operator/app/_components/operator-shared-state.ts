'use client';

/**
 * Module-scoped shared state for the Operator chrome (button + panel +
 * background scanner). Single source of truth so a click on the button
 * is visible to the panel, the scanner respects pause toggles, etc.
 */

export type IconState =
  | 'idle'
  | 'scanning'
  | 'thinking'
  | 'acting'
  | 'paused'
  | 'awaiting-input';

export interface OperatorState {
  open: boolean;
  iconState: IconState;
  paused: boolean;
}

const defaultState: OperatorState = {
  open: false,
  iconState: 'idle',
  paused: false,
};

const setters = new Set<(s: Partial<OperatorState>) => void>();
export let sharedState: OperatorState = { ...defaultState };

export function broadcastState(partial: Partial<OperatorState>): void {
  sharedState = { ...sharedState, ...partial };
  for (const fn of setters) fn(partial);
}

export function setOperatorState(partial: Partial<OperatorState>): void {
  broadcastState(partial);
}

export function subscribeOperatorState(fn: (s: Partial<OperatorState>) => void): () => void {
  setters.add(fn);
  return () => {
    setters.delete(fn);
  };
}
