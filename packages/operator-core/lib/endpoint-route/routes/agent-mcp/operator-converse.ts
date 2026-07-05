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
  trigger?: 'user_message' | 'quiet_wait_resume' | 'open_canvas' | 'user_says_ready' | 'user_welcomed' | 'continue' | 'sentinel_scan';
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
  /** Which persona the brain assumes — the Sentinel-as-Herald re-home seam.
   *  Defaults to 'operator' (backward-compatible). 'sentinel' resolves the
   *  `papercup:converse` tool alias (same handler, loads the Herald persona). */
  role?: string;
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

    // Sentinel-as-Herald re-home seam: resolve `${role}:converse`. Default
    // 'operator' is byte-identical to before; 'sentinel' resolves the
    // papercup:converse alias (same handler, Herald persona). An unknown role
    // falls back to operator:converse so a stray value can't 500 a live turn.
    //
    // P-012 (text parity): an EXPLICIT body.role wins (P-006). When the caller
    // didn't set one, fall back to the `humanFacingRole` voice pref so the
    // Sentinel repoint is consistent with the voice + device paths. Default
    // remains 'operator' (pref unset/'operator' → byte-for-byte unchanged).
    let role = typeof body.role === 'string' && body.role.trim() ? body.role.trim() : '';
    if (!role) {
      try {
        const { loadVoicePrefs } = await import('../../../voice-prefs');
        const prefs = await loadVoicePrefs();
        // 'sentinel' is the pre-rename pref value (WI-2932) — accepted, resolves
        // to the canonical 'papercup' role id.
        role = prefs.humanFacingRole === 'sentinel' || prefs.humanFacingRole === 'papercup' ? 'papercup' : 'operator';
      } catch {
        role = 'operator';
      }
    }
    // The papercup persona brain is registered under `papercup:converse`
    // (sentinel-converse.ts); every other role resolves `${role}:converse`.
    // A stale explicit 'sentinel' still routes there during the expand phase.
    const converseToolName = role === 'sentinel' || role === 'papercup' ? 'papercup:converse' : `${role}:converse`;
    const operatorConverseTool =
      lookupByMcpName(converseToolName) ?? lookupByMcpName('operator:converse');
    if (!operatorConverseTool) {
      return new Response(`${converseToolName} tool not registered`, { status: 500 });
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
          log: (msg) => { console.log(`[${converseToolName}][tool] ${msg}`); },
          signal: ctrl.signal,
          progress: () => {},
          emit: () => { /* installed by dispatchProjectedToolStream */ },
          workspaceId,
          role,
          runId: globalThis.crypto.randomUUID(),
          spawnId: globalThis.crypto.randomUUID(),
          transport: 'in_process',
          uiClientId: body.uiClientId ?? null,
        };

        let totalCost = 0;
        try {
          for await (const ev of dispatchProjectedToolStream(
            operatorConverseTool,
            converseToolName,
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
              // Sentinel-as-Herald re-home seam: forward the persona role so the
              // prompt builder loads the matching persona set ('operator' default).
              role,
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
