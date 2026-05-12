/**
 * POST /api/agent-mcp/operator-converse
 *
 * SSE stream of the operator's next conversational turn.
 *
 * Self-contained as of the IPC-allowlist migration (2026-05-12): the
 * `operator:converse` tool owns prompt composition (role docs, mem0
 * pre-turn injection, history budgeting, trigger/modality sections),
 * budget gating, principal load, mcpConfig assembly, post-stream
 * recordSpend, mem0 post-turn .add, and <spawn>-tag dispatch.
 *
 * The route is a thin shim that resolves the session user from
 * cookies (cookies aren't readable from an IPC dispatch path, so this
 * is the one HTTP-only step) and forwards everything else into the
 * tool via dispatchProjectedToolStream.
 *
 * Request body:
 *   { messages, trigger, welcomed_user?, mayAskActive?, modality?,
 *     uiClientId? }
 *
 * SSE events emitted:
 *   - delta:  { text }                  — token-streamed model output
 *   - tool_call: { name, input }
 *   - done:   { costUsd }                — stream complete
 *   - error:  { message }                — fatal
 */

import { NextRequest } from 'next/server';
import { sseResponse } from '@restart/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
// Side-effect: registers operator:converse + the other operator-side tools.
import '@/lib/agent-tools/index';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ConverseRequestBody {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?: 'user_message' | 'silence_after_question' | 'quiet_wait_resume' | 'open_canvas' | 'user_says_ready' | 'user_welcomed';
  welcomed_user?: { display_name?: string };
  mayAskActive?: boolean;
  modality?: 'voice' | 'text';
  uiClientId?: string;
}

export async function POST(req: NextRequest) {
  let body: ConverseRequestBody = {};
  try {
    body = (await req.json()) as ConverseRequestBody;
  } catch {
    return new Response('invalid JSON body', { status: 400 });
  }

  // Resolve session user from cookies ONCE here — Next.js cookies()
  // reads the current request context, which isn't available inside
  // the tool handler (especially via IPC). The post-turn mem0.add
  // runs after the SSE stream completes, by which time cookies()
  // would not be reachable. Capture now, forward through the tool.
  let sessionUser: { id: string; username: string; display_name: string; has_password: boolean } | null = null;
  try {
    const { getSessionUserOrDefault } = await import('@/lib/auth');
    sessionUser = await getSessionUserOrDefault();
  } catch (err) {
    console.warn('[operator-converse] session user resolution failed:', (err as Error).message);
  }

  const operatorConverseTool = lookupByMcpName('operator:converse');
  if (!operatorConverseTool) {
    return new Response('operator:converse tool not registered', { status: 500 });
  }

  const ctrl = new AbortController();
  const workspaceId = activeWorkspaceId();

  return sseResponse({
    signal: req.signal,
    setup: async (sink) => {
      sink.onClose(() => ctrl.abort());

      const ctxBase: UnifiedToolContext = {
        log: (msg) => { console.log(`[operator:converse][tool] ${msg}`); },
        signal: ctrl.signal,
        progress: () => {},
        emit: () => { /* installed by dispatchProjectedToolStream */ },
        workspaceId,
        role: 'operator',
        runId: `op-converse-${Date.now()}`,
        spawnId: `op-converse-${Date.now()}`,
        transport: 'in_process',
      };

      let totalCost = 0;
      try {
        for await (const ev of dispatchProjectedToolStream(
          operatorConverseTool,
          'operator:converse',
          {
            messages: body.messages ?? [],
            trigger: body.trigger,
            welcomedUser: body.welcomed_user,
            mayAskActive: body.mayAskActive,
            modality: body.modality,
            uiClientId: body.uiClientId,
            sessionUser,
          },
          ctxBase,
          {},
        )) {
          if (ctrl.signal.aborted) break;
          if (ev.kind === 'event') {
            emitToSseSink(sink, operatorConverseTool, ev.name, ev.data);
          } else if (ev.kind === 'done') {
            try {
              const text = (ev.result.content[0] as { text?: string })?.text ?? '{}';
              const out = JSON.parse(text) as { totalCost: number; assembled: string };
              totalCost = out.totalCost;
            } catch (e) {
              console.warn('[operator-converse] tool result parse failed:', e);
            }
          } else if (ev.kind === 'error') {
            if (!ctrl.signal.aborted) sink.event('error', { message: ev.error.message });
            return;
          }
        }
        sink.done({ costUsd: totalCost });
      } catch (err) {
        if (!ctrl.signal.aborted) {
          sink.event('error', { message: err instanceof Error ? err.message : String(err) });
        }
      }
    },
  });
}
