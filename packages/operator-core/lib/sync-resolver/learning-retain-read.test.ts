/**
 * learning-retain-read tests (WI-5412 → WI-39493 Variant D) — the unified
 * Retained-ledger feed (keyset windows, k-way merge, server-side shipped
 * classification), the slim extras strip, and the insight-doc fs legs.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  countInsightDocs,
  parseInsightFrontmatter,
  readInsightDocsPage,
  readRetainDetail,
  readRetainExtras,
  readRetainFeed,
  readRetainPlanChildren,
  RETAIN_FEED_PAGE_SIZE,
  retainMemoryTitle,
  retainMemoryTsOf,
  stripFrontmatter,
  type RetainDetailDeps,
  type RetainExtrasDeps,
  type RetainFeedDeps,
} from './learning-retain-read';
import {
  compareRetainRows,
  decodeRetainCursor,
  encodeRetainCursor,
  inRetainLegWindow,
  retainLegWindowFor,
} from './learning-retain-types';

/** A postgres-tag stub: every sql`…` call resolves via the injected handler.
 *  Nested fragments (filter/window predicates) surface as VALUES, so routing
 *  keys on the STATIC template text only. */
function sqlStub(handler: (text: string, values: unknown[]) => unknown[]): never {
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(handler(strings.join('?'), values));
  return fn as never;
}

const isPlanLeg = (t: string) => t.includes('DISTINCT ON (hp.plan_slug)');
const isWiLeg = (t: string) => t.includes('DISTINCT ON (ei.issue_id)');
const isPlanCount = (t: string) => t.includes('count(DISTINCT hp.plan_slug)');
const isWiCount = (t: string) => t.includes('count(DISTINCT ei.issue_id)');

const extrasDeps: RetainExtrasDeps = {
  readLensWeights: async () => ({ analogical: 2, reframing: 1 }),
};

describe('readRetainExtras (slim strip: banked + lens weights)', () => {
  it('returns the banked counts and lens weights on the happy path', async () => {
    const sql = sqlStub(() => [{ n: 3 }]);
    const snap = await readRetainExtras(sql, 'ws-1', extrasDeps);
    expect(snap.banked).toEqual({ improvementsFiled7d: 3, plansDrafted7d: 3 });
    expect(snap.lensWeights).toEqual({ analogical: 2, reframing: 1 });
  });

  it('degrades each failing leg independently — never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub(() => {
      throw new Error('pg down');
    });
    const snap = await readRetainExtras(sql, 'ws-1', {
      readLensWeights: async () => {
        throw new Error('weights down');
      },
    });
    expect(snap.banked).toEqual({ improvementsFiled7d: null, plansDrafted7d: null });
    expect(snap.lensWeights).toBeNull();
    warn.mockRestore();
  });

  it('empty lens weights read as null (none recorded), not {}', async () => {
    const sql = sqlStub(() => [{ n: 0 }]);
    const snap = await readRetainExtras(sql, 'ws-1', { readLensWeights: async () => ({}) });
    expect(snap.lensWeights).toBeNull();
  });
});

describe('parseInsightFrontmatter', () => {
  it('extracts title + discovered', () => {
    const doc = parseInsightFrontmatter(
      'my-doc',
      '---\ntitle: The runbook title\ndescription: x\ndiscovered: 2026-06-14\n---\nbody',
    );
    expect(doc).toEqual({ slug: 'my-doc', title: 'The runbook title', discovered: '2026-06-14' });
  });

  it('falls back to the slug on a missing title, null on a missing date', () => {
    expect(parseInsightFrontmatter('slug-x', '---\nstatus: active\n---')).toEqual({
      slug: 'slug-x',
      title: 'slug-x',
      discovered: null,
    });
  });
});

// ─── Feed machinery: cursor + windows + comparator ───────────────────────────

