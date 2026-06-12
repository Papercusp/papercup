import { describe, expect, it } from 'vitest';
import { demandSnapshotFromRows, EMPTY_DEMAND_SNAPSHOT, type DemandRow } from './demand-read';

const row = (over: Partial<DemandRow> = {}): DemandRow => ({
  surface: 'docs',
  query_norm: 'tauri bridge port',
  example_query: 'Tauri bridge port',
  miss_count: 4,
  distinct_agents: 2,
  last_missed_at: '2026-06-11T10:00:00.000Z',
  candidate_improvement_id: null,
  updated_at: '2026-06-12T06:00:00.000Z',
  ...over,
});

describe('demandSnapshotFromRows', () => {
  it('projects rows hottest-first with the header rollups', () => {
    const snap = demandSnapshotFromRows([
      row({ query_norm: 'cool', miss_count: 2 }),
      row({ query_norm: 'hot', miss_count: 9, candidate_improvement_id: 'EI-5' }),
      row({ query_norm: 'warm', miss_count: 4, updated_at: new Date('2026-06-12T07:00:00.000Z') }),
    ]);
    expect(snap.entries.map((e) => e.queryNorm)).toEqual(['hot', 'warm', 'cool']);
    expect(snap.totalEntries).toBe(3);
    expect(snap.totalMisses).toBe(15);
    expect(snap.filedCount).toBe(1);
    expect(snap.minedAt).toBe('2026-06-12T07:00:00.000Z');
    expect(snap.entries[0].candidateImprovementId).toBe('EI-5');
  });

  it('caps the page at limit while rollups cover the whole map', () => {
    const snap = demandSnapshotFromRows(
      Array.from({ length: 5 }, (_, i) => row({ query_norm: `q-${i}`, miss_count: i + 1 })),
      2,
    );
    expect(snap.entries).toHaveLength(2);
    expect(snap.totalEntries).toBe(5);
  });

  it('empty rows give the empty snapshot shape', () => {
    expect(demandSnapshotFromRows([])).toEqual(EMPTY_DEMAND_SNAPSHOT);
  });
});
