/**
 * activity:recent delta capability (agent-tool-delta-protocol P-015, Lane F rollout).
 * Pure unit coverage of the declared DeltaCapability: the `rows` selector, id-keying,
 * the workspace `scope`, and — the load-bearing one — merge-correctness: applying the
 * framework's diff of (prev → next) to prev reconstructs next's row SET, so a delta is
 * behaviour-identical to a full re-read once the flag flips. (The exemplar's PG/replay
 * path is integration-tier; this pins the keying without a DB.)
 */
import { describe, it, expect } from 'vitest';
import { computeRowDigest, diffFromDigest, applySemanticDelta } from '@papercusp/tooldef';
import tool from './recent';

const delta = (tool as unknown as { delta: import('@papercusp/tooldef').DeltaCapability }).delta;
const itemKey = (r: unknown) => delta.itemKey!(r);

const row = (id: string, kind = 'tool', extra: Record<string, unknown> = {}) => ({ id, kind, summary: `s${id}`, ...extra });

describe('activity:recent delta capability', () => {
  it('extracts the activity row array via rows() (null when absent → opts out)', () => {
    expect(delta.rows!({ activity: [row('1')], count: 1 })).toEqual([row('1')]);
    expect(delta.rows!({ count: 0 })).toBeNull();
    expect(delta.rows!(null)).toBeNull();
  });

  it('keys rows by id and tags type by kind', () => {
    expect(itemKey(row('42'))).toBe('42');
    expect(delta.rowType!(row('42', 'lifecycle'))).toBe('lifecycle');
  });

  it('merge-correctness: applying diff(prev → next) to prev reconstructs next (set-equal)', () => {
    const prev = [row('1'), row('2'), row('3')];
    const next = [row('3'), row('4'), row('5')]; // window churned: 1+2 fell out, 4+5 arrived
    const digest = computeRowDigest(prev, itemKey)!;
    const changes = diffFromDigest(digest, next, itemKey);
    const merged = applySemanticDelta(prev, changes, itemKey);
    expect(new Set(merged.map(itemKey))).toEqual(new Set(next.map(itemKey)));
    expect(merged).toEqual(expect.arrayContaining(next));
  });

  it('scope folds in the workspace dimension (so a cursor never crosses workspaces)', () => {
    expect(delta.scope!({}, { workspaceId: 'ws-1' } as never)).toBe('ws-1');
    expect(delta.scope!({}, {} as never)).toBe('');
  });

  it('declares schemaVersion + a forced-full max age', () => {
    expect(delta.schemaVersion).toBe('activity-v1');
    expect(delta.maxDeltaAge).toBe(5 * 60_000);
  });
});
