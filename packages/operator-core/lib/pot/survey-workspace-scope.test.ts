/**
 * survey-workspace-scope.test.ts — P-003 Phase B (workspace-scoped-coordination-
 * 2026-06-20, D-002): the CROSS-POT DISPATCH WIDENING. The central-dispatcher
 * Mug's survey + placement-routing re-keyed from one pot to the whole
 * workspace, gated on FLAGS.WORKSPACE_COORDINATION. The Mug-side companion to
 * started-workspace-scope.ts (Phase A re-key of the started bit).
 *
 *   - surveyWorkspace: per-pot sections (focused ideation, D-004 dilution
 *     mitigation) + ONE cross-pot ranked backlog (merged + re-ranked through the
 *     ONE placement registry), every candidate carrying its `hive` tag (P-001
 *     source/target-pot routing).
 *   - pot:survey tool: ON ⇒ the cross-pot shape (perPot + crossPot); OFF (the
 *     dark default) ⇒ the single-pot survey, BYTE-IDENTICAL to today.
 *   - fleet:place_batch routeByPot: tally a batch's target hives by the
 *     harness→pot tag (routing VISIBILITY; the per-task harness already routes).
 *
 * Hermetic: surveyWorkspace's `listPotSlugs` + per-pot `deps` are injected and
 * the flag/registry edges are mocked, so this pins the WIDENING DECISION (not the
 * DB). The single-pot survey itself is covered by survey.test.ts; the pure
 * papercup math by workspace-brain-scope.test.ts.
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
 * Build a per-pot SurveyDeps stub. Each pot home maps to a member harness whose
 * plan + frontier rows are supplied; the registry only wires that pot's member so
 * surveyPot scopes to it (the membership-based scope, never workspace-wide
 * fallback that would let hives bleed into each other).
 */
function depsForPots(
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
      // surveySlugs is this pot's member set; return the frontier of whichever
      // pot's member is in scope (the per-pot scoping under test).
      for (const { member, frontier } of Object.values(hives)) {
        if (surveySlugs.includes(member)) return frontier;
      }
      return [];
    },
  };
}

const WS = 'papercusp-workspace';

describe('surveyWorkspace — per-pot sections (P-003 Phase B)', () => {
  it('surveys EACH workspace pot individually, returning one section per pot', async () => {
    const ws = await surveyWorkspace(WS, {
      listPotSlugs: async () => ['pot-a', 'pot-b'],
      deps: depsForPots({
        'pot-a': {
          member: 'proj-a',
          plans: [planRow({ planSlug: 'plan-a', harnessSlug: 'proj-a', items: [planItem('x', 'high')] })],
          frontier: [frontierRow({ feature_id: 'WI-A', harness_slug: 'proj-a' })],
        },
        'pot-b': {
          member: 'proj-b',
          plans: [planRow({ planSlug: 'plan-b', harnessSlug: 'proj-b', items: [planItem('y', 'low')] })],
          frontier: [frontierRow({ feature_id: 'WI-B', harness_slug: 'proj-b' })],
        },
      }),
    });

    expect(ws.hives).toEqual(['pot-a', 'pot-b']);
    expect(ws.perPot.map((s) => s.pot)).toEqual(['pot-a', 'pot-b']);
    // Each section is its OWN pot's survey — focused, never the other pot's work.
    const a = ws.perPot.find((s) => s.pot === 'pot-a')!.survey;
    const b = ws.perPot.find((s) => s.pot === 'pot-b')!.survey;
    expect(a.plans.map((c) => c.id)).toEqual(['plan-a']);
    expect(a.frontier.map((c) => c.id)).toEqual(['WI-A']);
    expect(b.plans.map((c) => c.id)).toEqual(['plan-b']);
    expect(b.frontier.map((c) => c.id)).toEqual(['WI-B']);
  });
});

