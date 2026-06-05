/**
 * Shared resolve+validate helper for the `blueprint:*` authoring tools
 * (`harness-blueprint-orchestration-2026-06-03` P-007 / B1). Wraps the engine's
 * loader so the tools RETURN validation issues instead of throwing — an agent
 * authoring a blueprint wants the errors back, not an exception.
 */
import { parse as parseYaml } from 'yaml';
import {
  BlueprintSchema,
  validateBlueprint,
  resolveExtends,
  type Blueprint,
  type BlueprintValidation,
} from '@papercusp/orchestrator/blueprint';

export interface ResolveResult {
  ok: boolean;
  /** The resolved (extends-merged + schema-parsed) blueprint, when it parsed. */
  blueprint?: Blueprint;
  validation?: BlueprintValidation;
  /** A structural/parse error message, when resolution failed before validation. */
  parseError?: string;
}

/**
 * Parse a YAML or JSON source string into a raw blueprint object. `yaml.parse`
 * accepts JSON too (YAML ⊇ JSON), so one path handles both.
 */
export function parseBlueprintSource(source: string): Record<string, unknown> {
  const parsed = parseYaml(source);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('blueprint source is not a YAML/JSON mapping');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve `extends` + schema-parse + semantic-validate a raw blueprint, returning
 * issues rather than throwing. `ok` is true only when the schema parses AND
 * `validateBlueprint` reports no errors (warnings still allow ok).
 */
export function resolveAndValidate(raw: Record<string, unknown>): ResolveResult {
  let merged: Record<string, unknown>;
  try {
    merged = resolveExtends(raw);
  } catch (e) {
    return { ok: false, parseError: `extends resolution failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  let blueprint: Blueprint;
  try {
    blueprint = BlueprintSchema.parse(merged);
  } catch (e) {
    return { ok: false, parseError: `schema validation failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const validation = validateBlueprint(blueprint);
  return { ok: validation.ok, blueprint, validation };
}
