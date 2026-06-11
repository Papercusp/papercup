/**
 * POST /api/agent-mcp/operator-converse — SSE stream of operator's next turn.
 * Thin shim into the operator:converse tool; resolves session user from
 * cookies (the one HTTP-only step), budget pre-flight, forwards the rest.
 * Ported from app/api/agent-mcp/operator-converse/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { sseResponse } from '@papercusp/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  subscribeWorkspace,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import '../../../agent-tools/index';
import { activeWorkspaceId } from '../../../workspace-registry';
import { checkBudget } from '../../../operator-budget';
import { defineTool } from '@papercusp/agent-mcp';

interface ConverseRequestBody {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?: 'user_message' | 'quiet_wait_resume' | 'open_canvas' | 'user_says_ready' | 'user_welcomed' | 'continue';
  welcomed_user?: { display_name?: string };
  mayAskActive?: boolean;
  modality?: 'voice' | 'text';
  /** Rendering surface: 'desktop' (default) vs 'tui' (the pui terminal
   *  workbench). Forwarded to operator:converse so it injects per-surface
   *  affordances (tui-operator-surface D-003). */
  surface?: 'desktop' | 'tui';
  uiClientId?: string;
  conversationId?: string;
  isAutoFire?: boolean;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-converse',
  auth: 'loopback',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  // The watchdog times only the handler's PRE-FLIGHT (json/budget/auth — the
  // SSE Response returns before streaming starts), but under PG contention
  // those awaits can queue past the default 30s and 408 a healthy voice turn
  // (observed live 2026-06-07: brain route died at $0.00 spend in an op-S13
  // run while the box was loaded). The brain's own caps govern the stream.
  timeoutSec: 120,
  async handler(req) {
    let body: ConverseRequestBody = {};
    try {
      body = (await req.json()) as ConverseRequestBody;
    } catch {
      return new Response('invalid JSON body', { status: 400 });
    }

    const budget = await checkBudget();
    if (budget.state && budget.exceeded) {
      return new Response(
        `Papercup daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
        { status: 402 },
      );
    }

    let sessionUser: { id: string; username: string; display_name: string; has_password: boolean } | null = null;
    try {
      const { getSessionUserOrDefault } = await import('../../../auth');
      sessionUser = await getSessionUserOrDefault(req.headers);
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

        if (body.conversationId && body.uiClientId) {
          const { recordChainEvent } = await import('../../../operator-continue-chains');
          if (body.trigger === 'continue') {
            void recordChainEvent({
              conversationId: body.conversationId,
              uiClientId: body.uiClientId,
              trigger: 'continue',
            });
          } else if (body.trigger === 'user_says_ready' && body.isAutoFire) {
            void recordChainEvent({
              conversationId: body.conversationId,
              uiClientId: body.uiClientId,
              trigger: 'auto_fire_terminal',
            });
          } else if (body.trigger === 'user_message') {
            void recordChainEvent({
              conversationId: body.conversationId,
              uiClientId: body.uiClientId,
              trigger: 'reset',
            });
          }
        }

        const ctxBase: UnifiedToolContext = {
          log: (msg) => { console.log(`[operator:converse][tool] ${msg}`); },
          signal: ctrl.signal,
          progress: () => {},
          emit: () => { /* installed by dispatchProjectedToolStream */ },
          workspaceId,
          role: 'operator',
          runId: globalThis.crypto.randomUUID(),
          spawnId: globalThis.crypto.randomUUID(),
          transport: 'in_process',
          uiClientId: body.uiClientId ?? null,
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
              surface: body.surface,
              uiClientId: body.uiClientId,
              // Enables rolling-summary context + the post-turn compaction
              // pass (operator-context-compaction-2026-06-05).
              conversationId: body.conversationId,
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
  },
});
