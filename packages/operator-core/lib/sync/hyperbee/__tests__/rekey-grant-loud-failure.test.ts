/**
 * rekey-grant-loud-failure.test.ts — WI-280 part B (+ ee7e9's emission), at the upsertHiveMember seam.
 *
 * The owner's re-key epoch-key grant to a member (grantEpochKeysToMembers, fired best-effort from
 * upsertHiveMember — the single grant seam the open-mode admit AND approve paths funnel through) must
 * not fail SILENTLY: the live C-001 witness's K-stage minted 0 keys for exactly this (sodium-native
 * unresolved → deriveEpochKey/wrapKeyToMember threw, swallowed by the best-effort catch).
 *
 * This pins the LOUD behavior at the SOURCE (upsertHiveMember), DECOUPLED from the volatile admit
 * wiring (which has rerouted → FK-gated → hive-home-redirected across this work; its end-to-end is
 * covered by the live two-instance witness, not this unit):
 *   • a grant that THROWS → a queryable `rekey_grant_failed` boot event (part B), AND the membership
 *     write still succeeds (the grant is fire-and-forget — a throw must never fail the row).
 *   • a grant that SILENTLY returns {applied:false} → `rekey_grant_skipped` with the reason (ee7e9's
 *     result-check — the non-throw 0-keys path part B's catch cannot see; the actual WI-280 root).
 *
 * Hermetic: the grant module + the org-PG INSERT are stubbed (no PG, no crypto).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

// Force the grant to THROW (sodium-native unresolved class). isHiveRekeyEnabled → true so the grant
// path is taken. Test 2 overrides this once for the silent {applied:false} skip path.
vi.mock('../hive-epoch-boundary-wiring', () => ({
  grantEpochKeysToMembers: vi.fn(async () => {
    throw new Error('sodium-native unresolved (test) — deriveEpochKey throw');
  }),
  isHiveRekeyEnabled: vi.fn(async () => true),
}));

// Stub the org PG so upsertHiveMember's hive_members INSERT returns a fake row (the hermetic test has
// no real PG). The INSERT echoes its params back as the RETURNING row (valid for rowToRecord).
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  const stubSql = {
    unsafe: async (_q: string, params: readonly unknown[] = []) => [
      {
        workspace_id: params[0],
        hive_home_slug: params[1],
        github_user_id: params[2],
        github_username: params[3],
        display_name: params[4] ?? null,
        avatar_url: params[5] ?? null,
        device_attestations: params[6] ?? '[]',
        revoked_pubkeys: params[7] ?? [],
        binding_status: params[8] ?? 'unverified',
      },
    ],
  };
  return {
    ...actual,
    getOrgPg: (() => ({ sql: stubSql })) as unknown as typeof actual.getOrgPg,
  };
});

import { upsertHiveMember } from '../../../hive-membership-store';
import { grantEpochKeysToMembers } from '../hive-epoch-boundary-wiring';
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';

const WS = 'ws-rekey-loud';
const HIVE = 'rekey-loud';

afterEach(() => {
  _resetBootHistoryForTests();
  vi.clearAllMocks();
});

/** A member with one bound device → upsertHiveMember runs the grant (newMemberPubkeys.length > 0). */
const member = {
  workspaceId: WS,
  potHomeSlug: HIVE,
  githubUserId: 42,
  githubUsername: 'alice',
  deviceAttestations: [
    { device_pubkey: 'pk-b', gist_id: 'g', gist_url: '', device_label: 'd', created_at: 1, signature_by_device: 's' },
  ],
};

describe('WI-280 part B — re-key grant failure is LOUD, not swallowed (at the upsertHiveMember seam)', () => {
  it('records a rekey_grant_failed boot event when the grant THROWS, and still writes the member', async () => {
    // part B ALSO logs the throw loudly via console.error (the stack); vitest-fail-on-console would
    // fail on it, so spy it (suppress + assert) — the loud log is the intended behavior.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const rec = await upsertHiveMember(member);
    // The membership write succeeded despite the grant throw (best-effort: a grant throw never fails the row).
    expect(rec.githubUserId).toBe(42);

    const events = listBootHistory({ workspaceId: WS, harnessSlug: HIVE, kinds: ['rekey_grant_failed'], limit: 5 });
    expect(events.length, 'rekey_grant_failed boot event recorded (not silently swallowed)').toBeGreaterThan(0);
    expect(events[0].message).toContain('grantEpochKeysToMembers on upsertHiveMember failed');

    // The loud console.error (with the stack) also fired — the failure is no longer message-only / swallowed.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('grantEpochKeysToMembers on upsertHiveMember failed'),
    );
  });

  it('records a rekey_grant_skipped boot event (with the reason) when the grant SILENTLY returns {applied:false}', async () => {
    // The NON-THROW 0-keys path — the actual WI-280 root (flag-disabled). The grant returns
    // {applied:false, reason} WITHOUT throwing, so part B's throw catch never sees it; ee7e9's
    // result-check in upsertHiveMember emits rekey_grant_skipped so a 0-keys run NAMES the cause.
    vi.mocked(grantEpochKeysToMembers).mockImplementationOnce(async () => ({
      applied: false,
      reason: 'flag-disabled',
    }));

    const rec = await upsertHiveMember(member);
    expect(rec.githubUserId).toBe(42);

    const events = listBootHistory({ workspaceId: WS, harnessSlug: HIVE, kinds: ['rekey_grant_skipped'], limit: 5 });
    expect(events.length, 'rekey_grant_skipped boot event recorded (the silent 0-keys path is named)').toBeGreaterThan(0);
    expect(events[0].message).toContain('flag-disabled'); // the WHICH-return reason is surfaced
  });
});
