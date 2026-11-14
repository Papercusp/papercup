import { describe, expect, it, vi } from 'vitest';
vi.mock('./predicate-watch', async (original) => ({
  ...await original<typeof import('./predicate-watch')>(),
  dispatchReadOnlyTool: vi.fn(),
}));
import { dispatchReadOnlyTool } from './predicate-watch';
import type { ProducerHealthCertificate, VerifiedWaitTimeoutResult } from './verified-wait';
import { advanceProgressLeaseCertificate, observeProgressLease, progressValueFingerprint } from './progress-lease';

function certificate(): ProducerHealthCertificate {
  const evidence = {
    writer: 'work_items:get',
    units: 'checkpoint-revision',
    observedAtMs: 1,
    valuePreview: 7,
    valueFingerprint: progressValueFingerprint(7),
    reference: { tool: 'work_items:get', args: { id: 'WI-1' }, path: 'checkpoint.revision' },
    uncertainty: null,
  };
  return {
    version: 1,
    producer: { kind: 'delegated-progress', id: 'lease-1' },
    owner: { ownerId: 'worker', workItemId: 'WI-1' },
    issuedAtMs: 1,
    lastProgressAtMs: 1,
    lastFireAtMs: null,
    expectedCadenceMs: 1_000,
    verificationDeadlineMs: 1_001,
    progressLease: {
      leaseId: 'lease-1',
      sourceKind: 'checkpoint-revision',
      resolver: {
        tool: 'work_items:get', args: { id: 'WI-1' }, path: 'checkpoint.revision', op: 'changed',
        workspaceId: 'ws', harnessSlug: 'h', role: 'su', onBehalfOf: 'leader',
      },
      subscriberId: 'leader', writer: evidence.writer, units: evidence.units,
      baselineFingerprint: evidence.valueFingerprint, latestEvidence: evidence,
      missCount: 0, remedyAfterMisses: 2,
      remedy: { kind: 'leader-claim', workItemId: 'WI-1', harness: 'h' },
      history: [{ state: 'armed', atMs: 1, writer: evidence.writer, units: evidence.units, missCount: 0, evidence }],
    },
  };
}

function result(progressing: boolean, value: number, uncertainty: string | null = null): VerifiedWaitTimeoutResult {
  return {
    classification: progressing ? 'progressing' : 'stalled',
    nextAction: progressing ? 're-await' : 'wake-owner-or-takeover',
    producer: { kind: 'delegated-progress', id: 'lease-1' }, owner: { ownerId: 'worker', workItemId: 'WI-1' },
    checkedAtMs: 2_000, verificationDeadlineMs: 1_001,
    lastProgressAtMs: progressing ? 2_000 : 1, lastFireAtMs: null,
    evidence: { progressLease: {
      writer: 'work_items:get', units: 'checkpoint-revision', observedAtMs: 2_000,
      valuePreview: value, valueFingerprint: progressValueFingerprint(value),
      reference: { tool: 'work_items:get', args: { id: 'WI-1' }, path: 'checkpoint.revision' }, uncertainty,
    } },
  };
}

describe('delegated wait progress leases', () => {
  it('renews only from changed authoritative evidence and resets the miss count', () => {
    const next = advanceProgressLeaseCertificate(certificate(), result(true, 8));
    expect(next.progressLease).toMatchObject({ missCount: 0, baselineFingerprint: progressValueFingerprint(8) });
    expect(next.progressLease?.history.map((entry) => entry.state)).toEqual(['armed', 'progress']);
  });

  it('records first-miss wake evidence append-only without treating heartbeat or time as progress', () => {
    const next = advanceProgressLeaseCertificate(certificate(), result(false, 7), {
      wake: { attempted: true, queued: 1, staged: 0 },
    });
    expect(next.progressLease?.missCount).toBe(1);
    expect(next.progressLease?.history.map((entry) => entry.state)).toEqual(['armed', 'miss', 'owner-wake']);
    expect(next.progressLease?.history[2]).toMatchObject({ writer: 'work_items:get', units: 'checkpoint-revision' });
  });

  it.each(['exception', 'missing-path'])('keeps %s uncertainty separate from a measured miss and remedy authority', async (failure) => {
    let current = advanceProgressLeaseCertificate(certificate(), result(false, 7));
    for (const checkedAtMs of [3_000, 4_000]) {
      if (failure === 'exception') vi.mocked(dispatchReadOnlyTool).mockRejectedValueOnce(new Error('resolver unavailable'));
      else vi.mocked(dispatchReadOnlyTool).mockResolvedValueOnce({});
      const observed = await observeProgressLease(current, checkedAtMs);
      expect(observed).toMatchObject({
        classification: 'unknown', nextAction: 'resolve-uncertainty',
        evidence: { progressed: false, missCount: 1, uncertainty: expect.any(String) },
      });
      expect(() => advanceProgressLeaseCertificate(current, observed, {
        remedy: { kind: 'leader-claim', disposition: 'executed', summary: 'invalid' },
      })).toThrow('Unknown progress evidence');
      current = advanceProgressLeaseCertificate(current, observed);
      expect(current.progressLease).toMatchObject({ missCount: 1, baselineFingerprint: progressValueFingerprint(7) });
      expect(current.progressLease?.history.at(-1)?.state).toBe('unknown');
    }
  });
});
