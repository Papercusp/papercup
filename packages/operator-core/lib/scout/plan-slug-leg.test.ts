import { describe, expect, it } from 'vitest';

import {
  GENERIC_SLUG_TOKENS,
  classifyPlanStatus,
  ideaTextStems,
  lightStem,
  matchPlans,
  planSlugTokens,
  probePlanSlugs,
  summarisePlanSlugLeg,
  type PlanRecord,
  type PlanSearchDeps,
} from './plan-slug-leg';

/**
 * THE WORKED CASE — the reason this leg exists, kept as a calibration case.
 *
 * An idea phrased in condition-language is already implemented by a module named
 * in mechanism-language (`orphaned-dispatch.ts`), sharing no token with it. The
 * plan slug is the only bridge. If this case ever stops matching, the leg has lost
 * the single property it was built for, whatever else still passes.
 */
const WORKED_IDEA =
  'Monitoring signals fire but bind no acting consumer, so detected work is silently stranded.';
const WORKED_PLAN_SLUG = 'self-improvement-consume-edges-2026-06-12';

describe('lightStem', () => {
  it('maps the worked case pair onto one stem — consume <-> consumer', () => {
    // This single assertion is what the whole leg turns on.
    expect(lightStem('consumer')).toBe(lightStem('consume'));
  });

  it('is self-consistent on plural/singular pairs that the length guard protects', () => {
    // Without the min-stem-length guard these split: "edges" -> "edg" but
    // "edge" -> "edg" only by a second rule firing, and the pair silently
    // stops matching whenever exactly one of the two applies.
    expect(lightStem('edges')).toBe(lightStem('edge'));
    expect(lightStem('fires')).toBe(lightStem('fire'));
    expect(lightStem('signals')).toBe(lightStem('signal'));
    expect(lightStem('consumers')).toBe(lightStem('consumer'));
  });

  it('strips the LONGEST matching suffix, not the shortest', () => {
    // "consumers" must lose "ers", not just "s", or it lands on "consumer"
    // and stops matching "consume".
    expect(lightStem('consumers')).toBe('consum');
  });

  it('refuses to strip below the minimum stem length', () => {
    expect(lightStem('fire')).toBe('fire');
    expect(lightStem('acting')).toBe('acting'); // "act" would be 3 chars
  });

  it('handles -ing and -ed without collapsing short words', () => {
    expect(lightStem('dispatching')).toBe('dispatch');
    expect(lightStem('orphaned')).toBe('orphan');
  });

  it('is idempotent — stemming a stem changes nothing further', () => {
    for (const w of ['consumer', 'edges', 'dispatching', 'orphaned', 'signals']) {
      expect(lightStem(lightStem(w))).toBe(lightStem(w));
    }
  });
});

describe('planSlugTokens', () => {
  it('drops the trailing YYYY-MM-DD date', () => {
    expect(planSlugTokens(WORKED_PLAN_SLUG)).toEqual([
      'self',
      'improvement',
      'consume',
      'edges',
    ]);
  });

  it('drops bare numeric fragments the kebab split leaves behind', () => {
    // Stripping the date as one span is NOT sufficient when the date is not
    // in trailing position — the split still yields "2026" / "06" / "12".
    expect(planSlugTokens('consume-2026-06-12-edges')).toEqual(['consume', 'edges']);
  });

  it('drops generic slug vocabulary that discriminates nothing', () => {
    expect(planSlugTokens('papercusp-work-consume-plan-v2')).toEqual(['consume']);
  });

  it('returns nothing for a slug made ENTIRELY of generic tokens', () => {
    // Such a plan must never match anything, rather than matching everything.
    expect(planSlugTokens('the-work-plan-fix-v2')).toEqual([]);
  });

  it('drops tokens shorter than the minimum and de-duplicates', () => {
    expect(planSlugTokens('ab-consume-consume-edges')).toEqual(['consume', 'edges']);
  });

  it('splits on underscores and slashes as well as hyphens', () => {
    expect(planSlugTokens('consume_edges/orphaned')).toEqual([
      'consume',
      'edges',
      'orphaned',
    ]);
  });

  it('returns raw tokens, not stems, so a reader sees what the slug contributed', () => {
    expect(planSlugTokens('consume-edges')).toContain('edges');
  });

  it('is safe on an empty or degenerate slug', () => {
    expect(planSlugTokens('')).toEqual([]);
    expect(planSlugTokens('---')).toEqual([]);
    expect(planSlugTokens('2026-06-12')).toEqual([]);
  });
});

