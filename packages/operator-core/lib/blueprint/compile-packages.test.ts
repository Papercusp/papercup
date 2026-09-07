import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pinPackageInput, resolveBlueprint, type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';
import {
  compileBlueprintWithPackages, provisionBlueprintPackages, resolveBlueprintPackageInputs, resolveLocalBlueprintPackage,
} from './compile-packages';
vi.mock('../memory/hive-scope', () => ({ resolvePotSlugsForHarnesses: vi.fn(async () => ['parent-pot']) }));
vi.mock('../hive-settings-store', () => ({ getHiveSetting: vi.fn(async () => ({ value: ['research'] })) }));

const pin = (ref: string, packageKind: 'recipe' | 'rubric' | 'knowledge-pack' = 'recipe') => pinPackageInput({
  packageKind, ref, revision: '1.0.0', files: [{ path: 'manifest.json', bytes: ref }],
  value: { id: ref, script: 'return 1', criteria: [{ id: 'correct' }] },
});
const reference = ({ packageKind, ref, revision, contentHash }: ResolvedPackageInput) =>
  ({ packageKind, ref, revision, contentHash });
const blueprint = (bundles: { kind: string; ref: string; version?: string }[]) => resolveBlueprint({
  id: 'bundle-fixture', bundles,
  workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
  knobs: { aiBackend: { default: { engine: 'loop', model: 'fixture-model' } } },
});

