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
  type MembershipAdmissionDeps,
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
  const deps: MembershipAdmissionDeps = {
    getPolicy: async () => policy,
    recordPendingJoin: recordPendingJoin as never,
    upsertHiveMember: upsertHiveMember as never,
    setPendingJoinDecision: setPendingJoinDecision as never,
    ...over,
  };
  return { deps, recordPendingJoin, upsertHiveMember, setPendingJoinDecision };
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
