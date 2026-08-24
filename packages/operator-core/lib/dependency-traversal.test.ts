import { describe, expect, it, vi } from 'vitest';
import {
  dependencyTraversalStartKey,
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
    const query = vi.fn(async () => [
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

