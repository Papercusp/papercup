/**
 * Unit tests for the Queen's plan-aware survey (queen-autonomous-execution B-08:
 * P-010 plan consumption + the P-012 member-harness fix). The PG reads are
 * injected, so the membership resolution, candidate builders, and the
 * home-only-blind-spot guard test with no database. The real cross-member SQL
 * is pinned by survey.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { PlanIndexRow } from '../agent-tools/plans/source';
import {
  filterReadyFrontier,
  frontierInEligiblePlans,
  frontierRowToCandidate,
  planToCandidate,
  resolveHiveMembership,
  surveyHive,
  type FrontierRow,
  type HarnessBlockGraph,
  type SurveyDeps,
} from './survey';

const NOW = 1_000_000_000_000;
const daysAgo = (d: number) => NOW - d * 86_400_000;

function planRow(over: Partial<PlanIndexRow>): PlanIndexRow {
  return {
    planSlug: 'p',
    harnessSlug: 'h',
    title: 'A plan',
    status: 'active',
    opStatus: 'started',
    opStartedAt: null,
    opUpdatedAt: new Date(daysAgo(1)).toISOString(),
    opPriority: null,
    currentWave: null,
    updatedAt: new Date(daysAgo(1)).toISOString(),
    archived: false,
    isLegacy: false,
    created: null,
    updated: null,
    owner: null,
    supersedes: [],
    supersededBy: null,
    contentHash: 'x',
    version: 1,
    items: [],
    decisions: [],
    nowState: null,
    nowNext: null,
    ...over,
  } as unknown as PlanIndexRow;
}

const frontierRow = (over: Partial<FrontierRow>): FrontierRow => ({
  feature_id: 'WI-1',
  harness_slug: 'h',
  title: 'an item',
  item_kind: 'feature',
  created_ts: daysAgo(1),
  feature_order: null,
  plan_slug: null,
  ...over,
});

describe('resolveHiveMembership (P-012)', () => {
  it('resolves member harnesses from the registry hive_slug, home first, members listed', async () => {
    const m = await resolveHiveMembership('default', 'papercup-hive', async () => ({
      projects: [
        { slug: 'papercup', hive_slug: 'papercup-hive' },
        { slug: 'restart', hive_slug: 'papercup-hive' },
        { slug: 'other', hive_slug: 'other-hive' },
        { slug: 'papercup-hive' }, // the home seat itself — not a member
      ],
    }));
    expect(m.members.sort()).toEqual(['papercup', 'restart']);
    expect(m.surveySlugs).toEqual(['papercup-hive', 'papercup', 'restart']);
    expect(m.scope).toBe('members');
  });

  it('falls back to a WORKSPACE-WIDE survey when no member is wired (the home-only-blind-spot guard)', async () => {
    const m = await resolveHiveMembership('default', 'papercup-hive', async () => ({
      projects: [{ slug: 'papercup-hive' }, { slug: 'papercup' }], // nobody points at the hive
    }));
    expect(m.members).toEqual([]);
    expect(m.surveySlugs).toEqual([]); // [] ⇒ survey workspace-wide, never home-only
    expect(m.scope).toBe('workspace');
  });
});

describe('planToCandidate (P-010)', () => {
  it('maps a STARTED plan: hottest-open importance, needs-human → escalations, todo+wip → openItems', () => {
    const c = planToCandidate(
      planRow({
        planSlug: 'queen-plan',
        harnessSlug: 'papercup',
        opPriority: 3,
        items: [
          { id: 'P-001', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null },
          { id: 'P-002', status: 'wip', text: '', importance: 'normal', blockedBy: [], decisionRefs: [], phase: null },
          { id: 'P-003', status: 'needs-human', text: '', importance: 'urgent', blockedBy: [], decisionRefs: [], phase: null },
          { id: 'P-004', status: 'done', text: '', importance: 'urgent', blockedBy: [], decisionRefs: [], phase: null },
        ],
      }),
      NOW,
    )!;
    expect(c.view).toBe('plan');
    expect(c.id).toBe('queen-plan');
    expect(c.harness).toBe('papercup');
    expect(c.importance).toBe('urgent'); // hottest OPEN item (P-003), done urgent excluded counts too but it's open anyway
    expect(c.openItems).toBe(2); // todo + wip
    expect(c.escalations).toBe(1); // needs-human
    expect(c.opPriority).toBe(3);
  });

  it('returns null for a plan that is not operationally started (paused / done / terminal)', () => {
    expect(planToCandidate(planRow({ opStatus: 'paused' }), NOW)).toBeNull();
    expect(planToCandidate(planRow({ opStatus: 'done' }), NOW)).toBeNull();
    expect(planToCandidate(planRow({ opStatus: null }), NOW)).toBeNull();
    // terminal lifecycle reconciles a stale started row to done → null
    expect(planToCandidate(planRow({ opStatus: 'started', status: 'shipped' }), NOW)).toBeNull();
  });

  it('SURFACES an unstarted eligible plan when includeUnstarted (needsStart); excludes terminal even then (P-B1)', () => {
    // unstarted + active + eligible ⇒ surfaced, flagged needsStart (the self-feed)
    const surfaced = planToCandidate(planRow({ opStatus: null, status: 'active' }), NOW, { includeUnstarted: true });
    expect(surfaced).not.toBeNull();
    expect(surfaced!.needsStart).toBe(true);
    // a STARTED plan is never flagged needsStart, even with includeUnstarted
    expect(planToCandidate(planRow({ opStatus: 'started' }), NOW, { includeUnstarted: true })!.needsStart).toBeUndefined();
    // terminal (shipped/superseded) is excluded even when eligible
    expect(planToCandidate(planRow({ opStatus: null, status: 'shipped' }), NOW, { includeUnstarted: true })).toBeNull();
    expect(planToCandidate(planRow({ opStatus: null, status: 'superseded' }), NOW, { includeUnstarted: true })).toBeNull();
    // without includeUnstarted, an unstarted plan stays invisible (default behaviour)
    expect(planToCandidate(planRow({ opStatus: null, status: 'active' }), NOW)).toBeNull();
  });

  it("defaults a started plan with no open items to 'normal' importance", () => {
    const c = planToCandidate(planRow({ items: [] }), NOW)!;
    expect(c.importance).toBe('normal');
    expect(c.openItems).toBe(0);
  });
});

describe('frontierRowToCandidate', () => {
  it('maps an unplaced work-item row, importance normal, op_priority from feature_order', () => {
    const c = frontierRowToCandidate(frontierRow({ feature_id: 'WI-9', harness_slug: 'papercup', feature_order: 7 }), NOW);
    expect(c).toMatchObject({ id: 'WI-9', view: 'work-item', harness: 'papercup', importance: 'normal', opPriority: 7 });
    expect(c.ageDays).toBeCloseTo(1, 5);
  });
});

describe('surveyHive (P-012 regression)', () => {
  const noBlockers: HarnessBlockGraph = { blockers: new Map(), statuses: new Map() };
  const depsFor = (over: Partial<SurveyDeps>): Partial<SurveyDeps> => ({
    now: () => NOW,
    fetchBlockGraph: async () => noBlockers,
    ...over,
  });

  it('surfaces a MEMBER harness work-item even though the home seat is empty (the 2026-06-11 bug)', async () => {
    const calls: { planSlugs: string[]; frontierScope: readonly string[] } = { planSlugs: [], frontierScope: [] };
    const survey = await surveyHive('default', 'papercup-hive', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }, { slug: 'papercup-hive' }] }),
        listPlanRows: async (slug) => {
          calls.planSlugs.push(slug);
          // The home seat has no started plan; the member does.
          return slug === 'papercup'
            ? [planRow({ planSlug: 'member-plan', harnessSlug: 'papercup', items: [{ id: 'P-1', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null }] })]
            : [];
        },
        fetchFrontier: async (surveySlugs) => {
          calls.frontierScope = surveySlugs;
          // a freshly-filed member work-item — the thing the buggy home-only survey slept through
          return [frontierRow({ feature_id: 'WI-MEMBER', harness_slug: 'papercup' })];
        },
      }),
    });

    // The member's started plan AND its unplaced work-item BOTH surface.
    expect(survey.frontier.map((c) => c.id)).toContain('WI-MEMBER');
    expect(survey.plans.map((c) => c.id)).toContain('member-plan');
    // It surveyed the member, not just the home seat.
    expect(calls.planSlugs).toContain('papercup');
    expect(calls.frontierScope).toEqual(['papercup-hive', 'papercup']);
    expect(survey.scope).toBe('members');
  });

  it('runs a workspace-wide survey (frontier scope []) when membership is not wired', async () => {
    let frontierScope: readonly string[] | null = null;
    const survey = await surveyHive('default', 'papercup-hive', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup-hive' }, { slug: 'papercup' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async (surveySlugs) => {
          frontierScope = surveySlugs;
          return [];
        },
      }),
    });
    expect(frontierScope).toEqual([]); // [] ⇒ workspace-wide, never home-only
    expect(survey.scope).toBe('workspace');
  });

  it('ranks both views through the one ranker (urgent member plan leads its view)', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [
                planRow({ planSlug: 'low-plan', harnessSlug: 'papercup', items: [{ id: 'a', status: 'todo', text: '', importance: 'low', blockedBy: [], decisionRefs: [], phase: null }] }),
                planRow({ planSlug: 'urgent-plan', harnessSlug: 'papercup', items: [{ id: 'b', status: 'todo', text: '', importance: 'urgent', blockedBy: [], decisionRefs: [], phase: null }] }),
              ]
            : [],
        fetchFrontier: async () => [],
      }),
    });
    expect(survey.plans[0].id).toBe('urgent-plan');
    expect(survey.plans[0].rank.score).toBeGreaterThan(survey.plans[1].rank.score);
  });

  // ── blocked_by readiness (W-01 / P-010) ──────────────────────────────────
  it('holds back a frontier lane whose blocker is still in flight, surfaces it once the blocker passes', async () => {
    const common = {
      loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
      listPlanRows: async () => [],
    };

    // Phase 1 — tier1 (WI-1) + tier2 (WI-2, blocked_by WI-1) are both unplaced
    // todo lanes; WI-1 is in flight (todo), so WI-2 is held back.
    const blocked = await surveyHive('default', 'papercup-hive', {
      deps: depsFor({
        ...common,
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup' }),
          frontierRow({ feature_id: 'WI-2', harness_slug: 'papercup' }),
        ],
        fetchBlockGraph: async () => ({ blockers: new Map([['WI-2', ['WI-1']]]), statuses: new Map([['WI-1', 'todo']]) }),
      }),
    });
    expect(blocked.frontier.map((c) => c.id)).toEqual(['WI-1']);
    expect(blocked.frontierBlocked).toBe(1);

    // Phase 2 — WI-1 has passed, so it drops out of the todo frontier; WI-2's
    // blocker is now terminal (resolved via the block-graph statuses) → it surfaces.
    const ready = await surveyHive('default', 'papercup-hive', {
      deps: depsFor({
        ...common,
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-2', harness_slug: 'papercup' })],
        fetchBlockGraph: async () => ({ blockers: new Map([['WI-2', ['WI-1']]]), statuses: new Map([['WI-1', 'passed']]) }),
      }),
    });
    expect(ready.frontier.map((c) => c.id)).toEqual(['WI-2']);
    expect(ready.frontierBlocked).toBe(0);
  });

  // ── scopeFilter: pause + scope enforcement (queen-steering-panel C-2 / P-003) ──
  const planItem = (id: string) => ({ id, status: 'todo' as const, text: '', importance: 'high' as const, blockedBy: [], decisionRefs: [], phase: null });

  it('pauseNewWork empties the FRONTIER (no new work) but keeps started-plan momentum', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      scopeFilter: { pauseNewWork: true },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup' ? [planRow({ planSlug: 'p1', harnessSlug: 'papercup', items: [planItem('a')] })] : [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup' })],
      }),
    });
    expect(survey.frontier).toEqual([]); // new unplaced work withheld while paused
    expect(survey.plans.map((c) => c.id)).toContain('p1'); // existing plan momentum continues
  });

  it('pausedUntil empties the frontier while now < pausedUntil, restores it once expired', async () => {
    const mkDeps = () =>
      depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup' })],
      });
    const paused = await surveyHive('default', 'papercup-hive', { scopeFilter: { pausedUntil: NOW + 60_000 }, deps: mkDeps() });
    expect(paused.frontier).toEqual([]);
    const resumed = await surveyHive('default', 'papercup-hive', { scopeFilter: { pausedUntil: NOW - 1 }, deps: mkDeps() });
    expect(resumed.frontier.map((c) => c.id)).toContain('WI-1');
  });

  it('allowedHarnesses restricts the frontier to the allowed harness(es)', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      scopeFilter: { allowedHarnesses: ['papercup'] },
      deps: depsFor({
        loadRegistry: async () => ({
          projects: [
            { slug: 'papercup', hive_slug: 'papercup-hive' },
            { slug: 'other', hive_slug: 'papercup-hive' },
          ],
        }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-IN', harness_slug: 'papercup' }),
          frontierRow({ feature_id: 'WI-OUT', harness_slug: 'other' }),
        ],
      }),
    });
    const ids = survey.frontier.map((c) => c.id);
    expect(ids).toContain('WI-IN');
    expect(ids).not.toContain('WI-OUT');
  });

  it('eligiblePlans restricts the PLAN view to the eligible plan slug(s)', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      scopeFilter: { eligiblePlans: ['keep-plan'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [
                planRow({ planSlug: 'keep-plan', harnessSlug: 'papercup', items: [planItem('a')] }),
                planRow({ planSlug: 'drop-plan', harnessSlug: 'papercup', items: [planItem('b')] }),
              ]
            : [],
        fetchFrontier: async () => [],
      }),
    });
    const ids = survey.plans.map((c) => c.id);
    expect(ids).toContain('keep-plan');
    expect(ids).not.toContain('drop-plan');
  });

  // ── eligiblePlans HARD-filters the FRONTIER too (queen-steering-panel P-008) ──
  it('eligiblePlans is a STRICT scope: keeps ONLY eligible-plan frontier rows, drops ineligible AND unplanned (owner 2026-06-16)', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      scopeFilter: { eligiblePlans: ['keep-plan'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-KEEP', harness_slug: 'papercup', plan_slug: 'keep-plan' }),
          frontierRow({ feature_id: 'WI-DROP', harness_slug: 'papercup', plan_slug: 'other-plan' }),
          frontierRow({ feature_id: 'WI-UNPLANNED', harness_slug: 'papercup', plan_slug: null }),
        ],
      }),
    });
    const ids = survey.frontier.map((c) => c.id);
    expect(ids).toContain('WI-KEEP'); // minted from the eligible plan
    expect(ids).not.toContain('WI-UNPLANNED'); // unplanned work belongs to no eligible plan → dropped under a restriction
    expect(ids).not.toContain('WI-DROP'); // minted from a non-eligible plan → dropped at the source
  });

  it('no eligiblePlans restriction keeps every frontier row regardless of source plan (P-008 no-op)', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      scopeFilter: {},
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup', plan_slug: 'any-plan' }),
          frontierRow({ feature_id: 'WI-2', harness_slug: 'papercup', plan_slug: null }),
        ],
      }),
    });
    expect(survey.frontier.map((c) => c.id).sort()).toEqual(['WI-1', 'WI-2']);
  });

  it('an empty/absent scopeFilter is a no-op (full survey)', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      scopeFilter: {},
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup' })],
      }),
    });
    expect(survey.frontier.map((c) => c.id)).toContain('WI-1');
  });

  // ── self-feed: eligiblePlans SURFACES unstarted eligible plans (queen-autonomy-and-selffeed C-1 / P-B1) ──
  it('eligiblePlans surfaces an active-but-UNSTARTED plan (self-feed, needsStart)', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      scopeFilter: { eligiblePlans: ['unstarted-eligible'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [planRow({ planSlug: 'unstarted-eligible', harnessSlug: 'papercup', opStatus: null, status: 'active', items: [planItem('a')] })]
            : [],
        fetchFrontier: async () => [],
      }),
    });
    const plan = survey.plans.find((c) => c.id === 'unstarted-eligible');
    expect(plan).toBeDefined();
    expect(plan!.needsStart).toBe(true);
  });

  it('an UN-STEERED survey does NOT surface an unstarted plan (invariant a — only started plans show)', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup' ? [planRow({ planSlug: 'unstarted', harnessSlug: 'papercup', opStatus: null, status: 'active', items: [planItem('a')] })] : [],
        fetchFrontier: async () => [],
      }),
    });
    expect(survey.plans.map((c) => c.id)).not.toContain('unstarted');
  });

  it('a TERMINAL plan in eligiblePlans is NOT surfaced', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      scopeFilter: { eligiblePlans: ['shipped-plan'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup' ? [planRow({ planSlug: 'shipped-plan', harnessSlug: 'papercup', opStatus: null, status: 'shipped', items: [planItem('a')] })] : [],
        fetchFrontier: async () => [],
      }),
    });
    expect(survey.plans.map((c) => c.id)).not.toContain('shipped-plan');
  });

  it('a STARTED plan NOT in eligiblePlans stays filtered out (invariant b)', async () => {
    const survey = await surveyHive('default', 'papercup-hive', {
      scopeFilter: { eligiblePlans: ['keep'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-hive' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [
                planRow({ planSlug: 'keep', harnessSlug: 'papercup', opStatus: 'started', items: [planItem('a')] }),
                planRow({ planSlug: 'other-started', harnessSlug: 'papercup', opStatus: 'started', items: [planItem('b')] }),
              ]
            : [],
        fetchFrontier: async () => [],
      }),
    });
    const ids = survey.plans.map((c) => c.id);
    expect(ids).toContain('keep');
    expect(ids).not.toContain('other-started');
  });
});

describe('filterReadyFrontier (W-01 / P-010 — the shared readiness, pure)', () => {
  const row = (id: string, harness = 'h'): FrontierRow => frontierRow({ feature_id: id, harness_slug: harness });

  it('keeps every row when a harness has no blockers', () => {
    const { ready, blockedCount } = filterReadyFrontier([row('A'), row('B')], new Map());
    expect(ready.map((r) => r.feature_id)).toEqual(['A', 'B']);
    expect(blockedCount).toBe(0);
  });

  it('drops a lane with a non-terminal blocker, keeps one whose blocker is absent or passed', () => {
    const graph: HarnessBlockGraph = {
      blockers: new Map([['blocked', ['mid']], ['gone', ['ghost']], ['done-dep', ['fin']]]),
      statuses: new Map([['mid', 'wip'], ['fin', 'passed']]), // 'ghost' unresolved ⇒ absent ⇒ satisfied
    };
    const { ready, blockedCount } = filterReadyFrontier(
      [row('blocked'), row('gone'), row('done-dep'), row('free')],
      new Map([['h', graph]]),
    );
    expect(ready.map((r) => r.feature_id).sort()).toEqual(['done-dep', 'free', 'gone']);
    expect(blockedCount).toBe(1);
  });

  it('computes readiness per-harness (ids are not globally unique)', () => {
    const ha: HarnessBlockGraph = { blockers: new Map([['F-1', ['F-0']]]), statuses: new Map([['F-0', 'wip']]) };
    const hb: HarnessBlockGraph = { blockers: new Map(), statuses: new Map() };
    const { ready } = filterReadyFrontier(
      [row('F-1', 'a'), row('F-1', 'b')], // same id, different harness
      new Map([['a', ha], ['b', hb]]),
    );
    // a/F-1 is blocked; b/F-1 has no blockers → only b's survives.
    expect(ready.map((r) => r.harness_slug)).toEqual(['b']);
  });
});

describe('frontierInEligiblePlans (queen-steering-panel P-008 — the frontier plan HARD-filter, pure)', () => {
  it('no eligible-plans list ⇒ keep everything (un-steered survey is unchanged)', () => {
    expect(frontierInEligiblePlans('p', undefined)).toBe(true);
    expect(frontierInEligiblePlans('p', {})).toBe(true);
    expect(frontierInEligiblePlans('p', { eligiblePlans: [] })).toBe(true);
  });

  it('with a list: keeps a row from an eligible plan, drops a row from a non-eligible plan', () => {
    expect(frontierInEligiblePlans('keep', { eligiblePlans: ['keep'] })).toBe(true);
    expect(frontierInEligiblePlans('drop', { eligiblePlans: ['keep'] })).toBe(false);
  });

  it('DROPS an UNPLANNED row (null/undefined source plan) under a restriction — strict scope (owner 2026-06-16)', () => {
    expect(frontierInEligiblePlans(null, { eligiblePlans: ['keep'] })).toBe(false);
    expect(frontierInEligiblePlans(undefined, { eligiblePlans: ['keep'] })).toBe(false);
    // ...but with NO restriction, unplanned work still passes:
    expect(frontierInEligiblePlans(null, { eligiblePlans: [] })).toBe(true);
    expect(frontierInEligiblePlans(undefined, {})).toBe(true);
  });
});
