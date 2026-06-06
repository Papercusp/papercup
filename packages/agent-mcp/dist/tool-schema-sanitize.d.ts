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
 * unaffected.
 *
 * Deliberately scoped to `properties[*]` and `items` (the positions Ollama
 * types as an object). `additionalProperties` is left UNTOUCHED: Ollama's
 * struct has no such field (it's ignored), and OpenAI strict mode requires
 * the literal `additionalProperties: false`. Everything else is copied
 * byte-for-byte.
 */
/**
 * Recursively objectify boolean sub-schemas in `properties[*]` and `items`
 * positions. Returns a new value; the input is not mutated. Non-object
 * input (incl. a top-level boolean) is returned as-is.
 */
export declare function sanitizeToolSchema<T>(node: T): T;
