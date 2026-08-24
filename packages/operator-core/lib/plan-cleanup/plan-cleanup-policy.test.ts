import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActiveRunError extends Error {
    code = 'run_already_active';
    activeRunId = 'cleanup-live';
    activePhase = 'running';
  }
  return {
  ActiveRunError,
  createRun: vi.fn(),
  getRun: vi.fn(),
  getLatestRun: vi.fn(),
  setRunPhase: vi.fn(),
  settleRunPhase: vi.fn(),
  failRunIfExecuting: vi.fn(),
  markCleanupFindingAccepted: vi.fn(),
  getRunFindings: vi.fn(),
  notifyPlanCleanupRunChanged: vi.fn(),
  requireAllowedOriginOr403: vi.fn(),
  gateApiRoute: vi.fn(),
  buildConsoleEnvelope: vi.fn(),
  spawnHeadless: vi.fn(),
  resolveSpawnHostOperatorBaseUrl: vi.fn(),
  buildResolverLaunchCommand: vi.fn(),
  resolverSpawnOutcome: vi.fn(),
  child: { once: vi.fn() },
  };
});

vi.mock('../attention/bulk-run-store', () => ({
  BulkRunAlreadyActiveError: h.ActiveRunError,
  createRun: h.createRun,
  getRun: h.getRun,
  getLatestRun: h.getLatestRun,
  setRunPhase: h.setRunPhase,
  settleRunPhase: h.settleRunPhase,
  failRunIfExecuting: h.failRunIfExecuting,
}));
vi.mock('./run-store', () => ({
  markCleanupFindingAccepted: h.markCleanupFindingAccepted,
  getRunFindings: h.getRunFindings,
}));
vi.mock('../attention/bulk-run-sync', () => ({
  notifyPlanCleanupRunChanged: h.notifyPlanCleanupRunChanged,
}));
vi.mock('../endpoint-route/cors', () => ({
  requireAllowedOriginOr403: h.requireAllowedOriginOr403,
}));
vi.mock('../require-flag', () => ({ gateApiRoute: h.gateApiRoute }));
vi.mock('../console-launcher', () => ({ buildConsoleEnvelope: h.buildConsoleEnvelope }));
vi.mock('../console-spawn', () => ({ spawnHeadless: h.spawnHeadless }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
vi.mock('../mcp-base-url', () => ({
  resolveSpawnHostOperatorBaseUrl: h.resolveSpawnHostOperatorBaseUrl,
}));
vi.mock('../endpoint-route/routes/admin/attention-bulk-resolve', () => ({
  buildResolverLaunchCommand: h.buildResolverLaunchCommand,
  resolverSpawnOutcome: h.resolverSpawnOutcome,
}));

import {
  MAX_RUN_PLANS,
  parsePlanSlugs,
  planCleanupHandler,
} from '../endpoint-route/routes/admin/plan-cleanup';
import { getRegistryEntryV2 } from '../sync-resolver/index';

const run = {
  runId: 'cleanup-1',
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp',
  phase: 'pending',
  runKind: 'plan-cleanup',
  seedRefs: ['plan-a', 'plan-b'],
  totalItems: 2,
};

function request(body: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1:3070/api/admin/plan-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.createRun.mockResolvedValue(run);
  h.setRunPhase.mockResolvedValue({ ...run, phase: 'running' });
  h.settleRunPhase.mockResolvedValue({ ...run, phase: 'complete' });
  h.failRunIfExecuting.mockResolvedValue(null);
  h.markCleanupFindingAccepted.mockResolvedValue({
    finding: { findingId: 'stale-now:papercusp/plan-a', outcome: 'accepted' },
    run: { ...run, phase: 'review' },
  });
  h.notifyPlanCleanupRunChanged.mockResolvedValue(undefined);
  h.requireAllowedOriginOr403.mockReturnValue(null);
  h.gateApiRoute.mockResolvedValue(null);
  h.buildConsoleEnvelope.mockResolvedValue({ env: { BASE: '1' }, greetingCmd: 'old' });
  h.resolveSpawnHostOperatorBaseUrl.mockResolvedValue('http://127.0.0.1:3070');
  h.buildResolverLaunchCommand.mockReturnValue('psu --headless');
  h.spawnHeadless.mockResolvedValue({ status: 'ok', child: h.child });
  h.resolverSpawnOutcome.mockReturnValue({ ok: true, sessionId: 'su-resolver', child: h.child });
  h.getRunFindings.mockResolvedValue([{ findingId: 'f-1' }]);
});

describe('plan-cleanup route policy', () => {
  it('dedupes and caps the click-time plan snapshot', () => {
    const input = [' plan-a ', 'plan-a', ...Array.from({ length: MAX_RUN_PLANS + 10 }, (_, i) => `p-${i}`)];
    const parsed = parsePlanSlugs(input);
    expect(parsed[0]).toBe('plan-a');
    expect(parsed).toHaveLength(MAX_RUN_PLANS);
    expect(new Set(parsed).size).toBe(parsed.length);
  });

  it('creates a plan-kind run and launches a supervised resolver with the run brief', async () => {
    const response = await planCleanupHandler(
      request({ planSlugs: ['plan-a', 'plan-b'], harness: 'papercusp', filter: { q: 'active' } }),
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runId: run.runId, launched: true });
    expect(h.createRun).toHaveBeenCalledWith(expect.objectContaining({
      items: [],
      runKind: 'plan-cleanup',
      seedRefs: ['plan-a', 'plan-b'],
      harnessSlug: 'papercusp',
    }));
    expect(h.spawnHeadless).toHaveBeenCalledWith(expect.objectContaining({
      label: expect.stringContaining('plan-cleanup-'),
      launchedBy: 'plan-cleanup',
      envelope: expect.objectContaining({
        greetingCmd: 'psu --headless',
        env: expect.objectContaining({
          PAPERCUSP_KICKOFF_PROMPT: expect.stringContaining('plans:cleanup-manifest'),
        }),
      }),
    }));
    expect(h.setRunPhase).toHaveBeenCalledWith({
      runId: run.runId,
      phase: 'running',
      resolverOwner: 'su-resolver',
    });
  });

  it('returns a visible failed run when launch fails instead of failing the request', async () => {
    h.resolverSpawnOutcome.mockReturnValue({ ok: false, error: 'psu boot failed' });
    const response = await planCleanupHandler(request({ planSlugs: ['plan-a'] }), {} as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      runId: run.runId,
      phase: 'failed',
      launched: false,
      launchError: 'psu boot failed',
    });
    expect(h.setRunPhase).toHaveBeenCalledWith({
      runId: run.runId,
      phase: 'failed',
      error: 'psu boot failed',
    });
  });

  it('keeps stop reachable while the feature gate would refuse acting', async () => {
    h.gateApiRoute.mockResolvedValue(new Response(null, { status: 404 }));
    const response = await planCleanupHandler(request({ op: 'stop', runId: run.runId }), {} as never);
    expect(response.status).toBe(200);
    expect(h.gateApiRoute).not.toHaveBeenCalled();
    expect(h.settleRunPhase).toHaveBeenCalledWith({ runId: run.runId });
  });

  it('records acceptance only after the client names the reviewed finding', async () => {
    const response = await planCleanupHandler(
      request({ op: 'accept', runId: run.runId, findingId: 'stale-now:papercusp/plan-a', note: 'Approved' }),
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(h.markCleanupFindingAccepted).toHaveBeenCalledWith({
      runId: run.runId,
      findingId: 'stale-now:papercusp/plan-a',
      note: 'Approved',
    });
    expect(h.settleRunPhase).toHaveBeenCalledWith({ runId: run.runId });
  });
});

describe('plans.cleanupRun sync resolver', () => {
  it('returns an explicit idle row and filters the latest read to plan-cleanup', async () => {
    h.getLatestRun.mockResolvedValue(null);
    const rows = await getRegistryEntryV2('plans.cleanupRun')!.resolve!({} as never);
    expect(h.getLatestRun).toHaveBeenCalledWith(undefined, 'plan-cleanup');
    expect(rows).toEqual([{ run: null, findings: [] }]);
  });

  it('returns one run with its findings and rejects an explicit inbox-kind run', async () => {
    h.getRun.mockResolvedValue({ ...run, phase: 'review' });
    expect(
      await getRegistryEntryV2('plans.cleanupRun')!.resolve!({ runId: run.runId } as never),
    ).toEqual([{ run: { ...run, phase: 'review' }, findings: [{ findingId: 'f-1' }] }]);

    h.getRun.mockResolvedValue({ ...run, runKind: 'inbox-resolve' });
    expect(
      await getRegistryEntryV2('plans.cleanupRun')!.resolve!({ runId: 'inbox-1' } as never),
    ).toEqual([{ run: null, findings: [] }]);
  });
});
