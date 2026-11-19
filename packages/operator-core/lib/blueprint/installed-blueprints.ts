/**
 * The operator's blueprint distribution tiers
 * (official-blueprints-cupboard-publish-2026-06-05 P-004/P-006, D-005).
 *
 * One place that names where Cupboard-installed blueprints live
 * (`~/.papercusp/blueprints/<id>/blueprint.yaml` — the same root the CLI's
 * `init --from` already resolves) and builds the composed
 * local → installed → built-in `extends` resolver for the operator's
 * authoring + create surfaces. Before this, the operator tools resolved
 * built-ins ONLY (`blueprint:extend` refused non-built-in parents) while the
 * distribution layer already supported all three tiers — the tool gating was
 * the artificial restriction, retired per D-005.
 */
import { dirname, join, resolve } from 'node:path';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  blueprintRetirement,
  builtinBlueprintPath,
  loadBlueprintFromFile,
  type ResolveExtendsPath,
} from '@papercusp/orchestrator/blueprint';
import {
  makeComposedResolveExtends,
  type BuiltinSupersession,
  type SupersessionInput,
} from '@papercusp/blueprint-distribution';
import { papercuspRoot } from '../papercusp-root';
import { physicalPath } from '../agent-tools/locks/external-path';

/** Cupboard-installed blueprints root — `~/.papercusp/blueprints`. */
export function INSTALLED_BLUEPRINTS_DIR(): string {
  return join(papercuspRoot(), 'blueprints');
}

/**
 * The operator's composed `extends` resolver: optional project-local dirs
 * (e.g. a target repo's `.papercusp/blueprints`) → installed
 * (`~/.papercusp/blueprints`) → built-in. Drop-in for the loader's `resolve`
 * arg and for "does blueprint id X exist?" probes.
 */
export function operatorResolveExtends(opts: { localDirs?: string[] } = {}): ResolveExtendsPath {
  return makeComposedResolveExtends({
    localDirs: opts.localDirs ?? [],
    installedDir: INSTALLED_BLUEPRINTS_DIR(),
  });
}

/** Ids under a `<root>/<id>/blueprint.yaml` layout (the tier convention). */
function listBlueprintIdsIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'blueprint.yaml')))
    .map((e) => e.name);
}

/**
 * The set of blueprint ids resolvable NOW without a Cupboard fetch — every
 * built-in plus every Cupboard-installed blueprint. Feeds the dep-validator's
 * `availableBlueprints` host set so a `dependencies.blueprints` entry (a hive
 * declaring it spawns `coding`/`research`) resolves as satisfied
 * (blueprint-role-bundling P-007). The built-in root is derived from
 * `builtinBlueprintPath` so enumeration never drifts from resolution.
 */
export function availableBlueprintIds(): Set<string> {
  return new Set(availableBlueprintSources().map((entry) => entry.id));
}

export interface BlueprintSourceLocation {
  id: string;
  tier: 'builtin' | 'installed' | 'local';
  file: string;
  /** Set on a built-in entry kept over an installed copy of the same id: the
   * resolver's `builtinSupersedesInstalled` verdict (WI-6554700010054458). */
  supersededInstalled?: { file: string; reason: BuiltinSupersession['reason']; detail: string };
}

/** Resolution's installed-vs-built-in policy; `null` keeps strict tier order. */
export type BlueprintSupersedesPolicy = ((input: SupersessionInput) => BuiltinSupersession | null) | null;

/** When an installed copy would override the current built-in entry, ask the
 * SAME policy the composed resolver applies, so inventory never advertises a
 * source that resolution skips. Local tiers are never superseded. */
