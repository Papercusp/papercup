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

import { runBackfillSweep, getLastBackfillResult, backfillTable, TARGETS } from './embed-backfill';
// Import the width — the sweep writes into the prose columns, so a width change
// must move this fixture automatically rather than stranding it (384→768).
import { PROSE_VECTOR_DIMS } from './prose-vector-dims';
// The default per-target cap is derived from the resource profile's batch size,
// so the WI-7111 test asserts against the real value rather than a literal that
// would silently stop testing anything if the profile changed.
import { getResourceProfile } from '../resource-profile';

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

const VEC = Array.from({ length: PROSE_VECTOR_DIMS }, () => 0.1);

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

  it('takes over a STALE latch instead of deferring to a hung sweep forever (WI-7327)', async () => {
    // The regression: `running` was a bare boolean cleared only in a `finally`.
    // A sweep that THROWS reaches that finally; a sweep that HANGS never does —
    // and the flag is pinned to globalThis, so every later tick returned
    // `already_running` and the backfill was wedged until the host restarted.
    // Measured 2026-08-03: a sweep hung at 04:45:04Z, the next 9 ticks each
    // no-opped in ~265ms, and 451k rows stayed unembedded with ZERO log output.
    const state = (globalThis as Record<symbol, unknown>)[
      Symbol.for('papercusp.embedBackfillSweepState')
    ] as { running: boolean; startedAt: number | null };

    // Simulate a sweep that took the latch and never gave it back.
    state.running = true;
    state.startedAt = Date.now() - 16 * 60 * 1000; // older than the 15-min ceiling

    unsafeResults = [[]]; // ext probe → no vector extension → clean early exit

    // Precondition: we really are holding the latch the module reads.
    expect(state.running).toBe(true);
    expect(state.startedAt).toBeLessThan(Date.now() - 15 * 60 * 1000);

    const result = await runBackfillSweep();

    // It must RUN, not skip: a holder this old is gone, not slow.
    expect(result).not.toEqual({ skipped: 'already_running' });
    expect(Array.isArray(result)).toBe(true);
    // And the latch must be re-stamped and released cleanly, so the NEXT sweep
    // is judged on its own start time rather than inheriting a dead one.
    expect(state.running).toBe(false);
    expect(state.startedAt).toBeNull();
    // (The takeover also warns loudly; that log is allowlisted in
    // libs/test-config console-noise-filter — an in-test spy does not reliably
    // catch it under the forks pool, so behaviour is what we assert here.)
  });

  it('still defers to a FRESH in-flight sweep (the stale ceiling must not break dedupe)', async () => {
    // Guard the other direction: the WI-7327 takeover must fire ONLY on a hang.
    // A ceiling that is too eager would let two sweeps run concurrently and
    // double-embed, which is the bug the latch exists to prevent.
    const state = (globalThis as Record<symbol, unknown>)[
      Symbol.for('papercusp.embedBackfillSweepState')
    ] as { running: boolean; startedAt: number | null };

    state.running = true;
    state.startedAt = Date.now() - 30 * 1000; // slow, but well inside the ceiling

    const result = await runBackfillSweep();
    expect(result).toEqual({ skipped: 'already_running' });

    state.running = false;
    state.startedAt = null;
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
    // each sweep is just its TARGETS.length ordered column probes — enough to
    // observe order. Derived from TARGETS so adding a target never silently
    // starves sweep 2's ext probe again (EI-9318 — two agents paid the
    // "expected undefined" debugging round-trip before this).
    unsafeResults = [
      [{ extname: 'vector' }], ...TARGETS.map(() => []),
      [{ extname: 'vector' }], ...TARGETS.map(() => []),
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

  /**
   * WI-7111 — `maxRowsPerTarget` threads to the per-target ceiling so a BULK
   * REFILL is not cap-bound at the WI-2905 fairness cap.
   *
   * Why this needs pinning: a prose width change (migration 727: 384→768) drops
   * every stored vector, because pgvector cannot cast between widths. Refilling
   * ~500k rows through the fairness cap takes 2-5 DAYS for session_turns alone
   * (EI-19375205903428632), with semantic search lexical-only throughout. The
   * regression this guards is silent — a refill that "works" but at trickle
   * speed looks identical to a working sweep, and is only distinguishable by
   * the LIMIT the batch pull asks for.
   */
  it('threads maxRowsPerTarget to the batch LIMIT, leaving the default cap intact (WI-7111)', async () => {
    // Reach the first target's batch pull, then end the loop immediately: the
    // LIMIT of that first pull is the whole observable.
    const reachFirstBatchPull = () => [
      [{ extname: 'vector' }],              // pg_extension probe
      [{ column_name: 'body_embedding' }],  // target 1 column probe (no mode col → spaceAware false)
      [],                                   // batch pull → empty, per-target loop ends
      ...TARGETS.slice(1).map(() => []),    // remaining targets: column missing → skipped
    ];
    const firstBatchLimit = () =>
      unsafeCalls.find((c) => c.q.includes('LIMIT $1'))!.params![0];

    // Explicit bulk ceiling, deliberately below BATCH_SIZE so it is the binding
    // constraint (the pull asks for min(BATCH_SIZE, remaining)).
    unsafeResults = reachFirstBatchPull();
    await runBackfillSweep({ maxRowsPerTarget: 3 });
    expect(firstBatchLimit()).toBe(3);

    // Default is unchanged: the routine scheduler calls this with no arguments
    // and must still get the WI-2905 fairness cap, whose first pull is a full
    // BATCH_SIZE (cap = BATCH_SIZE * 4, so min(BATCH_SIZE, cap) === BATCH_SIZE).
    unsafeCalls.length = 0;
    resetSweepState();
    unsafeResults = reachFirstBatchPull();
    await runBackfillSweep();
    expect(firstBatchLimit()).toBe(getResourceProfile().embedBatchSize);
  });
});

/**
 * WI-3616 — the embedding SPACE discriminator (migration 530).
 *
 * The bug these pin: `memoryEmbedderMode` selects the embedder at runtime AND drives
 * the query-side vector. Flipping it left every already-stored vector in a foreign
 * 384-D space. Because the sweep only ever looked for `embedding IS NULL`, those rows
 * were never revisited — the column silently mixed OpenAI and BGE vectors forever and
 * search returned noise (measured: a row's own exact text ranked #6574 of 8383).
 */
describe('embedding-space discriminator (WI-3616)', () => {
  const TARGET = {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    keyCols: ['id'],
  };

  /** Minimal `sql` double: records calls, replays queued results. */
  function fakeSql(results: unknown[][]) {
    const calls: Array<{ q: string; params?: unknown[] }> = [];
    const sql = {
      unsafe: async (q: string, params?: unknown[]) => {
        calls.push({ q, params });
        return results.shift() ?? [];
      },
    };
    return { sql: sql as never, calls };
  }

  const embed = async (): Promise<number[]> => VEC;

  it('re-embeds a row whose recorded space differs from the active embedder', async () => {
    // One stale row (its vector is non-NULL but was made by openai), then empty.
    const { sql, calls } = fakeSql([[{ k0: 'row-1', body: 'hello world' }], [], []]);

    const stats = await backfillTable(sql, TARGET, embed, 10, 'local', true);

    // It was NOT skipped just because text_embedding was already non-NULL.
    expect(stats.embedded).toBe(1);

    const select = calls.find((c) => c.q.includes('SELECT'))!;
    // NULL-safe comparison: `mode <> 'local'` is NULL for pre-530 rows and would
    // match nothing, silently reintroducing the original bug.
    expect(select.q).toContain('IS DISTINCT FROM $2');
    expect(select.q).toContain('text_embedding IS NULL OR');
    expect(select.params).toEqual([10, 'local']);

    // The vector and the space it belongs to are written together — a row can
    // never advertise a space it is not actually in.
    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.q).toContain('text_embedding_mode = $2');
    expect(update.q).toContain('IS DISTINCT FROM $2'); // re-asserted guard
    expect(update.params![1]).toBe('local');
    expect(update.params![2]).toBe('row-1'); // PK shifted to $3
  });

  it('stamps the active mode so a converged column stops being re-swept', async () => {
    const { sql, calls } = fakeSql([[{ k0: 'row-1', body: 'x' }], [], []]);
    await backfillTable(sql, TARGET, embed, 10, 'openai', true);
    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.params![1]).toBe('openai');
  });

  it('legacy DB without migration 530: never binds a parameter the SQL does not use', async () => {
    // Postgres derives the parameter COUNT from the highest $n referenced and rejects a
    // Bind that supplies an unused one ("could not determine data type of parameter $2").
    // The legacy path must therefore omit `mode` entirely — not just skip reading it.
    const { sql, calls } = fakeSql([[{ k0: 'row-1', body: 'x' }], [], []]);

    await backfillTable(sql, TARGET, embed, 10, 'local', false);

    const select = calls.find((c) => c.q.includes('SELECT'))!;
    expect(select.q).not.toContain('_mode');
    expect(select.params).toEqual([10]); // no mode bound

    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.q).not.toContain('_mode');
    expect(update.q).toContain('text_embedding IS NULL');
    expect(update.params).toEqual([`[${VEC.join(',')}]`, 'row-1']); // PK back at $2
  });

  it('sweep turns space-awareness on only when the discriminator column exists', async () => {
    unsafeResults = [
      [{ extname: 'vector' }],
      // harness_escalations: BOTH the vector column and its _mode column exist.
      [{ column_name: 'body_embedding' }, { column_name: 'body_embedding_mode' }],
      [{ k0: 'h', k1: 'p', body: 'escalation text' }],
      [],
      [],
      [], [], [], [],
    ];

    await runBackfillSweep();

    const update = unsafeCalls.find((c) => c.q.includes('UPDATE harness_shared.harness_escalations'))!;
    expect(update.q).toContain('body_embedding_mode = $2');
    expect(update.params![1]).toBe('openai'); // the mocked active mode
  });
});

