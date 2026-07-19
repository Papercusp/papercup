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

vi.mock('@papercusp/db-org', () => ({
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
    sqlResults = [[{ payload: [{ id: 'a' }], computed_at: Date.now(), compute_ms: 12, producer_version: 1, error: null }]];

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
    sqlResults = [[{ payload: [{ old: true }], computed_at: Date.now(), compute_ms: 1, producer_version: 1, error: null }]];

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