describe('retain cursor + leg windows', () => {
  const cursor = { ts: '2026-08-15T12:00:00.000Z', kind: 'rubric' as const, id: 'r-mid' };

  it('cursor round-trips and rejects garbage', () => {
    expect(decodeRetainCursor(encodeRetainCursor(cursor))).toEqual(cursor);
    expect(decodeRetainCursor('not json')).toBeNull();
    expect(decodeRetainCursor(JSON.stringify({ ts: 1, kind: 'plan', id: 'x' }))).toBeNull();
    expect(decodeRetainCursor(JSON.stringify({ ts: 't', kind: 'nope', id: 'x' }))).toBeNull();
    expect(decodeRetainCursor(null)).toBeNull();
  });

  it('windows depend on the leg kind relative to the cursor kind (kind ASC at equal ts)', () => {
    // 'plan' < 'rubric': all its rows at the cursor ts were already emitted.
    expect(retainLegWindowFor('plan', cursor)).toEqual({
      beforeTs: cursor.ts,
      includeTies: false,
      tieIdAfter: null,
    });
    // 'runbook' > 'rubric': its rows AT the cursor ts are still to come.
    expect(retainLegWindowFor('runbook', cursor)).toEqual({
      beforeTs: cursor.ts,
      includeTies: true,
      tieIdAfter: null,
    });
    // same kind: ties resolved by id.
    expect(retainLegWindowFor('rubric', cursor)).toEqual({
      beforeTs: cursor.ts,
      includeTies: false,
      tieIdAfter: 'r-mid',
    });
    expect(retainLegWindowFor('plan', null)).toBeNull();
  });

  it('inRetainLegWindow evaluates the three window shapes', () => {
    const t0 = '2026-08-15T12:00:00.000Z';
    const earlier = '2026-08-15T11:59:59.999Z';
    const later = '2026-08-15T12:00:00.001Z';
    const strict = { beforeTs: t0, includeTies: false, tieIdAfter: null };
    const ties = { beforeTs: t0, includeTies: true, tieIdAfter: null };
    const sameKind = { beforeTs: t0, includeTies: false, tieIdAfter: 'm' };
    expect(inRetainLegWindow(earlier, 'a', strict)).toBe(true);
    expect(inRetainLegWindow(t0, 'a', strict)).toBe(false);
    expect(inRetainLegWindow(t0, 'a', ties)).toBe(true);
    expect(inRetainLegWindow(later, 'a', ties)).toBe(false);
    expect(inRetainLegWindow(t0, 'z', sameKind)).toBe(true);
    expect(inRetainLegWindow(t0, 'a', sameKind)).toBe(false);
    expect(inRetainLegWindow(later, 'z', null)).toBe(true);
  });

  it('compareRetainRows orders ts DESC, then kind ASC, then id ASC', () => {
    const rows = [
      { ts: '2026-08-14T00:00:00.000Z', kind: 'plan' as const, id: 'a' },
      { ts: '2026-08-15T00:00:00.000Z', kind: 'wi' as const, id: 'b' },
      { ts: '2026-08-15T00:00:00.000Z', kind: 'plan' as const, id: 'z' },
      { ts: '2026-08-15T00:00:00.000Z', kind: 'plan' as const, id: 'a' },
    ];
    const sorted = rows.slice().sort(compareRetainRows);
    expect(sorted.map((r) => `${r.kind}:${r.id}`)).toEqual(['plan:a', 'plan:z', 'wi:b', 'plan:a']);
  });
});

// ─── The unified feed ────────────────────────────────────────────────────────

const emptyFeedDeps = (): RetainFeedDeps => ({
  listMemories: async () => [],
  listRubrics: async () => [],
  listRecipesPage: async () => [],
  countRecipes: async () => 0,
  listRunbooksPage: async () => [],
  countRunbooks: async () => 0,
});

const planRow = (slug: string, ts: string, over: Record<string, unknown> = {}) => ({
  id: slug,
  title: `Plan ${slug}`,
  status: 'ready',
  ts,
  idea_id: `idea-${slug}`,
  idea_title: `idea for ${slug}`,
  lens: 'reframing',
  child_total: 3,
  child_done: 2,
  ...over,
});

const wiRow = (id: string, ts: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `WI ${id}`,
  status: 'done',
  shipped: true,
  ts,
  idea_id: `idea-${id}`,
  idea_title: null,
  lens: 'constraint-removal',
  ...over,
});

