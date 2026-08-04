import { describe, it, expect, vi, beforeEach } from 'vitest';

// db-org is mocked so the dedup/bump paths (getOrgPg().sql) are deterministic and
// never touch a real PG. `sqlRows` is the canned result the sql tag returns; the
// dedup test sets it to mark a memory id as recently-surfaced.
let sqlRows: Array<{ id: string }> = [];
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: async () => sqlRows }),
}));

vi.mock('./backend', () => ({
  getMemoryBackend: vi.fn(),
}));

// P-026: the push-path recall telemetry is fire-and-forget behind a dynamic
// import; mocking it lets the wiring be asserted (see the P-026 describe below).
const recordRecallStatsMock = vi.hoisted(() => vi.fn(async (_sql: unknown, _input: unknown) => {}));
vi.mock('./recall-stats', () => ({ recordRecallStats: recordRecallStatsMock }));

// P-001: the corpus leg is behind a DYNAMIC import, so it is stubbed here and
// driven per-test via `corpusIoResult`.
//
// The default THROWS on purpose. `startCorpusLeg` swallows a fault into "the
// leg did not run", which is exactly the state every pre-P-001 test in this
// file already sat in (the real module needs a live search registry). Defaulting
// to a *successful* empty result would instead make every test in this file
// report a leg that ran BM25-only — which now emits a console.warn, and this
// package is fail-on-console.
type CorpusIoStub = {
  block: string | null;
  lines: Array<{ line: string; handle: { ref: string } }>;
  dropped: unknown[];
  embedderAvailable: boolean;
  candidateCount: number;
};
let corpusIoResult: CorpusIoStub | null = null;
const recallCorpusContext = vi.fn(async (_input: Record<string, unknown>) => {
  if (!corpusIoResult) throw new Error('corpus leg not stubbed for this test');
  return corpusIoResult;
});
vi.mock('./corpus-recall-io', () => ({ recallCorpusContext }));

// The harness registry backs the member→hive resolution (knowledge-packs
// P-004). Canned per-test via `registryProjects`; default empty ⇒ no hive pull.
let registryProjects: Array<{ slug: string; harness_kind?: string; hive_slug?: string }> = [];
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: registryProjects })),
}));

import {
  buildMemoryContextBlock,
  lastUserContext,
  MEMORY_INJECTION_COSINE_FLOOR,
  MEMORY_INJECTION_LEX_FLOOR,
  _resetCorpusLegHealthForTests,
} from './injection';
import { CORPUS_BLOCK_HEADING } from './corpus-recall';
import { getMemoryBackend } from './backend';
import { _resetForTests } from './bump-last-surfaced';

type Row = { id: string; text: string; kind?: string };

// The neutral-backend mock (generalize-memory-backend-swappable D-003):
// `search` stamps each canned row with the scope it was queried under,
// mimicking the real backend's per-pool attribution.
//
// F-C (P-033, D-011): the push path now issues ONE multi-scope search, so the
// mock fans the canned rows out over EVERY requested scope — as the real
// backend does (mem0-backend.ts fans out per scope and merges). The aggregate
// is unchanged from the pre-F-C three-call era, where each call returned the
// same rows stamped with its own scope.
const mockBackend = (rows: Row[], availability: { ok: boolean; reason?: string } = { ok: true }) => ({
  name: 'fake',
  available: vi.fn(async () => availability),
  search: vi.fn(async (_q: string, opts: { scope: string | readonly string[] }) => {
    const scopes = typeof opts.scope === 'string' ? [opts.scope] : [...opts.scope];
    return scopes.flatMap((scope) => rows.map((r) => ({ ...r, scope })));
  }),
});

const useBackend = (b: ReturnType<typeof mockBackend>): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

beforeEach(() => {
  vi.mocked(getMemoryBackend).mockReset();
  recordRecallStatsMock.mockClear();
  sqlRows = [];
  registryProjects = [];
  corpusIoResult = null;
  _resetForTests();
  _resetCorpusLegHealthForTests();
});

/**
 * context-injection-audit-2026-07-28 P-032 (F-B / D-010) — the CEILING guard.
 *
 * The push path must be able to return FEWER than K, including ZERO. It could
 * not: under the hybrid default `floored-union` the lexical leg admits hits on
 * minLexScore ALONE, so the cosine leg could return zero and the block still came
 * back full — 97% of turn-start recalls returned exactly the pool-limit sums with
 * a 0.0% zero-hit rate (D-005). The fix is the fusion MODE, not any constant:
 * `cosine-gated` seeds candidates only from cosine hits.
 *
 * These tests pin that the push path REQUESTS the gated mode. The mode's actual
 * short-circuit semantics belong to the hybrid backend and are pinned there
 * (hybrid-backend.test.ts) — asserting them against this file's fake backend
 * would only prove the fake ignores the flag, which is exactly the false-green
 * this comment exists to prevent.
 */
