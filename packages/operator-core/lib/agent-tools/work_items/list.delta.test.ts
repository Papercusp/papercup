/**
 * work_items:list delta capability (agent-tool-delta-client-rollout-2026-06-23, P-001).
 * Pure unit coverage of the declared DeltaCapability: the array selector, id-keying,
 * kind row-type, and merge-correctness — applying the framework's diff of (prev → next)
 * to prev reconstructs next's row SET (incl. an updated row), so a delta is behaviour-
 * identical to a full re-read once a delta-aware client exists.
 */
import { describe, it, expect } from 'vitest';
import { computeRowDigest, diffFromDigest, applySemanticDelta } from '@papercusp/tooldef';
import tool from './list';

const delta = (tool as unknown as { delta: import('@papercusp/tooldef').DeltaCapability }).delta;
const itemKey = (r: unknown) => delta.itemKey!(r);

const wi = (id: string, kind = 'chunk', extra: Record<string, unknown> = {}) => ({ id, kind, title: `t${id}`, state: 'todo', ...extra });

describe('work_items:list delta capability', () => {
  it('treats the data array as the rows (null otherwise)', () => {
    expect(delta.rows!([wi('WI-1')])).toEqual([wi('WI-1')]);
    expect(delta.rows!(null)).toBeNull();
    expect(delta.rows!({ not: 'an array' })).toBeNull();
  });

  it('keys by id and types by kind', () => {
    expect(itemKey(wi('WI-9'))).toBe('WI-9');
    expect(delta.rowType!(wi('WI-9', 'bug'))).toBe('bug');
  });

  it('merge-correctness: diff(prev → next) reconstructs next, incl. an updated item', () => {
    const prev = [wi('WI-1'), wi('WI-2', 'chunk', { state: 'todo' }), wi('WI-3')];
    const next = [wi('WI-1'), wi('WI-2', 'chunk', { state: 'wip' /* updated */ }), wi('WI-4')]; // WI-3 removed, WI-4 added
    const changes = diffFromDigest(computeRowDigest(prev, itemKey)!, next, itemKey);
    const merged = applySemanticDelta(prev, changes, itemKey);
    expect(new Set(merged.map(itemKey))).toEqual(new Set(next.map(itemKey)));
    expect(merged.find((r) => itemKey(r) === 'WI-2')).toEqual(wi('WI-2', 'chunk', { state: 'wip' }));
    expect(changes.some((c) => c.change === 'updated' && c.id === 'WI-2')).toBe(true);
  });

  it('scope folds in the workspace; declares schemaVersion + max age', () => {
    expect(delta.scope!({}, { workspaceId: 'ws-7' } as never)).toBe('ws-7');
    expect(delta.schemaVersion).toBe('work-items-list-v1');
    expect(delta.maxDeltaAge).toBe(5 * 60_000);
  });
});
