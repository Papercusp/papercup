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
// WI-7348: same idiom, one phase earlier. When set, embedder RESOLUTION blocks
// on this gate — the only way to reproduce a hang that happens before any row
// is read (and before getOrgPg), which is what `unsafeGate` cannot reach.
let voicePrefsGate: Promise<void> | null = null;

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
  loadVoicePrefs: async () => {
    if (voicePrefsGate) await voicePrefsGate;
    return { memoryEmbedderMode: 'openai' };
  },
}));
vi.mock('../credentials', () => ({
  readCredentials: async () => ({ openai_api_key: 'test-key' }),
}));

import {
  runBackfillSweep,
  getLastBackfillResult,
  backfillTable,
  TARGETS,
  logMemoryVecOutcome,
  resetMemoryVecIdleLogState,
  MEMORY_VEC_IDLE_LOG_INTERVAL_MS,
} from './embed-backfill';
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
  voicePrefsGate = null;
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
    // P-005: probe-ALL-then-drain. The queue is ext-probe, then one column-probe
    // per TARGET, then the round-robin drain.
    unsafeResults = [
      [{ extname: 'vector' }],            // pg_extension probe
      // target 1 (harness_escalations): column exists → the only live target
      [{ column_name: 'body_embedding' }],
      // the other 9 targets: column missing → skipped
      [], [], [], [], [], [], [], [], [],
      // drain round 1 for harness_escalations
      [{ id: '(0,1)', body: 'escalation text' }],
      [],                                  // UPDATE (returns rows array)
      [],                                  // next batch → empty, loop ends
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
    state.startedAt = Date.now() - 61 * 60 * 1000; // older than the 60-min ceiling

    unsafeResults = [[]]; // ext probe → no vector extension → clean early exit

    // Precondition: we really are holding the latch the module reads.
    expect(state.running).toBe(true);
    expect(state.startedAt).toBeLessThan(Date.now() - 60 * 60 * 1000);

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

    // 20 MINUTES — deliberately longer than a naive "surely a sweep is done by
    // now" guess. Measured 2026-08-03: consecutive HEALTHY sweeps took 14.5min
    // and 15.3min against the real backlog. An earlier draft of this fix set the
    // ceiling at 15min, which would have declared both of those dead and run a
    // second sweep alongside them. This case fails if anyone re-lowers it.
    state.running = true;
    state.startedAt = Date.now() - 20 * 60 * 1000;

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
describe('embedder-resolution deadline (WI-7348)', () => {
  const sweepState = () =>
    (
      globalThis as Record<symbol, { running: boolean; startedAt: number | null } | undefined>
    )[Symbol.for('papercusp.embedBackfillSweepState')];

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws instead of hanging forever when embedder RESOLUTION never returns', async () => {
    vi.useFakeTimers();
    // Never resolved: reproduces the measured 2026-08-03 hang, which sat 55min
    // inside pass 1 before any row was read — no DB connection, no socket.
    voicePrefsGate = new Promise<void>(() => {});

    const p = runBackfillSweep();
    const assertion = expect(p).rejects.toThrow(/embedder_resolve_timeout_after_60000ms/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('RELEASES the sweep latch when resolution times out, so backfill is not disabled forever', async () => {
    vi.useFakeTimers();
    voicePrefsGate = new Promise<void>(() => {});

    const p = runBackfillSweep();
    const assertion = expect(p).rejects.toThrow(/embedder_resolve_timeout_after_60000ms/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    // THE regression property. A hang never reached the `finally` that clears
    // `running`, and the state is pinned to globalThis — so one wedged resolve
    // silently disabled ALL future backfill until the much-later stale-latch
    // ceiling expired. Converting the hang into a throw makes the existing
    // `finally` do the work, which is why this is a fix and not a second backstop.
    expect(sweepState()?.running).toBe(false);
    expect(sweepState()?.startedAt).toBeNull();
  });

  it('announces the start and the resolved embedder, so silence is always a fault', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    try {
      // No vector extension -> the sweep returns early, but only AFTER both
      // heartbeat lines. That is the point: the shortest possible successful
      // path still says it ran.
      unsafeResults = [[]];
      await runBackfillSweep();
    } finally {
      spy.mockRestore();
    }

    expect(logs.some((l) => l.includes('sweep starting: resolving embedder'))).toBe(true);
    expect(logs.some((l) => l.includes('embedder resolved: mode='))).toBe(true);
  });
});

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
    // P-005: $3 is the failure-skip OFFSET (0 on the first pull — nothing has
    // failed yet). It is bound on every pull so the placeholder count is stable.
    expect(select.params).toEqual([10, 'local', 0]);

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
    // No mode bound — but the P-005 OFFSET still is, at $2 instead of $3.
    expect(select.params).toEqual([10, 0]);

    const update = calls.find((c) => c.q.includes('UPDATE'))!;
    expect(update.q).not.toContain('_mode');
    expect(update.q).toContain('text_embedding IS NULL');
    expect(update.params).toEqual([`[${VEC.join(',')}]`, 'row-1']); // PK back at $2
  });

  it('sweep turns space-awareness on only when the discriminator column exists', async () => {
    // P-005 reordered the sweep: ALL targets are schema-probed first, THEN drained
    // round-robin. So the queue is ext-probe, 10 column-probes, then the drain.
    unsafeResults = [
      [{ extname: 'vector' }],
      // harness_escalations: BOTH the vector column and its _mode column exist.
      [{ column_name: 'body_embedding' }, { column_name: 'body_embedding_mode' }],
      // The other 9 TARGETS probe as column-missing → skipped, never drained.
      [], [], [], [], [], [], [], [], [],
      // Drain round 1 for harness_escalations: batch, UPDATE, then empty.
      [{ k0: 'h', k1: 'p', body: 'escalation text' }],
      [],
      [],
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

/**
 * EI-19409840792445272 — the memory-vec leg used to log ONLY when
 * `embedded > 0 || failed > 0`, which made three states byte-identical and silent:
 * healthy-idle, a predicate matching nothing, and a disabled embedder. Two of those
 * are total outages of semantic recall.
 *
 * The property under test is NOT the message wording — it is that the states are
 * DISTINGUISHABLE from outside, and that a healthy system stays quiet enough that
 * the loud cases still read as loud.
 */
describe('logMemoryVecOutcome — silent-failure discrimination', () => {
  function capture() {
    const lines: Array<{ level: 'log' | 'warn'; text: string }> = [];
    return {
      lines,
      sink: {
        log: (...a: unknown[]) => lines.push({ level: 'log', text: a.join(' ') }),
        warn: (...a: unknown[]) => lines.push({ level: 'warn', text: a.join(' ') }),
      } as Pick<Console, 'log' | 'warn'>,
    };
  }

  beforeEach(() => resetMemoryVecIdleLogState());

  it('a disabled embedder is LOUD — the most dangerous state must never be silent', () => {
    const { lines, sink } = capture();
    logMemoryVecOutcome({ scanned: 0, embedded: 0, failed: 0, skipped: 'embedder-disabled' }, 0, sink);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].text).toMatch(/DISABLED/);
  });

  it('an empty vector space WITH recallable rows is LOUD, and repeats every tick (it cannot self-heal)', () => {
    const { lines, sink } = capture();
    const totalFailure = {
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'gemma',
      table: 'memory_vec_gemma',
      zeroYield: { vectorSpaceEmpty: true, canonicalHasRows: true },
    };
    logMemoryVecOutcome(totalFailure, 0, sink);
    logMemoryVecOutcome(totalFailure, 1000, sink);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.level === 'warn')).toBe(true);
    expect(lines[0].text).toMatch(/TOTAL FAILURE/);
    // It must name the table — the whole point is answering "which space is empty?"
    expect(lines[0].text).toContain('memory_vec_gemma');
  });

  it('a HEALTHY idle sweep is quiet after its first line — and is NOT confusable with the failure above', () => {
    const { lines, sink } = capture();
    const healthy = {
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'harrier',
      table: 'memory_vec_harrier',
      zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
    };
    logMemoryVecOutcome(healthy, 0, sink);
    logMemoryVecOutcome(healthy, 60_000, sink);
    logMemoryVecOutcome(healthy, 120_000, sink);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('log');
    expect(lines[0].text).not.toMatch(/TOTAL FAILURE|DISABLED/);
  });

  it('names the ACTIVE table on the idle line — the line that would have prevented the misdiagnosis', () => {
    const { lines, sink } = capture();
    logMemoryVecOutcome(
      {
        scanned: 0,
        embedded: 0,
        failed: 0,
        mode: 'harrier',
        table: 'memory_vec_harrier',
        zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
      },
      0,
      sink,
    );
    expect(lines[0].text).toContain('memory_vec_harrier');
    expect(lines[0].text).toContain('harrier');
  });

  it('re-logs IMMEDIATELY when the active target changes, without waiting for the interval', () => {
    const { lines, sink } = capture();
    const at = (table: string, mode: string) => ({
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode,
      table,
      zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
    });
    logMemoryVecOutcome(at('memory_vec_harrier', 'harrier'), 0, sink);
    logMemoryVecOutcome(at('memory_vec_gemma', 'gemma'), 1000, sink);
    expect(lines).toHaveLength(2);
    expect(lines[1].text).toContain('memory_vec_gemma');
  });

  it('restates the live target once the interval elapses, so the signal never goes permanently dark', () => {
    const { lines, sink } = capture();
    const healthy = {
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'harrier',
      table: 'memory_vec_harrier',
      zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
    };
    logMemoryVecOutcome(healthy, 0, sink);
    logMemoryVecOutcome(healthy, MEMORY_VEC_IDLE_LOG_INTERVAL_MS, sink);
    expect(lines).toHaveLength(2);
  });

  it('a productive pass names the target too (counts alone never identified the table)', () => {
    const { lines, sink } = capture();
    logMemoryVecOutcome(
      { scanned: 5, embedded: 4, failed: 1, mode: 'harrier', table: 'memory_vec_harrier' },
      0,
      sink,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain('memory_vec_harrier');
    expect(lines[0].text).toMatch(/embedded=4/);
  });

  it('the three zero-count states are mutually DISTINGUISHABLE — the core regression guard', () => {
    const render = (r: Parameters<typeof logMemoryVecOutcome>[0]) => {
      resetMemoryVecIdleLogState();
      const { lines, sink } = capture();
      logMemoryVecOutcome(r, 0, sink);
      return lines.map((l) => `${l.level}:${l.text}`).join('|');
    };
    const disabled = render({ scanned: 0, embedded: 0, failed: 0, skipped: 'embedder-disabled' });
    const dead = render({
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'harrier',
      table: 'memory_vec_harrier',
      zeroYield: { vectorSpaceEmpty: true, canonicalHasRows: true },
    });
    const healthy = render({
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: 'harrier',
      table: 'memory_vec_harrier',
      zeroYield: { vectorSpaceEmpty: false, canonicalHasRows: true },
    });
    expect(new Set([disabled, dead, healthy]).size).toBe(3);
  });
});