describe('push path requests a relevance-gated ceiling (P-032 / F-B)', () => {
  const optsOf = (b: ReturnType<typeof mockBackend>, i: number) =>
    b.search.mock.calls[i]![1] as { fusionMode?: string; minScore?: number; limit?: number };
  const diversifyOf = (b: ReturnType<typeof mockBackend>, i: number) =>
    (b.search.mock.calls[i]![1] as { diversify?: { lambda?: number } }).diversify;

  // F-C (P-033, D-011) collapsed the three per-pool searches into ONE
  // multi-scope search, so "every pool is gated" is now "the one call covering
  // every pool is gated" — the guarantee is unchanged, its shape is not.
  it('passes fusionMode cosine-gated on the search covering EVERY pool (user, harness, hive)', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      hiveSlugs: ['hivey'],
    });
    expect(backend.search).toHaveBeenCalledTimes(1);
    expect(optsOf(backend, 0).fusionMode).toBe('cosine-gated');
    expect(backend.search.mock.calls[0]![1]!.scope).toEqual([
      'u1',
      'harness:papercusp',
      'hive:hivey',
    ]);
  });

  /**
   * P-046's GUARD, at the seam it actually has to hold (P-044 / F-L).
   *
   * `recall-query.test.ts` pins that `lexicalQueryText` COMPOSES a query
   * carrying the signals. That is necessary and not sufficient: a refactor
   * could keep that function perfect while this file quietly stopped passing
   * `lexicalQuery` to the backend, and every test in both files would still be
   * green while retrieval silently reverted to user-text-only on both legs.
   * That is exactly the failure mode P-046 exists to catch — "every existing
   * test asserts on what retrieval RETURNS, none on what it ASKS".
   *
   * Note what is asserted about the COSINE query: it stays byte-identical to
   * the human's words. Under P-044 that is the design, not the bug (D-041
   * measured identifiers diluting that vector), so the divergence P-046 wants
   * lives on the lexical leg.
   */
  it('ISSUES the signal-bearing query to the lexical leg — not just composes it', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: {
        userText: 'continue where you left off',
        agentSignals: {
          workItem: { id: 'WI-6512' },
          trajectory: { paths: ['apps/operator-vite/src/components/HistoryDropdown.tsx'] },
        },
      },
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    const [query, opts] = backend.search.mock.calls[0]! as [string, { lexicalQuery?: string }];
    expect(query).toBe('continue where you left off');
    expect(opts.lexicalQuery).toBe('continue where you left off WI-6512 HistoryDropdown');
    expect(opts.lexicalQuery).not.toBe(query);
  });

  it('omits lexicalQuery entirely with no signals, so both legs share one query', async () => {
    // The no-signals turn must stay byte-identical to pre-P-044 — that is what
    // keeps the P-041 baseline comparable across the change.
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    expect(backend.search.mock.calls[0]![1]).not.toHaveProperty('lexicalQuery');
  });

  // The floor is NOT the fix for the saturation bug and must not be quietly
  // retuned as if it were: the saturating hits never came through the cosine leg
  // (D-008), so moving the floor changes which cosine hits survive, not how many
  // results come back.
  //
  // ⚠ Asserted against the EXPORTED constant, never a copied literal. This test
  // used to hard-code 0.45 and was stranded the moment D-058 recalibrated the
  // floor to 0.58 — the exact "copied magic number" failure the export exists to
  // prevent (see MEMORY_INJECTION_COSINE_FLOOR's doc-comment). What this pins is
  // the WIRING — that the push path forwards the calibrated floor to the backend
  // unchanged — which still fails loudly if minScore goes missing, gets swapped
  // for the lexical bar, or is hardcoded in the request path. The VALUE itself is
  // governed by the calibration sweep + D-058, not by this assertion.
  it('forwards the calibrated cosine floor unchanged — the mode is the fix, not the floor', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    expect(optsOf(backend, 0).minScore).toBe(MEMORY_INJECTION_COSINE_FLOOR);
  });

  // F-D (P-034, D-014). Only the REQUEST is asserted here, for the same reason
  // the header gives for fusionMode: the re-rank itself is the backend's, and
  // asserting its effect against this file's fake would prove only that the fake
  // ignores the option. The behavior is pinned in hybrid-backend.test.ts.
  it('requests the diversity re-rank — nothing else in the chain penalizes redundancy', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'], hiveSlugs: [],
    });
    expect(diversifyOf(backend, 0)).toEqual({ lambda: 0.7 });
  });

  it('PAPERCUSP_MEMORY_DIVERSITY_LAMBDA=1 omits the option entirely — λ=1 is a no-op, so do not pay for it', async () => {
    const prev = process.env.PAPERCUSP_MEMORY_DIVERSITY_LAMBDA;
    process.env.PAPERCUSP_MEMORY_DIVERSITY_LAMBDA = '1';
    try {
      const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
      useBackend(backend);
      await buildMemoryContextBlock({
        userId: 'u1', workspaceId: 'ws', queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'], hiveSlugs: [],
      });
      expect(diversifyOf(backend, 0)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_DIVERSITY_LAMBDA;
      else process.env.PAPERCUSP_MEMORY_DIVERSITY_LAMBDA = prev;
    }
  });

  it('returns null when the pools come back empty — a zero-hit turn injects NOTHING', async () => {
    useBackend(mockBackend([]));
    const block = await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'a query nothing is relevant to',
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    expect(block).toBeNull();
  });

  it('honours the PAPERCUSP_MEMORY_FUSION_MODE revert switch', async () => {
    const prev = process.env.PAPERCUSP_MEMORY_FUSION_MODE;
    process.env.PAPERCUSP_MEMORY_FUSION_MODE = 'floored-union';
    try {
      const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
      useBackend(backend);
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        hiveSlugs: [],
      });
      expect(optsOf(backend, 0).fusionMode).toBe('floored-union');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_FUSION_MODE;
      else process.env.PAPERCUSP_MEMORY_FUSION_MODE = prev;
    }
  });
});

