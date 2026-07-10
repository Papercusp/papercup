/**
 * mug-guard.test.ts — pure unit coverage for the P-005 split-brain-Mug
 * gate + detection invariant (plan shared-hive-loop-e2e-testing-2026-06-10
 * D-008).
 */
import { describe, expect, it } from 'vitest';
import { detectDoubleSteering, evaluateQueenTurnGate, type SteeringEvent } from './mug-guard';

const ev = (item: string, by: string, ts: number): SteeringEvent => ({ workItemId: item, steererPubkey: by, tsMs: ts });

describe('evaluateQueenTurnGate', () => {
  it('home swarm may steer', () => {
    expect(evaluateQueenTurnGate({ selfPubkey: 'pk-a', queenHomePubkey: 'pk-a' })).toEqual({
      ok: true,
      reason: 'home-swarm',
    });
  });

  it('a non-home swarm is refused, with the recorded home in the verdict', () => {
    expect(evaluateQueenTurnGate({ selfPubkey: 'pk-b', queenHomePubkey: 'pk-a' })).toEqual({
      ok: false,
      reason: 'not-home-swarm',
      queenHomePubkey: 'pk-a',
    });
  });

  it('an unset home FAILS OPEN (convention-only Hives keep working; the detector is the alarm)', () => {
    expect(evaluateQueenTurnGate({ selfPubkey: 'pk-b', queenHomePubkey: null })).toEqual({
      ok: true,
      reason: 'fail-open-unset',
    });
    expect(evaluateQueenTurnGate({ selfPubkey: 'pk-b', queenHomePubkey: '' })).toEqual({
      ok: true,
      reason: 'fail-open-unset',
    });
  });
});

describe('detectDoubleSteering', () => {
  it('quiet on a single steerer, however busy', () => {
    const events = [ev('F-1', 'pk-a', 0), ev('F-2', 'pk-a', 10), ev('F-1', 'pk-a', 20)];
    expect(detectDoubleSteering(events, 1000)).toEqual([]);
  });

  it('two steerers inside the window = ONE merged incident with contested items + forensics', () => {
    const events = [
      ev('F-1', 'pk-a', 0),
      ev('F-2', 'pk-a', 10),
      ev('F-1', 'pk-b', 50), // contests F-1
      ev('F-3', 'pk-b', 60),
    ];
    const incidents = detectDoubleSteering(events, 1000);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].steerers).toEqual(['pk-a', 'pk-b']);
    expect(incidents[0].contestedItems).toEqual(['F-1']);
    expect(incidents[0].events).toHaveLength(4);
    expect(incidents[0].windowStartMs).toBe(0);
    expect(incidents[0].windowEndMs).toBe(60);
  });

  it('events farther apart than the window are separate clusters; single-steerer clusters stay quiet', () => {
    const events = [
      ev('F-1', 'pk-a', 0),
      ev('F-1', 'pk-b', 100), // cluster 1: split-brain
      ev('F-2', 'pk-a', 10_000), // cluster 2: solo → quiet
      ev('F-2', 'pk-b', 30_000), // cluster 3: solo → quiet
    ];
    const incidents = detectDoubleSteering(events, 1000);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].contestedItems).toEqual(['F-1']);
  });

  it('is input-order independent', () => {
    const events = [ev('F-1', 'pk-b', 50), ev('F-1', 'pk-a', 0), ev('F-2', 'pk-b', 60)];
    const a = detectDoubleSteering(events, 1000);
    const b = detectDoubleSteering([...events].reverse(), 1000);
    expect(a).toEqual(b);
  });
});
