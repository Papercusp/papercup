/**
 * Operator I/O for the existing composition boundary. Resolution reads the local
 * distribution stores; provisioning uses the existing recipe and memory writers.
 * Nothing here installs another identity, changes a session stack or grants tools.
 */
import type { Sql } from 'postgres';
import {
  compileAgentSpecification,
  CompositionCompilerError,
  snapshotPackageDirectory,
  validateAgentInputClosure,
  replayAgentSpecification,
  type LoadedBlueprint,
  type CompiledAgentSpecification,
  type CompositionCompilerInput,
  type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';
import { resolveLocalRecipe } from '../cupboard/recipe-store';
import { resolveLocalRubric } from '../cupboard/rubric-store';
import { loadKnowledgePack } from '../knowledge-packs/load-packs';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';

type PackageRequest = { kind: string; ref: string; version?: string };
export type BlueprintPackageResolver = (request: PackageRequest) => Promise<ResolvedPackageInput | null>;

/** Use the existing resolution precedence and snapshot the directory actually selected. */
export const resolveLocalBlueprintPackage: BlueprintPackageResolver = async (request) => {
  if (request.kind === 'recipe') {
    const asset = resolveLocalRecipe(request.ref);
    if (!asset) return null;
    const { dir, layer: _layer, source: _source, ...value } = asset;
    return snapshotPackageDirectory({ packageKind: 'recipe', ref: request.ref, revision: asset.version, dir, value });
  }
  if (request.kind === 'rubric') {
    const asset = resolveLocalRubric(request.ref);
    if (!asset) return null;
    const { dir, layer: _layer, source: _source, ...value } = asset;
    return snapshotPackageDirectory({ packageKind: 'rubric', ref: request.ref, revision: asset.version, dir, value });
  }
  if (request.kind === 'knowledge-pack') {
    const asset = await loadKnowledgePack(request.ref);
    if (!asset) return null;
    if (!asset.directory || asset.warnings.length) {
      throw new CompositionCompilerError('package-read-failed', asset.warnings.join('; ') || 'resolved directory missing', request.ref);
    }
    return snapshotPackageDirectory({
      packageKind: 'knowledge-pack', ref: request.ref, revision: asset.pack.manifest.version,
      dir: asset.directory, value: asset.pack,
    });
  }
  throw new CompositionCompilerError('package-missing', 'no installed content resolver for package kind ' + request.kind, request.ref);
};

/** Resolve the exact transitive graph once per compile; conflicting demands never overwrite. */
export async function resolveBlueprintPackageInputs(
  requests: readonly PackageRequest[],
  resolvePackage: BlueprintPackageResolver = resolveLocalBlueprintPackage,
): Promise<ResolvedPackageInput[]> {
  const resolved = new Map<string, Promise<ResolvedPackageInput>>();
  const selected = new Map<string, ResolvedPackageInput>();
  const visit = async (request: PackageRequest, ancestors: readonly string[]): Promise<ResolvedPackageInput> => {
    const key = request.kind + ':' + request.ref;
    if (ancestors.includes(key)) throw new CompositionCompilerError('package-pin-conflict', 'cyclic package dependency: ' + [...ancestors, key].join(' -> '), key);
    let pending = resolved.get(key);
    if (!pending) {
      pending = (async () => {
        const pin = await resolvePackage(request);
        if (!pin) throw new CompositionCompilerError('package-missing', 'required package is not installed', key);
        if (pin.packageKind !== request.kind || pin.ref !== request.ref) {
          throw new CompositionCompilerError('package-pin-conflict', 'resolver returned a different package', key);
        }
        selected.set(key, pin);
        return pin;
      })();
      resolved.set(key, pending);
    }
    const pin = await pending;
    if (request.version && request.version !== pin.revision) {
      throw new CompositionCompilerError('package-pin-conflict', 'requires ' + request.version + ', selected ' + pin.revision, key);
    }
    await Promise.all(pin.dependencies.map((dependency) => visit({
      kind: dependency.packageKind, ref: dependency.ref, version: dependency.revision,
    }, [...ancestors, key])));
    return pin;
  };
  await Promise.all(requests.map((request) => visit(request, [])));
  const inputs = [...selected.values()].sort((a, b) => (a.packageKind + ':' + a.ref).localeCompare(b.packageKind + ':' + b.ref));
  validateAgentInputClosure(inputs);
  return inputs;
}

export interface CompileBlueprintPackagesOptions {
  workspaceId: string;
  harnessSlug: string;
  resolvePackage?: BlueprintPackageResolver;
  /** Prompt, addressed-document and versioned policy inputs belong to this same boundary. */
  input?: Omit<CompositionCompilerInput, 'source' | 'blueprint' | 'loaded' | 'sourcePath'>;
}

export async function compileBlueprintWithPackages(
  loaded: LoadedBlueprint,
  options: CompileBlueprintPackagesOptions,
): Promise<CompiledAgentSpecification> {
  const requests: PackageRequest[] = [...loaded.blueprint.bundles];
  const knowledge = resolveSeedPackKey(loaded.blueprint).packId;
  if (knowledge && !requests.some((request) => request.kind === 'knowledge-pack' && request.ref === knowledge)) {
    requests.push({ kind: 'knowledge-pack', ref: knowledge });
  }
  const packages = await resolveBlueprintPackageInputs(requests, options.resolvePackage);
  const scope = { workspaceId: options.workspaceId, harnessSlug: options.harnessSlug };
  return compileAgentSpecification({
    ...options.input,
    source: loaded,
    inputClosure: [...packages, ...(options.input?.inputClosure ?? [])],
    settings: [
      ...(options.input?.settings ?? []),
      { ref: 'bundle-scope', revision: '1', value: scope },
    ],
  });
}

export interface BlueprintPackageProvisioners {
  recipe: (pin: ResolvedPackageInput, scope: { workspaceId: string; harnessSlug: string }) => Promise<void>;
  knowledge: (pin: ResolvedPackageInput, scope: { workspaceId: string; harnessSlug: string }) => Promise<void>;
}

/** Provision only explicit bundles, from verified snapshots, before a host applies the artifact. */
export async function provisionBlueprintPackages(
  artifact: CompiledAgentSpecification,
  provisioners: BlueprintPackageProvisioners,
): Promise<void> {
  const specification = replayAgentSpecification(artifact);
  const scopeInput = specification.inputs.find((entry) => entry.kind === 'setting' && entry.ref === 'bundle-scope');
  const scope = scopeInput?.kind === 'setting' ? scopeInput.value as { workspaceId?: string; harnessSlug?: string } : null;
  if (typeof scope?.workspaceId !== 'string' || !scope.workspaceId.trim() ||
      typeof scope.harnessSlug !== 'string' || !scope.harnessSlug.trim()) {
    throw new CompositionCompilerError('setting-invalid', 'bundle provisioning needs an explicit workspace and harness');
  }
  const target = { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug };
  const bundles = specification.configuration.bundles;
  const pins = validateAgentInputClosure(specification.inputs).filter((entry): entry is ResolvedPackageInput =>
    entry.kind === 'package' && bundles.some((bundle) => bundle.kind === entry.packageKind && bundle.ref === entry.ref));
  // Fully validate before any side effect. Rubrics are attached as immutable input
  // values; interpreting their criteria does not require rewriting the rubric store.
  for (const pin of pins) {
    if (!pin.value || typeof pin.value !== 'object') throw new CompositionCompilerError('input-invalid', 'bundle lacks its parsed content', pin.ref);
  }
  for (const pin of pins) {
    if (pin.packageKind === 'recipe') await provisioners.recipe(pin, target);
    else if (pin.packageKind === 'knowledge-pack') await provisioners.knowledge(pin, target);
  }
}

/** Existing stores, with no-clobber registration and the existing reviewed memory install. */
export function blueprintPackageProvisioners(sql: Sql): BlueprintPackageProvisioners {
  return {
    async recipe(pin, scope) {
      const { getRecipe, upsertRecipe } = await import('../code-recipes-store');
      const value = pin.value as { id: string; title: string; description: string; script: string; toolsUsed: string[]; tags: string[] };
      const current = await getRecipe(sql, value.id);
      if (current) {
        if (current.script !== value.script || current.bindingSchema !== null || current.capabilityManifest !== null) {
          throw new CompositionCompilerError('package-pin-conflict', 'registered recipe differs; explicit migration is required', pin.ref);
        }
        return;
      }
      await upsertRecipe(sql, {
        id: value.id, title: value.title, description: value.description, script: value.script,
        toolsUsed: value.toolsUsed, tags: value.tags, potSlug: scope.harnessSlug,
        authorRole: 'blueprint-bundle', createdBy: 'blueprint-package:' + pin.contentHash,
        createOnly: true,
      });
    },
    async knowledge(pin, scope) {
      const { classifyPackInstall, applyPackInstall } = await import('../knowledge-packs/manage');
      const pack = pin.value as import('../knowledge-packs/pack-format').KnowledgePack;
      const review = await classifyPackInstall({ potSlug: scope.harnessSlug, pack });
      if (review.conflicts > 0) throw new CompositionCompilerError('package-pin-conflict', 'knowledge pack conflicts with scoped memory; explicit review is required', pin.ref);
      const result = await applyPackInstall({
        ...scope, potSlug: scope.harnessSlug, pack, review, createdBy: 'blueprint-package:' + pin.contentHash,
      });
      if (!result.ok || result.failed) throw new CompositionCompilerError('package-read-failed', result.error ?? 'knowledge seed failed', pin.ref);
    },
  };
}
