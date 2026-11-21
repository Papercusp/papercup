/** Claude ignores an MCP tool whose root contains the generic batch union.
 * Advertise the keyed operation that the same tools/call endpoint already accepts.
 * Keep the definitions used by local references in the operation's properties.
 */
export function acpKeyedToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = schema.$defs as Record<string, unknown> | undefined;
  const operation = defs?.operation;
  if (!Array.isArray(schema.anyOf) || !operation || typeof operation !== 'object' || Array.isArray(operation)) return schema;
  const keyed = operation as Record<string, unknown>;
  if (keyed.type !== 'object') return schema;
  return { ...keyed, $defs: { ...defs, ...(keyed.$defs as Record<string, unknown> | undefined) } };
}
