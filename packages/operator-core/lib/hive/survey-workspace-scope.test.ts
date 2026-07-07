/**
 * survey-workspace-scope.test.ts — P-003 Phase B (workspace-scoped-coordination-
 * 2026-06-20, D-002): the CROSS-HIVE DISPATCH WIDENING. The central-dispatcher
 * Queen's survey + placement-routing re-keyed from one hive to the whole
 * workspace, gated on FLAGS.WORKSPACE_COORDINATION. The Queen-side companion to
 * started-workspace-scope.ts (Phase A re-key of the started bit).
 *
 *   - surveyWorkspace: per-hive sections (focused ideation, D-004 dilution
 *     mitigation) + ONE cross-hive ranked backlog (merged + re-ranked through the
 *     ONE placement registry), every candidate carrying its `hive` tag (P-001
 *     source/target-hive routing).
 *   - pot:survey tool: ON ⇒ the cross-hive shape (perHive + crossHive); OFF (the
 *     dark default) ⇒ the single-hive survey, BYTE-IDENTICAL to today.
 *   - fleet:place_batch routeByHive: tally a batch's target hives by the
 *     harness→hive tag (routing VISIBILITY; the per-task harness already routes).
 *
 * Hermetic: surveyWorkspace's `listHiveSlugs` + per-hive `deps` are injected and
 * the flag/registry edges are mocked, so this pins the WIDENING DECISION (not the
 * DB). The single-hive survey itself is covered by survey.test.ts; the pure
 * sentinel math by workspace-brain-scope.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { PlanIndexRow } from '../agent-tools/plans/source';
import {
  surveyWorkspace,
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

const planItem = (id: string, importance: 'low' | 'normal' | 'high' | 'urgent' = 'high') => ({
  id,
  status: 'todo' as const,
  text: '',
  importance,
  blockedBy: [],
  decisionRefs: [],
  phase: null,
});

const noBlockers: HarnessBlockGraph = { blockers: new Map(), statuses: new Map() };

/**
 * Build a per-hive SurveyDeps stub. Each hive home maps to a member harness whose
 * plan + frontier rows are supplied; the registry only wires that hive's member so
 * surveyHive scopes to it (the membership-based scope, never workspace-wide
 * fallback that would let hives bleed into each other).
 */
function depsForHives(
  hives: Record<string, { member: string; plans: PlanIndexRow[]; frontier: FrontierRow[] }>,
): Partial<SurveyDeps> {
  const allProjects = Object.entries(hives).flatMap(([home, { member }]) => [
    { slug: home, hive_slug: undefined as string | undefined },
    { slug: member, hive_slug: home },
  ]);
  return {
    now: () => NOW,
    fetchBlockGraph: async () => noBlockers,
    loadRegistry: async () => ({ projects: allProjects }),
    listPlanRows: async (slug) => {
      for (const { member, plans } of Object.values(hives)) {
        if (slug === member) return plans;
      }
      return [];
    },
    fetchFrontier: async (surveySlugs) => {
      // surveySlugs is this hive's member set; return the frontier of whichever
      // hive's member is in scope (the per-hive scoping under test).
      for (const { member, frontier } of Object.values(hives)) {
        if (surveySlugs.includes(member)) return frontier;
      }
      return [];
    },
  };
}

const WS = 'papercusp-workspace';