describe('ideaTextStems', () => {
  it('stems the idea vocabulary and drops generic tokens', () => {
    const stems = ideaTextStems(WORKED_IDEA);
    expect(stems.has('consum')).toBe(true);
    expect(stems.has('signal')).toBe(true);
  });

  it('is empty for text with no usable vocabulary', () => {
    expect(ideaTextStems('').size).toBe(0);
    expect(ideaTextStems('!!! 123 -- ??').size).toBe(0);
  });
});

describe('matchPlans — the worked case', () => {
  const plans: PlanRecord[] = [
    { slug: WORKED_PLAN_SLUG, title: 'Consume self-improvement edges', status: 'shipped' },
    { slug: 'green-checkpoint-gate-hardening-2026-07-02', title: 'Gate', status: 'shipped' },
  ];

  it('bridges an idea to a plan that shares NO literal token with it', () => {
    const hits = matchPlans(WORKED_IDEA, plans);
    expect(hits.map((h) => h.slug)).toEqual([WORKED_PLAN_SLUG]);
    expect(hits[0].overlap).toEqual(['consum']);
    expect(hits[0].statusClass).toBe('implemented');
  });

  it('CONTROL: the bridge is stemming — exact-token matching scores it zero', () => {
    // A deliberately-wrong matcher, kept permanently as a control. It is the
    // implementation this leg would have had without lightStem, and it must
    // FAIL the worked case. If this control ever passes, the worked case has
    // stopped being evidence that stemming is load-bearing.
    const planTokens = new Set(planSlugTokens(WORKED_PLAN_SLUG));
    const ideaTokens = new Set(WORKED_IDEA.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []);
    const exactOverlap = [...planTokens].filter((t) => ideaTokens.has(t));

    expect(exactOverlap).toEqual([]);
    // ...while the real matcher finds it.
    expect(matchPlans(WORKED_IDEA, plans)).toHaveLength(1);
  });

  it('CONTROL: an unrelated plan does not match, so the hit is not vacuous', () => {
    const hits = matchPlans(WORKED_IDEA, [
      { slug: 'green-checkpoint-gate-hardening-2026-07-02', status: 'shipped' },
    ]);
    expect(hits).toEqual([]);
  });
});

