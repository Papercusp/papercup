import { describe, expect, it, vi } from 'vitest';
import {
  activationReceiptFromCheck,
  activationReceiptToCheck,
  activationReadyEvent,
  evaluateActivationEligibility,
  executeActivationProbeOnce,
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

  it('queues activation behind declared blockers and preserves the coordinated restart authority', () => {
    const restart = { tool: 'dev:restart', args: { target: 'bg-host', confirm: true } };
    expect(evaluateActivationEligibility(receipt(), restart)).toEqual({
      state: 'queued',
      blockers: [{ kind: 'critical-job', ref: 'green-checkpoint' }],
      restart,
      readyEvent: 'activation:ready:bg-host-abc123',
      reason: 'critical-job:green-checkpoint',
    });
  });

  it('never overrides an active critical job omitted by a stale receipt', () => {
    const committed = { ...receipt(), blockers: [] };
    const critical = { kind: 'critical-job', ref: 'release-cut', detail: 'publishing artifacts' } as const;
    const result = evaluateActivationEligibility(
      committed,
      { tool: 'dev:restart', args: { target: 'bg-host' } },
      critical,
    );
    expect(result.state).toBe('queued');
    expect(result.blockers).toEqual([critical]);
  });

  it('becomes ready on the same stable event key after blockers clear', () => {
    const committed = { ...receipt(), blockers: [] };
    const result = evaluateActivationEligibility(committed, {
      tool: 'dev:restart',
      args: { target: 'bg-host' },
    });
    expect(result).toMatchObject({ state: 'ready', blockers: [] });
    expect(result.readyEvent).toBe(activationReadyEvent(committed.id));
  });

  it('claims loaded -> verifying before invoking and persists terminal evidence', async () => {
    const writes: Array<{ state: string; expected: string }> = [];
    const invoke = vi.fn(async () => ({ passed: true, evidence: 'service returned healthy' }));
    const loaded = { ...receipt('loaded'), blockers: [], observedIdentity: { kind: 'git-sha', value: 'abc123' } } as ActivationReceipt;
    const result = await executeActivationProbeOnce(loaded, {
      persist: async (next, expected) => { writes.push({ state: next.state, expected }); return true; },
      invoke,
      nowMs: () => 1_800_000_000_000,
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(writes).toEqual([
      { state: 'verifying', expected: 'loaded' },
      { state: 'verified', expected: 'verifying' },
    ]);
    expect(result.receipt).toMatchObject({ state: 'verified', evidence: 'service returned healthy' });
  });

  it('does not invoke when identity is stale or another caller won the claim', async () => {
    const invoke = vi.fn(async () => ({ passed: true, evidence: 'unexpected' }));
    expect((await executeActivationProbeOnce(receipt('loaded'), { persist: async () => true, invoke })).reason).toBe('identity-mismatch');
    const loaded = { ...receipt('loaded'), observedIdentity: { kind: 'git-sha', value: 'abc123' } } as ActivationReceipt;
    expect((await executeActivationProbeOnce(loaded, { persist: async () => false, invoke })).reason).toBe('already-claimed');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('persists thrown probe failures and never repeats terminal receipts', async () => {
    const writes: ActivationReceipt[] = [];
    const invoke = vi.fn(async () => { throw new Error('probe unavailable'); });
    const loaded = { ...receipt('loaded'), observedIdentity: { kind: 'git-sha', value: 'abc123' } } as ActivationReceipt;
    const failed = await executeActivationProbeOnce(loaded, {
      persist: async (next) => { writes.push(next); return true; },
      invoke,
    });
    expect(failed.receipt).toMatchObject({ state: 'failed', failure: 'probe unavailable', evidence: 'probe threw: probe unavailable' });
    expect((await executeActivationProbeOnce(failed.receipt, { persist: async () => true, invoke })).reason).toBe('terminal');
    expect(invoke).toHaveBeenCalledOnce();
  });
});