describe('readRetainFeed', () => {
  it('interleaves every kind by recent activity, newest first', async () => {
    const sql = sqlStub((t) => {
      if (isPlanLeg(t)) return [planRow('p1', '2026-08-15T10:00:00.000Z')];
      if (isWiLeg(t)) return [wiRow('EI-1', '2026-08-16T09:00:00.000Z')];
      return [{ n: 0 }];
    });
    const deps: RetainFeedDeps = {
      ...emptyFeedDeps(),
      listRubrics: async () => [
        { slug: 'r1', title: 'Rubric', status: 'active', updatedAt: '2026-08-16T08:00:00.000Z' },
      ],
      listRunbooksPage: async () => [
        { slug: 'd1', title: 'Doc', discovered: '2026-08-14', ts: '2026-08-14T12:00:00.000Z' },
      ],
      listRecipesPage: async () => [{ id: 'rec1', title: 'Recipe', runCount: 4, ts: '2026-08-16T11:00:00.000Z' }],
    };
    const page = await readRetainFeed(sql, 'ws-1', deps);
    expect(page.rows.map((r) => `${r.kind}:${r.id}`)).toEqual([
      'recipe:rec1',
      'wi:EI-1',
      'rubric:r1',
      'plan:p1',
      'runbook:d1',
    ]);
    expect(page.degraded).toEqual([]);
    // 5 candidates < default page size → exhausted.
    expect(page.nextCursor).toBeNull();
  });

  it('pages with a composite cursor: full page ⇒ nextCursor at the last row, and the next page resumes after it', async () => {
    const rubrics = Array.from({ length: 6 }, (_, i) => ({
      slug: `r-${String(i).padStart(2, '0')}`,
      title: `Rubric ${i}`,
      status: 'active',
      updatedAt: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const deps: RetainFeedDeps = { ...emptyFeedDeps(), listRubrics: async () => rubrics };
    const sql = sqlStub(() => [{ n: 0 }]);
    const page1 = await readRetainFeed(sql, 'ws-1', deps, { tab: 'rubrics', limit: 4 });
    expect(page1.rows).toHaveLength(4);
    expect(page1.rows[0]!.id).toBe('r-05');
    expect(page1.nextCursor).not.toBeNull();
    const c = decodeRetainCursor(page1.nextCursor)!;
    expect(c).toEqual({ ts: '2026-08-12T00:00:00.000Z', kind: 'rubric', id: 'r-02' });
    const page2 = await readRetainFeed(sql, 'ws-1', deps, { tab: 'rubrics', limit: 4, cursor: page1.nextCursor });
    expect(page2.rows.map((r) => r.id)).toEqual(['r-01', 'r-00']);
    expect(page2.nextCursor).toBeNull();
    // Paging never re-emits and never skips: the two pages partition the corpus.
    const all = [...page1.rows, ...page2.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(6);
  });

  it('a full-page tie at one timestamp still advances via the id tiebreak', async () => {
    const ts = '2026-08-15T00:00:00.000Z';
    const rubrics = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      slug: id,
      title: id,
      status: 'active',
      updatedAt: ts,
    }));
    const deps: RetainFeedDeps = { ...emptyFeedDeps(), listRubrics: async () => rubrics };
    const sql = sqlStub(() => [{ n: 0 }]);
    const page1 = await readRetainFeed(sql, 'ws-1', deps, { tab: 'rubrics', limit: 2 });
    expect(page1.rows.map((r) => r.id)).toEqual(['a', 'b']);
    const page2 = await readRetainFeed(sql, 'ws-1', deps, { tab: 'rubrics', limit: 2, cursor: page1.nextCursor });
    expect(page2.rows.map((r) => r.id)).toEqual(['c', 'd']);
  });

  it('counts ride the FIRST page only, filter-independent corpus sizes', async () => {
    const sql = sqlStub((t) => {
      if (isPlanCount(t)) return [{ n: 21 }];
      if (isWiCount(t)) return [{ n: 991 }];
      return [];
    });
    const deps: RetainFeedDeps = {
      ...emptyFeedDeps(),
      listRubrics: async () => [
        { slug: 'r1', title: 'R', status: 'active', updatedAt: '2026-08-01T00:00:00.000Z' },
      ],
      countRunbooks: async () => 512,
      countRecipes: async () => 13561,
    };
    const page1 = await readRetainFeed(sql, 'ws-1', deps);
    expect(page1.counts).toEqual({ memories: 0, plans: 21, wi: 991, rubrics: 1, runbooks: 512, recipes: 13561 });
    const page2 = await readRetainFeed(sql, 'ws-1', deps, {
      cursor: encodeRetainCursor({ ts: '2026-08-01T00:00:00.000Z', kind: 'rubric', id: 'r1' }),
    });
    expect(page2.counts).toBeNull();
  });

  it('a failing count degrades to null — never 0 (a bounded read must not read as an empty corpus)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub((t) => {
      if (isPlanCount(t)) throw new Error('pg down');
      if (isWiCount(t)) return [{ n: 5 }];
      return [];
    });
    const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps());
    expect(page.counts).toEqual({ memories: 0, plans: null, wi: 5, rubrics: 0, runbooks: 0, recipes: 0 });
    warn.mockRestore();
  });

  it('tab narrows to one leg; a cursored single-kind page touches no other store', async () => {
    const deps = emptyFeedDeps();
    const listRubrics = vi.fn(deps.listRubrics);
    const listRunbooksPage = vi.fn(deps.listRunbooksPage);
    const listRecipesPage = vi.fn(async () => [
      { id: 'rec1', title: 'Recipe', runCount: 1, ts: '2026-08-10T00:00:00.000Z' },
    ]);
    const sqlCalls: string[] = [];
    const sql = sqlStub((t) => {
      sqlCalls.push(t);
      return [];
    });
    const page = await readRetainFeed(
      sql,
      'ws-1',
      { ...deps, listRubrics, listRunbooksPage, listRecipesPage },
      { tab: 'recipes', cursor: encodeRetainCursor({ ts: '2026-08-11T00:00:00.000Z', kind: 'recipe', id: 'x' }) },
    );
    expect(page.rows.map((r) => r.kind)).toEqual(['recipe']);
    expect(listRubrics).not.toHaveBeenCalled();
    expect(listRunbooksPage).not.toHaveBeenCalled();
    expect(sqlCalls).toEqual([]); // no plan/wi legs, no counts past page 1
  });

  it('the recipe leg receives the cursor as its keyset window', async () => {
    const listRecipesPage = vi.fn(async () => []);
    const sql = sqlStub(() => []);
    const cursor = { ts: '2026-08-11T00:00:00.000Z', kind: 'recipe' as const, id: 'rec-mid' };
    await readRetainFeed(
      sql,
      'ws-1',
      { ...emptyFeedDeps(), listRecipesPage },
      { tab: 'recipes', cursor: encodeRetainCursor(cursor) },
    );
    expect(listRecipesPage).toHaveBeenCalledWith({
      window: { beforeTs: cursor.ts, includeTies: false, tieIdAfter: 'rec-mid' },
      // Pin the CONSTANT, not its value: the page size is a measured product decision
      // (24→75 in WI-39675) and this assertion is about the cursor window plumbing,
      // not the size itself. A literal here strands this test on every size change.
      limit: RETAIN_FEED_PAGE_SIZE,
    });
  });

  it('a non-all filter narrows the feed to statusful kinds (plan, wi) — no rubric/runbook/recipe reads', async () => {
    const deps = emptyFeedDeps();
    const listRubrics = vi.fn(deps.listRubrics);
    const listRunbooksPage = vi.fn(deps.listRunbooksPage);
    const listRecipesPage = vi.fn(deps.listRecipesPage);
    const sql = sqlStub((t) => {
      if (isPlanLeg(t)) return [planRow('p1', '2026-08-15T00:00:00.000Z', { status: 'shipped' })];
      if (isWiLeg(t)) return [wiRow('EI-1', '2026-08-16T00:00:00.000Z')];
      return [{ n: 0 }];
    });
    const page = await readRetainFeed(
      sql,
      'ws-1',
      { ...deps, listRubrics, listRunbooksPage, listRecipesPage },
      { filter: 'shipped' },
    );
    expect(page.rows.map((r) => r.kind).sort()).toEqual(['plan', 'wi']);
    expect(listRubrics).toHaveBeenCalledTimes(1); // counts only (page 1)…
    expect(listRunbooksPage).not.toHaveBeenCalled(); // …never the row legs
    expect(listRecipesPage).not.toHaveBeenCalled();
  });

  it('a throwing leg lands in `degraded` while the rest of the page survives', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub((t) => {
      if (isPlanLeg(t)) throw new Error('pg down');
      if (isWiLeg(t)) return [wiRow('EI-1', '2026-08-16T00:00:00.000Z')];
      return [{ n: 0 }];
    });
    const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps());
    expect(page.degraded).toEqual(['plan']);
    expect(page.rows.map((r) => r.id)).toEqual(['EI-1']);
    warn.mockRestore();
  });

  /**
   * EI-18792873324746237 — the shipped verdict is stamped SERVER-side against
   * the shared unified status set. The regression: a query naming only the
   * pre-unify 'resolved'/'closed' spellings selected nothing post-flip, and a
   * client-side re-typed list scored `done` as not-a-win. Pin both halves.
   */
  describe('server-side shipped classification (EI-18792873324746237)', () => {
    it('binds the CANONICAL unified spelling into the wi leg, so it can match a live row', async () => {
      const bound: unknown[][] = [];
      const sql = sqlStub((t, values) => {
        if (isWiLeg(t)) bound.push(values);
        return [];
      });
      await readRetainFeed(sql, 'ws-1', emptyFeedDeps(), { tab: 'wi', cursor: 'x' });
      expect(bound).toHaveLength(1);
      expect(bound.flat(2)).toContain('done');
    });

    it('serves the row-level verdict the SQL computed — done=shipped, dropped=not', async () => {
      const sql = sqlStub((t) =>
        isWiLeg(t)
          ? [
              wiRow('EI-done', '2026-08-16T00:00:00.000Z', { status: 'done', shipped: true }),
              wiRow('EI-dropped', '2026-08-15T00:00:00.000Z', { status: 'dropped', shipped: false }),
            ]
          : [{ n: 0 }],
      );
      const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps(), { tab: 'wi' });
      expect(page.rows.map((r) => [r.id, r.shipped])).toEqual([
        ['EI-done', true],
        ['EI-dropped', false],
      ]);
    });

    it('classifies a plan by the PLAN vocabulary: only `shipped` lands', async () => {
      const sql = sqlStub((t) =>
        isPlanLeg(t)
          ? [
              planRow('p-shipped', '2026-08-16T00:00:00.000Z', { status: 'shipped' }),
              planRow('p-active', '2026-08-15T00:00:00.000Z', { status: 'active' }),
            ]
          : [{ n: 0 }],
      );
      const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps(), { tab: 'plans' });
      expect(page.rows.map((r) => [r.id, r.shipped])).toEqual([
        ['p-shipped', true],
        ['p-active', false],
      ]);
    });
  });

  it('plan rows carry the plan-born child rollup + origin idea', async () => {
    const sql = sqlStub((t) =>
      isPlanLeg(t) ? [planRow('p1', '2026-08-15T00:00:00.000Z')] : [{ n: 0 }],
    );
    const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps(), { tab: 'plans' });
    expect(page.rows[0]!.meta).toEqual({
      ideaId: 'idea-p1',
      ideaTitle: 'idea for p1',
      lens: 'reframing',
      childTotal: 3,
      childDone: 2,
    });
  });

  // ─── The memory leg (WI-39535: shared-memory pool folded in as a kind) ────
  describe('memory leg', () => {
    const mem = (id: string, text: string, metadata: Record<string, unknown> = {}, kind?: string) => ({
      id,
      text,
      ...(kind ? { kind } : {}),
      metadata,
    });

    it('interleaves memory rows by metadata recency, with provenance in meta', async () => {
      const sql = sqlStub((t) =>
        isWiLeg(t) ? [wiRow('EI-1', '2026-08-15T00:00:00.000Z')] : [{ n: 0 }],
      );
      const deps: RetainFeedDeps = {
        ...emptyFeedDeps(),
        listMemories: async () => [
          mem('m-new', 'Fresh fact', { updated_at: '2026-08-16T00:00:00.000Z', created_by: 'owner' }, 'feedback'),
          mem('m-pack', 'Pack fact', {
            created_at: '2026-08-14T00:00:00.000Z',
            source: 'pack',
            pack_id: 'coding',
          }),
        ],
      };
      const page = await readRetainFeed(sql, 'ws-1', deps);
      expect(page.rows.map((r) => `${r.kind}:${r.id}`)).toEqual(['memory:m-new', 'wi:EI-1', 'memory:m-pack']);
      expect(page.rows[0]!.meta).toEqual({ memKind: 'feedback', createdBy: 'owner' });
      expect(page.rows[0]!.status).toBeNull();
      expect(page.rows[2]!.meta).toEqual({ packId: 'coding' });
      expect(page.counts?.memories).toBe(2);
    });

    it('a memory with no timestamp reads as epoch — visible at the tail, never dropped', async () => {
      const sql = sqlStub(() => [{ n: 0 }]);
      const deps: RetainFeedDeps = { ...emptyFeedDeps(), listMemories: async () => [mem('m-old', 'Undated fact')] };
      const page = await readRetainFeed(sql, 'ws-1', deps, { tab: 'memories' });
      expect(page.rows.map((r) => r.id)).toEqual(['m-old']);
      expect(page.rows[0]!.ts).toBe('1970-01-01T00:00:00.000Z');
    });

    it('the memories tab narrows to the memory leg — no SQL legs touched past page 1', async () => {
      const sqlCalls: string[] = [];
      const sql = sqlStub((t) => {
        sqlCalls.push(t);
        return [];
      });
      const cursor = encodeRetainCursor({ ts: '2026-08-15T00:00:00.000Z', kind: 'memory', id: 'm-mid' });
      const deps: RetainFeedDeps = {
        ...emptyFeedDeps(),
        listMemories: async () => [
          mem('m-a', 'after cursor', { updated_at: '2026-08-14T00:00:00.000Z' }),
          mem('m-z', 'before cursor', { updated_at: '2026-08-16T00:00:00.000Z' }),
        ],
      };
      const page = await readRetainFeed(sql, 'ws-1', deps, { tab: 'memories', cursor });
      expect(page.rows.map((r) => r.id)).toEqual(['m-a']); // keyset window applied
      expect(sqlCalls).toEqual([]);
    });

    it('an UNWIRED listMemories dep degrades VISIBLY, never silently', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { listMemories: _omit, ...rest } = emptyFeedDeps();
      const page = await readRetainFeed(sqlStub(() => [{ n: 0 }]), 'ws-1', rest as RetainFeedDeps);
      expect(page.degraded).toEqual(['memory']);
      expect(page.counts?.memories).toBeNull();
      warn.mockRestore();
    });

    it('retainMemoryTitle collapses whitespace and clamps long facts', () => {
      expect(retainMemoryTitle('a\n b\t c')).toBe('a b c');
      const long = 'x'.repeat(300);
      const title = retainMemoryTitle(long);
      expect(title.length).toBeLessThanOrEqual(200);
      expect(title.endsWith('…')).toBe(true);
    });

    it('retainMemoryTsOf prefers updated over created and tolerates both spellings', () => {
      expect(retainMemoryTsOf({ updated_at: '2026-08-16T00:00:00.000Z', created_at: '2026-08-10T00:00:00.000Z' })).toBe(
        '2026-08-16T00:00:00.000Z',
      );
      expect(retainMemoryTsOf({ createdAt: '2026-08-10T00:00:00.000Z' })).toBe('2026-08-10T00:00:00.000Z');
      expect(retainMemoryTsOf(undefined)).toBe('1970-01-01T00:00:00.000Z');
    });
  });
});

