/**
 * rubric-rail.test.ts — the Scout `rubric` rail (plan-templates-and-rubric-v2 P-009).
 * Pure + deterministic: the draft creator is faked (no PG, no withPlanLock, no LLM).
 */
import { describe, it, expect } from 'vitest';
import {
  deriveRubricSlugStem,
  rubricDraftTitle,
  buildScoutRubricDraftBody,
  authorRubricGapPlans,
  DEFAULT_MAX_RUBRIC_DRAFTS_PER_CYCLE,
  type AuthorRubricGapPlansDeps,
} from './rubric-rail';
import { RUBRIC_TEMPLATE_NAME } from '../agent-tools/plans/rubric-template';
import type { MetaPattern } from './types';

function gap(over: Partial<MetaPattern> = {}): MetaPattern {
  return {
    summary: 'Queen placement keeps double-placing the same work item',
    detail: 'recurring (5× · 3 authors · 2 cycles), no covering rubric',
    ref: 'wi:WI-291',
    weight: 1,
    ...over,
  };
}

/** A fake createDraft that records calls and reports created/existing per a controllable map. */
function fakeCreator(opts: { existingSlugs?: Set<string>; throwOn?: (slug: string) => boolean } = {}) {
  const calls: Array<{ slug: string; title: string; body: string; harnessSlug?: string }> = [];
  const dep: AuthorRubricGapPlansDeps = {
    createDraft: async (input) => {
      // Exercise the buildBody seam exactly as the real createScoutPlanDraft would:
      // resolve a dated slug, then build the body from it.
      const dated = /-\d{4}-\d{2}-\d{2}$/.test(input.slug) ? input.slug : `${input.slug}-2026-06-21`;
      const body = input.buildBody ? input.buildBody({ slug: dated, date: '2026-06-21' }) : '';
      calls.push({ slug: dated, title: input.title, body, harnessSlug: input.harnessSlug });
      if (opts.throwOn?.(dated)) throw new Error(`boom: ${dated}`);
      const created = !(opts.existingSlugs?.has(dated) ?? false);
      return { slug: dated, created };
    },
  };
  return { dep, calls };
}

describe('deriveRubricSlugStem', () => {
  it('produces a stable, valid, scout-rubric-prefixed kebab slug', () => {
    const s = deriveRubricSlugStem('Queen placement keeps DOUBLE-placing work!!');
    expect(s).toBe('scout-rubric-queen-placement-keeps-double-placing-work');
    expect(s).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/); // plans:new slug rule
  });

  it('is stable across calls (same gap theme → same slug → idempotent draft)', () => {
    expect(deriveRubricSlugStem('a recurring thing')).toBe(deriveRubricSlugStem('a recurring thing'));
  });

  it('falls back to a valid slug when the summary has no usable tokens', () => {
    expect(deriveRubricSlugStem('!!! ???')).toBe('scout-rubric-gap');
    expect(deriveRubricSlugStem('')).toBe('scout-rubric-gap');
  });

  it('caps the slug length (no runaway from a long summary)', () => {
    const s = deriveRubricSlugStem('x'.repeat(200));
    expect(s.length).toBeLessThanOrEqual('scout-rubric-'.length + 50);
  });
});

describe('buildScoutRubricDraftBody', () => {
  const body = buildScoutRubricDraftBody({
    slug: 'scout-rubric-queen-placement-2026-06-21',
    title: rubricDraftTitle(gap()),
    date: '2026-06-21',
    gap: gap(),
  });

  it('ships a template:rubric, origin:scout, status:draft frontmatter', () => {
    expect(body).toContain(`template: ${RUBRIC_TEMPLATE_NAME}`);
    expect(body).toContain('origin: scout');
    expect(body).toContain('status: draft');
    expect(body).toContain('slug: scout-rubric-queen-placement-2026-06-21');
  });

  it('embeds the mug↔blender loop note (enters the existing loop)', () => {
    // Distinctive phrases from SCOUT_DRAFT_LOOP_NOTE — the draft self-documents its loop.
    expect(body).toContain('Mug↔Blender feedback loop');
    expect(body).toContain('learnings');
  });

  it('carries the gap evidence (theme + signal + drill-back ref) as the rubric seed', () => {
    expect(body).toContain('Queen placement keeps double-placing the same work item');
    expect(body).toContain('recurring (5× · 3 authors · 2 cycles), no covering rubric');
    expect(body).toContain('wi:WI-291');
  });

  it('guides the Queen to fill the structured templateData (characteristic/criteria/ratingScale)', () => {
    expect(body).toContain('plans:set-template-data');
    expect(body).toContain('characteristic');
    expect(body).toContain('criteria');
    expect(body).toContain('ratingScale');
  });

  it('tolerates a gap with no detail/ref (free-text-derived cluster)', () => {
    const b = buildScoutRubricDraftBody({
      slug: 'scout-rubric-x-2026-06-21',
      title: 'Rubric proposal: x',
      date: '2026-06-21',
      gap: { summary: 'x', ref: '' } as MetaPattern,
    });
    expect(b).toContain('a recurring cross-author friction cluster'); // detail fallback
    expect(b).not.toContain('drill-back:'); // no ref → no drill-back suffix
  });
});

