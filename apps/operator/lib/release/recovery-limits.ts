/**
 * P-001's measured-limit data boundary. Downstream recovery/admission paths can
 * consume this verdict in their existing result records; this module neither
 * persists policy nor changes a production gate. A historical drill is usable
 * only for its exact workload/runtime/configuration and declared validity period.
 */
export const RECOVERY_LIMIT_FIELDS = [
  'clientWindowMs', 'jobWindowMs', 'rollbackWindowMs', 'retentionWindowMs',
  'rtoMs', 'rpoMs', 'maxLostCommittedWrites',
] as const;

type WriteDisposition = 'preserve' | 'replay' | 'compensate' | 'explicit-loss';

export interface MeasuredRecoveryLimits {
  status: 'SUPPORTED';
  workload: string;
  runtimeIdentity: string;
  configIdentity: string;
  measuredAtMs: number;
  expiresAtMs: number;
  evidenceRefs: string[];
  limits: Record<(typeof RECOVERY_LIMIT_FIELDS)[number], number>;
  committedWrites: {
    acknowledged: WriteDisposition;
    lostAcknowledgement: WriteDisposition;
    /** Required when either class of committed writes may be lost. */
    lossAuthorizationRef?: string;
  };
}

export type RecoveryLimitsRecord = MeasuredRecoveryLimits | {
  status: 'UNKNOWN' | 'UNSUPPORTED';
  workload: string;
  reason: string;
  ownerWorkItem: string;
};

export interface RecoveryLimitSubject {
  workload: string;
  runtimeIdentity: string;
  configIdentity: string;
  nowMs: number;
}

type RefusalCode = 'absent' | 'unknown' | 'unsupported' | 'wrong-workload' |
  'wrong-runtime' | 'wrong-config' | 'stale' | 'invalid';

export type RecoveryLimitVerdict = { ok: true; record: MeasuredRecoveryLimits } |
  { ok: false; code: RefusalCode; reason: string };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const quantity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const disposition = (value: unknown): value is WriteDisposition =>
  value === 'preserve' || value === 'replay' || value === 'compensate' || value === 'explicit-loss';

/** No inferred windows, default target, clock, or loss policy on missing evidence. */
export function validateRecoveryLimits(
  raw: unknown,
  subject: RecoveryLimitSubject,
): RecoveryLimitVerdict {
  const refuse = (code: RefusalCode, reason: string): RecoveryLimitVerdict => ({ ok: false, code, reason });
  if (!text(subject.workload) || !text(subject.runtimeIdentity) || !text(subject.configIdentity) ||
      !quantity(subject.nowMs)) return refuse('invalid', 'Expected workload, runtime, configuration and clock are required');
  if (raw === undefined || raw === null) return refuse('absent', 'No measured limits record');
  if (!object(raw)) return refuse('invalid', 'Limits record must be an object');
  if (!text(raw.workload)) return refuse('invalid', 'Workload identity is missing');
  if (raw.workload !== subject.workload) return refuse('wrong-workload', 'Limits belong to another workload');
  if (raw.status === 'UNSUPPORTED') return refuse('unsupported', 'Workload has no supported measured limits');
  if (raw.status === 'UNKNOWN') return refuse('unknown', 'Workload limits are unknown');
  if (raw.status !== 'SUPPORTED') return refuse('invalid', 'Limits support status is missing or invalid');
  if (raw.runtimeIdentity !== subject.runtimeIdentity) return refuse('wrong-runtime', 'Measured runtime differs from the requested runtime');
  if (raw.configIdentity !== subject.configIdentity) return refuse('wrong-config', 'Measured configuration differs from the requested configuration');
  if (!quantity(raw.measuredAtMs) || !quantity(raw.expiresAtMs) ||
      raw.measuredAtMs > subject.nowMs || raw.expiresAtMs <= raw.measuredAtMs) {
    return refuse('invalid', 'Measurement and expiry must define a finite interval beginning in the past');
  }
  if (raw.expiresAtMs <= subject.nowMs) return refuse('stale', 'Measured limits have expired');
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length === 0 || !raw.evidenceRefs.every(text)) {
    return refuse('invalid', 'Measured basis references are required');
  }
  if (!object(raw.limits)) return refuse('invalid', 'Finite limits with explicit units are required');
  for (const field of RECOVERY_LIMIT_FIELDS) {
    if (!quantity(raw.limits[field])) return refuse('invalid', `Missing or invalid ${field}`);
  }
  if (Number(raw.limits.retentionWindowMs) < Number(raw.limits.rollbackWindowMs)) {
    return refuse('invalid', 'Retention cannot end before the supported rollback window');
  }
  const writes = raw.committedWrites;
  if (!object(writes) || !disposition(writes.acknowledged) || !disposition(writes.lostAcknowledgement)) {
    return refuse('invalid', 'Both acknowledged and lost-acknowledgement committed writes need a policy');
  }
  const permitsLoss = writes.acknowledged === 'explicit-loss' || writes.lostAcknowledgement === 'explicit-loss';
  if (permitsLoss && !text(writes.lossAuthorizationRef)) {
    return refuse('invalid', 'Explicit loss requires its authorization reference');
  }
  if (!permitsLoss && raw.limits.maxLostCommittedWrites !== 0) {
    return refuse('invalid', 'A preservation/replay/compensation policy cannot declare lost committed writes');
  }
  return { ok: true, record: raw as unknown as MeasuredRecoveryLimits };
}
