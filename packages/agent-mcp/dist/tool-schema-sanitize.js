"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeToolSchema = sanitizeToolSchema;
function boolToSchema(b) {
    return b ? {} : { not: {} };
}
/**
 * Recursively objectify boolean sub-schemas in `properties[*]` and `items`
 * positions. Returns a new value; the input is not mutated. Non-object
 * input (incl. a top-level boolean) is returned as-is.
 */
function sanitizeToolSchema(node) {
    if (Array.isArray(node)) {
        return node.map((n) => sanitizeToolSchema(n));
    }
    if (!node || typeof node !== 'object')
        return node;
    const src = node;
    const out = {};
    for (const [key, value] of Object.entries(src)) {
        if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
            const props = {};
            for (const [propName, propSchema] of Object.entries(value)) {
                props[propName] =
                    typeof propSchema === 'boolean' ? boolToSchema(propSchema) : sanitizeToolSchema(propSchema);
            }
            out[key] = props;
        }
        else if (key === 'items') {
            out[key] = typeof value === 'boolean' ? boolToSchema(value) : sanitizeToolSchema(value);
        }
        else {
            // Recurse (so nested properties/items are reached) but do NOT
            // objectify booleans elsewhere — notably additionalProperties.
            out[key] = sanitizeToolSchema(value);
        }
    }
    return out;
}
