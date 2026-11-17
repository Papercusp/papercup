/**
 * Registry-aware input-schema advertising (token-efficient-agent-io P-008).
 *
 * The one place that decides what a tool's `tools/list` input schema LOOKS like
 * to the model. For a registry write-positional tool it becomes a single `row`
 * string (so the model emits a positional row, not keyed args); every other tool
 * advertises its real args schema unchanged. Consulted at advertise time (after
 * the registry is configured), so registration order doesn't matter.
 */

import { isWritePositional, getPrePromptEntry } from './registry';
import { projectWriteColumns, positionalRowSchema } from './positional';

function hasOnlyRowProperty(schema: Record<string, unknown> | undefined): boolean {
  const props = schema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
  return Object.keys(props as Record<string, unknown>).join(',') === 'row';
}

function alreadyAdvertisedPositional(schema: Record<string, unknown>): boolean {
  if (hasOnlyRowProperty(schema)) return true;
  return [schema.oneOf, schema.anyOf].some(branches => Array.isArray(branches) &&
    branches.some(member => hasOnlyRowProperty(member as Record<string, unknown> | undefined)));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Extend the framework envelope; positional advertising cannot replace it. */
function batchPositionalSchema(schema: Record<string, unknown>, row: Record<string, unknown>): Record<string, unknown> {
  const definitions = schema.$defs as Record<string, unknown>;
  let name = 'positionalOperation';
  while (Object.hasOwn(definitions, name)) name += '_';
  const literalKeys = new Set(['const', 'enum', 'default', 'example', 'examples']);
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    const object = asObject(value);
    if (!object || typeof object.$id === 'string') return value;
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key,
      literalKeys.has(key) ? child
        : key === '$ref' && child === '#/$defs/operation' ? '#/$defs/' + name : replace(child),
    ]));
  };
  const rewritten = replace(schema) as Record<string, unknown>;
  return { ...rewritten,
    $defs: { ...(rewritten.$defs as Record<string, unknown>),
      operation: definitions.operation,
      ...(definitions.legacy ? { legacy: definitions.legacy } : {}),
      [name]: { anyOf: [{ $ref: '#/$defs/operation' }, row] },
    },
    anyOf: [...rewritten.anyOf as unknown[], row],
  };
}

function positionalWriteAdvertisedSchema(
  rowSchema: Record<string, unknown>,
  argsJsonSchema: Record<string, unknown>,
  keyedFallback: boolean | undefined,
): Record<string, unknown> {
  if (!keyedFallback) return rowSchema;
  return {
    // WI-3290: the MCP spec requires `inputSchema.type === "object"` — a bare
    // top-level `oneOf` is rejected by strict clients (Claude Code, ptool),
    // and one bad tool made them drop the ENTIRE catalog (a session with zero
    // tools). Both members are object schemas, so constraining the top level
    // to `type: "object"` is semantically free.
    type: 'object',
    oneOf: [rowSchema, argsJsonSchema],
    description: 'Accepts either a compact positional `row` string or the full keyed args shape.',
  };
}

/**
 * Given a tool name and its real args JSON-Schema, return the schema to
 * advertise. Falls back to the original when the tool isn't write-positional or
 * doesn't actually fit the bounded positional shape.
 */
export function advertisedArgsSchema(
  toolName: string,
  argsJsonSchema: Record<string, unknown>,
): Record<string, unknown> {
  if (!isWritePositional(toolName)) return argsJsonSchema;
  if (alreadyAdvertisedPositional(argsJsonSchema)) return argsJsonSchema;
  const definitions = asObject(argsJsonSchema.$defs);
  const batch = definitions?.operation && Array.isArray(argsJsonSchema.anyOf) && argsJsonSchema.anyOf.some(branch => {
    const properties = asObject(asObject(branch)?.properties);
    return asObject(properties?._batch)?.const === 1 && properties?.items !== undefined;
  });
  const entry = getPrePromptEntry(toolName);
  const cols = projectWriteColumns(batch ? asObject(definitions!.operation) : argsJsonSchema, {
    freeTextName: entry?.freeTextArg,
    columnOverrides: entry?.columnOverrides,
    columnNames: entry?.writeColumnNames,
    requiredColumnNames: entry?.writeRequiredColumnNames,
  });
  if (!cols) return argsJsonSchema;
  if (batch) return batchPositionalSchema(argsJsonSchema, positionalRowSchema(cols));
  return positionalWriteAdvertisedSchema(positionalRowSchema(cols), argsJsonSchema, entry?.writeKeyedFallback);
}
