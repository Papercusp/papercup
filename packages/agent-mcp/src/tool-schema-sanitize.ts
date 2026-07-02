/**
 * tool-schema-sanitize — make a tool `inputSchema` parseable by strict
 * tool-schema consumers.
 *
 * Why: `z.unknown()` / `z.any()` params serialize (under Zod 4's
 * `z.toJSONSchema`) to the JSON-Schema-2020-12 BOOLEAN schema `true`
 * ("accept any value") in `properties[*]` / `items` positions. Permissive
 * consumers (Claude, OpenAI) accept that, but Ollama's Go tool-schema
 * parser types each `properties[*]` value (and `items`) as an object
 * (`api.ToolProperty`) and 400s the WHOLE request on a bare boolean:
 *
 *   failed to unmarshal tool parameters: json: cannot unmarshal bool into
 *   Go struct field ToolFunctionParameters.properties of type api.ToolProperty
 *
 * One offending tool kills every prompt (the full catalog is sent each
 * turn). This rewrites those booleans to the SEMANTICALLY IDENTICAL object
 * form — `true` → `{}` (accept anything), `false` → `{ not: {} }` (accept
 * nothing) — so strict parsers accept them while permissive ones are
 * unaffected. It ALSO rewrites the OBJECT spellings of "accept anything"
 * (`{}` / annotation-only schemas) to the same typed form, because OMP's
 * outbound serialization collapses those BACK to bare `true` client-side
 * (see boolToSchema notes; live-verified 2026-07-02, P-031).
 *
 * Deliberately scoped to `properties[*]` and `items` (the positions Ollama
 * types as an object). `additionalProperties` is left UNTOUCHED: Ollama's
 * struct has no such field (it's ignored), and OpenAI strict mode requires
 * the literal `additionalProperties: false`. Everything else is copied
 * byte-for-byte.
 */

/** JSON-Schema keywords that ANNOTATE but do not CONSTRAIN. A sub-schema whose
 *  every key is in this set is semantically "matches anything" — exactly the
 *  shape OMP's outbound serialization collapses back to the bare boolean `true`
 *  (both collapse passes: literal `{}` and the type-less description-only form).
 *  Verified live 2026-07-02 (context-trimming-tiers P-031): the server emitted
 *  `detail: {}` for operator:voice_debug (z.unknown() under Zod 4 can serialize
 *  to `{}`, not only `true`), OMP's cache held it verbatim, and the request OMP
 *  built for Ollama carried `detail: true` → the Go parser 400-killed the turn. */
const ANNOTATION_ONLY_KEYS = new Set([
  'description',
  'title',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
]);

/** True for a sub-schema that accepts anything (no `type`, no structural or
 *  combinator keyword) — the object-form twins of the boolean schema `true`. */
function isUnconstrainedSchema(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.keys(v).every((k) => ANNOTATION_ONLY_KEYS.has(k));
}

/** Rewrite an unconstrained object schema to the same OMP-collapse-proof shape
 *  as `boolToSchema(true)`, preserving its annotations (description wins over
 *  the generic placeholder). */
function unconstrainedToSchema(s: Record<string, unknown>): Record<string, unknown> {
  return {
    ...boolToSchema(true),
    ...s, // keep the original description/default/etc.
    type: 'object',
    additionalProperties: true,
  };
}

function boolToSchema(b: boolean): Record<string, unknown> {
  // `{}` (the literal empty-object spelling of "matches anything") gets a NON-EMPTY
  // representation here. Root-caused 2026-06-30 (omp-ollama-tool-schema-investigation):
  // OMP (oh-my-pi)'s own outbound request serialization collapses any literally-empty
  // `{}` property/items schema BACK into the bare JSON-Schema boolean `true` when it
  // builds the request it sends to the model provider — independent of papercusp,
  // independent of which tool/field it came from. That re-introduces the exact
  // construct Ollama's tool-schema parser rejects (the whole reason this file exists),
  // even though `{}` itself is fully valid JSON Schema and is what THIS function used
  // to emit.
  //
  // A `description`-only object defeats the literal-`{}` case, but 2026-07-01 found a
  // SECOND OMP collapse: any `properties[*]` sub-schema that carries no `type` keyword
  // — description-only included — gets re-collapsed to bare `true` when OMP flattens a
  // tool whose args are a Zod discriminated union (multiple `anyOf` branches merged into
  // one object for Ollama, which the raw MCP request capture showed OMP doing client-side;
  // papercusp itself never flattens unions). Giving the "matches anything" schema a real
  // `type: 'object'` (the one JSON-Schema type every field in this catalog already uses
  // successfully against Ollama) survives BOTH collapses: it is never empty and it always
  // carries `type`. Narrows z.unknown()/z.any() from "any JSON value" to "any object" —
  // an acceptable trade for every current caller (all pass object payloads here) against
  // "the whole catalog 400s on every turn".
  return b ? { type: 'object', additionalProperties: true, description: 'matches any object value' } : { not: {} };
}

/**
 * Recursively objectify boolean sub-schemas in `properties[*]` and `items`
 * positions. Returns a new value; the input is not mutated. Non-object
 * input (incl. a top-level boolean) is returned as-is.
 */
export function sanitizeToolSchema<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map((n) => sanitizeToolSchema(n)) as unknown as T;
  }
  if (!node || typeof node !== 'object') return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] =
          typeof propSchema === 'boolean'
            ? boolToSchema(propSchema)
            : isUnconstrainedSchema(propSchema)
              ? unconstrainedToSchema(propSchema)
              : sanitizeToolSchema(propSchema);
      }
      out[key] = props;
    } else if (key === 'items') {
      out[key] =
        typeof value === 'boolean'
          ? boolToSchema(value)
          : isUnconstrainedSchema(value)
            ? unconstrainedToSchema(value)
            : sanitizeToolSchema(value);
    } else {
      // Recurse (so nested properties/items are reached) but do NOT
      // objectify booleans elsewhere — notably additionalProperties.
      out[key] = sanitizeToolSchema(value);
    }
  }
  return out as unknown as T;
}
