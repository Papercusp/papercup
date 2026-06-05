/**
 * Per-field share semantics for snapshot capture.
 *
 * Plugins flag each `configSchema` property with one of:
 *   - `secret: true`            credential, stripped by default
 *       + `snapshotPolicy: "strip" | "include" | "warn-and-prompt"`
 *       + optional `oauth: { provider, scopes }`
 *   - `shareable: false`        publisher-specific identifier, stripped
 *   - (neither)                 plain config, travels with the snapshot
 *
 * `extractShape(schema, config, opts)` returns the redacted config plus a
 * `.shape.json`-shaped record describing what was stripped and why. The
 * snapshot exporter writes the redacted config alongside the shape file
 * into the tarball; the fork-completion UI consumes the shape to drive
 * its prompts.
 *
 * Spec: /docs/snapshots/share-semantics
 */

export const REDACTION_MARKER = '[REDACTED]';

/* ─── Schema-side types (subset of JSON-Schema we care about) ─── */

export interface FieldSchema {
  type?: string;
  description?: string;
  default?: unknown;
  pattern?: string;
  enum?: unknown[];

  /** Credential — stripped from snapshots by default. */
  secret?: boolean;
  /** Override snapshot behavior for `secret: true` fields. */
  snapshotPolicy?: 'strip' | 'include' | 'warn-and-prompt';
  /** Environment-specific identifier; `false` means strip. */
  shareable?: boolean;
  /** OAuth descriptor — when present, fork UI offers a Connect button. */
  oauth?: { provider: string; scopes?: string[] };

  /** Schema-evolution: prior names, or `null` to mark removed-from-schema. */
  aliases?: (string | null)[];
}

export interface ConfigSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, FieldSchema>;
}

/* ─── Output: .shape.json contents ─── */

export type ShapeReason =
  | 'secret-strip'
  | 'secret-include'
  | 'secret-warn'
  | 'shareable-false'
  | 'pattern-fallback';

export interface ShapeField {
  /** Why the field was stripped (or warned-on but kept). */
  reason: ShapeReason;
  /** OAuth descriptor copied through verbatim if present, so fork UI can render Connect. */
  oauth?: { provider: string; scopes?: string[] };
  /** Pattern (if any) — fork UI uses this for client-side validation. */
  pattern?: string;
  /** Description copied through so fork UI can show the prompt label. */
  description?: string;
  /** True if `pattern-fallback` matched a flagged-shareable field (publisher override needed). */
  flaggedShareableButLooksSecret?: boolean;
}

export interface SnapshotShape {
  /**
   * Per-field stripping/inclusion decisions. Absent fields travelled
   * with the snapshot in plaintext.
   */
  fields: Record<string, ShapeField>;
  /**
   * Top-level warnings the publisher should see at publish time
   * (e.g. unflagged field matched secret pattern).
   */
  warnings: string[];
}

/* ─── Pattern-based fallback (defense-in-depth) ─── */

const SECRET_KEY_PATTERNS: RegExp[] = [
  /token/i,
  /secret/i,
  /api[_-]?key/i,
  /password/i,
  /(?:^|[^a-z])pat(?:[^a-z]|$)/i,
];

function looksSecret(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/* ─── extractShape ─── */

export interface ExtractShapeOptions {
  /**
   * Whether the publisher passed `--include-secrets` and confirmed each
   * `snapshotPolicy: "include"` field. If false, `include`-policy fields
   * are stripped anyway and a warning is emitted.
   *
   * Default: false (safe).
   */
  includeSecretsConfirmed?: boolean;
  /**
   * Resolver for `warn-and-prompt` fields. Called per-field; returns
   * true to include, false to strip. If undefined, treat as strip.
   */
  resolveWarnAndPrompt?: (key: string, schema: FieldSchema) => boolean;
}

export interface ExtractShapeResult {
  /** Config with stripped fields removed (NOT replaced with [REDACTED] — they're absent). */
  redactedConfig: Record<string, unknown>;
  /** Shape descriptor — what was stripped and why. Goes into `.shape.json`. */
  shape: SnapshotShape;
}

/**
 * Apply per-field share semantics + pattern-based fallback.
 *
 * Behavior for each top-level property in `config`:
 *
 * - schema flags `secret: true`:
 *   - `snapshotPolicy: "strip"` (default) → remove
 *   - `snapshotPolicy: "include"` + `includeSecretsConfirmed=true` → keep
 *   - `snapshotPolicy: "include"` + not confirmed → remove + warning
 *   - `snapshotPolicy: "warn-and-prompt"` → call `resolveWarnAndPrompt`
 *
 * - schema flags `shareable: false` → remove
 *
 * - no flags but key matches secret pattern → remove + warning ("unflagged-but-looks-secret")
 *
 * - schema flags `secret: false` AND key matches secret pattern → keep, but
 *   record `flaggedShareableButLooksSecret: true` so the publish CLI can
 *   prompt "you sure?".
 *
 * - schema flags `shareable: true` (or absent) and no pattern hit → travel verbatim.
 *
 * Fields present in config but absent from schema travel verbatim (plugin
 * authors who don't update their schema are accommodated; pattern fallback
 * still catches obvious credentials). Unknown extra keys are passed through.
 */
export function extractShape(
  schema: ConfigSchema | undefined | null,
  config: Record<string, unknown>,
  opts: ExtractShapeOptions = {},
): ExtractShapeResult {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  const fields: Record<string, ShapeField> = {};
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(config)) {
    const fieldSchema = props[key];
    const decision = decideField(key, fieldSchema, opts);

    if (decision.action === 'keep') {
      out[key] = value;
      if (decision.shape) fields[key] = decision.shape;
    } else {
      fields[key] = decision.shape!;
    }
    if (decision.warning) warnings.push(decision.warning);
  }

  return { redactedConfig: out, shape: { fields, warnings } };
}

