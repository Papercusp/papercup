import { describe, expect, it, vi } from 'vitest';
import { bulkDedupOwnerId, makeWorkItemAdmissionBulkDedupAction } from './work-item-admission-bulk-dedup-action';

describe('work-item admission bulk dedup system action', () => {
  it('derives a stable, run-scoped gateway owner id', () => {
    expect(bulkDedupOwnerId('run-1')).toBe('system:work-item-admission-bulk-dedup:run-1');
    expect(bulkDedupOwnerId('run-1')).toBe(bulkDedupOwnerId('run-1'));
    expect(bulkDedupOwnerId('run-2')).not.toBe(bulkDedupOwnerId('run-1'));
  });

  it('runs the durable bulk job, invalidates the shared ledger query, and logs convergence', async () => {
    const run = vi.fn(async () => ({
      runId: 'bulk-live-1',
      scope: 'full-corpus' as const,
      converged: true,
      convergenceReason: 'global-zero' as const,
      initialCensus: 19,
      finalCensus: 0,
      finalScopedPairs: 0,
      stages: [],
    }));
    const invalidate = vi.fn(async () => undefined);
    const log = vi.fn();
    const action = makeWorkItemAdmissionBulkDedupAction({ run, invalidate, log });

    await action({
      workspaceId: 'ws',
      installSlug: 'papercusp',
      triggerConfig: {},
      payloadTemplate: { runId: 'bulk-live-1' },
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws', installSlug: 'papercusp' }));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('census=19->0'));
  });
});
