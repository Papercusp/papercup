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
 *   - response shape contract: { enabled:true, booted, bootedCount }
 *   - bootedCount === booted.length for N booted handles
 *   - idle ground state (zero booted) still reports enabled:true
 *   - route metadata: GET path + verified/trusted auth gate
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';

const H = vi.hoisted(() => {
  const state: { booted: Array<{ workspaceId: string; harnessSlug: string }> } = {
    booted: [],
  };
  return { state, listBootedHandles: () => state.booted };
});

vi.mock('../../../../sync/hyperbee/boot-all', () => ({
  listBootedHandles: H.listBootedHandles,
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
});
