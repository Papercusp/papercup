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
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { withWorkspace } from '@restart/db-org';
import { resolveBearer } from './auth';
import { getCatalog, lookup } from './registry';
import type { Principal, ToolContext, ToolDefinition, ToolResponse } from './types';

export interface DispatchOptions {
  toolName: string;
  args: unknown;
  bearer: string;
}

export interface DispatchResult {
  ok: boolean;
  response?: ToolResponse;
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
  // Validate args via Zod.
  const parsed = tool.args.safeParse(opts.args);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'invalid_args', message: parsed.error.message },
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
      return await tool.handler(parsed.data, ctx);
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
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const bearer = process.env[bearerEnv] ?? '';
    const principal = bearer ? await resolveBearer(bearer) : null;
    const catalog = getCatalog();
    const tools = catalog
      .filter((t) => !principal || principal.capabilities.has(t.capability))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.args as unknown as Parameters<typeof zodToJsonSchema>[0], {
          target: 'jsonSchema7',
        }) as Record<string, unknown>,
      }));
    return { tools };
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
    const r = result.response!;
    return {
      content: [{ type: 'text', text: JSON.stringify(r) }],
    };
  });

  if (stdio) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

export type { Principal, ToolDefinition, ToolResponse };
