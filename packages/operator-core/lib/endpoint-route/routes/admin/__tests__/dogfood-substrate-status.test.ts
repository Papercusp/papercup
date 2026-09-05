/**
 * dogfood-substrate-status.test.ts — endpoint tests for
 * GET /api/admin/dogfood-substrate-status.
 *
 * The route is route-shaped (`defineTool({ method, path, auth, handler })`)
 * and has NO injectable deps seam: it reads the in-process boot map via the
 * module-level `listBootedHandles` import. We mock that module with a
 * `vi.hoisted` stub and invoke the exported `default[0].handler(req, ctx)`
 * directly — no PG, no Hypercore, no network.
 *
 * Covered:
 *   - response shape contract: { enabled:true, booted, bootedCount, reachedSubstrateOwner }
 *   - bootedCount === booted.length for N booted handles
 *   - idle ground state (zero booted) still reports enabled:true
 *   - route metadata: GET path + verified/trusted auth gate
 *   - WI-5307: the dedicated-bg-host request-only blind spot (mirrors
 *     dogfood-substrate-health's EI-8816/WI-5307 coverage)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';

const H = vi.hoisted(() => {
  const state: {
    booted: Array<{ workspaceId: string; harnessSlug: string }>;
    isPrimary: boolean;
    requestOnly: boolean;
    cachedRemote: { handles: Array<{ workspaceId: string; harnessSlug: string }>; receivedAt: number } | null;
    // EI-19327550671915579: the cross-SERVICE PG fallback leg — the one that actually
    // reaches a request-only host under the dedicated-bg-host topology, where
    // node:cluster IPC (cachedRemote above) can never apply at all.
    pgFallback: { handles: Array<{ workspaceId: string; harnessSlug: string }>; receivedAt: number } | null;
  } = {
    booted: [],
    isPrimary: true,
    requestOnly: false,
    cachedRemote: null,
    pgFallback: null,
  };
  return {
    state,
    listBootedHandles: () => state.booted,
    requestOnlyHost: () => state.requestOnly,
    // EI-18735338283879820: the route now calls the SHARED predicate rather than
    // computing `isPrimary && !requestOnly` inline — mirror that same logic here so
    // the mock stays behaviorally equivalent to the real background-workers export.
    isSubstrateOwnerProcess: () => state.isPrimary && !state.requestOnly,
    getCachedRemoteBootedHandles: () => state.cachedRemote,
    getPgBootedHandlesSnapshotFallback: vi.fn(async () => state.pgFallback),
  };
});

vi.mock('../../../../sync/hyperbee/boot-all', () => ({
  listBootedHandles: H.listBootedHandles,
}));
// Spread the real module: the route graph transitively reaches
// resource-profile.ts → utilityHostEnabled, so a bare factory strands the file
// at collection ("No utilityHostEnabled export is defined on the mock").
vi.mock('../../../../background-workers', async (orig) => ({
  ...(await orig<typeof import('../../../../background-workers')>()),
  requestOnlyHost: H.requestOnlyHost,
  isSubstrateOwnerProcess: H.isSubstrateOwnerProcess,
}));
vi.mock('../../../../sync/hyperbee/cluster-booted-handles-sync', () => ({
  getCachedRemoteBootedHandles: H.getCachedRemoteBootedHandles,
  collectHarnessContentConnectivity: vi.fn(() => []),
}));
vi.mock('../../../../sync/hyperbee/substrate-booted-handles-pg', () => ({
  getPgBootedHandlesSnapshotFallback: H.getPgBootedHandlesSnapshotFallback,
}));
vi.mock('node:cluster', () => ({
  default: {
    get isPrimary() {
      return H.state.isPrimary;
    },
  },
}));

import route from '../dogfood-substrate-status';

function ctx(): RouteContext {
  return {
    principal: null,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
  };
}

const req = () =>
  new Request('http://localhost/api/admin/dogfood-substrate-status');

beforeEach(() => {
  H.state.booted = [];
  H.state.isPrimary = true;
  H.state.requestOnly = false;
  H.state.cachedRemote = null;
  H.state.pgFallback = null;
  H.getPgBootedHandlesSnapshotFallback.mockClear();
});

describe('dogfood-substrate-status route metadata', () => {
  it('exports one GET route at /admin/dogfood-substrate-status', () => {
    expect(route).toHaveLength(1);
    expect(route[0].method).toBe('GET');
    expect(route[0].path).toBe('/admin/dogfood-substrate-status');
  });

  it('is gated to verified/trusted trust tiers (not public)', () => {
    expect(route[0].auth).toEqual({ trust: ['verified', 'trusted'] });
  });
});

describe('GET /admin/dogfood-substrate-status handler', () => {
  it('200 with enabled:true and the booted list + count', async () => {
    H.state.booted = [
      { workspaceId: 'ws1', harnessSlug: 'papercup' },
      { workspaceId: 'ws1', harnessSlug: 'restart' },
    ];
    const res = await route[0].handler(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.booted).toEqual([
      { workspaceId: 'ws1', harnessSlug: 'papercup' },
      { workspaceId: 'ws1', harnessSlug: 'restart' },
    ]);
    expect(body.bootedCount).toBe(2);
  });

  it('bootedCount mirrors booted.length', async () => {
    H.state.booted = [
      { workspaceId: 'a', harnessSlug: 'x' },
      { workspaceId: 'b', harnessSlug: 'y' },
      { workspaceId: 'c', harnessSlug: 'z' },
    ];
    const body = await (await route[0].handler(req(), ctx())).json();
    expect(body.bootedCount).toBe(3);
    expect(body.booted).toHaveLength(3);
  });

  it('idle ground state: zero booted → enabled:true, empty list, count 0', async () => {
    H.state.booted = [];
    const res = await route[0].handler(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.booted).toEqual([]);
    expect(body.bootedCount).toBe(0);
  });

  it('ordinary primary/single-process host → reachedSubstrateOwner:true, local map trusted directly', async () => {
    H.state.booted = [{ workspaceId: 'ws1', harnessSlug: 'papercup' }];
    const body = await (await route[0].handler(req(), ctx())).json();
    expect(body.reachedSubstrateOwner).toBe(true);
    expect(body.bootedCount).toBe(1);
  });

  // WI-5307: a request-only secondary (the dedicated-bg-host topology's :3070/:3270)
  // is a node:cluster primary (isPrimary:true) that never boots the substrate — its
  // own local `booted` must NOT be trusted just because it's not a forked worker.
  describe('request-only secondary blind spot (WI-5307)', () => {
    it('isPrimary:true but request-only, no cached broadcast → reachedSubstrateOwner:false, booted:[] even with a local entry', async () => {
      H.state.requestOnly = true;
      H.state.booted = [{ workspaceId: 'ws1', harnessSlug: 'papercup' }];
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(false);
      expect(body.booted).toEqual([]);
      expect(body.bootedCount).toBe(0);
    });

    it('isPrimary:true but request-only, WITH a fresh cached broadcast → uses the remote handles', async () => {
      H.state.requestOnly = true;
      H.state.cachedRemote = {
        handles: [{ workspaceId: 'ws1', harnessSlug: 'papercup' }],
        receivedAt: Date.now(),
      };
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(true);
      expect(body.bootedCount).toBe(1);
    });

    it('genuine forked worker (isPrimary:false), no cached broadcast → reachedSubstrateOwner:false', async () => {
      H.state.isPrimary = false;
      H.state.booted = [{ workspaceId: 'ws1', harnessSlug: 'papercup' }];
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(false);
      expect(body.booted).toEqual([]);
    });
  });

  // EI-19327550671915579: node:cluster IPC (cachedRemote) can never reach a request-only
  // host under the dedicated-bg-host topology at all (bg-host is a separate systemd
  // service, not a forked child) — this is the leg that closes that permanent blind spot.
  describe('cross-SERVICE PG fallback (EI-19327550671915579, dedicated-bg-host topology)', () => {
    it('request-only, no cached broadcast, but a FRESH PG row → reachedSubstrateOwner:true, uses the PG handles', async () => {
      H.state.requestOnly = true;
      H.state.cachedRemote = null;
      H.state.pgFallback = { handles: [{ workspaceId: 'ws1', harnessSlug: 'papercup' }], receivedAt: Date.now() };
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(true);
      expect(body.booted).toEqual([{ workspaceId: 'ws1', harnessSlug: 'papercup' }]);
      expect(body.bootedCount).toBe(1);
      expect(H.getPgBootedHandlesSnapshotFallback).toHaveBeenCalledTimes(1);
    });

    it('request-only, no cached broadcast, PG row also absent → stays reachedSubstrateOwner:false (still a blind spot, not silently trusted)', async () => {
      H.state.requestOnly = true;
      H.state.cachedRemote = null;
      H.state.pgFallback = null;
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(false);
      expect(body.booted).toEqual([]);
      expect(H.getPgBootedHandlesSnapshotFallback).toHaveBeenCalledTimes(1);
    });

    it('the cluster-IPC cached broadcast wins over PG when BOTH are fresh — PG is a fallback, never consulted when the fast path already reached the owner', async () => {
      H.state.requestOnly = true;
      H.state.cachedRemote = { handles: [{ workspaceId: 'ws1', harnessSlug: 'from-cluster-ipc' }], receivedAt: Date.now() };
      H.state.pgFallback = { handles: [{ workspaceId: 'ws1', harnessSlug: 'from-pg' }], receivedAt: Date.now() };
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(true);
      expect(body.booted).toEqual([{ workspaceId: 'ws1', harnessSlug: 'from-cluster-ipc' }]);
      expect(H.getPgBootedHandlesSnapshotFallback).not.toHaveBeenCalled();
    });

    it('ordinary primary/single-process host (already reachedSubstrateOwner:true) → PG fallback never consulted', async () => {
      H.state.booted = [{ workspaceId: 'ws1', harnessSlug: 'papercup' }];
      const body = await (await route[0].handler(req(), ctx())).json();
      expect(body.reachedSubstrateOwner).toBe(true);
      expect(H.getPgBootedHandlesSnapshotFallback).not.toHaveBeenCalled();
    });
  });
});
