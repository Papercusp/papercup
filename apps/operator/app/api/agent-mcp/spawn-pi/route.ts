/**
 * POST /api/agent-mcp/spawn-pi
 *
 * Provisions a fresh pi:<session-id> principal and returns the bearer
 * the spawning UI should pass to the pi process. Called from the operator
 * when /pi opens an iframe-mode plugin or claude-bridge spawns an
 * external coding session.
 *
 * Request:  { sessionId?: string, capabilities?: string[] }
 * Response: { sessionId, bearer, mcpServer }
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { startPiSession } from '@papercusp/agent-mcp/provisioning';
import { papercuspRoot } from '@/lib/papercusp-root';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: string;
    capabilities?: string[];
  };
  const sessionId = body.sessionId ?? randomBytes(8).toString('hex');
  const workspaceId = activeWorkspaceId();
  const result = await startPiSession({
    workspaceId,
    sessionId,
    capabilities: body.capabilities ?? [],
  });

  const root = papercuspRoot();

  // Use HTTP MCP via mcp-remote bridge instead of the standalone stdio
  // server-entry. The standalone bootstrap only registers the 28
  // in-package tools (packages/agent-mcp/src/tools/) — it misses the
  // operator-side defineTool entries (agent_tools:list, ui:*, autoloop:*,
  // harness:plan_reviews, etc.) that live in apps/operator/lib/agent-tools/.
  //
  // Same migration applied to operator-chat/delegate-chat/oracle in
  // commit bca4f15f. Stdio fallback retained for environments where
  // superuser-token isn't provisioned (fresh installs, CI).
  let superuserToken: string | null = null;
  try {
    superuserToken = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
    if (!superuserToken || superuserToken.length < 16) superuserToken = null;
  } catch { /* missing token → stdio fallback */ }

  const mcpServer = superuserToken
    ? {
        command: 'npx',
        args: [
          '-y',
          'mcp-remote@latest',
          // workspace= required for state-channel scoping —
          // see operator/converse.ts audit4 comment.
          `http://127.0.0.1:3055/api/mcp?superuser=1&workspace=${encodeURIComponent(workspaceId)}`,
          '--header',
          `Authorization:Bearer ${superuserToken}`,
        ],
        env: { PAPERCUSP_HOME: root } as Record<string, string>,
      }
    : {
        command: './node_modules/.bin/tsx',
        args: [join(process.cwd(), 'packages/agent-mcp/src/server-entry.ts')],
        env: {
          AGENT_MCP_BEARER: result.bearer,
          OPERATOR_BASE_URL: 'http://localhost:3055',
          PAPERCUSP_HOME: root,
        } as Record<string, string>,
      };

  return NextResponse.json({
    sessionId: result.sessionId,
    bearer: result.bearer,
    mcpServer,
  });
}
