/**
 * co-seed — the shared packs every new pot receives alongside its declared pack.
 *
 * The load-bearing test here is `every co-seed id resolves to a real builtin
 * pack`. The bug this whole module exists to fix (WI-2145732) was the OTHER
 * side of that relation: a pack existed in the bundle and nothing named it, so
 * its learnings reached no install. This asserts the relation in the direction
 * a test can actually hold — an id on the list that names no pack — and the
 * `resolves nothing` control below proves the loader can return null, so a pass
 * is never vacuous.
 */
import { describe, it, expect } from 'vitest';
import { CO_SEED_PACK_IDS, PAPERCUSP_PACK_ID } from './co-seed';
import { FLEET_LESSONS_PACK_ID } from './candidates-shared';
import { DEFAULT_KNOWLEDGE_PACK_ID } from './pack-format';
import { builtinKnowledgePacksRoot, loadKnowledgePack } from './load-packs';

/** Builtin root only — no papercuspRoot()/workspacesRoot(), so this needs no workspace context. */
const builtinOnly = { roots: [{ dir: builtinKnowledgePacksRoot(), source: 'builtin' as const }] };

describe('CO_SEED_PACK_IDS', () => {
  it('carries fleet-lessons and papercusp, with no duplicates', () => {
    expect(CO_SEED_PACK_IDS).toContain(FLEET_LESSONS_PACK_ID);
    expect(CO_SEED_PACK_IDS).toContain(PAPERCUSP_PACK_ID);
    expect(new Set(CO_SEED_PACK_IDS).size).toBe(CO_SEED_PACK_IDS.length);
  });

  it('does NOT make papercusp the global default pack', () => {
    // memory-corpus-hygiene-and-release-distribution-2026-08-03: EI-1539 retired a
    // Papercusp-BRANDED pack as the wrong GLOBAL DEFAULT. Co-seeding is a different
    // mechanism; the default must stay generic.
    expect(DEFAULT_KNOWLEDGE_PACK_ID).not.toBe(PAPERCUSP_PACK_ID);
    expect(CO_SEED_PACK_IDS).not.toContain(DEFAULT_KNOWLEDGE_PACK_ID);
  });

  it('every co-seed id resolves to a real builtin pack carrying at least one item', async () => {
    for (const packId of CO_SEED_PACK_IDS) {
      const loaded = await loadKnowledgePack(packId, builtinOnly);
      expect(loaded, `co-seed pack '${packId}' does not resolve as a builtin pack`).toBeTruthy();
      expect(loaded!.pack.manifest.id).toBe(packId);
      expect(
        loaded!.pack.items.length,
        `co-seed pack '${packId}' is empty — it would seed nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it('CONTROL: an id naming no builtin pack resolves to null', async () => {
    // Calibration for the assertion above: without this, a loader that returned a
    // truthy value for everything would make that test pass while proving nothing.
    expect(await loadKnowledgePack('no-such-pack-co-seed-control', builtinOnly)).toBeNull();
  });
});
