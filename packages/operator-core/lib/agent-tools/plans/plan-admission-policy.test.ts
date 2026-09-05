import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_ADMISSION_POLICY,
  canonicalizePlanAdmissionPolicy,
  evaluatePlanAdmission,
  validatePlanAdmissionPolicy,
} from './plan-admission-policy';

const snapshot = (overrides: Partial<Parameters<typeof evaluatePlanAdmission>[1]> = {}) => ({
  planRevisionHash: 'sha256:plan-v1',
  policyVersion: 1,
  eligibleMemberIds: ['alice', 'bob', 'carol'],
  votes: [
    { memberId: 'alice', choice: 'approve' as const },
    { memberId: 'bob', choice: 'approve' as const },
  ],
  ratifiedAtMs: 1_000,
  ...overrides,
});

describe('plan admission policy', () => {
  it('validates and canonicalizes the signed policy payload', () => {
    const result = validatePlanAdmissionPolicy(DEFAULT_PLAN_ADMISSION_POLICY);
    expect(result).toEqual({ ok: true, policy: DEFAULT_PLAN_ADMISSION_POLICY });
    expect(canonicalizePlanAdmissionPolicy(DEFAULT_PLAN_ADMISSION_POLICY)).toBe(
      '{"approvalBps":6667,"materiality":{"maxChangedItems":3,"maxChangedLines":200},"policyVersion":1,"quorumBps":5000,"ratificationWindowSec":604800}',
    );
  });

  it('rejects malformed thresholds and materiality values', () => {
    expect(validatePlanAdmissionPolicy({ ...DEFAULT_PLAN_ADMISSION_POLICY, quorumBps: 10_001 }).ok).toBe(false);
    expect(validatePlanAdmissionPolicy({ ...DEFAULT_PLAN_ADMISSION_POLICY, materiality: { maxChangedLines: -1, maxChangedItems: 1 } }).ok).toBe(false);
  });

  it('admits a quorum-reaching approval snapshot and counts abstentions only toward quorum', () => {
    const verdict = evaluatePlanAdmission(
      DEFAULT_PLAN_ADMISSION_POLICY,
      snapshot({ votes: [
        { memberId: 'alice', choice: 'approve' },
        { memberId: 'bob', choice: 'approve' },
        { memberId: 'carol', choice: 'abstain' },
      ] }),
      2_000,
    );
    expect(verdict).toMatchObject({ admitted: true, reason: 'approved', quorumBps: 10_000, approvalBps: 10_000 });
  });

  it('fails closed for duplicate, unknown, stale, and expired snapshots', () => {
    expect(evaluatePlanAdmission(DEFAULT_PLAN_ADMISSION_POLICY, snapshot({ votes: [
      { memberId: 'alice', choice: 'approve' },
      { memberId: 'alice', choice: 'approve' },
    ] }), 2_000).reason).toBe('duplicate-member-vote');
    expect(evaluatePlanAdmission(DEFAULT_PLAN_ADMISSION_POLICY, snapshot({ votes: [
      { memberId: 'mallory', choice: 'approve' },
    ] }), 2_000).reason).toBe('unknown-voter');
    expect(evaluatePlanAdmission(DEFAULT_PLAN_ADMISSION_POLICY, snapshot({ policyVersion: 2 }), 2_000).reason).toBe('wrong-policy-epoch');
    expect(evaluatePlanAdmission(DEFAULT_PLAN_ADMISSION_POLICY, snapshot(), 604_801_001).reason).toBe('expired');
  });
});
