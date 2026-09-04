/**
 * Unit tests for the derived-read precompute substrate
 * (precompute-derived-sync-reads-2026-07-19 P-002, WI-5460).
 *
 * The behaviors worth pinning are the ones that make this a PRECOMPUTE and not a
 * cache, because those are exactly what a well-meaning future edit would undo:
 *   - a read NEVER computes (D-003);
 *   - a failing refresh never blanks a good payload;
 *   - a shape bump makes an old snapshot read as absent rather than wrong.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const sqlMock = vi.fn();
const getFlagMock = vi.fn();

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...args: unknown[]) => getFlagMock(...args),
}));
vi.mock('@papercusp/flags', () => ({
  FLAGS: { PRECOMPUTE_DERIVED_READS: 'papercusp-precompute-derived-reads' },
}));
vi.mock('../flag-distinct-id', () => ({ systemDistinctId: () => 'system' }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import {
  __clearDerivedReadRegistryForTest,
  __clearWarmingKeysForTest,
  readDerivedSnapshot,
  refreshDerivedReads,
  registerDerivedRead,
} from './registry';

/** Queue of result-sets the tagged-template `sql` mock returns, in call order. */
let sqlResults: unknown[][] = [];

beforeEach(() => {
  __clearDerivedReadRegistryForTest();
  __clearWarmingKeysForTest();
  sqlResults = [];
  sqlMock.mockReset();
  sqlMock.mockImplementation(() => Promise.resolve(sqlResults.shift() ?? []));
  getFlagMock.mockReset();
  getFlagMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readDerivedSnapshot', () => {
  it('NEVER invokes the producer on a read — the whole point of precompute (D-003)', async () => {
    const compute = vi.fn().mockResolvedValue([{ id: 'a' }]);
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [
      [{ payload: [{ id: 'a' }], computed_at: Date.now(), compute_ms: 12, producer_version: 1, error: null }],
    ];

    const { payload } = await readDerivedSnapshot('test.slow');

    expect(payload).toEqual([{ id: 'a' }]);
    expect(compute).not.toHaveBeenCalled();
  });

  it('returns MISSING immediately on a cold read — never inlining the compute', async () => {
    // The invariant is that the read does not WAIT on the expensive work. It may
    // (and does) kick a background warm-up; what it must never do is block on it,
    // because blocking is precisely the cold-load stall precompute removes.
    let resolveCompute: (v: unknown) => void = () => {};
    const compute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCompute = resolve;
        }),
    );
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[], []];

    // The compute promise is deliberately left PENDING: if the read awaited it,
    // this line would hang rather than resolve.
    const { payload, meta } = await readDerivedSnapshot('test.slow');

    expect(payload).toBeNull();
    expect(meta.missing).toBe(true);
    resolveCompute([]);
  });

  it('treats a snapshot from an older producerVersion as absent, not as data', async () => {
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 2,
      scope: 'workspace',
      compute: vi.fn(),
    });
    sqlResults = [
      [{ payload: [{ old: true }], computed_at: Date.now(), compute_ms: 1, producer_version: 1, error: null }],
    ];

    const { payload, meta } = await readDerivedSnapshot('test.slow');

    expect(payload).toBeNull();
    expect(meta.missing).toBe(true);
  });

  it('serves a stale snapshot, flagged stale — stale data beats a 20s wait', async () => {
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 1_000,
      producerVersion: 1,
      scope: 'workspace',
      compute: vi.fn(),
    });
    const old = Date.now() - 60_000;
    sqlResults = [[{ payload: ['x'], computed_at: old, compute_ms: 5, producer_version: 1, error: null }]];

    const { payload, meta } = await readDerivedSnapshot('test.slow');

    expect(payload).toEqual(['x']);
    expect(meta.stale).toBe(true);
    expect(meta.computedAt).toBe(old);
  });

  it('a refreshOnRead producer serves stale data NOW and refreshes it in the background', async () => {
    const compute = vi.fn().mockResolvedValue(['fresh']);
    registerDerivedRead({
      key: 'test.lazy',
      ttlMs: 1_000,
      producerVersion: 1,
      scope: 'workspace',
      excludeFromDefaultSweep: true,
      refreshOnRead: true,
      compute,
    });
    const old = Date.now() - 60_000;
    sqlResults = [
      [{ payload: ['stale'], computed_at: old, compute_ms: 5, producer_version: 1, error: null }],
      [{ computed_at: old, producer_version: 1, payload_md5: 'old' }],
      [{ payload_md5: 'fresh' }],
    ];

    const { payload, meta } = await readDerivedSnapshot('test.lazy');

    expect(payload).toEqual(['stale']);
    expect(meta.stale).toBe(true);
    await vi.waitFor(() => expect(compute).toHaveBeenCalledOnce());
  });

  it('falls back to inline compute ONLY when the flag is explicitly off', async () => {
    getFlagMock.mockResolvedValue(false);
    const compute = vi.fn().mockResolvedValue(['inline']);
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });

    const { payload, meta } = await readDerivedSnapshot('test.slow');

    expect(payload).toEqual(['inline']);
    expect(meta.precomputed).toBe(false);
    expect(compute).toHaveBeenCalledOnce();
  });

  it('kicks a BACKGROUND warm-up on a miss without awaiting it', async () => {
    // A cold DB must heal itself rather than showing an empty panel until the
    // next cron tick — but the read still returns immediately (D-003).
    let resolveCompute: (v: unknown) => void = () => {};
    const compute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCompute = resolve;
        }),
    );
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[], []];

    const started = Date.now();
    const { payload, meta } = await readDerivedSnapshot('test.slow');

    // Returned NOW, while the warm-up is still pending.
    expect(payload).toBeNull();
    expect(meta.missing).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(compute).toHaveBeenCalledOnce();
    resolveCompute([]);
  });

  it('collapses a warm-up stampede — N concurrent cold readers trigger ONE compute', async () => {
    // The sync transport polls ~every 3s across many viewers; without the guard
    // each cold read would launch its own 70s disk walk.
    let resolveCompute: (v: unknown) => void = () => {};
    const compute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCompute = resolve;
        }),
    );
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[], [], [], [], [], []];

    await Promise.all([
      readDerivedSnapshot('test.slow'),
      readDerivedSnapshot('test.slow'),
      readDerivedSnapshot('test.slow'),
    ]);

    expect(compute).toHaveBeenCalledOnce();
    resolveCompute([]);
  });

  it('prefers the precomputed path when the flag read itself fails', async () => {
    // A flag-service blip must not silently reintroduce the 20s inline walk.
    getFlagMock.mockRejectedValue(new Error('flag service down'));
    let resolveCompute: (v: unknown) => void = () => {};
    const compute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCompute = resolve;
        }),
    );
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[], []];

    const { payload, meta } = await readDerivedSnapshot('test.slow');

    // Took the SNAPSHOT path (a miss), not the flag-off inline-compute path —
    // an inline result would have come back with precomputed:false and a payload.
    expect(meta.precomputed).toBe(true);
    expect(payload).toBeNull();
    resolveCompute([]);
  });
});

