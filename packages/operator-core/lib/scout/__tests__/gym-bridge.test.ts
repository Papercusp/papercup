import { describe, it, expect } from 'vitest';
import {
  type ArchiveEliteView,
  type ArchivePort,
  type ArchiveSeedEntry,
  type BehaviorDescriptor,
  type NicheCoords,
  type ScoutIdeaView,
  behaviorDistance,
  describeScoutIdea,
  gatherSteppingStones,
  nicheKey,
  noveltyDistance,
  riskOrdinal,
  scopeOrdinal,
  seedDistantNiches,
} from '../gym-bridge';

// ── test doubles ──────────────────────────────────────────────────────────────

/** In-memory archive mirroring the real MAP-Elites semantics: a scout seed (fitness 0)
 *  is admitted only into an EMPTY niche cell. */
class FakeArchive implements ArchivePort {
  readonly cells = new Map<string, ArchiveEliteView>();
  constructor(seedElites: ArchiveEliteView[] = []) {
    for (const e of seedElites) this.cells.set(e.nicheKey, e);
  }
  listElites(): readonly ArchiveEliteView[] {
    return [...this.cells.values()];
  }
  seed(entry: ArchiveSeedEntry): { admitted: boolean; nicheKey: string } {
    const key = nicheKey(entry.descriptor.coords);
    if (this.cells.has(key)) return { admitted: false, nicheKey: key };
    this.cells.set(key, {
      nicheKey: key,
      coords: entry.descriptor.coords,
      candidateId: entry.candidateId,
      fitness: 0,
      descriptor: entry.descriptor,
      source: 'scout',
      rationale: entry.rationale,
    });
    return { admitted: true, nicheKey: key };
  }
}

function elite(
  id: string,
  coords: NicheCoords,
  features: number[],
  fitness = 0.5,
  source: 'gym' | 'scout' = 'gym',
): ArchiveEliteView {
  return { nicheKey: nicheKey(coords), coords, candidateId: id, fitness, descriptor: { coords, features }, source };
}

const C = (scope: NicheCoords['scope'], domain: string, risk: NicheCoords['risk']): NicheCoords => ({ scope, domain, risk });

// ── pure behaviour-space helpers ────────────────────────────────────────────

describe('nicheKey + ordinals', () => {
  it('builds a stable lowercased key', () => {
    expect(nicheKey(C('module', 'Coord', 'high'))).toBe('module|coord|high');
  });
  it('orders the discretised bands', () => {
    expect(scopeOrdinal('local')).toBe(0);
    expect(scopeOrdinal('architectural')).toBe(3);
    expect(riskOrdinal('low')).toBe(0);
    expect(riskOrdinal('high')).toBe(2);
  });
});

describe('behaviorDistance', () => {
  const d = (features: number[], domain = 'x'): BehaviorDescriptor => ({ coords: C('module', domain, 'low'), features });

  it('is Euclidean over features when the domain matches', () => {
    expect(behaviorDistance(d([0, 0, 0, 0]), d([1, 1, 1, 1]))).toBeCloseTo(2, 10); // sqrt(4)
    expect(behaviorDistance(d([0, 0]), d([3, 4]))).toBeCloseTo(5, 10);
  });
  it('adds a categorical penalty when the domain differs', () => {
    expect(behaviorDistance(d([0, 0, 0, 0], 'a'), d([0, 0, 0, 0], 'b'))).toBeCloseTo(1, 10); // sqrt(0 + 1)
  });
  it('is symmetric and length-tolerant (zero-pads the shorter vector)', () => {
    const a = d([0.2, 0.8]);
    const b = d([0.2, 0.8, 0.5, 0.5]);
    expect(behaviorDistance(a, b)).toBeCloseTo(behaviorDistance(b, a), 10);
    expect(behaviorDistance(a, b)).toBeCloseTo(Math.sqrt(0.25 + 0.25), 10);
  });
});