/**
 * context-injection-audit-2026-07-28 P-033 (F-C / D-011) — the NO-QUOTA guard.
 *
 * The pools were budgeted INVERSELY to where knowledge lives: 6 slots to the
 * 487-memory CROSS-PROJECT personal pool, 3 to the 770-memory on-topic harness
 * pool. F-C deletes the per-pool reservations rather than retuning them (P-033
 * explicitly forbids simply raising the harness quota).
 *
 * The reason this had to become ONE search is subtle and worth pinning, because
 * a future change could "simplify" it back into three calls and silently
 * reintroduce the quota: the score handed back is RRF, a function of rank WITHIN
 * ONE CALL. Across separate calls two pools' rank-1 hits score identically, so
 * there is nothing sound to allocate on and any cross-pool ordering degenerates
 * into a fixed priority — a quota by another name.
 */
describe('pool budgets are a single shared ceiling, not per-pool quotas (P-033 / F-C)', () => {
  it('issues ONE search over the union of scopes, not one per pool', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'q',
      harnessSlugs: ['papercusp', 'other'],
      hiveSlugs: ['hivey'],
    });
    expect(backend.search).toHaveBeenCalledTimes(1);
    const opts = backend.search.mock.calls[0]![1] as { scope: string[]; limit: number };
    expect(opts.scope).toEqual(['u1', 'harness:papercusp', 'harness:other', 'hive:hivey']);
    // ONE ceiling for all of them — not 6 + 3 + 3 spent per pool.
    expect(opts.limit).toBe(12);
  });

  it('lets a SINGLE pool fill the whole block — no pool holds a reservation', async () => {
    // Only the harness pool returns anything. Under the old quotas it could
    // never exceed 3 however relevant its hits were; now it competes for all 12.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `h${i}`,
      text: `harness fact number ${i} about the deploy pipeline`,
      kind: 'reference',
    }));
    const backend = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async (_q: string, opts: { scope: string | readonly string[] }) => {
        const scopes = typeof opts.scope === 'string' ? [opts.scope] : [...opts.scope];
        return scopes.flatMap((scope) =>
          scope.startsWith('harness:') ? rows.map((r) => ({ ...r, scope })) : [],
        );
      }),
    };
    useBackend(backend as unknown as ReturnType<typeof mockBackend>);
    const block = await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'deploy pipeline',
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    // All 8 render: the old PER_HARNESS_LIMIT=3 would have capped this at 3.
    for (let i = 0; i < 8; i++) expect(block).toContain(`harness fact number ${i}`);
  });

  it('renders in the backend RELEVANCE order, not in pool order', async () => {
    // The backend returns one ranked list; the harness hit outranks the user
    // hit. Pre-F-C the render was strictly user-then-harness, so the user hit
    // would lead regardless of rank — and since the char budget truncates in
    // render order, that ordering WAS the real allocator.
    const backend = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async () => [
        { id: 'r1', text: 'the most relevant fact', kind: 'reference', scope: 'harness:papercusp' },
        { id: 'r2', text: 'a less relevant personal note', kind: 'preference', scope: 'u1' },
      ]),
    };
    useBackend(backend as unknown as ReturnType<typeof mockBackend>);
    const block = await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'q',
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    expect(block!.indexOf('the most relevant fact')).toBeLessThan(
      block!.indexOf('a less relevant personal note'),
    );
  });

  it('still yields hive-PACK rows last, whatever their rank (preserved trust tier)', async () => {
    // The one exception F-C keeps: packs are the most numerous and least
    // turn-specific, so they lose the budget race even when they rank first.
    const backend = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async () => [
        {
          id: 'p1',
          text: 'a seeded pack learning',
          kind: 'reference',
          scope: 'hive:hivey',
          metadata: { source: 'pack', pack_id: 'pk1' },
        },
        { id: 'o1', text: 'an organic harness fact', kind: 'reference', scope: 'harness:papercusp' },
      ]),
    };
    useBackend(backend as unknown as ReturnType<typeof mockBackend>);
    const block = await buildMemoryContextBlock({
      userId: null,
      workspaceId: 'ws',
      queryContext: 'q',
      harnessSlugs: ['papercusp'],
      hiveSlugs: ['hivey'],
    });
    expect(block!.indexOf('an organic harness fact')).toBeLessThan(
      block!.indexOf('a seeded pack learning'),
    );
  });

  it('treats input.limit as the TOTAL ceiling across pools, not the user pool alone', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'q',
      harnessSlugs: ['papercusp'],
      hiveSlugs: ['hivey'],
      limit: 3,
    });
    expect(
      (backend.search.mock.calls[0]![1] as { scope: string[]; limit: number }).limit,
    ).toBe(3);
  });
});

/**
 * context-injection-audit-2026-07-28 P-026 — the WIRING guard.
 *
 * recall-stats.ts can grow the richest per-pool schema in the world and it
 * changes nothing if the push path keeps calling it with a flat `entries` list:
 * the column stays NULL in production and the measurement every other fix in
 * that plan is judged by silently does not exist. This block fails if the call
 * site regresses to a flat record — the failure that is invisible in staging,
 * because a flat write succeeds just as quietly as a per-pool one.
 */