interface FieldDecision {
  action: 'keep' | 'strip';
  shape?: ShapeField;
  warning?: string;
}

function decideField(
  key: string,
  schema: FieldSchema | undefined,
  opts: ExtractShapeOptions,
): FieldDecision {
  // Path 1: explicit secret flag.
  if (schema?.secret === true) {
    const policy = schema.snapshotPolicy ?? 'strip';
    if (policy === 'include') {
      if (opts.includeSecretsConfirmed) {
        // Keep — but still surface in shape so fork UI knows it carries a secret.
        return {
          action: 'keep',
          shape: { reason: 'secret-include', ...optionalOauth(schema), ...optionalDescription(schema) },
        };
      }
      return {
        action: 'strip',
        shape: { reason: 'secret-strip', ...optionalOauth(schema), ...optionalDescription(schema) },
        warning: `Field "${key}" has snapshotPolicy: "include" but --include-secrets was not confirmed; stripping.`,
      };
    }
    if (policy === 'warn-and-prompt') {
      const include = opts.resolveWarnAndPrompt?.(key, schema) ?? false;
      if (include) {
        return {
          action: 'keep',
          shape: { reason: 'secret-include', ...optionalOauth(schema), ...optionalDescription(schema) },
        };
      }
      return {
        action: 'strip',
        shape: { reason: 'secret-warn', ...optionalOauth(schema), ...optionalDescription(schema) },
      };
    }
    // policy === 'strip' (default)
    return {
      action: 'strip',
      shape: { reason: 'secret-strip', ...optionalOauth(schema), ...optionalDescription(schema) },
    };
  }

  // Path 2: explicit shareable: false.
  if (schema?.shareable === false) {
    return {
      action: 'strip',
      shape: {
        reason: 'shareable-false',
        ...optionalDescription(schema),
        ...(schema.pattern ? { pattern: schema.pattern } : {}),
      },
    };
  }

  // Path 3: pattern fallback for unflagged keys that look like credentials.
  if (looksSecret(key)) {
    if (schema?.shareable === true || schema?.secret === false) {
      // Plugin author explicitly said "this is fine to share" — keep but flag for publisher prompt.
      return {
        action: 'keep',
        shape: {
          reason: 'pattern-fallback',
          flaggedShareableButLooksSecret: true,
          ...optionalDescription(schema),
        },
        warning: `Field "${key}" is flagged shareable but matches a credential pattern. Publisher confirmation recommended.`,
      };
    }
    // Unflagged + looks secret → strip with warning.
    return {
      action: 'strip',
      shape: { reason: 'pattern-fallback', ...optionalDescription(schema) },
      warning: `Field "${key}" was not flagged but matches a credential pattern; stripping. Consider declaring secret/shareable explicitly.`,
    };
  }

  // Path 4: plain config — travels verbatim.
  return { action: 'keep' };
}

function optionalOauth(schema: FieldSchema): Pick<ShapeField, 'oauth'> {
  return schema.oauth ? { oauth: schema.oauth } : {};
}

function optionalDescription(schema: FieldSchema | undefined): Pick<ShapeField, 'description'> {
  return schema?.description ? { description: schema.description } : {};
}

/* ─── Schema evolution: alias resolution ─── */

export interface ResolveAliasesResult {
  /** Config with old keys remapped to current keys; removed keys dropped. */
  config: Record<string, unknown>;
  /** Per-key trace: 'renamed' | 'removed' | 'unchanged'. */
  trace: Record<string, 'renamed' | 'removed' | 'unchanged'>;
}

/**
 * Walk a forked snapshot's stored config and remap fields based on the
 * current schema's `aliases` declarations.
 *
 * For each property in the *current* schema with `aliases: ["old1", "old2"]`,
 * if the snapshot's config has `old1` or `old2` (and not the current name),
 * rename to the current name. For each property whose `aliases` includes
 * `null`, drop that property from the snapshot config (it was removed
 * from the schema in this version).
 *
 * Conflicts (both old and new name present) prefer the new name.
 */
export function resolveAliases(
  schema: ConfigSchema | undefined | null,
  config: Record<string, unknown>,
): ResolveAliasesResult {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = { ...config };
  const trace: Record<string, 'renamed' | 'removed' | 'unchanged'> = {};

  for (const [currentName, fieldSchema] of Object.entries(props)) {
    const aliases = fieldSchema.aliases ?? [];
    if (aliases.length === 0) continue;

    for (const alias of aliases) {
      if (alias === null) continue;
      if (alias in out && !(currentName in out)) {
        out[currentName] = out[alias];
        trace[alias] = 'renamed';
      }
      // Always drop the alias key — it's no longer part of the schema.
      if (alias in out) delete out[alias];
    }

    // `null` in aliases means the field was removed from the schema.
    // Drop the current-name key if it still appears in the config.
    if (aliases.includes(null) && currentName in out) {
      delete out[currentName];
      trace[currentName] = 'removed';
    }
  }

  return { config: out, trace };
}
