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

import { z, type ZodTypeAny } from 'zod';
import { tierFor } from './capability-tiers';
import { register } from './registry';
import { registerProjectedTool, type ToolFn } from './tool-projection';
import { UnauthorizedToolError } from './dispatch-projected';
import type {
  RoleToolDefinition,
  RoleToolDefinitionInput,
  ToolContext,
  ToolDefinition,
  ToolDefinitionInput,
  ToolResponse,
} from './types';
import type { ToolResult } from '@papercusp/plugin-sdk';

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
  input: RoleToolDefinitionInput<TArgs>,
): RoleToolDefinition<TArgs>;
export function defineTool<TArgs extends ZodTypeAny>(
  input: ToolDefinitionInput<TArgs>,
): ToolDefinition<TArgs>;
export function defineTool<TArgs extends ZodTypeAny>(
  input: ToolDefinitionInput<TArgs> | RoleToolDefinitionInput<TArgs>,
): ToolDefinition<TArgs> | RoleToolDefinition<TArgs> {
  if ((input as RoleToolDefinitionInput<TArgs>).requirePrincipal === false) {
    return defineRoleGatedTool(input as RoleToolDefinitionInput<TArgs>);
  }
  return definePrincipalGatedTool(input as ToolDefinitionInput<TArgs>);
}

function definePrincipalGatedTool<TArgs extends ZodTypeAny>(
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
    guidance: input.guidance,
  };

  register(def);
  registerLegacyAsProjected(def);
  return def;
}

/**
 * Role-gated first-party tool — registers into the same projection
 * registry as principal-gated tools but skips the `principal+tx`
 * requirement in the wrapper. Gating happens via the dispatcher's
 * `roles` allowlist + `rolesQuota`, exactly as for plugin tools.
 *
 * The handler receives `UnifiedToolContext` directly (workspaceId,
 * harnessSlug, role, runId, etc.) — no `Principal`, no transaction.
 * If the tool needs PG, open its own connection from the workspace-
 * resolved pool; do not assume `tx` is set.
 */
function defineRoleGatedTool<TArgs extends ZodTypeAny>(
  input: RoleToolDefinitionInput<TArgs>,
): RoleToolDefinition<TArgs> {
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

  const def: RoleToolDefinition<TArgs> = {
    name,
    description,
    capability: input.capability,
    tier,
    requirePrincipal: false,
    roles: input.roles,
    rolesQuota: input.rolesQuota,
    timeoutSec: input.timeoutSec,
    idleTimeoutSec: input.idleTimeoutSec,
    replayBufferSize: input.replayBufferSize,
    modality: input.modality,
    args: input.args,
    events: input.events,
    state: input.state,
    handler: input.handler,
    guidance: input.guidance,
  };

  registerRoleGatedAsProjected(def);
  return def;
}

/**
 * Auto-register a legacy `defineTool` entry in the projected-tool
 * registry so it appears alongside plugin-contributed tools and gets
 * HTTP exposure for free.
 *
 * Conventions:
 *   - MCP name unchanged (e.g. `tasks:list`).
 *   - HTTP path: `/api/agent-tools/<group>/<verb>` (group/verb derived
 *     from the colon in the legacy name).
 *   - Single capability from legacy `tool.capability` becomes a
 *     one-element capabilities[] array.
 *   - JSON Schema derived from Zod schema via zodToJsonSchema.
 *   - Handler wrapped so the legacy (args, ToolContext) signature
 *     adapts to the unified (args, UnifiedToolContext) shape:
 *       · ctx.principal + ctx.tx must be populated (built-in tools
 *         don't work without them; the route attaches them via bearer
 *         auth + withWorkspace).
 *       · ToolResponse.data → ToolResult.content[text(JSON)].
 *       · ToolResponse.uiResources → trailing content items.
 */
/**
 * Flatten a JSON schema for OpenAI's function-calling validator.
 *
 * OpenAI Codex (strict mode) requires:
 *   1. `type: "object"` at root.
 *   2. NO `oneOf`/`anyOf`/`allOf`/`enum`/`not` at root.
 *
 * Zod's `discriminatedUnion` (and `z.union`) produces a top-level
 * `{oneOf: [...]}` or `{anyOf: [...]}` — both rejected.
 *
 * Fix: when we see root-level oneOf/anyOf with all-object variants,
 * merge each variant's `properties` into a single object schema.
 * The discriminator field (`mode`, `op`, etc.) stays required; every
 * variant-specific field becomes optional. Handler-level validation
 * (via def.args.safeParse) re-enforces the per-variant required fields
 * at runtime, so loosening the schema for OpenAI doesn't compromise
 * input safety.
 *
 * Schemas that already have `type: "object"` and no problematic
 * top-level keys pass through unchanged.
 */
