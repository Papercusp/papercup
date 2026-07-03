import { describe, expect, it } from 'vitest';
import { CONTROL_HIVE_FEDERATED_PRIMING, DEFAULT_FEDERATED_PRIMING } from './federated-priming';
import type { RoutedIdeaProvenance } from './outcome-feedback';
import {
  buildNoveltyGainReport,
  computeNoveltyGainReport,
  mapProvenanceToNoveltyRow,
  type NoveltyIdeaRow,
} from './novelty-metrics';

describe('computeNoveltyGainReport — empty/scaffold safety', () => {
  it('yields an all-zero/all-null report (never NaN) on empty input', () => {
    const r = computeNoveltyGainReport({ elites: [], ideas: [] });
    expect(r).toEqual({
      uniqueNichesOccupied: 0,
      localNichesOccupied: 0,
      foreignAddedNiches: 0,
      peerCount: 0,
      nichesPerPeer: null,
      dedupConsidered: 0,
      dedupRate: null,
      foreignSeededDecided: 0,
      localOnlyDecided: 0,
      foreignSeededWinRate: null,
      localOnlyWinRate: null,
      isControlArm: false,
    });
  });

  it('keeps foreignSeededWinRate null until a seeded idea is decided (P-008 scaffold)', () => {
    const r = computeNoveltyGainReport({
      elites: [],
      ideas: [{ humanGrade: 5 }, { humanGrade: 1 }], // both local-only, no seededByRefs
    });
    expect(r.localOnlyDecided).toBe(2);
    expect(r.foreignSeededDecided).toBe(0);
    expect(r.foreignSeededWinRate).toBeNull();
  });
});

describe('computeNoveltyGainReport — (a) niche occupancy / novelty gain', () => {
  it('counts network-wide niches and the foreign-only slice as the per-peer gain', () => {
    const r = computeNoveltyGainReport({
      elites: [
        { nicheKey: 'A', fitness: 0.9, sourceHive: null }, // local, niche A
        { nicheKey: 'A', fitness: 0.7, sourceHive: 'peer-2' }, // foreign also in A
        { nicheKey: 'B', fitness: 0.8, sourceHive: 'peer-1' }, // foreign-only niche
        { nicheKey: 'C', fitness: 0.6, sourceHive: 'peer-1' }, // foreign-only niche
      ],
      ideas: [],
    });
    expect(r.uniqueNichesOccupied).toBe(3); // A, B, C
    expect(r.localNichesOccupied).toBe(1); // A
    expect(r.foreignAddedNiches).toBe(2); // B, C — novelty gifts
    expect(r.peerCount).toBe(2); // peer-1, peer-2
    expect(r.nichesPerPeer).toBe(1); // 2 foreign-added / 2 peers
  });

  it('treats blank/whitespace sourceHive as local', () => {
    const r = computeNoveltyGainReport({
      elites: [
        { nicheKey: 'A', fitness: 0.9, sourceHive: '' },
        { nicheKey: 'A', fitness: 0.9, sourceHive: '   ' },
      ],
      ideas: [],
    });
    expect(r.localNichesOccupied).toBe(1);
    expect(r.foreignAddedNiches).toBe(0);
    expect(r.peerCount).toBe(0);
    expect(r.nichesPerPeer).toBeNull();
  });

  it('canonicalizes raw niche keys through the mapKey seam before counting', () => {
    const r = computeNoveltyGainReport({
      elites: [
        { nicheKey: 'v1:loop/guard/r2/m', fitness: 0.9, sourceHive: null },
        { nicheKey: 'v2:emb/0007', fitness: 0.8, sourceHive: 'peer-a' },
      ],
      ideas: [],
      mapKey: () => 'X', // collapse both raw keys into one canonical niche
    });
    expect(r.uniqueNichesOccupied).toBe(1);
    expect(r.localNichesOccupied).toBe(1); // the collapsed niche has a local elite
    expect(r.foreignAddedNiches).toBe(0);
    expect(r.peerCount).toBe(1);
  });
});

