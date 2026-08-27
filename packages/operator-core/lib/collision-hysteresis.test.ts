/** collision-hysteresis (ambient-semantic-push P-004, plan D-006 + D-010): the
 *  sustained-collision detector. Verifies "single spikes do nothing", enter/exit
 *  hysteresis with an asymmetric gap, the staleness backstop, bounded tracking,
 *  the enter-edge collision push, and purity. */
import { describe, it, expect } from 'vitest';
import type { CollisionLike, PushObject } from './ambient-push';
import {
  collisionHysteresisTick,
  validateCollisionParams,
  DEFAULT_COLLISION_HYSTERESIS_PARAMS,
  type CollisionHysteresisParams,
  type CollisionState,
  type CollisionNotice,
} from './collision-hysteresis';

type Sample = { score: number } | { absent: true };

/** Fold a per-tick (score present / absent) sequence for ONE peer through the
 *  machine, collecting the final state + every notice + every push. */
function runPeer(
  sid: string,
  samples: Sample[],
  opts: { params?: CollisionHysteresisParams; terms?: string[] } = {},
): { states: CollisionState[]; notices: CollisionNotice[]; pushes: PushObject[] } {
  let states: CollisionState[] = [];
  const notices: CollisionNotice[] = [];
  const pushes: PushObject[] = [];
  const terms = (opts.terms ?? ['alpha', 'beta']).map((t) => ({ term: t }));
  samples.forEach((s, i) => {
    const snapshot: CollisionLike[] =
      'absent' in s ? [] : [{ sessionId: sid, overlap: { score: s.score, sharedTerms: terms } }];
    const res = collisionHysteresisTick({ states, snapshot, tick: i, params: opts.params });
    states = res.states;
    notices.push(...res.notices);
    pushes.push(...res.pushes);
  });
  return { states, notices, pushes };
}

const present = (score: number, n: number): Sample[] => Array.from({ length: n }, () => ({ score }));
const absent = (n: number): Sample[] => Array.from({ length: n }, () => ({ absent: true as const }));

describe('validateCollisionParams', () => {
  it('accepts the sane defaults', () => {
    expect(validateCollisionParams(DEFAULT_COLLISION_HYSTERESIS_PARAMS)).toEqual([]);
    expect(DEFAULT_COLLISION_HYSTERESIS_PARAMS.enterThreshold).toBe(0.3);
  });
  it('flags a missing hysteresis gap and a non-asymmetric dwell', () => {
    const w = validateCollisionParams({ ...DEFAULT_COLLISION_HYSTERESIS_PARAMS, exitThreshold: 0.5, exitDwell: 2 });
    expect(w.some((m) => /gap/.test(m))).toBe(true);
    expect(w.some((m) => /asymmetric|dwell/.test(m))).toBe(true);
  });
});

describe('P-004 — single spikes do nothing', () => {
  it('one high tick then absence never enters a collision', () => {
    const { states, notices, pushes } = runPeer('peer-1', [{ score: 0.9 }, ...absent(4)]);
    expect(notices).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    // (and the transient peer is GC'd once it goes stale — stalenessTicks = 4)
    expect(states.find((s) => s.sessionId === 'peer-1')).toBeUndefined();
  });

  it('a dip resets the enter-dwell streak (must be CONSECUTIVE)', () => {
    // 0.6,0.6,0.1,0.6,0.6 — never 3 in a row → no enter.
    const { notices } = runPeer('peer-1', [{ score: 0.6 }, { score: 0.6 }, { score: 0.1 }, { score: 0.6 }, { score: 0.6 }]);
    expect(notices.filter((n) => n.kind === 'collision-entered')).toHaveLength(0);
  });
});

describe('P-004 — sustained convergence enters (with the enter-dwell)', () => {
  it('subscribes to the collision only after enterDwell consecutive ≥-enter ticks', () => {
    const two = runPeer('peer-1', present(0.6, 2)); // enterDwell 3
    expect(two.notices).toHaveLength(0);

    const three = runPeer('peer-1', present(0.6, 3));
    const entered = three.notices.filter((n) => n.kind === 'collision-entered');
    expect(entered).toHaveLength(1);
    expect(three.pushes).toHaveLength(1);
    expect(three.states.find((s) => s.sessionId === 'peer-1')!.colliding).toBe(true);
  });

  it('the enter-edge emits a proper collision push (critical, data-not-directive, names shared terms)', () => {
    const { pushes } = runPeer('peer-1', present(0.7, 3), { terms: ['psu-launcher.mjs', 'compaction'] });
    const push = pushes[0];
    expect(push.matcherKind).toBe('collision');
    expect(push.severity).toBe('critical');
    expect(push.provenance).toBe('data-not-directive');
    expect(push.handle.kind).toBe('session');
    expect(push.handle.ref).toBe('peer-1');
    expect(push.handle.query).toContain('psu-launcher.mjs');
    expect(push.teaser).toContain('peer-1');
  });
});