describe('refreshDerivedReads', () => {
  it('skips a producer whose snapshot is still fresh (replay-safe, no re-walk)', async () => {
    const compute = vi.fn();
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[{ computed_at: Date.now(), producer_version: 1 }]];

    const [outcome] = await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h' });

    expect(outcome.skippedFresh).toBe(true);
    expect(compute).not.toHaveBeenCalled();
  });

  // EI-19457924854150358: producers run SEQUENTIALLY under a `concurrency: 'skip'`
  // routine, so a minutes-scale producer blocks the shared 2-min tick and starves the
  // 90s-ttl liveness producers. `excludeFromDefaultSweep` is how such a producer stays
  // registered (inheriting ttl gating / versioning / snapshot write) without ever
  // entering that tick. A long ttl is NOT a substitute — it changes how OFTEN the cost
  // is paid, never how LONG the shared tick is blocked when it is.
  it('SKIPS an excludeFromDefaultSweep producer in the default pass — it never enters the shared tick', async () => {
    const heavy = vi.fn().mockResolvedValue(['audit']);
    registerDerivedRead({
      key: 'test.heavy',
      ttlMs: 1_000, // DUE for refresh — proves the exclusion, not freshness, is what skipped it
      producerVersion: 1,
      scope: 'workspace',
      excludeFromDefaultSweep: true,
      compute: heavy,
    });

    const outcomes = await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h' });

    expect(heavy).not.toHaveBeenCalled();
    expect(outcomes.map((o) => o.key)).not.toContain('test.heavy');
  });

  it('CONTROL: an ordinary producer that is due DOES run in the same default pass', async () => {
    // Without this the test above passes even if refreshDerivedReads were broken
    // outright (e.g. running nothing at all), which would be a vacuous green.
    const ordinary = vi.fn().mockResolvedValue(['x']);
    registerDerivedRead({
      key: 'test.ordinary',
      ttlMs: 1_000,
      producerVersion: 1,
      scope: 'workspace',
      compute: ordinary,
    });
    sqlResults = [[{ computed_at: Date.now() - 60_000, producer_version: 1 }], []];

    const outcomes = await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h' });

    expect(ordinary).toHaveBeenCalledOnce();
    expect(outcomes.map((o) => o.key)).toContain('test.ordinary');
  });

  it('RUNS an excludeFromDefaultSweep producer when named explicitly in `only` — its own routine drives it', async () => {
    const heavy = vi.fn().mockResolvedValue(['audit']);
    registerDerivedRead({
      key: 'test.heavy',
      ttlMs: 1_000,
      producerVersion: 1,
      scope: 'workspace',
      excludeFromDefaultSweep: true,
      compute: heavy,
    });
    sqlResults = [[{ computed_at: Date.now() - 60_000, producer_version: 1 }], []];

    const outcomes = await refreshDerivedReads({
      workspaceId: 'ws-test',
      harnessSlug: 'h',
      only: ['test.heavy'],
    });

    expect(heavy).toHaveBeenCalledOnce();
    expect(outcomes.map((o) => o.key)).toContain('test.heavy');
  });

  it('recomputes when the snapshot is past its ttl', async () => {
    const compute = vi.fn().mockResolvedValue(['new']);
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 1_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[{ computed_at: Date.now() - 60_000, producer_version: 1 }], []];

    const [outcome] = await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h' });

    expect(outcome.refreshed).toBe(true);
    expect(compute).toHaveBeenCalledOnce();
  });

  it('records a producer failure WITHOUT clearing the last-known-good payload', async () => {
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 1_000,
      producerVersion: 1,
      scope: 'workspace',
      compute: vi.fn().mockRejectedValue(new Error('journalctl exploded')),
    });
    sqlResults = [[{ computed_at: Date.now() - 60_000, producer_version: 1 }], []];

    const [outcome] = await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h' });

    expect(outcome.refreshed).toBe(false);
    expect(outcome.error).toContain('journalctl exploded');
    // The error-recording upsert must not touch payload/computed_at — a transient
    // producer failure must never blank a working panel.
    const errorUpsert = sqlMock.mock.calls.at(-1)?.[0] as string[] | undefined;
    const text = Array.isArray(errorUpsert) ? errorUpsert.join('') : String(errorUpsert ?? '');
    expect(text).toContain('DO UPDATE SET');
    expect(text).not.toContain('payload = EXCLUDED.payload');
  });

  it('force recomputes regardless of freshness (the backfill path)', async () => {
    const compute = vi.fn().mockResolvedValue(['x']);
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[]];

    await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h', force: true });

    expect(compute).toHaveBeenCalledOnce();
  });
});

