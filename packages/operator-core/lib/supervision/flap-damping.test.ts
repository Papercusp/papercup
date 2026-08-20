import { describe, expect, it } from 'vitest';
import {
  BACKOFF_SEQUENCE_SEC,
  GIVE_UP_THRESHOLD,
  GIVE_UP_WINDOW_MS,
  HEALTHY_RESET_MS,
  decideFlapDamping,
  initialFlapDampingState,
  type FlapDampingState,
} from './flap-damping';

describe('shared flap damping (goal-live-holder-guarantee P-008)', () => {
  it('uses the shared 1s, 5s, 15s, 60s capped restart ladder', () => {
    let state = initialFlapDampingState();
    let now = 1_000;
    const observed: number[] = [];

    for (let attempt = 0; attempt < GIVE_UP_THRESHOLD; attempt += 1) {
      const result = decideFlapDamping({ healthy: false, state, now });
      expect(result.action.kind).toBe('restart');
      if (result.action.kind !== 'restart') throw new Error('expected restart');
      observed.push(result.action.backoffSec);
      state = result.nextState;
      now += result.action.backoffSec * 1_000;
    }

    expect(observed).toEqual([1, 5, 15, 60, 60, 60]);
  });

  it('waits for the prior rung before allowing another attempt', () => {
    const first = decideFlapDamping({ healthy: false, state: initialFlapDampingState(), now: 10_000 });
    const early = decideFlapDamping({ healthy: false, state: first.nextState, now: 10_999 });
    const ready = decideFlapDamping({ healthy: false, state: first.nextState, now: 11_000 });

    expect(early.action).toEqual({ kind: 'waiting-backoff' });
    expect(ready.action).toEqual({ kind: 'restart', backoffSec: 5 });
  });

  it('gives up after six attempts inside ten minutes and latches the escalation', () => {
    let state = initialFlapDampingState();
    let now = 0;
    for (let attempt = 0; attempt < GIVE_UP_THRESHOLD; attempt += 1) {
      const result = decideFlapDamping({ healthy: false, state, now });
      expect(result.action.kind).toBe('restart');
      if (result.action.kind !== 'restart') throw new Error('expected restart');
      state = result.nextState;
      now += result.action.backoffSec * 1_000;
    }

    const giveUp = decideFlapDamping({ healthy: false, state, now });
    expect(giveUp.action).toEqual({
      kind: 'escalate-give-up',
      restartsInWindow: GIVE_UP_THRESHOLD,
    });
    expect(giveUp.nextState.gaveUp).toBe(true);
    expect(decideFlapDamping({ healthy: false, state: giveUp.nextState, now: now + 60_000 }).action)
      .toEqual({ kind: 'already-escalated' });
  });

  it('prunes attempts at the give-up-window boundary', () => {
    const now = GIVE_UP_WINDOW_MS + 50_000;
    const state: FlapDampingState = {
      ...initialFlapDampingState(),
      restarts: Array.from({ length: GIVE_UP_THRESHOLD }, (_, index) => 50_000 - index),
      backoffIndex: BACKOFF_SEQUENCE_SEC.length - 1,
      lastRestartAt: 50_000,
    };

    const result = decideFlapDamping({ healthy: false, state, now });
    expect(result.action).toEqual({ kind: 'restart', backoffSec: 60 });
    expect(result.nextState.restarts).toEqual([now]);
  });

  it('clears attempts and give-up only after five continuously healthy minutes', () => {
    const state: FlapDampingState = {
      ...initialFlapDampingState(),
      restarts: [1, 2, 3, 4, 5, 6],
      backoffIndex: BACKOFF_SEQUENCE_SEC.length - 1,
      lastRestartAt: 6,
      gaveUp: true,
    };
    const firstHealthy = decideFlapDamping({ healthy: true, state, now: 1_000 });
    const tooSoon = decideFlapDamping({
      healthy: true,
      state: firstHealthy.nextState,
      now: 1_000 + HEALTHY_RESET_MS - 1,
    });
    const reset = decideFlapDamping({
      healthy: true,
      state: tooSoon.nextState,
      now: 1_000 + HEALTHY_RESET_MS,
    });

    expect(firstHealthy.action).toEqual({ kind: 'healthy', reset: false });
    expect(tooSoon.action).toEqual({ kind: 'healthy', reset: false });
    expect(reset.action).toEqual({ kind: 'healthy', reset: true });
    expect(reset.nextState).toEqual({
      ...initialFlapDampingState(),
      healthySince: 1_000,
    });
  });
});
