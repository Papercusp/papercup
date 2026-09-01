import { describe, expect, it, vi } from 'vitest';
import { getSystemActionEntry } from './system-actions';
import {
  BULK_DEDUP_ROUTINE_FIRE_TIMEOUT_MS,
  bulkDedupOwnerId,
  bulkDedupRuntimeWiring,
  makeWorkItemAdmissionBulkDedupAction,
} from './work-item-admission-bulk-dedup-action';
import { runCheckpointedStep } from '../../dbos/checkpointed-step';
import { defaultBulkDedupPreflight } from '../../work-items-admission-bulk-dedup';

describe('work-item admission bulk dedup system action', () => {
  it('registers a bounded long-running routine deadline without changing the generic default', () => {
    expect(getSystemActionEntry('work-item-admission-bulk-dedup')).toMatchObject({
      ownSteps: true,
      routineTimeoutMs: BULK_DEDUP_ROUTINE_FIRE_TIMEOUT_MS,
    });
    expect(BULK_DEDUP_ROUTINE_FIRE_TIMEOUT_MS).toBe(24 * 60 * 60_000);
  });

  it('derives a stable, run-scoped gateway owner id', () => {
    expect(bulkDedupOwnerId('run-1')).toBe('system:work-item-admission-bulk-dedup:run-1');
    expect(bulkDedupOwnerId('run-1')).toBe(bulkDedupOwnerId('run-1'));
    expect(bulkDedupOwnerId('run-2')).not.toBe(bulkDedupOwnerId('run-1'));
  });

  it('wires the workflow identity, DBOS checkpoint helper, and live capacity preflight into production', () => {
    const wiring = bulkDedupRuntimeWiring('run-1', 'routine-workflow-1');
    expect(wiring).toMatchObject({
      ownerId: 'system:work-item-admission-bulk-dedup:run-1',
      executionId: 'routine-workflow-1',
    });
    expect(wiring.step).toBe(runCheckpointedStep);
    expect(wiring.preflight).toBe(defaultBulkDedupPreflight);
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
