/**
 * mug-wave-dispatch-invariants.test.ts — the P-041 INVARIANTS suite for
 * queen-wave-dispatch-2026-06-13 (W-04). These pin the three structural
 * guarantees the whole arc rests on; they are pure (no DB) so they run in the
 * fast unit lane.
 *
 * (a) The DBOS orchestrator's dispatch is behavior-neutral (P-011): its readiness
 *     selection IS `selectReady`, not a second copy. The full 63-case ordering
 *     behavior is pinned by orchestrator-loop.test.ts; here we pin that
 *     computeFrontier's READINESS verdict is byte-for-byte the shared predicate's.
 *
 * (b) ONE readiness predicate, EVERY frontier consumer (D-002/D-007). The three
 *     frontier entry points — `computeFrontier` (orchestrator), `filterReadyFrontier`
 *     (the Mug's survey) and `partitionTasksByReadiness` (the placement chokepoint)
 *     — each in its own input shape, must AGREE on the readiness verdict for the
 *     same wave graph. No duplicated blocked_by logic ⇒ no divergence. (Note: only
 *     READINESS is shared; ORDERING is intentionally per-consumer — D-007.)
 *
 * (c) Brief-discipline is STRUCTURAL, so EI-248/249 (unsubstituted `brief-NN`
 *     placeholders) and EI-277/283 (claim thundering-herds) are impossible by
 *     construction (D-006):
 *       • the compiler substitutes templates — no `{item}` placeholder can reach an
 *         agent (`buildWaveFeatures`), so EI-248/249 cannot recur;
 *       • a wave's `blocked_by` compiles to per-feature edges (`applyInterWaveEdges`)
 *         which become `coord_links rel='blocks'`, and a blocked lane is NEVER
 *         returned as placeable (`partitionTasksByReadiness`) — the lanes are
 *         sole-owner by `from_items` scope and sequenced by the edges, so two
 *         placement passes can't both hand out the same lane (EI-277/283).
 */
import { describe, expect, it } from 'vitest';
import { computeFrontier, type FrontierFeature } from '../dbos/orchestrator-loop';
import { selectReady } from '../dbos/frontier-readiness';
import { filterReadyFrontier, type HarnessBlockGraph, type FrontierRow } from './survey';
import { partitionTasksByReadiness } from '../fleet/placement-gather';
import type { PlacementTask } from '../fleet/placement-affinity';
import {
  buildWaveFeatures,
  applyInterWaveEdges,
  type PromoteWave,
  type BuiltFeature,
} from '../agent-tools/plans/promote-policy';

// The orchestrator's private default dispatchable set (orchestrator-loop.ts) —
// reconstructed here and passed to BOTH computeFrontier and selectReady so the
// readiness comparison is over an identical policy.
const NEEDS_WORK: ReadonlySet<string> = new Set(['todo', 'failing', 'pending', 'failed']);
const NO_PLANS = new Map<string, number>();
const NONE: ReadonlySet<string> = new Set();

const ff = (id: string, status: string, over: Partial<FrontierFeature> = {}): FrontierFeature => ({
  id,
  status,
  blockedBy: [],
  sourcePlan: null,
  order: null,
  ...over,
});
const row = (id: string): FrontierRow => ({
  feature_id: id,
  harness_slug: 'h',
  title: id,
  item_kind: 'feature',
  created_ts: null,
  feature_order: null,
});
const task = (id: string): PlacementTask => ({ id, harness: 'h', title: id });

// A wave graph in each consumer's own input shape: tier2 (F-2) blocked_by tier1
// (F-1). When tier1 is done it's no longer an UNPLACED frontier row — it survives
// only as a (terminal) blocker — exactly as it does in the live system.
const graphFor = (tier1Done: boolean): Map<string, HarnessBlockGraph> =>
  new Map<string, HarnessBlockGraph>([
    [
      'h',
      {
        blockers: new Map([['F-2', ['F-1']]]),
        statuses: new Map(tier1Done ? [['F-1', 'passed']] : []),
      },
    ],
  ]);

const readyByOrchestrator = (tier1Done: boolean): Set<string> =>
  new Set(
    computeFrontier(
      [ff('F-1', tier1Done ? 'passed' : 'todo'), ff('F-2', 'todo', { blockedBy: ['F-1'] })],
      NO_PLANS,
      NONE,
      99,
      NEEDS_WORK,
    ).toStart,
  );
const readyBySurvey = (tier1Done: boolean): Set<string> =>
  new Set(
    filterReadyFrontier(tier1Done ? [row('F-2')] : [row('F-1'), row('F-2')], graphFor(tier1Done)).ready.map(
      (r) => r.feature_id,
    ),
  );
const readyByPlacement = (tier1Done: boolean): Set<string> =>
  new Set(
    partitionTasksByReadiness(tier1Done ? [task('F-2')] : [task('F-1'), task('F-2')], graphFor(tier1Done)).ready.map(
      (t) => t.id,
    ),
  );

