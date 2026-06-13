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
  frontierRowToCandidate,
  planToCandidate,
  resolveHiveMembership,
  surveyHive,
  type FrontierRow,
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
  const depsFor = (over: Partial<SurveyDeps>): Partial<SurveyDeps> => ({ now: () => NOW, ...over });

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
});
