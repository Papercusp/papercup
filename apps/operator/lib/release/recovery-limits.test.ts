import { describe, expect, it } from 'vitest';
import { RECOVERY_LIMIT_FIELDS, validateRecoveryLimits, type MeasuredRecoveryLimits } from './recovery-limits';

const subject = { workload: 'disposable-clone-feasibility', runtimeIdentity: 'private-pg:fixture-1',
  configIdentity: 'clone-config:fixture-1', nowMs: 2_000 };
const measured = (): MeasuredRecoveryLimits => ({
  status: 'SUPPORTED', workload: subject.workload, runtimeIdentity: subject.runtimeIdentity,
  configIdentity: subject.configIdentity, measuredAtMs: 1_000, expiresAtMs: 3_000,
  evidenceRefs: ['test-run:clone-fixture'],
  limits: { clientWindowMs: 0, jobWindowMs: 0, rollbackWindowMs: 0, retentionWindowMs: 1_000,
    rtoMs: 900, rpoMs: 0, maxLostCommittedWrites: 0 },
  committedWrites: { acknowledged: 'preserve', lostAcknowledgement: 'preserve' },
});

describe('P-001 measured recovery limit admission', () => {
  it('accepts the exact measured workload and preserves explicit zero windows/loss', () => {
    const record = measured();
    expect(validateRecoveryLimits(record, subject)).toEqual({ ok: true, record });
  });

  it.each([undefined, null])('refuses an absent record (%s)', raw => {
    expect(validateRecoveryLimits(raw, subject)).toMatchObject({ ok: false, code: 'absent' });
  });

  it.each(['UNKNOWN', 'UNSUPPORTED'] as const)('refuses %s without inventing defaults', status => {
    expect(validateRecoveryLimits({ status, workload: subject.workload,
      reason: 'No representative production drill', ownerWorkItem: 'WI-fixture' }, subject))
      .toMatchObject({ ok: false, code: status.toLowerCase() });
  });

  it.each([
    ['workload', 'shared-production-recovery', 'wrong-workload'],
    ['runtimeIdentity', 'shared-pg:production', 'wrong-runtime'],
    ['configIdentity', 'clone-config:changed', 'wrong-config'],
  ])('refuses foreign %s evidence', (field, value, code) => {
    expect(validateRecoveryLimits({ ...measured(), [field]: value }, subject)).toMatchObject({ ok: false, code });
  });

  it.each([1_999, 2_000])('refuses expired evidence at %s including the expiry edge', expiresAtMs => {
    expect(validateRecoveryLimits({ ...measured(), expiresAtMs }, subject)).toMatchObject({ ok: false, code: 'stale' });
  });

  it.each([
    { measuredAtMs: 2_001 }, { measuredAtMs: NaN }, { measuredAtMs: undefined },
    { expiresAtMs: Infinity }, { expiresAtMs: 1_000 }, { expiresAtMs: undefined },
  ])('refuses a missing, future or invalid measurement interval %j', change => {
    expect(validateRecoveryLimits({ ...measured(), ...change }, subject)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it.each(RECOVERY_LIMIT_FIELDS)('requires a finite non-negative, explicit %s quantity', field => {
    for (const value of [undefined, null, '1000', NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const record = measured();
      expect(validateRecoveryLimits({ ...record, limits: { ...record.limits, [field]: value } }, subject))
        .toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('refuses retention shorter than the declared rollback support', () => {
    const record = measured();
    record.limits.rollbackWindowMs = record.limits.retentionWindowMs + 1;
    expect(validateRecoveryLimits(record, subject)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it.each([undefined, {}, { acknowledged: 'preserve' },
    { acknowledged: 'preserve', lostAcknowledgement: 'unknown' }])('requires both committed-write policies %j', committedWrites => {
    expect(validateRecoveryLimits({ ...measured(), committedWrites }, subject)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('requires an authorization reference for an explicit measured loss policy', () => {
    const record = measured();
    record.limits.maxLostCommittedWrites = 1;
    record.committedWrites.lostAcknowledgement = 'explicit-loss';
    expect(validateRecoveryLimits(record, subject)).toMatchObject({ ok: false, code: 'invalid' });
    record.committedWrites.lossAuthorizationRef = 'authorization:fixture-only';
    expect(validateRecoveryLimits(record, subject)).toEqual({ ok: true, record });
  });

  it('refuses a claimed preservation policy with nonzero lost committed writes', () => {
    const record = measured();
    record.limits.maxLostCommittedWrites = 1;
    expect(validateRecoveryLimits(record, subject)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it.each([undefined, [], [''], ['evidence', null]].map(evidenceRefs => ({ evidenceRefs })))
  ('requires the measured basis %j', ({ evidenceRefs }) => {
    expect(validateRecoveryLimits({ ...measured(), evidenceRefs }, subject)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it.each([false, [], 'SUPPORTED', {}, { ...measured(), status: 'maybe' }].map(raw => ({ raw })))
  ('refuses malformed input %j', ({ raw }) => {
    expect(validateRecoveryLimits(raw, subject)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it.each([{ nowMs: NaN }, { nowMs: -1 }, { workload: '' },
    { runtimeIdentity: '' }, { configIdentity: '' }])('requires an explicit valid operation subject %j', change => {
    expect(validateRecoveryLimits(measured(), { ...subject, ...change })).toMatchObject({ ok: false, code: 'invalid' });
  });
});
