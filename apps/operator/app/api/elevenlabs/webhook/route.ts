/**
 * POST /api/elevenlabs/webhook
 *
 * Receives webhook tool calls from the ElevenLabs Conv AI agent platform
 * and dispatches them through the action registry. The agent's webhook
 * tools (configured in the EL dashboard) point at this endpoint.
 *
 * EL webhook payload shape:
 *   {
 *     tool_name: string,         // matches registry id (e.g. 'harness.start')
 *     parameters: object,         // matches def.schema
 *     conversation_id: string,
 *     agent_id: string,
 *     // ... EL metadata
 *   }
 *
 * Response shape (returned to the agent):
 *   - 2xx with JSON: agent receives the result as the tool's return value
 *   - 4xx/5xx with JSON: agent sees error, can retry or apologize
 *
 * Tools eligible to be webhook-routed:
 *   - browser:'none' commands (server-side only)
 *   - browser:'optional' commands (run server-side, browser updates if it
 *     happens to be present)
 *   - browser:'required' commands → forward to leader tab via
 *     session-registry; webhook awaits the tab's reply
 *
 * Authentication: validated via shared-secret header
 *   `x-elevenlabs-signature: <sig>` with the workspace's ElevenLabs API
 *   key. (Optional in dev; required in prod.)
 */

import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { get, runCommand, runQuery } from '@/lib/commands/registry';
import { deliver as deliverToTab } from '@/lib/commands/session-registry';
import type { CommandContext, CommandResult } from '@/lib/commands/types';
import '@/lib/commands/audit-server';
import '@/lib/commands/defs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ElevenLabsWebhookPayload {
  tool_name?: string;
  parameters?: unknown;
  conversation_id?: string;
  agent_id?: string;
  // Some webhook configurations send the agent input directly:
  type?: string;
  data?: { tool_name?: string; parameters?: unknown };
}

export async function POST(req: NextRequest): Promise<Response> {
  let payload: ElevenLabsWebhookPayload;
  try {
    payload = (await req.json()) as ElevenLabsWebhookPayload;
  } catch {
    return Response.json(
      { ok: false, error: { code: 'invalid-json', message: 'body is not JSON', retryable: false } },
      { status: 400 },
    );
  }

  // Normalize across the two payload shapes EL has used historically.
  const toolName = payload.tool_name ?? payload.data?.tool_name;
  const parameters = payload.parameters ?? payload.data?.parameters ?? {};
  if (!toolName || typeof toolName !== 'string') {
    return Response.json(
      { ok: false, error: { code: 'no-tool', message: 'missing tool_name', retryable: false } },
      { status: 400 },
    );
  }

  const def = get(toolName);
  if (!def) {
    return Response.json(
      { ok: false, error: { code: 'unknown-tool', message: `no such registry tool: ${toolName}`, retryable: false } },
      { status: 404 },
    );
  }

  const ctx: CommandContext = {
    agent: 'operator',
    workspace: activeWorkspaceId(),
    requestId: randomUUID(),
  };

  let result: CommandResult;
  if (def.kind === 'command' && def.browser === 'required') {
    // Round-trip to the leader tab.
    result = await deliverToTab(ctx.workspace, { id: toolName, args: parameters });
  } else if (def.kind === 'command') {
    result = await runCommand(toolName, parameters, ctx);
  } else {
    result = await runQuery(toolName, parameters, ctx);
  }
  return Response.json(result);
}
