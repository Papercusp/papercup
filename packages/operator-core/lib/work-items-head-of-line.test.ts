/**
 * work-items-head-of-line.test.ts — the swarm scheduler's BUFFERED-DRAIN order
 * (swarm-coordination-architecture-2026-06-06 P-005 / D-006).
 *
 * P-005 externalizes each slot's work-list as the per-assignee `rank` (the
 * Queen places several items ahead; the bee drains them head-of-line WITHOUT
 * waiting on the brain's ~30-min cadence). The order is the pure
 * `compareByHeadOfLine` comparator `listWorkItems({ orderByRank })` applies
 * after its cross-family fetch — pinned here in isolation (no PG):
 *   - ranked items first, by `rank` ASC (0 = head-of-line),
 *   - unranked (`rank == null`) sink to the tail,
 *   - ties (equal rank, or both unranked) break by recency (newest first),
 *   - the order MERGES across families (feature ∪ issue rows interleave by rank).
 */
import { describe, it, expect } from 'vitest';
import { compareByHeadOfLine, compareByRecency, type WorkItem } from './work-items';

function wi(p: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    family: 'issue',
    harness: null,
    id: p.id,
    title: p.id,
    summary: '',
    state: 'open',
    assignee: 'bee-A',
    assignedBy: null,
    severity: null,
    parent: null,
    payload: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    kind: 'task',
    ...p,
  } as WorkItem;
}

/** Apply the head-of-line comparator the way listWorkItems does. */
function drain(items: WorkItem[]): string[] {
  return [...items].sort(compareByHeadOfLine).map((i) => i.id);
}

describe('compareByHeadOfLine — the buffered per-slot work-list order (P-005)', () => {
  it('drains ranked items head-of-line by rank ASC (0 first)', () => {
    const items = [
      wi({ id: 'C', rank: 2 }),
      wi({ id: 'A', rank: 0 }),
      wi({ id: 'B', rank: 1 }),
    ];
    expect(drain(items)).toEqual(['A', 'B', 'C']);
  });

  it('sinks unranked (rank=null) items BELOW every ranked item (buffered work runs first)', () => {
    const items = [
      wi({ id: 'unranked-new', rank: null, updatedAt: '2026-06-08T12:00:00.000Z' }),
      wi({ id: 'ranked-5', rank: 5, updatedAt: '2026-06-01T00:00:00.000Z' }),
    ];
    // Even though the unranked item is much newer, the ranked (placed) item leads.
    expect(drain(items)).toEqual(['ranked-5', 'unranked-new']);
  });

  it('breaks equal-rank ties by recency (newest first)', () => {
    const items = [
      wi({ id: 'older', rank: 1, updatedAt: '2026-06-08T08:00:00.000Z' }),
      wi({ id: 'newer', rank: 1, updatedAt: '2026-06-08T09:00:00.000Z' }),
    ];
    expect(drain(items)).toEqual(['newer', 'older']);
  });

  it('orders multiple unranked items among themselves by recency', () => {
    const items = [
      wi({ id: 'old', rank: null, updatedAt: '2026-06-08T01:00:00.000Z' }),
      wi({ id: 'new', rank: null, updatedAt: '2026-06-08T03:00:00.000Z' }),
      wi({ id: 'mid', rank: null, updatedAt: '2026-06-08T02:00:00.000Z' }),
    ];
    expect(drain(items)).toEqual(['new', 'mid', 'old']);
  });

  it('MERGES across families — a bee feature + issue items interleave by rank into one list', () => {
    const items = [
      wi({ id: 'F-2', family: 'feature', kind: 'feature', rank: 3 }),
      wi({ id: 'WI-1', family: 'issue', kind: 'task', rank: 1 }),
      wi({ id: 'F-1', family: 'feature', kind: 'feature', rank: 0 }),
      wi({ id: 'WI-2', family: 'issue', kind: 'bug', rank: 2 }),
    ];
    // One unified head-of-line order regardless of which kind-table it came from.
    expect(drain(items)).toEqual(['F-1', 'WI-1', 'WI-2', 'F-2']);
  });

  it('is a total order — stable + transitive over a buffered list of mixed ranks', () => {
    const items = [
      wi({ id: 'a', rank: 0 }),
      wi({ id: 'b', rank: null, updatedAt: '2026-06-08T05:00:00.000Z' }),
      wi({ id: 'c', rank: 2 }),
      wi({ id: 'd', rank: null, updatedAt: '2026-06-08T06:00:00.000Z' }),
      wi({ id: 'e', rank: 1 }),
    ];
    // ranked 0,1,2 then unranked newest→oldest.
    expect(drain(items)).toEqual(['a', 'e', 'c', 'd', 'b']);
  });
});

describe('compareByRecency — the default (non-ranked) order', () => {
  it('orders newest updatedAt first', () => {
    const items = [
      wi({ id: 'old', updatedAt: '2026-06-08T01:00:00.000Z' }),
      wi({ id: 'new', updatedAt: '2026-06-08T09:00:00.000Z' }),
    ];
    expect([...items].sort(compareByRecency).map((i) => i.id)).toEqual(['new', 'old']);
  });
});
