/**
 * Install a blueprint FROM the Cupboard
 * (official-blueprints-cupboard-publish-2026-06-05 P-004 / D-001 / D-004).
 *
 * A `kind=blueprint` listing is GitHub-repo-backed (the Cupboard is a
 * git-listing registry, not a tarball store): the listing points at a repo
 * whose `<listing_ref>/blueprint.yaml` (or root `blueprint.yaml` for a
 * single-blueprint repo) is the blueprint. Installing it = git-clone the repo,
 * locate the blueprint dir, VALIDATE it (schema + semantics via the composed
 * local→installed→built-in resolver, so `extends: base` resolves against the
 * bundled floor — D-004), run the import-time DEP-VALIDATION (tools against
 * the host catalog, plugins against installed+Cupboard — the E2a validator),
 * and place the whole dir (blueprint.yaml + any blueprint-local prompts/)
 * under `~/.papercusp/blueprints/<id>/` — the middle tier of the composed
 * `extends` resolution, where it now shadows the built-in of the same id.
 *
 * Abstract parents (e.g. `base` — no workItem/spine, never loaded standalone)
 * are installable too: they skip the full semantic validation (which requires
 * a runnable shape) and are placed as parent-only blueprints.
 *
 * The core is dependency-injected (clone / installed dir / host capability
 * sets) so it's unit-testable without real git, network, or the tool catalog.
 * The route (`cupboard-install-blueprint.ts`) wires the real impls.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BlueprintSourceDocumentSchema, blueprintPackageInputs, resolveBlueprintSource, type ResolveExtendsPath } from '@papercusp/orchestrator/blueprint';
import {
  resolveAndValidateBlueprint,
  validateBlueprintDependencies,
  type BlueprintDependencyValidation,
  type DependencyHostSets,
} from '@papercusp/blueprint-distribution';
import { blueprintRegistrySets } from '../blueprint/registry-sets';
import { registerHarnessOpProxies } from '../harness-ops/proxy';
import { resolveBlueprintPackageInputs, type BlueprintPackageResolver } from '../blueprint/compile-packages';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';

export interface InstallBlueprintCoreInput {
  /** The blueprint repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo blueprint discriminator — the subdir to look in first. */
  listingRef?: string;
}

export interface InstallBlueprintCoreResult {
  ok: true;
  /** The installed blueprint's id (from its blueprint.yaml). */
  id: string;
  version: string | null;
  description: string | null;
  /** True for an abstract parent-only blueprint (no workItem/spine — e.g. `base`). */
  abstract: boolean;
  source: string;
  installedTo: string;
  /** The blueprint's declared dependencies, verbatim (tool-distribution D-002:
   *  tools/packs/plugins; blueprint-role-bundling P-007: spawned-blueprint closure). */
  dependencies: { tools: string[]; packs: string[]; plugins: string[]; blueprints: string[] };
  /** Import-time validation, including complete source and bundled-content pins. */
  depCheck: BlueprintDependencyValidation | null;
}

export interface InstallBlueprintCoreDeps {
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** Absolute path of the installed-blueprints dir (`~/.papercusp/blueprints`). */
  installedBlueprintsDir: () => string;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
  /**
   * The composed `extends` resolver the validation runs under (real:
   * `operatorResolveExtends()` — installed + built-in tiers, so an installed
   * blueprint's `extends: base` resolves against the bundled floor).
   */
  resolveExtends: ResolveExtendsPath;
  /** Existing local bundle stores by default; injectable for an isolated installer. */
  resolvePackage?: BlueprintPackageResolver;
  /**
   * Host capability sets for the import-time dep-validation. Called only when
   * the blueprint declares dependencies; `cupboardReachable:false` downgrades
   * missing PLUGINS to a warning (mirrors harness:create — a transient
   * Cupboard outage must not false-fail an installable plugin). Missing TOOLS
   * always hard-fail (the catalog is in-process, authoritative).
   */
  resolveHostSets: () => Promise<DependencyHostSets & { cupboardReachable: boolean }>;
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;

// A blueprint id becomes a directory under ~/.papercusp/blueprints AND the
// `extends`-resolution key, so it must be a safe SINGLE-SEGMENT slug — never a
// path. It is UNTRUSTED (from the cloned repo's blueprint.yaml).
const SAFE_BLUEPRINT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export class InstallBlueprintError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'InstallBlueprintError';
  }
}

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new InstallBlueprintError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/** A within-repo subdir ref must be relative, charset-safe, and contain no `..`/empty segment. */
function isSafeListingRef(ref: string): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Find the blueprint dir within a freshly-cloned repo. Prefers the
 * `listingRef` subdir (a repo hosting several blueprints — the official
 * library's layout), else the repo root (single-blueprint repo).
 */
function locateBlueprintDir(cloneDir: string, listingRef: string | undefined): string {
  const candidates: string[] = [];
  if (listingRef && isSafeListingRef(listingRef)) {
    const sub = join(cloneDir, listingRef);
    assertInside(cloneDir, sub, `listing_ref "${listingRef}"`);
    candidates.push(sub);
  }
  candidates.push(cloneDir);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'blueprint.yaml'))) return dir;
  }
  throw new InstallBlueprintError(
    'no blueprint.yaml found in the blueprint repo (checked listing_ref subdir + root)',
    422,
  );
}

