import { describe, expect, it } from 'vitest';
import {
  TABLE_TO_QUERY_NAMES,
  queryNamesForTriggerEvent,
  allBridgedQueryNames,
} from './table-to-query-names';
import { knownQueryNamesV2 } from './index';

describe('queryNamesForTriggerEvent', () => {
  it('strips the .changed suffix and looks up the table', () => {
    expect(queryNamesForTriggerEvent('harness_shared.harness_text_artifacts.changed')).toEqual([
      'harnessTextArtifact.byHarness',
    ]);
  });

  it('returns multiple names when a single table backs multiple queries', () => {
    const names = queryNamesForTriggerEvent('harness_shared.harness_chunk_plans.changed');
    expect(names).toEqual(expect.arrayContaining(['chunkPlans.byHarness', 'chunkPlans.byFeature']));
    expect(names).toHaveLength(2);
  });

  it('returns empty array for unknown tables', () => {
    expect(queryNamesForTriggerEvent('harness_shared.totally_unknown.changed')).toEqual([]);
  });

  it('returns empty array for malformed event names (no .changed suffix)', () => {
    expect(queryNamesForTriggerEvent('plans.list')).toEqual([]);
    expect(queryNamesForTriggerEvent('harness_shared.harness_text_artifacts')).toEqual([]);
    expect(queryNamesForTriggerEvent('')).toEqual([]);
  });

  it('handles userActions which contributes two names from one table', () => {
    expect(queryNamesForTriggerEvent('harness_shared.user_actions.changed')).toEqual(
      expect.arrayContaining(['userActions.byHarness', 'userActions.byKind']),
    );
  });

  it('handles *Consolidated tables', () => {
    expect(queryNamesForTriggerEvent('harness_shared.harness_features_consolidated.changed')).toEqual(
      expect.arrayContaining(['featuresConsolidated.bySlug', 'featuresConsolidated.byPlanSlug']),
    );
    expect(queryNamesForTriggerEvent('harness_shared.agent_runs_consolidated.changed')).toEqual(
      expect.arrayContaining(['agentRunsConsolidated.bySlug', 'agentRunsConsolidated.recent']),
    );
  });
});

describe('TABLE_TO_QUERY_NAMES vs v2 registry consistency', () => {
  /**
   * Forward-defined names — mapped in the bridge BEFORE the
   * corresponding v2 registry entry exists. Trigger events for these
   * tables fire (as expected) but currently invalidate nothing; the
   * matching consumer + v2 entry will land later. Listed here so
   * the consistency assertion stays sharp while permitting deliberate
   * advance-mapping.
   *
   * REMOVE an entry from this set as soon as its v2 registry entry
   * lands — otherwise drift between intent ("this should land soon")
   * and reality ("it never did") stops being visible.
   */
  const FORWARD_DEFINED = new Set<string>([
    // v5 addendum 3 §9.0 Insights tab — P-073+ work.
    'contributorUsageEvents.byHarness',
    'insightsFirstVisit.byHarness',
  ]);

  it('every bridged query name is either in v2 registry OR explicitly forward-defined', () => {
    const v2 = new Set(knownQueryNamesV2());
    const bridged = allBridgedQueryNames();
    const unaccountedFor = bridged.filter((n) => !v2.has(n) && !FORWARD_DEFINED.has(n));
    expect(unaccountedFor).toEqual([]);
  });

  it('forward-defined names are NOT in v2 registry (sanity)', () => {
    const v2 = new Set(knownQueryNamesV2());
    const stillForward = Array.from(FORWARD_DEFINED).filter((n) => !v2.has(n));
    // If this assertion fails, a forward-defined name has been
    // implemented and its entry in FORWARD_DEFINED should be removed.
    expect(stillForward.sort()).toEqual(Array.from(FORWARD_DEFINED).sort());
  });

  it('exposes a distinct, non-trivially-populated set of camelCase names through the bridge', () => {
    // Was a brittle exact count (56) that flapped red as query families landed
    // (issues/conversations/coord added 2026-06-04 → 63; delegates.byWorkspace
    // removed by collapse-delegate-into-workitems-2026-06-04 → 62). The
    // forward-defined + v2-consistency assertions above carry the real signal;
    // here we only assert the bridge is non-trivially populated + every name distinct.
    const names = allBridgedQueryNames();
    expect(names.length).toBeGreaterThanOrEqual(62);
    expect(new Set(names).size, 'bridged query names are distinct').toBe(names.length);
  });
});

describe('TABLE_TO_QUERY_NAMES shape', () => {
  it('all keys start with harness_shared.', () => {
    for (const k of Object.keys(TABLE_TO_QUERY_NAMES)) {
      expect(k).toMatch(/^harness_shared\./);
    }
  });

  it('all values are non-empty string arrays', () => {
    for (const [k, vs] of Object.entries(TABLE_TO_QUERY_NAMES)) {
      expect(Array.isArray(vs), `value for ${k}`).toBe(true);
      expect(vs.length, `value for ${k}`).toBeGreaterThan(0);
      for (const v of vs) {
        expect(typeof v, `entry in ${k}`).toBe('string');
        expect(v, `entry in ${k}`).toMatch(/^\w+\.\w+$/);
      }
    }
  });
});