/**
 * P-005 — drain policy: freshest-first ordering, batched embeds, failure-skip,
 * and round-robin fairness in place of the per-sweep row ceiling.
 *
 * These guard the four properties that made the sweep starve a big table:
 * arbitrary pull order, one HTTP round-trip per ROW, persistent failures pinning
 * the head of the queue, and a ceiling set without reference to write rate.
 */
describe('embed-backfill drain policy (P-005)', () => {
  const ORDERED = {
    table: 'harness_shared.session_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    keyCols: ['id'],
    orderBySql: 'ingested_at DESC',
  };
  const UNORDERED = {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: 'text',
    keyCols: ['id'],
  };

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
  const selects = (calls: Array<{ q: string }>) => calls.filter((c) => c.q.includes('SELECT'));

  it('pulls FRESHEST-FIRST when the target declares an order', async () => {
    const { sql, calls } = fakeSql([[{ k0: 'r1', body: 'x' }], [], []]);
    await backfillTable(sql, ORDERED, embed, 10, 'gemma', true);
    expect(selects(calls)[0].q).toContain('ORDER BY ingested_at DESC');
  });

  it('omits ORDER BY entirely for a target that declares none', async () => {
    const { sql, calls } = fakeSql([[{ k0: 'r1', body: 'x' }], [], []]);
    await backfillTable(sql, UNORDERED, embed, 10, 'gemma', true);
    expect(selects(calls)[0].q).not.toContain('ORDER BY');
  });

  it('embeds a whole batch in ONE call when a batch embedder is supplied', async () => {
    const rows = [
      { k0: 'a', body: 'aaa' },
      { k0: 'b', body: 'bbb' },
      { k0: 'c', body: 'ccc' },
    ];
    const { sql } = fakeSql([rows, [], [], [], []]);
    const batchCalls: string[][] = [];
    const embedMany = async (texts: string[]) => {
      batchCalls.push(texts);
      return texts.map(() => VEC);
    };
    const perRow = vi.fn(async () => VEC);

    const stats = await backfillTable(sql, ORDERED, perRow, 10, 'gemma', true, embedMany);

    expect(stats.embedded).toBe(3);
    // ONE batch call carrying all three bodies — not three single-text calls.
    expect(batchCalls).toEqual([['aaa', 'bbb', 'ccc']]);
    // The per-row embedder is never touched on the happy path.
    expect(perRow).not.toHaveBeenCalled();
  });

  it('falls back to the PER-ROW embedder when the batch call fails, so one bad row cannot sink its batch', async () => {
    const rows = [
      { k0: 'a', body: 'aaa' },
      { k0: 'b', body: 'bbb' },
    ];
    const { sql } = fakeSql([rows, [], [], [], []]);
    const embedMany = async () => {
      throw new Error('sidecar_embed_400: one text too long');
    };
    const perRow = vi.fn(async () => VEC);

    const stats = await backfillTable(sql, ORDERED, perRow, 10, 'gemma', true, embedMany);

    // Every row still lands, via the isolating per-row path.
    expect(stats.embedded).toBe(2);
    expect(perRow).toHaveBeenCalledTimes(2);
  });

  it('OFFSETs past rows that persistently FAIL, so they cannot pin the head of an ordered queue', async () => {
    // Row 'bad' always throws; 'good' succeeds. With a stable ORDER BY and no
    // offset, 'bad' would be re-selected in every batch forever.
    const { sql, calls } = fakeSql([
      [{ k0: 'bad', body: 'bad' }, { k0: 'good', body: 'good' }],
      [], // UPDATE for 'good'
      [], // next pull → empty
    ]);
    const flaky = async (t: string) => {
      if (t === 'bad') throw new Error('permanent');
      return VEC;
    };

    const stats = await backfillTable(sql, ORDERED, flaky, 10, 'gemma', true);

    expect(stats.embedded).toBe(1);
    expect(stats.errors).toBe(1);
    const pulls = selects(calls);
    // First pull starts at 0; the pull AFTER a failure skips it.
    expect(pulls[0].params![2]).toBe(0);
    expect(pulls[1].params![2]).toBe(1);
  });

  it('does NOT cap a target at the old 4-batch ceiling — the bound is time, not rows', async () => {
    // Nine consecutive full batches of 1 row each. The pre-P-005 default would
    // have stopped this target after BATCH_SIZE*4 rows regardless of capacity.
    const rows: unknown[][] = [];
    for (let i = 0; i < 9; i++) {
      rows.push([{ k0: `r${i}`, body: `body-${i}` }]);
      rows.push([]); // its UPDATE
    }
    rows.push([]); // final empty pull
    const { sql } = fakeSql(rows);

    // maxRows well above the old ceiling: the loop must keep going, not stop at 4.
    const stats = await backfillTable(sql, ORDERED, embed, 1000, 'gemma', true);
    expect(stats.embedded).toBe(9);
  });
});
