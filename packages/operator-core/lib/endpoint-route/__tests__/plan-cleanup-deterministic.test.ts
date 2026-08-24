import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  createRun: vi.fn(),
  setRunPhase: vi.fn(),
  deterministic: vi.fn(),
  buildCall: vi.fn((_args: unknown) => vi.fn()),
  invalidate: vi.fn(async () => undefined),
}));

vi.mock('../../require-flag', () => ({ gateApiRoute: vi.fn(async () => null) }));
vi.mock('../../cors', () => ({ requireAllowedOriginOr403: vi.fn(() => null) }));
vi.mock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
vi.mock('../../attention/bulk-run-sync', () => ({
  notifyPlanCleanupRunChanged: () => H.invalidate(),
}));
vi.mock('../../attention/bulk-run-store', () => {
  class BulkRunAlreadyActiveError extends Error {
    code = 'run_already_active';
    activeRunId = null;
    activePhase = null;
  }
  return {
    BulkRunAlreadyActiveError,
    createRun: (...args: unknown[]) => H.createRun(...args),
    failRunIfExecuting: vi.fn(),
    setRunPhase: (...args: unknown[]) => H.setRunPhase(...args),
    settleRunPhase: vi.fn(),
  };
});
vi.mock('../../plan-cleanup/run-store', () => ({ markCleanupFindingAccepted: vi.fn() }));
vi.mock('../../plan-cleanup/resolver-brief', () => ({ buildCleanupResolverBrief: vi.fn(() => 'brief') }));
vi.mock('../../plan-cleanup/deterministic-runner', () => ({
  buildPlanCleanupSystemCall: (args: unknown) => H.buildCall(args),
  runDeterministicPlanCleanup: (args: unknown) => H.deterministic(args),
}));
vi.mock('../routes/admin/attention-bulk-resolve', () => ({
  buildResolverLaunchCommand: vi.fn(() => 'psu'),
  preflightResolverLaunch: vi.fn(() => ({
    ok: true,
    launch: { model: null, effort: null, account: 'default', carry: 'warm', backend: 'claude' },
  })),
  resolverSpawnOutcome: vi.fn(),
}));

import { planCleanupHandler } from '../routes/admin/plan-cleanup';

const RUN = {
  runId: 'run-det',
  workspaceId: 'workspace-1',
  harnessSlug: 'papercusp',
  requestedBy: 'owner',
  resolverOwner: null,
  phase: 'pending',
  runKind: 'plan-cleanup',
  seedRefs: ['plan-a'],
  filterSnapshot: {},
  launchSnapshot: {},
  totalItems: 1,
  autoResolved: 0,
  recommended: 0,
  skipped: 0,
  failed: 0,
  error: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  heartbeatAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  H.createRun.mockResolvedValue({ ...RUN });
  H.deterministic.mockResolvedValue({
    needsResolver: false,
    phase: 'complete',
    passes: 2,
    applied: 1,
    skipped: 0,
    failed: 0,
    appliedFindingIds: ['flip-to-done:papercusp/plan-a#P-001'],
    recommendationFindingIds: [],
    reconciliationRequired: [],
    fatalError: null,
    authorityRevoked: false,
  });
});

describe('POST /admin/plan-cleanup deterministic start', () => {
  it('returns a successful no-resolver receipt when the deterministic pass exhausts the run', async () => {
    const response = await planCleanupHandler(
      new Request('http://localhost/api/admin/plan-cleanup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'start',
          planSlugs: ['plan-a'],
          launch: { model: null, effort: null, account: 'default', carry: 'warm' },
        }),
      }),
      {
        principal: null,
        input: undefined,
        params: {},
        log: vi.fn(),
        signal: new AbortController().signal,
      },
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      ok: true,
      runId: 'run-det',
      phase: 'complete',
      launched: false,
      resolverNeeded: false,
      deterministic: { applied: 1, failed: 0 },
    });
    expect(H.deterministic).toHaveBeenCalledTimes(1);
    expect(H.buildCall).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-det' }));
    expect(H.setRunPhase).not.toHaveBeenCalled();
  });
});
