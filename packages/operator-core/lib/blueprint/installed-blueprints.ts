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
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { builtinBlueprintPath, type ResolveExtendsPath } from '@papercusp/orchestrator/blueprint';
import { makeComposedResolveExtends } from '@papercusp/blueprint-distribution';
import { papercuspRoot } from '../papercusp-root';

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
  const builtinRoot = dirname(dirname(builtinBlueprintPath('probe')));
  return new Set([...listBlueprintIdsIn(builtinRoot), ...listBlueprintIdsIn(INSTALLED_BLUEPRINTS_DIR())]);
}

/**
 * The available blueprint ids whose declared `kind` is 'hive' — the installable hive
 * templates a `hive:create` picker offers + the set `hive:create` validates its
 * `blueprintId` against (hive-blueprint-generalization P-019). Reads each
 * blueprint.yaml's own `kind` header (default 'harness'); a hive blueprint declares
 * `kind: hive` (e.g. `hive`, `generic-hive`). Cheap raw-YAML read — no extends
 * resolution — since `kind` is always declared on the leaf, never inherited.
 */
export function availableHiveBlueprintIds(): string[] {
  const builtinRoot = dirname(dirname(builtinBlueprintPath('probe')));
  const out: string[] = [];
  for (const root of [builtinRoot, INSTALLED_BLUEPRINTS_DIR()]) {
    for (const id of listBlueprintIdsIn(root)) {
      try {
        const raw = parseYaml(readFileSync(join(root, id, 'blueprint.yaml'), 'utf8')) as { kind?: unknown } | null;
        if (raw && typeof raw === 'object' && raw.kind === 'hive') out.push(id);
      } catch {
        /* skip an unreadable/unparseable blueprint */
      }
    }
  }
  return [...new Set(out)].sort();
}
