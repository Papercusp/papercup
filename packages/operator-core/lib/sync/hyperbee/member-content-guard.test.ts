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
import { shouldApplyMemberContentOp, decideMemberContentOp, type MemberContentGuardOpts } from './member-content-guard';
import { _clearHiveMemberDeviceSetCacheForTest } from './hive-member-identity-set';
import type { listHiveMembers } from '../../hive-membership-store';

const HIVE_OPTS: MemberContentGuardOpts = {
  workspaceId: 'ws',
  harnessSlug: 'member-b',
  potHomeSlug: 'hive-home',
};

// loadMembers stub: members A + B are in the hive, each with one device pubkey.
const MEMBERS = [
  { deviceAttestations: [{ device_pubkey: 'A_DEV' }] },
  { deviceAttestations: [{ device_pubkey: 'B_DEV' }] },
] as unknown as Awaited<ReturnType<typeof listHiveMembers>>;
// `loadRevoked` MUST be stubbed: the apply branch consults the revocation set (EI-1895), and
// the module's default is the real `loadRevokedHivePubkeysForLocalPot`, which opens a live PG
// pool. Leaving it unset made this a unit test reading the developer's database — the exact
// hazard the forbid-real-PG rail catches [EI-19311807188719573].
const deps = (revoked: string[] = []) => ({
  loadMembers: async () => MEMBERS,
  now: () => 1000,
  loadRevoked: async () => new Set(revoked),
});

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

  it('cross-member op authored by a REVOKED member → HARD-drops, never defers (EI-1895)', async () => {
    // A revoked device still appears in the member set (listHiveMembers does not filter it), so
    // this branch is the only thing stopping a revoked peer's write from applying.
    expect(await shouldApplyMemberContentOp('member-a', HIVE_OPTS, 'A_DEV', deps(['A_DEV']))).toBe(false);
    expect(await decideMemberContentOp('member-a', HIVE_OPTS, 'A_DEV', deps(['A_DEV']))).toBe('drop');
  });

  it('cross-member op authored by a NON-member → drops', async () => {
    expect(await shouldApplyMemberContentOp('member-x', HIVE_OPTS, 'X_DEV', deps())).toBe(false);
  });

  it('cross-slug op on a NON-hive harness (no potHomeSlug) → drops', async () => {
    const nonHive: MemberContentGuardOpts = { workspaceId: 'ws', harnessSlug: 'member-b' };
    expect(await shouldApplyMemberContentOp('member-a', nonHive, 'A_DEV', deps())).toBe(false);
  });

  it('cross-member op with NO author pubkey → drops (fail-closed)', async () => {
    expect(await shouldApplyMemberContentOp('member-a', HIVE_OPTS, null, deps())).toBe(false);
    expect(await shouldApplyMemberContentOp('member-a', HIVE_OPTS, undefined, deps())).toBe(false);
  });
});

describe('EI-1895 — a REVOKED member\'s write is hard-dropped, never applied or deferred', () => {
  beforeEach(() => _clearHiveMemberDeviceSetCacheForTest());

  // `listHiveMembers` (the real loadMembers) does NOT filter revoked device pubkeys out of
  // deviceAttestations — A_DEV is still "in the member set" here even though its owner was
  // revoked, mirroring the real bug: revocation is tracked separately from the member set.
  const depsWithRevoked = (revokedPubkeys: string[]) => ({
    loadMembers: async () => MEMBERS,
    now: () => 1000,
    loadRevoked: async () => new Set(revokedPubkeys),
  });

  it('a cross-member op whose author IS a current member but IS revoked → drops (not apply)', async () => {
    const decision = await decideMemberContentOp('member-a', HIVE_OPTS, 'A_DEV', depsWithRevoked(['A_DEV']));
    expect(decision).toBe('drop');
    expect(await shouldApplyMemberContentOp('member-a', HIVE_OPTS, 'A_DEV', depsWithRevoked(['A_DEV']))).toBe(false);
  });

  it('a cross-member op whose author is a current, NON-revoked member → still applies (no regression)', async () => {
    expect(await shouldApplyMemberContentOp('member-a', HIVE_OPTS, 'A_DEV', depsWithRevoked(['X_DEV']))).toBe(true);
  });

  it('the revoked-pubkey check is NOT consulted on the own-slug hot path or the non-member drop/defer paths', async () => {
    const loadRevoked = vi.fn(async () => new Set(['A_DEV']));
    // Own-slug: short-circuits before any membership/revocation work.
    await shouldApplyMemberContentOp('member-b', HIVE_OPTS, 'B_DEV', {
      loadMembers: async () => MEMBERS, now: () => 1000, loadRevoked,
    });
    expect(loadRevoked).not.toHaveBeenCalled();
    // A genuine non-member (not in the member set at all) — already defers/drops without
    // needing the revoked-pubkey lookup.
    await shouldApplyMemberContentOp('member-x', HIVE_OPTS, 'X_DEV', {
      loadMembers: async () => MEMBERS, now: () => 1000, loadRevoked,
    });
    expect(loadRevoked).not.toHaveBeenCalled();
  });
});
