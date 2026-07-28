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

// The harness registry backs the member→hive resolution (knowledge-packs
// P-004). Canned per-test via `registryProjects`; default empty ⇒ no hive pull.
let registryProjects: Array<{ slug: string; harness_kind?: string; hive_slug?: string }> = [];
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: registryProjects })),
}));

import { buildMemoryContextBlock, lastUserContext } from './injection';
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
  _resetForTests();
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

  // The floor is NOT the fix and must not be quietly retuned as if it were: the
  // saturating hits never came through the cosine leg (D-008), so moving 0.45
  // changes which cosine hits survive, not how many results come back.
  it('still passes the 0.45 cosine floor unchanged — the mode is the fix, not the floor', async () => {
    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);
    useBackend(backend);
    await buildMemoryContextBlock({
      userId: 'u1',
      workspaceId: 'ws',
      queryContext: 'why is the recall empty',
      harnessSlugs: ['papercusp'],
      hiveSlugs: [],
    });
    expect(optsOf(backend, 0).minScore).toBe(0.45);
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
    expect((backend.search.mock.calls[0]![1] as { limit: number }).limit).toBe(3);
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
  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

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
    // (injectMinScore() 0.45) + the hybrid push lexical bar (injectMinLexScore()
    // 0.40) — the no-LLM-in-the-loop precision gate (P-031 / D-003) — and
    // fusionMode 'cosine-gated', which makes the limit a CEILING rather than a
    // target (P-032 / F-B, D-010). `limit` is now the TOTAL across all pools,
    // replacing the old per-pool quotas (user 6 + harness 3 + hive 3 = 12).
    expect(b.search.mock.calls).toEqual([
      [
        'foo',
        {
          scope: ['u-123', 'harness:papercup'],
          limit: 12,
          minScore: 0.45,
          minLexScore: 0.4,
          fusionMode: 'cosine-gated',
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
          minScore: 0.45,
          minLexScore: 0.4,
          fusionMode: 'cosine-gated',
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
        metadata: { source: 'pack', pack_id: 'papercusp-default' },
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
