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
  return NextResponse.json({
    sessionId: result.sessionId,
    bearer: result.bearer,
    mcpServer: {
      command: './node_modules/.bin/tsx',
      args: [join(process.cwd(), 'packages/agent-mcp/src/server-entry.ts')],
      env: {
        AGENT_MCP_BEARER: result.bearer,
        OPERATOR_BASE_URL: 'http://localhost:3055',
        PAPERCUSP_HOME: root,
      },
    },
  });
}
