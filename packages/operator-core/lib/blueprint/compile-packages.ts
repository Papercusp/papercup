/**
 * Operator I/O for the existing composition boundary. Resolution reads the local
 * distribution stores; provisioning uses the existing recipe and memory writers.
 * Nothing here installs another identity, changes a session stack or grants tools.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  compileAgentSpecification,
  CompositionCompilerError,
  BlueprintSourceDocumentSchema,
  resolveBlueprintSource,
  snapshotPackageDirectory,
  validateAgentInputClosure,
  replayAgentSpecification,
  type LoadedBlueprint,
  type ResolveExtendsPath,
  type CompiledAgentSpecification,
  type CompositionCompilerInput,
  type ResolvedCapabilityProviderInput,
  type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';
import { resolveLocalRecipe } from '../cupboard/recipe-store';
import { resolveLocalRubric } from '../cupboard/rubric-store';
import { loadKnowledgePack } from '../knowledge-packs/load-packs';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';
import { resolvePotSlugsForHarnesses } from '../memory/hive-scope';
import type { KnowledgePackMemoryTarget } from '../knowledge-packs/seed';
import { APPLIES_TO_SHAPES, type AppliesTo } from '../knowledge-packs/pack-format';
import { declaredDomainsFor } from '../knowledge-packs/manage';
import {
  getPotCapabilityProviderBinding,
  parseCapabilityClassRef,
  type ProviderBindingRow,
} from '../capability-class-registry-store';

type PackageRequest = { kind: string; ref: string; version?: string };
export type BlueprintPackageResolver = (request: PackageRequest) => Promise<ResolvedPackageInput | null>;
export type CapabilityProviderResolver = (
  classRef: string,
  potSlug: string,
) => Promise<ProviderBindingRow | null>;

export function capabilityProviderInput(
  binding: ProviderBindingRow,
): ResolvedCapabilityProviderInput {
  return {
    kind: 'capability-provider',
    ref: binding.classRef,
    providerPackage: binding.providerPackage,
    providerVersion: binding.providerVersion,
    conformanceRunId: binding.conformanceRunId,
    registryRevision: binding.registryRevision,
    verbBindings: binding.verbBindings,
  };
}

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
  /** Preserve the authored source path and inheritance resolver for abstract identities. */
  sourcePath?: string;
  resolve?: ResolveExtendsPath;
  /** For a not-yet-registered target; existing harnesses resolve through the shared registry. */
  memoryTarget?: KnowledgePackMemoryTarget;
  /** Pin the selection, so replay never consults changing detection or hive settings. */
  knowledgeSelection?: { shapes?: readonly AppliesTo[]; domains?: readonly string[] };
  resolvePackage?: BlueprintPackageResolver;
  /** Exact target pot; inferred from the harness registry when omitted. */
  potSlug?: string;
  resolveCapabilityProvider?: CapabilityProviderResolver;
  /** Prompt, addressed-document and versioned policy inputs belong to this same boundary. */
  input?: Omit<CompositionCompilerInput, 'source' | 'blueprint' | 'loaded' | 'sourcePath'>;
}

