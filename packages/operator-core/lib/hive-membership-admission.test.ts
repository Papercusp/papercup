/**
 * Orchestration unit tests for the P-MEMBER admission flow
 * (hive-membership-admission.ts) — injected fakes, no PG.
 *
 * Verifies the gate routes admit/pending/refuse correctly off the policy, records a
 * pending request ONLY in approval mode, and that approve trust-admits (upsertHiveMember
 * with the captured devices) while deny never does. The pure decision itself is covered
 * by hive-membership-policy.test.ts; this guards the WIRING + side effects.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HivePolicy } from './hive-policy-schema';
import {
  evaluateJoinAdmission,
  approvePendingJoin,
  denyPendingJoin,
  ownerAdmitOrPend,
  admitAnnouncedPeerAsOwner,
  type MembershipAdmissionDeps,
  type AdmitAnnouncedPeerDeps,
} from './hive-membership-admission';
import type { PendingJoinRecord } from './hive-pending-joins-store';

const joiner = {
  githubUserId: 1001,
  githubUsername: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
  deviceAttestations: [{ device_pubkey: 'devA', gist_url: 'g', signature: 's' }] as never[],
};

function depsWith(policy: HivePolicy | null, over: Partial<MembershipAdmissionDeps> = {}): {
  deps: MembershipAdmissionDeps;
  recordPendingJoin: ReturnType<typeof vi.fn>;
  upsertHiveMember: ReturnType<typeof vi.fn>;
  setPendingJoinDecision: ReturnType<typeof vi.fn>;
  refederateMemberEpochKeys: ReturnType<typeof vi.fn>;
} {
  const recordPendingJoin = vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    status: 'pending',
    reason: null,
    requestedAt: 1,
    decidedAt: null,
    decidedByGithubUserId: null,
  })) as ReturnType<typeof vi.fn>;
  const upsertHiveMember = vi.fn(async (input: Record<string, unknown>) => ({ ...input })) as ReturnType<
    typeof vi.fn
  >;
  const setPendingJoinDecision = vi.fn(
    async (
      _ws: string,
      _home: string,
      githubUserId: number,
      status: string,
      decidedBy: number,
      reason?: string | null,
    ) => ({ githubUserId, status, decidedByGithubUserId: decidedBy, reason: reason ?? null }),
  ) as ReturnType<typeof vi.fn>;
  // BUG B (D-028) reconnect re-grant seam — a no-op spy by default so the default impl
  // (which dynamic-imports the boundary-wiring) never runs in these hermetic unit tests.
  const refederateMemberEpochKeys = vi.fn(async () => {}) as ReturnType<typeof vi.fn>;
  const deps: MembershipAdmissionDeps = {
    getPolicy: async () => policy,
    recordPendingJoin: recordPendingJoin as never,
    upsertHiveMember: upsertHiveMember as never,
    setPendingJoinDecision: setPendingJoinDecision as never,
    refederateMemberEpochKeys: refederateMemberEpochKeys as never,
    ...over,
  };
  return { deps, recordPendingJoin, upsertHiveMember, setPendingJoinDecision, refederateMemberEpochKeys };
}

describe('evaluateJoinAdmission — routes off the policy', () => {
  it('open/null policy ⇒ admit, NO pending recorded', async () => {
    const { deps, recordPendingJoin } = depsWith(null);
    const out = await evaluateJoinAdmission({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out).toEqual({ outcome: 'admit' });
    expect(recordPendingJoin).not.toHaveBeenCalled();
  });

  it('approval ⇒ pending, request RECORDED with the joiner devices', async () => {
    const { deps, recordPendingJoin } = depsWith({ membership: 'approval' });
    const out = await evaluateJoinAdmission({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out.outcome).toBe('pending');
    expect(recordPendingJoin).toHaveBeenCalledTimes(1);
    const arg = recordPendingJoin.mock.calls[0][0];
    expect(arg).toMatchObject({
      workspaceId: 'w',
      hiveHomeSlug: 'h',
      githubUserId: 1001,
      deviceAttestations: joiner.deviceAttestations,
    });
  });

  it('allowlist non-listed ⇒ refuse(not_allowlisted), NO pending, NO admit', async () => {
    const { deps, recordPendingJoin, upsertHiveMember } = depsWith({
      membership: 'allowlist',
      allowlist: ['someone-else'],
    });
    const out = await evaluateJoinAdmission({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out).toEqual({ outcome: 'refuse', reason: 'not_allowlisted' });
    expect(recordPendingJoin).not.toHaveBeenCalled();
    expect(upsertHiveMember).not.toHaveBeenCalled();
  });

  it('banned ⇒ refuse(banned) even in open mode', async () => {
    const { deps } = depsWith({ membership: 'open', moderation: { bannedGithubIds: ['1001'] } });
    const out = await evaluateJoinAdmission({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out).toEqual({ outcome: 'refuse', reason: 'banned' });
  });
});

describe('approvePendingJoin — trust-admits the joiner', () => {
  it('approve ⇒ upsertHiveMember(with captured devices) + status approved', async () => {
    const pending: PendingJoinRecord = {
      workspaceId: 'w',
      hiveHomeSlug: 'h',
      githubUserId: 1001,
      githubUsername: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      deviceAttestations: joiner.deviceAttestations,
      status: 'pending',
      reason: null,
      requestedAt: 1,
      decidedAt: null,
      decidedByGithubUserId: null,
    };
    const { deps, upsertHiveMember, setPendingJoinDecision } = depsWith(null, {
      getPendingJoin: (async () => pending) as never,
    });
    const res = await approvePendingJoin(
      { workspaceId: 'w', hiveHomeSlug: 'h', githubUserId: 1001, decidedByGithubUserId: 9 },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ status: 'approved' });
    expect(upsertHiveMember).toHaveBeenCalledTimes(1);
    expect(upsertHiveMember.mock.calls[0][0]).toMatchObject({
      githubUserId: 1001,
      deviceAttestations: joiner.deviceAttestations,
      bindingStatus: 'verified',
    });
    expect(setPendingJoinDecision).toHaveBeenCalledWith('w', 'h', 1001, 'approved', 9, null, undefined);
  });

  it('approve with NO pending row ⇒ no_pending, never trust-admits', async () => {
    const { deps, upsertHiveMember } = depsWith(null, { getPendingJoin: (async () => null) as never });
    const res = await approvePendingJoin(
      { workspaceId: 'w', hiveHomeSlug: 'h', githubUserId: 1001, decidedByGithubUserId: 9 },
      deps,
    );
    expect(res).toEqual({ ok: false, code: 'no_pending' });
    expect(upsertHiveMember).not.toHaveBeenCalled();
  });
});

describe('denyPendingJoin — never trust-admits', () => {
  it('deny ⇒ status denied (with reason), NO upsertHiveMember', async () => {
    const { deps, upsertHiveMember, setPendingJoinDecision } = depsWith(null);
    const res = await denyPendingJoin(
      { workspaceId: 'w', hiveHomeSlug: 'h', githubUserId: 1001, decidedByGithubUserId: 9, reason: 'spam' },
      deps,
    );
    expect(res).toMatchObject({ ok: true, status: 'denied' });
    expect(setPendingJoinDecision).toHaveBeenCalledWith('w', 'h', 1001, 'denied', 9, 'spam', undefined);
    expect(upsertHiveMember).not.toHaveBeenCalled();
  });

  it('deny with NO pending row ⇒ no_pending', async () => {
    const { deps } = depsWith(null, {
      setPendingJoinDecision: (async () => null) as never,
    });
    const res = await denyPendingJoin(
      { workspaceId: 'w', hiveHomeSlug: 'h', githubUserId: 1001, decidedByGithubUserId: 9 },
      deps,
    );
    expect(res).toEqual({ ok: false, code: 'no_pending' });
  });
});

describe('ownerAdmitOrPend — the owner admission seam (WI-639: wires the gate)', () => {
  const memberRow = {
    workspaceId: 'w',
    hiveHomeSlug: 'h',
    githubUserId: 1001,
    githubUsername: 'alice',
    displayName: 'Alice',
    avatarUrl: null,
    deviceAttestations: joiner.deviceAttestations,
    revokedPubkeys: [],
    bindingStatus: 'verified',
  };

  it('ALREADY a member ⇒ refresh (re-upsert), policy gate is NOT consulted even under approval', async () => {
    // approval policy + an already-member peer: must refresh, NOT re-open a pending request.
    const { deps, upsertHiveMember, recordPendingJoin } = depsWith(
      { membership: 'approval' },
      { getHiveMember: (async () => memberRow) as never },
    );
    const out = await ownerAdmitOrPend({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out).toMatchObject({ action: 'admitted', reason: 'already_member' });
    expect(upsertHiveMember).toHaveBeenCalledTimes(1);
    expect(upsertHiveMember.mock.calls[0][0]).toMatchObject({ githubUserId: 1001, bindingStatus: 'verified' });
    expect(recordPendingJoin).not.toHaveBeenCalled();
  });

  it('BUG B (D-028): ALREADY a member ⇒ refederating epoch-key re-grant fires for THIS member device on reconnect', async () => {
    const { deps, refederateMemberEpochKeys } = depsWith(
      { membership: 'approval' },
      { getHiveMember: (async () => memberRow) as never },
    );
    const out = await ownerAdmitOrPend({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out).toMatchObject({ action: 'admitted', reason: 'already_member' });
    expect(refederateMemberEpochKeys).toHaveBeenCalledTimes(1);
    // Re-grant is scoped to the reconnecting member's announced device pubkeys (BUG-B target).
    expect(refederateMemberEpochKeys.mock.calls[0][0]).toEqual({
      workspaceId: 'w',
      hiveHomeSlug: 'h',
      memberDevicePubkeys: ['devA'],
    });
  });

  it('BUG B (D-028): a re-grant THROW is swallowed — never fails the reconnect admission', async () => {
    const { deps } = depsWith(
      { membership: 'approval' },
      {
        getHiveMember: (async () => memberRow) as never,
        refederateMemberEpochKeys: (async () => {
          throw new Error('boundary-wiring blew up');
        }) as never,
      },
    );
    const out = await ownerAdmitOrPend({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out).toMatchObject({ action: 'admitted', reason: 'already_member' });
  });

  it('NOT a member + open/null policy ⇒ trust-admit (upsert), no pending, NO refederate re-grant', async () => {
    const { deps, upsertHiveMember, recordPendingJoin, refederateMemberEpochKeys } = depsWith(null, {
      getHiveMember: (async () => null) as never,
    });
    const out = await ownerAdmitOrPend({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out).toMatchObject({ action: 'admitted', reason: 'policy_admit' });
    expect(upsertHiveMember).toHaveBeenCalledTimes(1);
    expect(recordPendingJoin).not.toHaveBeenCalled();
    // A NEW admit's grant is upsertHiveMember's own [0..current] write-once grant — the
    // refederating re-send is the RECONNECT-only path, so it must NOT fire here.
    expect(refederateMemberEpochKeys).not.toHaveBeenCalled();
  });

  it('NOT a member + approval ⇒ pending (record), NEVER trust-admit', async () => {
    const { deps, upsertHiveMember, recordPendingJoin } = depsWith(
      { membership: 'approval' },
      { getHiveMember: (async () => null) as never },
    );
    const out = await ownerAdmitOrPend({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out.action).toBe('pending');
    expect(recordPendingJoin).toHaveBeenCalledTimes(1);
    expect(upsertHiveMember).not.toHaveBeenCalled();
  });

  it('NOT a member + banned ⇒ refuse, NEVER trust-admit, NO pending', async () => {
    const { deps, upsertHiveMember, recordPendingJoin } = depsWith(
      { membership: 'open', moderation: { bannedGithubIds: ['1001'] } },
      { getHiveMember: (async () => null) as never },
    );
    const out = await ownerAdmitOrPend({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out).toEqual({ action: 'refuse', reason: 'banned' });
    expect(upsertHiveMember).not.toHaveBeenCalled();
    expect(recordPendingJoin).not.toHaveBeenCalled();
  });

  it('NOT a member + allowlist non-listed ⇒ refuse(not_allowlisted), no member, no pending', async () => {
    const { deps, upsertHiveMember, recordPendingJoin } = depsWith(
      { membership: 'allowlist', allowlist: ['someone-else'] },
      { getHiveMember: (async () => null) as never },
    );
    const out = await ownerAdmitOrPend({ workspaceId: 'w', hiveHomeSlug: 'h', joiner }, deps);
    expect(out).toEqual({ action: 'refuse', reason: 'not_allowlisted' });
    expect(upsertHiveMember).not.toHaveBeenCalled();
    expect(recordPendingJoin).not.toHaveBeenCalled();
  });
});

describe('admitAnnouncedPeerAsOwner — boot.ts admission-seam wiring (WI-639)', () => {
  const peer = { githubUserId: 1001, githubLogin: 'alice', devicePubkey: 'devA', attestationGistId: 'g' };
  // Build AdmitAnnouncedPeerDeps over depsWith's membership fakes + the resolve/owner-gate seams.
  function admitDeps(
    policy: HivePolicy | null,
    over: Partial<AdmitAnnouncedPeerDeps> = {},
  ): { deps: AdmitAnnouncedPeerDeps; recordPendingJoin: ReturnType<typeof vi.fn>; upsertHiveMember: ReturnType<typeof vi.fn> } {
    const base = depsWith(policy, { getHiveMember: (async () => null) as never });
    const deps: AdmitAnnouncedPeerDeps = {
      ...base.deps,
      hiveHomeSlugForHarness: async () => 'home',
      loadHivePubkey: async () => 'OWNER_PK',
      ...over,
    };
    return { deps, recordPendingJoin: base.recordPendingJoin, upsertHiveMember: base.upsertHiveMember };
  }

  it('no hive-home ⇒ skip(no_hive_home), no membership decision', async () => {
    const { deps, upsertHiveMember } = admitDeps(null, { hiveHomeSlugForHarness: async () => null });
    const out = await admitAnnouncedPeerAsOwner({ workspaceId: 'w', harnessSlug: 'member', peer }, deps);
    expect(out).toEqual({ action: 'skip', reason: 'no_hive_home' });
    expect(upsertHiveMember).not.toHaveBeenCalled();
  });

  it('not the owner box (no hive key) ⇒ skip(not_owner)', async () => {
    const { deps, upsertHiveMember } = admitDeps(null, { loadHivePubkey: async () => null });
    const out = await admitAnnouncedPeerAsOwner({ workspaceId: 'w', harnessSlug: 'member', peer }, deps);
    expect(out).toEqual({ action: 'skip', reason: 'not_owner' });
    expect(upsertHiveMember).not.toHaveBeenCalled();
  });

  it('owner + open ⇒ admitted(policy_admit) with the resolved hiveHomeSlug', async () => {
    const { deps, upsertHiveMember } = admitDeps(null);
    const out = await admitAnnouncedPeerAsOwner({ workspaceId: 'w', harnessSlug: 'member', peer }, deps);
    expect(out).toEqual({ action: 'admitted', hiveHomeSlug: 'home', reason: 'policy_admit' });
    // The joiner is built from the announce frame: hive-home slug, verified, devA captured.
    expect(upsertHiveMember.mock.calls[0][0]).toMatchObject({
      hiveHomeSlug: 'home',
      githubUserId: 1001,
      githubUsername: 'alice',
      bindingStatus: 'verified',
    });
    expect(upsertHiveMember.mock.calls[0][0].deviceAttestations[0]).toMatchObject({ device_pubkey: 'devA', gist_id: 'g' });
  });

  it('owner + approval ⇒ pending with the resolved hiveHomeSlug, NO upsert', async () => {
    const { deps, recordPendingJoin, upsertHiveMember } = admitDeps({ membership: 'approval' });
    const out = await admitAnnouncedPeerAsOwner({ workspaceId: 'w', harnessSlug: 'member', peer }, deps);
    expect(out).toEqual({ action: 'pending', hiveHomeSlug: 'home' });
    expect(recordPendingJoin).toHaveBeenCalledTimes(1);
    expect(recordPendingJoin.mock.calls[0][0]).toMatchObject({ hiveHomeSlug: 'home', githubUserId: 1001 });
    expect(upsertHiveMember).not.toHaveBeenCalled();
  });

  it('owner + already a member ⇒ admitted(already_member), refresh', async () => {
    const memberRow = { hiveHomeSlug: 'home', githubUserId: 1001, deviceAttestations: [], bindingStatus: 'verified' };
    const { deps, upsertHiveMember } = admitDeps({ membership: 'approval' }, {
      getHiveMember: (async () => memberRow) as never,
    });
    const out = await admitAnnouncedPeerAsOwner({ workspaceId: 'w', harnessSlug: 'member', peer }, deps);
    expect(out).toEqual({ action: 'admitted', hiveHomeSlug: 'home', reason: 'already_member' });
    expect(upsertHiveMember).toHaveBeenCalledTimes(1);
  });

  it('owner + banned ⇒ refuse(banned), NO upsert, NO pending', async () => {
    const { deps, upsertHiveMember, recordPendingJoin } = admitDeps({
      membership: 'open',
      moderation: { bannedGithubIds: ['1001'] },
    });
    const out = await admitAnnouncedPeerAsOwner({ workspaceId: 'w', harnessSlug: 'member', peer }, deps);
    expect(out).toEqual({ action: 'refuse', hiveHomeSlug: 'home', reason: 'banned' });
    expect(upsertHiveMember).not.toHaveBeenCalled();
    expect(recordPendingJoin).not.toHaveBeenCalled();
  });
});