describe('readRetainPlanChildren', () => {
  it('maps rows with the server-stamped shipped verdict', async () => {
    const sql = sqlStub(() => [
      { id: 'EI-1', title: 'Child one', status: 'done', shipped: true, ts: '2026-08-15T00:00:00.000Z' },
      { id: 'EI-2', title: 'Child two', status: 'wip', shipped: false, ts: '2026-08-14T00:00:00.000Z' },
    ]);
    const rows = await readRetainPlanChildren(sql, 'ws-1', 'plan-x');
    expect(rows).toEqual([
      { id: 'EI-1', title: 'Child one', status: 'done', shipped: true, ts: '2026-08-15T00:00:00.000Z' },
      { id: 'EI-2', title: 'Child two', status: 'wip', shipped: false, ts: '2026-08-14T00:00:00.000Z' },
    ]);
  });

  it('degrades to [] on a read failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub(() => {
      throw new Error('pg down');
    });
    expect(await readRetainPlanChildren(sql, 'ws-1', 'plan-x')).toEqual([]);
    warn.mockRestore();
  });
});

// ─── Row detail (WI-39534) ───────────────────────────────────────────────────

const isPlanDetail = (t: string) => t.includes('hp.content');
const isWiDetail = (t: string) => t.includes('ei.body');