function flattenForOpenAi(schema: Record<string, unknown>): Record<string, unknown> {
  // Already shaped right.
  const PROHIBITED_AT_ROOT = ['oneOf', 'anyOf', 'allOf', 'not'];
  const hasProhibited = PROHIBITED_AT_ROOT.some((k) => k in schema);
  if (schema.type === 'object' && !hasProhibited) return schema;

  // Pull the discriminator unions out of root.
  const variants: Array<Record<string, unknown>> = [];
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) {
      for (const v of schema[key] as Array<Record<string, unknown>>) {
        if (v && typeof v === 'object') variants.push(v);
      }
    }
  }

  if (variants.length === 0) {
    // No unions — just ensure type:"object" + strip problematic keys.
    const out = { ...schema };
    for (const k of PROHIBITED_AT_ROOT) delete out[k];
    if (out.type !== 'object') out.type = 'object';
    return out;
  }

  // Merge variant properties. Each property keeps its first definition;
  // a property required by EVERY variant stays required (typically the
  // discriminator); others become optional.
  const mergedProps: Record<string, unknown> = {};
  const requiredSets: Set<string>[] = [];
  for (const v of variants) {
    const props = (v.properties as Record<string, unknown>) ?? {};
    for (const [pk, pv] of Object.entries(props)) {
      if (!(pk in mergedProps)) mergedProps[pk] = pv;
    }
    const req = Array.isArray(v.required) ? new Set(v.required as string[]) : new Set<string>();
    requiredSets.push(req);
  }
  const required = [...requiredSets[0]].filter((p) =>
    requiredSets.every((s) => s.has(p)),
  );

  return {
    type: 'object',
    properties: mergedProps,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
    description: typeof schema.description === 'string' ? schema.description : undefined,
  };
}

function registerLegacyAsProjected<TArgs extends ZodTypeAny>(def: ToolDefinition<TArgs>): void {
  // tasks:list → /api/agent-tools/tasks/list
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  // Zod 4: use built-in z.toJSONSchema. zod-to-json-schema@3 returns just
  // `{ $schema }` for zod 4 schemas — produces empty input schemas.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSchema = (z as any).toJSONSchema(def.args) as Record<string, unknown>;
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);

  const projectedFn: ToolFn = async (input, ctx) => {
    if (!ctx.principal || !ctx.tx) {
      throw new UnauthorizedToolError(
        `built-in tool "${def.name}" requires authenticated request (bearer + workspace tx)`,
      );
    }
    const legacyCtx: ToolContext = {
      principal: ctx.principal as ToolContext['principal'],
      tx: ctx.tx,
      log: (level, msg, meta) => ctx.log(`[${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
    };
    const parsed = def.args.safeParse(input);
    if (!parsed.success) {
      throw new Error(`invalid_args: ${parsed.error.message}`);
    }
    const response: ToolResponse = await def.handler(parsed.data, legacyCtx);
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: JSON.stringify(response.data ?? response) },
    ];
    if (Array.isArray(response.uiResources)) {
      for (const ui of response.uiResources) {
        content.push(ui as unknown as Record<string, unknown>);
      }
    }
    return { content: content as never };
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    inputSchema,
    capabilities: [def.capability as never],
    expose: {
      mcp: { name: def.name },
      http: { path: httpPath, methods: ['POST'] },
    },
    fn: projectedFn,
    guidance: def.guidance as never,
  });
}

/**
 * Project a role-gated first-party tool into the registry. Unlike the
 * legacy wrapper, the handler is invoked WITHOUT requiring `principal`
 * or `tx` on the context — gating is the dispatcher's role + quota
 * check.
 *
 * The handler may return either a `ToolResult` (MCP shape) or a
 * `ToolResponse` envelope; this wrapper normalises to `ToolResult` so
 * both transports see the same content[] array.
 */
function registerRoleGatedAsProjected<TArgs extends ZodTypeAny>(
  def: RoleToolDefinition<TArgs>,
): void {
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSchema = (z as any).toJSONSchema(def.args) as Record<string, unknown>;
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);

  const projectedFn: ToolFn = async (input, ctx) => {
    const parsed = def.args.safeParse(input);
    if (!parsed.success) {
      throw new Error(`invalid_args: ${parsed.error.message}`);
    }
    const out = await def.handler(parsed.data, ctx);

    // Already a ToolResult? Pass through.
    if (out && typeof out === 'object' && Array.isArray((out as ToolResult).content)) {
      return out as ToolResult;
    }

    // Otherwise treat as ToolResponse envelope and adapt to MCP content[].
    const response = out as ToolResponse;
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: JSON.stringify(response.data ?? response) },
    ];
    if (Array.isArray(response.uiResources)) {
      for (const ui of response.uiResources) {
        content.push(ui as unknown as Record<string, unknown>);
      }
    }
    return { content: content as never };
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    inputSchema,
    capabilities: [def.capability as never],
    roles: def.roles,
    rolesQuota: def.rolesQuota,
    timeoutSec: def.timeoutSec,
    idleTimeoutSec: def.idleTimeoutSec,
    replayBufferSize: def.replayBufferSize,
    modality: def.modality,
    events: def.events,
    state: def.state,
    expose: {
      mcp: { name: def.name },
      http: { path: httpPath, methods: ['POST'] },
    },
    fn: projectedFn,
    guidance: def.guidance as never,
  });
}
