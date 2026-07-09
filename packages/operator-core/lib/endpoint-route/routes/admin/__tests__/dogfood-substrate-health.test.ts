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
    drainByKey: Map<string, { undrainedCount: number; oldestUndrainedAgeMs: number | null }>;
    verdict: { verdict: string; reasons: string[] };
    summary: unknown;
    // EI-8816: cluster-role + cached-remote-snapshot seams for the blind-spot tests.
    isPrimary: boolean;
    cachedRemote: { handles: Array<{ workspaceId: string; harnessSlug: string }>; receivedAt: number } | null;
  } = {
    booted: [],
    progress: [],
    drainByKey: new Map(),
    verdict: { verdict: 'healthy', reasons: [] },
    summary: { worstVerdict: 'healthy' },
    isPrimary: true,
    cachedRemote: null,
  };
  return {
    state,
    listBootedHandles: () => state.booted,
    listBootstrapProgress: () => state.progress,
    loadSubstrateDrainStats: vi.fn(async () => state.drainByKey),
    loadClaimAttemptStats: vi.fn(async () => ({ total: 0, won: 0, lost: 0 })),
    assessHarnessSubstrateHealth: vi.fn(() => state.verdict),
    summariseWorkspaceSubstrate: vi.fn(() => state.summary),
    getCachedRemoteBootedHandles: () => state.cachedRemote,
  };
});

vi.mock('../../../../sync/hyperbee/boot-all', () => ({ listBootedHandles: H.listBootedHandles }));
vi.mock('../../../../sync/hyperbee/bootstrap-progress', () => ({ listBootstrapProgress: H.listBootstrapProgress }));
vi.mock('../../../../sync/hyperbee/load-drain-stats', () => ({ loadSubstrateDrainStats: H.loadSubstrateDrainStats }));
vi.mock('../../../../orchestrator/load-claim-attempts', () => ({ loadClaimAttemptStats: H.loadClaimAttemptStats }));
vi.mock('../../../../sync/hyperbee/health', () => ({ assessHarnessSubstrateHealth: H.assessHarnessSubstrateHealth }));
vi.mock('../../../../sync/hyperbee/summary', () => ({ summariseWorkspaceSubstrate: H.summariseWorkspaceSubstrate }));
vi.mock('../../../../sync/hyperbee/cluster-booted-handles-sync', () => ({
  getCachedRemoteBootedHandles: H.getCachedRemoteBootedHandles,
}));
// EI-8816: node:cluster.isPrimary drives resolveEffectiveBootedHandles' "am I the
// substrate owner" check — mock it so the worker-blind-spot branch is reachable in-test
// (a real vitest process is always isPrimary:true otherwise).
vi.mock('node:cluster', () => ({
  default: {
    get isPrimary() {
      return H.state.isPrimary;
    },
  },
}));
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
  H.state.drainByKey = new Map();
  H.state.verdict = { verdict: 'healthy', reasons: [] };
  H.state.isPrimary = true;
  H.state.cachedRemote = null;
  H.loadSubstrateDrainStats.mockClear();
  H.loadClaimAttemptStats.mockClear();
  H.assessHarnessSubstrateHealth.mockClear();
});

describe('dogfood-substrate-health route metadata', () => {
  it('exports one GET route at /admin/dogfood-substrate-health gated to verified/trusted/unverified-loopback', () => {
    expect(route).toHaveLength(1);
    expect(route[0].method).toBe('GET');
    expect(route[0].path).toBe('/admin/dogfood-substrate-health');
    // EI-8816: unverified-loopback included so the packaged (cookie-less) desktop
    // webview can reach this diagnostic route from localhost instead of 403ing.
    expect(route[0].auth).toEqual({ trust: ['verified', 'trusted', 'unverified-loopback'] });
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

  it('feeds substrate outbox drain stats into health assessment', async () => {
    H.state.booted = [{ workspaceId: 'ws1', harnessSlug: 'papercup' }];
    H.state.drainByKey = new Map([
      ['ws1::papercup', { undrainedCount: 2, oldestUndrainedAgeMs: 90_000 }],
    ]);
    await route[0].handler(req(), ctx());
    expect(H.loadSubstrateDrainStats).toHaveBeenCalledTimes(1);
    expect(H.assessHarnessSubstrateHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        drainStats: { undrainedCount: 2, oldestUndrainedAgeMs: 90_000 },
      }),
    );
  });

  it('idle ground state reports reachedSubstrateOwner:true (this process IS the owner)', async () => {
    const body = await (await route[0].handler(req(), ctx())).json();
    expect(body.reachedSubstrateOwner).toBe(true);
  });

  // EI-8816: the cluster-worker blind spot — a request landing on a request-only
  // worker must NOT silently render like "nothing booted".
  describe('cluster-worker blind spot (EI-8816)', () => {
    it('non-owner process, no cached broadcast yet → reachedSubstrateOwner:false, harnesses empty', async () => {
      H.state.isPrimary = false;
      H.state.cachedRemote = null;
      H.state.booted = [{ workspaceId: 'ws1', harnessSlug: 'papercup' }]; // never consulted (not the owner)
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(false);
      expect(body.harnesses).toEqual([]);
      expect(H.loadClaimAttemptStats).not.toHaveBeenCalled();
    });

    it('non-owner process with a FRESH cached broadcast → uses the remote handles, reachedSubstrateOwner:true', async () => {
      H.state.isPrimary = false;
      H.state.cachedRemote = {
        handles: [{ workspaceId: 'ws1', harnessSlug: 'papercup' }],
        receivedAt: Date.now(),
      };
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(true);
      expect(body.harnesses).toHaveLength(1);
      expect(body.harnesses[0]).toMatchObject({ workspaceId: 'ws1', harnessSlug: 'papercup' });
    });

    it('non-owner process with a STALE cached broadcast → reachedSubstrateOwner:false, not silently trusted', async () => {
      H.state.isPrimary = false;
      H.state.cachedRemote = {
        handles: [{ workspaceId: 'ws1', harnessSlug: 'papercup' }],
        receivedAt: Date.now() - 60_000, // well past the 15s default max age
      };
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(false);
      expect(body.harnesses).toEqual([]);
    });
  });
});
