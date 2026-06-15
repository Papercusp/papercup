import { describe, it, expect } from 'vitest';
import { workItemToTask, partitionTasksByReadiness, pickBeeRecentActivityMs } from './placement-gather';
import type { WorkItem } from '../work-items';
import type { PlacementTask } from './placement-affinity';
import type { HarnessBlockGraph } from '../hive/survey';

function wi(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-1',
    kind: 'feature',
    family: 'feature',
    harness: 'papercup',
    title: 'a task',
    summary: '',
    state: 'todo',
    assignee: null,
    assignedBy: null,
    severity: null,
    parent: null,
    payload: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...over,
  } as WorkItem;
}

describe('workItemToTask — payload → PlacementTask mapping', () => {
  it('carries id / harness / title straight through', () => {
    const t = workItemToTask(wi({ id: 'F-9', harness: 'restart', title: 'port the thing' }));
    expect(t).toMatchObject({ id: 'F-9', harness: 'restart', title: 'port the thing' });
  });

  it('extracts file hints from payload.files / fileScope / primaryFiles', () => {
    expect(workItemToTask(wi({ payload: { files: ['a.ts', 'b.ts'] } })).files).toEqual(['a.ts', 'b.ts']);
    expect(workItemToTask(wi({ payload: { fileScope: ['x.ts'] } })).files).toEqual(['x.ts']);
    expect(workItemToTask(wi({ payload: { primaryFiles: ['y.ts'] } })).files).toEqual(['y.ts']);
  });

  it('drops non-string file entries and tolerates a missing / non-object payload', () => {
    expect(workItemToTask(wi({ payload: { files: ['a.ts', 42, null] } })).files).toEqual(['a.ts']);
    expect(workItemToTask(wi({ payload: null })).files).toEqual([]);
    expect(workItemToTask(wi({ payload: 'nope' })).files).toEqual([]);
  });

  it('extracts the plan slug from payload.planSlug / plan_slug / plan', () => {
    expect(workItemToTask(wi({ payload: { planSlug: 'plan-a' } })).planSlug).toBe('plan-a');
    expect(workItemToTask(wi({ payload: { plan_slug: 'plan-b' } })).planSlug).toBe('plan-b');
    expect(workItemToTask(wi({ payload: { plan: 'plan-c' } })).planSlug).toBe('plan-c');
    expect(workItemToTask(wi({ payload: {} })).planSlug).toBeNull();
  });

  it('carries the per-lane brief from payload.brief (queen-wave-dispatch P-031)', () => {
    expect(workItemToTask(wi({ payload: { brief: 'the missing context' } })).brief).toBe('the missing context');
    // missing / non-string / whitespace-only → null (no brief to attach)
    expect(workItemToTask(wi({ payload: {} })).brief).toBeNull();
    expect(workItemToTask(wi({ payload: { brief: 42 } })).brief).toBeNull();
    expect(workItemToTask(wi({ payload: { brief: '   ' } })).brief).toBeNull();
    expect(workItemToTask(wi({ payload: null })).brief).toBeNull();
  });
});

describe('partitionTasksByReadiness — blocked_by gate over the placement frontier (P-030)', () => {
  const task = (id: string, harness: string): PlacementTask => ({ id, harness, title: id });

  it('drops a lane whose blocker is non-terminal; keeps one whose blocker is terminal or absent', () => {
    // h1: F-A blocked_by F-B (passed → satisfied); F-C blocked_by F-D (todo → NOT satisfied).
    // h2: F-E has no graph entry → unblocked.
    const graph = new Map<string, HarnessBlockGraph>([
      [
        'h1',
        {
          blockers: new Map([
            ['F-A', ['F-B']],
            ['F-C', ['F-D']],
          ]),
          statuses: new Map([
            ['F-B', 'passed'],
            ['F-D', 'todo'],
          ]),
        },
      ],
    ]);
    const { ready, blocked } = partitionTasksByReadiness(
      [task('F-A', 'h1'), task('F-C', 'h1'), task('F-E', 'h2')],
      graph,
    );
    expect(ready.map((t) => t.id).sort()).toEqual(['F-A', 'F-E']);
    expect(blocked.map((t) => t.id)).toEqual(['F-C']);
  });

  it('treats every lane as ready when no blocking graph is supplied (fail-open)', () => {
    const { ready, blocked } = partitionTasksByReadiness(
      [task('F-1', 'h1'), task('F-2', 'h1')],
      new Map(),
    );
    expect(ready).toHaveLength(2);
    expect(blocked).toHaveLength(0);
  });

  it('is a no-op for an empty task list', () => {
    expect(partitionTasksByReadiness([], new Map())).toEqual({ ready: [], blocked: [] });
  });
});