describe('push-path recall telemetry is recorded PER POOL (P-026)', () => {
  /** Flush the fire-and-forget telemetry task (dynamic import + insert). */
  // Let the FIRE-AND-FORGET telemetry write land. It is `void`-ed on purpose, so
  // there is nothing to await — the test has to yield until it completes.
  //
  // ⚠ MACROTASK turns, not `Promise.resolve()` microtasks. The writer does
  // `await import('./recall-stats')`, and a dynamic import does not settle by
  // spinning the microtask queue however many times you spin it. The old
  // 5-microtask version passed only because the write was START­ED early in
  // buildMemoryContextBlock and had the whole filter chain's awaits to resolve
  // in — i.e. it was coupled to WHERE the call sat in the function, not to the
  // work it does. P-002 moved that write into a `finally` (so every exit path
  // records exactly one row) and the coupling surfaced as 7 failures that look
  // like assertion breaks and are really a hidden timing dependency.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('passes a per-pool breakdown, never a flat entries list', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    await flush();

    expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
    const input = recordRecallStatsMock.mock.calls[0]![1] as {
      pools?: Record<string, { entries: unknown[]; limit: number; scopes: string[] }>;
      entries?: unknown[];
    };
    // The collapse must not come back.
    expect(input.entries).toBeUndefined();
    expect(input.pools).toBeDefined();
    expect(Object.keys(input.pools!).sort()).toEqual(['harness', 'hive', 'user']);
  });

  it('stamps each pool with the budget and the SCOPE KEYS it actually queried', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      hiveSlugs: ['hivey'],
      limit: 6,
    });
    await flush();

    const { pools } = recordRecallStatsMock.mock.calls[0]![1] as {
      pools: Record<string, { entries: unknown[]; limit: number; scopes: string[] }>;
    };
    expect(pools.user).toMatchObject({ limit: 6, scopes: ['u1'] });
    // The gate-2 detector: the harness pool records the slug it was keyed on,
    // so a pool queried under a slug nothing writes to is identifiable later.
    expect(pools.harness!.scopes).toEqual(['harness:papercusp']);
    expect(pools.hive!.scopes).toEqual(['hive:hivey']);
  });

  it('records a pool that returned ZERO — the row a flat hit_count could not express', async () => {
    // Backend returns rows for the user scope only; harness/hive come back empty.
    const backend = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async (_q: string, opts: { scope: string | readonly string[] }) => {
        const scope = typeof opts.scope === 'string' ? opts.scope : opts.scope[0]!;
        return scope.startsWith('harness:') || scope.startsWith('hive:')
          ? []
          : [{ id: 'u-only', text: 'personal', scope }];
      }),
    };
    useBackend(backend as unknown as ReturnType<typeof mockBackend>);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    await flush();

    const { pools } = recordRecallStatsMock.mock.calls[0]![1] as {
      pools: Record<string, { entries: unknown[]; scopes: string[] }>;
    };
    expect(pools.user!.entries).toHaveLength(1);
    expect(pools.harness!.entries).toHaveLength(0);
    expect(pools.harness!.scopes).toEqual(['harness:papercusp']);
  });

  it('stamps workspace and pot so the telemetry is sliceable (dead since migration 290)', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws-42',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    await flush();
    expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
      workspaceId: 'ws-42',
      potSlug: 'papercusp',
    });
  });

  /**
   * P-002 / migration 758 — the ADMISSION FUNNEL.
   *
   * The row is assembled from what the INDEX returned, and six filter stages sit
   * between that and what the agent receives. Before this, nothing recorded the
   * delivered end at all, so "12 hits" and "delivered 2 lines" were the same row.
   */
  describe('records the admission funnel, not just what the index returned', () => {
    it('separates what came back from what was DELIVERED, and says where the rest went', async () => {
      // Three distinct entries, a budget that fits roughly one line.
      useBackend(
        mockBackend([
          { id: 'm1', text: 'alpha alpha alpha alpha alpha alpha alpha alpha' },
          { id: 'm2', text: 'bravo bravo bravo bravo bravo bravo bravo bravo' },
          { id: 'm3', text: 'charlie charlie charlie charlie charlie charlie' },
        ]),
      );
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        hiveSlugs: [],
        budgetChars: 60,
      });
      await flush();

      const { admission } = recordRecallStatsMock.mock.calls[0]![1] as {
        admission: { returned: number; admitted: number; truncated: boolean; dropped: Record<string, number> };
      };
      // The whole point: returned and admitted DIVERGE...
      expect(admission.returned).toBeGreaterThan(0);
      expect(admission.admitted).toBeLessThan(admission.returned);
      expect(admission.truncated).toBe(true);
      expect(admission.dropped.budget).toBeGreaterThan(0);
      // ...and the funnel ACCOUNTS FOR THE GAP — every returned row is either
      // admitted or attributed to the stage that dropped it. This is the
      // invariant, not any particular count: a stage added later that forgets to
      // record its drops breaks this sum, which is exactly when we want to know.
      const totalDropped = Object.values(admission.dropped).reduce((a, b) => a + b, 0);
      expect(admission.admitted + totalDropped).toBe(admission.returned);
    });

    it('records EVERY stage even at zero — a filter that ran and removed nothing is not a filter that never ran', async () => {
      useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        hiveSlugs: [],
      });
      await flush();
      const { admission } = recordRecallStatsMock.mock.calls[0]![1] as {
        admission: { dropped: Record<string, number>; admitted: number };
      };
      expect(Object.keys(admission.dropped).sort()).toEqual([
        'budget',
        'dedup',
        'feedback',
        'nearDuplicate',
        'pack',
        'workspace',
      ]);
      expect(admission.admitted).toBe(1);
    });

    it('attributes ADMITTED lines to the leg that produced them', async () => {
      // Provenance rides on the entry (stamped by fuse()); the funnel counts it
      // over the DELIVERED set, which is the only set that says a leg is earning
      // its place rather than merely offering candidates.
      useBackend(
        mockBackend([
          { id: 'm1', text: 'alpha', retrieval: { cosineRank: 1 } },
          { id: 'm2', text: 'bravo', retrieval: { cosineRank: 2, lexicalRank: 1 } },
          { id: 'm3', text: 'charlie', retrieval: { lexicalRank: 2 } },
        ] as never),
      );
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        hiveSlugs: [],
      });
      await flush();
      const { admission } = recordRecallStatsMock.mock.calls[0]![1] as {
        admission: { byLeg: Record<string, number> };
      };
      expect(admission.byLeg).toEqual({ cosineOnly: 1, lexicalOnly: 1, both: 1 });
    });

    it('still writes a row when the block is EMPTY — the zero-hit rate is the signal', async () => {
      // The write moved into a `finally` precisely so the several early-return
      // paths keep recording. A recall that delivers nothing is the single most
      // important row in this table; dropping it would make the index look
      // healthiest exactly when it is worst.
      useBackend(mockBackend([]));
      const block = await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        hiveSlugs: [],
      });
      await flush();
      expect(block).toBeNull();
      expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
      expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
        admission: { returned: 0, admitted: 0 },
      });
    });

    it('writes EXACTLY ONE row per recall', async () => {
      useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        hiveSlugs: [],
      });
      await flush();
      expect(recordRecallStatsMock).toHaveBeenCalledTimes(1);
    });

    it('keeps hit_count/pools meaning WHAT THE INDEX RETURNED, not what survived', async () => {
      // Recurrence guard for the trap the deferred write created: the three pool
      // variables are REASSIGNED by the filters, so reading them live at write
      // time would silently redefine three existing columns — changing every
      // historical comparison without touching a query. Budget-drop two of three
      // and assert the pools still report all three.
      useBackend(
        mockBackend([
          { id: 'm1', text: 'alpha alpha alpha alpha alpha alpha alpha alpha' },
          { id: 'm2', text: 'bravo bravo bravo bravo bravo bravo bravo bravo' },
          { id: 'm3', text: 'charlie charlie charlie charlie charlie charlie' },
        ]),
      );
      await buildMemoryContextBlock({
        userId: 'u1',
        workspaceId: 'ws',
        queryContext: 'why is the recall empty',
        harnessSlugs: ['papercusp'],
        hiveSlugs: [],
        budgetChars: 60,
      });
      await flush();
      const input = recordRecallStatsMock.mock.calls[0]![1] as {
        pools: Record<string, { entries: unknown[] }>;
        admission: { admitted: number };
      };
      const pooled =
        input.pools.user!.entries.length +
        input.pools.harness!.entries.length +
        input.pools.hive!.entries.length;
      // `pools` is the PRE-filter view and must agree with the funnel's
      // `returned`, never with `admitted`.
      expect(pooled).toBe(input.admission.returned);
      expect(input.admission.admitted).toBeLessThan(pooled);
    });
  });
});

