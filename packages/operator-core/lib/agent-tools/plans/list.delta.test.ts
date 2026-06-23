/**
 * plans:list delta capability (agent-tool-delta-protocol P-015, Lane F rollout).
 * Pure unit coverage of the declared DeltaCapability: the `plans` selector, slug-keying,
 * and merge-correctness — applying the framework's diff of (prev → next) to prev
 * reconstructs next's row SET (incl. a plan whose `updated` changed → an `updated`), so a
 * delta is behaviour-identical to a full re-read once the flag flips. (plans:attention's
 * PG/replay path is integration-tier; this pins the keying without a DB.)
 */
import { describe, it, expect } from 'vitest';
import { computeRowDigest, diffFromDigest, applySemanticDelta } from '@papercusp/tooldef';
import tool from './list';

const delta = (tool as unknown as { delta: import('@papercusp/tooldef').DeltaCapability }).delta;
const itemKey = (r: unknown) => delta.itemKey!(r);

const plan = (slug: string, updated: string, extra: Record<string, unknown> = {}) => ({ slug, updated, status: 'active', ...extra });

describe('plans:list delta capability', () => {
  it('extracts the plans row array via rows() (null when absent → opts out)', () => {
    expect(delta.rows!({ plans: [plan('a', 't1')] })).toEqual([plan('a', 't1')]);
    expect(delta.rows!({})).toBeNull();
    expect(delta.rows!(null)).toBeNull();
  });

  it('keys rows by slug', () => {
    expect(itemKey(plan('my-plan', 't1'))).toBe('my-plan');
  });

  it('merge-correctness: diff(prev → next) reconstructs next, incl. an updated plan', () => {
    const prev = [plan('a', 't1'), plan('b', 't1'), plan('c', 't1')];
    const next = [plan('a', 't1'), plan('b', 't2' /* updated */), plan('d', 't1')]; // c removed, d added, b updated
    const digest = computeRowDigest(prev, itemKey)!;
    const changes = diffFromDigest(digest, next, itemKey);
    const merged = applySemanticDelta(prev, changes, itemKey);
    expect(new Set(merged.map(itemKey))).toEqual(new Set(next.map(itemKey)));
    expect(merged.find((p) => itemKey(p) === 'b')).toEqual(plan('b', 't2')); // carries the updated row
    expect(changes.some((c) => c.change === 'updated' && c.id === 'b')).toBe(true);
  });

  it('scope folds in the workspace dimension; declares schemaVersion + max age', () => {
    expect(delta.scope!({}, { workspaceId: 'ws-9' } as never)).toBe('ws-9');
    expect(delta.schemaVersion).toBe('plans-list-v1');
    expect(delta.maxDeltaAge).toBe(5 * 60_000);
  });
});