describe('P-006 operator package adapter', () => {
  it('resolves a transitive diamond once and retains every exact content pin', async () => {
    const leaf = pin('leaf');
    const parent = pinPackageInput({ packageKind: 'rubric', ref: 'parent', revision: '1', files: [], dependencies: [reference(leaf)] });
    const resolver = vi.fn(async ({ ref }: { ref: string }) => ref === 'leaf' ? leaf : parent);
    const inputs = await resolveBlueprintPackageInputs([
      { kind: 'rubric', ref: 'parent' }, { kind: 'recipe', ref: 'leaf' },
    ], resolver);
    expect(inputs).toEqual([leaf, parent]);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('refuses cross-root cycles without waiting on another root promise', async () => {
    const a = pinPackageInput({ packageKind: 'recipe', ref: 'a', revision: '1', files: [],
      dependencies: [{ packageKind: 'recipe', ref: 'b', revision: '1', contentHash: 'b'.repeat(64) }] });
    const b = pinPackageInput({ packageKind: 'recipe', ref: 'b', revision: '1', files: [],
      dependencies: [{ packageKind: 'recipe', ref: 'a', revision: '1', contentHash: 'a'.repeat(64) }] });
    await expect(resolveBlueprintPackageInputs([{ kind: 'recipe', ref: 'a' }, { kind: 'recipe', ref: 'b' }],
      async ({ ref }) => ref === 'a' ? a : b)).rejects.toThrow(/cyclic package dependency/);
  });

  it('rejects a version mismatch, absent package and resolver substitution', async () => {
    await expect(resolveBlueprintPackageInputs([{ kind: 'recipe', ref: 'same', version: '2' }],
      async () => pin('same'))).rejects.toThrow(/requires 2, selected 1.0.0/);
    await expect(resolveBlueprintPackageInputs([{ kind: 'recipe', ref: 'absent' }],
      async () => null)).rejects.toThrow(/package-missing/);
    await expect(resolveBlueprintPackageInputs([{ kind: 'recipe', ref: 'wanted' }],
      async () => pin('different'))).rejects.toThrow(/different package/);
  });

  it('compiles scoped bundle assets and leaves engine defaults and mutable mode inputs distinct', async () => {
    const bundles = [{ kind: 'recipe', ref: 'job' }, { kind: 'knowledge-pack', ref: 'facts' }, { kind: 'rubric', ref: 'judge' }];
    const loaded = blueprint(bundles);
    const artifact = await compileBlueprintWithPackages(loaded, {
      workspaceId: 'workspace-a', harnessSlug: 'harness-a',
      resolvePackage: async ({ ref, kind }) => pin(ref, kind as 'recipe' | 'knowledge-pack' | 'rubric'),
      input: { mutableState: { ref: 'mode', revision: 6, value: { auto: false } } },
    });
    expect(artifact.configuration.knobs.aiBackend?.default?.engine).toBe('loop');
    expect(artifact.inputs).toContainEqual({ kind: 'setting', ref: 'mode', revision: '6', value: { auto: false } });
    expect(artifact.inputs).toContainEqual({ kind: 'setting', ref: 'bundle-scope', revision: '1',
      value: { workspaceId: 'workspace-a', harnessSlug: 'harness-a', memoryTarget: { kind: 'hive', slug: 'parent-pot' },
        knowledgeSelection: { shapes: [], domains: ['research'] } } });
    expect(artifact.inputs.find((entry) => entry.kind === 'package' && entry.packageKind === 'rubric')).toHaveProperty('value.criteria');
    const recipe = vi.fn(async () => {});
    const knowledge = vi.fn(async () => {});
    await provisionBlueprintPackages(artifact, { recipe, knowledge });
    expect(recipe).toHaveBeenCalledWith(expect.objectContaining({ ref: 'job' }), expect.objectContaining({ workspaceId: 'workspace-a', harnessSlug: 'harness-a' }));
    expect(knowledge).toHaveBeenCalledWith(expect.objectContaining({ ref: 'facts' }), {
      workspaceId: 'workspace-a', harnessSlug: 'harness-a', memoryTarget: { kind: 'hive', slug: 'parent-pot' },
      knowledgeSelection: { shapes: [], domains: ['research'] },
    });

    const corrupt = JSON.parse(JSON.stringify(artifact));
    corrupt.inputs.find((entry: { kind: string; ref: string }) => entry.kind === 'package' && entry.ref === 'job').value.script = 'corrupt';
    recipe.mockClear(); knowledge.mockClear();
    await expect(provisionBlueprintPackages(corrupt, { recipe, knowledge })).rejects.toThrow(/package-hash-mismatch/);
    expect(recipe).not.toHaveBeenCalled();
    expect(knowledge).not.toHaveBeenCalled();
  });

  it('pins and provisions the existing seed-pack declaration with explicit replayable selection', async () => {
    const loaded = resolveBlueprint({ id: 'seed-fixture', knowledge: { pack: 'facts' },
      workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } });
    const compile = (domains: string[]) => compileBlueprintWithPackages(loaded, { workspaceId: 'w', harnessSlug: 'h',
      memoryTarget: { kind: 'harness', slug: 'h' }, knowledgeSelection: { shapes: ['ui'], domains },
      resolvePackage: async () => pin('facts', 'knowledge-pack') });
    const artifact = await compile(['research']);
    const root = artifact.inputs.find((entry) => entry.kind === 'package' && entry.ref === 'seed-fixture');
    expect(root).toHaveProperty('dependencies', [expect.objectContaining({ packageKind: 'knowledge-pack', ref: 'facts' })]);
    const knowledge = vi.fn(async () => {});
    await provisionBlueprintPackages(artifact, { recipe: vi.fn(), knowledge });
    expect(knowledge).toHaveBeenCalledWith(expect.objectContaining({ ref: 'facts' }), expect.objectContaining({
      memoryTarget: { kind: 'harness', slug: 'h' }, knowledgeSelection: { shapes: ['ui'], domains: ['research'] },
    }));
    expect((await compile([])).specificationRevision).not.toBe(artifact.specificationRevision);
  });

  it('uses the default local stores and preserves precedence, exact files and version errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blueprint-local-packages-'));
    const put = (relative: string, bytes: string) => {
      const path = join(root, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, bytes);
    };
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    vi.stubEnv('PAPERCUSP_RECIPES_DIR', join(root, 'recipes'));
    vi.stubEnv('PAPERCUSP_RUBRICS_DIR', join(root, 'rubrics'));
    vi.stubEnv('PAPERCUSP_HARNESS_DIR', join(root, 'harness'));
    try {
      put('recipes/p006-recipe/recipe.json', JSON.stringify({ id: 'p006-recipe', title: 'Bundled', script: 'return 0' }));
      put('home/recipes/p006-recipe/recipe.json', JSON.stringify({ id: 'p006-recipe', title: 'Installed', script: 'return 1' }));
      put('home/recipes/p006-recipe/listing.json', JSON.stringify({ version: '2.0.0' }));
      put('rubrics/p006-rubric/rubric.json', JSON.stringify({ rubricId: 'p006-rubric', title: 'Rubric', version: '1.0.0',
        characteristic: 'correctness', ratingScale: ['fail', 'pass'],
        criteria: [{ key: 'correct', title: 'Correct', model: 'binary', method: 'check', driftMarkers: 'changed' }] }));
      put('harness/knowledge-packs/p006-facts/manifest.yaml', 'id: p006-facts\ntitle: Facts\ndescription: fixture\nversion: 1.0.0\n');
      put('harness/knowledge-packs/p006-facts/fact.md', '---\nid: fact\ntitle: Fact\n---\nPinned knowledge.\n');
      const requests = [{ kind: 'recipe', ref: 'p006-recipe', version: '2.0.0' },
        { kind: 'rubric', ref: 'p006-rubric' }, { kind: 'knowledge-pack', ref: 'p006-facts' }];
      const inputs = await resolveBlueprintPackageInputs(requests);
      const recipe = inputs.find((entry) => entry.packageKind === 'recipe')!;
      expect(recipe.value).toMatchObject({ title: 'Installed', script: 'return 1' });
      expect(inputs.find((entry) => entry.packageKind === 'rubric')?.value).toHaveProperty('criteria');
      const knowledge = inputs.find((entry) => entry.packageKind === 'knowledge-pack')!;
      expect(knowledge.files.map((file) => file.path)).toContain('fact.md');
      expect(knowledge.value).toHaveProperty('items.0.text', 'Pinned knowledge.');
      expect(inputs.every((entry) => entry.dependencies.length === 0)).toBe(true);
      put('home/recipes/p006-recipe/notes.md', 'content beyond the manifest');
      expect((await resolveLocalBlueprintPackage(requests[0]!))?.contentHash).not.toBe(recipe.contentHash);
      await expect(resolveBlueprintPackageInputs([{ ...requests[0]!, version: '3.0.0' }])).rejects.toThrow(/requires 3.0.0/);
      expect(await resolveLocalBlueprintPackage({ kind: 'recipe', ref: 'p006-absent' })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
