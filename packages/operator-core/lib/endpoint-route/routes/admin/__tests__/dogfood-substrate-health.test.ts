/**
 * dogfood-substrate-health.test.ts — GET /api/admin/dogfood-substrate-health.
 *
 * Route-shaped (defineTool), no injectable deps seam: it reads the in-process
 * boot map + bootstrap progress + per-harness claim stats and runs them through
 * the pure assess/summarise helpers. We mock those module imports and invoke
 * the exported handler directly — no PG, no Hypercore.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';

const H = vi.hoisted(() => {
  const state: {
    booted: Array<{ workspaceId: string; harnessSlug: string }>;
    progress: Array<{ workspaceId: string; harnessSlug: string }>;
    verdict: { verdict: string; reasons: string[] };
    summary: unknown;
  } = {
    booted: [],
    progress: [],
    verdict: { verdict: 'healthy', reasons: [] },
    summary: { worstVerdict: 'healthy' },
  };
  return {
    state,
    listBootedHandles: () => state.booted,
    listBootstrapProgress: () => state.progress,
    loadClaimAttemptStats: vi.fn(async () => ({ total: 0, won: 0, lost: 0 })),
    assessHarnessSubstrateHealth: vi.fn(() => state.verdict),
    summariseWorkspaceSubstrate: vi.fn(() => state.summary),
  };
});

vi.mock('../../../../sync/hyperbee/boot-all', () => ({ listBootedHandles: H.listBootedHandles }));
vi.mock('../../../../sync/hyperbee/bootstrap-progress', () => ({ listBootstrapProgress: H.listBootstrapProgress }));
vi.mock('../../../../orchestrator/load-claim-attempts', () => ({ loadClaimAttemptStats: H.loadClaimAttemptStats }));
vi.mock('../../../../sync/hyperbee/health', () => ({ assessHarnessSubstrateHealth: H.assessHarnessSubstrateHealth }));
vi.mock('../../../../sync/hyperbee/summary', () => ({ summariseWorkspaceSubstrate: H.summariseWorkspaceSubstrate }));
// Spread the real module — agent-mcp bootstrap imports `generated` from here.
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: vi.fn(async () => []) } }),
}));

import route from '../dogfood-substrate-health';

function ctx(): RouteContext {
  return { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal } as RouteContext;
}
const req = () => new Request('http://localhost/api/admin/dogfood-substrate-health');

beforeEach(() => {
  H.state.booted = [];
  H.state.progress = [];
  H.state.verdict = { verdict: 'healthy', reasons: [] };
  H.loadClaimAttemptStats.mockClear();
  H.assessHarnessSubstrateHealth.mockClear();
});

describe('dogfood-substrate-health route metadata', () => {
  it('exports one GET route at /admin/dogfood-substrate-health gated to verified/trusted', () => {
    expect(route).toHaveLength(1);
    expect(route[0].method).toBe('GET');
    expect(route[0].path).toBe('/admin/dogfood-substrate-health');
    expect(route[0].auth).toEqual({ trust: ['verified', 'trusted'] });
  });
});

describe('GET /admin/dogfood-substrate-health handler', () => {
  it('idle ground state: zero booted → flagEnabled:true, empty harnesses, summary passthrough', async () => {
    const res = await route[0].handler(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flagEnabled).toBe(true);
    expect(body.harnesses).toEqual([]);
    expect(body.summary).toEqual({ worstVerdict: 'healthy' });
    expect(H.assessHarnessSubstrateHealth).not.toHaveBeenCalled();
  });

  it('one verdict row per booted handle, carrying verdict + reasons', async () => {
    H.state.booted = [
      { workspaceId: 'ws1', harnessSlug: 'papercup' },
      { workspaceId: 'ws1', harnessSlug: 'restart' },
    ];
    H.state.verdict = { verdict: 'degraded', reasons: ['claims failing'] };
    const body = await (await route[0].handler(req(), ctx())).json();
    expect(body.harnesses).toEqual([
      { workspaceId: 'ws1', harnessSlug: 'papercup', verdict: 'degraded', reasons: ['claims failing'] },
      { workspaceId: 'ws1', harnessSlug: 'restart', verdict: 'degraded', reasons: ['claims failing'] },
    ]);
    // claim stats loaded once per booted handle
    expect(H.loadClaimAttemptStats).toHaveBeenCalledTimes(2);
  });
});