export async function compileBlueprintWithPackages(
  loaded: LoadedBlueprint | Record<string, unknown>,
  options: CompileBlueprintPackagesOptions,
): Promise<CompiledAgentSpecification> {
  const isLoaded = 'blueprint' in loaded && 'validation' in loaded && 'layers' in loaded;
  const resolve = options.resolve ?? options.input?.resolve;
  const resolved = isLoaded ? loaded as LoadedBlueprint : resolveBlueprintSource(loaded, {
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    ...(resolve ? { resolve } : {}),
    ...(options.input?.lint ? { lint: options.input.lint } : {}),
  });
  if (!resolved.validation.ok) {
    throw new CompositionCompilerError('source-invalid',
      'package composition source has validation errors', options.sourcePath);
  }
  const blueprint = isLoaded ? (resolved as LoadedBlueprint).blueprint
    : BlueprintSourceDocumentSchema.parse((resolved as ReturnType<typeof resolveBlueprintSource>).merged);
  const requests: PackageRequest[] = [...(blueprint.bundles ?? [])];
  const knowledge = resolveSeedPackKey(blueprint).packId;
  if (knowledge && !requests.some((request) => request.kind === 'knowledge-pack' && request.ref === knowledge)) {
    requests.push({ kind: 'knowledge-pack', ref: knowledge });
  }
  const packages = await resolveBlueprintPackageInputs(requests, options.resolvePackage);
  const requiredClasses = new Set(blueprint.grants?.requires ?? []);
  const optionalClasses = (blueprint.grants?.optional ?? [])
    .filter((ref) => !requiredClasses.has(ref));
  const classRefs = [...requiredClasses, ...optionalClasses];
  let resolvedPotSlug = options.potSlug;
  if (!resolvedPotSlug && classRefs.length > 0) {
    const pots = await resolvePotSlugsForHarnesses(options.workspaceId, [options.harnessSlug]);
    resolvedPotSlug = pots[0] ?? options.harnessSlug;
  }
  const resolveCapabilityProvider: CapabilityProviderResolver =
    options.resolveCapabilityProvider ??
    (async (classRef, potSlug) => {
      const parsed = parseCapabilityClassRef(classRef);
      if (!parsed) return null;
      return getPotCapabilityProviderBinding(getOrgPg().sql, {
        workspaceId: options.workspaceId,
        potSlug,
        classId: parsed.id,
        classVersion: parsed.version,
      });
    });
  const capabilityProviders: ResolvedCapabilityProviderInput[] = [];
  if (resolvedPotSlug) {
    for (const classRef of classRefs) {
      const binding = await resolveCapabilityProvider(classRef, resolvedPotSlug);
      if (!binding) {
        if (requiredClasses.has(classRef)) {
          throw new CompositionCompilerError(
            'input-invalid',
            'required capability class has no active pot provider binding',
            classRef,
          );
        }
        continue;
      }
      capabilityProviders.push(capabilityProviderInput(binding));
    }
  }
  let memoryTarget = options.memoryTarget;
  if (!memoryTarget && packages.some((pin) => pin.packageKind === 'knowledge-pack')) {
    const pots = await resolvePotSlugsForHarnesses(options.workspaceId, [options.harnessSlug]);
    memoryTarget = pots[0] ? { kind: 'hive', slug: pots[0] } : { kind: 'harness', slug: options.harnessSlug };
  }
  const scope = { workspaceId: options.workspaceId, harnessSlug: options.harnessSlug,
    ...(memoryTarget ? { memoryTarget } : {}),
    ...(packages.some((pin) => pin.packageKind === 'knowledge-pack') ? {
      knowledgeSelection: {
        shapes: [...new Set(options.knowledgeSelection?.shapes ?? [])].sort(),
        domains: [...new Set(options.knowledgeSelection?.domains ?? (memoryTarget?.kind === 'hive'
          ? await declaredDomainsFor(options.workspaceId, memoryTarget.slug) : undefined) ?? [])].sort(),
      },
    } : {}),
  };
  return compileAgentSpecification({
    ...options.input,
    source: loaded,
    ...(isLoaded ? {} : { sourcePath: options.sourcePath, resolve }),
    inputClosure: [
      ...packages,
      ...capabilityProviders,
      ...(options.input?.inputClosure ?? []),
    ],
    settings: [
      ...(options.input?.settings ?? []),
      { ref: 'bundle-scope', revision: '1', value: scope },
    ],
  });
}

export interface BlueprintPackageScope {
  workspaceId: string;
  harnessSlug: string;
  memoryTarget?: KnowledgePackMemoryTarget;
  knowledgeSelection?: { shapes: AppliesTo[]; domains: string[] };
}

export interface BlueprintPackageProvisioners {
  recipe: (pin: ResolvedPackageInput, scope: BlueprintPackageScope) => Promise<void>;
  knowledge: (pin: ResolvedPackageInput, scope: BlueprintPackageScope) => Promise<void>;
}

