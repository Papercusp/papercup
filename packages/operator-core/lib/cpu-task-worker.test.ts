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
import { Worker } from 'node:worker_threads';

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

/**
 * WI-37688 — the three transient-failure traps this module inherited from
 * local-embedder-worker.ts. Each of these failed before the fix:
 *   - a single crash left `disabled` latched on forever
 *   - an in-flight request was dropped without settling
 *   - the worker was never unref'd, so a one-off process could not exit
 */
describe('cpu-task-worker — transient-failure recovery (WI-37688)', () => {
  /** A batch big enough to take the worker path. */
  function bigBatch(m: { OFFLOAD_MIN_ITEMS: number }) {
    return Array.from({ length: m.OFFLOAD_MIN_ITEMS + 1 }, (_, i) => ({ id: i }));
  }

  it('a single worker crash does NOT disable the offload, and the next call respawns', async () => {
    const m = await mod();
    const rows = bigBatch(m);

    await m.serializeJsonResponse({ rows }, rows.length);
    expect(m.getCpuWorkerState().alive).toBe(true);

    expect(m._injectWorkerCrashForTest(new Error('transient boom'))).toBe(true);

    // The latch is the defect: one transient crash must not turn the offload
    // off for the rest of the process lifetime.
    const afterCrash = m.getCpuWorkerState();
    expect(afterCrash.disabled).toBe(false);
    expect(afterCrash.alive).toBe(false);

    // ...and the very next call must self-heal by respawning.
    const json = await m.serializeJsonResponse({ rows }, rows.length);
    expect(JSON.parse(json)).toEqual({ rows });
    const healed = m.getCpuWorkerState();
    expect(healed.alive).toBe(true);
    expect(healed.disabled).toBe(false);
    // A success resets the crash run — otherwise unrelated crashes spread out
    // over a long-lived process would eventually trip the breaker.
    expect(healed.consecutiveCrashes).toBe(0);
  });

  it('a crash run BROKEN BY a served request does not trip the breaker', async () => {
    const m = await mod();
    const rows = bigBatch(m);

    // Crash, serve, crash, serve, crash... A worker that is answering
    // requests is working, however flaky — it must keep being respawned.
    for (let i = 0; i < 4; i++) {
      const json = await m.serializeJsonResponse({ rows }, rows.length);
      expect(JSON.parse(json)).toEqual({ rows });
      expect(m._injectWorkerCrashForTest(new Error(`flaky ${i}`))).toBe(true);
      expect(m.getCpuWorkerState().consecutiveCrashes).toBe(1);
    }
    expect(m.getCpuWorkerState().disabled).toBe(false);
  });

  it('gives up after a run of crashes that serve NOTHING, so a broken worker is not respawned per request', async () => {
    const m = await mod();
    const rows = bigBatch(m);

    // Remove the answer so every spawned worker goes ready and then serves
    // nothing — the "spawns fine, dies on every message" case the breaker
    // exists for.
    const realPost = Worker.prototype.postMessage;
    (Worker.prototype as unknown as { postMessage: () => void }).postMessage = () => {};

    try {
      for (let i = 0; i < 3; i++) {
        const inFlight = m.serializeJsonResponse({ rows }, rows.length);
        // Wait for the request to actually be in flight rather than sleeping
        // a guessed interval.
        for (let t = 0; t < 200 && m.getCpuWorkerState().pendingCount === 0; t++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(m.getCpuWorkerState().pendingCount).toBe(1);
        expect(m._injectWorkerCrashForTest(new Error(`boom ${i}`))).toBe(true);
        await inFlight; // rejected internally, answered by the sync fallback
      }
    } finally {
      (Worker.prototype as unknown as { postMessage: typeof realPost }).postMessage =
        realPost;
    }

    // Still CORRECT — the sync fallback answers — but the offload has been
    // given up on rather than respawned on every single request.
    expect(m.getCpuWorkerState()).toMatchObject({ disabled: true, consecutiveCrashes: 3 });
    const json = await m.serializeJsonResponse({ rows }, rows.length);
    expect(JSON.parse(json)).toEqual({ rows });
  });

  it('settles an in-flight request when the worker goes away instead of dropping it', async () => {
    const m = await mod();
    const rows = bigBatch(m);

    // Warm the worker on the real path first, so the request under test is
    // the only thing in flight.
    await m.serializeJsonResponse({ rows }, rows.length);

    // Remove the answer: with postMessage stubbed the worker can never reply,
    // so the request stays pending for as long as we need it to. Hoping the
    // worker is "slow enough" would race it (EI-20053788422725852).
    const realPost = Worker.prototype.postMessage;
    (Worker.prototype as unknown as { postMessage: () => void }).postMessage = () => {};

    let settled = false;
    try {
      const inFlight = m.serializeJsonResponse({ rows }, rows.length).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await new Promise((r) => setTimeout(r, 50));
      // One snapshot, asserted as an invariant object — reading pendingCount
      // and keepAlive in two separate expects is a race, not an assertion.
      expect(m.getCpuWorkerState()).toMatchObject({ pendingCount: 1, keepAlive: true });

      // The worker goes away underneath the in-flight request.
      await m._resetCpuWorker();

      await Promise.race([inFlight, new Promise((r) => setTimeout(r, 2000))]);
      // Pre-fix this was false: the promise never settled and the awaiting
      // HTTP handler in rest-query.ts would never send a response.
      expect(settled).toBe(true);
    } finally {
      (Worker.prototype as unknown as { postMessage: typeof realPost }).postMessage =
        realPost;
    }

    expect(m.getCpuWorkerState()).toMatchObject({ pendingCount: 0, keepAlive: false });
  });

  it('holds the event loop open only while a request is in flight', async () => {
    const m = await mod();
    const rows = bigBatch(m);

    expect(m.getCpuWorkerState()).toMatchObject({ keepAlive: false });
    await m.serializeJsonResponse({ rows }, rows.length);

    // Idle again after the round-trip: the worker is alive but must NOT be
    // holding the loop open, or a one-off process never exits.
    expect(m.getCpuWorkerState()).toMatchObject({ alive: true, keepAlive: false });
  });
});
