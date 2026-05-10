/**
 * Strict manifest validation. Refuses unknown fields, validates id +
 * semver shape, surfaces a precise field path on failure. The same
 * validator is used by the loader (load-time) and the `papercusp plugin
 * lint` CLI (build-time) so authors see errors before deploy.
 *
 * Schema is statically imported so it becomes part of the dependency
 * graph and is bundled by Next/Turbopack into the standalone build.
 * Previously this used a deferred `readFileSync` against `__dirname`-
 * relative paths, which silently failed in standalone (the JSON file
 * wasn't traced as a dependency). Every plugin then load-failed with a
 * misleading "missing or invalid papercusp.json" — bug regressed twice
 * before this comment landed; please don't switch back without solving
 * the standalone-bundling story first.
 *
 * Edge-runtime safe: ESM JSON imports are inlined as JS literals at
 * build time and don't pull `node:*` modules at runtime.
 */

import Ajv, { type ErrorObject } from 'ajv';
import schemaJson from '../../plugin-sdk/papercusp-plugin.schema.json' with { type: 'json' };

function getSchema(): object {
  return schemaJson as object;
}

let _validator: ReturnType<Ajv['compile']> | null = null;
function getValidator() {
  if (_validator) return _validator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  _validator = ajv.compile(getSchema());
  return _validator;
}

export interface ManifestValidationIssue {
  path: string;
  message: string;
}

export interface ManifestValidationResult {
  ok: boolean;
  issues: ManifestValidationIssue[];
}

/**
 * Validates a parsed manifest against the JSON schema. Returns issues
 * with field paths so callers can render precise error messages.
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const validate = getValidator();
  const ok = validate(manifest);
  if (ok) return { ok: true, issues: [] };
  const issues: ManifestValidationIssue[] = (validate.errors ?? []).map((e: ErrorObject) => {
    const path = e.instancePath || '/';
    let message = e.message ?? 'invalid';
    if (e.keyword === 'additionalProperties' && e.params && 'additionalProperty' in e.params) {
      message = `unknown property "${(e.params as { additionalProperty: string }).additionalProperty}" — typo? (additionalProperties:false)`;
    }
    if (e.keyword === 'pattern' && path === '/name') {
      message = `plugin id must match ^(@scope/)?[a-z][a-z0-9_.-]{2,62}$ (got "${(manifest as { name?: unknown }).name}")`;
    }
    if (e.keyword === 'pattern' && path === '/version') {
      message = `version must be valid semver (got "${(manifest as { version?: unknown }).version}")`;
    }
    return { path, message };
  });
  return { ok: false, issues };
}

/**
 * Throws on invalid manifest with all issues concatenated. Used at load
 * time where partial loading is wrong.
 */
export function assertManifestValid(manifest: unknown, sourceLabel = 'manifest'): void {
  const r = validateManifest(manifest);
  if (r.ok) return;
  const lines = r.issues.map((i) => `  ${i.path} — ${i.message}`).join('\n');
  throw new Error(`${sourceLabel} is invalid:\n${lines}`);
}
