/** Reusable exact-plan admission guard for every lifecycle execution door (P-004). */
export const PLAN_ADMISSION_DOORS = ['status', 'start', 'promotion', 'scheduled', 'run-now', 'autostart', 'fleet-launch'] as const;
export type PlanAdmissionDoor = (typeof PLAN_ADMISSION_DOORS)[number];

export interface AdmissionCertificate {
  readonly planRevisionHash: string;
  readonly policyVersion: number;
  readonly admitted: boolean;
  readonly expiresAtMs: number;
  readonly certificateHash: string;
}

export type AdmissionRefusalCode = 'unknown-door' | 'missing-plan-revision' | 'missing-certificate' | 'certificate-rejected' | 'revision-mismatch' | 'policy-epoch-mismatch' | 'certificate-expired';
export type AdmissionResult = { ok: true; door: PlanAdmissionDoor; certificate: AdmissionCertificate } | { ok: false; code: AdmissionRefusalCode; detail: string };

/**
 * Assert that an execution door is operating on the exact ratified plan
 * revision and owner policy epoch. Callers invoke this inside their existing
 * transaction/lock immediately before promotion or execution.
 */
export function assertPlanAdmission(input: { door: string; planRevisionHash: string; policyVersion: number; certificate?: AdmissionCertificate | null; nowMs: number }): AdmissionResult {
  if (!(PLAN_ADMISSION_DOORS as readonly string[]).includes(input.door)) return { ok: false, code: 'unknown-door', detail: `unsupported plan execution door '${input.door}'` };
  if (!input.planRevisionHash.trim()) return { ok: false, code: 'missing-plan-revision', detail: 'exact plan revision hash is required' };
  if (!input.certificate) return { ok: false, code: 'missing-certificate', detail: 'an immutable admission certificate is required' };
  if (!input.certificate.admitted) return { ok: false, code: 'certificate-rejected', detail: 'admission certificate does not authorize execution' };
  if (input.certificate.planRevisionHash !== input.planRevisionHash) return { ok: false, code: 'revision-mismatch', detail: 'certificate is for a different plan revision' };
  if (input.certificate.policyVersion !== input.policyVersion) return { ok: false, code: 'policy-epoch-mismatch', detail: 'certificate is for a different policy epoch' };
  if (!Number.isFinite(input.nowMs) || input.nowMs > input.certificate.expiresAtMs) return { ok: false, code: 'certificate-expired', detail: 'admission certificate has expired' };
  return { ok: true, door: input.door as PlanAdmissionDoor, certificate: input.certificate };
}
