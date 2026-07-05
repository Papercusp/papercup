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

import { runBackfillSweep, getLastBackfillResult, backfillTable } from './embed-backfill';

function resetSweepState(): void {
  const key = Symbol.for('papercusp.embedBackfillSweepState');
  const g = globalThis as Record<
    symbol,
    { running: boolean; lastResult: unknown; sweepCounter?: number } | undefined
  >;
  const s = g[key];
  if (s) {
    s.running = false;
    s.lastResult = null;
    s.sweepCounter = 0; // WI-2905 rotation offset — deterministic order per test
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

  // ── WI-2905: sweep fairness (no table can starve the shared daily budget) ──

  it('caps one table at maxRows per sweep instead of draining until the budget dies (WI-2905)', async () => {
    // A target with an endless NULL backlog: every SELECT returns a full batch.
    // With maxRows=4 the sweep must stop after scanning 4 rows (2 batches of 2)
    // and NEVER issue a third SELECT — pre-fix it looped until budget exhaustion.
    const rows = [
      { k0: 'a', body: 'one' },
      { k0: 'b', body: 'two' },
    ];
    unsafeResults = [
      [...rows], [], [],       // batch 1 (2 rows) + its 2 UPDATEs
      [...rows], [], [],       // batch 2 (2 rows) + its 2 UPDATEs
      [...rows],               // would-be batch 3 — must never be consumed
    ];
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql as unknown as Parameters<typeof backfillTable>[0];
    const stats = await backfillTable(
      sql,
      { table: 'harness_shared.session_turns', embedCol: 'text_embedding', bodySql: 'text', keyCols: ['id'] },
      async () => VEC,
      4,
    );
    expect(stats.scanned).toBe(4);
    expect(stats.embedded).toBe(4);
    const selects = unsafeCalls.filter((c) => c.q.trimStart().startsWith('SELECT'));
    expect(selects).toHaveLength(2); // 2 batches, then the cap — no 3rd pull
    // The second pull shrank its LIMIT to the remaining allowance.
    expect(selects[1]!.params![0]).toBe(2);
  });

  it('rotates which target leads each sweep so budget priority round-robins (WI-2905)', async () => {
    // Two sweeps, vector ext present, every column probe returns "missing" so
    // each sweep is just its 5 ordered column probes — enough to observe order.
    unsafeResults = [
      [{ extname: 'vector' }], [], [], [], [], [],
      [{ extname: 'vector' }], [], [], [], [], [],
    ];
    await runBackfillSweep();
    const probesSweep1 = unsafeCalls
      .filter((c) => c.q.includes('information_schema.columns'))
      .map((c) => c.params![0]);
    unsafeCalls.length = 0;
    await runBackfillSweep();
    const probesSweep2 = unsafeCalls
      .filter((c) => c.q.includes('information_schema.columns'))
      .map((c) => c.params![0]);

    expect(probesSweep1[0]).toBe('harness_shared.harness_escalations'); // offset 0
    expect(probesSweep2[0]).toBe('harness_shared.harness_brainstorm');  // offset 1
    // Same SET of targets either way — rotation never drops one.
    expect([...probesSweep1].sort()).toEqual([...probesSweep2].sort());
    // And the RESULT order stays canonical regardless of sweep order.
    const last = getLastBackfillResult()!;
    expect(last[0]!.table).toBe('harness_shared.harness_escalations');
  });
});
