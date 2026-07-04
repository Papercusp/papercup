/**
 * Where Cupboard-installed templates live (app-templates-2026-07-04 P-010) —
 * `~/.papercusp/templates/<id>/` (template.yaml + GUIDE.md + blueprints/ +
 * contracts/ + checks/ + reference/), mirroring the installed-blueprints tier
 * (`~/.papercusp/blueprints`). The P-011 thin materializer (the scaffold
 * "from-template" entry) reads templates from here; the repo `templates/` dir
 * stays the v1 authoring source of truth (D-005) that listings project from.
 */
import { join } from 'node:path';
import { papercuspRoot } from '../papercusp-root';

/** Cupboard-installed templates root — `~/.papercusp/templates`. */
export function INSTALLED_TEMPLATES_DIR(): string {
  return join(papercuspRoot(), 'templates');
}
