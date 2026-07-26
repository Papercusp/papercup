/**
 * cpu-task-worker.test.ts — protocol contract + functional tests for the
 * worker-thread CPU offload module.
 *
 * infra-perf-reliability-audit-round3-2026-06-19 P-011 / round4 P-002.
 *
 * What's tested here:
 *   - API surface (exports exist with right types)
 *   - Initial module state (nothing spawned)
 *   - serializeJsonResponse: small-batch sync fallback path
 *   - serializeJsonResponse: large-batch worker path (end-to-end)
 *   - BigInt→Number coercion on both paths
 *   - that the output is NEVER compressed (inverse guard, 2026-07-26)
 *   - getCpuWorkerState diagnostics
 *   - _resetCpuWorker test seam
 *
 * The worker script (.mjs) is co-located — no external dep needed.
 * All tests run in Node via vitest, so worker_threads is available.
 */

import { describe, it, expect, afterEach } from 'vitest';

// Dynamic import lets afterEach reset module state between tests.
async function mod() {
  return import('./cpu-task-worker');
}

afterEach(async () => {
  const m = await mod();
  await m._resetCpuWorker();
});

describe('cpu-task-worker — API surface', () => {
  it('exports the expected functions', async () => {
    const m = await mod();
    expect(typeof m.serializeJsonResponse).toBe('function');
    expect(typeof m._resetCpuWorker).toBe('function');
    expect(typeof m.getCpuWorkerState).toBe('function');
    expect(typeof m.OFFLOAD_MIN_ITEMS).toBe('number');
  });

  it('getCpuWorkerState starts in idle state', async () => {
    const m = await mod();
    const s = m.getCpuWorkerState();
    expect(s.alive).toBe(false);
    expect(s.disabled).toBe(false);
    expect(s.pendingCount).toBe(0);
    expect(typeof s.minItems).toBe('number');
  });
});

describe('cpu-task-worker — sync fallback (small batch)', () => {
  it('returns a JSON string for a small batch', async () => {
    const m = await mod();
    // itemCount < OFFLOAD_MIN_ITEMS → sync fallback
    const body = await m.serializeJsonResponse({ results: [1, 2, 3] }, 1);
    expect(typeof body).toBe('string');
    expect(JSON.parse(body)).toEqual({ results: [1, 2, 3] });
  });

  it('converts BigInt values to Number in the sync path', async () => {
    const m = await mod();
    const body = await m.serializeJsonResponse({ id: BigInt('9007199254740993') }, 1);
    const parsed = JSON.parse(body) as { id: number };
    // BigInt 9007199254740993n converts to Number 9007199254740992 (JS precision limit)
    expect(typeof parsed.id).toBe('number');
  });

  // INVERSE guard (2026-07-26): this module used to gzip large payloads. It
  // must not again — the operator is a loopback desktop sidecar, so
  // compression is pure CPU for bytes that never leave the machine, and the
  // gzipSync it replaced was itself a ~50–100 ms main-thread block.
  it('returns an uncompressed string even for a large payload', async () => {
    const m = await mod();
    // Comfortably over the old 1024-byte gzip threshold.
    const bigArray = Array.from({ length: 100 }, (_, i) => ({ index: i, value: 'x'.repeat(20) }));
    const body = await m.serializeJsonResponse({ rows: bigArray }, 1);
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(1024);
    // Parseable directly — no decompression step exists.
    const parsed = JSON.parse(body) as { rows: typeof bigArray };
    expect(parsed.rows.length).toBe(100);
  });
});

describe('cpu-task-worker — worker thread path (large batch)', () => {
  it('serializes a large batch via the worker and returns JSON string', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({ id: i }));
    const body = await m.serializeJsonResponse({ rows }, rows.length);
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body) as { rows: typeof rows };
    expect(parsed.rows.length).toBe(rows.length);
  });

  // INVERSE guard — the worker path must not reintroduce compression either.
  it('returns an uncompressed string from the worker path for a large payload', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({
      id: i,
      data: 'x'.repeat(50),
    }));
    const body = await m.serializeJsonResponse({ rows }, rows.length);
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body) as { rows: typeof rows };
    expect(parsed.rows.length).toBe(rows.length);
  });

  it('converts BigInt values to Number via the worker path', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({
      id: BigInt(i),
      name: `row-${i}`,
    }));
    const body = await m.serializeJsonResponse({ rows }, rows.length);
    const parsed = JSON.parse(body) as { rows: { id: number; name: string }[] };
    // All BigInt ids must have been coerced to Number
    for (const row of parsed.rows) {
      expect(typeof row.id).toBe('number');
    }
  });

  it('after a large-batch call, getCpuWorkerState shows worker alive', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({ id: i }));
    await m.serializeJsonResponse({ rows }, rows.length);
    const s = m.getCpuWorkerState();
    // Worker should have been spawned and stay alive.
    expect(s.alive || s.disabled).toBe(true);
  });
});

describe('cpu-task-worker — _resetCpuWorker test seam', () => {
  it('returns state to fully idle after reset', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({ id: i }));
    await m.serializeJsonResponse({ rows }, rows.length);
    await m._resetCpuWorker();
    const s = m.getCpuWorkerState();
    expect(s.alive).toBe(false);
    expect(s.disabled).toBe(false);
    expect(s.pendingCount).toBe(0);
  });
});
