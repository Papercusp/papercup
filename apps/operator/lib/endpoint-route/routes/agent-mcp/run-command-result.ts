/**
 * POST /api/agent-mcp/run-command/result — leader tab posts command result back.
 * Ported from app/api/agent-mcp/run-command/result/route.ts. `auth: 'public'`.
 */
import { resolveRequest } from '@/lib/commands/session-registry';
import type { CommandResult } from '@/lib/commands/types';
import { defineRoute } from '../../define-route';

interface Body {
  requestId?: string;
  result?: CommandResult;
}

export default defineRoute({
  method: 'POST',
  path: '/agent-mcp/run-command/result',
  auth: 'public',
  async handler(req) {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    if (!body.requestId || !body.result) {
      return new Response('missing requestId or result', { status: 400 });
    }
    const ok = resolveRequest(body.requestId, body.result);
    return Response.json({ ok });
  },
});