describe('every TARGETS bodySql caps its free-text input (EI-12967)', () => {
  // The sidecar hard-rejects any text over 32000 chars with an UNRETRYABLE 400 — a row
  // whose embed input has no cap stays `embedCol IS NULL` forever and gets re-selected
  // (and re-fails) by every future sweep tick. harness_escalations/harness_brainstorm/
  // operator_turns/harness_decisions shipped with NO cap at all (live: 392 operator_turns
  // rows + 9 harness_escalations rows over 32000 chars, one re-failing every ~5min since
  // 2026-07-16) while every other target already used the `left(…, 2000)` convention.
  // This is the recurrence guard: a future target (or a re-edit of one of these) that
  // forgets the cap fails HERE instead of silently retry-looping in production.
  it('wraps every bodySql column reference in left(…, N) for N <= 2000', () => {
    for (const target of TARGETS) {
      // A bodySql that is just a bare column name (no left(), no COALESCE-of-a-literal)
      // is the exact shape that caused EI-12967 — every target must at minimum cap via
      // left(<col-or-coalesce>, N). Constant/short expressions (verb, titles) are fine
      // uncapped; every target below DOES reference a free-text column, so demand a cap
      // present somewhere in the expression.
      const leftCaps = [...target.bodySql.matchAll(/left\(\s*(?:COALESCE\([^)]*\)|\w+)\s*,\s*(\d+)\s*\)/g)];
      expect(leftCaps.length, `${target.table}.bodySql has no left(…, N) cap: ${target.bodySql}`).toBeGreaterThan(0);
      for (const m of leftCaps) {
        expect(Number(m[1]), `${target.table}.bodySql cap exceeds 2000: ${target.bodySql}`).toBeLessThanOrEqual(2000);
      }
    }
  });
});
