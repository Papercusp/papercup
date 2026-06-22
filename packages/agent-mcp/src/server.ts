/**
 * Agent MCP server.
 *
 * Wires the catalog (populated by importing `tools/**`) into an MCP
 * server. Each `tools/list` and `tools/call` request resolves the caller
 * to a Principal via the bearer token, checks the tool's capability
 * against the principal's grants, and runs the handler inside a
 * transaction with `app.workspace_id` set.
 *
 * Transports:
 *   - stdio (out-of-process pi sessions / external claude-code consumers)
 *   - in-process: import `dispatch()` directly (Operator/Oracle running
 *     in the same Node process call the same handlers without going
 *     over a wire — same contract, no transport overhead).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { withWorkspace } from '@papercusp/db-org';
import { advertisedArgsSchema } from '@papercusp/result-encoding';
import { resolveBearer } from './auth';
import { sanitizeToolSchema } from './tool-schema-sanitize';
import {
  getCatalog,
  lookup,
  lookupByMcpName,
  standardValidate,
  formatIssues,
  serializeToolResponse,
  formatOptsFromCtx,
} from '@papercusp/tooldef';
import { applyToolManifest } from './tool-manifest';
import {
  getResourceCatalog,
  matchResource,
} from '@papercusp/tooldef';
import { getPromptCatalog, lookupPrompt } from '@papercusp/tooldef';
import type {
  Principal,
  PromptContext,
  PromptResult,
  ResourceContents,
  ResourceContext,
  ResourceListEntry,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolResponse,
} from '@papercusp/tooldef';

export interface DispatchOptions {
  toolName: string;
  args: unknown;
  bearer: string;
}

export interface DispatchResult {
  ok: boolean;
  response?: ToolResponse | ToolResult;
  error?: { code: string; message: string };
}

/**
 * Run a tool by name with bearer-derived principal. The single entry
 * point used by both the MCP transport handler and in-process callers
 * (Operator/Oracle).
 */
