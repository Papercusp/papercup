import { describe, expect, it } from 'vitest';
import { appendGovernanceVote, createGovernanceRound, finalizeGovernanceRound, rebuildGovernanceRound, type GovernanceVoteEvent } from './governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from './plan-admission-policy';

const round = createGovernanceRound({ roundId: 'r-1', planRevisionHash: 'sha256:plan', policyVersion: 1, eligibleMemberIds: ['a', 'b'], createdAtMs: 1_000 });
const vote = (memberId: string, sequence: number, eventId = `e-${memberId}`): GovernanceVoteEvent => ({ eventId, roundId: 'r-1', memberId, choice: 'approve', sequence, signature: 'sig' });

describe('governance round records', () => {
  it('snapshots membership, appends immutable votes, and finalizes a certificate', () => {
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    const first = appendGovernanceVote(round.value, [], vote('a', 1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = appendGovernanceVote(round.value, first.value, vote('b', 2));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const cert = finalizeGovernanceRound({ round: round.value, events: second.value, policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000 });
    expect(cert).toMatchObject({ ok: true, value: { admitted: true, certificateHash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  });

  it('rebuilds deterministically and rejects duplicate/unknown votes', () => {
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    const rebuilt = rebuildGovernanceRound(round.value, [vote('b', 2), vote('a', 1)]);
    expect(rebuilt).toMatchObject({ ok: true, value: [{ memberId: 'a' }, { memberId: 'b' }] });
    if (!rebuilt.ok) return;
    expect(appendGovernanceVote(round.value, rebuilt.value, vote('a', 3, 'e-duplicate'))).toMatchObject({ ok: false, code: 'duplicate-event' });
    expect(appendGovernanceVote(round.value, rebuilt.value, vote('mallory', 3, 'e-m'))).toMatchObject({ ok: false, code: 'unknown-member' });
  });
});