describe('surveyWorkspace — the cross-pot ranked backlog (P-003 Phase B / D-002)', () => {
  it('merges every pot into ONE ranked priority, pot-tagged for routing', async () => {
    const ws = await surveyWorkspace(WS, {
      listPotSlugs: async () => ['pot-a', 'pot-b'],
      deps: depsForPots({
        'pot-a': {
          member: 'proj-a',
          // a LOW-importance plan
          plans: [planRow({ planSlug: 'low-plan', harnessSlug: 'proj-a', items: [planItem('x', 'low')] })],
          frontier: [frontierRow({ feature_id: 'WI-A', harness_slug: 'proj-a' })],
        },
        'pot-b': {
          member: 'proj-b',
          // an URGENT plan — must out-rank pot-a's low plan in the cross-pot view
          plans: [planRow({ planSlug: 'urgent-plan', harnessSlug: 'proj-b', items: [planItem('y', 'urgent')] })],
          frontier: [frontierRow({ feature_id: 'WI-B', harness_slug: 'proj-b' })],
        },
      }),
    });

    // The cross-pot plan view holds BOTH hives' plans, ranked across hives — the
    // urgent plan (pot-b) leads the low plan (pot-a). A single ordering, not a
    // per-pot concat.
    expect(ws.crossPot.plans.map((c) => c.id)).toEqual(['urgent-plan', 'low-plan']);
    expect(ws.crossPot.plans[0].rank.score).toBeGreaterThan(ws.crossPot.plans[1].rank.score);
    // The cross-pot frontier holds BOTH hives' work-items.
    expect(ws.crossPot.frontier.map((c) => c.id).sort()).toEqual(['WI-A', 'WI-B']);

    // Every cross-pot candidate carries its SOURCE/TARGET-pot tag (P-001) so the
    // placement path routes it onto the right pot's cups.
    const tagOf = (id: string) =>
      [...ws.crossPot.plans, ...ws.crossPot.frontier].find((c) => c.id === id)?.pot;
    expect(tagOf('urgent-plan')).toBe('pot-b');
    expect(tagOf('low-plan')).toBe('pot-a');
    expect(tagOf('WI-A')).toBe('pot-a');
    expect(tagOf('WI-B')).toBe('pot-b');
  });

  it('de-dups workspace-fallback frontier echoes and keeps the member-scoped pot tag', async () => {
    const ws = await surveyWorkspace(WS, {
      // The pass-through pot is first to prove a later member-scoped row
      // replaces its workspace-wide echo for the same real work item.
      listPotSlugs: async () => ['pass-through-pot', 'real-pot'],
      deps: {
        now: () => NOW,
        loadRegistry: async () => ({
          projects: [
            { slug: 'pass-through-pot' },
            { slug: 'real-pot' },
            { slug: 'real-proj', hive_slug: 'real-pot' },
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

    expect(ws.perPot.find((s) => s.pot === 'pass-through-pot')!.survey.scope).toBe('workspace');
    expect(ws.perPot.find((s) => s.pot === 'real-pot')!.survey.scope).toBe('members');
    expect(ws.crossPot.frontier.map((c) => c.id).sort()).toEqual(['WI-A', 'WI-B']);
    expect(ws.crossPot.frontier.filter((c) => c.id === 'WI-A')).toHaveLength(1);
    expect(ws.crossPot.frontier.find((c) => c.id === 'WI-A')?.pot).toBe('real-pot');
  });

  it('sums frontierBlocked across all hives', async () => {
    const ws = await surveyWorkspace(WS, {
      listPotSlugs: async () => ['pot-a', 'pot-b'],
      deps: {
        now: () => NOW,
        loadRegistry: async () => ({
          projects: [
            { slug: 'pot-a' }, { slug: 'proj-a', hive_slug: 'pot-a' },
            { slug: 'pot-b' }, { slug: 'proj-b', hive_slug: 'pot-b' },
          ],
        }),
        listPlanRows: async () => [],
        // each pot has a tier2 lane blocked by an in-flight tier1
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
    expect(ws.crossPot.frontierBlocked).toBe(2); // one held-back lane per pot
    expect(ws.crossPot.frontier.map((c) => c.id).sort()).toEqual(['WI-A1', 'WI-B1']);
  });

  it('falls back to surveying the supplied home pot alone when no pot resolves', async () => {
    const ws = await surveyWorkspace(WS, {
      listPotSlugs: async () => [],
      fallbackHome: 'lonely-pot',
      deps: depsForPots({
        'lonely-pot': {
          member: 'proj-lonely',
          plans: [planRow({ planSlug: 'lp', harnessSlug: 'proj-lonely', items: [planItem('z')] })],
          frontier: [frontierRow({ feature_id: 'WI-L', harness_slug: 'proj-lonely' })],
        },
      }),
    });
    expect(ws.hives).toEqual(['lonely-pot']);
    expect(ws.perPot).toHaveLength(1);
    expect(ws.crossPot.frontier.map((c) => c.id)).toEqual(['WI-L']);
  });

  it('de-dups a pot listed twice (workspace==pot shape stays one section)', async () => {
    const ws = await surveyWorkspace(WS, {
      listPotSlugs: async () => ['pot-a', 'pot-a'],
      deps: depsForPots({
        'pot-a': { member: 'proj-a', plans: [], frontier: [frontierRow({ feature_id: 'WI-A', harness_slug: 'proj-a' })] },
      }),
    });
    expect(ws.hives).toEqual(['pot-a']);
    expect(ws.perPot).toHaveLength(1);
    expect(ws.crossPot.frontier.map((c) => c.id)).toEqual(['WI-A']);
  });
});
