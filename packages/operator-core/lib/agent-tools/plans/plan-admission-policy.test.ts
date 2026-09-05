import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_ADMISSION_POLICY,
  canonicalizePlanAdmissionPolicy,
  evaluatePlanAdmission,
  resolvePlanAdmissionMode,
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
    // `mode` is INSIDE the signed bytes (P-013). It is the enforce/observe switch,
    // so excluding it would let the gate be turned off without invalidating the
    // owner's signature. This literal changed when the field was added; that is the
    // intended contract change, not drift.
    expect(canonicalizePlanAdmissionPolicy(DEFAULT_PLAN_ADMISSION_POLICY)).toBe(
      '{"approvalBps":6667,"materiality":{"maxChangedItems":3,"maxChangedLines":200},"mode":"enforce","policyVersion":1,"quorumBps":5000,"ratificationWindowSec":604800}',
    );
  });

  describe('admission mode (P-013 shadow)', () => {
    it('signs the EFFECTIVE mode, so an omitted mode and an explicit enforce hash identically', () => {
      // Otherwise the same policy would produce two signatures depending only on
      // how it happened to be written.
      expect(canonicalizePlanAdmissionPolicy({ ...DEFAULT_PLAN_ADMISSION_POLICY, mode: 'enforce' })).toBe(
        canonicalizePlanAdmissionPolicy(DEFAULT_PLAN_ADMISSION_POLICY),
      );
    });

    it('produces DIFFERENT signed bytes for shadow — flipping enforcement cannot ride an old signature', () => {
      // THE SECURITY PROPERTY. If these ever matched, anyone who could edit the
      // policy document could disable the gate while keeping the signature valid.
      expect(canonicalizePlanAdmissionPolicy({ ...DEFAULT_PLAN_ADMISSION_POLICY, mode: 'shadow' })).not.toBe(
        canonicalizePlanAdmissionPolicy(DEFAULT_PLAN_ADMISSION_POLICY),
      );
    });

    it('defaults an unstated mode to enforce — an unstated mode must never be the one that disables the gate', () => {
      expect(resolvePlanAdmissionMode(DEFAULT_PLAN_ADMISSION_POLICY)).toBe('enforce');
      expect(resolvePlanAdmissionMode({ mode: undefined })).toBe('enforce');
      expect(resolvePlanAdmissionMode({ mode: 'shadow' })).toBe('shadow');
    });

    it('accepts both valid modes, and preserves an absent one as absent', () => {
      expect(validatePlanAdmissionPolicy({ ...DEFAULT_PLAN_ADMISSION_POLICY, mode: 'shadow' }))
        .toEqual({ ok: true, policy: { ...DEFAULT_PLAN_ADMISSION_POLICY, mode: 'shadow' } });
      // Absent stays absent rather than being materialised to the default, so a
      // round-trip through validation cannot silently rewrite the owner's document.
      expect(validatePlanAdmissionPolicy(DEFAULT_PLAN_ADMISSION_POLICY).ok && 'mode' in validatePlanAdmissionPolicy(DEFAULT_PLAN_ADMISSION_POLICY))
        .toBe(false);
    });

    it('REFUSES an unrecognised mode rather than falling back to a default', () => {
      // A typo'd or hostile mode is a malformed policy. The gate turns a validation
      // failure into a present-and-unsatisfiable policy that refuses everything, so
      // this fails closed; defaulting to shadow here would silently disable it.
      for (const bad of ['observe', 'Shadow', '', 'off', 0, null]) {
        expect(validatePlanAdmissionPolicy({ ...DEFAULT_PLAN_ADMISSION_POLICY, mode: bad }).ok).toBe(false);
      }
    });
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
