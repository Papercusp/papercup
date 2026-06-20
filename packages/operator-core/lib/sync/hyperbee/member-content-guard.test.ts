/**
 * member-content-guard.test.ts — WI-259 P-002 membership-aware content guard (su-c2a63).
 *
 * Pins the decision table that replaces the bare `if (row.harness_slug !== opts.harnessSlug)
 * return;` on the six shared-hive content projections: own-slug always applies; a cross-member
 * op applies iff its author device-identity pubkey ∈ the hive's current member device set; a
 * non-member / no-author / non-hive cross-slug op drops (fail-closed). The own-slug hot path
 * must do NO member resolve.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shouldApplyMemberContentOp, type MemberContentGuardOpts } from './member-content-guard';
import { _clearHiveMemberDeviceSetCacheForTest } from './hive-member-identity-set';
import type { listHiveMembers } from '../../hive-membership-store';

const HIVE_OPTS: MemberContentGuardOpts = {
  workspaceId: 'ws',
  harnessSlug: 'member-b',
  hiveHomeSlug: 'hive-home',
};

// loadMembers stub: members A + B are in the hive, each with one device pubkey.
const MEMBERS = [
  { deviceAttestations: [{ device_pubkey: 'A_DEV' }] },
  { deviceAttestations: [{ device_pubkey: 'B_DEV' }] },
] as unknown as Awaited<ReturnType<typeof listHiveMembers>>;
const deps = () => ({ loadMembers: async () => MEMBERS, now: () => 1000 });

describe('WI-259 P-002 — membership-aware content guard', () => {
  beforeEach(() => _clearHiveMemberDeviceSetCacheForTest());

  it('own-slug op → applies, and does NO member resolve (hot path short-circuits)', async () => {
    const loadMembers = vi.fn(async () => MEMBERS);
    const r = await shouldApplyMemberContentOp('member-b', HIVE_OPTS, 'B_DEV', { loadMembers, now: () => 1000 });
    expect(r).toBe(true);
    expect(loadMembers).not.toHaveBeenCalled();
  });

  it('cross-member op authored by a CURRENT member → applies', async () => {
    expect(await shouldApplyMemberContentOp('member-a', HIVE_OPTS, 'A_DEV', deps())).toBe(true);
  });

  it('cross-member op authored by a NON-member → drops', async () => {
    expect(await shouldApplyMemberContentOp('member-x', HIVE_OPTS, 'X_DEV', deps())).toBe(false);
  });

  it('cross-slug op on a NON-hive harness (no hiveHomeSlug) → drops', async () => {
    const nonHive: MemberContentGuardOpts = { workspaceId: 'ws', harnessSlug: 'member-b' };
    expect(await shouldApplyMemberContentOp('member-a', nonHive, 'A_DEV', deps())).toBe(false);
  });

  it('cross-member op with NO author pubkey → drops (fail-closed)', async () => {
    expect(await shouldApplyMemberContentOp('member-a', HIVE_OPTS, null, deps())).toBe(false);
    expect(await shouldApplyMemberContentOp('member-a', HIVE_OPTS, undefined, deps())).toBe(false);
  });
});
