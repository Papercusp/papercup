import { describe, expect, it, vi } from 'vitest';
import {
  dependencyTraversalStartKey,
  readDependencyBottlenecks,
  traverseDependencies,
  workItemIdFromExternalBlockerRef,
} from './dependency-traversal';

describe('workItemIdFromExternalBlockerRef', () => {
  it('extracts the canonical work item from a namespaced event ref', () => {
    expect(workItemIdFromExternalBlockerRef('harness:papercusp:wi-40086-qualified-current-tip')).toBe('WI-40086');
  });

  it('accepts exact issue/feature ids and rejects prose without an id', () => {
    expect(workItemIdFromExternalBlockerRef('EI-41117')).toBe('EI-41117');
    expect(workItemIdFromExternalBlockerRef('gate:release-green')).toBeNull();
  });
});

describe('dependencyTraversalStartKey', () => {
  it('qualifies plan items by plan because P-NNN ids are not globally unique', () => {
    expect(
      dependencyTraversalStartKey({ kind: 'plan_item', planSlug: 'cloud-plan', itemId: 'p-046' }),
    ).toBe('plan_item:cloud-plan#P-046');
  });

  it('rejects ambiguous or malformed starts', () => {
    expect(() => dependencyTraversalStartKey({ kind: 'plan_item', planSlug: '', itemId: 'P-046' })).toThrow();
    expect(() => dependencyTraversalStartKey({ kind: 'work_item', id: 'P-046' })).toThrow();
  });
});

describe('traverseDependencies result shaping', () => {
  it('dedupes multiply-reached nodes/edges and keeps the shallowest depth', async () => {
    const query = vi.fn(async (_text: string, _params: readonly unknown[]) => [
      {
        node_key: 'plan_item:cloud-plan#P-046', node_kind: 'plan_item' as const, ref: 'P-046',
        status: 'todo', title: 'Cloud lane', harness_slug: 'papercusp', plan_slug: 'cloud-plan',
        item_id: 'P-046', depth: 0, edge_key: null, subject_key: null, dependency_key: null,
        relation: null, external_ref: null, hit_depth_limit: false,
      },
      {
        node_key: 'work_item:WI-40474', node_kind: 'work_item' as const, ref: 'WI-40474',
        status: 'blocked', title: 'Implementation', harness_slug: 'papercusp', plan_slug: null,
        item_id: 'WI-40474', depth: 1, edge_key: 'coverage',
        subject_key: 'plan_item:cloud-plan#P-046', dependency_key: 'work_item:WI-40474',
        relation: 'coverage' as const, external_ref: null, hit_depth_limit: false,
      },
      {
        node_key: 'work_item:WI-40086', node_kind: 'work_item' as const, ref: 'WI-40086',
        status: 'open', title: 'Gate owner', harness_slug: 'papercusp', plan_slug: null,
        item_id: 'WI-40086', depth: 2, edge_key: 'external',
        subject_key: 'work_item:WI-40474', dependency_key: 'work_item:WI-40086',
        relation: 'external-blocker' as const,
        external_ref: 'harness:papercusp:wi-40086-qualified-current-tip', hit_depth_limit: false,
      },
      {
        node_key: 'work_item:WI-40086', node_kind: 'work_item' as const, ref: 'WI-40086',
        status: 'open', title: 'Gate owner', harness_slug: 'papercusp', plan_slug: null,
        item_id: 'WI-40086', depth: 4, edge_key: 'external',
        subject_key: 'work_item:WI-40474', dependency_key: 'work_item:WI-40086',
        relation: 'external-blocker' as const,
        external_ref: 'harness:papercusp:wi-40086-qualified-current-tip', hit_depth_limit: true,
      },
    ]);

    const result = await traverseDependencies(
      {
        workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
        start: { kind: 'plan_item', planSlug: 'cloud-plan', itemId: 'P-046' },
      },
      { query },
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.nodes.map((node) => [node.ref, node.depth])).toEqual([
      ['P-046', 0], ['WI-40474', 1], ['WI-40086', 2],
    ]);
    expect(result.edges.map((edge) => edge.relation)).toEqual(['coverage', 'external-blocker']);
    expect(result.truncated).toBe(true);
  });
});

describe('readDependencyBottlenecks result shaping', () => {
  it('preserves the population contract, canonical progress, and ranked row', async () => {
    const query = vi.fn(async () => [
      {
        row_kind: 'population' as const,
        blocker_key: null,
        blocker_kind: null,
        blocker_ref: null,
        blocker_status: null,
        blocker_title: null,
        work_item_refs: null,
        last_progress_at: null,
        open_blocked_count: null,
        open_root_count: 7,
        candidate_count: 4,
        depth_limited: false,
      },
      {
        row_kind: 'bottleneck' as const,
        blocker_key: 'work_item:WI-41117',
        blocker_kind: 'work_item' as const,
        blocker_ref: 'WI-41117',
        blocker_status: 'open',
        blocker_title: 'Shared dependency',
        work_item_refs: ['WI-41117'],
        last_progress_at: '2026-08-23T01:02:03.000Z',
        open_blocked_count: 5,
        open_root_count: 7,
        candidate_count: 4,
        depth_limited: false,
      },
    ]);

    const result = await readDependencyBottlenecks(
      {
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'papercusp',
        planSlug: 'fleet-plan',
        maxDepth: 12,
        limit: 3,
      },
      { query: query as never },
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['fleet-plan', 3]));
    expect(result).toEqual({
      population: {
        kind: 'exact-plan-open-roots',
        planSlug: 'fleet-plan',
        harnessSlug: 'papercusp',
        basis: 'unified-dependency-graph',
        openRoots: 7,
        candidates: 4,
        shown: 1,
        limit: 3,
        truncated: true,
        depthLimited: false,
        maxDepth: 12,
      },
      rows: [{
        key: 'work_item:WI-41117',
        kind: 'work_item',
        ref: 'WI-41117',
        status: 'open',
        title: 'Shared dependency',
        workItemRefs: ['WI-41117'],
        lastProgressAt: '2026-08-23T01:02:03.000Z',
        openBlockedCount: 5,
      }],
    });
  });
});
