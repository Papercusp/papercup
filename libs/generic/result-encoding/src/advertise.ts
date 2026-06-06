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
  const cols = projectWriteColumns(argsJsonSchema, { freeTextName: getPrePromptEntry(toolName)?.freeTextArg });
  if (!cols) return argsJsonSchema;
  return positionalRowSchema(cols);
}
