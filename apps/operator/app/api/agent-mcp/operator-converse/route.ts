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
  subscribeWorkspace,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
// Side-effect: registers operator:converse + the other operator-side tools.
import '@/lib/agent-tools/index';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { checkBudget } from '@/lib/operator-budget';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ConverseRequestBody {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?: 'user_message' | 'quiet_wait_resume' | 'open_canvas' | 'user_says_ready' | 'user_welcomed';
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

  // Budget pre-flight. The voice consumer at elevenlabs-conv.ts:525
  // checks `res.ok` and degrades to "I had trouble..." on non-2xx.
  // If we let the tool's internal budget check throw, the dispatcher
  // converts it to an SSE error event with HTTP 200 — voice users
  // see a silent '...' because the EL consumer only accumulates
  // `payload.text` from delta events. Pre-flight here preserves the
  // 402 status code for HTTP consumers. The tool also re-checks
  // budget internally so IPC dispatches (which skip this shim)
  // don't bypass the gate.
  const budget = await checkBudget();
  if (budget.state && budget.exceeded) {
    return new Response(
      `Operator daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
      { status: 402 },
    );
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

      // Forward state-channel snapshots (ctx.askUser cards) onto this
      // SSE stream when (and only when) the turn is voice. The chat
      // surface uses /api/operator/state-snapshot separately and does
      // NOT need this fan-out.
      //
      // Gating rationale (audit): subscribeWorkspace is workspace-scoped,
      // so cards from a parallel conversation in the same workspace would
      // otherwise leak into this stream and be spoken during this voice
      // turn. Limiting to voice turns means: a user with one voice + one
      // text conversation gets the right behavior (chat surface owns text
      // cards via /state-snapshot; voice path only sees its own surface).
      // True multi-voice cross-talk would still occur but is far rarer
      // and resolves cleanly when a runId-propagation refactor lands.
      //
      // We additionally filter to cards with fallbackText set — that
      // signals the tool author intended voice rendering. Pure state-
      // shaped tools (ctx.publishState, no askUser) emit toolState
      // without fallbackText and don't need to reach voice.
      //
      // Plan: bespoke-card-improvements-2026-05-13.md §6.3
      let offStateChannel: (() => void) | null = null;
      if (body.modality === 'voice') {
        offStateChannel = subscribeWorkspace(workspaceId, (vs) => {
          if (sink.closed) return;
          const hasVoiceCard = vs.snapshot.openCards?.some(
            (c) => typeof c.fallbackText === 'string' && c.fallbackText.length > 0,
          );
          if (!hasVoiceCard) return;
          sink.event('state-snapshot', vs);
        });
        sink.onClose(offStateChannel);
      }

      const ctxBase: UnifiedToolContext = {
        log: (msg) => { console.log(`[operator:converse][tool] ${msg}`); },
        signal: ctrl.signal,
        progress: () => {},
        emit: () => { /* installed by dispatchProjectedToolStream */ },
        workspaceId,
        role: 'operator',
        // Phase 4 T2.2: UUIDs eliminate the Date.now() collision risk
        // that the v1 plan's reviewer flagged as concern #4. The /dev
        // Sessions UI tolerates any string runId/spawnId.
        runId: globalThis.crypto.randomUUID(),
        spawnId: globalThis.crypto.randomUUID(),
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
            // Close on error so the voice consumer's reader returns
            // EOF and the chat UI stops spinning. Was missing —
            // sink.event alone leaves the stream open and the client
            // hangs reading heartbeats.
            sink.close();
            return;
          }
        }
        sink.done({ costUsd: totalCost });
      } catch (err) {
        if (!ctrl.signal.aborted) {
          sink.event('error', { message: err instanceof Error ? err.message : String(err) });
        }
        sink.close();
      }
    },
  });
}
