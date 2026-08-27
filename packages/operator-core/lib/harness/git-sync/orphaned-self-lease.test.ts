/**
 * WI-222602 — the orphaned-self-lease predicate.
 *
 * The defect this guards: a git-sync fire acquires exclusive(git-sync:<slug>)
 * and then ceases to exist WITHOUT its `finally` running, while its host
 * process stays alive. `reclaimDeadExclusiveHolders` only reclaims a lease
 * whose owner PID is definitively DEAD, so it is structurally blind to that
 * orphan; nothing else releases it; every later tick reads it as a live peer
 * and skips. Measured 2026-08-27: 3h40m with zero commits fleet-wide.
 *
 * `isOrphanedSelfOwner` is the falsifier the PID test cannot be — membership in
 * the set of fires actually in flight HERE, rather than process liveness.
 */
import { describe, expect, it } from 'vitest';
import { isOrphanedSelfOwner, parseGitSyncOwnerPid } from './git-sync-action';

const SELF = 4242;
const owner = (pid: number, uuid: string) => `system:git-sync:${pid}:${uuid}`;

/**
 * The deliberately-wrong implementation this guard must be able to tell apart
 * from the real one: "the owner names this process" WITHOUT the in-flight
 * check. That is the pre-fix reading, and it reclaims a live fire's own lease.
 * Kept permanently as a control so a regression cannot pass by accident.
 */
const pidOnly = (o: string, _inFlight: ReadonlySet<string>, selfPid: number): boolean =>
  parseGitSyncOwnerPid(o) === selfPid;

describe('isOrphanedSelfOwner', () => {
  it('calls a lease from this process an orphan when no fire here still holds it', () => {
    // The freeze case: the fire is gone, the process is alive, the row remains.
    expect(isOrphanedSelfOwner(owner(SELF, 'gone'), new Set(), SELF)).toBe(true);
  });

  it('does NOT touch a lease a live fire in this process still holds', () => {
    // Calibration: without this, the fix would reclaim the lock out from under
    // a running commit — strictly worse than the bug it replaces.
    const live = owner(SELF, 'running');
    expect(isOrphanedSelfOwner(live, new Set([live]), SELF)).toBe(false);
  });

  it('does NOT touch a lease held by a DIFFERENT process', () => {
    // Calibration: a peer operator's lease is not ours to judge — its liveness
    // is unknown to us, so the TTL and the dead-PID reclaim stay in charge.
    expect(isOrphanedSelfOwner(owner(SELF + 1, 'peer'), new Set(), SELF)).toBe(false);
  });

  it('does NOT touch an owner string that is not a git-sync fire owner', () => {
    // parseGitSyncOwnerPid returns null for legacy UUID-only and unrelated
    // owners, which must keep ordinary back-pressure semantics.
    expect(isOrphanedSelfOwner('some-agent-lock-owner', new Set(), SELF)).toBe(false);
    expect(isOrphanedSelfOwner(`system:other:${SELF}:x`, new Set(), SELF)).toBe(false);
  });

  it('is not satisfied by the pid-only reading (the control is weaker)', () => {
    // Proves the guard has teeth: on a LIVE fire's lease the two implementations
    // disagree, so a regression to pid-only cannot pass the suite above.
    const live = owner(SELF, 'running');
    const inFlight = new Set([live]);
    expect(pidOnly(live, inFlight, SELF)).toBe(true);
    expect(isOrphanedSelfOwner(live, inFlight, SELF)).toBe(false);
  });
});
