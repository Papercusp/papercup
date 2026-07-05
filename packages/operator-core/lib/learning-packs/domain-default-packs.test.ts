/**
 * Pins the two GENERIC domain default learning packs + their blueprint wiring
 * (domain-generic-hive-architecture-2026-06-18 P-017, D-010).
 *
 * D-010: a coding hive seeds a GENERIC `coding` pack and a work hive a GENERIC
 * `work` pack — generic engineering / work wisdom, NOT project-specific (project
 * specifics ride the per-hive override + a separate project pack, never the
 * blueprint). This test fails HERE — not silently at hive creation — if a pack
 * develops a content typo, drifts off-domain, or the blueprint `learning.pack`
 * wiring breaks.
 *
 * The wiring assertions resolve through the EXACT path createHiveHarness uses
 * (operatorResolveExtends → resolveAndValidate), so a regression in the extends
 * deep-merge (e.g. `work` losing its `pack: work` override and inheriting
 * `coding`) is caught.
 */
import { describe, expect, it } from 'vitest';
import { validatePack, filterByShapes } from './pack-format';
import { loadLearningPack } from './load-packs';
import { operatorResolveExtends } from '../blueprint/installed-blueprints';
import { resolveAndValidate } from '../agent-tools/blueprint/_resolve';

describe('generic `coding` default pack (shipped content)', () => {
  it('loads cleanly from the builtin root and validates', async () => {
    const loaded = await loadLearningPack('coding');
    expect(loaded, 'builtin `coding` pack must resolve').toBeTruthy();
    expect(loaded!.source).toBe('builtin');
    expect(loaded!.warnings).toEqual([]);
    expect(validatePack(loaded!.pack)).toEqual([]);
  });

  it('is a substantial coding pack: 20–40 items, every project shape represented', async () => {
    const { pack } = (await loadLearningPack('coding'))!;
    expect(pack.items.length).toBeGreaterThanOrEqual(20);
    expect(pack.items.length).toBeLessThanOrEqual(40);

    // Repo-less hives still inherit a substantial `any` core (D-008/OQ-3) …
    const anyCore = filterByShapes(pack.items);
    expect(anyCore.length).toBeGreaterThanOrEqual(20);
    // … and each conditional coding shape contributes at least one learning.
    for (const shape of ['ui', 'service', 'library', 'cli'] as const) {
      expect(
        filterByShapes(pack.items, [shape]).length,
        `shape ${shape} adds coding learnings`,
      ).toBeGreaterThan(anyCore.length - 1);
    }
  });

  it('carries coding-domain learnings (it is the coding pack, not the work pack)', async () => {
    const { pack } = (await loadLearningPack('coding'))!;
    const ids = new Set(pack.items.map((i) => i.id));
    for (const id of ['tests-ship-with-feature', 'migrations-not-runtime-ddl', 'use-existing-test-framework']) {
      expect(ids.has(id), `coding pack carries ${id}`).toBe(true);
    }
  });
});

describe('generic `work` default pack (shipped content)', () => {
  it('loads cleanly from the builtin root and validates', async () => {
    const loaded = await loadLearningPack('work');
    expect(loaded, 'builtin `work` pack must resolve').toBeTruthy();
    expect(loaded!.source).toBe('builtin');
    expect(loaded!.warnings).toEqual([]);
    expect(validatePack(loaded!.pack)).toEqual([]);
  });

  it('is a substantial, fully repo-less-seedable pack (every item is `any`)', async () => {
    const { pack } = (await loadLearningPack('work'))!;
    expect(pack.items.length).toBeGreaterThanOrEqual(20);
    // A work hive is repo-less ⇒ blueprint detection yields no shapes ⇒ only
    // `any`-tagged items seed (D-008/OQ-3). So EVERY work learning must be `any`,
    // or it would never reach a work hive. anyCore === full set proves it.
    const anyCore = filterByShapes(pack.items);
    expect(anyCore.length).toBe(pack.items.length);
  });

  it('carries work-domain learnings and drops coding-only ones (D-010)', async () => {
    const { pack } = (await loadLearningPack('work'))!;
    const ids = new Set(pack.items.map((i) => i.id));
    // Work-specific judgment present …
    for (const id of [
      'deliverable-is-the-output',
      'acceptance-is-a-judge-verdict',
      'decompose-by-topic',
      'ground-claims-in-sources',
    ]) {
      expect(ids.has(id), `work pack carries ${id}`).toBe(true);
    }
    // … coding-only learnings absent (a work hive has no test suite / migrations / UI).
    for (const id of [
      'tests-ship-with-feature',
      'migrations-not-runtime-ddl',
      'use-existing-test-framework',
      'design-system-first',
      'ui-state-idiom',
    ]) {
      expect(ids.has(id), `work pack omits coding-only ${id}`).toBe(false);
    }
  });
});

describe('blueprint → default-pack wiring (resolved via the pot-create path)', () => {
  const resolver = operatorResolveExtends({ localDirs: [] });

  it('the coding pot (`coding`) defaults to the generic `coding` pack', () => {
    const v = resolveAndValidate({ id: 'probe-hive', extends: 'coding' }, resolver);
    expect(v.ok, v.parseError ?? JSON.stringify(v.validation?.errors)).toBe(true);
    expect(v.blueprint!.learning?.pack).toBe('coding');
    expect(v.blueprint!.kind).toBe('pot');
  });

  it('the work hive (`generic-hive`) overrides to the generic `work` pack, keeping its scout loop', () => {
    const v = resolveAndValidate({ id: 'probe-generic-hive', extends: 'work' }, resolver);
    expect(v.ok, v.parseError ?? JSON.stringify(v.validation?.errors)).toBe(true);
    // `pack: work` must win over the inherited `pack: coding` (extends deep-merge
    // replaces the scalar) — the regression this test exists to catch.
    expect(v.blueprint!.learning?.pack).toBe('work');
    expect(v.blueprint!.learning?.loops).toContain('scout');
  });
});
