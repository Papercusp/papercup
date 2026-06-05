/**
 * Verification for the ported `admin` family. Covers the auth gate
 * (custom-bearer routes return 401 on bad auth; trust-gated routes pass
 * with a mocked trusted principal), validation branches, and the cheap
 * happy paths. PG-backed llm-tests list routes are exercised only for
 * their pre-DB validation branches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'system', slug: 'system:operator', workspaceId: 'ws',
    authMethod: 'superuser-bearer', trust: 'trusted',
    capabilities: new Set(['*']), label: 'su',
  })),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
  },
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('@papercusp/sse', () => ({
  sseResponse: vi.fn(() => new Response('event: x\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })),
}));
vi.mock('../../admin-commands', () => ({
  listCommands: vi.fn(() => [{ id: 'c1', label: 'C1', command: 'echo', cwd: '/' }]),
  getCommand: vi.fn(() => undefined),
}));
vi.mock('../../llm-testing/scenarios', () => ({ SCENARIOS: [] }));
vi.mock('../../admin-tables', () => ({
  listAdminTables: vi.fn(() => []),
  getAdminTable: vi.fn(() => undefined),
}));
vi.mock('../../execute-action', () => ({
  deriveCallerFromBearer: vi.fn(async () => ({ ok: false, error: 'invalid_or_missing_token', status: 401, detail: null })),
  validateIdentityFields: vi.fn(() => null),
  executeAction: vi.fn(),
}));
vi.mock('../../backup/orphan-cleanup', () => ({ sweepOrphanSnapshots: vi.fn(async () => ({ swept: 0 })) }));
vi.mock('../../search/embed-backfill', () => ({ runBackfillSweep: vi.fn(async () => ({ tables: [] })) }));
vi.mock('../../spawn-signing', () => ({ rotateSpawnSigningKey: vi.fn(async () => {}) }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import adminBackupOrphanCleanup from '../routes/admin/backup-orphan-cleanup';
import adminCommands from '../routes/admin/commands';
import adminEmbedBackfill from '../routes/admin/embed-backfill';
import adminExecuteAction from '../routes/admin/execute-action';
import adminLlmTestsScenarios from '../routes/admin/llm-tests-scenarios';
import adminLlmTestsFindingById from '../routes/admin/llm-tests-finding-by-id';
import adminPruneExecutedActions from '../routes/admin/prune-executed-actions';
import adminRotateToken from '../routes/admin/rotate-token';
import adminRun from '../routes/admin/run';
import adminSpawnSigningRotate from '../routes/admin/spawn-signing-rotate';
import adminTables from '../routes/admin/tables';
import adminTestingAiExplore from '../routes/admin/testing-ai-explore';
import adminTestingTestRuns from '../routes/admin/testing-test-runs';
import adminTestingTestRunsById from '../routes/admin/testing-test-runs-by-id';
import adminTestingTestRunsCancel from '../routes/admin/testing-test-runs-cancel';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}
const json = (b: unknown) => ({
  method: 'POST',
  body: JSON.stringify(b),
  headers: { 'content-type': 'application/json' },
});

afterEach(() => vi.clearAllMocks());

describe('admin family ports', () => {
  it('GET /admin/commands lists registered commands', async () => {
    const res = await appWith(adminCommands as AnyRoute).request('/admin/commands');
    expect(res.status).toBe(200);
    expect((await res.json()).commands).toHaveLength(1);
  });

  it('GET /admin/llm-tests/scenarios returns scenarios', async () => {
    const res = await appWith(adminLlmTestsScenarios as AnyRoute).request('/admin/llm-tests/scenarios');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scenarios: [] });
  });

  it('GET /admin/tables returns the table list', async () => {
    const res = await appWith(adminTables as AnyRoute).request('/admin/tables');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tables: [] });
  });

  it('POST /admin/execute-action returns 401 on bad bearer', async () => {
    const res = await appWith(adminExecuteAction as AnyRoute)
      .request('/admin/execute-action', json({ verb: 'x' }));
    expect(res.status).toBe(401);
  });

  it('POST /admin/prune-executed-actions returns 401 on bad bearer', async () => {
    const res = await appWith(adminPruneExecutedActions as AnyRoute)
      .request('/admin/prune-executed-actions', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('POST /admin/rotate-token returns 401 on bad bearer', async () => {
    const res = await appWith(adminRotateToken as AnyRoute)
      .request('/admin/rotate-token', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('POST /admin/backup-orphan-cleanup sweeps (trusted principal)', async () => {
    const res = await appWith(adminBackupOrphanCleanup as AnyRoute)
      .request('/admin/backup-orphan-cleanup', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('POST /admin/embed-backfill runs the sweep (trusted principal)', async () => {
    const res = await appWith(adminEmbedBackfill as AnyRoute)
      .request('/admin/embed-backfill', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('POST /admin/spawn-signing/rotate rotates the key (trusted principal)', async () => {
    const res = await appWith(adminSpawnSigningRotate as AnyRoute)
      .request('/admin/spawn-signing/rotate', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('GET /admin/run rejects a missing ?cmd with 400', async () => {
    const res = await appWith(adminRun as AnyRoute).request('/admin/run');
    expect(res.status).toBe(400);
  });

  it('GET /admin/run returns 404 for an unknown command', async () => {
    const res = await appWith(adminRun as AnyRoute).request('/admin/run?cmd=nope');
    expect(res.status).toBe(404);
  });

  it('POST /admin/testing/ai-explore rejects a goal-less body with 400', async () => {
    const res = await appWith(adminTestingAiExplore as AnyRoute)
      .request('/admin/testing/ai-explore', json({ startUrl: 'http://x' }));
    expect(res.status).toBe(400);
  });

  it('POST /admin/testing/test-runs rejects a missing suiteId with 400', async () => {
    const res = await appWith(adminTestingTestRuns as AnyRoute)
      .request('/admin/testing/test-runs', json({}));
    expect(res.status).toBe(400);
  });

  it('POST /admin/testing/test-runs starts a detached run', async () => {
    const res = await appWith(adminTestingTestRuns as AnyRoute)
      .request('/admin/testing/test-runs', json({ suiteId: 'desktop-health' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runId: expect.stringContaining('testrun-'),
      snapshot: expect.objectContaining({ selection: 'desktop-health' }),
    });
  });

  it('GET /admin/testing/test-runs/:runId returns 404 for an unknown run id', async () => {
    const res = await appWith(adminTestingTestRunsById as AnyRoute)
      .request('/admin/testing/test-runs/nope');
    expect(res.status).toBe(404);
  });

  it('POST /admin/testing/test-runs/:runId/cancel returns 404 for an unknown run id', async () => {
    const res = await appWith(adminTestingTestRunsCancel as AnyRoute)
      .request('/admin/testing/test-runs/nope/cancel', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('PATCH /admin/llm-tests/findings/:id rejects invalid JSON with 400', async () => {
    const res = await appWith(adminLlmTestsFindingById as AnyRoute).request('/admin/llm-tests/findings/abc', {
      method: 'PATCH', body: 'not json', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /admin/llm-tests/findings/:id requires an acknowledged boolean', async () => {
    const res = await appWith(adminLlmTestsFindingById as AnyRoute)
      .request('/admin/llm-tests/findings/abc', { ...json({ acknowledgedBy: 'me' }), method: 'PATCH' });
    expect(res.status).toBe(400);
  });
});
