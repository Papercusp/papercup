/**
 * Teeth-verified unit tests for the P-MOD moderation core (hive-moderation.ts).
 *
 * The takedown FILTER is the no-resurrection enforcement: a taken-down ref is dropped
 * on every read (so re-federated content stays hidden); neutering filterTakenDownContent
 * → the taken-down row survives → RED. The owner actions' mutate fns are applied to a
 * sample policy to assert the append/dedupe/remove logic + that unknown keys survive.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HivePolicy } from './hive-policy-schema';
import {
  isContentTakenDown,
  filterTakenDownContent,
  takedownContent,
  restoreContent,
  banMember,
  unbanMember,
} from './hive-moderation';

describe('isContentTakenDown / filterTakenDownContent (no-resurrection enforcement)', () => {
  const policy: HivePolicy = { moderation: { takedownList: ['F-1', ' F-2 '] } };

  it('isContentTakenDown: matches (trim-tolerant); false on empty/absent', () => {
    expect(isContentTakenDown(policy, 'F-1')).toBe(true);
    expect(isContentTakenDown(policy, 'F-2')).toBe(true); // stored with whitespace
    expect(isContentTakenDown(policy, 'F-3')).toBe(false);
    expect(isContentTakenDown({ moderation: {} }, 'F-1')).toBe(false);
    expect(isContentTakenDown(null, 'F-1')).toBe(false);
  });

  it('filterTakenDownContent DROPS taken-down rows  ← RED if the filter is neutered', () => {
    const rows = [{ id: 'F-1' }, { id: 'F-2' }, { id: 'F-3' }];
    const visible = filterTakenDownContent(policy, rows, (r) => r.id);
    expect(visible).toEqual([{ id: 'F-3' }]);
  });

  it('no policy / empty takedownList ⇒ rows unchanged (existing hives unaffected)', () => {
    const rows = [{ id: 'F-1' }, { id: 'F-2' }];
    expect(filterTakenDownContent(null, rows, (r) => r.id)).toEqual(rows);
    expect(filterTakenDownContent({ moderation: {} }, rows, (r) => r.id)).toEqual(rows);
  });
});

/** A fake mutateHivePolicy that applies the caller's mutate fn to `current` and returns
 *  the resulting policy, so tests can assert the mutation logic exactly. */
function fakeMutate(current: HivePolicy) {
  return vi.fn(async (input: { mutate: (p: HivePolicy) => HivePolicy }) => ({
    ok: true as const,
    policy: { policy: input.mutate(current) } as never,
  }));
}

describe('takedownContent — appends to the signed takedownList (idempotent)', () => {
  it('appends the ref; preserves unknown keys', async () => {
    const mutate = fakeMutate({ membership: 'open', moderation: { reportable: true }, futureKey: 1 } as HivePolicy);
    const res = await takedownContent(
      { workspaceId: 'w', potHomeSlug: 'h', contentRef: 'F-9' },
      { mutateHivePolicy: mutate as never },
    );
    const next = (res as { policy: { policy: HivePolicy } }).policy.policy;
    expect(next.moderation?.takedownList).toEqual(['F-9']);
    expect(next.moderation?.reportable).toBe(true); // existing moderation preserved
    expect((next as Record<string, unknown>).futureKey).toBe(1); // forward-compat key preserved
  });

  it('does NOT duplicate an already-taken-down ref', async () => {
    const mutate = fakeMutate({ moderation: { takedownList: ['F-9'] } });
    await takedownContent({ workspaceId: 'w', potHomeSlug: 'h', contentRef: 'F-9' }, {
      mutateHivePolicy: mutate as never,
    });
    const next = (await (mutate.mock.results[0].value as Promise<{ policy: { policy: HivePolicy } }>)).policy.policy;
    expect(next.moderation?.takedownList).toEqual(['F-9']);
  });
});

describe('restoreContent — removes a ref from the takedown list', () => {
  it('removes the ref', async () => {
    const mutate = fakeMutate({ moderation: { takedownList: ['F-1', 'F-2'] } });
    const res = await restoreContent(
      { workspaceId: 'w', potHomeSlug: 'h', contentRef: 'F-1' },
      { mutateHivePolicy: mutate as never },
    );
    const next = (res as { policy: { policy: HivePolicy } }).policy.policy;
    expect(next.moderation?.takedownList).toEqual(['F-2']);
  });
});

describe('banMember — appends ban + calls revoke (the teeth)', () => {
  it('appends bannedGithubIds AND calls revokeHiveContributor', async () => {
    const mutate = fakeMutate({ moderation: {} });
    const revoke = vi.fn(async () => ({ ok: true as const, revokedPubkeys: ['k1'], live: false }));
    const res = await banMember(
      { workspaceId: 'w', potHomeSlug: 'h', githubUserId: 6666 },
      { mutateHivePolicy: mutate as never, revokeHiveContributor: revoke as never },
    );
    const next = (res.policy as { policy: { policy: HivePolicy } }).policy.policy;
    expect(next.moderation?.bannedGithubIds).toEqual(['6666']);
    expect(revoke).toHaveBeenCalledWith({ workspaceId: 'w', potHomeSlug: 'h', githubUserId: 6666 });
    expect(res.revoke).toMatchObject({ ok: true, live: false }); // re-key not wired yet → live:false
  });

  it('revoke:false ⇒ bans (policy) but SKIPS revoke', async () => {
    const mutate = fakeMutate({ moderation: {} });
    const revoke = vi.fn();
    const res = await banMember(
      { workspaceId: 'w', potHomeSlug: 'h', githubUserId: 6666, revoke: false },
      { mutateHivePolicy: mutate as never, revokeHiveContributor: revoke as never },
    );
    expect(res.revoke).toEqual({ skipped: true });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('policy write fails (not owner) ⇒ revoke SKIPPED', async () => {
    const mutate = vi.fn(async () => ({ ok: false as const, code: 'not_owner_swarm' as const }));
    const revoke = vi.fn();
    const res = await banMember(
      { workspaceId: 'w', potHomeSlug: 'h', githubUserId: 6666 },
      { mutateHivePolicy: mutate as never, revokeHiveContributor: revoke as never },
    );
    expect(res.policy.ok).toBe(false);
    expect(res.revoke).toEqual({ skipped: true });
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe('unbanMember — removes from the ban list', () => {
  it('removes the github id', async () => {
    const mutate = fakeMutate({ moderation: { bannedGithubIds: ['6666', '7777'] } });
    const res = await unbanMember(
      { workspaceId: 'w', potHomeSlug: 'h', githubUserId: 6666 },
      { mutateHivePolicy: mutate as never },
    );
    const next = (res as { policy: { policy: HivePolicy } }).policy.policy;
    expect(next.moderation?.bannedGithubIds).toEqual(['7777']);
  });
});
