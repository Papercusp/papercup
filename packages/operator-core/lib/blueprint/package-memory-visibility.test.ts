import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryEntry } from '@papercusp/memory';
import { PACK_MEMORY_SOURCE } from '../knowledge-packs/pack-format';
import { IDENTITY_PACKAGE_RESOURCE, PINNED_PACK_BOOST, isIdentityPackageHit, packageRecallEligibility,
  shapeIdentityPackageHits, wearerPackageResourcesOrEmpty } from './package-memory-visibility';

const packHit = (id: string, item: string, version: string, resource: string | null, score: number): MemoryEntry => ({
  id, text: `${item} ${version}`, scope: 'harness:t', score,
  metadata: { source: PACK_MEMORY_SOURCE, pack_id: 'pack', pack_item_id: item, pack_version: version,
    ...(resource ? { [IDENTITY_PACKAGE_RESOURCE]: resource } : {}) } });
const organic: MemoryEntry = { id: 'organic', text: 'organic', scope: 'harness:t', score: 0.85 };

describe('shapeIdentityPackageHits', () => {
  it('keeps the pinned exact version over a higher-scored promoted copy, boosts it and stamps provenance', () => {
    const promoted = packHit('v1', 'item', '1', 'r1', 0.9);
    const pinned = packHit('v2', 'item', '2', 'r2', 0.8);
    const shaped = shapeIdentityPackageHits([promoted, organic, pinned], new Set(['r2']));
    expect(shaped.map((hit) => hit.id)).toEqual(['v2', 'organic']);
    expect(shaped[0]!.score).toBeCloseTo(0.8 * PINNED_PACK_BOOST);
    expect(shaped[0]!.metadata!.identity_package).toEqual({ pack_id: 'pack', pack_version: '2', pack_item_id: 'item', pinned: true });
    expect(shaped[1]).toBe(organic);
  });

  it('without a pin keeps the higher score unboosted, one hit per item rather than per pack', () => {
    const shaped = shapeIdentityPackageHits([packHit('v2', 'item', '2', 'r2', 0.8), packHit('v1', 'item', '1', 'r1', 0.9),
      packHit('other', 'other', '1', null, 0.5)], new Set());
    expect(shaped.map((hit) => [hit.id, hit.score])).toEqual([['v1', 0.9], ['other', 0.5]]);
    expect(shaped[0]!.metadata!.identity_package).toMatchObject({ pinned: false });
  });

  it('passes rows without complete pack provenance through untouched and keeps input order on ties', () => {
    const partial: MemoryEntry = { id: 'partial', text: 'p', scope: 'harness:t', score: 0.5,
      metadata: { source: PACK_MEMORY_SOURCE, pack_id: 'pack' } };
    const tie: MemoryEntry = { id: 'tie', text: 't', scope: 'harness:t', score: 0.5 };
    expect(shapeIdentityPackageHits([partial, tie], new Set(['r1']))).toEqual([partial, tie]);
    expect(shapeIdentityPackageHits([tie, partial], new Set())).toEqual([tie, partial]);
  });
});

describe('recall eligibility inputs', () => {
  it('admits nothing for an empty pin set and the sorted exact keys otherwise', () => {
    expect(packageRecallEligibility(new Set())).toEqual({});
    expect(packageRecallEligibility(new Set(['b', 'a']))).toEqual({
      archivedEligibility: { key: IDENTITY_PACKAGE_RESOURCE, values: ['a', 'b'] } });
    expect(isIdentityPackageHit(packHit('x', 'item', '1', 'r1', 1))).toBe(true);
    expect(isIdentityPackageHit(packHit('x', 'item', '1', null, 1))).toBe(false);
  });

  it('fails closed to no pack rows when there is no wearer or the resolver throws', async () => {
    const sql = vi.fn(() => { throw new Error('db down'); }) as unknown as Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await wearerPackageResourcesOrEmpty(sql, { workspaceId: 'ws', ownerId: null })).toEqual(new Set());
      expect(sql).not.toHaveBeenCalled();
      expect(await wearerPackageResourcesOrEmpty(sql, { workspaceId: 'ws', ownerId: 'wearer' })).toEqual(new Set());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    } finally { warn.mockRestore(); }
  });
});
