import { describe, expect, it } from 'vitest';
import {
  activationReceiptFromCheck,
  activationReceiptToCheck,
  identitiesMatch,
  validateActivationReceipt,
  type ActivationReceipt,
} from './activation-receipt';

const receipt = (state: ActivationReceipt['state'] = 'committed'): ActivationReceipt => ({
  version: 1,
  id: 'bg-host-abc123',
  workItemId: 'WI-42',
  runtime: 'bg-host',
  expectedIdentity: { kind: 'git-sha', value: 'abc123' },
  blockers: [{ kind: 'critical-job', ref: 'green-checkpoint' }],
  probe: { tool: 'dev:service_health', args: { units: ['papercup-bg-host'] }, expected: 'healthy' },
  state,
  updatedAtMs: 1_700_000_000_000,
});

describe('activation receipt model', () => {
  it('requires loaded and verified states to carry the matching observed identity', () => {
    expect(validateActivationReceipt(receipt('loaded'))).toContain(
      'loaded requires observedIdentity to match expectedIdentity',
    );
    const loaded = { ...receipt('loaded'), observedIdentity: { kind: 'git-sha', value: 'abc123' } } as ActivationReceipt;
    expect(validateActivationReceipt(loaded)).toEqual([]);
    expect(identitiesMatch(loaded.expectedIdentity, loaded.observedIdentity)).toBe(true);
  });

  it('requires verification evidence and failure detail in terminal states', () => {
    expect(validateActivationReceipt({ ...receipt('verified'), observedIdentity: { kind: 'git-sha', value: 'abc123' } })).toContain(
      'verified requires evidence',
    );
    expect(validateActivationReceipt(receipt('failed'))).toContain('failed requires failure');
  });

  it('round-trips through the existing durable work-item CheckEntry surface', () => {
    const verified: ActivationReceipt = {
      ...receipt('verified'),
      observedIdentity: { kind: 'git-sha', value: 'abc123' },
      blockers: [],
      evidence: 'probe returned healthy',
    };
    const check = activationReceiptToCheck(verified);
    expect(check.id).toBe('activation:bg-host-abc123');
    expect(check.recheck).toContain('dev:service_health');
    expect(activationReceiptFromCheck(check)).toEqual(verified);
  });

  it('does not mistake ordinary or corrupt checks for receipts', () => {
    expect(activationReceiptFromCheck({ claim: 'gate is green' })).toBeNull();
    expect(activationReceiptFromCheck({ claim: 'activation-receipt:v1:not-base64-json' })).toBeNull();
  });
});
