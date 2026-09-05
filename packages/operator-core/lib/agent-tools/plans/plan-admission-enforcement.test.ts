import { describe, expect, it } from 'vitest';
import { assertPlanAdmission, PLAN_ADMISSION_DOORS, type AdmissionCertificate } from './plan-admission-enforcement';

const cert: AdmissionCertificate = { planRevisionHash: 'sha256:plan', policyVersion: 2, admitted: true, expiresAtMs: 10_000, certificateHash: 'sha256:cert' };

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
});
