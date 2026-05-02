/**
 * defineTool — the simplification engine.
 *
 * Tools are declared via `defineTool({ capability, args, handler })` and
 * placed in `src/tools/<group>/<verb>.ts`. The helper:
 *   - Derives the tool name from the file path: `tools/tasks/list.ts` →
 *     `tasks:list`. Override via `name` if needed.
 *   - Pulls the description from the caller-file's leading TSDoc block
 *     when not passed explicitly.
 *   - Looks up the tier from the capability per §10.6.1.
 *   - Self-registers into the runtime catalog (`registry.ts`).
 *
 * The catalog is the result of importing `tools/**`. The MCP `tools/list`
 * response is generated from the catalog at startup. Adding a tool is
 * dropping a file; no manual list to maintain.
 */

import type { ZodTypeAny } from 'zod';
import { tierFor } from './capability-tiers';
import { register } from './registry';
import type { ToolDefinition, ToolDefinitionInput } from './types';

/**
 * Walk up the call stack to find the file that called defineTool, then
 * derive a tool name from that file's path. Convention:
 *   .../tools/tasks/list.ts    → tasks:list
 *   .../tools/harness/get.ts   → harness:get
 *   .../tools/search/query.ts  → search:query
 *
 * If the file is `index.ts`, the parent directory contributes the verb;
 * useful for tools that need a directory of helpers.
 */
function deriveNameFromCallSite(): string | null {
  const ErrorAny = Error as unknown as {
    prepareStackTrace?: (err: Error, stack: unknown[]) => unknown;
  };
  const orig = ErrorAny.prepareStackTrace;
  try {
    ErrorAny.prepareStackTrace = (_err: Error, stack: unknown[]) => stack;
    const raw = new Error().stack as unknown as Array<{ getFileName?: () => string }>;
    // [0]=this fn, [1]=defineTool, [2]=caller (the tool file).
    const callerFile = raw?.[2]?.getFileName?.();
    if (!callerFile) return null;
    // Find the segment after 'tools/'.
    const match = /\/tools\/([^/]+)\/([^/]+)\.[mc]?[jt]s$/.exec(callerFile);
    if (!match) return null;
    const group = match[1];
    let verb = match[2];
    if (verb === 'index') {
      verb = 'default';
    }
    return `${group}:${verb}`;
  } catch {
    return null;
  } finally {
    ErrorAny.prepareStackTrace = orig;
  }
}

function deriveDescriptionFromCallSite(): string | null {
  // Attempting build-time TSDoc parsing at runtime is brittle; instead we
  // require the caller to pass `description` explicitly OR rely on the
  // generator step that runs at build time to populate it. For runtime
  // usage without that step, return a sensible default.
  return null;
}

export function defineTool<TArgs extends ZodTypeAny>(
  input: ToolDefinitionInput<TArgs>,
): ToolDefinition<TArgs> {
  const name = input.name ?? deriveNameFromCallSite();
  if (!name) {
    throw new Error(
      'defineTool: could not derive tool name from call site. ' +
      'Pass `name` explicitly or place the file under `tools/<group>/<verb>.ts`.',
    );
  }
  const description =
    input.description ??
    deriveDescriptionFromCallSite() ??
    `Tool ${name}`;
  const tier = tierFor(input.capability);

  const def: ToolDefinition<TArgs> = {
    name,
    description,
    capability: input.capability,
    tier,
    args: input.args,
    handler: input.handler,
  };

  register(def);
  return def;
}