function supersededByBuiltin(current: BlueprintSourceLocation | undefined, installedFile: string,
  policy: BlueprintSupersedesPolicy | undefined): BlueprintSourceLocation['supersededInstalled'] | null {
  // Only an installed copy that overlaps a built-in reaches the policy.
  if (current?.tier !== 'builtin') return null;
  // OPT-IN, like the resolver: omitted means strict tier order (WI-6554700010054458).
  const decide = policy ?? null;
  if (!decide) return null;
  const verdict = decide({ id: current.id, installedFile, builtinFile: current.file });
  return verdict ? { file: verdict.installedFile, reason: verdict.reason, detail: verdict.detail } : null;
}

/** Keep inventory and resolution on the same registered distribution tiers. */
function blueprintSourceRoots(opts: { localDirs?: string[] }) {
  return [
    { root: dirname(dirname(builtinBlueprintPath('probe'))), tier: 'builtin' as const },
    { root: INSTALLED_BLUEPRINTS_DIR(), tier: 'installed' as const },
    ...(opts.localDirs ?? []).slice().reverse().map((root) => ({ root, tier: 'local' as const })),
  ];
}

/** Registered source roots intersected by an ordinary file mutation. Include
 * ancestors (a recursive delete/rename) and absent local library subtrees. */
export function blueprintMutationRoots(paths: readonly string[], opts: { localDirs?: string[] } = {}): string[] {
  const absolute = paths.map(path => resolve(path));
  const candidates = blueprintSourceRoots(opts).map(({ root }) => root);
  for (const path of absolute) {
    const match = /^(.*\/\.papercusp\/blueprints)(?:\/|$)/.exec(path);
    if (match) candidates.push(match[1]!);
  }
  const physical = absolute.map(physicalPath);
  const intersects = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  return [...new Set(candidates.filter(root => {
    // Lexical matching also catches a library alias whose target is being replaced.
    if (absolute.some(path => intersects(path, resolve(root)))) return true;
    return physical.some(path => intersects(path, physicalPath(root)));
  }).map(root => resolve(root)))].sort();
}

