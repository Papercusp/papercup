/**
 * operator:converse — Operator brain streaming-chat core.
 *
 * Self-contained as of the IPC-allowlist migration (2026-05-12). The
 * tool now owns the full lifecycle:
 *   - buildOperatorPrompt (role files, voice prefs, mem0 pre-turn
 *     injection, history budgeting, trigger/modality sections)
 *   - checkBudget gate
 *   - principal load + workspace check
 *   - mcpConfig assembly (agentmcp via mcp-remote bridge; reads
 *     ~/.papercusp/superuser-token directly)
 *   - LLM streaming via runAgentChat
 *   - post-stream side-effects: recordSpend, mem0 fact extraction
 *     (post-turn .add), and server-side <spawn>-tag dispatch
 *
 * The /api/agent-mcp/operator-converse route is now a thin shim that
 * resolves the session user from cookies (cookies aren't readable from
 * an IPC dispatch path) and forwards everything else through the tool.
 *
 * Wire format:
 *   event: delta    data: { text }                       ← object → JSON
 *                   (elevenlabs-conv consumer at :545 does
 *                    JSON.parse(line.slice(6)).text)
 *   event: tool_call data: { name, input }
 *   event: done     data: <ToolResult.content as JSON>  ← framework auto-emit
 *                                                       (route also emits
 *                                                        sink.done with cost)
 *
 * On the IPC path the route's sink.done re-emit is bypassed; the
 * framework auto-emitted `done` is sufficient (consumer reads from
 * the tool's return value `{ totalCost, assembled }`).
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '../../agent-chat-stream';
import { readAgentConfig, surfaceBackend, surfaceModel } from '../../agent-config';
import { selfUrl } from '../../self-url';
import { checkBudget, recordSpend } from '../../operator-budget';
import { parseOperatorTurn } from '../../operator-converse-tags';
import { readSystemPrincipal } from '../../system-principal';
import { activeWorkspaceId } from '../../workspace-registry';
import { ALL_AGENT_MCP_TOOLS } from '../../operator-mcp-tools';
import { PROMPT_ROLES } from '../../prompt-assembly';
import {
  buildOperatorPrompt,
  type ConverseSessionUser,
  type OperatorConverseInput,
} from './converse-prompt';

const MessageSchema = z.object({
  role: z.union([z.literal('user'), z.literal('assistant'), z.literal('system')]),
  content: z.string(),
});

const SessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string(),
  has_password: z.boolean(),
});

/** Exported so the `sentinel:converse` alias (sentinel-converse.ts) reuses the EXACT
 *  same strict arg surface — instead of a `.passthrough()` that drops the projected
 *  inputSchema's additionalProperties:false (the tool-input-schema-rejection guard). */
