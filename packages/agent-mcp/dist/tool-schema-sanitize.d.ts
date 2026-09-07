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
/** `inputSchema` (what a model must GENERATE args against) vs `outputSchema`
 *  (what the MCP client SDK VALIDATES the tool's real return value against —
 *  see `Client.callTool` in `@modelcontextprotocol/sdk`, which fetches
 *  `tool.outputSchema` from tools/list and runs a real JSON-Schema validator
 *  over `result.structuredContent`). The two need DIFFERENT "matches anything"
 *  encodings — see `boolToSchema` — so every objectifying helper takes this. */
export type SanitizePosition = "input" | "output";
/**
 * @param position `"input"` (default, unchanged behavior) objectifies
 *   unconstrained/boolean sub-schemas to `type: "object"` so they survive
 *   OMP's outbound request-building collapse (see `boolToSchema`) — correct
 *   for an `inputSchema`, which only describes what a MODEL must generate.
 *   `"output"` keeps them as a plain annotated object (never a bare boolean,
 *   so Ollama's Go unmarshal into `api.ToolProperty` still succeeds) WITHOUT
 *   constraining the JSON type, because an `outputSchema` is validated by the
 *   MCP client SDK against the tool's REAL return value
 *   (EI-22064217935223876) — forcing `type: "object"` there rejects any
 *   non-object return value a `z.unknown()`/`z.any()` result field legitimately
 *   carries (a string, number, array, or boolean).
 */
export declare function sanitizeToolSchema<T>(node: T, position?: SanitizePosition): T;
