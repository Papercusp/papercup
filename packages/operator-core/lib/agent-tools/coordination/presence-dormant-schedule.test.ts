/**
 * presence-dormant-schedule.test.ts — EI-22805550006169069.
 *
 * The recurrence guard for "coord:presence rendered an agent that was merely
 * DORMANT BETWEEN LOOP FIRES identically to a dead one".
 *
 * The measured incident (2026-09-09 17:19:48Z): a presence read of the
 * green-checkpoint gate holder returned `state:'ended'`, `wakeable:false`,
 * `claims:0`, `lastActiveSecAgo:null` — and 26 seconds later a
 * `coord:send { wake:'required' }` to the SAME owner returned
 * `recipient_dormant_scheduled` with `nextFireAt: 17:33:31.265Z` and an explicit
 * "not dead, do NOT reassign". The holder then replied in person.
 *
 * What makes this worth a guard is the shape, not the outage: every one of those
 * presence fields was individually ACCURATE. The agent's session really had ended
 * and it really held no claim. The row was not WRONG, it was INCOMPLETE — and a
 * reader cannot repair incompleteness by reading more carefully. That is why the
 * near-miss was a wrongful reclaim of a live peer's gate work.
 *
 * So these cases are written against the failure: each asserts a DISTINCTION
 * that, if it collapsed, would put the two agents back to byte-identical.
 */

import { describe, it, expect } from 'vitest';
import { deriveDormantSchedule } from './presence-selfwake';
import { shapeCoordPresence } from './tools/presence-shape';
import type { LoopStatus } from '../../harness/routines/loop';

const NOW = Date.parse('2026-09-09T17:19:48.643Z');
const NEXT_FIRE = '2026-09-09T17:33:31.265Z';

/** Only the four fields the shared rule reads; the rest of LoopStatus is noise here. */
const loop = (o: Partial<Pick<LoopStatus, 'active' | 'nextFireAt' | 'parked' | 'stalled'>>) =>
  ({ active: true, nextFireAt: null, parked: false, stalled: false, ...o }) as Pick<
    LoopStatus,
    'active' | 'nextFireAt' | 'parked' | 'stalled'
  >;

describe('deriveDormantSchedule — the incident distinction', () => {
  it('THE INCIDENT: a dormant-between-fires owner is distinguishable from a dead one', () => {
    // Both agents are, on every pre-existing presence field, identical: session
    // ended, not wakeable, no claims, no recent activity. This one is coming back.
    const dormant = deriveDormantSchedule(
      { measured: true, loop: loop({ nextFireAt: NEXT_FIRE }) },
      NOW,
    );
    // ...and this one is genuinely gone: no loop row at all.
    const dead = deriveDormantSchedule({ measured: true, loop: null }, NOW);

    expect(dormant).toEqual({ dormantScheduled: true, nextFireAt: NEXT_FIRE });
    expect(dead).toEqual({ dormantScheduled: false, nextFireAt: null });
    // The load-bearing assertion: if these ever compare equal, the incident is back.
    expect(dormant).not.toEqual(dead);
  });

  it('reports a turn IN FLIGHT as scheduled, with no fire time to promise', () => {
    // A parked loop has no concrete nextFireAt — the fire is imminent, not at a
    // known future instant. `true` + null must not be read as "not scheduled".
    expect(deriveDormantSchedule({ measured: true, loop: loop({ parked: true }) }, NOW)).toEqual({
      dormantScheduled: true,
      nextFireAt: null,
    });
  });

  it('does NOT promise a fire for a STALLED loop — no false confidence', () => {
    // The failure mode one level past this bug: an ACTIVE loop parked-and-wedged
    // for hours still carries a nextFireAt, but nothing is going to fire. Swapping
    // missing information for wrong information would be a worse bug than the one
    // being fixed, so a stalled loop reads exactly like no loop.
    expect(
      deriveDormantSchedule(
        { measured: true, loop: loop({ nextFireAt: NEXT_FIRE, parked: true, stalled: true }) },
        NOW,
      ),
    ).toEqual({ dormantScheduled: false, nextFireAt: null });
  });

  it('does NOT promise a fire for a DISARMED loop', () => {
    // active:false is the stranded-member state presence-selfwake.ts exists for.
    expect(
      deriveDormantSchedule(
        { measured: true, loop: loop({ active: false, nextFireAt: NEXT_FIRE }) },
        NOW,
      ),
    ).toEqual({ dormantScheduled: false, nextFireAt: null });
  });

  it('ignores a nextFireAt already in the PAST — a lapsed schedule is not a promise', () => {
    expect(
      deriveDormantSchedule(
        { measured: true, loop: loop({ nextFireAt: '2026-09-09T16:00:00.000Z' }) },
        NOW,
      ),
    ).toEqual({ dormantScheduled: false, nextFireAt: null });
  });

  it('an UNMEASURED read is null, never false — absence of evidence is not evidence', () => {
    // The batched loop read is best-effort. If it failed, an empty map is
    // indistinguishable from "nobody has a loop", and reporting `false` would
    // assert that nothing will ever wake this agent — the exact false negative
    // that authorizes a wrongful reclaim. It must degrade to NOT MEASURED.
    expect(deriveDormantSchedule({ measured: false, loop: null }, NOW)).toEqual({
      dormantScheduled: null,
      nextFireAt: null,
    });
    // Even when a loop IS present, an unmeasured read may not report it.
    expect(
      deriveDormantSchedule({ measured: false, loop: loop({ nextFireAt: NEXT_FIRE }) }, NOW),
    ).toEqual({ dormantScheduled: null, nextFireAt: null });
  });

  it('a FEDERATED row is null — its loop lives on its home box', () => {
    // Same convention as onDesktop/viewerAttached: not measurable here, so unknown.
    expect(
      deriveDormantSchedule(
        { federated: true, measured: true, loop: loop({ nextFireAt: NEXT_FIRE }) },
        NOW,
      ),
    ).toEqual({ dormantScheduled: null, nextFireAt: null });
  });
});