describe('matchPlans — scoring and ranking', () => {
  it('scores COVERAGE of the plan name, not raw overlap count', () => {
    const hits = matchPlans(WORKED_IDEA, [
      { slug: 'consume-edges' }, // 1 of 2 stems
      { slug: WORKED_PLAN_SLUG }, // 1 of 4 stems
    ]);
    // Same overlap COUNT (1 each); the tighter plan name must rank first.
    expect(hits.map((h) => h.slug)).toEqual(['consume-edges', WORKED_PLAN_SLUG]);
    expect(hits[0].score).toBeCloseTo(0.5, 5);
    expect(hits[1].score).toBeCloseTo(0.25, 5);
  });

  it('breaks a score tie by the number of overlapping stems', () => {
    const hits = matchPlans(WORKED_IDEA, [
      { slug: 'consume-edges' }, // 1/2 = 0.5
      { slug: 'consume-signals-fires-alpha-beta-gamma' }, // 3/6 = 0.5, more overlap
    ]);
    expect(hits[0].slug).toBe('consume-signals-fires-alpha-beta-gamma');
    expect(hits[0].score).toBeCloseTo(hits[1].score, 5);
  });

  it('honours minScore, minOverlap and maxMatches', () => {
    const plans: PlanRecord[] = [
      { slug: 'consume-edges' }, // 0.5
      { slug: WORKED_PLAN_SLUG }, // 0.25
    ];
    expect(matchPlans(WORKED_IDEA, plans, { minScore: 0.4 }).map((h) => h.slug)).toEqual([
      'consume-edges',
    ]);
    expect(matchPlans(WORKED_IDEA, plans, { minOverlap: 2 })).toEqual([]);
    expect(matchPlans(WORKED_IDEA, plans, { maxMatches: 1 })).toHaveLength(1);
  });

  it('returns nothing when the idea text has no usable vocabulary', () => {
    expect(matchPlans('', [{ slug: 'consume-edges' }])).toEqual([]);
  });

  it('skips plans whose slug reduces to no meaningful tokens', () => {
    // Guards against a division by zero AND against an all-generic slug
    // scoring 1.0 against everything.
    expect(matchPlans(WORKED_IDEA, [{ slug: 'the-work-plan-v2' }])).toEqual([]);
  });

  it('tolerates a null/degenerate plan list', () => {
    expect(matchPlans(WORKED_IDEA, [])).toEqual([]);
    expect(matchPlans(WORKED_IDEA, undefined as unknown as PlanRecord[])).toEqual([]);
  });

  it('carries the title through for display but never scores on it', () => {
    // The title is stuffed with the idea's vocabulary; the slug is unrelated.
    // If titles were scored this would match — it must not.
    const hits = matchPlans(WORKED_IDEA, [
      { slug: 'green-checkpoint-gate-hardening', title: 'signals fire with no acting consumer' },
    ]);
    expect(hits).toEqual([]);
  });
});

describe('classifyPlanStatus — "abandoned is not built" (WI-9476 defect #4)', () => {
  it('treats only a shipped plan as evidence of an implementation', () => {
    expect(classifyPlanStatus('shipped')).toBe('implemented');
  });

  it('treats in-flight plans as intent, never as existing code', () => {
    for (const s of ['draft', 'ready', 'active']) {
      expect(classifyPlanStatus(s)).toBe('in-flight');
    }
  });

  it('treats a superseded plan as abandoned, not as prior art', () => {
    expect(classifyPlanStatus('superseded')).toBe('abandoned');
  });

  it('reports an unknown or missing status as unknown rather than guessing', () => {
    expect(classifyPlanStatus(undefined)).toBe('unknown');
    expect(classifyPlanStatus('')).toBe('unknown');
    expect(classifyPlanStatus('something-else')).toBe('unknown');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(classifyPlanStatus('  Shipped ')).toBe('implemented');
  });
});