const emptyDetailDeps = (): RetainDetailDeps => ({
  getRubric: async () => null,
  getRecipe: async () => null,
  readRunbook: async () => null,
  getMemory: async () => null,
});

describe('readRetainDetail', () => {
  it('plan: body from content, provenance fields from the routed idea', async () => {
    const sql = sqlStub((t) =>
      isPlanDetail(t)
        ? [
            {
              title: 'Plan one',
              status: 'active',
              content: '  # Plan body  ',
              harness_slug: 'h-1',
              now_state: 'building',
              ts: '2026-08-15T00:00:00.000Z',
              idea_id: 'idea-1',
              idea_title: 'the idea',
              lens: 'reframing',
              routed_ts: '2026-08-10T00:00:00.000Z',
            },
          ]
        : [],
    );
    const d = await readRetainDetail(sql, 'ws-1', 'plan', 'p-1', emptyDetailDeps());
    expect(d).toMatchObject({
      kind: 'plan',
      id: 'p-1',
      title: 'Plan one',
      status: 'active',
      body: '# Plan body',
      bodyTruncated: false,
    });
    expect(d!.fields).toEqual([
      { label: 'Harness', value: 'h-1' },
      { label: 'Now', value: 'building' },
      { label: 'From idea', value: 'the idea' },
      { label: 'Lens', value: 'reframing' },
      { label: 'Routed', value: '2026-08-10T00:00:00.000Z' },
    ]);
  });

  it('wi: body + severity/scope fields; unknown id resolves null', async () => {
    const sql = sqlStub((t) =>
      isWiDetail(t)
        ? [
            {
              title: 'The issue',
              state: 'done',
              body: 'repro steps',
              severity: 'major',
              created_by: 'scout',
              scope: 'harness:h-1',
              ts: '2026-08-15T00:00:00.000Z',
              created_ts: '2026-08-01T00:00:00.000Z',
              idea_id: null,
              idea_title: null,
              lens: null,
            },
          ]
        : [],
    );
    const d = await readRetainDetail(sql, 'ws-1', 'wi', 'EI-1', emptyDetailDeps());
    expect(d).toMatchObject({ kind: 'wi', title: 'The issue', status: 'done', body: 'repro steps' });
    expect(d!.fields.map((f) => f.label)).toEqual(['Severity', 'Scope', 'Created by', 'Created']);
    expect(await readRetainDetail(sqlStub(() => []), 'ws-1', 'wi', 'EI-none', emptyDetailDeps())).toBeNull();
  });

  it('rubric: criteria as listItems', async () => {
    const deps: RetainDetailDeps = {
      ...emptyDetailDeps(),
      getRubric: async () => ({
        title: 'Rubric R',
        description: 'what good looks like',
        status: 'active',
        characteristic: 'hive-coordination',
        criteria: [{ label: 'C1' }, { title: 'C2' }, { id: 'c3' }],
        updatedAt: '2026-08-15T00:00:00.000Z',
      }),
    };
    const d = await readRetainDetail(sqlStub(() => []), 'ws-1', 'rubric', 'r-1', deps);
    expect(d).toMatchObject({ kind: 'rubric', title: 'Rubric R', body: 'what good looks like' });
    expect(d!.listItems).toEqual(['C1', 'C2', 'c3']);
    expect(d!.fields).toEqual([{ label: 'Characteristic', value: 'hive-coordination' }]);
  });

  it('runbook: frontmatter stripped from the body, title/discovered parsed from it', async () => {
    const deps: RetainDetailDeps = {
      ...emptyDetailDeps(),
      readRunbook: async () => ({
        text: '---\ntitle: The doc\ndiscovered: 2026-07-01\n---\nThe method itself.',
        ts: '2026-08-01T00:00:00.000Z',
      }),
    };
    const d = await readRetainDetail(sqlStub(() => []), 'ws-1', 'runbook', 'doc-1', deps);
    expect(d).toMatchObject({ title: 'The doc', body: 'The method itself.', ts: '2026-08-01T00:00:00.000Z' });
    expect(d!.fields).toEqual([{ label: 'Discovered', value: '2026-07-01' }]);
  });

  it('recipe: description as body, script as code, run stats as fields', async () => {
    const deps: RetainDetailDeps = {
      ...emptyDetailDeps(),
      getRecipe: async () => ({
        title: 'Recipe R',
        description: 'what it automates',
        script: 'console.log(1)',
        potSlug: 'pot-a',
        toolsUsed: ['dev:pg_query'],
        runCount: 5,
        successCount: 4,
        lastRunAt: '2026-08-15T00:00:00.000Z',
        status: 'active',
        createdBy: 'agent-x',
        updatedAt: '2026-08-10T00:00:00.000Z',
      }),
    };
    const d = await readRetainDetail(sqlStub(() => []), 'ws-1', 'recipe', 'rec-1', deps);
    expect(d).toMatchObject({ kind: 'recipe', body: 'what it automates', code: 'console.log(1)' });
    expect(d!.ts).toBe('2026-08-15T00:00:00.000Z');
    expect(d!.fields).toEqual([
      { label: 'Runs', value: '4/5 ok' },
      { label: 'Last run', value: '2026-08-15T00:00:00.000Z' },
      { label: 'Pot', value: 'pot-a' },
      { label: 'Author', value: 'agent-x' },
      { label: 'Tools', value: 'dev:pg_query' },
    ]);
  });

  it('memory: full text, editable, pack + pool provenance', async () => {
    const deps: RetainDetailDeps = {
      ...emptyDetailDeps(),
      getMemory: async () => ({
        id: 'm-1',
        text: 'The retained fact, in full.',
        kind: 'feedback',
        scope: 'hive:pot-a',
        metadata: {
          created_by: 'owner',
          source: 'pack',
          pack_id: 'coding',
          pack_version: '1.2.0',
          applies_to: ['engineer'],
          updated_at: '2026-08-16T00:00:00.000Z',
        },
      }),
    };
    const d = await readRetainDetail(sqlStub(() => []), 'ws-1', 'memory', 'm-1', deps);
    expect(d).toMatchObject({
      kind: 'memory',
      body: 'The retained fact, in full.',
      editable: true,
      ts: '2026-08-16T00:00:00.000Z',
    });
    expect(d!.fields).toEqual([
      { label: 'Kind', value: 'feedback' },
      { label: 'Created by', value: 'owner' },
      { label: 'Pack', value: 'coding @1.2.0' },
      { label: 'Applies to', value: 'engineer' },
      { label: 'Pool', value: 'hive:pot-a' },
    ]);
  });

  it('a long body clamps with bodyTruncated', async () => {
    const sql = sqlStub((t) => (isPlanDetail(t) ? [{ title: 'P', status: null, content: 'x'.repeat(9000) }] : []));
    const d = await readRetainDetail(sql, 'ws-1', 'plan', 'p-big', emptyDetailDeps());
    expect(d!.bodyTruncated).toBe(true);
    expect(d!.body!.length).toBe(4000);
  });

  it('an empty id, an unknown id, and a throwing store all resolve null — never a 500', async () => {
    expect(await readRetainDetail(sqlStub(() => []), 'ws-1', 'plan', '', emptyDetailDeps())).toBeNull();
    expect(await readRetainDetail(sqlStub(() => []), 'ws-1', 'memory', 'm-none', emptyDetailDeps())).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps: RetainDetailDeps = {
      ...emptyDetailDeps(),
      getRubric: async () => {
        throw new Error('store down');
      },
    };
    expect(await readRetainDetail(sqlStub(() => []), 'ws-1', 'rubric', 'r-1', deps)).toBeNull();
    warn.mockRestore();
  });

  it('stripFrontmatter leaves a doc without frontmatter intact', () => {
    expect(stripFrontmatter('no frontmatter here')).toBe('no frontmatter here');
    expect(stripFrontmatter('---\na: 1\n---\nbody')).toBe('body');
  });
});

