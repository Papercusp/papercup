/**
 * sync-sse — the per-process LISTEN fan-out, ring-buffer replay, the
 * PG-trigger → camelCase bridge, and the source-side notify dedupe.
 *
 * The real module opens a long-lived `postgres()` LISTEN connection; we mock
 * `postgres` so `.listen()` just captures the callback, then drive that
 * callback directly to simulate `pg_notify('sync_invalidate', …)` deliveries.
 * getOrgPg / getHarnessAdminUrl / the bridge map are mocked too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let capturedListen: ((raw: string) => void) | null = null;
const notifySql = vi.fn(async (..._args: unknown[]) => [] as unknown[]); // called as a tagged template
type BridgeTarget = string | { name: string; args: Record<string, unknown> };
let bridgeReturn: (name: string, args?: Record<string, unknown>) => BridgeTarget[] = () => [];
const emitSysEvt = vi.fn();
// EI-6468 (WI-1547 boot-wiring regression guard): number of REMAINING `.listen()`
// calls that should reject before one finally succeeds — lets a test simulate "PG
// still coming up at boot" without touching real timers/network.
let listenFailuresRemaining = 0;

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.resetModules();
  capturedListen = null;
  notifySql.mockClear();
  bridgeReturn = () => [];
  emitSysEvt.mockClear();
  listenFailuresRemaining = 0;
  // The dedupe Map is pinned to globalThis → clear it so each test starts fresh.
  delete (globalThis as unknown as { __syncNotifyDedupe?: unknown }).__syncNotifyDedupe;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('postgres');
  vi.doUnmock('@papercusp/db-org');
  vi.doUnmock('./embedded-pg-discovery');
  vi.doUnmock('./sync-resolver/table-to-query-names');
  vi.doUnmock('./cache/instance');
  vi.doUnmock('./events/engine');
});

async function load() {
  vi.doMock('postgres', () => ({
    default: () => ({
      listen: (_ch: string, cb: (raw: string) => void) => {
        if (listenFailuresRemaining > 0) {
          listenFailuresRemaining--;
          return Promise.reject(new Error('simulated LISTEN failure (PG not up yet)'));
        }
        capturedListen = cb;
        return Promise.resolve();
      },
    }),
  }));
  vi.doMock('./embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgres://test' }));
  vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: notifySql }) }));
  // caching-layer-tag-eca P-017 wired a cold-bust onListen hook into sync-sse;
  // stub the cache so the LISTEN start doesn't reach the real L1 instance.
  vi.doMock('./cache/instance', () => ({ getOperatorCache: () => ({ clearL1: () => {} }) }));
  vi.doMock('./sync-resolver/table-to-query-names', () => ({
    queryNamesForTriggerEvent: (name: string, args?: Record<string, unknown>) =>
      bridgeReturn(name, args),
  }));
  vi.doMock('./events/engine', () => ({ emitSystemEvent: emitSysEvt }));
  return import('./sync-sse');
}

describe('sync-sse LISTEN fan-out + replay', () => {
  it('a sync_invalidate notify is parsed and delivered to every subscriber', async () => {
    const { subscribe } = await load();
    const a = vi.fn();
    const b = vi.fn();
    await subscribe(a);
    await subscribe(b);
    capturedListen!(JSON.stringify({ name: 'harnessArchives.byHarness', args: { slug: 'x' } }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    const ev = a.mock.calls[0][0];
    expect(ev).toMatchObject({ name: 'harnessArchives.byHarness', args: { slug: 'x' } });
    expect(typeof ev.id).toBe('number');
    expect(typeof ev.ts).toBe('number');
  });

  it('ignores a non-JSON payload and a payload with no string name', async () => {
    const { subscribe } = await load();
    const sub = vi.fn();
    await subscribe(sub);
    capturedListen!('not json');
    capturedListen!(JSON.stringify({ args: {} })); // no name
    expect(sub).not.toHaveBeenCalled();
  });

  it('bridges a PG-trigger <schema>.<table>.changed event to its camelCase query names', async () => {
    bridgeReturn = (name) => (name === 'harness_shared.feature_queue.changed' ? ['featureQueue.byHarness'] : []);
    const { subscribe } = await load();
    const sub = vi.fn();
    await subscribe(sub);
    capturedListen!(JSON.stringify({ name: 'harness_shared.feature_queue.changed', args: { workspace_id: 'w', op: 'INSERT' } }));
    // original + one bridged event
    expect(sub).toHaveBeenCalledTimes(2);
    const names = sub.mock.calls.map((c) => c[0].name);
    expect(names).toContain('harness_shared.feature_queue.changed');
    expect(names).toContain('featureQueue.byHarness');
    const bridged = sub.mock.calls.find((c) => c[0].name === 'featureQueue.byHarness')![0];
    expect(bridged.args).toBeUndefined();
  });

  it('forwards the trigger args to the bridge and SCOPES a { name, args } target by row id', async () => {
    // caching-layer-tag-eca P-006: the bus now hands the trigger args
    // (workspace_id, op, id) to the bridge; a per-row query returns a scoped
    // { name, args } so the client invalidates just that row's cache key.
    const seen: Array<Record<string, unknown> | undefined> = [];
    bridgeReturn = (name, args) => {
      seen.push(args);
      if (name !== 'harness_shared.widget.changed') return [];
      const id = args?.id;
      return typeof id === 'string' ? [{ name: 'widget.byId', args: { id } }] : ['widget.byId'];
    };
    const { subscribe } = await load();
    const sub = vi.fn();
    await subscribe(sub);
    capturedListen!(
      JSON.stringify({
        name: 'harness_shared.widget.changed',
        args: { workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' },
      }),
    );
    // bridge saw the row id from the trigger payload
    expect(seen).toEqual([{ workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' }]);
    const scoped = sub.mock.calls.find((c) => c[0].name === 'widget.byId')![0];
    expect(scoped.args).toEqual({ id: 'widget-42' });
  });

  it('taps emitSystemEvent for a <table>.changed event so cache.bumpTags fires on real DB changes', async () => {
    // caching-layer-tag-eca KEYSTONE: a real DB change (sync_invalidate NOTIFY) must reach the
    // in-process reaction matcher so the cache.bumpTags ECA rule invalidates — otherwise the
    // cache layer is built but INERT. bridgeTriggerEvent is the tap.
    const { bridgeTriggerEvent } = await load();
    bridgeTriggerEvent('harness_shared.widget.changed', { workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' });
    expect(emitSysEvt).toHaveBeenCalledTimes(1);
    expect(emitSysEvt).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'harness_shared.widget.changed',
        args: { workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' },
        workspaceId: 'w1',
      }),
    );
    // a non-.changed bridged/query event is NOT fed into the reaction matcher
    bridgeTriggerEvent('featureQueue.byHarness', { slug: 'x' });
    expect(emitSysEvt).toHaveBeenCalledTimes(1);
  });

  it('backfillSince replays only events with a higher id than the last seen', async () => {
    const { subscribe, backfillSince } = await load();
    await subscribe(vi.fn());
    capturedListen!(JSON.stringify({ name: 'q.one' }));
    capturedListen!(JSON.stringify({ name: 'q.two' }));
    const all = backfillSince(0);
    expect(all.map((e) => e.name)).toEqual(['q.one', 'q.two']);
    const afterFirst = backfillSince(all[0].id);
    expect(afterFirst.map((e) => e.name)).toEqual(['q.two']);
  });

  it('prunes events older than the 60s ring-buffer window from replay', async () => {
    const { subscribe, backfillSince } = await load();
    await subscribe(vi.fn());
    capturedListen!(JSON.stringify({ name: 'q.old' }));
    vi.setSystemTime(T0 + 61_000); // advance past HISTORY_WINDOW_MS
    capturedListen!(JSON.stringify({ name: 'q.new' })); // push triggers pruneHistory
    const replay = backfillSince(0);
    expect(replay.map((e) => e.name)).toEqual(['q.new']);
  });
});

describe('ensureInvalidationListener (EI-6468 / WI-1547: cache-ECA must not be inert)', () => {
  // A cachedRead consumer (e.g. work_items:list, feeding coord:orient's
  // claimable[]) relies on the cache-ECA (table-change → cache.bumpTags) to
  // invalidate promptly. That rail rides this SAME PG LISTEN connection, which
  // otherwise starts only lazily on the first SSE subscribe — a process that
  // never gets one (a reuseport worker serving only MCP/tool HTTP) had an
  // inert cache-ECA and served arbitrarily stale reads (the exact reported
  // shape of EI-6468: a just-completed/claimed work-item still showing as
  // claimable minutes later). `hono-host.ts` calls this eagerly at boot for
  // every process specifically to close that gap — these tests pin the
  // function's OWN retry/give-up contract in isolation.

  it('starts the LISTEN on the first attempt and returns true', async () => {
    const { ensureInvalidationListener } = await load();
    const ok = await ensureInvalidationListener();
    expect(ok).toBe(true);
    expect(capturedListen).not.toBeNull();
  });

  it('retries with backoff past a transient failure and eventually succeeds', async () => {
    const { ensureInvalidationListener } = await load();
    listenFailuresRemaining = 2; // fail attempts 1 and 2; succeed on attempt 3
    const promise = ensureInvalidationListener({ attempts: 5, delayMs: 1000 });
    // Drain the retry backoffs under fake timers (2 failures ⇒ 2 delayed retries).
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const ok = await promise;
    expect(ok).toBe(true);
    expect(capturedListen).not.toBeNull();
  });

  it('gives up after exhausting all attempts, returns false, and logs loudly (cache-ECA stays inert until the next SSE subscribe retries)', async () => {
    const { ensureInvalidationListener } = await load();
    listenFailuresRemaining = 99; // never succeeds
    const errSpy = vi.spyOn(console, 'error');
    const promise = ensureInvalidationListener({ attempts: 3, delayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const ok = await promise;
    expect(ok).toBe(false);
    expect(capturedListen).toBeNull();
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes('cache-ECA inert in this process')),
    ).toBe(true);
  });
});

describe('boot wiring: hono-host.ts eagerly starts the invalidation LISTEN (EI-6468 / WI-1547 regression guard)', () => {
  // A STATIC source check, not a behavioral one: the whole WI-1547 incident class
  // (cache-ECA silently inert in a cluster worker that never got an SSE subscriber)
  // is reintroduced just as easily by someone later refactoring startRequestServers
  // and DROPPING this one call as by never adding it in the first place — the prior
  // two describe blocks pin ensureInvalidationListener's own contract, but neither
  // catches "the host stopped calling it". Pin the call site directly.
  it('startRequestServers() calls ensureInvalidationListener() at boot', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../apps/operator/bin/hono-host.ts'),
      'utf8',
    );
    expect(src).toContain("import { ensureInvalidationListener } from '@papercusp/operator-core/lib/sync-sse'");
    const fnStart = src.indexOf('function startRequestServers');
    expect(fnStart).toBeGreaterThan(-1);
    // The call must live INSIDE startRequestServers, not merely somewhere in the file —
    // slice to the next top-level function/export boundary and search within it.
    const nextBoundary = src.indexOf('\nfunction ', fnStart + 1);
    const body = nextBoundary > -1 ? src.slice(fnStart, nextBoundary) : src.slice(fnStart);
    expect(body).toContain('ensureInvalidationListener()');
  });
});

describe('sync-sse notifySyncInvalidate', () => {
  it('fires pg_notify on the sync_invalidate channel with the name + args payload', async () => {
    const { notifySyncInvalidate } = await load();
    await notifySyncInvalidate('feature_queue.changed', { harnessSlug: 'sheets' });
    expect(notifySql).toHaveBeenCalledTimes(1);
    // SQL is `SELECT pg_notify(${channel}, ${payload})` — channel is bound
    // param [1], payload is [2] (the pg-adapter parameterizes the channel).
    const payload = JSON.parse(String(notifySql.mock.calls[0][2]));
    expect(payload).toMatchObject({ name: 'feature_queue.changed', args: { harnessSlug: 'sheets' } });
  });

  it('dedupes an identical (name,args) notify within the 90s window, lets it through after', async () => {
    const { notifySyncInvalidate } = await load();
    await notifySyncInvalidate('q.x', { a: 1 });
    await notifySyncInvalidate('q.x', { a: 1 }); // duplicate within window → suppressed
    expect(notifySql).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 91_000); // past DEDUPE_WINDOW_MS
    await notifySyncInvalidate('q.x', { a: 1 });
    expect(notifySql).toHaveBeenCalledTimes(2);
  });

  it('strips an oversized (>32KB) data payload, sending only name + args', async () => {
    const { notifySyncInvalidate } = await load();
    const big = [{ blob: 'x'.repeat(40_000) }];
    await notifySyncInvalidate('q.big', { k: 'v' }, big);
    const payload = JSON.parse(String(notifySql.mock.calls[0][2]));
    expect(payload.name).toBe('q.big');
    expect(payload.args).toEqual({ k: 'v' });
    expect(payload.data).toBeUndefined();
  });

  it('keeps a small data payload inline', async () => {
    const { notifySyncInvalidate } = await load();
    await notifySyncInvalidate('q.small', undefined, [{ id: 1 }]);
    const payload = JSON.parse(String(notifySql.mock.calls[0][2]));
    expect(payload.data).toEqual([{ id: 1 }]);
  });
});