/** Provision only explicit bundles, from verified snapshots, before a host applies the artifact. */
export async function provisionBlueprintPackages(
  artifact: CompiledAgentSpecification,
  provisioners: BlueprintPackageProvisioners,
): Promise<void> {
  const specification = replayAgentSpecification(artifact);
  const scopeInput = specification.inputs.find((entry) => entry.kind === 'setting' && entry.ref === 'bundle-scope');
  const scope = scopeInput?.kind === 'setting' ? scopeInput.value as Partial<BlueprintPackageScope> : null;
  if (typeof scope?.workspaceId !== 'string' || !scope.workspaceId.trim() ||
      typeof scope.harnessSlug !== 'string' || !scope.harnessSlug.trim()) {
    throw new CompositionCompilerError('setting-invalid', 'bundle provisioning needs an explicit workspace and harness');
  }
  const target: BlueprintPackageScope = { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
    ...(scope.memoryTarget ? { memoryTarget: scope.memoryTarget } : {}),
    ...(scope.knowledgeSelection ? { knowledgeSelection: scope.knowledgeSelection } : {}) };
  const bundles = specification.configuration.bundles ?? [];
  const packages = validateAgentInputClosure(specification.inputs).filter((entry): entry is ResolvedPackageInput => entry.kind === 'package');
  const byKey = new Map(packages.map((pin) => [pin.packageKind + ':' + pin.ref, pin]));
  const included = new Set<string>();
  const include = (key: string): void => {
    if (included.has(key)) return;
    included.add(key);
    for (const dependency of byKey.get(key)?.dependencies ?? []) include(dependency.packageKind + ':' + dependency.ref);
  };
  for (const bundle of bundles) include(bundle.kind + ':' + bundle.ref);
  const seedPack = resolveSeedPackKey(specification.configuration).packId;
  if (seedPack) {
    const key = 'knowledge-pack:' + seedPack;
    if (!byKey.has(key)) throw new CompositionCompilerError('package-missing', 'declared seed pack has no resolved content', key);
    include(key);
  }
  const pins = packages.filter((pin) => included.has(pin.packageKind + ':' + pin.ref));
  // Fully validate before any side effect. Rubrics are attached as immutable input
  // values; interpreting their criteria does not require rewriting the rubric store.
  for (const pin of pins) {
    if ((pin.packageKind === 'recipe' || pin.packageKind === 'knowledge-pack') && (!pin.value || typeof pin.value !== 'object')) {
      throw new CompositionCompilerError('input-invalid', 'bundle lacks its parsed content', pin.ref);
    }
    if (pin.packageKind === 'knowledge-pack' &&
        (!target.memoryTarget || !['hive', 'harness'].includes(target.memoryTarget.kind) ||
          typeof target.memoryTarget.slug !== 'string' || !target.memoryTarget.slug.trim())) {
      throw new CompositionCompilerError('setting-invalid', 'knowledge provisioning needs its resolved memory target', pin.ref);
    }
    if (pin.packageKind === 'knowledge-pack' &&
        (!target.knowledgeSelection || !Array.isArray(target.knowledgeSelection.shapes) ||
          !target.knowledgeSelection.shapes.every((shape) => APPLIES_TO_SHAPES.includes(shape)) ||
          !Array.isArray(target.knowledgeSelection.domains) ||
          !target.knowledgeSelection.domains.every((domain) => typeof domain === 'string'))) {
      throw new CompositionCompilerError('setting-invalid', 'knowledge provisioning needs its pinned shape/domain selection', pin.ref);
    }
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
        toolsUsed: value.toolsUsed, tags: value.tags, potSlug: null,
        authorRole: 'blueprint-bundle', createdBy: 'blueprint-package:' + pin.contentHash,
        createOnly: true,
      });
    },
    async knowledge(pin, scope) {
      const { classifyPackInstall, applyPackInstall } = await import('../knowledge-packs/manage');
      const pack = pin.value as import('../knowledge-packs/pack-format').KnowledgePack;
      const review = await classifyPackInstall({ potSlug: scope.harnessSlug, pack,
        memoryTarget: scope.memoryTarget, ...scope.knowledgeSelection, requireExactContent: true });
      if (review.conflicts > 0) throw new CompositionCompilerError('package-pin-conflict', 'knowledge pack conflicts with scoped memory; explicit review is required', pin.ref);
      const result = await applyPackInstall({
        ...scope, potSlug: scope.harnessSlug, pack, review, memoryTarget: scope.memoryTarget,
        createdBy: 'blueprint-package:' + pin.contentHash,
      });
      if (!result.ok || result.failed) throw new CompositionCompilerError('package-read-failed', result.error ?? 'knowledge seed failed', pin.ref);
    },
  };
}