describe('P-004 — exit hysteresis (asymmetric gap)', () => {
  it('the gap holds a collision: overlap between exit and enter never clears', () => {
    // Enter (3× 0.6), then sit at 0.3 (≥ exit 0.2, < enter 0.4) for a long time.
    const { states, notices } = runPeer('peer-1', [...present(0.6, 3), ...present(0.3, 20)]);
    expect(states.find((s) => s.sessionId === 'peer-1')!.colliding).toBe(true);
    expect(notices.filter((n) => n.kind === 'collision-cleared')).toHaveLength(0);
  });

  it('drift clears after exitDwell consecutive sub-exit ticks (still present)', () => {
    const { states, notices } = runPeer('peer-1', [...present(0.6, 3), ...present(0.05, 6)]); // exitDwell 6
    expect(states.find((s) => s.sessionId === 'peer-1')!.colliding).toBe(false);
    const cleared = notices.find((n) => n.kind === 'collision-cleared')!;
    expect(cleared.reason).toMatch(/diverged/);
  });

  it('the staleness backstop clears a vanished peer faster than the full drift dwell', () => {
    // Enter, then the peer disappears entirely: stalenessTicks (4) < exitDwell (6).
    const { notices } = runPeer('peer-1', [...present(0.6, 3), ...absent(4)]);
    const cleared = notices.find((n) => n.kind === 'collision-cleared')!;
    expect(cleared.reason).toMatch(/staleness/);
  });

  it('re-entry after a clear is cheap — the enter-dwell just reapplies', () => {
    const { notices } = runPeer('peer-1', [...present(0.6, 3), ...present(0.05, 6), ...present(0.6, 3)]);
    expect(notices.filter((n) => n.kind === 'collision-entered')).toHaveLength(2);
  });
});

describe('P-004 — bounded set + simultaneous enters + purity', () => {
  it('caps the tracked set, evicting the weakest non-colliding while protecting active collisions', () => {
    const params: CollisionHysteresisParams = { ...DEFAULT_COLLISION_HYSTERESIS_PARAMS, enterDwell: 1, maxTrackedPeers: 3 };
    let states: CollisionState[] = [];
    // Tick 0..2: drive A,B,C into a sustained collision (enterDwell 1 → immediate,
    // held for 3 ticks). On the last tick, also flood D,E,F,G as weak non-colliders.
    for (let t = 0; t < 3; t++) {
      const snapshot: CollisionLike[] = [
        ...['A', 'B', 'C'].map((sid) => ({ sessionId: sid, overlap: { score: 0.9, sharedTerms: [{ term: 'x' }] } })),
        ...(t === 2 ? ['D', 'E', 'F', 'G'].map((sid) => ({ sessionId: sid, overlap: { score: 0.1, sharedTerms: [{ term: 'y' }] } })) : []),
      ];
      states = collisionHysteresisTick({ states, snapshot, tick: t, params }).states;
    }
    // Over cap (7 > 3): the 4 non-colliding weaklings are evicted; A,B,C survive.
    const on = new Set(states.filter((s) => s.colliding).map((s) => s.sessionId));
    expect(on).toEqual(new Set(['A', 'B', 'C']));
    expect(states).toHaveLength(3);
  });

  it('orders simultaneous enter-edge pushes by overlap score, highest first', () => {
    const params: CollisionHysteresisParams = { ...DEFAULT_COLLISION_HYSTERESIS_PARAMS, enterDwell: 1 };
    const snapshot: CollisionLike[] = [
      { sessionId: 'Y', overlap: { score: 0.5, sharedTerms: [{ term: 'x' }] } },
      { sessionId: 'X', overlap: { score: 0.9, sharedTerms: [{ term: 'x' }] } },
      { sessionId: 'Z', overlap: { score: 0.7, sharedTerms: [{ term: 'x' }] } },
    ];
    const { pushes } = collisionHysteresisTick({ states: [], snapshot, tick: 0, params });
    expect(pushes.map((p) => p.handle.ref)).toEqual(['X', 'Z', 'Y']);
  });

  it('does not mutate the input state (pure)', () => {
    const initial: CollisionState[] = [
      { sessionId: 'peer-1', colliding: true, aboveEnterStreak: 3, belowExitStreak: 0, ticksSinceSeen: 0, lastScore: 0.6, lastSharedTerms: ['x'], enteredAtTick: 0 },
    ];
    const snapshot = JSON.parse(JSON.stringify(initial));
    collisionHysteresisTick({ states: initial, snapshot: [], tick: 1 });
    expect(initial).toEqual(snapshot); // untouched
  });
});
