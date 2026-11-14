import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: vi.fn(async () => ({ queued: 1, woken: 1, staged: 0 })),
}));
vi.mock('../../coord/condition-upsert', () => ({
  upsertConditionWorkItem: vi.fn(async () => ({ id: 'WI-UNBLOCK', created: true, conditionKey: 'k' })),
}));
vi.mock('../../work-items', () => ({
  claimWorkItem: vi.fn(async (id: string, assignee: string) => ({ id, assignee })),
}));

import { claimWorkItem } from '../../work-items';
import { upsertConditionWorkItem } from '../../coord/condition-upsert';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import { executeProgressLeaseRemedy, progressValueFingerprint, wakeProgressLeaseOwner } from './progress-lease';
import type { ProducerHealthCertificate, ProgressLeaseRemedy, VerifiedWaitTimeoutResult } from './verified-wait';

function certificate(remedy: ProgressLeaseRemedy): ProducerHealthCertificate {
  const evidence = {
    writer: 'work_items:get', units: 'revision', observedAtMs: 1, valuePreview: 1,
    valueFingerprint: progressValueFingerprint(1),
    reference: { tool: 'work_items:get', args: { id: 'WI-1' }, path: 'checkpoint.revision' },
    uncertainty: null,
  };
  return {
    version: 1, producer: { kind: 'delegated-progress', id: 'lease-1' },
    owner: { ownerId: 'worker', workItemId: 'WI-1' }, issuedAtMs: 1,
    lastProgressAtMs: 1, lastFireAtMs: null, expectedCadenceMs: 60_000, verificationDeadlineMs: 60_001,
    progressLease: {
      leaseId: 'lease-1', sourceKind: 'checkpoint-revision', subscriberId: 'leader',
      resolver: { tool: 'work_items:get', args: { id: 'WI-1' }, path: 'checkpoint.revision', op: 'changed', workspaceId: 'ws', harnessSlug: 'papercusp', role: 'su', onBehalfOf: 'leader' },
      writer: evidence.writer, units: evidence.units, baselineFingerprint: evidence.valueFingerprint,
      latestEvidence: evidence, missCount: 0, remedyAfterMisses: 2, remedy,
      history: [{ state: 'armed', atMs: 1, writer: evidence.writer, units: evidence.units, missCount: 0, evidence }],
    },
  };
}

const stalled: VerifiedWaitTimeoutResult = {
  classification: 'stalled', nextAction: 'wake-owner-or-takeover',
  producer: { kind: 'delegated-progress', id: 'lease-1' }, owner: { ownerId: 'worker', workItemId: 'WI-1' },
  checkedAtMs: 60_001, verificationDeadlineMs: 60_001, lastProgressAtMs: 1, lastFireAtMs: null,
};

beforeEach(() => vi.clearAllMocks());

describe('progress lease stale actions', () => {
  it('does not wake a delegated owner from unknown evidence', async () => {
    const result = await wakeProgressLeaseOwner(certificate({ kind: 'leader-claim', workItemId: 'WI-1' }), {
      ...stalled, classification: 'unknown', nextAction: 'resolve-uncertainty',
      evidence: { uncertainty: 'resolver unavailable' },
    });
    expect(result).toEqual({ attempted: false, queued: 0, staged: 0 });
    expect(wakeRecipients).not.toHaveBeenCalled();
    expect(claimWorkItem).not.toHaveBeenCalled();
  });
  it('directly wakes the delegated owner with evidence on the first miss', async () => {
    const result = await wakeProgressLeaseOwner(certificate({ kind: 'spec-widen', instructions: 'widen tags' }), stalled);
    expect(result).toEqual({ attempted: true, queued: 1, staged: 0 });
    expect(wakeRecipients).toHaveBeenCalledWith(['worker'], expect.objectContaining({
      source: 'system:progress-lease', requiredWake: true,
      payload: expect.objectContaining({ progressLease: 'lease-1' }),
    }));
  });

  it('executes leader takeover through expected-holder CAS', async () => {
    const result = await executeProgressLeaseRemedy(certificate({ kind: 'leader-claim', workItemId: 'WI-1', harness: 'papercusp' }));
    expect(result).toMatchObject({ disposition: 'executed', workItemId: 'WI-1' });
    expect(claimWorkItem).toHaveBeenCalledWith('WI-1', 'leader', { harness: 'papercusp', expectedAssignee: 'worker' });
  });

  it('surfaces spec widening without inventing a second scheduler', async () => {
    const result = await executeProgressLeaseRemedy(certificate({ kind: 'spec-widen', instructions: 'set scheduler claim spec revision 4 tags:any[a,b]' }));
    expect(result).toEqual({ kind: 'spec-widen', disposition: 'surfaced', summary: 'set scheduler claim spec revision 4 tags:any[a,b]' });
    expect(claimWorkItem).not.toHaveBeenCalled();
  });

  it('idempotently creates/adopts and claims an unblock work-item', async () => {
    const result = await executeProgressLeaseRemedy(certificate({
      kind: 'create-unblock-item', title: 'Repair upstream', summary: 'Evidence did not advance', harness: 'papercusp',
    }));
    expect(result).toMatchObject({ disposition: 'executed', workItemId: 'WI-UNBLOCK' });
    expect(upsertConditionWorkItem).toHaveBeenCalledWith('progress-lease:lease-1', expect.objectContaining({ kind: 'task', harness: 'papercusp' }));
    expect(claimWorkItem).toHaveBeenCalledWith('WI-UNBLOCK', 'leader', { harness: 'papercusp' });
  });

  it('turns a remedy backend exception into explicit failed evidence', async () => {
    vi.mocked(claimWorkItem).mockRejectedValueOnce(new Error('claim store unavailable'));
    const result = await executeProgressLeaseRemedy(certificate({ kind: 'leader-claim', workItemId: 'WI-1' }));
    expect(result).toMatchObject({
      kind: 'leader-claim', disposition: 'failed', workItemId: 'WI-1',
      summary: expect.stringContaining('claim store unavailable'),
    });
  });
});