describe('surveyWorkspace — per-hive sections (P-003 Phase B)', () => {
  it('surveys EACH workspace hive individually, returning one section per hive', async () => {
    const ws = await surveyWorkspace(WS, {
      listHiveSlugs: async () => ['hive-a', 'hive-b'],
      deps: depsForHives({
        'hive-a': {
          member: 'proj-a',
          plans: [planRow({ planSlug: 'plan-a', harnessSlug: 'proj-a', items: [planItem('x', 'high')] })],
          frontier: [frontierRow({ feature_id: 'WI-A', harness_slug: 'proj-a' })],
        },
        'hive-b': {
          member: 'proj-b',
          plans: [planRow({ planSlug: 'plan-b', harnessSlug: 'proj-b', items: [planItem('y', 'low')] })],
          frontier: [frontierRow({ feature_id: 'WI-B', harness_slug: 'proj-b' })],
        },
      }),
    });

    expect(ws.hives).toEqual(['hive-a', 'hive-b']);
    expect(ws.perHive.map((s) => s.hive)).toEqual(['hive-a', 'hive-b']);
    // Each section is its OWN hive's survey — focused, never the other hive's work.
    const a = ws.perHive.find((s) => s.hive === 'hive-a')!.survey;
    const b = ws.perHive.find((s) => s.hive === 'hive-b')!.survey;
    expect(a.plans.map((c) => c.id)).toEqual(['plan-a']);
    expect(a.frontier.map((c) => c.id)).toEqual(['WI-A']);
    expect(b.plans.map((c) => c.id)).toEqual(['plan-b']);
    expect(b.frontier.map((c) => c.id)).toEqual(['WI-B']);
  });
});