// ── WI-7226: producerVersion is a RATCHET, on the write side too ─────────────
//
// One row per (workspace, harness, key), but three long-running writers on this
// box (:3170 staging, :3070 release, papercup-bg-host), none hot-reloading. So
// after a producerVersion bump they disagree until each restarts. Measured live
// on plans.lint: v4 written 03:57:01Z, clobbered back to v2 at 03:58:12Z, ten
// consecutive reads returning 0 rows while both sides re-warmed at ~14-22s a go.
describe('producerVersion downgrade guard (WI-7226)', () => {
  it('does NOT recompute when a NEWER producerVersion already owns the key', async () => {
    const compute = vi.fn();
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 1_000,
      producerVersion: 2,
      scope: 'workspace',
      compute,
    });
    // Stored v3 > our v2, and long past the ttl — without the guard this is the
    // exact shape that recomputes on EVERY tick (a mismatch reads as stale).
    sqlResults = [[{ computed_at: Date.now() - 60_000, producer_version: 3 }]];

    const [outcome] = await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h' });

    expect(compute).not.toHaveBeenCalled();
    expect(outcome.skippedFresh).toBe(true);
    expect(outcome.refreshed).toBe(false);
  });

  it('holds even under force — force means "ignore the ttl", not "downgrade the row"', async () => {
    const compute = vi.fn();
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[{ computed_at: Date.now() - 60_000, producer_version: 5 }]];

    await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h', force: true });

    expect(compute).not.toHaveBeenCalled();
  });

  it('still recomputes when the stored version is OLDER — an UPGRADE must not be blocked', async () => {
    const compute = vi.fn().mockResolvedValue(['new-shape']);
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 1_000,
      producerVersion: 4,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[{ computed_at: Date.now() - 60_000, producer_version: 2 }], []];

    const [outcome] = await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h' });

    expect(compute).toHaveBeenCalledOnce();
    expect(outcome.refreshed).toBe(true);
  });

  it('the upsert carries a WHERE that refuses a downgrade', async () => {
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 1_000,
      producerVersion: 3,
      scope: 'workspace',
      compute: vi.fn().mockResolvedValue(['x']),
    });
    sqlResults = [[{ computed_at: Date.now() - 60_000, producer_version: 3 }], []];

    await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h' });

    const upsert = sqlMock.mock.calls.at(-1)?.[0] as string[] | undefined;
    const text = Array.isArray(upsert) ? upsert.join('') : String(upsert ?? '');
    expect(text).toContain('payload = EXCLUDED.payload');
    // The ratchet itself. Without this the newest write is racy, not durable.
    expect(text).toContain('producer_version <= EXCLUDED.producer_version');
  });

  it('a read whose stored version is NEWER does not warm — the superseded process must not storm', async () => {
    const compute = vi.fn().mockResolvedValue([]);
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [
      [{ payload: [{ newer: true }], computed_at: Date.now(), compute_ms: 1, producer_version: 9, error: null }],
    ];

    const { payload, meta } = await readDerivedSnapshot('test.slow');

    // Still absent to THIS reader — it cannot parse a shape from the future.
    expect(payload).toBeNull();
    expect(meta.missing).toBe(true);
    // But it must not try to "heal" it: the write would be refused anyway, and
    // warming on every read is what turns a rolling deploy into a compute storm.
    expect(compute).not.toHaveBeenCalled();
  });

  it('a read whose stored version is OLDER still warms — that is a legitimate upgrade', async () => {
    const compute = vi.fn().mockResolvedValue([]);
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 60_000,
      producerVersion: 5,
      scope: 'workspace',
      compute,
    });
    sqlResults = [
      [{ payload: [{ old: true }], computed_at: Date.now(), compute_ms: 1, producer_version: 2, error: null }],
      [{ computed_at: Date.now() - 60_000, producer_version: 2 }],
      [],
    ];

    const { payload, meta } = await readDerivedSnapshot('test.slow');

    expect(payload).toBeNull();
    expect(meta.missing).toBe(true);
    await vi.waitFor(() => expect(compute).toHaveBeenCalled());
  });

  // EI-19480218051289304. The warm path names its key explicitly (`only: [key]`),
  // and `only` OVERRIDES the exclusion by design — that override is how the
  // producer's own routine drives it. So the flag that keeps a minutes-scale
  // compute off the shared 2-min tick left it reachable from any ordinary reader
  // of a cold panel: same cost, worse trigger (unscheduled, once per distinct
  // caller, invisible to the routine bookkeeping).
  it('a MISS on an excludeFromDefaultSweep producer does NOT warm — only its own routine fills it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const compute = vi.fn().mockResolvedValue(['expensive']);
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 12 * 60 * 60_000,
      producerVersion: 1,
      scope: 'workspace',
      excludeFromDefaultSweep: true,
      compute,
    });
    sqlResults = [[], [], [], []];

    const { payload, meta } = await readDerivedSnapshot('test.slow');

    // The read behaves exactly as before: an immediate, honest miss.
    expect(payload).toBeNull();
    expect(meta.missing).toBe(true);
    // What must NOT happen is the background fill. Asserted twice: not synchronously,
    // and not on a later tick either (the warm is fire-and-forget, so a bare
    // `not.toHaveBeenCalled()` here would also pass while the compute was merely
    // pending — the very shape this guard exists to prevent).
    expect(compute).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compute).not.toHaveBeenCalled();

    // The decline is explained ONCE per key, not once per read: this read runs on
    // every ~3s sync poll of a cold panel, so a per-read line would be a log flood
    // and would train everyone to filter out the one message that explains the
    // empty panel.
    await readDerivedSnapshot('test.slow');
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('NOT warming from a read'))).toHaveLength(1);
    warn.mockRestore();

    // Falsifiability control: the SAME miss on a non-excluded producer DOES warm —
    // proven by 'kicks a BACKGROUND warm-up on a miss without awaiting it' above,
    // which is identical but for `excludeFromDefaultSweep`. Without that pairing
    // this test would still pass if warming broke outright.
  });

  it('a MISS on a refreshOnRead producer heals in the background without joining the default sweep', async () => {
    const compute = vi.fn().mockResolvedValue(['fresh']);
    registerDerivedRead({
      key: 'test.lazy',
      ttlMs: 12 * 60 * 60_000,
      producerVersion: 1,
      scope: 'workspace',
      excludeFromDefaultSweep: true,
      refreshOnRead: true,
      compute,
    });
    sqlResults = [[], [], []];

    const { payload, meta } = await readDerivedSnapshot('test.lazy');

    expect(payload).toBeNull();
    expect(meta.missing).toBe(true);
    await vi.waitFor(() => expect(compute).toHaveBeenCalledOnce());
  });

  it('still warms a producer that merely has a LONG ttl — duration is the criterion, not cadence', async () => {
    // The guard keys off the explicit opt-out, never off ttl. A 12h-ttl producer
    // that never asked to leave the sweep must keep healing a cold DB on its own.
    const compute = vi.fn().mockResolvedValue(['x']);
    registerDerivedRead({
      key: 'test.slow',
      ttlMs: 12 * 60 * 60_000,
      producerVersion: 1,
      scope: 'workspace',
      compute,
    });
    sqlResults = [[], [], []];

    const { meta } = await readDerivedSnapshot('test.slow');

    expect(meta.missing).toBe(true);
    await vi.waitFor(() => expect(compute).toHaveBeenCalled());
  });
});

