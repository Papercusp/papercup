/**
 * dogfood-substrate-boot-history.test.ts — endpoint tests for
 * GET /api/admin/dogfood-substrate-boot-history.
 *
 * Route-shaped, no deps seam: it reads the in-process boot-history buffer
 * via the module-level `listBootHistory` / `bootHistoryDepth` imports. We
 * mock that module with a `vi.hoisted` stub that records the opts the
 * handler passes in, then invoke `default[0].handler(req, ctx)` directly.
 *
 * The handler's contribution (the bit worth testing) is the query-string →
 * `ListBootHistoryOpts` mapping: workspace_id / harness_slug pass-through,
 * the kinds allow-list filter, and the limit parse + clamp (1..500).
 *
 * Covered:
 *   - response shape: { entries, depth }
 *   - workspace_id + harness_slug forwarded; absent → undefined
 *   - kinds filtered against the VALID_KINDS allow-list (bogus dropped)
 *   - kinds absent → undefined (no filter)
 *   - limit default 50; clamp high (>500 → 500); clamp low (<1 → 1);
 *     NaN → 50
 *   - route metadata: GET path + verified/trusted auth gate
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';

const H = vi.hoisted(() => {
  const calls: Array<Record<string, unknown>> = [];
  const state: { entries: unknown[]; depth: number } = { entries: [], depth: 0 };
  // Sidecar seam: the flag (default OFF → local ring) + a fake IPC client whose
  // `call` is overridable per-test (success → sidecar data; throw → fallback).
  const sidecar: {
    flag: boolean;
    ipcCalls: Array<{ method: string; params: unknown }>;
    call: (method: string, params: unknown) => Promise<unknown>;
  } = {
    flag: false,
    ipcCalls: [],
    call: async () => ({ entries: [], depth: 0 }),
  };
  return {
    calls,
    state,
    sidecar,
    listBootHistory: (opts: Record<string, unknown>) => {
      calls.push(opts);
      return state.entries;
    },
    bootHistoryDepth: () => state.depth,
  };
});

vi.mock('../../../../sync/hyperbee/boot-history', () => ({
  listBootHistory: H.listBootHistory,
  bootHistoryDepth: H.bootHistoryDepth,
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: async () => H.sidecar.flag,
}));

vi.mock('../../../../sync/hyperbee/substrate-ipc-client', () => ({
  getSubstrateIpcClient: () => ({
    call: (method: string, params: unknown) => {
      H.sidecar.ipcCalls.push({ method, params });
      return H.sidecar.call(method, params);
    },
  }),
}));

import route from '../dogfood-substrate-boot-history';

function ctx(): RouteContext {
  return {
    principal: null,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
  };
}

const reqWith = (qs = '') =>
  new Request(
    `http://localhost/api/admin/dogfood-substrate-boot-history${qs ? `?${qs}` : ''}`,
  );

const lastOpts = () => H.calls[H.calls.length - 1]!;

beforeEach(() => {
  H.calls.length = 0;
  H.state.entries = [];
  H.state.depth = 0;
  H.sidecar.flag = false;
  H.sidecar.ipcCalls.length = 0;
  H.sidecar.call = async () => ({ entries: [], depth: 0 });
});

describe('dogfood-substrate-boot-history route metadata', () => {
  it('exports one GET route at /admin/dogfood-substrate-boot-history', () => {
    expect(route).toHaveLength(1);
    expect(route[0].method).toBe('GET');
    expect(route[0].path).toBe('/admin/dogfood-substrate-boot-history');
  });

  it('is gated to verified/trusted trust tiers', () => {
    expect(route[0].auth).toEqual({ trust: ['verified', 'trusted'] });
  });
});

describe('GET boot-history response shape', () => {
  it('200 with { entries, depth } from the local ring (sidecar OFF, source:main)', async () => {
    H.state.entries = [{ ts: 1, workspaceId: 'ws1', harnessSlug: 'papercup', kind: 'boot_ok' }];
    H.state.depth = 7;
    const res = await route[0].handler(reqWith(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual(H.state.entries);
    expect(body.depth).toBe(7);
    expect(body.source).toBe('main');
    expect(H.sidecar.ipcCalls).toHaveLength(0); // no IPC when the flag is off
  });
});

describe('SUBSTRATE_SIDECAR proxy', () => {
  it('flag ON ⇒ proxies to substrate:getBootHistory and returns the SIDECAR ring (source:sidecar)', async () => {
    H.sidecar.flag = true;
    // the main ring is empty (the bug) — the real events live in the sidecar.
    H.state.entries = [];
    H.state.depth = 0;
    const sidecarEntries = [{ ts: 99, workspaceId: 'ws1', harnessSlug: 'papercup', kind: 'announce_admitted' }];
    H.sidecar.call = async () => ({ entries: sidecarEntries, depth: 42 });

    const res = await route[0].handler(reqWith('workspace_id=ws1&limit=10'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual(sidecarEntries);
    expect(body.depth).toBe(42);
    expect(body.source).toBe('sidecar');
    // proxied with the SAME ListBootHistoryOpts the local path would have used.
    expect(H.sidecar.ipcCalls).toHaveLength(1);
    expect(H.sidecar.ipcCalls[0]!.method).toBe('substrate:getBootHistory');
    expect(H.sidecar.ipcCalls[0]!.params).toMatchObject({ workspaceId: 'ws1', limit: 10 });
    expect(H.calls).toHaveLength(0); // never touched the local ring
  });

  it('flag ON but IPC throws ⇒ degrades to the local ring (source:main-fallback)', async () => {
    H.sidecar.flag = true;
    H.state.entries = [{ ts: 2, workspaceId: 'ws1', harnessSlug: 'papercup', kind: 'boot_ok' }];
    H.state.depth = 3;
    H.sidecar.call = async () => {
      throw new Error('sidecar socket closed');
    };

    const res = await route[0].handler(reqWith(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual(H.state.entries); // fell back to the local ring
    expect(body.depth).toBe(3);
    expect(body.source).toBe('main-fallback');
    expect(H.sidecar.ipcCalls).toHaveLength(1); // it DID try the sidecar first
  });
});

describe('query-string → ListBootHistoryOpts mapping', () => {
  it('defaults: no filters, limit 50', async () => {
    await route[0].handler(reqWith(), ctx());
    expect(lastOpts()).toEqual({
      workspaceId: undefined,
      harnessSlug: undefined,
      kinds: undefined,
      limit: 50,
    });
  });

  it('forwards workspace_id + harness_slug', async () => {
    await route[0].handler(reqWith('workspace_id=ws-9&harness_slug=restart'), ctx());
    expect(lastOpts().workspaceId).toBe('ws-9');
    expect(lastOpts().harnessSlug).toBe('restart');
  });

  it('filters kinds against the allow-list, dropping unknown kinds', async () => {
    await route[0].handler(reqWith('kinds=boot_fail,close,bogus,peer_connected'), ctx());
    expect(lastOpts().kinds).toEqual(['boot_fail', 'close', 'peer_connected']);
  });

  it('allows admission and rekey diagnostic kinds', async () => {
    await route[0].handler(
      reqWith('kinds=announce_admitted,announce_pending,rekey_grant_skipped,rekey_boundary_skipped'),
      ctx(),
    );
    expect(lastOpts().kinds).toEqual([
      'announce_admitted',
      'announce_pending',
      'rekey_grant_skipped',
      'rekey_boundary_skipped',
    ]);
  });

  it('WI-1953 regression: allows the previously-missing kinds (epoch_*, peer_unrevoked, peer_cap_near, replication_*, announce_clock_skew, join_*) — these used to be silently dropped', async () => {
    await route[0].handler(
      reqWith(
        'kinds=' +
          [
            'join_started',
            'join_succeeded',
            'peer_cap_near',
            'peer_unrevoked',
            'replication_stalled',
            'replication_frozen',
            'announce_clock_skew',
            'epoch_gate_built',
            'epoch_gate_seen',
            'epoch_defer',
            'epoch_decrypt_fail',
            'epoch_applied',
          ].join(','),
      ),
      ctx(),
    );
    expect(lastOpts().kinds).toEqual([
      'join_started',
      'join_succeeded',
      'peer_cap_near',
      'peer_unrevoked',
      'replication_stalled',
      'replication_frozen',
      'announce_clock_skew',
      'epoch_gate_built',
      'epoch_gate_seen',
      'epoch_defer',
      'epoch_decrypt_fail',
      'epoch_applied',
    ]);
  });

  it('kinds absent → undefined (no kind filter)', async () => {
    await route[0].handler(reqWith('workspace_id=x'), ctx());
    expect(lastOpts().kinds).toBeUndefined();
  });

  it('clamps limit above 500 down to 500', async () => {
    await route[0].handler(reqWith('limit=99999'), ctx());
    expect(lastOpts().limit).toBe(500);
  });

  it('clamps limit below 1 up to 1', async () => {
    await route[0].handler(reqWith('limit=0'), ctx());
    expect(lastOpts().limit).toBe(1);
    await route[0].handler(reqWith('limit=-5'), ctx());
    expect(lastOpts().limit).toBe(1);
  });

  it('non-numeric limit falls back to 50', async () => {
    await route[0].handler(reqWith('limit=abc'), ctx());
    expect(lastOpts().limit).toBe(50);
  });

  it('passes a valid in-range limit through unchanged', async () => {
    await route[0].handler(reqWith('limit=123'), ctx());
    expect(lastOpts().limit).toBe(123);
  });
});
