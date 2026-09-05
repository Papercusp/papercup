import { describe, expect, it } from 'vitest';
import { appendGovernanceVote, createGovernanceRound, finalizeGovernanceRound, rebuildGovernanceRound, verifyFinalizationCertificate, type GovernanceVoteEvent } from './governance-round';
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

describe('finalization consults the weighted vote reducer', () => {
  const weighted = createGovernanceRound({ roundId: 'r-w', planRevisionHash: 'sha256:plan', policyVersion: 1, eligibleMemberIds: ['a', 'b', 'c', 'd'], createdAtMs: 1_000 });
  const ballot = (memberId: string, choice: GovernanceVoteEvent['choice'], sequence: number): GovernanceVoteEvent => ({ eventId: `e-${memberId}`, roundId: 'r-w', memberId, choice, sequence, signature: 'sig' });
  // Unweighted this is 3 approve vs 1 reject — 7500bps, clearing the policy's
  // 6667bps approval bar at full quorum, so the policy alone WOULD admit it.
  const events = [ballot('a', 'approve', 1), ballot('b', 'approve', 2), ballot('c', 'approve', 3), ballot('d', 'reject', 4)];

  it('lets the weighted tally veto an admission the unweighted policy count grants', () => {
    expect(weighted.ok).toBe(true);
    if (!weighted.ok) return;
    // POSITIVE CONTROL: at equal weights the same ballots ARE admitted, so a
    // veto below is the weights talking and not some unrelated refusal.
    const equal = finalizeGovernanceRound({ round: weighted.value, events, policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000 });
    expect(equal).toMatchObject({ ok: true, value: { admitted: true } });

    const skewed = finalizeGovernanceRound({
      round: weighted.value,
      events,
      policy: DEFAULT_PLAN_ADMISSION_POLICY,
      nowMs: 2_000,
      members: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }, { memberId: 'd', weight: 10 }],
    });
    expect(skewed.ok).toBe(true);
    if (!skewed.ok) return;
    expect(skewed.value.admitted).toBe(false);
    expect(skewed.value.reason).toContain('weighted-tally-rejected');
    expect(skewed.value.tally).toMatchObject({ approveWeight: 3, rejectWeight: 10 });
  });

  it('aborts finalization on a reducer refusal instead of certifying it', () => {
    expect(weighted.ok).toBe(true);
    if (!weighted.ok) return;
    expect(finalizeGovernanceRound({
      round: weighted.value,
      events,
      policy: DEFAULT_PLAN_ADMISSION_POLICY,
      nowMs: 2_000,
      members: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }, { memberId: 'd', revoked: true }],
    })).toMatchObject({ ok: false, code: 'vote-reduction-refused' });

    // A ballot signed under a superseded key epoch is likewise refused, not counted.
    expect(finalizeGovernanceRound({
      round: weighted.value,
      events: [{ ...ballot('a', 'approve', 1), keyEpoch: 1 }, ballot('b', 'approve', 2), ballot('c', 'approve', 3), ballot('d', 'reject', 4)],
      policy: DEFAULT_PLAN_ADMISSION_POLICY,
      nowMs: 2_000,
      members: [{ memberId: 'a', keyEpoch: 5 }, { memberId: 'b' }, { memberId: 'c' }, { memberId: 'd' }],
    })).toMatchObject({ ok: false, code: 'vote-reduction-refused' });
  });

  it('covers the tally with the certificate hash, so a swapped tally fails verification', () => {
    expect(weighted.ok).toBe(true);
    if (!weighted.ok) return;
    const cert = finalizeGovernanceRound({ round: weighted.value, events, policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000 });
    expect(cert.ok).toBe(true);
    if (!cert.ok) return;
    expect(verifyFinalizationCertificate(cert.value)).toBe(true);
    expect(verifyFinalizationCertificate({ ...cert.value, tally: { ...cert.value.tally, approveWeight: 99 } })).toBe(false);
  });
});
