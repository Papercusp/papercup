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
 *   - heartbeat   — server pings every 5s to keep the connection alive;
 *                   tab pings back via PUT /api/agent-mcp/run-command/sse
 *
 * The tab's `voice-leader.ts` election decides whether to open this
 * stream. Followers (non-leader tabs) don't subscribe.
 */

import { NextRequest } from 'next/server';
import {
  registerSession,
  unregisterSession,
  heartbeatSession,
} from '@/lib/commands/session-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const workspace = url.searchParams.get('workspace');
  const sessionId = url.searchParams.get('sessionId');
  if (!workspace || !sessionId) {
    return new Response('missing workspace or sessionId', { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* writer closed */
        }
      };

      // Register the tab as leader; provide a push function that emits a
      // `command` SSE event for each pending request.
      registerSession({
        workspace,
        sessionId,
        push: (request) => {
          send('command', { requestId: request.requestId, command: request.command });
        },
      });

      // Greet the tab.
      send('hello', { workspace, sessionId });

      // Heartbeat — keeps proxies + browser alive, also tickles
      // session-registry's lastSeen.
      const heartbeat = setInterval(() => {
        if (!heartbeatSession(workspace, sessionId)) {
          // Session was replaced (newer leader). Close this stream.
          closed = true;
          try {
            controller.close();
          } catch { /* already closed */ }
          clearInterval(heartbeat);
          return;
        }
        send('heartbeat', { t: Date.now() });
      }, 5000);

      // Tab disconnect → unregister.
      req.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(heartbeat);
        unregisterSession(workspace, sessionId);
        try {
          controller.close();
        } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
