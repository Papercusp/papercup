/**
 * Unit tests for the QD archive (P-010) — the MAP-Elites insert-if-better policy, novelty,
 * coverage, and stepping-stones, exercised over the InMemoryArchiveStore (the same QdArchive
 * logic runs in prod over PgArchiveStore).
 */
import { describe, it, expect } from 'vitest';
import { QdArchive, InMemoryArchiveStore } from './archive';
import { coordsToFeatures, GYM_NICHE_CELL_COUNT, nicheKey, type BehaviorDescriptor, type NicheCoords } from './niche';

function desc(scope: NicheCoords['scope'], domain: string, risk: NicheCoords['risk']): BehaviorDescriptor {
  const coords: NicheCoords = { scope, domain, risk };
  return { coords, features: coordsToFeatures(coords) };
}

function freshArchive() {
  return new QdArchive(new InMemoryArchiveStore());
}

describe('QdArchive.upsertElite — insert-if-better per niche cell', () => {
  it('admits the first candidate in an empty cell as a new niche', async () => {
    const a = freshArchive();
    const r = await a.upsertElite({ candidateId: 'v1', descriptor: desc('local', 'execution', 'low'), fitness: 5 }, 1);
    expect(r.admitted).toBe(true);
    expect(r.reason).toBe('new-niche');
    expect(r.isNewNiche).toBe(true);
    expect(r.novelty).toBe(1); // empty archive → maximally novel
    expect((await a.getElite(nicheKey(desc('local', 'execution', 'low').coords)))?.candidateId).toBe('v1');
  });

  it('rejects a lower-fitness candidate in an occupied cell (dominated)', async () => {
    const a = freshArchive();
    await a.upsertElite({ candidateId: 'v1', descriptor: desc('local', 'execution', 'low'), fitness: 8 }, 1);
    const r = await a.upsertElite({ candidateId: 'v2', descriptor: desc('local', 'execution', 'low'), fitness: 6 }, 2);
    expect(r.admitted).toBe(false);
    expect(r.reason).toBe('dominated');
    expect(r.elite.candidateId).toBe('v1'); // incumbent stays
    expect(r.novelty).toBe(0); // landed on a covered cell
  });

  it('replaces a lower-fitness incumbent with a fitter candidate (improved)', async () => {
    const a = freshArchive();
    await a.upsertElite({ candidateId: 'v1', descriptor: desc('local', 'execution', 'low'), fitness: 5 }, 1);
    const r = await a.upsertElite({ candidateId: 'v2', descriptor: desc('local', 'execution', 'low'), fitness: 9 }, 2);
    expect(r.admitted).toBe(true);
    expect(r.reason).toBe('improved');
    expect(r.replaced).toBe('v1');
    expect((await a.getElite(r.nicheKey))?.candidateId).toBe('v2');
  });

  it('keeps distinct cells independently (diversity, not a single global champion)', async () => {
    const a = freshArchive();
    await a.upsertElite({ candidateId: 'v1', descriptor: desc('local', 'execution', 'low'), fitness: 9 }, 1);
    await a.upsertElite({ candidateId: 'v2', descriptor: desc('architectural', 'knowledge', 'high'), fitness: 3 }, 2);
    const elites = await a.listElites();
    expect(elites).toHaveLength(2);
    // the weaker idea in its own niche is preserved despite a fitter idea existing elsewhere
    expect(elites.map((e) => e.candidateId).sort()).toEqual(['v1', 'v2']);
  });

  it('defaults source to gym and carries rationale', async () => {
    const a = freshArchive();
    const r = await a.upsertElite({ candidateId: 'v1', descriptor: desc('local', 'execution', 'low'), fitness: 5, rationale: 'why' }, 1);
    expect(r.elite.source).toBe('gym');
    expect(r.elite.rationale).toBe('why');
    expect(r.elite.updatedAt).toBe(1);
  });
});

describe('QdArchive.listElites', () => {
  it('orders by fitness desc and supports source filter + limit', async () => {
    const a = freshArchive();
    await a.upsertElite({ candidateId: 'g1', descriptor: desc('local', 'execution', 'low'), fitness: 4 }, 1);
    await a.upsertElite({ candidateId: 'g2', descriptor: desc('module', 'planning', 'low'), fitness: 8 }, 2);
    await a.upsertElite({ candidateId: 's1', descriptor: desc('architectural', 'knowledge', 'high'), fitness: 1, source: 'scout' }, 3);

    const all = await a.listElites();
    expect(all.map((e) => e.candidateId)).toEqual(['g2', 'g1', 's1']); // fitness desc

    const scoutOnly = await a.listElites({ source: 'scout' });
    expect(scoutOnly.map((e) => e.candidateId)).toEqual(['s1']);

    const top1 = await a.listElites({ limit: 1 });
    expect(top1.map((e) => e.candidateId)).toEqual(['g2']);
  });
});