describe('computeNoveltyGainReport — (c) foreign-seeded vs local-only win-rate', () => {
  it('buckets by seededByRefs and uses fractional winCredit semantics', () => {
    const r = computeNoveltyGainReport({
      elites: [],
      ideas: [
        { seededByRefs: ['e1'], humanGrade: 5 }, // seeded: +1.0 won
        { seededByRefs: ['e2'], humanGrade: 3 }, // seeded: +0.5 won / +0.5 lost
        { humanGrade: 4 }, // local: +0.75 won / +0.25 lost
        { humanGrade: 1 }, // local: +0.0 won / +1.0 lost
        { outcome: 'won' }, // local (ungraded feed win): +1.0 won
        { outcome: 'pending' }, // undecided — excluded from both denominators
      ],
    });
    expect(r.foreignSeededDecided).toBe(2);
    expect(r.foreignSeededWinRate).toBeCloseTo(0.75, 10); // 1.5 / 2
    expect(r.localOnlyDecided).toBe(3);
    expect(r.localOnlyWinRate).toBeCloseTo(1.75 / 3, 10);
  });

  it('ignores empty seededByRefs arrays (treated local-only)', () => {
    const r = computeNoveltyGainReport({
      elites: [],
      ideas: [{ seededByRefs: [], humanGrade: 5 }],
    });
    expect(r.foreignSeededDecided).toBe(0);
    expect(r.localOnlyDecided).toBe(1);
  });
});

describe('computeNoveltyGainReport — (b) dedup rate', () => {
  it('rates duplicates only over rows carrying a duplicate verdict', () => {
    const ideas: NoveltyIdeaRow[] = [
      { duplicate: true },
      { duplicate: false },
      { duplicate: true },
      { humanGrade: 5 }, // no duplicate verdict → not in the dedup denominator
    ];
    const r = computeNoveltyGainReport({ elites: [], ideas });
    expect(r.dedupConsidered).toBe(3);
    expect(r.dedupRate).toBeCloseTo(2 / 3, 10);
  });
});

describe('computeNoveltyGainReport — control-arm baseline (P-016)', () => {
  it('stamps isControlArm from the migration-rate-0 profile', () => {
    expect(
      computeNoveltyGainReport({ elites: [], ideas: [], priming: CONTROL_HIVE_FEDERATED_PRIMING }).isControlArm,
    ).toBe(true);
    expect(
      computeNoveltyGainReport({ elites: [], ideas: [], priming: DEFAULT_FEDERATED_PRIMING }).isControlArm,
    ).toBe(false);
    expect(computeNoveltyGainReport({ elites: [], ideas: [] }).isControlArm).toBe(false);
  });
});

describe('buildNoveltyGainReport — assembly over injected readers', () => {
  it('folds injected elites + ideas into the report without touching PG', async () => {
    const r = await buildNoveltyGainReport({
      scope: { workspaceId: 'ws', harnessSlug: 'h' },
      priming: CONTROL_HIVE_FEDERATED_PRIMING,
      readers: {
        listElites: async () => [{ nicheKey: 'A', fitness: 1, sourceHive: 'peer-1' }],
        listIdeas: async () => [{ humanGrade: 5, seededByRefs: ['e1'] }],
      },
    });
    expect(r.uniqueNichesOccupied).toBe(1);
    expect(r.foreignAddedNiches).toBe(1);
    expect(r.peerCount).toBe(1);
    expect(r.foreignSeededDecided).toBe(1);
    expect(r.foreignSeededWinRate).toBe(1);
    expect(r.isControlArm).toBe(true);
  });
});

describe('mapProvenanceToNoveltyRow', () => {
  const base = {
    ideaId: 'i1',
    lens: 'first-principles',
    rail: 'plan',
    routedRef: 'plan:x',
  } as unknown as RoutedIdeaProvenance;

  it('maps the grade and defaults seededByRefs to null (no P-008 column yet)', () => {
    expect(mapProvenanceToNoveltyRow({ ...base, humanGrade: 4 })).toEqual({
      humanGrade: 4,
      seededByRefs: null,
    });
  });

  it('surfaces seededByRefs the moment the ledger row carries it (forward-compat seam)', () => {
    const withSeed = { ...base, humanGrade: 5, seededByRefs: ['elite:abc'] } as unknown as RoutedIdeaProvenance;
    expect(mapProvenanceToNoveltyRow(withSeed)).toEqual({
      humanGrade: 5,
      seededByRefs: ['elite:abc'],
    });
  });
});