describe('noveltyDistance', () => {
  const d = (f: number[]): BehaviorDescriptor => ({ coords: C('module', 'x', 'low'), features: f });
  it('is Infinity against an empty archive (an open region is maximally novel)', () => {
    expect(noveltyDistance(d([0, 0, 0, 0]), [])).toBe(Infinity);
  });
  it('is the mean distance to the k nearest elites', () => {
    const elites = [{ descriptor: d([1, 0, 0, 0]) }, { descriptor: d([2, 0, 0, 0]) }, { descriptor: d([3, 0, 0, 0]) }];
    expect(noveltyDistance(d([0, 0, 0, 0]), elites, 2)).toBeCloseTo(1.5, 10); // (1 + 2)/2
    expect(noveltyDistance(d([0, 0, 0, 0]), elites, 1)).toBeCloseTo(1, 10);
  });
});

describe('describeScoutIdea (default characterisation)', () => {
  it('uses self-reported coords + a novelty/feasibility/scope/risk feature vector', () => {
    const desc = describeScoutIdea({ id: 'i1', scope: 'cross-cutting', domain: 'Gym', risk: 'high', novelty: 0.8, feasibility: 0.4 });
    expect(desc.coords).toEqual(C('cross-cutting', 'gym', 'high'));
    expect(desc.features).toEqual([0.8, 0.4, scopeOrdinal('cross-cutting') / 3, riskOrdinal('high') / 2]);
  });
  it('falls back conservatively, and a moonshot defaults to high-novelty/high-risk', () => {
    const desc = describeScoutIdea({ id: 'i2', moonshot: true });
    expect(desc.coords).toEqual(C('module', 'general', 'high'));
    expect(desc.features[0]).toBeCloseTo(0.9, 10); // novelty
  });
  it('clamps out-of-range critic scores to [0,1]', () => {
    const desc = describeScoutIdea({ id: 'i3', novelty: 5, feasibility: -2 });
    expect(desc.features[0]).toBe(1);
    expect(desc.features[1]).toBe(0);
  });
});

// ── archive → Scout : gatherSteppingStones ──────────────────────────────────

describe('gatherSteppingStones', () => {
  it('returns no stones + an empty-archive priming note when the archive is empty', () => {
    const res = gatherSteppingStones(new FakeArchive());
    expect(res.stones).toEqual([]);
    expect(res.priming).toContain('archive is empty');
  });

  it('honours count=0', () => {
    const a = new FakeArchive([elite('A', C('local', 'x', 'low'), [0, 0, 0, 0])]);
    expect(gatherSteppingStones(a, { count: 0 }).stones).toEqual([]);
  });

  it('picks the maximally-spread pair via farthest-point sampling', () => {
    // A and B are the two extremes; C is the midpoint, D hugs B. The diverse pick is {A,B}.
    const a = new FakeArchive([
      elite('A', C('local', 'x', 'low'), [0, 0, 0, 0]),
      elite('B', C('architectural', 'x', 'high'), [1, 1, 1, 1]),
      elite('C', C('module', 'x', 'medium'), [0.5, 0.5, 0.5, 0.5]),
      elite('D', C('architectural', 'x', 'high'), [0.9, 0.9, 0.9, 0.9]),
    ]);
    const res = gatherSteppingStones(a, { count: 2 });
    expect(res.stones.map((s) => s.candidateId).sort()).toEqual(['A', 'B']);
  });

  it('grows the diverse set deterministically (A,B then the midpoint C, not the near-duplicate D)', () => {
    const a = new FakeArchive([
      elite('A', C('local', 'x', 'low'), [0, 0, 0, 0]),
      elite('B', C('architectural', 'x', 'high'), [1, 1, 1, 1]),
      elite('C', C('module', 'x', 'medium'), [0.5, 0.5, 0.5, 0.5]),
      elite('D', C('architectural', 'x', 'high'), [0.9, 0.9, 0.9, 0.9]),
    ]);
    const ids = gatherSteppingStones(a, { count: 3 }).stones.map((s) => s.candidateId);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    expect(ids).toContain('C');
    expect(ids).not.toContain('D');
  });

  it('biasSparse=false seeds the walk from the highest-fitness elite', () => {
    const a = new FakeArchive([
      elite('A', C('local', 'x', 'low'), [0, 0, 0, 0], 0.1),
      elite('B', C('architectural', 'x', 'high'), [1, 1, 1, 1], 0.9),
      elite('C', C('module', 'x', 'medium'), [0.5, 0.5, 0.5, 0.5], 0.2),
    ]);
    const res = gatherSteppingStones(a, { count: 1, biasSparse: false });
    expect(res.stones.map((s) => s.candidateId)).toEqual(['B']);
  });

  it('formats priming with niche coords + source tag', () => {
    const a = new FakeArchive([
      elite('A', C('module', 'coord', 'low'), [0, 0, 0, 0], 0.73, 'gym'),
      elite('S', C('architectural', 'sync', 'high'), [1, 1, 1, 1], 0, 'scout'),
    ]);
    const { priming } = gatherSteppingStones(a, { count: 2 });
    expect(priming).toContain('module/coord/low risk');
    expect(priming).toContain('gym fitness 0.73');
    expect(priming).toContain('architectural/sync/high risk');
    expect(priming).toContain('scout-seed');
  });
});

