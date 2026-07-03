import { describe, expect, it } from 'vitest';
import {
  allGymNicheKeys,
  computeEmptyNicheKeys,
  hiveEmptyFrontierFromElites,
  partitionEmptyNichesForHive,
  partitionNicheKeyByHive,
} from './foreign-frontier';

describe('allGymNicheKeys', () => {
  it('enumerates the full 4×5×3 niche grid', () => {
    expect(allGymNicheKeys()).toHaveLength(60);
    expect(allGymNicheKeys()).toContain('local|planning|low');
    expect(allGymNicheKeys()).toContain('architectural|mixed|high');
  });
});

describe('computeEmptyNicheKeys', () => {
  it('subtracts occupied local/foreign niches from the full grid', () => {
    const empty = computeEmptyNicheKeys(['local|planning|low', 'module|execution|medium']);
    expect(empty).toHaveLength(58);
    expect(empty).not.toContain('local|planning|low');
    expect(empty).not.toContain('module|execution|medium');
    expect(empty).toContain('architectural|mixed|high');
  });
});

describe('HRW empty-frontier partition', () => {
  it('is deterministic per niche', () => {
    const hiveIds = ['hive-a', 'hive-b', 'hive-c'];
    expect(partitionNicheKeyByHive('local|planning|low', hiveIds)).toBe(
      partitionNicheKeyByHive('local|planning|low', hiveIds),
    );
  });

  it('partitions the empty frontier disjointly across hives', () => {
    const empty = ['local|planning|low', 'local|planning|medium', 'module|execution|high', 'architectural|mixed|low'];
    const hiveIds = ['hive-a', 'hive-b', 'hive-c'];
    const assignments = hiveIds.map((hiveId) => partitionEmptyNichesForHive(empty, hiveIds, hiveId));
    const flattened = assignments.flat();

    expect(new Set(flattened).size).toBe(flattened.length);
    expect([...flattened].sort()).toEqual([...empty].sort());
  });
});

describe('hiveEmptyFrontierFromElites — end-to-end empty-frontier pipeline', () => {
  it("returns this hive's disjoint slice; all hives' slices union to the whole empty set", () => {
    const frontier = [{ nicheKey: 'local|planning|low' }, { nicheKey: 'module|execution|medium' }];
    const hiveIds = ['hive-a', 'hive-b', 'hive-c'];
    const slices = hiveIds.map((h) => hiveEmptyFrontierFromElites(frontier, hiveIds, h));
    const flat = slices.flat();

    // disjoint across hives
    expect(new Set(flat).size).toBe(flat.length);
    // union = the full empty set (60-cell grid − 2 occupied)
    expect(flat.length).toBe(58);
    expect(flat).not.toContain('local|planning|low');
    expect(flat).not.toContain('module|execution|medium');
  });
});
