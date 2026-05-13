/**
 * Tests for selectToolStates (pure helper). The useStateSnapshots
 * hook itself is exercised via PendingCardsBar.test.tsx in PR 1b.
 */
import { describe, expect, it } from 'vitest';

import { selectToolStates, type SnapshotEnvelope } from './use-state-snapshots';

function env(runId: string, toolState?: unknown): SnapshotEnvelope {
  return {
    runId,
    version: 1,
    snapshot: { openCards: [], ...(toolState !== undefined ? { toolState } : {}) },
  };
}

describe('selectToolStates', () => {
  it('returns empty for an empty map', () => {
    expect(selectToolStates(new Map())).toEqual(new Map());
  });

  it('skips runs with no toolState (card-only flows)', () => {
    const m = new Map<string, SnapshotEnvelope>();
    m.set('rA', env('rA')); // no toolState
    m.set('rB', env('rB', { count: 3 }));
    const out = selectToolStates(m);
    expect(out.size).toBe(1);
    expect(out.get('rB')).toEqual({ count: 3 });
  });

  it('preserves runId → toolState mapping', () => {
    const m = new Map<string, SnapshotEnvelope>();
    m.set('a', env('a', { phase: 'querying' }));
    m.set('b', env('b', { phase: 'done', results: ['x'] }));
    const out = selectToolStates(m);
    expect(out.get('a')).toEqual({ phase: 'querying' });
    expect(out.get('b')).toEqual({ phase: 'done', results: ['x'] });
  });
});
