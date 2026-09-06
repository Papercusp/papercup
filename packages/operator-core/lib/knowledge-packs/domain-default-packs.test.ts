/**
 * Pins the two GENERIC domain default knowledge packs + their blueprint wiring
 * (domain-generic-hive-architecture-2026-06-18 P-017, D-010).
 *
 * D-010: a coding hive seeds a GENERIC `coding` pack and a work hive a GENERIC
 * `work` pack — generic engineering / work wisdom, NOT project-specific (project
 * specifics ride the per-hive override + a separate project pack, never the
 * blueprint). This test fails HERE — not silently at hive creation — if a pack
 * develops a content typo, drifts off-domain, or the blueprint `knowledge.pack`
 * wiring breaks.
 *
 * The wiring assertions resolve through the EXACT path createHiveHarness uses
 * (operatorResolveExtends → resolveAndValidate), so a regression in the extends
 * deep-merge (e.g. `work` losing its `pack: work` override and inheriting
 * `coding`) is caught.
 */
import { describe, expect, it } from 'vitest';
import { validatePack, filterByShapes } from './pack-format';
import { loadKnowledgePack } from './load-packs';
import { resolveSeedPackKey } from './seed-pack-key';
import { operatorResolveExtends } from '../blueprint/installed-blueprints';
import { resolveAndValidate } from '../agent-tools/blueprint/_resolve';

describe('generic `coding` default pack (shipped content)', () => {
  it('loads cleanly from the builtin root and validates', async () => {
    const loaded = await loadKnowledgePack('coding');
    expect(loaded, 'builtin `coding` pack must resolve').toBeTruthy();
    expect(loaded!.source).toBe('builtin');
    expect(loaded!.warnings).toEqual([]);
    expect(validatePack(loaded!.pack)).toEqual([]);
  });

  it('is a substantial coding pack: 20–40 items, every project shape represented', async () => {
    const { pack } = (await loadKnowledgePack('coding'))!;
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
    const { pack } = (await loadKnowledgePack('coding'))!;
    const ids = new Set(pack.items.map((i) => i.id));
    for (const id of ['tests-ship-with-feature', 'migrations-not-runtime-ddl', 'use-existing-test-framework']) {
      expect(ids.has(id), `coding pack carries ${id}`).toBe(true);
    }
  });
});

describe('generic `work` default pack (shipped content)', () => {
  it('loads cleanly from the builtin root and validates', async () => {
    const loaded = await loadKnowledgePack('work');
    expect(loaded, 'builtin `work` pack must resolve').toBeTruthy();
    expect(loaded!.source).toBe('builtin');
    expect(loaded!.warnings).toEqual([]);
    expect(validatePack(loaded!.pack)).toEqual([]);
  });

  it('is a substantial, fully repo-less-seedable pack (every item is `any`)', async () => {
    const { pack } = (await loadKnowledgePack('work'))!;
    expect(pack.items.length).toBeGreaterThanOrEqual(20);
    // A work hive is repo-less ⇒ blueprint detection yields no shapes ⇒ only
    // `any`-tagged items seed (D-008/OQ-3). So EVERY work learning must be `any`,
    // or it would never reach a work hive. anyCore === full set proves it.
    const anyCore = filterByShapes(pack.items);
    expect(anyCore.length).toBe(pack.items.length);
  });

  it('carries work-domain learnings and drops coding-only ones (D-010)', async () => {
    const { pack } = (await loadKnowledgePack('work'))!;
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
    expect(v.blueprint!.knowledge?.pack).toBe('coding');
    expect(v.blueprint!.kind).toBe('pot');
  });

  it('the work hive (`generic-hive`) overrides to the generic `work` pack, keeping its scout loop', () => {
    const v = resolveAndValidate({ id: 'probe-generic-hive', extends: 'work' }, resolver);
    expect(v.ok, v.parseError ?? JSON.stringify(v.validation?.errors)).toBe(true);
    // `pack: work` must win over the inherited `pack: coding` (extends deep-merge
    // replaces the scalar) — the regression this test exists to catch.
    expect(v.blueprint!.knowledge?.pack).toBe('work');
    // The learning LOOPS are a DIFFERENT system from Knowledge Packs and keep the
    // `learning:` block — the rename moved only the seed pack out of it (P-001).
    expect(v.blueprint!.learning?.loops).toContain('scout');
  });

  it('keeps legacy-only `learning.pack` readable without allowing two seed-pack authorities', () => {
    // Blueprint YAML is a true boundary (knowledge-packs-2026-07-11 D-001): a
    // blueprint authored before the rename — or already installed in a user's
    // tree, which we never rewrite — still says `learning.pack`. It must still
    // PARSE (the schema keeps the key) and still SEED the author's pack.
    //
    // P-033 made `knowledge.pack` the single authority. A legacy override of a
    // base that already declares the canonical key now resolves to TWO sites and
    // must fail loudly instead of letting a downstream reader choose one.
    const ambiguous = resolveAndValidate(
      { id: 'probe-legacy-ambiguous', extends: 'coding', learning: { pack: 'my-pack' } },
      resolver,
    );
    expect(ambiguous.ok).toBe(false);
    expect(
      ambiguous.validation?.errors.some((issue) => issue.code === 'duplicate-knowledge-pack-authority'),
    ).toBe(true);

    // Read-side compatibility still applies when there is only ONE declaration.
    // `implement` supplies a complete runnable shape but no default seed pack,
    // so the resolved blueprint retains the legacy key without ambiguity.
    const v = resolveAndValidate(
      { id: 'probe-legacy-only', extends: 'implement', learning: { pack: 'my-pack' } },
      resolver,
    );
    expect(v.ok, v.parseError ?? JSON.stringify(v.validation?.errors)).toBe(true);
    expect(v.blueprint!.learning?.pack).toBe('my-pack'); // the deprecated key still parses
    expect(v.blueprint!.knowledge?.pack).toBeUndefined(); // no competing canonical declaration

    const seed = resolveSeedPackKey(v.blueprint!);
    expect(seed.packId).toBe('my-pack');
    expect(seed.deprecatedKey).toBe(true);
  });
});
