/**
 * hive-revoke-contributor.boundary-skip.test.ts — WI-280 boundary loud-signal.
 *
 * revokeHiveContributor's epoch-advance can be SKIPPED silently: an early-return
 * (no_target / not_owner / ...) so advanceEpochOnHiveBoundary is never reached, OR the advance
 * itself no-op'd (live:false). The live witness's K2 revoke went 0→0 and cost a manual trace to
 * the no_target early-return (hive-revoke-contributor.ts:98) to root-cause. This pins the loud
 * signal — a queryable `rekey_boundary_skipped` boot event naming WHY — mirroring rekey_grant_skipped
 * for the grant path. Best-effort: the boot-event write must NEVER change the revoke result.
 *
 * Seam-injected + hermetic (no PG, no crypto): the wrapper only inspects the inner's result.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { revokeHiveContributor } from './hive-revoke-contributor';
import { listBootHistory, _resetBootHistoryForTests } from './sync/hyperbee/boot-history';

const WS = 'ws-boundary-skip';
const HIVE = 'hive-boundary-skip';

afterEach(() => {
  _resetBootHistoryForTests();
});

function skips() {
  return listBootHistory({ workspaceId: WS, harnessSlug: HIVE, kinds: ['rekey_boundary_skipped'], limit: 5 });
}

function applieds() {
  return listBootHistory({ workspaceId: WS, harnessSlug: HIVE, kinds: ['rekey_boundary_applied'], limit: 5 });
}

describe('WI-280 boundary loud-signal — a skipped revoke epoch-advance is NAMED, not silent', () => {
  it('records rekey_boundary_skipped(no_target) when the revoke target has no devices (the witness K2 root)', async () => {
    const result = await revokeHiveContributor(
      { workspaceId: WS, potHomeSlug: HIVE, githubUserId: 42 },
      {
        isOwningSwarm: async () => true,
        resolveOwnerGithubUserId: async () => 1,
        loadTargetPubkeys: async () => [], // empty → no_target → advanceEpochOnHiveBoundary never reached
      },
    );
    expect(result).toEqual({ ok: false, code: 'no_target' });
    const events = skips();
    expect(events.length, 'rekey_boundary_skipped recorded (the silent 0→0 is named)').toBeGreaterThan(0);
    expect(events[0].message).toContain('no_target'); // the WHICH-skip reason is surfaced
  });

  it("records rekey_boundary_skipped(advance-not-applied) when the revoke succeeds but the boundary advance no-op'd (flag off / no-author)", async () => {
    const result = await revokeHiveContributor(
      { workspaceId: WS, potHomeSlug: HIVE, githubUserId: 42 },
      {
        isOwningSwarm: async () => true,
        resolveOwnerGithubUserId: async () => 1,
        loadTargetPubkeys: async () => ['pk-b'],
        publishRevocation: async () => ({ live: false }), // PG write ok, advance no-op'd → live:false
      },
    );
    expect(result).toEqual({ ok: true, revokedPubkeys: ['pk-b'], live: false });
    const events = skips();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].message).toContain('advance-not-applied');
  });

  it('WI-6043: propagates the boundary REASON on live:false — the caller can name WHICH of the five early-returns fired', async () => {
    // Regression guard for the diagnostic gap that made every revocation_kcut FAIL run
    // unattributable: advanceEpochOnHiveBoundary computed `reason`, and realPublishRevocation
    // dropped it, so a live:false revoke reported only the hardcoded 'advance-not-applied'.
    // A FAIL is scarce (leaks on ~1 in 3-5 rig runs), so an unattributable one is a wasted run.
    const result = await revokeHiveContributor(
      { workspaceId: WS, potHomeSlug: HIVE, githubUserId: 42 },
      {
        isOwningSwarm: async () => true,
        resolveOwnerGithubUserId: async () => 1,
        loadTargetPubkeys: async () => ['pk-b'],
        // 'no-author' = loadHivePubkey returned null. Per-run state, so it is a candidate
        // mechanism for the INTERMITTENT post-ban leak — indistinguishable from the other
        // four causes until the reason survives this hop.
        publishRevocation: async () => ({ live: false, reason: 'no-author' as const }),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live).toBe(false);
    expect(result.reason, 'the boundary reason reaches the revoke caller').toBe('no-author');

    const events = skips();
    expect(events.length).toBeGreaterThan(0);
    // The boot event NAMES the cause rather than restating what live:false already said.
    expect(events[0].message).toContain('reason=no-author');
  });

  it('does NOT record a skip on the happy path (revoke live, boundary advanced) — records rekey_boundary_applied instead (WI-6043)', async () => {
    const result = await revokeHiveContributor(
      { workspaceId: WS, potHomeSlug: HIVE, githubUserId: 42 },
      {
        isOwningSwarm: async () => true,
        resolveOwnerGithubUserId: async () => 1,
        loadTargetPubkeys: async () => ['pk-b'],
        // advance applied → live:true, epoch advanced to 1, wrapped to 2 remaining members
        publishRevocation: async () => ({ live: true, newEpoch: 1, distributed: 2 }),
      },
    );
    expect(result).toEqual({ ok: true, revokedPubkeys: ['pk-b'], live: true, newEpoch: 1, distributed: 2 });
    expect(skips().length, 'no skip event on the happy path').toBe(0);
    const events = applieds();
    expect(events.length, 'rekey_boundary_applied recorded — the success path is no longer silent').toBe(1);
    expect(events[0].message).toContain('newEpoch=1');
    expect(events[0].message).toContain('distributed=2');
  });

  it('names skippedDevicePubkeys on a WI-6044 partial success (still live:true, some devices unwrappable)', async () => {
    const result = await revokeHiveContributor(
      { workspaceId: WS, potHomeSlug: HIVE, githubUserId: 42 },
      {
        isOwningSwarm: async () => true,
        resolveOwnerGithubUserId: async () => 1,
        loadTargetPubkeys: async () => ['pk-b'],
        publishRevocation: async () => ({
          live: true,
          newEpoch: 2,
          distributed: 1,
          skippedDevicePubkeys: ['pk-creator'], // WI-6044: one malformed device skipped, boundary still applied
        }),
      },
    );
    expect(result).toMatchObject({ ok: true, live: true, newEpoch: 2, distributed: 1, skippedDevicePubkeys: ['pk-creator'] });
    expect(skips().length, 'still a success — no skip event').toBe(0);
    const events = applieds();
    expect(events.length).toBe(1);
    expect(events[0].message).toContain('skippedDevices=1');
    expect(events[0].message).toContain('WI-6044');
  });
});
