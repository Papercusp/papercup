/** Claude ignores an MCP tool whose root contains the generic batch union.
 * Advertise the keyed operation that the same tools/call endpoint already accepts.
 * Keep the definitions used by local references in the operation's properties.
 *
 * An operation that is itself a union of object shapes (work_items:complete and
 * work_items:set_state: one shape per way of naming the items) still has a union at
 * its root once the batch form is taken off, and Claude drops the tool for it
 * ("its input schema uses top-level anyOf, which the Anthropic API does not accept").
 * Such an operation is advertised as ONE object carrying every shape's properties,
 * requiring only what every shape requires. The endpoint still validates a call
 * against the real union, so the advertised object only has to let the call be made.
 */
export function acpKeyedToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = schema.$defs as Record<string, unknown> | undefined;
  const operation = defs?.operation;
  if (!Array.isArray(schema.anyOf) || !operation || typeof operation !== 'object' || Array.isArray(operation)) return schema;
  const keyed = operation as Record<string, unknown>;
  const ownDefs = keyed.$defs as Record<string, unknown> | undefined;
  if (keyed.type === 'object') return { ...keyed, $defs: { ...defs, ...ownDefs } };
  const merged = Array.isArray(keyed.anyOf) ? mergedObjectShapes(keyed.anyOf) : null;
  if (!merged) return schema;
  return { ...merged, $defs: { ...defs, ...ownDefs } };
}

/** One object schema standing for a union of object shapes, or null when a branch is
 * not a plain object shape (the caller then leaves the schema as it was). A property
 * two shapes both declare keeps the first shape's schema. */
function mergedObjectShapes(branches: readonly unknown[]): Record<string, unknown> | null {
  if (branches.length === 0) return null;
  const properties: Record<string, unknown> = {};
  let required: string[] | null = null;
  for (const branch of branches) {
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return null;
    const shape = branch as Record<string, unknown>;
    const own = shape.properties ?? {};
    if (shape.type !== 'object' || typeof own !== 'object' || own === null || Array.isArray(own)) return null;
    for (const [key, value] of Object.entries(own as Record<string, unknown>)) {
      if (!(key in properties)) properties[key] = value;
    }
    const needs = Array.isArray(shape.required) ? shape.required.filter((k): k is string => typeof k === 'string') : [];
    required = required === null ? needs : required.filter((key) => needs.includes(key));
  }
  return { type: 'object', properties, ...(required && required.length > 0 ? { required } : {}) };
}