/** Recursively copy a blueprint dir into `target`, excluding any .git. */
async function copyBlueprintDir(src: string, target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(src, target, {
    recursive: true,
    filter: (s) => !s.split(/[/\\]/).includes('.git'),
  });
}

export async function installBlueprintFromCupboardCore(
  input: InstallBlueprintCoreInput,
  deps: InstallBlueprintCoreDeps,
): Promise<InstallBlueprintCoreResult> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new InstallBlueprintError(`invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`, 400);
  }

  const cloneDir = join(deps.tmpDir(), `cupboard-blueprint-${Date.now()}-${Math.floor(performance.now())}`);
  try {
    await deps.cloneRepo(url, cloneDir);
    const bpDir = locateBlueprintDir(cloneDir, input.listingRef);

    let raw: Record<string, unknown>;
    try {
      const parsed = parseYaml(await fs.readFile(join(bpDir, 'blueprint.yaml'), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a mapping');
      raw = parsed as Record<string, unknown>;
    } catch (e) {
      throw new InstallBlueprintError(
        `blueprint.yaml failed to parse: ${e instanceof Error ? e.message : String(e)}`,
        422,
      );
    }

    // The id is UNTRUSTED (from the cloned repo) and becomes a directory we
    // `rm -rf` + `cp` into, plus the resolution key — single-segment slug only.
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!SAFE_BLUEPRINT_ID_RE.test(id)) {
      throw new InstallBlueprintError(`unsafe blueprint id ${JSON.stringify(raw.id)} — must be a single-segment slug`, 400);
    }

    // Abstract parent-only blueprint (no workItem/spine — `base`): skip the
    // full semantic validation (it requires a runnable shape); it only ever
    // appears as an `extends` parent.
    const abstract = raw.workItem == null && raw.spine == null;
    let dependencies: { tools: string[]; packs: string[]; plugins: string[]; blueprints: string[] } = {
      tools: [],
      packs: [],
      plugins: [],
      blueprints: [],
    };
    if (!abstract) {
      // P-002: register a PROXY CoordOp per harness-provided op this blueprint
      // declares (`ops:` manifest), BEFORE the resolve+validate snapshots the op
      // registry — so an installed blueprint that ships its own harness ops
      // validates clean (the op name resolves) instead of failing `unknown-op`.
      // Ops are declared on the blueprint that ships them, so the raw manifest is
      // authoritative here. Default-inert when absent.
      const rawOps = (raw as { ops?: unknown }).ops;
      if (Array.isArray(rawOps)) registerHarnessOpProxies(rawOps as Parameters<typeof registerHarnessOpProxies>[0]);
      // P-001: validate the installed blueprint's ops/roles against THIS host's
      // live registries — a marketplace blueprint that names an op the host hasn't
      // registered fails the import with a clear `unknown-op` (422), not a runtime
      // throw after it lands in the installed tier.
      const res = resolveAndValidateBlueprint(raw, deps.resolveExtends, blueprintRegistrySets());
      if (res.parseError) {
        throw new InstallBlueprintError(`blueprint "${id}" failed to resolve: ${res.parseError}`, 422);
      }
      if (!res.ok) {
        const errs = (res.validation?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
        throw new InstallBlueprintError(`blueprint "${id}" is invalid: ${errs}`, 422);
      }
      const d = res.blueprint!.dependencies as
        | { tools?: string[]; packs?: string[]; plugins?: string[]; blueprints?: string[] }
        | undefined;
      dependencies = {
        tools: d?.tools ?? [],
        packs: d?.packs ?? [],
        plugins: d?.plugins ?? [],
        blueprints: d?.blueprints ?? [],
      };
    }

    // Source fragments use the same layer walk without inventing runnable fields.
    // Snapshot before copying: the returned existing depCheck pin record retains
    // every consumed parent, prompt file and bundle even after the clone is removed.
    let closure: NonNullable<Parameters<typeof validateBlueprintDependencies>[2]>;
    try {
      const source = resolveBlueprintSource(raw, { resolve: deps.resolveExtends, sourcePath: join(bpDir, 'blueprint.yaml') });
      if (!source.validation.ok) throw new Error(source.validation.errors.map((error) => error.message).join('; '));
      const resolved = BlueprintSourceDocumentSchema.parse(source.merged);
      const bundles = resolved.bundles ?? [];
      const requests: Array<{ kind: string; ref: string; version?: string }> = [...bundles];
      const knowledge = resolveSeedPackKey(resolved).packId;
      if (knowledge && !requests.some((request) => request.kind === 'knowledge-pack' && request.ref === knowledge)) {
        requests.push({ kind: 'knowledge-pack', ref: knowledge });
      }
      const packages = await resolveBlueprintPackageInputs(requests, deps.resolvePackage);
      closure = { bundles: requests, inputs: [...packages, ...blueprintPackageInputs(source, packages)] };
    } catch (error) {
      throw new InstallBlueprintError(`blueprint "${id}" package resolution failed: ${error instanceof Error ? error.message : String(error)}`, 422);
    }

    // Import-time dep-validation (E2a / D-001): fail upfront with an actionable
    // "needs tool/pack/plugin X", before the blueprint lands in the installed
    // tier. Tools with NO known provider hard-fail (installable-advisory tools
    // are excluded from `missing` by the provider-aware validator); packs/
    // plugins hard-fail only when the Cupboard was actually reachable.
    let depCheck: BlueprintDependencyValidation;
    if (
      dependencies.tools.length > 0 ||
      dependencies.packs.length > 0 ||
      dependencies.plugins.length > 0 ||
      dependencies.blueprints.length > 0
    ) {
      const host = await deps.resolveHostSets();
      depCheck = validateBlueprintDependencies(dependencies, host, closure);
      if (depCheck.missing.tools.length > 0) {
        throw new InstallBlueprintError(
          `blueprint "${id}" tool dependencies unmet: ${depCheck.missing.tools.join(', ')}`,
          422,
        );
      }
      // pack/plugin/blueprint deps hard-fail only when the Cupboard was actually
      // reachable — an installable dep the install path could still pull is not a
      // hard miss, and an offline run can't prove a unit unavailable.
      const missingUnits = [...depCheck.missing.packs, ...depCheck.missing.plugins, ...depCheck.missing.blueprints];
      if (host.cupboardReachable && missingUnits.length > 0) {
        throw new InstallBlueprintError(
          `blueprint "${id}" pack/plugin/blueprint dependencies unmet: ${missingUnits.join(', ')}`,
          422,
        );
      }
    } else {
      depCheck = validateBlueprintDependencies(dependencies, { availableTools: new Set(), installedPlugins: new Set() }, closure);
    }
    if (!depCheck.pins?.length) {
      throw new InstallBlueprintError(`blueprint "${id}" package pins invalid: ${depCheck.messages.join('; ')}`, 422);
    }

    const target = join(deps.installedBlueprintsDir(), id);
    assertInside(deps.installedBlueprintsDir(), target, `blueprint id "${id}"`);
    await fs.mkdir(deps.installedBlueprintsDir(), { recursive: true });
    await copyBlueprintDir(bpDir, target);

    return {
      ok: true,
      id,
      version: typeof raw.version === 'string' ? raw.version : null,
      description: typeof raw.description === 'string' ? raw.description : null,
      abstract,
      source: url,
      installedTo: target,
      dependencies,
      depCheck,
    };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
