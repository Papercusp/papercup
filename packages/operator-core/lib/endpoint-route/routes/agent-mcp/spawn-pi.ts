/**
 * POST /api/agent-mcp/spawn-pi — provision a pi:<session-id> principal.
 * Ported from app/api/agent-mcp/spawn-pi/route.ts. `auth: 'public'`.
 */
import { randomBytes } from 'node:crypto';
import { startPiSession } from '@papercusp/agent-mcp/provisioning';
import { papercuspRoot } from '../../../papercusp-root';
import { activeWorkspaceId } from '../../../workspace-registry';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/spawn-pi',
  auth: 'public',
  async handler(req) {
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

    return Response.json({
      sessionId: result.sessionId,
      bearer: result.bearer,
      mcpServer,
    });
  },
});
