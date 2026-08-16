/**
 * learning-retain-read tests (WI-5412) — the graceful-degradation contract
 * (every leg fails independently, the snapshot always comes back shaped) +
 * the insight-doc frontmatter parse.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseInsightFrontmatter,
  readRecentInsightDocs,
  readRetainExtras,
  type RetainExtrasDeps,
} from './learning-retain-read';

/** A postgres-tag stub: every sql`…` call resolves via the injected handler. */
function sqlStub(handler: (text: string) => unknown[]): never {
  const fn = (strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(handler(strings.join('?')));
  return fn as never;
}

const okDeps: RetainExtrasDeps = {
  listRubrics: async () => [
    { slug: 'r-old', title: 'Old rubric', status: 'active', updatedAt: '2026-07-01T00:00:00.000Z' },
    { slug: 'r-new', title: 'New rubric', status: 'proposed', updatedAt: '2026-07-18T00:00:00.000Z' },
  ],
  listRecipes: async () => [{ id: 'rec-1', title: 'A recipe', runCount: 4, lastRunAt: '2026-07-17T00:00:00.000Z' }],
  readLensWeights: async () => ({ analogical: 2, reframing: 1 }),
  readInsightDocs: async () => [{ slug: 'a-doc', title: 'A doc', discovered: '2026-07-18' }],
};

describe('readRetainExtras', () => {
  it('returns every leg + counts on the happy path, rubrics newest-updated first', async () => {
    const sql = sqlStub(() => [{ n: 3 }]);
    const snap = await readRetainExtras(sql, 'ws-1', okDeps);
    expect(snap.banked).toEqual({ improvementsFiled7d: 3, plansDrafted7d: 3 });
    expect(snap.lensWeights).toEqual({ analogical: 2, reframing: 1 });
    expect(snap.rubricChanges.map((r) => r.slug)).toEqual(['r-new', 'r-old']);
    expect(snap.insightDocs).toEqual([{ slug: 'a-doc', title: 'A doc', discovered: '2026-07-18' }]);
    expect(snap.recipes).toEqual([{ id: 'rec-1', title: 'A recipe', runCount: 4, lastRunAt: '2026-07-17T00:00:00.000Z' }]);
  });

  it('degrades each failing leg independently — never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub(() => {
      throw new Error('pg down');
    });
    const deps: RetainExtrasDeps = {
      listRubrics: async () => {
        throw new Error('rubrics down');
      },
      listRecipes: async () => {
        throw new Error('recipes down');
      },
      readLensWeights: async () => {
        throw new Error('weights down');
      },
      readInsightDocs: async () => {
        throw new Error('docs down');
      },
    };
    const snap = await readRetainExtras(sql, 'ws-1', deps);
    expect(snap.banked).toEqual({ improvementsFiled7d: null, plansDrafted7d: null });
    expect(snap.lensWeights).toBeNull();
    expect(snap.rubricChanges).toEqual([]);
    expect(snap.insightDocs).toEqual([]);
    expect(snap.recipes).toEqual([]);
    warn.mockRestore();
  });

  it('empty lens weights read as null (none recorded), not {}', async () => {
    const sql = sqlStub(() => [{ n: 0 }]);
    const snap = await readRetainExtras(sql, 'ws-1', { ...okDeps, readLensWeights: async () => ({}) });
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

/**
 * EI-18792873324746237 — "shipped from ideas" silently excluded every shipped
 * work item.
 *
 * The WHERE clause filtered `ei.state IN ('resolved','closed')`, the PRE-unify
 * spellings. After the work-item-status-full-unify writer-flip every live row
 * stores `done`/`dropped`, so the wi:-routed branch matched NOTHING: measured on
 * the live DB, 0 rows selected against 137 genuinely shipped ideas. The panel
 * still rendered — populated only by the plan branch — so nothing looked broken.
 *
 * These tests pin the two halves of the fix: the query must be able to MATCH a
 * live row, and the outcome must be classified honestly once it does.
 */
describe('shipped-from-ideas outcome classification (EI-18792873324746237)', () => {
  /** A sql stub recording the values bound by the shipped-from-ideas query
   *  ONLY — scoped deliberately (the blender-plans leg also reads
   *  scout_routed_ideas, but only this query joins engineer_issues), so the
   *  assertion below cannot be satisfied by some other leg that happens to
   *  bind the same string. */
  function recordingSqlStub(handler: (text: string) => unknown[]) {
    const bound: unknown[][] = [];
    const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('scout_routed_ideas') && text.includes('engineer_issues')) bound.push(values);
      return Promise.resolve(handler(text));
    };
    return { sql: fn as never, bound };
  }

  /** Route the shipped-from-ideas query to `rows`; every other leg returns []. */
  function stubReturning(rows: unknown[]) {
    return recordingSqlStub((text) =>
      text.includes('scout_routed_ideas') && text.includes('engineer_issues') ? rows : [],
    );
  }

  const idea = (ideaId: string, outcome: string, rail = 'improvement') => ({
    idea_id: ideaId,
    title: `idea ${ideaId}`,
    rail,
    routed_ref: rail === 'improvement' ? `wi:EI-${ideaId}` : `plan:${ideaId}`,
    outcome,
    completed_at: '2026-07-20T00:00:00.000Z',
  });

  it('binds the CANONICAL unified spelling, so the query can match a live row', async () => {
    // The regression itself: a query naming only 'resolved'/'closed' selects
    // nothing from a post-flip table. Assert 'done' is actually bound.
    const { sql, bound } = stubReturning([]);
    await readRetainExtras(sql, 'ws-1', okDeps);
    expect(bound).toHaveLength(1); // the shipped-from-ideas query ran exactly once
    expect(bound.flat(2)).toContain('done');
  });

  it('counts a `done` work item as shipped', async () => {
    const { sql } = stubReturning([idea('1', 'done')]);
    const snap = await readRetainExtras(sql, 'ws-1', okDeps);
    expect(snap.shippedFromIdeas.map((s) => [s.outcome, s.shipped])).toEqual([['done', true]]);
  });

  it('accepts the legacy `resolved` alias too — pre-flip rows still read as shipped', async () => {
    const { sql } = stubReturning([idea('2', 'resolved')]);
    const snap = await readRetainExtras(sql, 'ws-1', okDeps);
    expect(snap.shippedFromIdeas[0]!.shipped).toBe(true);
  });

  it('does NOT count an abandoned item as shipped', async () => {
    // `dropped` (and its legacy alias `closed`) mean the loop gave up. Marking
    // them shipped overstates the loop's output — the failure mode the old
    // client-side list had, where `closed` scored as a win.
    const { sql } = stubReturning([idea('3', 'dropped'), idea('4', 'closed')]);
    const snap = await readRetainExtras(sql, 'ws-1', okDeps);
    expect(snap.shippedFromIdeas.every((s) => s.shipped === false)).toBe(true);
  });

  it('classifies a routed PLAN by the plan vocabulary, not the work-item one', async () => {
    // The two rails end in different vocabularies. A plan lands only at
    // 'shipped'; 'active' survives the WHERE clause but is in-progress, and
    // used to be scored as a win by the client's hand-written list.
    const { sql } = stubReturning([idea('5', 'shipped', 'plan'), idea('6', 'active', 'plan')]);
    const snap = await readRetainExtras(sql, 'ws-1', okDeps);
    const byId = new Map(snap.shippedFromIdeas.map((s) => [s.ideaId, s.shipped]));
    expect(byId.get('5')).toBe(true);
    expect(byId.get('6')).toBe(false);
  });
});