describe('mug-wave-dispatch invariants (P-041)', () => {
  describe('(a) the orchestrator dispatch is behavior-neutral — its readiness IS selectReady (P-011)', () => {
    it('computeFrontier selects exactly the shared predicate`s ready set (no second blocked_by logic)', () => {
      const features = [
        ff('F-1', 'todo'),
        ff('F-2', 'todo', { blockedBy: ['F-1'] }), // blocked: F-1 non-terminal
        ff('F-3', 'passed'),
        ff('F-4', 'todo', { blockedBy: ['F-3'] }), // ready: blocker terminal
        ff('F-5', 'failing'), // dispatchable alias
        ff('F-6', 'todo', { blockedBy: ['GONE'] }), // ready: absent blocker never deadlocks
      ];
      // slots high enough that the cap drops nothing — compare the SELECTION, not the slice.
      const viaOrchestrator = new Set(computeFrontier(features, NO_PLANS, NONE, 99, NEEDS_WORK).toStart);
      const viaPredicate = new Set(selectReady(features, NONE, NEEDS_WORK).ready.map((n) => n.id));
      expect(viaOrchestrator).toEqual(viaPredicate);
      expect(viaOrchestrator).toEqual(new Set(['F-1', 'F-4', 'F-5', 'F-6']));
    });
  });

  describe('(b) ONE readiness predicate, every frontier consumer agrees (D-002/D-007)', () => {
    it('tier2 is BLOCKED in all three consumers while tier1 is non-terminal', () => {
      expect(readyByOrchestrator(false).has('F-2')).toBe(false);
      expect(readyBySurvey(false).has('F-2')).toBe(false);
      expect(readyByPlacement(false).has('F-2')).toBe(false);
      // …and tier1 itself is ready in every consumer where it is an unplaced lane.
      expect(readyByOrchestrator(false).has('F-1')).toBe(true);
      expect(readyBySurvey(false).has('F-1')).toBe(true);
      expect(readyByPlacement(false).has('F-1')).toBe(true);
    });

    it('tier2 becomes READY in all three consumers once tier1 is terminal', () => {
      expect(readyByOrchestrator(true).has('F-2')).toBe(true);
      expect(readyBySurvey(true).has('F-2')).toBe(true);
      expect(readyByPlacement(true).has('F-2')).toBe(true);
    });
  });

  describe('(c) brief-discipline is STRUCTURAL — EI-248/249 + EI-277/283 impossible by construction', () => {
    it('the compiler substitutes {item} in EVERY agent-facing field — no placeholder survives (EI-248/249)', () => {
      const wave = {
        id: 'tier2',
        blocked_by: 'tier1',
        generate: {
          for_each: 'universal_type',
          feature_template: {
            title: 'Universal schema: {item}',
            acceptance: ['validates vs asinDetails for {item}'],
            body: 'Implement the {item} handler',
            brief: 'Universal schema {item}: single handler, {item}-specific tests',
            agent_hint: 'touch only the {item} fetcher',
          },
        },
      } as unknown as PromoteWave;

      const { features } = buildWaveFeatures(wave, { generateItems: ['reviews', 'offers'] });
      expect(features).toHaveLength(2);
      for (const f of features) {
        const agentFacing = [f.title, f.brief, f.body, ...(f.acceptance ?? [])].filter(Boolean).join(' | ');
        expect(agentFacing).not.toMatch(/\{item\}/); // no template placeholder can reach an agent
        expect(f.generated).toBe(true);
      }
      expect(features[0].title).toBe('Universal schema: reviews');
      expect(features[0].brief).toBe('Universal schema reviews: single handler, reviews-specific tests');
      expect(features[1].title).toBe('Universal schema: offers');
    });

    it('a generative wave with NO items yields ZERO lanes + a warning — never an un-substituted feature', () => {
      const wave = {
        id: 'tier2',
        generate: { for_each: 'x', feature_template: { title: 'T {item}', brief: 'B {item}' } },
      } as unknown as PromoteWave;
      const { features, warnings } = buildWaveFeatures(wave, { generateItems: [] });
      expect(features).toEqual([]); // nothing un-substituted ever reaches placement
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('a wave`s blocked_by compiles into per-feature edges — the sequence that gates tier2 (EI-277/283)', () => {
      const tier1: BuiltFeature[] = [
        { title: 'Lane A', from_items: ['P-001'] },
        { title: 'Lane B', from_items: ['P-002'] },
      ];
      const tier2: BuiltFeature[] = [{ title: 'Lane C', generated: true }];
      const waves = [{ id: 'tier1' }, { id: 'tier2', blocked_by: 'tier1' }] as unknown as PromoteWave[];
      const builtByWave = new Map<string, BuiltFeature[]>([
        ['tier1', tier1],
        ['tier2', tier2],
      ]);

      applyInterWaveEdges(waves, builtByWave);

      // every tier2 feature is blocked_by every tier1 TITLE (→ coord_links rel='blocks').
      expect([...(tier2[0].blocked_by ?? [])].sort()).toEqual(['Lane A', 'Lane B']);
      // tier1 lanes carry no cross-wave edge — disjoint sole-owner lanes, placeable now.
      expect(tier1[0].blocked_by ?? []).toEqual([]);
      expect(tier1[1].blocked_by ?? []).toEqual([]);
    });

    it('a blocked lane is NEVER returned as placeable at the chokepoint — deterministic + idempotent (no claim race)', () => {
      // F-1 is a live (todo) lane gating F-2; the chokepoint must drop F-2 every pass,
      // so two placement sweeps can't both hand out the same blocked lane.
      const graph = new Map<string, HarnessBlockGraph>([
        ['h', { blockers: new Map([['F-2', ['F-1']]]), statuses: new Map() }],
      ]);
      const tasks = [task('F-1'), task('F-2')];
      for (let pass = 0; pass < 3; pass++) {
        const { ready, blocked } = partitionTasksByReadiness(tasks, graph);
        expect(ready.map((t) => t.id)).toEqual(['F-1']); // only the unblocked, sole-owner lane
        expect(blocked.map((t) => t.id)).toEqual(['F-2']);
      }
    });
  });
});