export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
  const tool = lookup(opts.toolName);
  if (!tool) {
    return { ok: false, error: { code: 'unknown_tool', message: `No tool named "${opts.toolName}"` } };
  }
  const principal = await resolveBearer(opts.bearer);
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer token did not resolve to a principal' } };
  }
  if (!principal.capabilities.has(tool.capability)) {
    return {
      ok: false,
      error: {
        code: 'missing_capability',
        message: `Principal ${principal.slug} lacks capability "${tool.capability}" (tool: ${tool.name})`,
      },
    };
  }
  // Validate args via the tool's Standard Schema validator.
  const parsed = await standardValidate(tool.args, opts.args);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: 'invalid_args', message: formatIssues(parsed.issues) },
    };
  }

  try {
    const response = await withWorkspace(principal.workspaceId, async (tx) => {
      const ctx: ToolContext = {
        principal,
        tx,
        log: (level, msg, meta) => {
          // Minimal logger; replace with substrate logger in Phase E.
          // eslint-disable-next-line no-console
          console[level === 'info' ? 'log' : level](
            `[agent-mcp][${tool.name}][${principal.slug}] ${msg}`,
            meta ?? '',
          );
        },
      };
      return await tool.handler(parsed.value, ctx);
    });
    return { ok: true, response };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'handler_error',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Resource dispatch — symmetric to tool dispatch.
// ──────────────────────────────────────────────────────────────────────

export interface ListResourcesResult {
  ok: boolean;
  resources?: ResourceListEntry[];
  error?: { code: string; message: string };
}

export interface ReadResourceOptions {
  uri: string;
  bearer: string;
}

export interface ReadResourceResult {
  ok: boolean;
  contents?: ResourceContents;
  error?: { code: string; message: string };
}

/**
 * Enumerate every resource the bearer is allowed to see. Templated
 * resources expand via their `list` callback (one URI per harness, etc.);
 * concrete resources contribute one entry each.
 */
export async function listResources(bearer: string): Promise<ListResourcesResult> {
  const principal = await resolveBearer(bearer);
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
  }

  const visible = getResourceCatalog().filter((r) =>
    principal.capabilities.has(r.capability),
  );

  try {
    const collected = await withWorkspace(principal.workspaceId, async (tx) => {
      const out: ResourceListEntry[] = [];
      for (const def of visible) {
        const ctx: ResourceContext = {
          principal,
          tx,
          log: (level, msg, meta) => {
            // eslint-disable-next-line no-console
            console[level === 'info' ? 'log' : level](
              `[agent-mcp][resource:list][${def.name}] ${msg}`,
              meta ?? '',
            );
          },
        };
        if (def.list) {
          try {
            const expanded = await def.list(ctx);
            out.push(...expanded);
          } catch (err) {
            // A single resource's list() failing must not block the rest.
            // eslint-disable-next-line no-console
            console.warn(
              `[agent-mcp] resource list() failed for ${def.name}:`,
              err instanceof Error ? err.message : err,
            );
          }
        } else {
          out.push({
            uri: def.uri,
            name: def.name,
            description: def.description,
            mimeType: def.mimeType,
          });
        }
      }
      return out;
    });
    return { ok: true, resources: collected };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'list_error', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Read a single resource by URI. Matches the URI against registered
 * templates, capability-checks the bearer, then runs the resource's
 * `read` callback inside a workspace-bound transaction.
 */
export async function readResource(opts: ReadResourceOptions): Promise<ReadResourceResult> {
  const matched = matchResource(opts.uri);
  if (!matched) {
    return { ok: false, error: { code: 'unknown_resource', message: `No resource matches URI "${opts.uri}"` } };
  }
  const principal = await resolveBearer(opts.bearer);
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
  }
  if (!principal.capabilities.has(matched.def.capability)) {
    return {
      ok: false,
      error: {
        code: 'missing_capability',
        message: `Principal ${principal.slug} lacks capability "${matched.def.capability}" (resource: ${matched.def.name})`,
      },
    };
  }

  try {
    const contents = await withWorkspace(principal.workspaceId, async (tx) => {
      const ctx: ResourceContext = {
        principal,
        tx,
        log: (level, msg, meta) => {
          // eslint-disable-next-line no-console
          console[level === 'info' ? 'log' : level](
            `[agent-mcp][resource:read][${matched.def.name}][${principal.slug}] ${msg}`,
            meta ?? '',
          );
        },
      };
      return await matched.def.read(opts.uri, ctx);
    });
    return { ok: true, contents };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'read_error', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Prompt dispatch — symmetric to tool/resource dispatch.
// ──────────────────────────────────────────────────────────────────────

export interface ListPromptsResult {
  ok: boolean;
  prompts?: Array<{
    name: string;
    description: string;
    arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  }>;
  error?: { code: string; message: string };
}

export interface GetPromptOptions {
  name: string;
  args: Record<string, string>;
  bearer: string;
}

export interface GetPromptResult {
  ok: boolean;
  result?: PromptResult;
  error?: { code: string; message: string };
}

/** Enumerate prompts visible to the bearer. */
export async function listPrompts(bearer: string): Promise<ListPromptsResult> {
  const principal = await resolveBearer(bearer);
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
  }
  const visible = getPromptCatalog().filter(
    (p) => !p.capability || principal.capabilities.has(p.capability),
  );
  return {
    ok: true,
    prompts: visible.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  };
}

/** Render a prompt by name with the given args. */
export async function getPrompt(opts: GetPromptOptions): Promise<GetPromptResult> {
  const def = lookupPrompt(opts.name);
  if (!def) {
    return { ok: false, error: { code: 'unknown_prompt', message: `No prompt named "${opts.name}"` } };
  }
  const principal = await resolveBearer(opts.bearer);
  if (!principal) {
    return { ok: false, error: { code: 'invalid_bearer', message: 'Bearer did not resolve to a principal' } };
  }
  if (def.capability && !principal.capabilities.has(def.capability)) {
    return {
      ok: false,
      error: {
        code: 'missing_capability',
        message: `Principal ${principal.slug} lacks capability "${def.capability}" (prompt: ${def.name})`,
      },
    };
  }
  // Enforce required-arg presence.
  for (const argSpec of def.arguments ?? []) {
    if (argSpec.required && !(argSpec.name in opts.args)) {
      return {
        ok: false,
        error: {
          code: 'missing_argument',
          message: `Prompt "${def.name}" requires argument "${argSpec.name}"`,
        },
      };
    }
  }

  try {
    const result = await withWorkspace(principal.workspaceId, async (tx) => {
      const ctx: PromptContext = {
        principal,
        tx,
        log: (level, msg, meta) => {
          // eslint-disable-next-line no-console
          console[level === 'info' ? 'log' : level](
            `[agent-mcp][prompt:get][${def.name}][${principal.slug}] ${msg}`,
            meta ?? '',
          );
        },
      };
      return await def.render(opts.args, ctx);
    });
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'render_error', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export interface StartServerOptions {
  /** Use stdio transport. Default true. */
  stdio?: boolean;
  /** Bearer source for stdio transport — env var name. Default `AGENT_MCP_BEARER`. */
  bearerEnv?: string;
}

export async function startServer(opts: StartServerOptions = {}): Promise<void> {
  const stdio = opts.stdio ?? true;
  const bearerEnv = opts.bearerEnv ?? 'AGENT_MCP_BEARER';

  const server = new Server(
    { name: 'agent-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const bearer = process.env[bearerEnv] ?? '';
    const principal = bearer ? await resolveBearer(bearer) : null;
    const catalog = getCatalog();
    const tools = catalog
      .filter((t) => !principal || principal.capabilities.has(t.capability))
      .map((t) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const inputSchema = (z as any).toJSONSchema(t.args) as Record<string, unknown>;
        delete (inputSchema as Record<string, unknown>).$schema;
        // Registry write-positional tools advertise a single `row` string (P-008).
        const advertised = advertisedArgsSchema(t.name, inputSchema);
        // Objectify boolean sub-schemas (z.unknown() → `true`) so strict
        // consumers (Ollama) can parse the tool surface. See tool-schema-sanitize.ts.
        return { name: t.name, description: t.description, inputSchema: sanitizeToolSchema(advertised) };
      });
    // Pin to the tool manifest (if configured) for cache-stable parity with
    // the HTTP transport. No-op when no manifest is present. See tool-manifest.ts.
    return { tools: applyToolManifest(tools) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await dispatch({
      toolName: req.params.name,
      args: req.params.arguments ?? {},
      bearer,
    });
    if (!result.ok) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `${result.error?.code}: ${result.error?.message}` },
        ],
      };
    }
    // Format-aware serialization (token-efficient-tool-result-formats P-005) —
    // the same single serializer the HTTP path uses. stdio is an agent-facing
    // MCP transport, so it defaults to compact; a client can override per call
    // via `_meta.format`. The envelope (nextCursor/degraded) rides in `_meta`.
    const r = result.response!;
    if ('content' in r) return r;
    const meta = req.params._meta as { format?: string; structured?: boolean } | undefined;
    const serialized = serializeToolResponse(
      r,
      formatOptsFromCtx(
        { requestedFormat: meta?.format, requestedStructured: meta?.structured === true, transport: 'mcp' },
        lookupByMcpName(req.params.name)?.resultEligibility,
      ),
    );
    return {
      content: serialized.content,
      ...(Object.keys(serialized._meta).length > 0 ? { _meta: serialized._meta } : {}),
      ...(serialized.structuredContent !== undefined ? { structuredContent: serialized.structuredContent } : {}),
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await listResources(bearer);
    return { resources: result.ok ? (result.resources ?? []) : [] };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await readResource({ uri: req.params.uri, bearer });
    if (!result.ok) {
      throw new Error(`${result.error?.code}: ${result.error?.message}`);
    }
    return { contents: [result.contents!] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await listPrompts(bearer);
    return { prompts: result.ok ? (result.prompts ?? []) : [] };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const bearer = process.env[bearerEnv] ?? '';
    const result = await getPrompt({
      name: req.params.name,
      args: (req.params.arguments ?? {}) as Record<string, string>,
      bearer,
    });
    if (!result.ok) {
      throw new Error(`${result.error?.code}: ${result.error?.message}`);
    }
    return {
      description: result.result!.description,
      messages: result.result!.messages,
    };
  });

  if (stdio) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

export type { Principal, ToolDefinition, ToolResponse };