/**
 * context-injection-audit-2026-07-28 P-042 (F-J) — the structured query seam,
 * asserted END-TO-END through buildMemoryContextBlock.
 *
 * recall-query.test.ts pins the helpers in isolation; this pins that injection.ts
 * actually ROUTES both forms through them. That distinction matters here: the
 * three readers of `queryContext` (the emptiness gate, the backend search, and
 * the P-041 telemetry) were separate `input.queryContext` reads before P-042, and
 * the failure mode of a partial migration is that ONE of them keeps reading the
 * raw union — which typechecks against `string | RecallQuery` in some positions
 * and silently stringifies an object into "[object Object]" in others.
 */
describe('the injection seam accepts a structured recall query (P-042 / F-J)', () => {
  // Let the FIRE-AND-FORGET telemetry write land. It is `void`-ed on purpose, so
  // there is nothing to await — the test has to yield until it completes.
  //
  // ⚠ MACROTASK turns, not `Promise.resolve()` microtasks. The writer does
  // `await import('./recall-stats')`, and a dynamic import does not settle by
  // spinning the microtask queue however many times you spin it. The old
  // 5-microtask version passed only because the write was START­ED early in
  // buildMemoryContextBlock and had the whole filter chain's awaits to resolve
  // in — i.e. it was coupled to WHERE the call sat in the function, not to the
  // work it does. P-002 moved that write into a `finally` (so every exit path
  // records exactly one row) and the coupling surfaced as 7 failures that look
  // like assertion breaks and are really a hidden timing dependency.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('issues the SAME index query for a string and its structured equivalent', async () => {
    const asString = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(asString);
    await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'why is the recall empty',
    });

    const asObject = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(asObject);
    await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: { userText: 'why is the recall empty' },
    });

    expect(asObject.search.mock.calls[0]![0]).toBe('why is the recall empty');
    expect(asObject.search.mock.calls[0]![0]).toBe(asString.search.mock.calls[0]![0]);
  });

  // The "[object Object]" detector. Without it, a missed normalization at the
  // search call still passes every existing test — they all assert on OPTIONS and
  // on returned rows, and this file's fake backend ignores the query entirely.
  it('never stringifies the object form into the query', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: { userText: 'deploy pipeline' },
    });
    expect(backend.search.mock.calls[0]![0]).not.toContain('[object Object]');
  });

  /**
   * ⚠ TRIPWIRE — the same one recall-query.test.ts carries, at the level that
   * actually matters (what the backend is asked). P-044 is what makes signals
   * reach retrieval; until then this failing means the baseline is at risk.
   */
  it('carries agent signals WITHOUT letting them reach the index (P-043/P-044 do that)', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: {
        userText: 'continue',
        agentSignals: {
          workItem: { id: 'WI-6635', title: 'Instrument the QUERY', body: 'record query shape' },
          trajectory: { paths: ['lib/memory/recall-stats.ts'], symbols: ['describeRecallQuery'] },
          activeFile: 'lib/memory/injection.ts',
        },
      },
    });
    expect(backend.search.mock.calls[0]![0]).toBe('continue');
  });

  it('records the EFFECTIVE retrieval text in the P-041 query telemetry', async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      harnessSlugs: ['papercusp'],
      queryContext: {
        userText: 'why is the recall empty',
        agentSignals: { workItem: { id: 'WI-6635' } },
      },
    });
    await flush();
    // Not the object, not "[object Object]", and — until P-044 — not the signals.
    expect(recordRecallStatsMock.mock.calls[0]![1]).toMatchObject({
      query: 'why is the recall empty',
    });
  });

  it('returns null for an empty structured query, exactly as for an empty string', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    for (const queryContext of ['', '   ', { userText: '' }, { userText: '   ' }]) {
      expect(
        await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext }),
      ).toBeNull();
    }
    // The gate short-circuits before the backend is ever consulted.
    expect(backend.search).not.toHaveBeenCalled();
  });
});

