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
import type { ToolDefinition, ToolDefinitionInput } from './types';
export declare function defineTool<TArgs extends ZodTypeAny>(input: ToolDefinitionInput<TArgs>): ToolDefinition<TArgs>;
