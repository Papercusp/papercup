/**
 * POST /api/agent-mcp/run-command
 *
 * Cross-process bridge for the Action Registry. Body:
 *   {
 *     id: string,
 *     args?: any,
 *     workspace?: string,        // defaults to active workspace
 *   }
 *
 * Routes by the def's `browser` requirement:
 *   - 'none' or 'optional' → run locally in this Node process
 *   - 'required' → forward to the leader tab via SSE bridge
 *
 * The endpoint returns the CommandResult JSON verbatim, including
 * structured errors. It never throws — callers (Oracle's MCP server,
 * ElevenLabs webhooks, Pi MCP) reason about `result.ok` and
 * `result.error.code`.
 */

import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { get, runCommand, runQuery } from '@/lib/commands/registry';
import { deliver as deliverToTab } from '@/lib/commands/session-registry';
import type { AgentId, CommandContext, CommandResult } from '@/lib/commands/types';
import { audit } from '@/lib/commands/audit';
import '@/lib/commands/audit-server';
import '@/lib/commands/defs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  id?: string;
  args?: unknown;
  workspace?: string;
  agent?: AgentId;
  /** When provided, the registry uses it as ctx.sessionId — server callers
   *  already know which tab to target. */
  sessionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse('invalid-args', 'request body must be JSON', false, 400);
  }
  if (!body.id || typeof body.id !== 'string') {
    return errorResponse('invalid-args', 'missing field: id', false, 400);
  }

  const def = get(body.id);
  if (!def) return errorResponse('unknown', `no such command: ${body.id}`, false, 404);

  const ctx: CommandContext = {
    agent: body.agent ?? 'operator',
    workspace: body.workspace ?? activeWorkspaceId(),
    sessionId: body.sessionId,
    requestId: randomUUID(),
  };

  // Browser-required commands need to round-trip to the leader tab.
  // The leader tab runs the handler under its own runCommand call, but
  // browser-side audit is a no-op (no PG access). Log here so the audit
  // trail isn't lost for cross-tab dispatch.
  if (def.kind === 'command' && def.browser === 'required') {
    const startedAt = Date.now();
    const result = await deliverToTab(ctx.workspace, { id: body.id, args: body.args });
    audit({
      id: body.id,
      agent: ctx.agent,
      workspace: ctx.workspace,
      sessionId: ctx.sessionId,
      requestId: ctx.requestId,
      args: body.args ?? {},
      status: result.ok ? 'ok' : 'err',
      errorCode: result.ok ? undefined : result.error.code,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(result);
  }

  // Otherwise run locally.
  const result: CommandResult =
    def.kind === 'command'
      ? await runCommand(body.id, body.args, ctx)
      : await runQuery(body.id, body.args, ctx);
  return Response.json(result);
}

function errorResponse(
  code: string,
  message: string,
  retryable: boolean,
  status: number,
): Response {
  return Response.json(
    { ok: false, error: { code, message, retryable } },
    { status },
  );
}