describe('lastUserContext', () => {
  it('returns empty string for no user messages', () => {
    expect(lastUserContext([])).toBe('');
    expect(lastUserContext([{ role: 'assistant', content: 'hi' }])).toBe('');
  });

  it('joins last N user-turn contents', () => {
    const out = lastUserContext([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'user', content: 'four' },
    ], 3);
    expect(out).toBe('two\nthree\nfour');
  });
});

describe('buildMemoryContextBlock', () => {
  it('returns null when query context is empty', async () => {
    useBackend(mockBackend([]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: '' });
    expect(block).toBeNull();
  });

  it('returns null when the backend is unavailable', async () => {
    useBackend(mockBackend([], { ok: false, reason: 'mem0_unavailable' }));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('returns null when the availability probe throws', async () => {
    const b = mockBackend([]);
    b.available = vi.fn(async () => { throw new Error('boom'); });
    useBackend(b);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('returns null when search throws', async () => {
    const b = mockBackend([]);
    b.search = vi.fn(async () => { throw new Error('pg down'); });
    useBackend(b);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('returns null when no hits', async () => {
    useBackend(mockBackend([]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('formats user hits with their kind', async () => {
    useBackend(mockBackend([
      { id: 'i1', text: 'User prefers terse replies', kind: 'preference' },
      { id: 'i2', text: 'User name is Aviyn', kind: 'identity' },
    ]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'who am i' });
    expect(block).toContain('## Operator memory (relevant entries)');
    expect(block).toContain('- [preference] (id=i1) User prefers terse replies');
    expect(block).toContain('- [identity] (id=i2) User name is Aviyn');
  });

  it('labels a harness-scoped hit with its slug', async () => {
    useBackend(mockBackend([
      { id: 'i3', text: 'Project uses PG by default', kind: 'project' },
    ]));
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['papercup'], queryContext: 'storage?',
    });
    expect(block).toContain('- [project @ papercup] (id=i3) Project uses PG by default');
  });

  it('falls back to unknown kind when the entry has none', async () => {
    useBackend(mockBackend([{ id: 'i4', text: 'Bare fact' }]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toContain('- [unknown] (id=i4) Bare fact');
  });

  it('respects custom heading', async () => {
    useBackend(mockBackend([{ id: 'i5', text: 'X', kind: 'project' }]));
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'x', heading: 'Brainstorm memory',
    });
    expect(block).toMatch(/^## Brainstorm memory/);
  });

  it('pulls user + harness scopes only — no deprecated workspace pull (D-005)', async () => {
    const b = mockBackend([{ id: 'i6', text: 'x', kind: 'preference' }]);
    useBackend(b);
    await buildMemoryContextBlock({
      userId: 'u-123', workspaceId: 'ws-7', harnessSlugs: ['papercup'], queryContext: 'foo',
    });
    // ONE search over the UNION of the pools (F-C / P-033, D-011) — never a
    // `workspace:*` scope. It carries the inject relevance floor
    // (injectMinScore()) + the hybrid push lexical bar (injectMinLexScore())
    // — the no-LLM-in-the-loop precision gate (P-031 / D-003) — and
    // fusionMode 'cosine-gated', which makes the limit a CEILING rather than a
    // target (P-032 / F-B, D-010). `limit` is now the TOTAL across all pools,
    // replacing the old per-pool quotas (user 6 + harness 3 + hive 3 = 12).
    // …and `diversify` (P-034 / F-D, D-014): the redundancy penalty this chain
    // otherwise has nowhere — every other pass ranks on relevance alone.
    expect(b.search.mock.calls).toEqual([
      [
        'foo',
        {
          scope: ['u-123', 'harness:papercup'],
          limit: 12,
          minScore: MEMORY_INJECTION_COSINE_FLOOR,
          minLexScore: MEMORY_INJECTION_LEX_FLOOR,
          fusionMode: 'cosine-gated',
          diversify: { lambda: 0.7 },
          // P-002: the leg-provenance reporting seam. Asserted as a FUNCTION
          // rather than dropped from the shape — this stays an exact-shape
          // assertion, so an option added here in future still has to be
          // declared deliberately instead of slipping in unnoticed.
          onLegStats: expect.any(Function),
        },
      ],
    ]);
  });

  it('filters ephemeral/benchmark harness slugs from the fan-out (P-016)', async () => {
    const b = mockBackend([{ id: 'i7', text: 'real fact', kind: 'reference' }]);
    useBackend(b);
    // Mix of production and ephemeral slugs; only papercup should survive.
    await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws',
      harnessSlugs: ['papercup', 'hiveloop-hive', 'xbq72ugvazs', 'bench-memcap-probe-DELETEME'],
      queryContext: 'storage?',
    });
    const scopes = b.search.mock.calls.map((c: unknown[]) => (c[1] as { scope: unknown }).scope);
    expect(scopes).toEqual([['harness:papercup']]);
  });

  it('dedups a memory surfaced within the watermark window (D-006)', async () => {
    const stale = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const fresh = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    useBackend(mockBackend([
      { id: stale, text: 'stale fact', kind: 'preference' },
      { id: fresh, text: 'fresh fact', kind: 'preference' },
    ]));
    // `stale` was surfaced recently → the guard must drop it; `fresh` stays.
    sqlRows = [{ id: stale }];
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
    expect(block).toContain('fresh fact');
    expect(block).not.toContain('stale fact');
  });

  it('returns null when every hit was recently surfaced', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    useBackend(mockBackend([
      { id, text: 'only fact', kind: 'preference' },
    ]));
    sqlRows = [{ id }];
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
    expect(block).toBeNull();
  });

  it('pulls + labels the hive pool for a member harness (knowledge-packs P-004)', async () => {
    registryProjects = [
      { slug: 'member-a', hive_slug: 'my-hive' },
      { slug: 'my-hive', harness_kind: 'hive' },
    ];
    // The harness pool and hive pool are DISTINCT stores with distinct content — return
    // per-scope facts (the flat mockBackend returns identical rows for every scope, which the
    // P-008 near-duplicate collapse would correctly fold, hiding the hive label under test).
    const b = {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async (_q: string, opts: { scope: string | readonly string[] }) => {
        const scopes = typeof opts.scope === 'string' ? [opts.scope] : [...opts.scope];
        return scopes.map((scope) =>
          scope.startsWith('hive:')
            ? { id: 'h1', text: 'Hive convention: tests ship with the feature', kind: 'feedback', scope }
            : { id: 'a1', text: 'Harness note: run npm test before pushing', kind: 'feedback', scope },
        );
      }),
    };
    useBackend(b as unknown as ReturnType<typeof mockBackend>);
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['member-a'], queryContext: 'testing?',
    });
    // ONE pull over both pools — the hive scope is resolved from the registry
    // and joins the same multi-scope search (F-C / D-011).
    expect(b.search.mock.calls).toEqual([
      [
        'testing?',
        {
          scope: ['harness:member-a', 'hive:my-hive'],
          limit: 12,
          minScore: MEMORY_INJECTION_COSINE_FLOOR,
          minLexScore: MEMORY_INJECTION_LEX_FLOOR,
          fusionMode: 'cosine-gated',
          diversify: { lambda: 0.7 },
          // P-002: the leg-provenance reporting seam. Asserted as a FUNCTION
          // rather than dropped from the shape — this stays an exact-shape
          // assertion, so an option added here in future still has to be
          // declared deliberately instead of slipping in unnoticed.
          onLegStats: expect.any(Function),
        },
      ],
    ]);
    expect(block).toContain('- [feedback @ hive:my-hive] (id=h1) Hive convention: tests ship with the feature');
    expect(block).toContain('- [feedback @ member-a] (id=a1) Harness note: run npm test before pushing');
  });

  it('P-008: collapses near-duplicate memories (same fact under different ids) before the budget', async () => {
    const dupText = 'owner directive: put yourself on auto mode and continue the full plan';
    useBackend(mockBackend([
      { id: 'd1', text: dupText, kind: 'preference' },
      { id: 'd2', text: dupText, kind: 'preference' }, // same fact, DIFFERENT id — the WI-4538 case
      { id: 'd3', text: 'a distinct fact about migration 557 renaming hive tables to pots', kind: 'reference' },
    ]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'directives?' });
    expect(block).not.toBeNull();
    // The highest-ranked copy survives; the duplicate id is dropped; the distinct fact is kept
    // (not crowded out — the collapse runs before the budget).
    expect(block).toContain('(id=d1)');
    expect(block).not.toContain('(id=d2)');
    expect(block).toContain('(id=d3)');
  });

  it('budget: hive-pack rows yield first under the cap; truncation is announced; only injected ids get watermarked (P-011)', async () => {
    const prev = process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS;
    process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS = '120';
    try {
      const organic = { id: 'org-1', text: 'this project tests via make test', kind: 'reference' };
      const packed = {
        id: 'pk-1',
        text: 'Tests ship with the feature — a long seeded learning body that will not fit the tiny budget'.repeat(2),
        kind: 'feedback',
        metadata: { source: 'pack', pack_id: 'coding' },
      };
      useBackend(mockBackend([organic, packed]));
      const block = await buildMemoryContextBlock({
        userId: null, workspaceId: 'ws', hiveSlugs: ['h'], queryContext: 'testing?',
      });
      expect(block).toContain('make test'); // organic admitted first
      expect(block).not.toContain('Tests ship with the feature'); // pack row dropped by the cap
      expect(block).toContain('memory budget is full'); // truncation announced honestly
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS;
      else process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS = prev;
    }
  });

  it('explicit hiveSlugs: [] suppresses the hive pull; explicit slugs skip resolution', async () => {
    registryProjects = [{ slug: 'member-a', hive_slug: 'my-hive' }];
    const suppressed = mockBackend([{ id: 'x', text: 'x', kind: 'project' }]);
    useBackend(suppressed);
    await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['member-a'], hiveSlugs: [], queryContext: 'q',
    });
    expect(suppressed.search.mock.calls.map((c) => c[1].scope)).toEqual([['harness:member-a']]);

    const pinned = mockBackend([{ id: 'y', text: 'y', kind: 'feedback' }]);
    useBackend(pinned);
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', hiveSlugs: ['other-hive'], queryContext: 'q',
    });
    expect(pinned.search.mock.calls.map((c) => c[1].scope)).toEqual([['hive:other-hive']]);
    expect(block).toContain('@ hive:other-hive');
  });

  describe('two-tier markers (self-learning-frontier P-022 / FB-08, D-006)', () => {
    const rows = [
      { id: 'p1', text: 'A probationary lesson', kind: 'project', metadata: { tier: 'probationary' } },
      { id: 'v1', text: 'A validated fact', kind: 'project' },
    ] as never[];
    const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_TRANSFER_HARNESS';

    it('flag dark ⇒ byte-identical output, no markers', async () => {
      // TRANSFER_HARNESS graduated to default-ON (flip-dark-flags-default-on-2026-06-23), so this
      // off-path test pins the flag OFF explicitly rather than relying on the (now-ON) default.
      process.env[FLAG_ENV] = '0';
      try {
        useBackend(mockBackend(rows));
        const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
        expect(block).toContain('- [project] (id=p1) A probationary lesson');
        expect(block).not.toContain('probationary]');
      } finally {
        delete process.env[FLAG_ENV];
      }
    });

    it('flag armed ⇒ probationary entries are marked, still injected (admission is free)', async () => {
      process.env[FLAG_ENV] = '1';
      try {
        useBackend(mockBackend(rows));
        const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
        expect(block).toContain('- [project · probationary] (id=p1) A probationary lesson');
        expect(block).toContain('- [project] (id=v1) A validated fact'); // legacy grandfathered
      } finally {
        delete process.env[FLAG_ENV];
      }
    });
  });
});

