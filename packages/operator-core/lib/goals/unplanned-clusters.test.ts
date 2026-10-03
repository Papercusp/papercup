/**
 * The unplanned-cluster detector (plan goal-holder-plans-ideation-truthful-reports-2026-10-03
 * P-002): 3+ open goal-stamped items sharing one cluster, in no plan, for more than 2
 * reporting cycles → one holder nudge. Pure-function guards; the sweep leg that calls
 * these is guarded in system-health/goal-liveness-watchdog.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { IMPROVEMENT_TOPIC } from '../agent-tools/coordination/topics-core';
import {
  PROVENANCE_TOPICS,
  UNPLANNED_CLUSTER_AGE_CYCLES,
  UNPLANNED_CLUSTER_MIN_SIZE,
  citedPaths,
  findUnplannedClusters,
  overdueUnplannedClusters,
  titlePrefix,
  type ClusterCandidateItem,
} from './unplanned-clusters';

const GOAL = 'papercusp-workspace:work-on-everything-60d3a8';
const H = 3600_000;
const T0 = Date.parse('2026-10-03T00:00:00Z');

function item(id: string, minutesAfterT0: number, over: Partial<ClusterCandidateItem> = {}): ClusterCandidateItem {
  return { id, title: `item ${id}`, summary: null, createdAtMs: T0 + minutesAfterT0 * 60_000, harness: 'papercusp', ...over };
}

describe('the contract thresholds', () => {
  it('pins the GOAL contract numbers: 3+ items, older than 2 reporting cycles', () => {
    expect(UNPLANNED_CLUSTER_MIN_SIZE).toBe(3);
    expect(UNPLANNED_CLUSTER_AGE_CYCLES).toBe(2);
  });

  it('treats the improvement-capture topic as provenance, never a cluster key', () => {
    expect(PROVENANCE_TOPICS).toContain(IMPROVEMENT_TOPIC);
  });
});

describe('citedPaths / titlePrefix', () => {
  it('extracts repository paths from prose', () => {
    expect(
      citedPaths('see packages/operator-core/lib/goals/holder.ts and apps/operator/scripts/psu-pty-host.mjs.'),
    ).toEqual(['packages/operator-core/lib/goals/holder.ts', 'apps/operator/scripts/psu-pty-host.mjs']);
    expect(citedPaths('no path here, just goals/holder.ts')).toEqual([]);
  });

  it('normalizes a bracketed group prefix', () => {
    expect(titlePrefix('[Truthful  Reports] Fix the cost line')).toBe('truthful reports');
    expect(titlePrefix('Truthful reports: no brackets')).toBeNull();
  });
});

describe('findUnplannedClusters', () => {
  it('clusters three items that cite the same file; anchor is the earliest, formedAt the third', () => {
    const p = 'packages/operator-core/lib/system-health/goal-liveness-watchdog.ts';
    const items = [
      item('WI-3', 30, { summary: `breaks in ${p}` }),
      item('WI-1', 0, { summary: `root cause in ${p}` }),
      item('WI-2', 10, { title: `${p} misreads holders` }),
      item('WI-9', 5, { summary: 'unrelated' }),
    ];
    const [c, ...rest] = findUnplannedClusters(GOAL, items, []);
    expect(rest).toEqual([]);
    expect(c.anchorId).toBe('WI-1');
    expect(c.key).toBe(`${GOAL}:WI-1`);
    expect(c.memberIds).toEqual(['WI-1', 'WI-2', 'WI-3']);
    expect(c.formedAtMs).toBe(T0 + 30 * 60_000);
    expect(c.reasons).toEqual([`path:${p}`]);
    expect(c.harness).toBe('papercusp');
  });

  it('unions DIFFERENT signals transitively: A–B by a link, B–C by a shared prefix', () => {
    const items = [
      item('A', 0),
      item('B', 1, { title: '[Reminder delivery] reminders never fire' }),
      item('C', 2, { title: '[Reminder delivery] fired reminders are dropped' }),
    ];
    const [c] = findUnplannedClusters(GOAL, items, [{ a: 'A', b: 'B', rel: 'caused-by' }]);
    expect(c.memberIds).toEqual(['A', 'B', 'C']);
    expect(c.reasons).toEqual(['link:caused-by', 'prefix:[reminder delivery]']);
  });

  it('clusters on a shared subject topic', () => {
    const items = [item('A', 0, { topics: ['gate'] }), item('B', 1, { topics: ['gate'] }), item('C', 2, { topics: ['gate', 'x'] })];
    expect(findUnplannedClusters(GOAL, items, [])[0].reasons).toEqual(['topic:gate']);
  });

  it('CALIBRATION: the provenance topic alone never makes a cluster (it tags every capture)', () => {
    const items = [0, 1, 2, 3].map((i) => item(`I${i}`, i, { topics: [IMPROVEMENT_TOPIC] }));
    expect(findUnplannedClusters(GOAL, items, [])).toEqual([]);
    // …and the same items DO cluster once the topic is not treated as provenance, so the
    // empty result above is the exclusion working, not an instrument that finds nothing.
    expect(findUnplannedClusters(GOAL, items, [], { provenanceTopics: [] })).toHaveLength(1);
  });

  it('reports nothing below the size floor', () => {
    const items = [item('A', 0, { topics: ['gate'] }), item('B', 1, { topics: ['gate'] }), item('C', 2)];
    expect(findUnplannedClusters(GOAL, items, [])).toEqual([]);
  });

  it('ignores topic edges, unknown relations, self-loops and edges leaving the item set', () => {
    const items = [item('A', 0), item('B', 1), item('C', 2)];
    const edges = [
      { a: 'A', b: 'B', rel: 'tagged' },
      { a: 'B', b: 'C', rel: 'mentions' },
      { a: 'C', b: 'C', rel: 'relates' },
      { a: 'A', b: 'PLANNED-ELSEWHERE', rel: 'relates' },
      { a: 'PLANNED-ELSEWHERE', b: 'C', rel: 'relates' },
    ];
    expect(findUnplannedClusters(GOAL, items, edges)).toEqual([]);
  });

  it('keeps two separate clusters separate and orders them by formation', () => {
    const items = [
      item('A1', 0, { topics: ['a'] }),
      item('A2', 1, { topics: ['a'] }),
      item('A3', 50, { topics: ['a'] }),
      item('B1', 2, { topics: ['b'] }),
      item('B2', 3, { topics: ['b'] }),
      item('B3', 4, { topics: ['b'] }),
    ];
    expect(findUnplannedClusters(GOAL, items, []).map((c) => c.anchorId)).toEqual(['B1', 'A1']);
  });
});

describe('overdueUnplannedClusters', () => {
  const [cluster] = findUnplannedClusters(
    GOAL,
    [item('A', 0, { topics: ['t'] }), item('B', 0, { topics: ['t'] }), item('C', 0, { topics: ['t'] })],
    [],
  );

  it('reports a cluster only once it is MORE than 2 reporting cycles old', () => {
    const cycle = 4 * H;
    expect(overdueUnplannedClusters([cluster], T0 + 2 * cycle - 1, cycle)).toEqual([]);
    expect(overdueUnplannedClusters([cluster], T0 + 2 * cycle, cycle)).toEqual([]);
    expect(overdueUnplannedClusters([cluster], T0 + 2 * cycle + 1, cycle)).toEqual([cluster]);
  });

  it('scales with the goal cadence: 3h is overdue at a 1h cycle and not at a 4h cycle', () => {
    expect(overdueUnplannedClusters([cluster], T0 + 3 * H, 1 * H)).toEqual([cluster]);
    expect(overdueUnplannedClusters([cluster], T0 + 3 * H, 4 * H)).toEqual([]);
  });
});