describe('probePlanSlugs — fail-open and the zero-work guard', () => {
  const okDeps = (plans: PlanRecord[]): PlanSearchDeps => ({
    searchPlans: async () => plans,
  });

  it('reports searched:true with matches when the backend runs', async () => {
    const r = await probePlanSlugs(WORKED_IDEA, okDeps([{ slug: WORKED_PLAN_SLUG, status: 'shipped' }]));
    expect(r.searched).toBe(true);
    expect(r.planMatches).toHaveLength(1);
    expect(r.unavailableReason).toBeUndefined();
  });

  it('reports searched:true with NO matches as a real, complete empty answer', async () => {
    const r = await probePlanSlugs(WORKED_IDEA, okDeps([]));
    expect(r.searched).toBe(true);
    expect(r.planMatches).toEqual([]);
  });

  it('degrades to searched:false when the backend throws — never a silent miss', async () => {
    const r = await probePlanSlugs(WORKED_IDEA, {
      searchPlans: async () => {
        throw new Error('plan store unreachable');
      },
    });
    expect(r.searched).toBe(false);
    expect(r.planMatches).toEqual([]);
    expect(r.unavailableReason).toContain('plan store unreachable');
  });

  it('ZERO-WORK GUARD: never calls the backend, and never reports searched:true', async () => {
    // The defect this screen already shipped once (WI-9476 defect #1): a probe
    // that never ran reporting as one that ran and found nothing. Both halves
    // are asserted together on purpose — the pair is what makes the regression
    // visible, since either alone reads as correct.
    let called = false;
    const r = await probePlanSlugs('   !!!   ', {
      searchPlans: async () => {
        called = true;
        return [];
      },
    });
    expect(called).toBe(false);
    expect(r.searched).toBe(false);
    expect(r.unavailableReason).toMatch(/never called/);
  });

  it('tolerates a backend returning null', async () => {
    const r = await probePlanSlugs(WORKED_IDEA, {
      searchPlans: async () => null as unknown as PlanRecord[],
    });
    expect(r.searched).toBe(true);
    expect(r.planMatches).toEqual([]);
  });
});

describe('summarisePlanSlugLeg — wording must not invite a close', () => {
  it('says an unavailable leg is NOT evidence of absence', () => {
    const s = summarisePlanSlugLeg({
      planMatches: [],
      searched: false,
      unavailableReason: 'boom',
    });
    expect(s).toMatch(/UNAVAILABLE/);
    expect(s).toMatch(/NOT evidence of absence/);
  });

  it('leads with SHIPPED plans and tells the reader to read them', async () => {
    const r = await probePlanSlugs(WORKED_IDEA, {
      searchPlans: async () => [{ slug: WORKED_PLAN_SLUG, status: 'shipped' }],
    });
    const s = summarisePlanSlugLeg(r);
    expect(s).toMatch(/SHIPPED/);
    expect(s).toContain(WORKED_PLAN_SLUG);
  });

  it('marks a match on a non-shipped plan as context, NOT prior art', async () => {
    // The regression that matters: an `active` or `superseded` plan must never
    // be summarised in language a reader could act on as "already built".
    for (const status of ['active', 'superseded', 'draft']) {
      const r = await probePlanSlugs(WORKED_IDEA, {
        searchPlans: async () => [{ slug: WORKED_PLAN_SLUG, status }],
      });
      const s = summarisePlanSlugLeg(r);
      expect(s).toMatch(/none shipped/);
      expect(s).toMatch(/not prior art/);
      expect(s).not.toMatch(/SHIPPED plan/);
    }
  });

  it('reports a genuine empty result plainly', () => {
    expect(summarisePlanSlugLeg({ planMatches: [], searched: true })).toMatch(/no plan name overlaps/);
  });
});

describe('leg separation', () => {
  it('reports matches in its OWN field, never merged into another leg', async () => {
    const r = await probePlanSlugs(WORKED_IDEA, {
      searchPlans: async () => [{ slug: WORKED_PLAN_SLUG, status: 'shipped' }],
    });
    // The whole point of a separate leg is that its precision stays separately
    // measurable. These field names are the contract with the consumer.
    expect(Object.keys(r).sort()).toEqual(['planMatches', 'searched']);
    expect(r).not.toHaveProperty('matches');
    expect(r).not.toHaveProperty('semantic');
  });

  it('keeps the generic stoplist small enough to stay non-suppressive', () => {
    // An over-eager stoplist suppresses real bridges, which is the failure
    // direction that costs a duplicate build. This is a ratchet, not a target.
    expect(GENERIC_SLUG_TOKENS.size).toBeLessThanOrEqual(30);
    // The worked case's discriminating tokens must never be stopped.
    for (const t of ['consume', 'edges', 'orphaned', 'dispatch']) {
      expect(GENERIC_SLUG_TOKENS.has(t)).toBe(false);
    }
  });
});
