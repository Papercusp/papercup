import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import type { DreamCycleDeps, DreamCycleInput } from './dream-cycle';
import { productionDreamCycle } from './dream-cycle-action';

const h = vi.hoisted(() => ({
  run: vi.fn(),
  sql: vi.fn(),
  registry: vi.fn(),
  packet: vi.fn(),
  sources: vi.fn(),
  sink: vi.fn(),
  begin: vi.fn(),
  select: vi.fn(),
  settle: vi.fn(),
  review: vi.fn(),
  finish: vi.fn(),
  history: vi.fn(),
  preflight: vi.fn(),
  admit: vi.fn(),
  spend: vi.fn(),
  flag: vi.fn(),
  idle: vi.fn(),
}));
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { workflowID: 'workflow-stable' } }));
vi.mock('@papercusp/db-org', async (original) => ({ ...(await original<object>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: h.flag }));
vi.mock('../owner-steering', () => ({ idleActivityAllowed: h.idle }));
vi.mock('../scout/cadence-signals', () => ({ readHiveIdleRatio: vi.fn() }));
vi.mock('../llm-testing/llm-client', () => ({ llmCall: vi.fn() }));
vi.mock('../harness-registry', async (original) => ({
  ...(await original<object>()),
  loadHarnessRegistry: h.registry,
}));
vi.mock('./dream-cycle', () => ({ runDreamCycle: h.run }));
vi.mock('./capability-packets', () => ({ buildCapabilityPacket: h.packet }));
vi.mock('./capability-review-sources', () => ({ buildCapabilityReviewSources: h.sources }));
vi.mock('./dream-sink', () => ({ sinkDreamInsight: h.sink }));
vi.mock('./dream-governor', () => ({
  preflightDreamCycle: h.preflight,
  admitDreamRunCall: h.admit,
  recordDreamRunSpend: h.spend,
}));
vi.mock('./dream-run-store', () => ({
  beginDreamRun: h.begin,
  recordDreamRunSelection: h.select,
  settleDreamRunCall: h.settle,
  recordDreamRunReview: h.review,
  finalizeDreamRun: h.finish,
  listDreamRuns: h.history,
}));

const ctx = { workspaceId: 'ws-production-test', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };
beforeEach(() => {
  vi.clearAllMocks();
  h.registry.mockResolvedValue({
    projects: [{ slug: 'papercusp', path: '/registered/repository', self_repo: true, harness_kind: 'hive' }],
  });
  h.flag.mockImplementation(async (flag) => flag === FLAGS.DREAM_CYCLE);
  h.sql.mockResolvedValue([{ active: true }]);
  h.idle.mockResolvedValue(true);
  h.packet.mockResolvedValue({ status: 'unavailable', reason: 'No fixture source', costUsd: 0, durationMs: 0 });
  h.run.mockResolvedValue({ reason: 'completed' });
});
function captured() {
  const [input, deps] = h.run.mock.calls[0]! as [DreamCycleInput, DreamCycleDeps];
  return { input, deps };
}

describe('production capability Dream adapter', () => {
  it('binds the registered repository, stable workflow identity and scoped persistent adapters', async () => {
    await productionDreamCycle(ctx, { mode: 'manual' });
    const { input } = captured();
    expect(h.registry).toHaveBeenCalledWith(ctx.workspaceId);
    expect(input).toMatchObject({ workspaceId: ctx.workspaceId, potSlug: ctx.installSlug, cycleId: 'workflow-stable' });
    expect(captured().deps.exclusiveReplay).toBe(true);
  });

  it('loads only the capability manifest and preserves scope across every write', async () => {
    await productionDreamCycle(ctx, { mode: 'manual' });
    const { input, deps } = captured();
    expect(input).toMatchObject({
      workspaceId: ctx.workspaceId,
      potSlug: ctx.installSlug,
      rootPath: '/registered/repository',
      repositoryId: ctx.installSlug,
      cycleId: 'workflow-stable',
    });
    await deps.loadPackets(new AbortController().signal);
    expect(h.packet).toHaveBeenCalledTimes(input.manifest.units.length);
    expect(h.packet).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: '/registered/repository',
        scope: { workspaceId: ctx.workspaceId, potSlug: ctx.installSlug, repositoryId: ctx.installSlug },
      }),
    );
    const call = { callId: 'generation', phase: 'generation' as const, model: 'test', reservedUsd: 0.1 };
    await deps.beginCall({ runId: 'run', call });
    expect(h.admit).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({ workspaceId: ctx.workspaceId, potSlug: ctx.installSlug, runId: 'run', call }),
    );
    await deps.sink('run', []);
    expect(h.sink).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capability',
        sql: h.sql,
        workspaceId: ctx.workspaceId,
        dreamRunId: 'run',
        rootPath: '/registered/repository',
      }),
    );
  });

  it('manual pause and feature disable stop subsequent phases; auto also rechecks the separate owner toggle', async () => {
    await productionDreamCycle(ctx, { mode: 'manual' });
    const manual = captured().deps;
    expect(await manual.canContinue!()).toBe(true);
    expect(h.idle).not.toHaveBeenCalled();
    h.sql.mockResolvedValue([{ active: false }]);
    expect(await manual.canContinue!()).toBe(false);
    h.sql.mockResolvedValue([{ active: true }]);
    h.flag.mockResolvedValue(false);
    expect(await manual.canContinue!()).toBe(false);
    h.flag.mockImplementation(async (flag) => flag === FLAGS.DREAM_CYCLE);
    h.run.mockClear();
    await productionDreamCycle(ctx, { mode: 'auto' });
    h.idle.mockResolvedValue(false);
    expect(await captured().deps.canContinue!()).toBe(false);
    expect(h.idle).toHaveBeenCalledWith(ctx.workspaceId, 'dream', ctx.installSlug);
    const queries = h.sql.mock.calls.map((c) => c.slice(1));
    expect(queries).toContainEqual([ctx.workspaceId, ctx.installSlug, 'dream-cycle-manual']);
    expect(queries).toContainEqual([ctx.workspaceId, ctx.installSlug, 'dream-cycle-auto']);
  });

  it('does not fall back to process.cwd when the requested repository is unregistered', async () => {
    h.registry.mockResolvedValue({ projects: [] });
    await expect(productionDreamCycle(ctx, { mode: 'manual' })).rejects.toThrow('registered repository');
    expect(h.run).not.toHaveBeenCalled();
  });
});