export const ArgsSchema = z.object({
  messages: z.array(MessageSchema).default([]),
  trigger: z
    .union([
      z.literal('user_message'),
      z.literal('quiet_wait_resume'),
      z.literal('open_canvas'),
      z.literal('user_says_ready'),
      z.literal('user_welcomed'),
      z.literal('continue'),
      // sentinel-as-herald-2026-06-21 Phase 5 (P-018): a PROACTIVE Sentinel sweep
      // turn — the server-side voice-host "decide to speak" tick fires this so a
      // proactive sentinel turn is distinguishable from a user-driven one (the
      // prompt surfaces FLEET-STATUS instead of a reply to the human). Gated:
      // only the server-side sweep (FLAGS.SENTINEL_PROACTIVE, default OFF) emits it.
      z.literal('sentinel_scan'),
    ])
    .optional(),
  welcomedUser: z.object({ display_name: z.string().optional() }).optional(),
  mayAskActive: z.boolean().optional(),
  modality: z.union([z.literal('voice'), z.literal('text')]).optional(),
  audienceMode: z.union([z.literal('engineer'), z.literal('novice')]).optional(),
  /** Which persona the brain assumes — the Sentinel-as-Herald re-home seam.
   *  Defaults to 'operator' (fully backward-compatible). 'sentinel' loads the
   *  always-on, voice-first Herald persona set (same brain, different persona).
   *  Constrained to the persona roles that ship a prompt set under
   *  apps/operator/prompts/ (PROMPT_ROLES); an unknown value would throw in the
   *  persona loader, so the schema pins it to the known set. */
  role: z.enum(PROMPT_ROLES).optional(),
  /** Rendering surface: 'desktop' (web/Tauri UI, default) vs 'tui' (the pui
   *  terminal workbench). Same persona either way; only per-surface affordances
   *  differ (tui-operator-surface D-001/D-003). */
  surface: z.union([z.literal('desktop'), z.literal('tui')]).optional(),
  uiClientId: z.string().optional(),
  /** The shared PG conversation this turn belongs to. Enables the rolling-
   *  summary context (compaction mode) + the post-turn compaction pass
   *  (operator-context-compaction-2026-06-05). Optional: callers without a
   *  conversation (llm-testing, legacy voice paths) get window-only context. */
  conversationId: z.string().optional(),
  /** Session user resolved from cookies by the HTTP route; null
   *  acceptable on the IPC path or unauthenticated calls. */
  sessionUser: SessionUserSchema.nullable().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

/**
 * The operator brain's model. Resolution chain (highest wins):
 *   1. `OPERATOR_BRAIN_MODEL` env — CI / ad-hoc override.
 *   2. agent-config `models['operator']` — set per-workspace via
 *      /settings/agent, same surface as every other agent role.
 *   3. `OPERATOR_BRAIN_MODEL_DEFAULT` — the pinned fallback below.
 *
 * The DEFAULT is pinned to Anthropic, NOT inherited from the user's
 * omp `modelRoles.default` (their coding-agent default). As of
 * 2026-05-21 that default was `openai-codex/gpt-5.5:xhigh`, which
 * reliably returns `server_error` from OpenAI Codex on the operator's
 * large (~50KB) converse prompt — every live turn came back empty.
 * The Anthropic provider handles the same prompt reliably. The brain
 * is a product feature; it must not break because the user retuned
 * their coding agent.
 *
 * A model set explicitly via env or settings is the user's INFORMED
 * choice and overrides the pin — including non-Anthropic models that
 * may choke on the big prompt. omp's `--model` needs the explicit
 * `provider/model` form — a bare id fuzzy-resolves to amazon-bedrock,
 * which has no key configured here.
 */
const OPERATOR_BRAIN_MODEL_DEFAULT = 'anthropic/claude-opus-4-7';

async function resolveBrainModel(): Promise<string> {
  const env = process.env.OPERATOR_BRAIN_MODEL;
  if (env && env.trim()) return env.trim();
  try {
    const cfg = await readAgentConfig();
    const v = cfg.models['operator'];
    if (v && v.trim()) return v.trim();
  } catch {
    /* PG unreachable — fall through to the pinned default */
  }
  return OPERATOR_BRAIN_MODEL_DEFAULT;
}

function readSuperuserToken(): string {
  try {
    const token = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
    return token.length >= 16 ? token : '';
  } catch {
    return '';
  }
}

export default defineTool({
  name: 'operator:converse',
  expose: { ipc: true },
  profile: 'engineer',
  description:
    'Operator brain conversation turn. Self-contained: builds the prompt (role+memory+history+trigger), gates on budget, runs the LLM with agentmcp tools, records spend, post-turn mem0.add, dispatches <spawn> tags. Streams deltas + tool_calls.',
  capability: 'operator:converse',
  requirePrincipal: false,
  // Sentinel-as-Herald: the sentinel is re-homed onto the always-on voice-first
  // Herald, which IS this converse brain loaded with role='sentinel' (the
  // operator-converse route resolves `${role}:converse` and the prompt builder
  // loads the sentinel persona set). So the sentinel role must be allowlisted
  // here too — paired with its operator:converse capability grant
  // (BLUEPRINT_ROLE_CAPS.sentinel). The sentinel:converse tool alias registers
  // the same handler under the sentinel name; both resolve this allowlist.
  agentRoles: ['operator', 'sentinel'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  // Phase 4 T2.2 — opt into replay buffer. 5000 events is a
  // generous soft cap; eviction warn-logs let us tune down once
  // migration 066's event_count column has p99 data.
  replayBufferSize: 5000,
  // Phase 4 T3.1 — operator:converse is the brain for BOTH text
  // chat AND voice (the EL Conv AI integration POSTs to this same
  // tool's HTTP shim). Declaring both modalities means it shows up
  // in both surface catalogs.
  modality: ['text', 'voice'],
  args: ArgsSchema,
  events: {
    delta: z.object({ text: z.string() }),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
  },
  handler: async (input: Args, ctx) => {
    const sessionUser: ConverseSessionUser | null = input.sessionUser ?? null;

    // Build the prompt up-front. This dominates wall-clock when mem0
    // is healthy (search hits one or two times). Failures inside
    // buildOperatorPrompt are swallowed best-effort already; an
    // outer throw here would be a real config error worth surfacing.
    //
    // Returns BOTH a system prompt (persona + tools + memory — the
    // stable spec) AND a user prompt (history + trigger + modality —
    // this turn's context). The agent backend (omp) is invoked with
    // `--system-prompt @file` for the system part so the brain
    // assumes the Operator identity instead of meta-commenting on
    // the persona as a document handed to it (2026-05-21 root cause).
    const { systemPromptText, userPromptText } = await buildOperatorPrompt(
      {
        messages: input.messages,
        trigger: input.trigger,
        welcomed_user: input.welcomedUser,
        mayAskActive: input.mayAskActive,
        modality: input.modality,
        audienceMode: input.audienceMode,
        surface: input.surface,
        uiClientId: input.uiClientId,
        conversationId: input.conversationId,
        // Sentinel-as-Herald re-home seam: 'operator' (default) is unchanged;
        // 'sentinel' loads the Herald persona set.
        role: input.role,
      } satisfies OperatorConverseInput,
      sessionUser,
    );

    // Budget gate. operator-converse fires on every user turn AND
    // self-fired silence-ladder triggers AND through ask_operator
    // from voice — without a cap this burns through the daily budget.
    const budget = await checkBudget();
    if (budget.state && budget.exceeded) {
      throw new Error(
        `Papercup daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
      );
    }

    // Principal + workspace check: transport-agnostic gate via
    // readSystemPrincipal. Missing principal falls through to a lean
    // tool-less path so conversation still works.
    // The workspace this turn runs in. Prefer the DISPATCH context's
    // workspace — the route/IPC layer resolved it INSIDE the request scope
    // (x-papercusp-workspace header / window stamp). Re-resolving
    // activeWorkspaceId() here runs outside the request ALS (the SSE setup
    // dispatches after the route handler has returned its Response), so it
    // silently falls back to the process-global workspace. That mis-keys the
    // state channel: chat_ask_choice cards register under the global
    // workspace while the voice SSE subscribed the request's workspace — no
    // overlap, so EVERY voice disambiguation card silently died and the
    // brain's askUser timed out to a prose fallback (root cause of the S16
    // cardUsage failures; voice-persona-production-readiness P-003, found
    // live 2026-06-07). '*' is the superuser wildcard, not a real workspace.
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    // The principal lookup must target the SAME workspace (it defaults to the
    // ALS-lost activeWorkspaceId() too — leaving it implicit reintroduces the
    // mismatch as a tool-less brain: principal from the global workspace,
    // comparison against the request's).
    const principal = await readSystemPrincipal('operator', workspaceId);
    const principalOk = principal !== null && principal.workspaceId === workspaceId;

    // mcpConfig with agentmcp HTTP via mcp-remote bridge (same pattern
    // as the old route). Reads superuser token from disk.
    // Accept hex/dash UUIDs (the browser tab's client id) AND the
    // llm-testing framework's `llm-testing/<uuid>` form. Both are
    // URL-safe after encodeURIComponent. The framework's prefix is
    // what the brain-subprocess MCP transport needs to see for the
    // dispatcher's overrideTool hook to fire — without preserving it
    // here, nested tool calls would lose the tag and the override
    // would never apply.
    const uiClientId =
      typeof input.uiClientId === 'string'
        && /^(?:llm-testing\/)?[0-9a-fA-F-]{16,128}$/.test(input.uiClientId)
        ? input.uiClientId
        : null;
    // The operator's curated working set (operator-mcp-tools.ts). chat:ask_choice
    // is available on the TUI surface too: the pui renders inline terminal cards
    // from the state-channel `openCards` snapshot and answers them via
    // /card-response (sentinel-tui-shared-backend-and-cards-2026-06-22 Phase 2a),
    // so a card no longer blocks until timeoutSec on the terminal. One set feeds
    // BOTH the `?tools=` allowlist and `--allowed-tools`, so the listed surface
    // and the callable surface stay identical by construction.
    const operatorTools: readonly string[] = ALL_AGENT_MCP_TOOLS;
    // `?tools=` shrinks the operator's /api/mcp surface from ~226 → ~50 tools,
    // loaded NON-deferred (each marked always-load server-side), so Claude
    // Code stops ToolSearch-flailing over a giant deferred catalog
    // (voice-persona-production-readiness P-009). The param value is the
    // colon MCP-catalog name (strip the claude-code `mcp__agentmcp__` prefix).
    const toolsParam = operatorTools
      .map((t) => t.replace(/^mcp__agentmcp__/, ''))
      .join(',');
    // workspace= is REQUIRED for state-channel scoping: chat:ask_choice
    // sub-tool calls (via claude-code → MCP HTTP) need ctx.workspaceId
    // to match what the chat surface subscribed to (subscribeWorkspace).
    // Without it, http-projection defaults to workspaceId='*' for the
    // superuser path and cards from chat:ask_choice never reach the
    // PendingCardsBar (registers under '*', surface subscribed to real
    // workspaceId — no overlap). Tool blocks until 60s timeoutSec.
    //
    // Plan ref: bespoke-card-improvements-2026-05-13.md §4.4 wire shape.
    const mcpUrl =
      `${selfUrl()}/api/mcp?superuser=1&workspace=${encodeURIComponent(workspaceId)}` +
      `&tools=${encodeURIComponent(toolsParam)}` +
      (uiClientId ? `&client=${encodeURIComponent(uiClientId)}` : '');
    const superuserToken = readSuperuserToken();
    const mcpConfig =
      principalOk && superuserToken
        ? {
            mcpServers: {
              // Direct HTTP MCP — omp connects to the host's /api/mcp
              // natively, the same shape the user's papercusp-su server
              // uses. The old `npx mcp-remote@latest` stdio bridge added
              // a cold npm-resolve + a proxy subprocess on every turn and
              // was the flaky empty-turn culprit (2026-05-21): the brain
              // would intermittently produce no output because its tool
              // transport never came up in time. omp speaks HTTP MCP
              // natively, so the bridge is pure overhead.
              agentmcp: {
                type: 'http',
                url: mcpUrl,
                headers: { Authorization: `Bearer ${superuserToken}` },
              },
            },
          }
        : undefined;
    // The callable surface mirrors the listed (`?tools=`) surface exactly —
    // operatorTools is now the full set on BOTH surfaces (chat:ask_choice
    // INCLUDED on tui; the pui renders inline terminal cards — see the note
    // above, Phase 2a). Listed == callable by construction.
    const allowedTools: readonly string[] =
      principalOk && superuserToken ? operatorTools : [];

    let totalCost = 0;
    let assembled = '';
    let emittedToolCall = false;

    // Resolve the brain model once per turn: env > agent-config
    // models['operator'] > pinned Anthropic default.
    const brainModel = await resolveBrainModel();
    // Per-surface backend override (/settings/agent). undefined → inherit the
    // global $AGENT_BACKEND that applyToProcessEnv mirrors from agent-config.
    const operatorBackend = await surfaceBackend('operator');
    // Per-surface model override (OQ3) wins over the pinned brain default
    // — needed when the per-surface backend is one the default model id
    // (anthropic/claude-opus-4-7) doesn't resolve on (e.g. codex).
    const operatorModel = (await surfaceModel('operator')) ?? brainModel;

    // The agent backend (omp → codex/anthropic) intermittently produces
    // an empty turn: a transient upstream model error, or omp exiting 0
    // with no assistant text. Retry ONCE when an attempt produced
    // nothing at all — but never after any delta/tool_call has already
    // streamed to the user, since that output is committed on the wire.
    // (2026-05-21: operator returned blank turns under codex flakiness.)
    const MAX_BRAIN_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_BRAIN_ATTEMPTS; attempt++) {
      try {
        for await (const ev of runAgentChat({
          promptText: userPromptText,
          systemPromptText,
          model: operatorModel,
          backend: operatorBackend,
          mcpConfig,
          allowedTools: [...allowedTools],
          permissionMode: 'bypassPermissions',
          // Isolate the claude-code brain spawn from the host ~/.claude so
          // it loads ONLY its agentmcp tools + persona — not the dev box's
          // MCP servers (coord_*/harness_*/papercusp-su) + SessionStart
          // skills hook, which under bypassPermissions make the brain go
          // agentic and emit no clean turn (turns=0). No-op for non-claude
          // backends. See plan operator-brain-test-isolation-2026-06-02.
          isolateConfig: true,
          // The operator reaches its world ONLY through agentmcp tools and
          // emits <say>/<spawn> as control-tag text — it needs no Claude
          // Code built-ins, and when present it misuses them (no-op Bash
          // "comments", ToolSearch-ing already-loaded tools, occasional
          // 600s loops). Deny them all. See voice-persona-production-readiness.
          disallowBuiltins: true,
          // Load the ~50-tool `?tools=`-filtered surface DIRECTLY (no ToolSearch
          // deferral). Empirically the proven non-deferral lever on claude-code
          // 2.1.x — per-tool `_meta.alwaysLoad` is not honored over HTTP MCP.
          // Safe only because the mcpUrl above pins `&tools=` to the small set.
          // (voice-persona-production-readiness P-009.)
          disableToolSearch: true,
          signal: ctx.signal,
        })) {
          if (ctx.signal.aborted) break;
          if (ev.type === 'delta') {
            ctx.emit('delta', { text: ev.text });
            assembled += ev.text;
          } else if (ev.type === 'tool_call') {
            emittedToolCall = true;
            const name = ev.name.startsWith('mcp__agentmcp__')
              ? ev.name.replace(/^mcp__agentmcp__/, '')
              : ev.name;
            ctx.emit('tool_call', { name, input: ev.input });
          } else if (ev.type === 'result') {
            totalCost += ev.costUsd ?? 0;
          } else if (ev.type === 'error') {
            // runAgentChat yields exactly one terminal `error` event
            // when the agent backend itself failed. Log it (stderr
            // included) for host-log visibility; fall through to the
            // empty-output retry check below rather than throwing, so a
            // transient backend error still gets a second attempt.
            const detail = ev.stderr
              ? `${ev.message}\n--- stderr ---\n${ev.stderr}`
              : ev.message;
            console.error(
              '[operator:converse] agent backend error ' +
                `(attempt ${attempt}/${MAX_BRAIN_ATTEMPTS}): ${detail}`,
            );
          }
        }
      } catch (err) {
        throw new Error(
          `operator converse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Stop once this attempt committed any output, or on abort.
      if (assembled.trim() || emittedToolCall || ctx.signal.aborted) break;
      if (attempt < MAX_BRAIN_ATTEMPTS) {
        console.error(
          `[operator:converse] brain produced no output on attempt ${attempt} — retrying.`,
        );
      }
    }

    // Definitive failure: nothing produced across all attempts. Surface
    // it as an error rather than masquerading a dead brain as an empty
    // `done` — the route turns a thrown error into `event: error`.
    if (!assembled.trim() && !emittedToolCall && !ctx.signal.aborted) {
      console.error(
        `[operator:converse] agent backend produced no output after ${MAX_BRAIN_ATTEMPTS} attempts.`,
      );
      throw new Error('operator brain produced no output (agent backend failure)');
    }

    // Post-stream side-effects. All fire-and-forget so transient
    // failures don't fail the user-visible response.
    void recordSpend(totalCost);

    // Rolling-summary compaction pass (operator-context-compaction-2026-06-05):
    // fold turns that aged out of the verbatim window into the conversation's
    // PG summary so the NEXT turn still remembers them. Single-flighted +
    // threshold-gated inside; no-op without a conversationId.
    if (input.conversationId) {
      void (async () => {
        const { maybeCompactConversation } = await import(
          '../../operator-conversation-compaction'
        );
        await maybeCompactConversation(input.conversationId!);
      })().catch((err) => {
        console.warn(
          '[operator-converse] compaction pass failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    if (sessionUser) {
      void (async () => {
        try {
          // EI-2032: kill switch for per-turn conversation capture — the largest
          // source of low-signal / zero-anchor memories (the auto-extraction path
          // that bypasses the explicit-write conflict-check/boundary gates).
          // Default ON (behavior unchanged); PAPERCUSP_MEM0_CONVERSATION_CAPTURE=off
          // disables it (e.g. if conversational capture is adding recall noise).
          if (process.env.PAPERCUSP_MEM0_CONVERSATION_CAPTURE === 'off') return;
          // Conversation-window fact extraction is an OPTIONAL backend
          // capability (generalize-memory-backend-swappable D-003) —
          // mem0 has it; plain stores skip the post-turn capture.
          const { getMemoryBackend } = await import('../../memory/backend');
          const backend = getMemoryBackend();
          if (!backend.rememberConversation) return;
          if (!(await backend.available()).ok) return;
          const recentWindow = input.messages
            ? [...input.messages.slice(-5), { role: 'assistant' as const, content: assembled }]
            : [{ role: 'assistant' as const, content: assembled }];
          await backend.rememberConversation(recentWindow, {
            scope: sessionUser.id,
            metadata: {
              workspace_id: workspaceId,
              display_name: sessionUser.display_name,
              turn_at: Date.now(),
            },
          });
        } catch (err) {
          console.warn('[operator-converse] post-turn memory capture failed:', (err as Error).message);
        }
      })();
    }

    // Server-side <spawn> tag dispatch. Parsing the assembled turn
    // server-side ensures voice and text surfaces both trigger spawns.
    // (EL's ask_operator handler doesn't run the client-side parser.)
    //
    // Dispatches through the durable nursery spawn engine
    // (fleet/operator-spawn) — NOT the retired POST
    // /api/plugins/orchestrator/spawn, which 404'd silently (the plugin
    // is not installed) and targeted harness='system' (not a registered
    // project). The engine resolves the tag's harness attr (or the
    // workspace's single registered harness), records the row in
    // harness_shared.spawned_agents (visible in fleet:tree), launches the
    // child in the harness's real project dir, and records resolution
    // failures as failed nursery rows instead of dropping them.
    try {
      const parsed = parseOperatorTurn(assembled);
      // Sentinel-as-Herald handoff (sentinel-herald P-014/P-015/P-016): the
      // SENTINEL never places work itself — instead of `<spawn>` it emits
      // `<handoff_to_queen>`, which we dispatch THROUGH the file-and-nudge seam
      // (tier-gate → file high-priority user-requested work_item → nudge the Queen
      // → subscribe for hindsight). Honored ONLY for role==='sentinel'; the
      // operator path below ignores handoffs entirely (and the sentinel ignores
      // spawns — the two can't cross). The Sentinel must NOT fleet:spawn.
      const isSentinel = input.role === 'sentinel';
      if (isSentinel && parsed.handoffs.length > 0) {
        const [{ dispatchSentinelHandoff }, { defaultSentinelHandoffDeps }] = await Promise.all([
          import('../../operator-sentinel-handoff'),
          import('../../operator-sentinel-handoff-deps'),
        ]);
        const deps = defaultSentinelHandoffDeps();
        for (const h of parsed.handoffs) {
          void dispatchSentinelHandoff(h, workspaceId, deps)
            .then((r) => {
              if (r.status === 'error') {
                console.warn(`[sentinel-converse] handoff dispatch failed: ${r.error}`);
              }
            })
            .catch((err) => {
              console.warn('[sentinel-converse] handoff dispatch error', err);
            });
        }
      }
      // The OPERATOR spawns directly; the SENTINEL never does (its envelope denies
      // fleet:spawn). Guard the spawn dispatch on NOT-sentinel so a stray `<spawn>`
      // from the Herald persona is a no-op rather than a placement.
      if (!isSentinel && parsed.spawns.length > 0) {
        const { spawnAgentInHarness } = await import('../../fleet/operator-spawn');
        for (const sp of parsed.spawns) {
          // The operator conversation turn is NOT itself a nursery node, so each
          // spawned agent is a ROOT in the spawn tree (parent_spawn_id = null) —
          // inspect it with fleet:tree { spawn_id: <returned id> }. (A synthetic
          // parent id would be an orphan: getSubtree anchors on a real row, so a
          // tree rooted at a non-existent parent comes back empty.)
          void spawnAgentInHarness({
            workspaceId,
            harness: sp.harness,
            role: sp.role,
            featureId: sp.featureId,
            chunkId: sp.chunkId,
            extras: sp.extras,
            parentSpawnId: null,
            parentRole: 'operator',
          })
            .then((r) => {
              if (!r.ok) console.warn(`[operator-converse] spawn dispatch rejected: ${r.error}`);
            })
            .catch((err) => {
              console.warn('[operator-converse] spawn dispatch failed', err);
            });
        }
      }
    } catch (err) {
      console.warn('[operator-converse] spawn parse/dispatch error', err);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ totalCost, assembled }) }],
    };
  },
});
