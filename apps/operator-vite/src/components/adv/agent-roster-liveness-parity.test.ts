/**
 * @papercusp/agent-roster declares its own `Liveness` type and `LIVE_MS`
 * threshold instead of importing operator-core's, because a libs/generic package
 * must not depend on a host (the repo's generic-first rule). That local copy is
 * only safe if something fails when the two drift — this is that something.
 *
 * It is the same guard operator-core's own `liveness.ts` documents for its copy
 * of coordination's PRESENCE_STALE_MS, placed here because this is the layer
 * where BOTH modules are importable.
 *
 * If this fails: the roster and the rest of the operator disagree about how old a
 * turn can be and still read "live", which is silent and user-visible — the dot
 * on a row would contradict every other liveness surface. Change the two together.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_MS as ROSTER_LIVE_MS } from '@papercusp/agent-roster';
import { LIVE_MS as CORE_LIVE_MS, STALE_MS as CORE_STALE_MS } from '@papercusp/operator-core/lib/liveness';
import { LIVE_TURN_MS } from '@papercusp/agent-roster';

describe('agent-roster liveness thresholds stay pinned to operator-core', () => {
  it('LIVE_MS is the same value in both copies', () => {
    expect(ROSTER_LIVE_MS).toBe(CORE_LIVE_MS);
  });

  it('LIVE_TURN_MS matches operator-core STALE_MS — the 10m "no genuine turn" boundary', () => {
    // The roster's own 10-minute window is deliberately the same duration as
    // coordination's presence-stale boundary. Naming it separately is what lets
    // the roster derive from GENUINE ACTIVITY while operator-core's constant
    // keeps describing heartbeat age; they must still measure the same span.
    expect(LIVE_TURN_MS).toBe(CORE_STALE_MS);
  });

  it('live is a strictly tighter window than stale', () => {
    expect(ROSTER_LIVE_MS).toBeLessThan(LIVE_TURN_MS);
  });
});