/**
 * blender-plans leg (D-004 / P-012, blender-loop-repair-and-opus5-xhigh-2026-08-16):
 * rail='plan' routed refs joined to the plan store — the Retain view lists what
 * the ideation loop DRAFTED, not only its shipped outcomes.
 */
describe('blender-generated plans leg', () => {
  /** Route ONLY the blender-plans query (reads harness_plans WITHOUT the
   *  engineer_issues join) to `rows`; every other leg returns []. */
  function stubBlenderReturning(rows: unknown[]) {
    const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?');
      const isBlender = text.includes('scout_routed_ideas') && !text.includes('engineer_issues');
      return Promise.resolve(isBlender ? rows : []);
    };
    return fn as never;
  }

  const planRow = (slug: string, over: Record<string, unknown> = {}) => ({
    plan_slug: slug,
    title: `Plan ${slug}`,
    status: 'draft',
    routed_at: '2026-08-10 00:00:00+00',
    idea_id: `idea-${slug}`,
    idea_title: `idea for ${slug}`,
    lens: 'reframing',
    ...over,
  });

  it('maps the joined rows and orders newest-routed first', async () => {
    const sql = stubBlenderReturning([
      planRow('older'),
      planRow('newer', { routed_at: '2026-08-15 00:00:00+00', status: 'ready' }),
    ]);
    const snap = await readRetainExtras(sql, 'ws-1', okDeps);
    expect(snap.blenderPlans.map((p) => p.planSlug)).toEqual(['newer', 'older']);
    expect(snap.blenderPlans[0]).toEqual({
      planSlug: 'newer',
      title: 'Plan newer',
      status: 'ready',
      routedAt: '2026-08-15 00:00:00+00',
      ideaId: 'idea-newer',
      ideaTitle: 'idea for newer',
      lens: 'reframing',
    });
  });

  it('drops a row without a plan slug and nulls a blank idea title', async () => {
    const sql = stubBlenderReturning([
      planRow('kept', { idea_title: '' }),
      planRow('', {}),
    ]);
    const snap = await readRetainExtras(sql, 'ws-1', okDeps);
    expect(snap.blenderPlans.map((p) => p.planSlug)).toEqual(['kept']);
    expect(snap.blenderPlans[0]!.ideaTitle).toBeNull();
  });

  it('caps the section', async () => {
    const sql = stubBlenderReturning(
      Array.from({ length: 12 }, (_, i) => planRow(`p-${String(i).padStart(2, '0')}`)),
    );
    const snap = await readRetainExtras(sql, 'ws-1', okDeps);
    expect(snap.blenderPlans).toHaveLength(8);
  });

  it('degrades to [] when the read throws — the leg fails independently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('scout_routed_ideas') && !text.includes('engineer_issues'))
        return Promise.reject(new Error('pg down'));
      return Promise.resolve([{ n: 1 }]);
    };
    const snap = await readRetainExtras(fn as never, 'ws-1', okDeps);
    expect(snap.blenderPlans).toEqual([]);
    expect(snap.banked.improvementsFiled7d).toBe(1);
    warn.mockRestore();
  });
});

describe('readRecentInsightDocs', () => {
  it('lists newest docs by discovered date, capped', async () => {
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
    const docs = await readRecentInsightDocs(dir, 2);
    expect(docs.map((d) => d.slug)).toEqual(['b', 'c']);
  });
});
