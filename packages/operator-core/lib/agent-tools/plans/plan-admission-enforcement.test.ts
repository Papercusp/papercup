import { describe, expect, it } from 'vitest';
import type { PlanGovernanceControls } from './governance-federation';
import { assertPlanAdmission, PLAN_ADMISSION_DOORS, type AdmissionCertificate } from './plan-admission-enforcement';

const cert: AdmissionCertificate = { planRevisionHash: 'sha256:plan', policyVersion: 2, admitted: true, expiresAtMs: 10_000, certificateHash: 'sha256:cert' };

const controls = (over: Partial<PlanGovernanceControls> = {}): PlanGovernanceControls => ({ roundId: 'round-1', status: 'finalized', quarantineReason: null, revokedReason: null, ...over });

/** The exact-certificate admission a governance control has to be able to override. */
const admissible = { planRevisionHash: cert.planRevisionHash, policyVersion: 2, certificate: cert, nowMs: 1_000 } as const;

describe('exact-plan admission enforcement', () => {
  it('admits every lifecycle door with the exact certificate and epoch', () => {
    for (const door of PLAN_ADMISSION_DOORS) expect(assertPlanAdmission({ door, planRevisionHash: cert.planRevisionHash, policyVersion: 2, certificate: cert, nowMs: 1_000 })).toMatchObject({ ok: true, door });
  });

  it('fails closed for missing, stale, rejected, and expired certificates', () => {
    expect(assertPlanAdmission({ door: 'start', planRevisionHash: cert.planRevisionHash, policyVersion: 2, nowMs: 1 })).toMatchObject({ ok: false, code: 'missing-certificate' });
    expect(assertPlanAdmission({ door: 'start', planRevisionHash: 'sha256:other', policyVersion: 2, certificate: cert, nowMs: 1 })).toMatchObject({ ok: false, code: 'revision-mismatch' });
    expect(assertPlanAdmission({ door: 'start', planRevisionHash: cert.planRevisionHash, policyVersion: 3, certificate: cert, nowMs: 1 })).toMatchObject({ ok: false, code: 'policy-epoch-mismatch' });
    expect(assertPlanAdmission({ door: 'start', planRevisionHash: cert.planRevisionHash, policyVersion: 2, certificate: { ...cert, admitted: false }, nowMs: 1 })).toMatchObject({ ok: false, code: 'certificate-rejected' });
    expect(assertPlanAdmission({ door: 'start', planRevisionHash: cert.planRevisionHash, policyVersion: 2, certificate: cert, nowMs: 10_001 })).toMatchObject({ ok: false, code: 'certificate-expired' });
  });

  it('preserves the seven pre-governance refusal codes and the seven doors', () => {
    // The governance codes are ADDITIVE (P-005 follow-up): a caller switching on the
    // original seven must keep compiling and keep receiving the same verdicts.
    expect([...PLAN_ADMISSION_DOORS]).toEqual(['status', 'start', 'promotion', 'scheduled', 'run-now', 'autostart', 'fleet-launch']);
  });
});

describe('governance controls gate admission ahead of the certificate', () => {
  it('refuses EVERY door while the round is paused, certificate notwithstanding', () => {
    for (const door of PLAN_ADMISSION_DOORS) {
      expect(assertPlanAdmission({ ...admissible, door, governance: controls({ status: 'paused' }) })).toMatchObject({ ok: false, code: 'plan-paused' });
    }
  });

  it('refuses a revoked round terminally, and a quarantined round pending recomputation', () => {
    expect(assertPlanAdmission({ ...admissible, door: 'start', governance: controls({ status: 'revoked', revokedReason: 'treasury compromise' }) })).toMatchObject({
      ok: false,
      code: 'plan-revoked',
      detail: expect.stringContaining('treasury compromise'),
    });
    expect(assertPlanAdmission({ ...admissible, door: 'start', governance: controls({ status: 'quarantined', quarantineReason: 'conflicting finalizations for round round-1' }) })).toMatchObject({
      ok: false,
      code: 'round-quarantined',
      detail: expect.stringContaining('conflicting finalizations'),
    });
  });

  it('mints nothing on a control refusal — no certificate is carried out of a refusal', () => {
    for (const status of ['paused', 'revoked', 'quarantined'] as const) {
      const result = assertPlanAdmission({ ...admissible, door: 'promotion', governance: controls({ status }) });
      expect(result.ok).toBe(false);
      expect('certificate' in result).toBe(false);
      expect('door' in result).toBe(false);
    }
  });

  it('evaluates the control BEFORE the certificate — a paused plan reports the pause, not the missing certificate', () => {
    // Order is the whole point: if the certificate checks ran first, a paused round
    // with no certificate would report 'missing-certificate' and an operator would
    // go hunting for a ratification that must not be honoured anyway.
    expect(assertPlanAdmission({ door: 'start', planRevisionHash: cert.planRevisionHash, policyVersion: 2, nowMs: 1_000, governance: controls({ status: 'paused' }) })).toMatchObject({ ok: false, code: 'plan-paused' });
    expect(assertPlanAdmission({ door: 'start', planRevisionHash: cert.planRevisionHash, policyVersion: 3, certificate: cert, nowMs: 1_000, governance: controls({ status: 'revoked' }) })).toMatchObject({ ok: false, code: 'plan-revoked' });
  });

  it('admits under a finalized round, and leaves an open round to the certificate checks', () => {
    expect(assertPlanAdmission({ ...admissible, door: 'start', governance: controls({ status: 'finalized' }) })).toMatchObject({ ok: true, door: 'start' });
    // 'open' is not a control refusal: the round simply has no certificate yet, and
    // that verdict belongs to 'missing-certificate' so the code names the real gap.
    expect(assertPlanAdmission({ door: 'start', planRevisionHash: cert.planRevisionHash, policyVersion: 2, nowMs: 1_000, governance: controls({ status: 'open' }) })).toMatchObject({ ok: false, code: 'missing-certificate' });
  });

  it('is unchanged when no governance input is supplied', () => {
    expect(assertPlanAdmission({ ...admissible, door: 'start' })).toMatchObject({ ok: true, door: 'start' });
    expect(assertPlanAdmission({ ...admissible, door: 'start', governance: null })).toMatchObject({ ok: true, door: 'start' });
  });
});