/** The existing file catalog, with the same local → installed → built-in precedence as resolution. */
export function availableBlueprintSources(opts: {
  localDirs?: string[]; supersedes?: BlueprintSupersedesPolicy;
} = {}): BlueprintSourceLocation[] {
  const selected = new Map<string, BlueprintSourceLocation>();
  for (const { root, tier } of blueprintSourceRoots(opts)) {
    for (const id of listBlueprintIdsIn(root)) {
      const file = join(root, id, 'blueprint.yaml');
      const current = selected.get(id);
      const superseded = tier === 'installed' ? supersededByBuiltin(current, file, opts.supersedes) : null;
      selected.set(id, superseded ? { ...current!, supersededInstalled: superseded } : { id, tier, file });
    }
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * P-002 library source inventory, including sources hidden by a higher tier.
 * Hash actual bytes throughout each registered root, not mtime/size cache keys:
 * prompts, resource files, release metadata and currently empty directories can
 * all change the affected population. Invalid YAML stays a source to inspect;
 * unreadable data, links and special files refuse the entire read.
 *
 * This is an optimistic filesystem read, NOT an atomic snapshot, effect lease,
 * human-owner census or permission grant. The host must supply every affected
 * checkout's local roots and guard these roots against writes before using the
 * revision for admission. A matching expectedRevision does not acquire a lease.
 * pinForEffect explicitly refuses: the cooperative runtime mutex does not
 * exclude native edits, root replacement or unconfined filesystem writers.
 * Missing roots are represented explicitly, never proof of absent authority.
 */
export function readBlueprintSourcePopulation(opts: {
  localDirs?: string[]; expectedRevision?: string; pinForEffect?: boolean;
  supersedes?: BlueprintSupersedesPolicy;
} = {}) {
  if (opts.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(opts.expectedRevision))
    throw new Error('blueprint population requires an exact content revision');
  if (opts.pinForEffect === true) return { status: 'unavailable' as const,
    reason: 'blueprint source effect protection is unavailable' };
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scan = (path: string): { revision: string; declaration?: boolean;
    children?: Map<string, { revision: string; file: boolean; declaration?: boolean }> } => {
    const stat = lstatSync(path);
    if (stat.isFile()) return { revision: createHash('sha256').update(readFileSync(path)).digest('hex') };
    if (!stat.isDirectory()) throw new Error(`unsupported blueprint population source: ${path}`);
    const children = new Map<string, { revision: string; file: boolean; declaration?: boolean }>();
    for (const name of readdirSync(path).sort()) {
      const child = scan(join(path, name));
      children.set(name, { revision: child.revision, file: child.children === undefined,
        ...(child.declaration !== undefined ? { declaration: child.declaration } : {}) });
    }
    return { revision: digest([...children]), children,
      ...(children.has('blueprint.yaml') ? { declaration: children.get('blueprint.yaml')!.file } : {}) };
  };
  try {
    const roots: Array<{ root: string; canonicalRoot: string | null;
      tier: BlueprintSourceLocation['tier']; state: 'present' | 'absent'; revision: string }> = [];
    const sources: Array<BlueprintSourceLocation & { revision: string; selected: boolean }> = [];
    const seen = new Set<string>();
    for (const location of blueprintSourceRoots({ localDirs: opts.localDirs?.slice() })) {
      const root = resolve(location.root);
      const key = JSON.stringify([location.tier, root]);
      if (seen.has(key)) continue;
      seen.add(key);
      try { lstatSync(root); }
      catch (error) {
        // Only the initial root lookup can establish absence. Disappearance
        // after traversal starts must refuse the entire inventory.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' ||
            (error as NodeJS.ErrnoException).path !== root) throw error;
        roots.push({ root, tier: location.tier, state: 'absent', canonicalRoot: null, revision: digest(['absent']) });
        continue;
      }
      const state = scan(root);
      if (!state.children) throw new Error(`blueprint population root is not a directory: ${root}`);
      roots.push({ root, tier: location.tier, state: 'present', canonicalRoot: realpathSync(root), revision: state.revision });
      for (const [id, child] of state.children) {
        if (child.file || child.declaration === undefined) continue;
        const file = join(root, id, 'blueprint.yaml');
        if (!child.declaration) throw new Error(`blueprint declaration is not a regular file: ${file}`);
        sources.push({ id, tier: location.tier, file, revision: child.revision, selected: false });
      }
    }
    const selected = new Map<string, typeof sources[number]>();
    for (const source of sources) {
      // Same verdict as resolution: a built-in kept over an installed copy stays selected.
      const current = selected.get(source.id);
      const superseded = source.tier === 'installed'
        ? supersededByBuiltin(current, source.file, opts.supersedes) : null;
      if (superseded) current!.supersededInstalled = superseded;
      else selected.set(source.id, source);
    }
    for (const source of selected.values()) source.selected = true;
    const revision = digest({ roots, sources });
    return opts.expectedRevision !== undefined && opts.expectedRevision !== revision
      ? { status: 'stale' as const, revision }
      : { status: 'ok' as const, revision, roots, sources };
  } catch (error) {
    return { status: 'unavailable' as const, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The available blueprint ids whose declared `kind` is 'hive' — the installable hive
 * templates a `pot:create` picker offers + the set `pot:create` validates its
 * `blueprintId` against (hive-blueprint-generalization P-019). Reads each
 * resolved blueprint is `kind: hive|pot` and remains launchable. Resolution matters:
 * retirement is inherited, so a raw leaf scan would advertise descendants of a retired
 * parent (for example `work`, which inherits retirement from `coding`).
 */
export function availableHiveBlueprintIds(): string[] {
  const resolve = operatorResolveExtends();
  const out: string[] = [];
  for (const { id, file } of availableBlueprintSources()) {
    try {
      const { blueprint } = loadBlueprintFromFile(file, resolve);
      if (blueprint.kind === 'pot' && !blueprintRetirement(blueprint)) out.push(id);
    } catch {
      /* skip an unreadable, unparseable, or unresolvable blueprint */
    }
  }
  return out.sort();
}