/**
 * context-injection-retrieval-reach-and-visibility-2026-08-03 P-001 —
 * `embedderAvailable` reaches the injection path instead of being dropped.
 *
 * `recallCorpusContext` has always computed it (corpus-recall-io.ts) and
 * `startCorpusLeg` has always thrown it away, which left injection unable to
 * separate two cases that must never be read the same way: "semantic ran and
 * these are its best matches" versus "semantic was absent and these are
 * lexical scraps". The second is not a weaker version of the first — it is a
 * different retrieval, and acting on it as though the semantic half had run is
 * the failure this item exists to make visible.
 *
 * What is deliberately NOT asserted here: any change to the RENDERED block. A
 * degraded leg still renders byte-identically today — marking or suppressing
 * the section is P-003's job, gated on the very signal P-001 delivers. Pinning
 * the rendering as unchanged is therefore a real guard, not an omission.
 */
describe('corpus leg carries its own retrieval health (P-001)', () => {
  const oneLine = (over: Partial<CorpusIoStub> = {}): CorpusIoStub => ({
    block: null,
    lines: [{ line: '- [work-item WI-6512] a pointer', handle: { ref: 'work-item:WI-6512' } }],
    dropped: [],
    embedderAvailable: true,
    candidateCount: 4,
    ...over,
  });

  const run = async () => {
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    return await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why did the corpus leg return that',
    });
  };

  it('hands the corpus leg the caller’s OWNER id, so its self-echo filter can fire', async () => {
    // EI-19460887729945170 — the wiring regression that shipped. This value has
    // always been the per-agent coord ownerId (`su-xxxx…`; claim-port.ts:47),
    // but it used to be passed as `excludeSessionId` and compared against hits'
    // NATIVE transcript uuids — two identity spaces, never equal — so the
    // self-session filter never fired once in production. Asserting the FIELD,
    // not just the value, is the point: a rename back would restore the bug
    // silently, with every other test still green.
    corpusIoResult = oneLine({ embedderAvailable: true });
    useBackend(mockBackend([{ id: 'm1', text: 'alpha' }]));
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why did the corpus leg return that',
      session: { sessionId: 'su-be34c423', port: 'mid-turn' },
    });
    const passed = recallCorpusContext.mock.calls.at(-1)?.[0] ?? {};
    expect(passed).toMatchObject({ excludeOwnerId: 'su-be34c423' });
    expect(passed).not.toHaveProperty('excludeSessionId');
  });

  it('WARNS when the leg ran BM25-only, and throttles the re-warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = oneLine({ embedderAvailable: false });
      await run();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('BM25-ONLY');
      expect(warn.mock.calls[0]![0]).toContain('candidates=4 admitted=1');

      // Second degraded injection inside the window: counted, not re-printed.
      // A one-shot warn is how a persistent embedder outage goes quiet.
      await run();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when the semantic half actually ran', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = oneLine({ embedderAvailable: true });
      await run();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * THE REGRESSION THIS ITEM IS REALLY ABOUT. Pre-P-001 the leg returned a bare
   * `null` when nothing was admitted, so an empty pointer section and a leg
   * that never ran were indistinguishable — and the one fact that explains the
   * emptiness (was semantic even reachable?) was destroyed at exactly the
   * moment it mattered most.
   */
  it('a leg that RAN and admitted nothing still reports HOW it ran', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = oneLine({ lines: [], embedderAvailable: false, candidateCount: 7 });
      const block = await run();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('candidates=7 admitted=0');
      // Retrieval found 7 and selection rejected all of them — the block is
      // unchanged, which is why the log line is the only place this is visible.
      expect(block).not.toContain(CORPUS_BLOCK_HEADING);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when the leg never ran at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = null; // the stub throws ⇒ startCorpusLeg degrades to null
      await run();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('renders the pointer section identically whether or not the embedder ran', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      corpusIoResult = oneLine({ embedderAvailable: true });
      const healthy = await run();
      _resetCorpusLegHealthForTests();
      corpusIoResult = oneLine({ embedderAvailable: false });
      const degraded = await run();
      expect(degraded).toBe(healthy);
      expect(healthy).toContain(CORPUS_BLOCK_HEADING);
      expect(healthy).toContain('- [work-item WI-6512] a pointer');
    } finally {
      warn.mockRestore();
    }
  });
});
