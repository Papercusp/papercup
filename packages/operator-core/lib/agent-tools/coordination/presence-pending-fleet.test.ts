/**
 * presence-pending-fleet.test.ts — the in-process hand-off that lets
 * `fleet:spawn { fleet }` place a HEADLESS bee in a named fleet (fleet-color-schemes).
 *
 * A spawned bee's fleet can't ride env (writePresence's env-fold reads the OPERATOR's
 * process.env, not the bee's), so operator-spawn registers a PENDING placement keyed
 * by the bee's spawnId and writePresence applies it on the bee's first presence write.
 * These guard the one-shot map semantics (set → take-once → cleared).
 */
import { describe, it, expect } from 'vitest';
import { setPendingFleet, takePendingFleet } from './presence';

describe('pending fleet placement (spawned-bee auto-join)', () => {
  it('returns the placement once, then null (one-shot — applied on first presence write)', () => {
    setPendingFleet('s-bee-oneshot', 'atlas-fleet', 'member');
    expect(takePendingFleet('s-bee-oneshot')).toEqual({ slug: 'atlas-fleet', role: 'member' });
    expect(takePendingFleet('s-bee-oneshot')).toBeNull(); // cleared after the first take
  });

  it('defaults a blank role to member, and ignores an empty owner or slug', () => {
    setPendingFleet('s-bee-role', 'nimbus-fleet', '');
    expect(takePendingFleet('s-bee-role')).toEqual({ slug: 'nimbus-fleet', role: 'member' });

    setPendingFleet('', 'fleet-x', 'member'); // no owner → not stored
    setPendingFleet('s-bee-noslug', '', 'member'); // no slug → not stored
    expect(takePendingFleet('s-bee-noslug')).toBeNull();
  });

  it('is per-owner (one bee taking its placement does not consume another\'s)', () => {
    setPendingFleet('s-a', 'fleet-a', 'member');
    setPendingFleet('s-b', 'fleet-b', 'leader');
    expect(takePendingFleet('s-b')).toEqual({ slug: 'fleet-b', role: 'leader' });
    expect(takePendingFleet('s-a')).toEqual({ slug: 'fleet-a', role: 'member' });
  });

  it('returns null for an owner that never had a placement', () => {
    expect(takePendingFleet('s-never')).toBeNull();
  });
});
