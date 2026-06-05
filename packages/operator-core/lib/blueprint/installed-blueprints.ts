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
import { join } from 'node:path';
import type { ResolveExtendsPath } from '@papercusp/orchestrator/blueprint';
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
