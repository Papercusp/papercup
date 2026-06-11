/**
 * Pins the shipped `papercusp-default` pack (learning-packs-2026-06-11 P-002):
 * it must load through the real builtin root, parse with zero warnings, and
 * stay inside the plan's 20–40 item band. A content typo (bad frontmatter,
 * empty body, dup id) fails HERE, not silently at hive creation.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEARNING_PACK_ID, validatePack, filterByShapes } from './pack-format';
import { loadLearningPack } from './load-packs';

describe('papercusp-default pack (shipped content)', () => {
  it('loads cleanly from the builtin root', async () => {
    const loaded = await loadLearningPack(DEFAULT_LEARNING_PACK_ID);
    expect(loaded, 'builtin papercusp-default pack must resolve').toBeTruthy();
    expect(loaded!.source).toBe('builtin');
    expect(loaded!.warnings).toEqual([]);
    expect(validatePack(loaded!.pack)).toEqual([]);
  });

  it('stays in the 20–40 learning band with every shape represented', async () => {
    const { pack } = (await loadLearningPack(DEFAULT_LEARNING_PACK_ID))!;
    expect(pack.items.length).toBeGreaterThanOrEqual(20);
    expect(pack.items.length).toBeLessThanOrEqual(40);

    // Repo-less hives still get a substantial 'any' core (D-008/OQ-3) …
    const anyCore = filterByShapes(pack.items);
    expect(anyCore.length).toBeGreaterThanOrEqual(20);
    // … and each conditional shape contributes at least one learning.
    for (const shape of ['ui', 'service', 'library', 'cli'] as const) {
      expect(
        filterByShapes(pack.items, [shape]).length,
        `shape ${shape} adds learnings`,
      ).toBeGreaterThan(anyCore.length - 1);
    }
  });
});