describe('insight-doc fs legs', () => {
  const mkDocs = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'insights-'));
    const mk = async (name: string, discovered: string, mtimeSec: number) => {
      const p = path.join(dir, name);
      await writeFile(p, `---\ntitle: ${name}\ndiscovered: ${discovered}\n---\n`);
      await utimes(p, mtimeSec, mtimeSec);
    };
    await mk('a.mdx', '2026-07-01', 1_700_000_100);
    await mk('b.mdx', '2026-07-18', 1_700_000_200);
    await mk('c.md', '2026-07-10', 1_700_000_300);
    await writeFile(path.join(dir, 'ignored.txt'), 'not a doc');
    return dir;
  };

  it('pages newest-mtime first, opening only the selected files', async () => {
    const dir = await mkDocs();
    const page = await readInsightDocsPage(dir, { window: null, limit: 2 });
    expect(page.map((d) => d.slug)).toEqual(['c', 'b']);
    expect(page[0]!.title).toBe('c.md');
    expect(page[0]!.ts).toBe(new Date(1_700_000_300_000).toISOString());
  });

  it('applies the keyset window', async () => {
    const dir = await mkDocs();
    const first = await readInsightDocsPage(dir, { window: null, limit: 1 });
    const w = { beforeTs: first[0]!.ts, includeTies: false, tieIdAfter: first[0]!.slug };
    const rest = await readInsightDocsPage(dir, { window: w, limit: 5 });
    expect(rest.map((d) => d.slug)).toEqual(['b', 'a']);
  });

  it('countInsightDocs counts only md/mdx', async () => {
    const dir = await mkDocs();
    expect(await countInsightDocs(dir)).toBe(3);
  });
});
