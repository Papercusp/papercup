/**
 * Strict manifest validation. Refuses unknown fields, validates id +
 * semver shape, surfaces a precise field path on failure. The same
 * validator is used by the loader (load-time) and the `papercusp plugin
 * lint` CLI (build-time) so authors see errors before deploy.
 *
 * Edge-runtime safety: Next.js bundles instrumentation.ts (and its
 * transitive imports) for both the nodejs and edge runtimes. Edge
 * forbids static `node:fs` / `node:path` / `node:url` imports even in
 * unreachable branches, so we defer those to first call via createRequire
 * (createRequire itself is `node:module`, which Next's edge runtime
 * tolerates as a partial polyfill). The validator is only ever invoked
 * from nodejs code.
 */

import Ajv, { type ErrorObject } from 'ajv';
import { createRequire } from 'node:module';

let _schema: unknown | null = null;
function getSchema(): object {
  if (_schema) return _schema as object;
  const req = createRequire(import.meta.url);
  const { readFileSync } = req('node:fs') as typeof import('node:fs');
  const { join, dirname } = req('node:path') as typeof import('node:path');
  const { fileURLToPath } = req('node:url') as typeof import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'plugin-sdk', 'papercusp-plugin.schema.json'),
    join(here, '..', '..', '..', 'plugin-sdk', 'papercusp-plugin.schema.json'),
  ];
  for (const p of candidates) {
    try {
      _schema = JSON.parse(readFileSync(p, 'utf8'));
      return _schema as object;
    } catch {
      // try next
    }
  }
  throw new Error('plugin-loader: papercusp-plugin.schema.json not found');
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