describe('authorRubricGapPlans', () => {
  it('authors one template:rubric draft per gap, threading the harness + a matching body', async () => {
    const { dep, calls } = fakeCreator();
    const res = await authorRubricGapPlans([gap()], { harnessSlug: 'papercusp' }, dep);

    expect(res.authored).toEqual(['scout-rubric-queen-placement-keeps-double-placing-the-same-work-2026-06-21']);
    expect(res.existing).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].harnessSlug).toBe('papercusp');
    // body was built from the RESOLVED dated slug (the buildBody seam) + is a rubric template.
    expect(calls[0].body).toContain('slug: scout-rubric-queen-placement-keeps-double-placing-the-same-work-2026-06-21');
    expect(calls[0].body).toContain(`template: ${RUBRIC_TEMPLATE_NAME}`);
    expect(calls[0].title).toBe('Rubric proposal: Queen placement keeps double-placing the same work item');
  });

  it('is idempotent — an already-existing draft slug counts as existing, not authored', async () => {
    const existingSlugs = new Set(['scout-rubric-flaky-test-quarantine-churn-2026-06-21']);
    const { dep } = fakeCreator({ existingSlugs });
    const res = await authorRubricGapPlans(
      [gap({ summary: 'flaky test quarantine churn' })],
      {},
      dep,
    );
    expect(res.authored).toEqual([]);
    expect(res.existing).toEqual(['scout-rubric-flaky-test-quarantine-churn-2026-06-21']);
  });

  it('is defensive — one gap that throws is recorded in failed; the rest still author', async () => {
    const { dep, calls } = fakeCreator({
      throwOn: (slug) => slug.includes('boom-gap'),
    });
    const res = await authorRubricGapPlans(
      [gap({ summary: 'boom gap', ref: 'wi:WI-1' }), gap({ summary: 'good gap', ref: 'wi:WI-2' })],
      {},
      dep,
    );
    expect(res.authored).toEqual(['scout-rubric-good-gap-2026-06-21']);
    expect(res.failed).toEqual([{ ref: 'wi:WI-1', error: 'boom: scout-rubric-boom-gap-2026-06-21' }]);
    expect(calls).toHaveLength(2); // batch did not abort on the first throw
  });

  it('caps drafts per cycle (burst guard) — only the top maxPerCycle gaps author', async () => {
    const { dep, calls } = fakeCreator();
    const many = Array.from({ length: 9 }, (_, i) => gap({ summary: `gap number ${i}`, ref: `wi:WI-${i}` }));
    const res = await authorRubricGapPlans(many, { maxPerCycle: 3 }, dep);
    expect(calls).toHaveLength(3);
    expect(res.authored).toHaveLength(3);
  });

  it('defaults the per-cycle cap to DEFAULT_MAX_RUBRIC_DRAFTS_PER_CYCLE', async () => {
    const { dep, calls } = fakeCreator();
    const many = Array.from({ length: 12 }, (_, i) => gap({ summary: `gap number ${i}`, ref: `wi:WI-${i}` }));
    await authorRubricGapPlans(many, {}, dep);
    expect(calls).toHaveLength(DEFAULT_MAX_RUBRIC_DRAFTS_PER_CYCLE);
  });

  it('no gaps → empty result, no creator calls', async () => {
    const { dep, calls } = fakeCreator();
    const res = await authorRubricGapPlans([], {}, dep);
    expect(res).toEqual({ authored: [], existing: [], failed: [] });
    expect(calls).toHaveLength(0);
  });
});