describe('surveyWorkspace — the cross-hive ranked backlog (P-003 Phase B / D-002)', () => {
  it('merges every hive into ONE ranked priority, hive-tagged for routing', async () => {
    const ws = await surveyWorkspace(WS, {
      listHiveSlugs: async () => ['hive-a', 'hive-b'],
      deps: depsForHives({
        'hive-a': {
          member: 'proj-a',
          // a LOW-importance plan
          plans: [planRow({ planSlug: 'low-plan', harnessSlug: 'proj-a', items: [planItem('x', 'low')] })],
          frontier: [frontierRow({ feature_id: 'WI-A', harness_slug: 'proj-a' })],
        },
        'hive-b': {
          member: 'proj-b',
          // an URGENT plan — must out-rank hive-a's low plan in the cross-hive view
          plans: [planRow({ planSlug: 'urgent-plan', harnessSlug: 'proj-b', items: [planItem('y', 'urgent')] })],
          frontier: [frontierRow({ feature_id: 'WI-B', harness_slug: 'proj-b' })],
        },
      }),
    });

    // The cross-hive plan view holds BOTH hives' plans, ranked across hives — the
    // urgent plan (hive-b) leads the low plan (hive-a). A single ordering, not a
    // per-hive concat.
    expect(ws.crossHive.plans.map((c) => c.id)).toEqual(['urgent-plan', 'low-plan']);
    expect(ws.crossHive.plans[0].rank.score).toBeGreaterThan(ws.crossHive.plans[1].rank.score);
    // The cross-hive frontier holds BOTH hives' work-items.
    expect(ws.crossHive.frontier.map((c) => c.id).sort()).toEqual(['WI-A', 'WI-B']);

    // Every cross-hive candidate carries its SOURCE/TARGET-hive tag (P-001) so the
    // placement path routes it onto the right hive's bees.
    const tagOf = (id: string) =>
      [...ws.crossHive.plans, ...ws.crossHive.frontier].find((c) => c.id === id)?.hive;
    expect(tagOf('urgent-plan')).toBe('hive-b');
    expect(tagOf('low-plan')).toBe('hive-a');
    expect(tagOf('WI-A')).toBe('hive-a');
    expect(tagOf('WI-B')).toBe('hive-b');
  });

  it('de-dups workspace-fallback frontier echoes and keeps the member-scoped hive tag', async () => {
    const ws = await surveyWorkspace(WS, {
      // The pass-through hive is first to prove a later member-scoped row
      // replaces its workspace-wide echo for the same real work item.
      listHiveSlugs: async () => ['pass-through-hive', 'real-hive'],
      deps: {
        now: () => NOW,
        loadRegistry: async () => ({
          projects: [
            { slug: 'pass-through-hive' },
            { slug: 'real-hive' },
            { slug: 'real-proj', hive_slug: 'real-hive' },
          ],
        }),
        listPlanRows: async () => [],
        fetchFrontier: async (surveySlugs) =>
          surveySlugs.includes('real-proj')
            ? [frontierRow({ feature_id: 'WI-A', harness_slug: 'real-proj' })]
            : [
                frontierRow({ feature_id: 'WI-A', harness_slug: 'real-proj' }),
                frontierRow({ feature_id: 'WI-B', harness_slug: 'loose-proj' }),
              ],
        fetchBlockGraph: async () => noBlockers,
      },
    });

    expect(ws.perHive.find((s) => s.hive === 'pass-through-hive')!.survey.scope).toBe('workspace');
    expect(ws.perHive.find((s) => s.hive === 'real-hive')!.survey.scope).toBe('members');
    expect(ws.crossHive.frontier.map((c) => c.id).sort()).toEqual(['WI-A', 'WI-B']);
    expect(ws.crossHive.frontier.filter((c) => c.id === 'WI-A')).toHaveLength(1);
    expect(ws.crossHive.frontier.find((c) => c.id === 'WI-A')?.hive).toBe('real-hive');
  });

  it('sums frontierBlocked across all hives', async () => {
    const ws = await surveyWorkspace(WS, {
      listHiveSlugs: async () => ['hive-a', 'hive-b'],
      deps: {
        now: () => NOW,
        loadRegistry: async () => ({
          projects: [
            { slug: 'hive-a' }, { slug: 'proj-a', hive_slug: 'hive-a' },
            { slug: 'hive-b' }, { slug: 'proj-b', hive_slug: 'hive-b' },
          ],
        }),
        listPlanRows: async () => [],
        // each hive has a tier2 lane blocked by an in-flight tier1
        fetchFrontier: async (surveySlugs) =>
          surveySlugs.includes('proj-a')
            ? [frontierRow({ feature_id: 'WI-A1', harness_slug: 'proj-a' }), frontierRow({ feature_id: 'WI-A2', harness_slug: 'proj-a' })]
            : [frontierRow({ feature_id: 'WI-B1', harness_slug: 'proj-b' }), frontierRow({ feature_id: 'WI-B2', harness_slug: 'proj-b' })],
        fetchBlockGraph: async (harness) =>
          harness === 'proj-a'
            ? { blockers: new Map([['WI-A2', ['WI-A1']]]), statuses: new Map([['WI-A1', 'todo']]) }
            : { blockers: new Map([['WI-B2', ['WI-B1']]]), statuses: new Map([['WI-B1', 'todo']]) },
      },
    });
    expect(ws.crossHive.frontierBlocked).toBe(2); // one held-back lane per hive
    expect(ws.crossHive.frontier.map((c) => c.id).sort()).toEqual(['WI-A1', 'WI-B1']);
  });

  it('falls back to surveying the supplied home hive alone when no hive resolves', async () => {
    const ws = await surveyWorkspace(WS, {
      listHiveSlugs: async () => [],
      fallbackHome: 'lonely-hive',
      deps: depsForHives({
        'lonely-hive': {
          member: 'proj-lonely',
          plans: [planRow({ planSlug: 'lp', harnessSlug: 'proj-lonely', items: [planItem('z')] })],
          frontier: [frontierRow({ feature_id: 'WI-L', harness_slug: 'proj-lonely' })],
        },
      }),
    });
    expect(ws.hives).toEqual(['lonely-hive']);
    expect(ws.perHive).toHaveLength(1);
    expect(ws.crossHive.frontier.map((c) => c.id)).toEqual(['WI-L']);
  });

  it('de-dups a hive listed twice (workspace==hive shape stays one section)', async () => {
    const ws = await surveyWorkspace(WS, {
      listHiveSlugs: async () => ['hive-a', 'hive-a'],
      deps: depsForHives({
        'hive-a': { member: 'proj-a', plans: [], frontier: [frontierRow({ feature_id: 'WI-A', harness_slug: 'proj-a' })] },
      }),
    });
    expect(ws.hives).toEqual(['hive-a']);
    expect(ws.perHive).toHaveLength(1);
    expect(ws.crossHive.frontier.map((c) => c.id)).toEqual(['WI-A']);
  });
});
