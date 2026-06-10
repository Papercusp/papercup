/**
 * embed-backfill sweep — audit P-010 (EI-119/EI-80).
 *
 * Asserts the sweep runs on the SHARED org pool (getOrgPg — no per-sweep
 * pg.Client), that concurrent sweeps dedupe via the globalThis-pinned state
 * (A18), and that NULL-embedding rows get vectors written back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Seams ────────────────────────────────────────────────────────────
const unsafeCalls: Array<{ q: string; params?: unknown[] }> = [];
// Handler queue: each entry answers the next sql.unsafe call.
let unsafeResults: Array<unknown[]> = [];
// When set, the next sql.unsafe call awaits this gate before resolving —
// lets the concurrency test hold a sweep in flight deterministically.
let unsafeGate: Promise<void> | null = null;

vi.mock('@papercusp/db-org', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: {
      unsafe: async (q: string, params?: unknown[]) => {
        unsafeCalls.push({ q, params });
        if (unsafeGate) {
          const gate = unsafeGate;
          unsafeGate = null;
          await gate;
        }
        return unsafeResults.shift() ?? [];
      },
    },
  }),
}));

vi.mock('../voice-prefs', () => ({
  loadVoicePrefs: async () => ({ memoryEmbedderMode: 'openai' }),
}));
vi.mock('../credentials', () => ({
  readCredentials: async () => ({ openai_api_key: 'test-key' }),
}));

import { runBackfillSweep, getLastBackfillResult } from './embed-backfill';

function resetSweepState(): void {
  const key = Symbol.for('papercusp.embedBackfillSweepState');
  const g = globalThis as Record<symbol, { running: boolean; lastResult: unknown } | undefined>;
  const s = g[key];
  if (s) {
    s.running = false;
    s.lastResult = null;
  }
}

const VEC = Array.from({ length: 384 }, () => 0.1);

beforeEach(() => {
  unsafeCalls.length = 0;
  unsafeResults = [];
  resetSweepState();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: [{ embedding: VEC }] }),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runBackfillSweep (P-010)', () => {
  it('runs entirely on the shared org pool and writes vectors for NULL rows', async () => {
    unsafeResults = [
      [{ extname: 'vector' }],            // pg_extension probe
      // target 1 (harness_escalations): column exists → one batch → empty
      [{ column_name: 'body_embedding' }],
      [{ id: '(0,1)', body: 'escalation text' }],
      [],                                  // UPDATE (returns rows array)
      [],                                  // next batch → empty, loop ends
      // target 2..4: column missing → skipped
      [], [], [],
    ];

    const r = await runBackfillSweep();
    expect(Array.isArray(r)).toBe(true);
    const stats = r as Array<{ table: string; embedded: number }>;
    expect(stats[0]).toMatchObject({ table: 'harness_shared.harness_escalations', embedded: 1 });

    // Every query went through the mocked shared pool.
    expect(unsafeCalls.length).toBeGreaterThan(0);
    const update = unsafeCalls.find((c) => c.q.includes('UPDATE harness_shared.harness_escalations'));
    expect(update).toBeTruthy();
    expect(String(update!.params![0])).toMatch(/^\[0\.1,/); // vector literal
    expect(getLastBackfillResult()).toEqual(stats);
  });

  it('dedupes concurrent sweeps via the globalThis-pinned running flag (A18)', async () => {
    // Hold the first sweep in flight at its pg_extension probe.
    let release!: () => void;
    unsafeGate = new Promise<void>((res) => { release = res; });
    unsafeResults = [[], []]; // ext probe (sweep 1) → no extension → early exit

    const first = runBackfillSweep();
    // Give sweep 1 time to pass mode/embedder resolution and reach the gated
    // PG probe (dynamic imports take real event-loop turns).
    await new Promise((r) => setTimeout(r, 25));

    const second = await runBackfillSweep();
    expect(second).toEqual({ skipped: 'already_running' });

    release();
    const firstResult = await first;
    expect(Array.isArray(firstResult)).toBe(true); // ran to its early-exit result
  });
});
