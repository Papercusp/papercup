/**
 * GET /api/agent-mcp/run-command/sse?workspace=<ws>&sessionId=<id>
 *
 * Server-Sent Events stream a leader browser tab subscribes to. While
 * the stream is open, the tab is registered as the leader for its
 * workspace. The server pushes command requests over the stream when
 * a cross-process caller (Oracle, EL webhook) needs the tab to run a
 * `browser: 'required'` command.
 *
 * Events:
 *   - hello       — initial handshake; tab knows it's registered
 *   - command     — { requestId, command: { id, args } }; tab runs it
 *                   via runCommand() and POSTs the result to
 *                   /api/agent-mcp/run-command/result
 *   - heartbeat   — emitted by @restart/sse on a 5s timer for keepalive;
 *                   tab pings back via PUT /api/agent-mcp/run-command/sse
 *
 * The tab's `voice-leader.ts` election decides whether to open this
 * stream. Followers (non-leader tabs) don't subscribe.
 */

import { NextRequest } from 'next/server';
import { sseResponse } from '@restart/sse';
import {
  registerSession,
  unregisterSession,
  heartbeatSession,
} from '@/lib/commands/session-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Events = {
  hello: { workspace: string; sessionId: string };
  command: { requestId: string; command: unknown };
};

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const workspace = url.searchParams.get('workspace');
  const sessionId = url.searchParams.get('sessionId');
  if (!workspace || !sessionId) {
    return new Response('missing workspace or sessionId', { status: 400 });
  }

  return sseResponse<Events>({
    signal: req.signal,
    heartbeatMs: 5000,
    setup: (sink) => {
      registerSession({
        workspace,
        sessionId,
        push: (request) => {
          sink.event('command', { requestId: request.requestId, command: request.command });
        },
      });

      sink.event('hello', { workspace, sessionId });

      const sessionCheck = setInterval(() => {
        if (!heartbeatSession(workspace, sessionId)) {
          sink.close();
        }
      }, 5000);

      sink.onClose(() => {
        clearInterval(sessionCheck);
        unregisterSession(workspace, sessionId);
      });
    },
  });
}
