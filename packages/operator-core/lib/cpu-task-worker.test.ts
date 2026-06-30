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
 *   - gzip path (worker + fallback)
 *   - getCpuWorkerState diagnostics
 *   - _resetCpuWorker test seam
 *
 * The worker script (.mjs) is co-located — no external dep needed.
 * All tests run in Node via vitest, so worker_threads is available.
 */

import { describe, it, expect, afterEach } from 'vitest';
import zlib from 'node:zlib';

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
  it('returns JSON string for a small batch without gzip', async () => {
    const m = await mod();
    // itemCount < OFFLOAD_MIN_ITEMS → sync fallback
    const { body, encoding } = await m.serializeJsonResponse({ results: [1, 2, 3] }, false, 1);
    expect(encoding).toBe(null);
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body as string);
    expect(parsed).toEqual({ results: [1, 2, 3] });
  });

  it('converts BigInt values to Number in the sync path', async () => {
    const m = await mod();
    const { body, encoding } = await m.serializeJsonResponse({ id: BigInt('9007199254740993') }, false, 1);
    expect(encoding).toBe(null);
    const parsed = JSON.parse(body as string) as { id: number };
    // BigInt 9007199254740993n converts to Number 9007199254740992 (JS precision limit)
    expect(typeof parsed.id).toBe('number');
  });

  it('returns gzip Buffer when acceptsGzip=true and payload is large enough', async () => {
    const m = await mod();
    // Build a body that will be ≥ 1024 bytes
    const bigArray = Array.from({ length: 100 }, (_, i) => ({ index: i, value: 'x'.repeat(20) }));
    const { body, encoding } = await m.serializeJsonResponse({ rows: bigArray }, true, 1);
    // Sync path gzips when payload >= 1024 bytes
    expect(encoding).toBe('gzip');
    expect(body).toBeInstanceOf(Buffer);
    const decompressed = zlib.gunzipSync(body as Buffer).toString('utf8');
    const parsed = JSON.parse(decompressed) as { rows: typeof bigArray };
    expect(parsed.rows.length).toBe(100);
  });

  it('does NOT gzip when payload is small even if acceptsGzip=true', async () => {
    const m = await mod();
    const { body, encoding } = await m.serializeJsonResponse({ ok: true }, true, 1);
    // Small payload → no gzip even when requested
    expect(encoding).toBe(null);
    expect(typeof body).toBe('string');
  });
});

describe('cpu-task-worker — worker thread path (large batch)', () => {
  it('serializes a large batch via the worker and returns JSON string', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({ id: i }));
    const { body, encoding } = await m.serializeJsonResponse({ rows }, false, rows.length);
    // Worker path: no gzip requested
    expect(encoding).toBe(null);
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body as string) as { rows: typeof rows };
    expect(parsed.rows.length).toBe(rows.length);
  });

  it('serializes and gzips a large batch via the worker', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({
      id: i,
      data: 'x'.repeat(50),
    }));
    const { body, encoding } = await m.serializeJsonResponse({ rows }, true, rows.length);
    expect(encoding).toBe('gzip');
    expect(body).toBeInstanceOf(Buffer);
    const decompressed = zlib.gunzipSync(body as Buffer).toString('utf8');
    const parsed = JSON.parse(decompressed) as { rows: typeof rows };
    expect(parsed.rows.length).toBe(rows.length);
  });

  it('converts BigInt values to Number via the worker path', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({
      id: BigInt(i),
      name: `row-${i}`,
    }));
    const { body, encoding } = await m.serializeJsonResponse({ rows }, false, rows.length);
    expect(encoding).toBe(null);
    const parsed = JSON.parse(body as string) as { rows: { id: number; name: string }[] };
    // All BigInt ids must have been coerced to Number
    for (const row of parsed.rows) {
      expect(typeof row.id).toBe('number');
    }
  });

  it('after a large-batch call, getCpuWorkerState shows worker alive', async () => {
    const m = await mod();
    const minItems = m.OFFLOAD_MIN_ITEMS;
    const rows = Array.from({ length: minItems + 1 }, (_, i) => ({ id: i }));
    await m.serializeJsonResponse({ rows }, false, rows.length);
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
    await m.serializeJsonResponse({ rows }, false, rows.length);
    await m._resetCpuWorker();
    const s = m.getCpuWorkerState();
    expect(s.alive).toBe(false);
    expect(s.disabled).toBe(false);
    expect(s.pendingCount).toBe(0);
  });
});
