import { describe, it, expect } from 'vitest';
import { workItemToTask } from './placement-gather';
import type { WorkItem } from '../work-items';

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
});
