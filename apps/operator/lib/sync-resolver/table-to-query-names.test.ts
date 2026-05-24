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
      ['featuresConsolidated.bySlug'],
    );
    expect(queryNamesForTriggerEvent('harness_shared.agent_runs_consolidated.changed')).toEqual(
      expect.arrayContaining(['agentRunsConsolidated.bySlug', 'agentRunsConsolidated.recent']),
    );
  });
});

describe('TABLE_TO_QUERY_NAMES vs v2 registry consistency', () => {
  it('every bridged query name is also a v2 registry entry', () => {
    const v2 = new Set(knownQueryNamesV2());
    const bridged = allBridgedQueryNames();
    const orphans = bridged.filter((n) => !v2.has(n));
    expect(orphans).toEqual([]);
  });

  it('exposes 54 distinct camelCase names through the bridge', () => {
    // Snapshot count so future drift surfaces. The bridge covers
    // every v2 registry entry — *.byHarness, *.byWorkspace, *.byKind,
    // *.byOrg, *.byDept, *.byProject, *.byHarnessAndBranch, *.bySlug,
    // *.byFeature, *.recent — every name the trigger could plausibly
    // invalidate.
    expect(allBridgedQueryNames()).toHaveLength(54);
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
