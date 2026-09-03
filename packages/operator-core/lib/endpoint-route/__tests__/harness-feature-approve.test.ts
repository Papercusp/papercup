/**
 * harness-feature-approve.test.ts — Plan 1 P-022: gate review/approve endpoint.
 *
 * POST /harness/:slug/features/:id/approve-human is the server-side half of
 * the human-in-the-loop approval gate: the reviewer UI calls this to clear
 * `needs_human_review` on a feature after inspecting the worker's output.
 *
 * Pattern from design.test.ts: import the route module directly + use
 * registerRoute, NOT registerAllRoutes (avoids the agent-mcp/bootstrap
 * db-org generated-schema access at module evaluation time).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...((await orig()) as object),
  getLegacyClient: vi.fn(),
  withWorkspaceLegacy: vi.fn(),
  getOrgPg: vi.fn(() => ({ db: {}, sql: vi.fn(async () => []) })),
  // approveHumanReview (WI-5381: migrated off getLegacyClient) reads/writes via
  // harnessQuery/harnessTransaction — both must be mocked explicitly, or the REAL
  // implementation runs here (spread from `orig()`) and tries to reach live Postgres,
  // which this unit test environment has none of. See mockHarnessQuerySequence below.
  harnessQuery: vi.fn(),
  harnessTransaction: vi.fn(),
}));
vi.mock('../../harness-core', () => ({
  resolveProject: vi.fn(),
  resolvePhasedProject: vi.fn(),
  harnessDir: vi.fn(() => '/tmp'),
  rowToFeature: vi.fn((r: any) =>
    r ? { id: r.feature_id ?? '', needs_human_review: r.needs_human_review } : null,
  ),
}));
vi.mock('../../feature-audit', () => ({ auditFeatureChange: vi.fn() }));
vi.mock('../../plugin-host-runtime', () => ({
  firePluginLifecycle: vi.fn(),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../harness-phases', () => ({ phasePhaseLabel: vi.fn((p: string) => p ?? 'staging') }));
vi.mock('../../plan-context-for-feature', () => ({
  getPlanContextForFeature: vi.fn(async () => null),
}));
// backup requires workspacesRoot at import time
vi.mock('../../backup', () => ({ workspaceBackupFor: vi.fn() }));
vi.mock('@papercusp/flags', async (orig) => ({
  ...((await orig()) as object),
  FLAG_DEFAULTS: {},
  ALL_FLAG_KEYS: [],
}));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import harnessFeatures from '../routes/harness/features';
import { resolveProject } from '../../harness-core';
import { harnessQuery, harnessTransaction } from '@papercusp/db-org';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

const mockProject = { slug: 'sheets', path: '/tmp/sheets' };
const mockFeature = {
  harness_slug: 'sheets',
  feature_id: 'F-001',
  title: 'Auth',
  status: 'validating',
  needs_human_review: 1,
  project_id: null,
  attempts: 0,
};

// harnessQuery's callback receives a postgres.js-shaped `sql` TAGGED TEMPLATE
// function (`sql\`SELECT ...\``), not a sqlite-style `.prepare().get()` handle — this
// fake tag ignores the query text/params and always resolves with `rows`, matching
// how the real driver's tag call returns a Promise<row[]>.
function fakeSqlTag(rows: any[]) {
  return (async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows) as any;
}

// Queues one row-set per harnessQuery() call, in order (approveHumanReview calls it
// twice: once for existingRows, once for updatedRows after the transaction). The last
// entry repeats for any further call.
function mockHarnessQuerySequence(...rowSets: any[][]) {
  let call = 0;
  vi.mocked(harnessQuery).mockImplementation(async (_slug: string, cb: any) => {
    const rows = rowSets[Math.min(call, rowSets.length - 1)];
    call += 1;
    return cb(fakeSqlTag(rows));
  });
}

// harnessTransaction just needs to invoke its callback with a tag function whose
// INSERT/UPDATE calls resolve to an empty row-set — the handler never reads the
// transaction's own return value.
function mockHarnessTransaction() {
  vi.mocked(harnessTransaction).mockImplementation(async (_slug: string, fn: any) =>
    fn(fakeSqlTag([])),
  );
}

function makeApp(): Hono {
  const app = new Hono();
  for (const def of Array.isArray(harnessFeatures) ? harnessFeatures : [harnessFeatures]) {
    registerRoute(app, def as AnyRoute);
  }
  return app;
}

function post(app: Hono, slug: string, id: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return app.request(`/harness/${slug}/features/${id}/approve-human`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.resetAllMocks());

describe('POST /harness/:slug/features/:id/approve-human', () => {
  it('returns 404 when project is not found', async () => {
    vi.mocked(resolveProject).mockResolvedValue(null as any);
    // harnessQuery is never reached (the route returns before it) — no mock needed.
    const app = makeApp();
    const res = await post(app, 'unknown', 'F-001');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/unknown project/i);
  });

  it('returns 404 when feature is not found', async () => {
    vi.mocked(resolveProject).mockResolvedValue(mockProject as any);
    mockHarnessQuerySequence([]); // existingRows: no matching row
    const app = makeApp();
    const res = await post(app, 'sheets', 'F-MISSING');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/feature not found/i);
  });

  it('returns 400 when feature does not need review', async () => {
    vi.mocked(resolveProject).mockResolvedValue(mockProject as any);
    mockHarnessQuerySequence([{ ...mockFeature, needs_human_review: 0 }]);
    const app = makeApp();
    const res = await post(app, 'sheets', 'F-001');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/does not need human review/i);
  });

  it('returns ok:true on successful approval', async () => {
    vi.mocked(resolveProject).mockResolvedValue(mockProject as any);
    mockHarnessQuerySequence([mockFeature], [{ ...mockFeature, needs_human_review: 0 }]);
    mockHarnessTransaction();
    const app = makeApp();
    const res = await post(app, 'sheets', 'F-001');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.approvedBy).toBe('human');
  });

  it('uses x-actor header as the approvedBy value', async () => {
    vi.mocked(resolveProject).mockResolvedValue(mockProject as any);
    mockHarnessQuerySequence([mockFeature], [{ ...mockFeature, needs_human_review: 0 }]);
    mockHarnessTransaction();
    const app = makeApp();
    const res = await post(app, 'sheets', 'F-001', {}, { 'x-actor': 'avi' });
    const body = await res.json();
    expect(body.approvedBy).toBe('avi');
  });
});
