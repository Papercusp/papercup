/**
 * Plugin-config redaction for snapshot capture.
 *
 * Snapshot manifests embed each enabled plugin's effective config as
 * `plugins[].configJson` so that an instantiate/fork can re-enable the
 * plugin with the same settings. The original capture path read the
 * config file verbatim, which leaked plaintext secrets — most plugin
 * config schemas declare sensitive fields like API tokens with the
 * uiSchema marker `{"ui:widget":"password"}` (intended for masked input
 * widgets), but that marker was being ignored at capture time.
 *
 * This helper parses `configJson`, walks the plugin manifest's
 * `uiSchema`, and replaces every value whose key carries `ui:widget:
 * "password"` with the constant `[REDACTED]`. The redaction count is
 * surfaced so the snapshot's redactions summary tells the operator
 * which plugin configs got scrubbed.
 *
 * Re-enable on instantiate: a `[REDACTED]` value is treated as "config
 * not present" by the install flow — the operator must re-enter the
 * secret on the new install, same as a fresh enable.
 *
 * NB: nested objects under password fields (rare) are redacted whole;
 * we don't recurse into them. uiSchema is flat in every reference plugin.
 */

export const REDACTION_MARKER = '[REDACTED]';

export interface RedactPluginConfigInput {
  /** The raw `<plugin>.json` config file contents from the harness. */
  configJson: string;
  /** Parsed `papercusp.json#uiSchema` (or undefined / null if absent). */
  uiSchema: unknown;
}

export interface RedactPluginConfigResult {
  /** Stringified config with password fields replaced by [REDACTED]. */
  configJson: string;
  /** Names of fields that were redacted. */
  redactedKeys: string[];
}

/**
 * Walk `uiSchema` to find every top-level key whose `ui:widget` is
 * `"password"`. Returns the key set; defensive against malformed input.
 */
function collectPasswordKeys(uiSchema: unknown): Set<string> {
  const out = new Set<string>();
  if (!uiSchema || typeof uiSchema !== 'object') return out;
  for (const [key, val] of Object.entries(uiSchema as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const widget = (val as { 'ui:widget'?: unknown })['ui:widget'];
    if (widget === 'password') out.add(key);
  }
  return out;
}

/**
 * Redact password fields from a plugin's captured config.
 *
 * - configJson that doesn't parse as a JSON object is left as-is (returned
 *   verbatim with redactedKeys=[]). Capture is best-effort; a corrupt
 *   config shouldn't kill the snapshot.
 * - If no password fields exist in the schema, returns input unchanged.
 * - Empty string config is normalized to `{}`.
 */
export function redactPluginConfig(input: RedactPluginConfigInput): RedactPluginConfigResult {
  const passwordKeys = collectPasswordKeys(input.uiSchema);
  if (passwordKeys.size === 0) {
    return { configJson: input.configJson || '{}', redactedKeys: [] };
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(input.configJson || '{}');
  } catch {
    return { configJson: input.configJson, redactedKeys: [] };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { configJson: input.configJson, redactedKeys: [] };
  }
  const obj = cfg as Record<string, unknown>;
  const redacted: string[] = [];
  for (const key of passwordKeys) {
    if (key in obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      obj[key] = REDACTION_MARKER;
      redacted.push(key);
    }
  }
  return {
    configJson: JSON.stringify(obj, null, 2),
    redactedKeys: redacted,
  };
}