describe('QdArchive.noveltyScore (the P-011 signal)', () => {
  it('is 1 for an empty archive', async () => {
    const a = freshArchive();
    expect(await a.noveltyScore(desc('local', 'execution', 'low'))).toBe(1);
  });

  it('is higher for a descriptor in a sparse region than a dense one', async () => {
    const a = freshArchive();
    // a dense cluster near (local, execution, low)
    await a.upsertElite({ candidateId: 'c1', descriptor: desc('local', 'execution', 'low'), fitness: 5 }, 1);
    await a.upsertElite({ candidateId: 'c2', descriptor: desc('module', 'execution', 'low'), fitness: 5 }, 2);
    await a.upsertElite({ candidateId: 'c3', descriptor: desc('local', 'execution', 'medium'), fitness: 5 }, 3);

    const inCluster = await a.noveltyScore(desc('module', 'execution', 'medium'), 2);
    const farAway = await a.noveltyScore(desc('architectural', 'knowledge', 'high'), 2);
    expect(farAway).toBeGreaterThan(inCluster);
  });

  it('excludes an elite from its own novelty (uses the others)', async () => {
    const a = freshArchive();
    await a.upsertElite({ candidateId: 'c1', descriptor: desc('local', 'execution', 'low'), fitness: 5 }, 1);
    // querying the same descriptor that is the only member → only-self → maximally novel
    expect(await a.noveltyScore(desc('local', 'execution', 'low'))).toBe(1);
  });
});

describe('QdArchive.coverage', () => {
  it('reports filled / total / fraction against the 60-cell grid', async () => {
    const a = freshArchive();
    await a.upsertElite({ candidateId: 'c1', descriptor: desc('local', 'execution', 'low'), fitness: 5 }, 1);
    await a.upsertElite({ candidateId: 'c2', descriptor: desc('module', 'planning', 'high'), fitness: 5 }, 2);
    const cov = await a.coverage();
    expect(cov.filled).toBe(2);
    expect(cov.total).toBe(GYM_NICHE_CELL_COUNT);
    expect(cov.fraction).toBeCloseTo(2 / GYM_NICHE_CELL_COUNT, 12);
  });
});

describe('QdArchive.steppingStones (P-012 feed)', () => {
  async function seeded() {
    const a = freshArchive();
    await a.upsertElite({ candidateId: 'corner-lo', descriptor: desc('local', 'execution', 'low'), fitness: 9 }, 1);
    await a.upsertElite({ candidateId: 'corner-hi', descriptor: desc('architectural', 'knowledge', 'high'), fitness: 8 }, 2);
    await a.upsertElite({ candidateId: 'mid', descriptor: desc('module', 'quality', 'medium'), fitness: 7 }, 3);
    await a.upsertElite({ candidateId: 'mid2', descriptor: desc('cross-cutting', 'planning', 'medium'), fitness: 6 }, 4);
    return a;
  }

  it('returns all elites when there are no more than k', async () => {
    const a = freshArchive();
    await a.upsertElite({ candidateId: 'only', descriptor: desc('local', 'execution', 'low'), fitness: 5 }, 1);
    expect((await a.steppingStones({ k: 5 })).map((e) => e.candidateId)).toEqual(['only']);
  });

  it('with an anchor descriptor returns the FARTHEST elites first (distant niches)', async () => {
    const a = await seeded();
    const stones = await a.steppingStones({ descriptor: desc('local', 'execution', 'low'), k: 1 });
    expect(stones[0].candidateId).toBe('corner-hi'); // the maximally-distant niche from the anchor
  });

  it('without an anchor returns a diverse spread seeded by the fittest', async () => {
    const a = await seeded();
    const stones = await a.steppingStones({ k: 2 });
    expect(stones).toHaveLength(2);
    expect(stones[0].candidateId).toBe('corner-lo'); // fittest seeds the spread
    // the second pick is the elite farthest from the first → the opposite corner
    expect(stones[1].candidateId).toBe('corner-hi');
  });
});
