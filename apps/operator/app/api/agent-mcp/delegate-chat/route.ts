/**
 * GET /api/agent-mcp/delegate-chat?request=<text>&sessionId=<uuid>
 *
 * Thin SSE shim into the `operator:delegate` projected tool.
 * Self-contained as of the IPC-allowlist migration (2026-05-12): the
 * tool owns principal load, session pick / resume, mcpConfig assembly,
 * LLM streaming, and post-stream PG writes (appendDelegateTurn +
 * generateSessionTitle). This route only parses the URL query, gates
 * the budget-irrelevant inputs, and forwards events to the SSE sink.
 *
 * Used by: `delegate_to_claude` voice tool (see
 *   apps/operator/lib/commands/defs/delegation.ts) — the voice
 *   agent's deep-work escape hatch.
 *
 * See /docs/agents/action-registry §5.
 */

import { NextRequest } from 'next/server';
import { sseResponse } from '@restart/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
// Side-effect: registers operator:delegate + the other operator-side tools.
import '@/lib/agent-tools/index';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
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
        runId: `op-delegate-${Date.now()}`,
        spawnId: `op-delegate-${Date.now()}`,
        transport: 'in_process',
      };

      try {
        for await (const ev of dispatchProjectedToolStream(
          delegateTool,
          'operator:delegate',
          {
            requestText,
            sessionId: requestedSessionId,
            newSession,
          },
          ctxBase,
          {},
        )) {
          if (ev.kind === 'event') {
            // Schema-driven wire-kind dispatch — same source of truth
            // as every other migrated route.
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
              // Emit the rich done payload the consumer expects
              // (delegation.ts after Phase 2 reads costUsd + fullText
              // + agentSessionId).
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
            return;
          }
        }
      } catch (e: unknown) {
        sink.event('error', { message: (e as Error)?.message ?? String(e) });
      }
    },
  });
}