describe('shapeCoordPresence — the signal must survive to the wire', () => {
  /** The incident row: accurate on every legacy field, and not gone. */
  const row = (extra: Record<string, unknown>) => ({
    ownerId: 'su-e10fc69e',
    ownerLabel: 'su · su-e10f',
    sessionState: 'ended',
    wakeable: false,
    confirmLiveness: false,
    lastActiveSecAgo: null,
    claimCount: 0,
    intent: 'WI-10000288 sole LIVE_GATE_OPS',
    ...extra,
  });

  it('carries dormantScheduled/nextFireAt at the TRIMMED tier', () => {
    // A field the shaper drops is INVISIBLE no matter what the producer joins, and
    // trimmed is the DEFAULT tier a coordinator reads before reclaiming work — so
    // emitting this only at payloadTier:'full' would leave the default read
    // carrying the very ambiguity the field exists to remove.
    const shaped = shapeCoordPresence(
      { active: [row({ dormantScheduled: true, nextFireAt: NEXT_FIRE })] },
      'trimmed',
    ) as { active: Record<string, unknown>[] };

    expect(shaped.active[0].dormantScheduled).toBe(true);
    expect(shaped.active[0].nextFireAt).toBe(NEXT_FIRE);
  });

  it('keeps the dormant and dead rows distinguishable AFTER shaping', () => {
    // End-to-end form of the headline case: two rows agreeing on every legacy
    // field, shaped for the wire, must not come out equal.
    const shaped = shapeCoordPresence(
      {
        active: [
          row({ ownerId: 'dormant', dormantScheduled: true, nextFireAt: NEXT_FIRE }),
          row({ ownerId: 'dead', dormantScheduled: false, nextFireAt: null }),
        ],
      },
      'trimmed',
    ) as { active: Record<string, unknown>[] };

    const [dormant, dead] = shaped.active;
    // Every field that existed BEFORE this fix still agrees — which is precisely
    // why the row needed a new one.
    for (const k of ['state', 'wakeable', 'claims', 'lastActiveSecAgo', 'confirmLiveness']) {
      expect(dormant[k]).toEqual(dead[k]);
    }
    expect(dormant.dormantScheduled).not.toEqual(dead.dormantScheduled);
  });

  it('renders an unmeasured schedule as null rather than omitting the key', () => {
    // Omission would recreate the bug one level up: a reader could not tell
    // "not scheduled" from "this build does not report it".
    const shaped = shapeCoordPresence({ active: [row({})] }, 'trimmed') as {
      active: Record<string, unknown>[];
    };
    expect(shaped.active[0]).toHaveProperty('dormantScheduled', null);
    expect(shaped.active[0]).toHaveProperty('nextFireAt', null);
  });
});
