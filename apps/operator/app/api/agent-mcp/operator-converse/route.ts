/**
 * POST /api/agent-mcp/operator-converse
 *
 * SSE stream of the operator's next conversational turn.
 *
 * Request body:
 *   {
 *     messages: [{ role: 'user'|'assistant'|'system', content }],
 *     trigger:  'user_message' | 'silence_after_question' | 'quiet_wait_resume' | 'open_canvas' | 'user_says_ready' | 'user_welcomed',
 *     mayAskActive: boolean,
 *   }
 *
 * SSE events emitted:
 *   - delta:  { text }                  — token-streamed model output
 *   - done:   { costUsd? }              — stream complete
 *   - error:  { message }               — fatal
 *
 * The shape matches Oracle's /api/oracle/chat so the client-side
 * stream-parser is shared via <ChatConversation>. Only routes + prompt
 * differ — Oracle uses scanner.md / oracle-specific instructions;
 * Operator uses operator.converse.md + operator.persona.md.
 *
 * Tag parsing (<say>, <set_mode>, <sleep>) happens client-side from
 * the buffered delta stream — see lib/operator-converse-tags.ts. The
 * route does NOT pre-parse, so the same wire format works for both
 * the text path and the future voice-realtime path.
 */

import { NextRequest } from 'next/server';
import { sseResponse } from '@restart/sse';
import {
  dispatchProjectedToolStream,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
// Side-effect: registers operator:converse + the other operator-side tools.
import '@/lib/agent-tools/index';
import { checkBudget, recordSpend } from '@/lib/operator-budget';
import { parseOperatorTurn } from '@/lib/operator-converse-tags';
import { selectHistoryWithinBudget } from '@/lib/operator-converse-history';
import { loadVoicePrefs } from '@/lib/voice-prefs';
import { readSystemPrincipal } from '@/lib/system-principal';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { ALL_AGENT_MCP_TOOLS } from '@/lib/operator-mcp-tools';
import {
  loadRolePersona,
  loadRoleToolsMd,
  loadRoleConverse,
  renderToolsCatalog,
} from '@/lib/prompt-assembly';


export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ConverseRequestBody {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?: 'user_message' | 'silence_after_question' | 'quiet_wait_resume' | 'open_canvas' | 'user_says_ready' | 'user_welcomed';
  /** Optional context for user_welcomed trigger. */
  welcomed_user?: { display_name?: string };
  mayAskActive?: boolean;
  /**
   * Output surface for this turn. 'voice' when EL/Realtime is
   * connected — the brain MUST reply in plain say() because
   * text-only affordances (chat:ask_choice buttons) are invisible
   * to a voice user. Defaults to 'text' on missing/unknown values.
   */
  modality?: 'voice' | 'text';
  /**
   * UI client id of the originating browser tab. The chat surface
   * passes this through so the agent's MCP URL is bound to that tab
   * — `ctx.uiClientId` is populated and `ui:*` tools default to it.
   */
  uiClientId?: string;
}

// History selection is token-budgeted (see selectHistoryWithinBudget).
// The legacy HISTORY_KEEP=30 fixed-count cap is gone; budget defaults
// to 40k tokens, configurable via VoicePrefs.operatorHistoryTokenBudget.

interface SessionUser {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

async function buildPrompt(body: ConverseRequestBody, sessionUser: SessionUser | null): Promise<string> {
  const prefs = await loadVoicePrefs().catch(() => null);
  const budget = prefs?.operatorHistoryTokenBudget ?? 40000;
  const messages = selectHistoryWithinBudget(
    (body.messages ?? []).filter(
      (m) => m && typeof m.role === 'string' && typeof m.content === 'string',
    ),
    budget,
  );
  const modality: 'voice' | 'text' = body.modality === 'voice' ? 'voice' : 'text';

  const trigger = body.trigger ?? 'user_message';
  const mayAskActive = !!body.mayAskActive;

  const sections: string[] = [];

  // Phase 3 of the tool-guidance arc: the server brain reads from the
  // .md files via prompt-assembly (single source of truth for human
  // edits). The voice path (lib/voice-engines/*) keeps the condensed
  // OPERATOR_PERSONA_PROMPT TS constant because EL Conv AI's shell
  // agent runs on Haiku with a tight token budget — see comments in
  // lib/operator-persona.ts. Two different LLMs, two different
  // prompts.
  sections.push(loadRoleConverse('operator'));
  sections.push(loadRolePersona('operator'));

  // Tools catalog with per-tool guidance from defineTool({ guidance }).
  // Phase 1a of the tool-guidance arc — renders only the tools the
  // operator is allowed to call. Each ALL_AGENT_MCP_TOOLS entry is the
  // claude-code-visible form (mcp__agentmcp__<name>); we strip the
  // server-alias prefix and pass both candidate forms (claude-code's
  // underscored `orchestrator_spawn` and the registry's dotted
  // `orchestrator.spawn`) so the catalog resolves regardless of the
  // dot-to-underscore translation that claude-code applies. Empty
  // guidance → description-only, so unmigrated tools are
  // backwards-identical to pre-guidance.
  const operatorToolNames: string[] = [];
  for (const fullName of ALL_AGENT_MCP_TOOLS) {
    const stripped = fullName.replace(/^mcp__agentmcp__/, '');
    operatorToolNames.push(stripped);
    if (stripped.includes('_')) {
      // orchestrator_spawn → orchestrator.spawn (registry's canonical
      // MCP name uses `.` for plugin tools, claude-code uses `_`).
      operatorToolNames.push(stripped.replace(/_/g, '.'));
    }
  }
  const catalog = renderToolsCatalog('operator', operatorToolNames);
  if (catalog) sections.push(catalog);

  // Cross-tool playbook + named workflows (Phase 1c). Loaded from
  // operator.tools.md; falls back to empty if the file is missing.
  const playbook = loadRoleToolsMd('operator');
  if (playbook) sections.push(playbook);

  // Operator memory (Plan 3) — pre-turn auto-injection. Surfaces the
  // user's stored facts relevant to the last few user turns. Best-
  // effort: if mem0 isn't available (deps not installed, PG down),
  // the section is empty and the rest of the prompt is unaffected.
  try {
    const recentUserContext = messages
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.content)
      .join('\n');
    if (recentUserContext && sessionUser) {
      const { getMemoryClient } = await import('@/lib/memory/mem0-client');
      const client = await getMemoryClient();
      const user = sessionUser;
      if (client) {
        // Workspace id for shared-memory filter.
        const { activeWorkspaceId } = await import('@/lib/workspace-registry');
        const ws = activeWorkspaceId();
        const [userHits, sharedHits] = await Promise.all([
          client.search(recentUserContext, { userId: user.id, limit: 6 }),
          client.search(recentUserContext, { userId: `workspace:${ws}`, limit: 4 }),
        ]);
        const combined = [...(userHits.results ?? []), ...(sharedHits.results ?? [])];
        const memText: string[] = [];
        for (const hit of combined) {
          const kind = (hit.metadata as Record<string, unknown>)?.kind ?? 'unknown';
          const shared = (hit.metadata as Record<string, unknown>)?.shared ? ' [shared]' : '';
          memText.push(`- [${kind}${shared}] ${hit.memory}`);
        }
        if (memText.length > 0) {
          sections.push(`## Operator memory (relevant entries)\n\n${memText.join('\n')}`);
        }
      }
    }
  } catch (err) {
    // Pre-turn memory injection is best-effort; never block the prompt.
    console.warn('[operator-converse] memory injection failed:', (err as Error).message);
  }

  // Conversation history — minimal serialization. Roles are preserved
  // so the model can reason about who said what.
  if (messages.length > 0) {
    // Messages were already truncated to maxTurnChars by
    // selectHistoryWithinBudget — no double-truncation here.
    const transcript = messages
      .map((m) => `[${m.role}]\n${m.content}`)
      .join('\n\n');
    sections.push(`## Conversation history (oldest first; last ${messages.length} turns)\n\n${transcript}`);
  }

  // Trigger context — tells the model whether this is a normal user
  // message, a self-fired silence nudge, or a quiet-wait resume.
  const triggerLines: Record<NonNullable<ConverseRequestBody['trigger']>, string> = {
    user_message: 'Trigger: user_message — the user just said something. React per the ladder.',
    silence_after_question: 'Trigger: silence_after_question — you asked the user something and they did not reply within 30s. Write ONE brief context-specific follow-up: first sentence references WHAT you were waiting to hear back on (e.g. "Still want me to dispatch the architect for that?" not "Still with me?"), then end with literally: "When you\'re ready, just say ready." That tells the user how to re-engage without you needing to ask again. After this nudge, the system will NOT prompt again. Total length: 2 sentences, under 30 words.',
    quiet_wait_resume: 'Trigger: quiet_wait_resume — the user just re-engaged after a long silence. Reference where you left off in your first sentence, then continue the thread.',
    open_canvas: `Trigger: open_canvas — fresh chat with no prior history.

STEP 1: Use MCP tools (harness:list / harness:status / issues:list / harness:escalation / harness:pending_reviews / audit:list) AND/OR your full conversation history above to find what's actionable.

STEP 2: Decide the OUTPUT SHAPE — cards or text. **PREFER CARDS.**

CARDS (use this whenever possible) — emit \`chat:ask_choice\` if you can name ≥2 distinct things the user could pick between. Includes:
  - 2 named items + "something else" (3 options total) ← THIS COUNTS, use cards
  - 3 active threads (use 3 options, no "other")
  - 2 specific escalations to triage
Button labels ≤80 chars. ≤3 options total. Mark one option with style: 'primary' if you have a recommended pick. End your turn after the tool call. The buttons ARE the prompt; do NOT also write the question as text.

WORKED EXAMPLE — DO emit cards for this:
  User's last context: "rust port and marketplace pipeline were both active."
  ✅ chat:ask_choice({ question: "Pick up where you left off?", options: [
       { id: "rust", label: "Check rust port status", style: "primary" },
       { id: "marketplace", label: "Check marketplace pipeline" },
       { id: "other", label: "Something else" }] })
  ❌ <say>"Want to check status on one, or pick something else?"</say>   ← AMBIGUOUS, USE CARDS

TEXT (fallback) — use plain <say> ONLY when:
  - There is exactly ONE obvious action ("Sheets has 3 escalations — open the latest?")
  - The situation is genuinely open-ended discussion (no comparables exist)
  - Fresh install / nothing set up: "Nothing set up here yet. Want to create your first harness?"

FORBIDDEN: generic greetings like "Hi, what can I help with" / "How can I help you today" / "Let me know what you need" — never start that way regardless of card vs text.

NOTE: when modality is 'voice' (see Modality section above), do NOT emit chat:ask_choice — buttons are invisible to a voice user. Always use plain <say>.`,

    user_says_ready: `Trigger: user_says_ready — the user signaled they want suggestions ("ready", "next", "what now?", "go").

STEP 1: Re-read the full history above for specific scope ("remember yesterday's X", "continue with Y"). If no specific reference, use MCP tools (harness:list / harness:status / issues:list / harness:escalation / harness:pending_reviews).

STEP 2: Decide the OUTPUT SHAPE — cards or text. **PREFER CARDS.**

CARDS (default for this trigger) — emit \`chat:ask_choice\` whenever you can name ≥2 distinct things. Button labels ≤80 chars. ≤3 options. Mark one option with style: 'primary' if you have a recommended pick. End your turn after the tool call.

WORKED EXAMPLE — DO emit cards for this:
  Recent thread mentioned: sheets escalation, marketplace pipeline.
  ✅ chat:ask_choice({ question: "What's the priority?", options: [
       { id: "sheets", label: "Look at sheets escalation", style: "primary" },
       { id: "market", label: "Resume marketplace pipeline" },
       { id: "wiki", label: "Decide what to do with wiki" }] })
  ❌ <say>"Want to look at sheets, or maybe the marketplace?"</say>   ← USE CARDS

TEXT (fallback) — use plain <say> ONLY when:
  - There's exactly 1 obvious next step (just suggest it)
  - The situation is genuinely open-ended ("what do you think about pricing?")

Either way: NO generic greeting, NO open trailing question, NO "let me know what you need" — deliver substance.

NOTE: when modality is 'voice', do NOT emit chat:ask_choice — speak the suggestions aloud as a short list instead.`,

    user_welcomed: `Trigger: user_welcomed — the user just logged in${body.welcomed_user?.display_name ? ` as **${body.welcomed_user.display_name}**` : ''}. Open with a warm, NAMED greeting in your FIRST SENTENCE (e.g. "Welcome back, ${body.welcomed_user?.display_name ?? 'there'}.").

Then deliver substance via the same suggestions flow as user_says_ready: use MCP tools (harness:list / harness:status / issues:list / harness:escalation / harness:pending_reviews) to find what's actionable, emit chat:ask_choice with ≤3 options when you have distinct comparables, or plain <say> with a single concrete suggestion otherwise.

NEVER say "Hi, what can I help with" or any generic greeting — always anchor on a concrete fact + a concrete option.

NOTE: when modality is 'voice', do NOT emit chat:ask_choice — speak the suggestions aloud as a short list instead.`,
  };
  // Modality — tells the brain whether the user is reading text or
  // hearing audio. Voice users can't see chat:ask_choice buttons.
  sections.push(
    `## Modality\n\nOutput surface: **${modality}**.\n\n` +
      (modality === 'voice'
        ? 'You are speaking to a voice user. Reply in plain <say> text. DO NOT call chat:ask_choice — buttons in the chat sidebar are invisible to a voice user. If you have multiple options to surface, speak them as a short spoken list (≤3 items).'
        : 'You are talking to a user reading the chat sidebar. When you have 2-3 distinct, comparable options, you may emit chat:ask_choice to render clickable buttons. Otherwise use plain <say> text.'),
  );

  sections.push(`## Trigger\n\n${triggerLines[trigger]}`);

  if (mayAskActive) {
    sections.push(`## [may_ask_active]\n\nThe runtime allows you to ask "Do you want me to go back into active mode?" at the end of your reply this turn — turns_in_last_2_min ≥ 3 AND sleep timer expired. Use only if it fits.`);
  }

  return sections.join('\n\n---\n\n');
}

export async function POST(req: NextRequest) {
  let body: ConverseRequestBody = {};
  try {
    body = (await req.json()) as ConverseRequestBody;
  } catch {
    return new Response('invalid JSON body', { status: 400 });
  }

  // Resolve session user ONCE here — Next.js cookies() reads the
  // current request context. The post-turn mem0 extraction runs in a
  // fire-and-forget after the SSE stream completes, by which time
  // cookies() may not be reachable. Capture the user now and pass to
  // the closure. Same captured value is used by buildPrompt's
  // pre-turn injection (via closure) so we read cookies exactly once.
  let sessionUser: { id: string; username: string; display_name: string; has_password: boolean } | null = null;
  try {
    const { getSessionUserOrDefault } = await import('@/lib/auth');
    sessionUser = await getSessionUserOrDefault();
  } catch (err) {
    console.warn('[operator-converse] session user resolution failed:', (err as Error).message);
  }

  const promptText = await buildPrompt(body, sessionUser);

  // Budget gate. operator-converse fires on every user turn AND on
  // silence-ladder timers AND through ask_operator from voice; without
  // a cap this is the easiest way to burn through the daily budget.
  const budget = await checkBudget();
  if (budget.state && budget.exceeded) {
    return new Response(
      `Operator daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
      { status: 402 },
    );
  }

  const ctrl = new AbortController();

  return sseResponse({
    signal: req.signal,
    setup: async (sink) => {
      sink.onClose(() => ctrl.abort());

      try {
        // Wire the agent-mcp server in, same shape as operator-scan.
        // The operator brain needs orchestrator.spawn / poll / cancel
        // to delegate work the user asks for via voice or text — this
        // route is the brain for both transports (text chat directly,
        // voice via the EL ask_operator client tool).
        //
        // If the principal isn't provisioned (fresh install), fall back
        // to the lean tool-less path so conversation still works — the
        // operator just can't spawn until /api/agent-mcp/provision runs.
        const principal = await readSystemPrincipal('operator');
        const workspaceId = activeWorkspaceId();
        const principalOk =
          principal !== null && principal.workspaceId === workspaceId;
        // HTTP MCP transport — points at the operator's own /api/mcp
        // route (apps/operator/app/api/[transport]/route.ts), which
        // exposes the full plugin catalog (orchestrator.spawn et al).
        //
        // Uses ?superuser=1 + Authorization: Bearer <superuser-token>
        // (commit 0ccac7cf) since operator-converse runs at chrome
        // scope (no specific harness/spawn/run context). The bypass
        // turns off role-allowlist + quota gates — the operator role
        // could spawn anything anyway, and we don't have a real spawn
        // to derive runId from. Token lives at ~/.papercusp/superuser-token
        // and is read by the operator process itself, never sent to
        // remote agents.
        // Pass the originating tab's client_id through to the agent's
        // MCP URL so ctx.uiClientId is set and `ui:dispatch` can default
        // to it. Validated as a UUID-ish — anything else is dropped to
        // avoid passing arbitrary attacker-controlled query through.
        const uiClientId = typeof body.uiClientId === 'string' && /^[0-9a-fA-F-]{16,128}$/.test(body.uiClientId)
          ? body.uiClientId
          : null;
        const mcpUrl =
          'http://127.0.0.1:3055/api/mcp?superuser=1' +
          (uiClientId ? `&client=${encodeURIComponent(uiClientId)}` : '');
        let superuserToken: string | null = null;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          superuserToken = require('node:fs').readFileSync(
            require('node:path').join(require('node:os').homedir(), '.papercusp', 'superuser-token'),
            'utf8',
          ).trim();
          if (!superuserToken || superuserToken.length < 16) superuserToken = null;
        } catch { superuserToken = null; }
        const mcpConfig = principalOk && superuserToken
          ? {
              mcpServers: {
                // omp silently drops type:'http' MCP servers — bridge
                // through mcp-remote (stdio→HTTP) which is the same
                // pattern voice-mode and hindsight already use in
                // ~/.omp/agent/mcp.json. claude-code can also speak
                // this format, so it works for both backends.
                agentmcp: {
                  type: 'stdio',
                  command: 'npx',
                  args: [
                    '-y',
                    'mcp-remote@latest',
                    mcpUrl,
                    '--header',
                    `Authorization:Bearer ${superuserToken}`,
                  ],
                },
              },
            }
          : undefined;
        const allowedTools: readonly string[] =
          principalOk && superuserToken ? ALL_AGENT_MCP_TOOLS : [];

        const operatorConverseTool = lookupByMcpName('operator:converse');
        if (!operatorConverseTool) {
          sink.event('error', { message: 'operator:converse tool not registered' });
          return;
        }
        const ctxBase: UnifiedToolContext = {
          log: (msg) => { console.log(`[operator:converse][tool] ${msg}`); },
          signal: ctrl.signal,
          progress: () => {},
          emit: () => { /* installed by dispatchProjectedToolStream */ },
          workspaceId,
          role: 'operator',
          runId: `op-converse-${Date.now()}`,
          spawnId: `op-converse-${Date.now()}`,
        };

        let totalCost = 0;
        let assembled = '';

        for await (const ev of dispatchProjectedToolStream(
          operatorConverseTool,
          'operator:converse',
          {
            promptText,
            mcpConfigJson: mcpConfig ? JSON.stringify(mcpConfig) : '',
            allowedTools: [...allowedTools],
          },
          ctxBase,
          {},
        )) {
          if (ctrl.signal.aborted) break;
          if (ev.kind === 'event') {
            // delta + tool_call are both JSON-shape; forward via sink.event.
            sink.event(ev.name, ev.data as Record<string, unknown>);
          } else if (ev.kind === 'done') {
            try {
              const text = (ev.result.content[0] as { text?: string })?.text ?? '{}';
              const out = JSON.parse(text) as { totalCost: number; assembled: string };
              totalCost = out.totalCost;
              assembled = out.assembled;
              void recordSpend(totalCost);
            } catch (e) {
              console.warn('[operator-converse] tool result parse failed:', e);
            }
          } else if (ev.kind === 'error') {
            if (!ctrl.signal.aborted) sink.event('error', { message: ev.error.message });
            return;
          }
        }

        // Plan 3.5 — Post-turn fact extraction. Fire-and-forget:
        // mem0's .add() runs an Anthropic Haiku call to extract atomic
        // facts from the conversation window. Latency ~1-2s; cost
        // ~$0.0001 per turn. Doesn't block the SSE response.
        //
        // We pass the last few user/assistant turns (not the full
        // history) so mem0's extractor focuses on what just happened.
        // If mem0 isn't available (deps not installed, PG down), this
        // silently no-ops.
        void (async () => {
          if (!sessionUser) return; // no user → no per-user memory
          try {
            const { getMemoryClient } = await import('@/lib/memory/mem0-client');
            const { activeWorkspaceId } = await import('@/lib/workspace-registry');
            const client = await getMemoryClient();
            if (!client) return;
            // sessionUser was captured at the top of POST, before the
            // SSE stream — safe to read even after the request lifecycle
            // is over (no cookies() access here).
            const ws = activeWorkspaceId();
            const recentWindow = body.messages
              ? [...body.messages.slice(-5), { role: 'assistant' as const, content: assembled }]
              : [{ role: 'assistant' as const, content: assembled }];
            await client.add(recentWindow, {
              userId: sessionUser.id,
              metadata: {
                workspace_id: ws,
                display_name: sessionUser.display_name,
                turn_at: Date.now(),
              },
            });
          } catch (err) {
            console.warn('[operator-converse] post-turn mem0.add failed:', (err as Error).message);
          }
        })();

        // Server-side <spawn> tag dispatch. Parsing the assembled
        // turn here (rather than only in the client provider) ensures
        // the voice path also triggers spawns — EL's ask_operator
        // handler returns the say body to EL, but it never invokes
        // our client-side parser. The HTTP API call here is what makes
        // the spawn actually happen for both text and voice surfaces.
        try {
          const parsed = parseOperatorTurn(assembled);
          for (const sp of parsed.spawns) {
            const params = new URLSearchParams({
              workspace: workspaceId, // resolved earlier from activeWorkspaceId()
              harness: 'system',
              role: 'operator',
              run: `op-converse-${Date.now()}`,
              spawn: `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            });
            const body: Record<string, unknown> = { role: sp.role };
            if (sp.featureId) body.featureId = sp.featureId;
            if (sp.chunkId) body.chunkId = sp.chunkId;
            if (sp.extras.length > 0) body.extras = sp.extras;
            void fetch(`http://127.0.0.1:3055/api/plugins/orchestrator/spawn?${params.toString()}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }).catch((err) => {
              console.warn('[operator-converse] spawn dispatch failed', err);
            });
          }
        } catch (err) {
          console.warn('[operator-converse] spawn parse/dispatch error', err);
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