describe('refreshDerivedReads producer ordering (WI-5471)', () => {
  it('runs producers shortest-ttl-FIRST so a heavy long-walk never head-of-line-blocks the liveness ones', async () => {
    // Registration order is deliberately the WORST case (heaviest/longest-ttl first),
    // to prove the pass reorders rather than relying on how producers happen to be
    // declared — this is exactly the storage.usage-registered-first hazard.
    const order: string[] = [];
    const mk = (key: string, ttlMs: number) =>
      registerDerivedRead({
        key,
        ttlMs,
        producerVersion: 1,
        scope: 'workspace',
        compute: vi.fn().mockImplementation(() => {
          order.push(key);
          return Promise.resolve([key]);
        }),
      });
    mk('storage.usage', 30 * 60_000); // heavy, long ttl — must run LAST
    mk('dev.serviceHealth', 90_000); // liveness — must run FIRST
    mk('plans.lint', 6 * 60 * 60_000); // heaviest, longest ttl — dead last
    mk('dev.gitPipeline', 90_000);
    sqlResults = [[], [], [], []]; // one INSERT per producer (force skips the SELECT)

    await refreshDerivedReads({ workspaceId: 'ws-test', harnessSlug: 'h', force: true });

    // ascending by ttl; the two 90s producers precede the 30m and 6h walks
    expect(order.indexOf('dev.serviceHealth')).toBeLessThan(order.indexOf('storage.usage'));
    expect(order.indexOf('dev.gitPipeline')).toBeLessThan(order.indexOf('storage.usage'));
    expect(order.indexOf('storage.usage')).toBeLessThan(order.indexOf('plans.lint'));
    expect(order.at(-1)).toBe('plans.lint');
  });
});