// ── Scout → archive : seedDistantNiches ─────────────────────────────────────

describe('seedDistantNiches', () => {
  const idea = (id: string, over: Partial<ScoutIdeaView> = {}): ScoutIdeaView => ({ id, scope: 'module', domain: 'gym', risk: 'low', novelty: 0.5, feasibility: 0.5, ...over });

  it('opens new niches in an empty archive and reports the coverage gain', () => {
    const a = new FakeArchive();
    const res = seedDistantNiches([idea('i1', { domain: 'coord' }), idea('i2', { domain: 'sync', scope: 'architectural', risk: 'high' })], a);
    expect(res.seeded.every((s) => s.admitted)).toBe(true);
    expect(res.newNiches).toEqual(['module|coord|low', 'architectural|sync|high']);
    expect(a.listElites()).toHaveLength(2);
  });

  it('does not re-open an already-occupied niche', () => {
    const a = new FakeArchive([elite('incumbent', C('module', 'gym', 'low'), [0.5, 0.5, 1 / 3, 0])]);
    const res = seedDistantNiches([idea('dup')], a);
    expect(res.seeded[0].admitted).toBe(false);
    expect(res.newNiches).toEqual([]);
    expect(res.skipped.some((s) => s.reason.includes('already occupied'))).toBe(true);
    // The incumbent (fitness 0.5) is NOT clobbered by the scout seed.
    expect(a.cells.get('module|gym|low')?.candidateId).toBe('incumbent');
  });

  it('skips ideas too close to the archive when minDistance is raised', () => {
    // Archive elite at the exact descriptor a non-moonshot idea would produce ⇒ distance 0.
    const a = new FakeArchive([elite('near', C('module', 'gym', 'low'), [0.5, 0.5, 1 / 3, 0])]);
    const res = seedDistantNiches([idea('close')], a, { minDistance: 1 });
    expect(res.seeded).toEqual([]);
    expect(res.skipped[0].reason).toContain('too close to archive');
  });

  it('always seeds a moonshot even when it is close, if includeMoonshots', () => {
    const a = new FakeArchive([elite('near', C('module', 'gym', 'high'), [0.9, 0.5, 1 / 3, 1])]);
    // A moonshot idea whose default coords collide with the occupied cell — distance is small,
    // but includeMoonshots forces the seed attempt (which the archive then rejects as occupied).
    const res = seedDistantNiches([idea('moon', { moonshot: true, risk: 'high', novelty: 0.9 })], a, { minDistance: 5 });
    expect(res.seeded).toHaveLength(1);
    expect(res.seeded[0].ideaId).toBe('moon');
  });

  it('uses an injected describer when provided', () => {
    const a = new FakeArchive();
    const fixedDescribe = (): BehaviorDescriptor => ({ coords: C('architectural', 'custom', 'high'), features: [1, 0, 1, 1] });
    const res = seedDistantNiches([idea('x')], a, {}, fixedDescribe);
    expect(res.newNiches).toEqual(['architectural|custom|high']);
  });
});
