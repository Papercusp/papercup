/**
 * GET /api/agent-mcp/delegate-chat — SSE shim into operator:delegate tool.
 * Ported from app/api/agent-mcp/delegate-chat/route.ts. `auth: 'public'`.
 */
import { sseResponse } from '@restart/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import '@/lib/agent-tools/index';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { resolveDelegateSession } from '@/lib/agent-tools/operator/delegate-session';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/delegate-chat',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const requestText = url.searchParams.get('request')?.trim();
    if (!requestText) {
      return new Response('missing required param: request', { status: 400 });
    }
    const requestedSessionId = url.searchParams.get('sessionId')?.trim() || undefined;
    const newSession = url.searchParams.get('newSession') === '1';

    const workspaceId = activeWorkspaceId();
    const delegateTool = lookupByMcpName('operator:delegate');
    if (!delegateTool) {
      return new Response('operator:delegate tool not registered', { status: 500 });
    }

    const resolved = await resolveDelegateSession(workspaceId, requestedSessionId, newSession);

    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        const ctxBase: UnifiedToolContext = {
          log: (msg) => { console.log(`[operator:delegate][tool] ${msg}`); },
          signal: req.signal,
          progress: () => {},
          emit: () => { /* installed by dispatchProjectedToolStream */ },
          workspaceId,
          role: 'operator',
          runId: resolved.agentSessionId,
          spawnId: resolved.agentSessionId,
          transport: 'in_process',
        };

        try {
          for await (const ev of dispatchProjectedToolStream(
            delegateTool,
            'operator:delegate',
            {
              requestText,
              sessionId: resolved.agentSessionId,
              newSession: false,
              preResolved: true,
              sessionCreated: resolved.sessionCreated,
            },
            ctxBase,
            {},
          )) {
            if (ev.kind === 'event') {
              emitToSseSink(sink, delegateTool, ev.name, ev.data);
            } else if (ev.kind === 'done') {
              try {
                const text = (ev.result.content[0] as { text?: string })?.text ?? '{}';
                const out = JSON.parse(text) as {
                  agentSessionId: string;
                  sessionCreated: boolean;
                  costUsd: number;
                  tokensIn: number;
                  tokensOut: number;
                  fullText: string;
                };
                sink.done({
                  agentSessionId: out.agentSessionId,
                  costUsd: out.costUsd,
                  tokensIn: out.tokensIn,
                  tokensOut: out.tokensOut,
                  fullText: out.fullText,
                });
              } catch (e) {
                console.warn('[delegate-chat] tool result parse failed:', e);
                sink.done({});
              }
            } else if (ev.kind === 'error') {
              sink.event('error', { message: ev.error.message });
              sink.close();
              return;
            }
          }
        } catch (e: unknown) {
          sink.event('error', { message: (e as Error)?.message ?? String(e) });
          sink.close();
        }
      },
    });
  },
});
