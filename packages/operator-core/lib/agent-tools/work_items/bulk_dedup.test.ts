import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: 'sql-double' }),
  upsertRoutine: upsert,
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'active-ws' }));

const tool = (await import('./bulk_dedup')).default;

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({
    id: 'rt-bulk-1',
    nextFireAt: new Date('2026-08-26T21:00:00.000Z'),
    targetRole: 'system:work-item-admission-bulk-dedup',
  });
});

describe('work_items:bulk_dedup handler', () => {
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
      'sql-double',
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

  it('uses the explicit workspace override instead of context', async () => {
    await tool.handler({ harness: 'papercusp', workspace: 'override-ws', confirm: true }, {
      workspaceId: 'ctx-ws',
    } as never);
    expect(upsert).toHaveBeenCalledWith(
      'sql-double',
      expect.objectContaining({ workspaceId: 'override-ws' }),
      expect.any(Function),
    );
  });
});
