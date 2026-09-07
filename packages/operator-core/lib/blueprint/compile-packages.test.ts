import { describe, expect, it, vi } from 'vitest';
import {
  pinPackageInput, resolveBlueprint, type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';
import {
  compileBlueprintWithPackages, provisionBlueprintPackages, resolveBlueprintPackageInputs,
} from './compile-packages';
vi.mock('../memory/hive-scope', () => ({ resolvePotSlugsForHarnesses: vi.fn(async () => ['parent-pot']) }));

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
      value: { workspaceId: 'workspace-a', harnessSlug: 'harness-a', memoryTarget: { kind: 'hive', slug: 'parent-pot' } } });
    expect(artifact.inputs.find((entry) => entry.kind === 'package' && entry.packageKind === 'rubric')).toHaveProperty('value.criteria');
    const recipe = vi.fn(async () => {});
    const knowledge = vi.fn(async () => {});
    await provisionBlueprintPackages(artifact, { recipe, knowledge });
    expect(recipe).toHaveBeenCalledWith(expect.objectContaining({ ref: 'job' }), expect.objectContaining({ workspaceId: 'workspace-a', harnessSlug: 'harness-a' }));
    expect(knowledge).toHaveBeenCalledWith(expect.objectContaining({ ref: 'facts' }), {
      workspaceId: 'workspace-a', harnessSlug: 'harness-a', memoryTarget: { kind: 'hive', slug: 'parent-pot' },
    });

    const corrupt = JSON.parse(JSON.stringify(artifact));
    corrupt.inputs.find((entry: { kind: string; ref: string }) => entry.kind === 'package' && entry.ref === 'job').value.script = 'corrupt';
    recipe.mockClear(); knowledge.mockClear();
    await expect(provisionBlueprintPackages(corrupt, { recipe, knowledge })).rejects.toThrow(/package-hash-mismatch/);
    expect(recipe).not.toHaveBeenCalled();
    expect(knowledge).not.toHaveBeenCalled();
  });
});
