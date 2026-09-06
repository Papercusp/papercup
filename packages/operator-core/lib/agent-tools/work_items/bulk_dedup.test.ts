import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, upsert } = vi.hoisted(() => ({ query: vi.fn(), upsert: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: query }),
  upsertRoutine: upsert,
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'active-ws' }));

const tool = (await import('./bulk_dedup')).default;

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue([]);
  Object.assign(query, {
    begin: async (callback: (tx: typeof query) => Promise<unknown>) => callback(query),
  });
  upsert.mockResolvedValue({
    id: 'rt-bulk-1',
    nextFireAt: new Date('2026-08-26T21:00:00.000Z'),
    targetRole: 'system:work-item-admission-bulk-dedup',
  });
});

describe('work_items:bulk_dedup handler', () => {
  it('previews a reviewed ledger without enqueuing, mutating, or calling a model', async () => {
    const out = (await tool.handler(
      {
        op: 'preview-reviewed',
        harness: 'papercusp',
        confirm: true,
        reviewedEntries: [
          {
            itemId: 'EI-missing',
            action: 'preserve',
            evidence: {
              status: 'unknown',
              ref: 'ledger#EI-missing',
              reason: 'no current evidence establishes a safe mutation',
            },
          },
        ],
      },
      { workspaceId: 'ctx-ws' } as never,
    )) as { data: Record<string, unknown> };

    expect(upsert).not.toHaveBeenCalled();
    expect(out.data).toMatchObject({
      ok: true,
      mode: 'preview-reviewed',
      schemaVersion: 'reviewed-admission-cleanup-preview-v1',
      mutates: false,
      modelCalled: false,
      counts: { total: 1, eligible: 0, preserved: 0, unknown: 1 },
      entries: [{ itemId: 'EI-missing', outcome: 'unknown' }],
    });
  });

  it('routes apply-reviewed through the scope-bound preview without enqueuing', async () => {
    const reviewedEntries = [
      {
        itemId: 'EI-missing',
        action: 'preserve' as const,
        evidence: {
          status: 'unknown' as const,
          ref: 'ledger#EI-missing',
          reason: 'no current evidence establishes a safe mutation',
        },
      },
    ];
    const preview = (await tool.handler(
      { op: 'preview-reviewed', harness: 'papercusp', confirm: true, reviewedEntries },
      { workspaceId: 'ctx-ws', ownerId: 'su-reviewer', role: 'su' } as never,
    )) as { data: Record<string, unknown> };
    const out = (await tool.handler(
      {
        op: 'apply-reviewed',
        harness: 'papercusp',
        confirm: true,
        reviewedEntries,
        previewHash: String(preview.data.previewHash),
        runId: 'reviewed-apply-1',
      },
      { workspaceId: 'ctx-ws', ownerId: 'su-reviewer', role: 'su' } as never,
    )) as { data: Record<string, unknown> };

    expect(upsert).not.toHaveBeenCalled();
    expect(out.data).toMatchObject({
      ok: false,
      mode: 'apply-reviewed',
      schemaVersion: 'reviewed-admission-cleanup-apply-v1',
      runId: 'reviewed-apply-1',
      requestedPreviewHash: preview.data.previewHash,
      currentPreviewHash: preview.data.previewHash,
      applied: false,
      mutates: false,
      modelCalled: false,
      reason: 'no-eligible-entries',
      counts: { total: 1, eligible: 0, merged: 0, retained: 1 },
    });
  });

  it('enqueues one durable due-now action with the bounded census controls', async () => {
    const out = (await tool.handler(
      {
        harness: 'papercusp',
        confirm: true,
        runId: 'bulk-1',
        maxStages: 4,
        pairsPerCall: 25,
        shardConcurrency: 3,
        targetTokens: 250_000,
        ceilingTokens: 900_000,
        chunkCount: 8,
        fullCorpusPairThreshold: 125,
      },
      { workspaceId: 'ctx-ws' } as never,
    )) as { data: Record<string, unknown> };

    expect(upsert).toHaveBeenCalledWith(
      query,
      expect.objectContaining({
        workspaceId: 'ctx-ws',
        installSlug: 'papercusp',
        targetRole: 'system:work-item-admission-bulk-dedup',
        triggerConfig: {},
        active: true,
        nextFireAt: expect.any(Date),
        payloadTemplate: {
          runId: 'bulk-1',
          maxStages: 4,
          pairsPerCall: 25,
          shardConcurrency: 3,
          targetTokens: 250_000,
          ceilingTokens: 900_000,
          chunkCount: 8,
          fullCorpusPairThreshold: 125,
        },
      }),
      expect.any(Function),
    );
    expect(out.data).toMatchObject({ ok: true, enqueued: true, runId: 'bulk-1', routineId: 'rt-bulk-1' });
  });

  it('refuses a same-run rearm while its deduplicated routineFire is live', async () => {
    query.mockResolvedValue([
      {
        routineId: 'rt_papercusp_work_item_admission_bulk_dedup_bulk_1',
        workflowUuid: 'wf-bulk-1',
        status: 'PENDING',
      },
    ]);

    const out = (await tool.handler(
      {
        harness: 'papercusp',
        confirm: true,
        runId: 'bulk-1',
        shardConcurrency: 1,
      },
      { workspaceId: 'ctx-ws' } as never,
    )) as { data: Record<string, unknown> };

    expect(out.data).toMatchObject({
      ok: false,
      enqueued: false,
      alreadyRunning: true,
      reason: 'already_running',
      runId: 'bulk-1',
      routineId: 'rt_papercusp_work_item_admission_bulk_dedup_bulk_1',
      workflowUuid: 'wf-bulk-1',
      workflowStatus: 'PENDING',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toBe('rt_papercusp_work_item_admission_bulk_dedup_bulk_1');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('uses the explicit workspace override instead of context', async () => {
    await tool.handler({ harness: 'papercusp', workspace: 'override-ws', confirm: true }, {
      workspaceId: 'ctx-ws',
    } as never);
    expect(upsert).toHaveBeenCalledWith(
      query,
      expect.objectContaining({ workspaceId: 'override-ws' }),
      expect.any(Function),
    );
  });
});
