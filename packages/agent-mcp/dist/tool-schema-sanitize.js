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
    "description",
    "title",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
    "$comment",
]);
/** True for a sub-schema that accepts anything (no `type`, no structural or
 *  combinator keyword) — the object-form twins of the boolean schema `true`. */
function isUnconstrainedSchema(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
        return false;
    return Object.keys(v).every((k) => ANNOTATION_ONLY_KEYS.has(k));
}
/** Rewrite an unconstrained object schema to the same shape as
 *  `boolToSchema(true, position)`, preserving its annotations (the schema's
 *  own description wins over the generic placeholder). */
function unconstrainedToSchema(s, position) {
    if (position === "output") {
        return { description: "matches any value", ...s };
    }
    return {
        ...boolToSchema(true, position),
        ...s, // keep the original description/default/etc.
        type: "object",
        additionalProperties: true,
    };
}
function boolToSchema(b, position) {
    if (!b)
        return { not: {} };
    if (position === "output") {
        // EI-22064217935223876: outputSchema is never sent to a model as a
        // function-calling definition to generate against — it is read back by
        // the MCP CLIENT SDK to validate the tool's REAL return value
        // (Client.callTool → jsonSchemaValidator(tool.outputSchema)(structuredContent)).
        // The `type: 'object'` strengthening below exists ONLY to survive OMP's
        // outbound *request-building* collapse (it re-flattens an input tool
        // definition's permissive sub-schemas back to a bare boolean when building
        // the prompt it sends to the model) — a code path outputSchema never goes
        // through. Applying that same strengthening to `outputSchema.properties[*]`
        // makes the client-side validator require e.g. a STRING/NUMBER/ARRAY
        // return value (a z.unknown() result field such as tools:find's `query`/
        // `count`/`hits`) to literally be a JS object, which it correctly is not —
        // producing an MCP -32602 "must be objects" rejection of a perfectly valid
        // tool result. A plain annotated object still satisfies the ORIGINAL
        // Ollama constraint this file exists for (a JSON OBJECT at properties[*],
        // never a bare boolean, so Go's unmarshal into api.ToolProperty succeeds)
        // without constraining the value's real JSON type, so real non-object
        // return values validate correctly.
        return { description: "matches any value" };
    }
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
    // an acceptable trade for every current INPUT caller (all pass object payloads here)
    // against "the whole catalog 400s on every turn". This branch is INPUT-only (see the
    // `position === 'output'` branch above) precisely because that trade is NOT acceptable
    // for a result field whose real value is a string/number/array/boolean.
    return {
        type: "object",
        additionalProperties: true,
        description: "matches any object value",
    };
}
function jsonPointerSegment(value) {
    return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
function recursiveReferenceToSchema(position) {
    // OMP resolves ordinary `$ref` nodes while flattening `anyOf` for Ollama, but a self-reference
    // is the cycle boundary: it collapses that node to the boolean schema `true`. Ollama's Go
    // decoder rejects the boolean before runtime validation ever sees the request. Keep the outer
    // recursive grammar intact and replace only the cycle edge with a typed object; the tool's own
    // validator remains authoritative for deeper payloads. For `output`, see boolToSchema's
    // position==='output' branch: the same real-value-validation concern applies here too.
    if (position === "output") {
        return { description: "recursive value validated by the tool" };
    }
    return {
        type: "object",
        additionalProperties: true,
        description: "recursive object validated by the tool",
    };
}
function isActiveReference(value, activeDefinitionRefs) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const entries = Object.entries(value);
    return (entries.length === 1 &&
        entries[0]?.[0] === "$ref" &&
        activeDefinitionRefs.has(String(entries[0]?.[1])));
}
/**
 * Recursively objectify boolean sub-schemas in `properties[*]` and `items`
 * positions. Returns a new value; the input is not mutated. Non-object
 * input (incl. a top-level boolean) is returned as-is.
 */
function sanitizeToolSchemaNode(node, activeDefinitionRefs, position) {
    if (Array.isArray(node)) {
        return node.map((n) => sanitizeToolSchemaNode(n, activeDefinitionRefs, position));
    }
    if (!node || typeof node !== "object")
        return node;
    const src = node;
    const out = {};
    for (const [key, value] of Object.entries(src)) {
        if (key === "$defs" &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value)) {
            out[key] = Object.fromEntries(Object.entries(value).map(([definitionName, definition]) => {
                const ref = `#/$defs/${jsonPointerSegment(definitionName)}`;
                return [
                    definitionName,
                    sanitizeToolSchemaNode(definition, new Set([...activeDefinitionRefs, ref]), position),
                ];
            }));
        }
        else if (key === "properties" &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value)) {
            const props = {};
            for (const [propName, propSchema] of Object.entries(value)) {
                props[propName] =
                    typeof propSchema === "boolean"
                        ? boolToSchema(propSchema, position)
                        : isActiveReference(propSchema, activeDefinitionRefs)
                            ? recursiveReferenceToSchema(position)
                            : isUnconstrainedSchema(propSchema)
                                ? unconstrainedToSchema(propSchema, position)
                                : sanitizeToolSchemaNode(propSchema, activeDefinitionRefs, position);
            }
            out[key] = props;
        }
        else if (key === "items") {
            out[key] =
                typeof value === "boolean"
                    ? boolToSchema(value, position)
                    : isActiveReference(value, activeDefinitionRefs)
                        ? recursiveReferenceToSchema(position)
                        : isUnconstrainedSchema(value)
                            ? unconstrainedToSchema(value, position)
                            : sanitizeToolSchemaNode(value, activeDefinitionRefs, position);
        }
        else {
            // Recurse (so nested properties/items are reached) but do NOT
            // objectify booleans elsewhere — notably additionalProperties.
            out[key] = sanitizeToolSchemaNode(value, activeDefinitionRefs, position);
        }
    }
    return out;
}
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
export function sanitizeToolSchema(node, position = "input") {
    return sanitizeToolSchemaNode(node, new Set(), position);
}
