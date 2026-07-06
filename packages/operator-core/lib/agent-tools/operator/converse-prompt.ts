/**
 * Prompt composition for the operator:converse tool. Moved out of
 * apps/operator/app/api/agent-mcp/operator-converse/route.ts so the
 * tool can call it directly and stay self-contained for IPC dispatch.
 *
 * The prompt assembles:
 *   - operator.converse.md + operator.persona.md (role docs)
 *   - per-tool catalog (renderToolsCatalog) — only the operator-visible
 *     tools, both _ and . name forms (claude-code vs registry)
 *   - operator.tools.md (cross-tool playbook)
 *   - mem0 pre-turn user/workspace memory (best-effort)
 *   - history-budget-trimmed conversation transcript
 *   - modality + trigger + may_ask_active hint sections
 */

import { selectHistoryWithinBudget } from '../../operator-converse-history';
import { loadVoicePrefs } from '../../voice-prefs';
import { ALL_AGENT_MCP_TOOLS } from '../../operator-mcp-tools';
import {
  loadRolePersona,
  loadRoleModePersona,
  loadRoleToolsMd,
  loadRoleConverse,
  renderToolsCatalog,
  type Role,
} from '../../prompt-assembly';
import { buildMemoryContextBlock, lastUserContext } from '../../memory/injection';
import { activeWorkspaceId } from '../../workspace-registry';
import { loadHarnessRegistry } from '../../harness-registry';

export interface ConverseInput {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?: 'user_message' | 'quiet_wait_resume' | 'open_canvas' | 'user_says_ready' | 'user_welcomed' | 'continue' | 'sentinel_scan';
  welcomed_user?: { display_name?: string };
  mayAskActive?: boolean;
  modality?: 'voice' | 'text';
  /** Which persona the converse brain assumes — the Sentinel re-home seam.
   *  Defaults to 'operator' (fully backward-compatible). 'sentinel' loads
   *  the Sentinel persona set (sentinel.persona[.<mode>-mode].md / .converse.md /
   *  .tools.md) instead, so the SAME brain becomes the always-on voice-first
   *  Sentinel. Constrained to PROMPT_ROLES (the roles with a persona set under
   *  apps/operator/prompts/); an unknown role would throw in loadRolePersona. */
  role?: Role;
  /** Who the operator is talking to. Controls the persona overlay injected
   *  as the first system section. Defaults to 'engineer'. */
  audienceMode?: 'engineer' | 'novice';
  /** Which rendering surface this turn is for. 'desktop' (web/Tauri UI, the
   *  default) vs 'tui' (the pui terminal workbench). The PERSONA is identical
   *  across surfaces (one role, one persona — tui-operator-surface D-001); only
   *  surface-appropriate AFFORDANCES are injected per turn (D-003). */
  surface?: 'desktop' | 'tui';
  /** The pui's workbench owner key (its tui_dispatch client_id), passed through
   *  on TUI turns so the affordance block can name the exact target. */
  uiClientId?: string;
  /** The shared PG conversation this turn belongs to. When present (desktop /
   *  device / TUI surfaces all send it) and the workspace runs in 'compaction'
   *  context mode, the prompt gains the rolling summary of every turn older
   *  than the verbatim window (operator-context-compaction-2026-06-05).
   *  Absent (legacy voice ask_operator, llm-testing) ⇒ window-only behavior. */
  conversationId?: string;
}

export interface ConverseSessionUser {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

export interface BuiltOperatorPrompt {
  /** Persona + tool catalog + tool playbook + memory. The stable spec
      sent as omp's --system-prompt so the model assumes the Operator
      identity rather than meta-commenting on it. */
  systemPromptText: string;
  /** This turn's context: conversation history + modality + trigger
      + may_ask_active hint. Sent as the positional user message so
      omp's chat loop sees it as the user's turn. */
  userPromptText: string;
}

export async function buildOperatorPrompt(
  input: ConverseInput,
  sessionUser: ConverseSessionUser | null,
): Promise<BuiltOperatorPrompt> {
  const prefs = await loadVoicePrefs().catch(() => null);
  const budget = prefs?.operatorHistoryTokenBudget ?? 40000;
  const messages = selectHistoryWithinBudget(
    (input.messages ?? []).filter(
      (m) => m && typeof m.role === 'string' && typeof m.content === 'string',
    ),
    budget,
  );

  // Rolling conversation summary (operator-context-compaction-2026-06-05).
  // In 'compaction' mode (the default) the verbatim window above stays the
  // recency floor and the PG-stored summary of everything older rides as a
  // separate section — so the brain remembers the gist of the WHOLE
  // conversation. Best-effort: no conversationId / no summary yet / a read
  // failure all degrade to exactly the legacy window behavior.
  const contextMode = prefs?.operatorContextMode ?? 'compaction';
  let compactedSummary: string | null = null;
  if (contextMode === 'compaction' && input.conversationId) {
    try {
      const { readConversationSummary } = await import('../../operator-conversations');
      const s = await readConversationSummary(input.conversationId);
      if (s?.summaryText && s.summaryText.trim()) compactedSummary = s.summaryText.trim();
    } catch (err) {
      console.warn(
        '[converse-prompt] summary read failed (window fallback):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const modality: 'voice' | 'text' = input.modality === 'voice' ? 'voice' : 'text';
  const trigger = input.trigger ?? 'user_message';
  const mayAskActive = !!input.mayAskActive;
  const audienceMode = input.audienceMode ?? 'engineer';
  // The persona the brain assumes — the Sentinel re-home seam. Defaults
  // to 'operator' (byte-identical to the pre-seam behavior); 'sentinel' loads the
  // Sentinel persona set instead. The catalog/playbook stay role-keyed too so each
  // persona gets its own tools.md.
  const role: Role = input.role ?? 'operator';

  // SYSTEM sections (stable persona spec — set as omp --system-prompt)
  const systemSections: string[] = [];

  // Audience-mode overlay first — frames who the user is before shared rules.
  const modeOverlay = loadRoleModePersona(role, audienceMode);
  if (modeOverlay) {
    systemSections.push(modeOverlay);
  } else {
    console.warn(`[converse-prompt] No mode overlay found for audienceMode="${audienceMode}" — ${role}.persona.${audienceMode}-mode.md is missing or unreadable.`);
  }

  systemSections.push(loadRoleConverse(role));
  systemSections.push(loadRolePersona(role));

  // Look the catalog up by the colon MCP-catalog name (the registry key), but
  // DISPLAY the underscore form below — Claude Code sanitizes the colon out of
  // an MCP tool name (`harness:status` → `harness_status`) before handing it to
  // the model, so the catalog must advertise the name the model actually sees
  // (voice-persona P-005). The earlier dotted-variant entries were dead: they
  // never matched the colon-keyed registry, so they only ever rendered nothing.
  const operatorToolNames = ALL_AGENT_MCP_TOOLS.map((fullName) =>
    fullName.replace(/^mcp__agentmcp__/, ''),
  );
  const toClaudeName = (mcpName: string): string => mcpName.replace(/:/g, '_');
  // Phase 4 T3.1: pass modality so the catalog filters out tools
  // that don't declare 'voice' support when this turn is voice-side.
  // Today chat_ask_choice is the load-bearing example — buttons are
  // invisible to a voice user, so the tool declares modality:['text']
  // and gets dropped from the voice catalog automatically (replaces
  // the manual NOTE in the trigger sections below).
  const catalog = renderToolsCatalog(role, operatorToolNames, modality, toClaudeName);
  if (catalog) systemSections.push(catalog);

  // Tool-calling contract (voice-persona P-005/P-009). The brain runs on
  // claude-code with a SMALL, directly-loaded MCP surface — the catalog above
  // is every tool it has, already loaded, NOT deferred. The historical failure
  // mode was the brain `ToolSearch`-ing colon names (`harness:status`) that
  // never resolved (claude-code presents the sanitized underscore form), firing
  // 4+ searches per turn and occasionally looping to the wall-clock cap. This
  // note + the underscore-named catalog close that gap.
  systemSections.push(
    `## Calling tools\n\n` +
      `Every tool you can call is listed in **Available tools** above — they are ` +
      `ALREADY LOADED and ready to call directly. Three hard rules:\n` +
      `- **Never call \`ToolSearch\`.** Your tools are not deferred; searching ` +
      `finds nothing new and wastes the turn. Just call the tool.\n` +
      `- **Use the exact catalog name — underscores, never colons.** It is ` +
      `\`harness_status\`, not \`harness:status\`; \`chat_ask_choice\`, not ` +
      `\`chat:ask_choice\`. Don't retry name variants; the catalog name is the ` +
      `only form that resolves.\n` +
      `- **The catalog is your ENTIRE tool surface — there are no built-ins.** ` +
      `You have no \`Bash\`, no \`Task\`, no file or shell access, and they will ` +
      `not work if you try. Never emit a \`Bash(...)\` call as a comment or ` +
      `no-op. If no catalog tool does what you need, say so in your \`<say>\` ` +
      `instead of improvising a tool.`,
  );

  const playbook = loadRoleToolsMd(role);
  if (playbook) systemSections.push(playbook);

  // Operator memory pre-turn injection — best-effort, via the shared
  // helper. Same source of truth as architect/brainstorm prompts; each
  // surface picks its own user/workspace scope.
  // Falls through silently when mem0 is unavailable.
  // Operator chat has no specific harness in scope, so fan out the
  // memory recall across every harness in the workspace. Failures
  // here are non-fatal — the injection helper is best-effort.
  let harnessSlugs: string[] = [];
  try {
    const reg = await loadHarnessRegistry(activeWorkspaceId());
    harnessSlugs = reg.projects.map((p) => p.slug);
  } catch { /* leave empty — recall just skips the harness pool */ }
  const memBlock = await buildMemoryContextBlock({
    userId: sessionUser?.id ?? null,
    workspaceId: activeWorkspaceId(),
    harnessSlugs,
    queryContext: lastUserContext(messages, 3),
    // The Sentinel's recall heading mirrors the operator one but names its own role
    // so an injected fact reads as the Sentinel's memory, not "Operator memory".
    ...(role === 'papercup' ? { heading: 'Sentinel memory (relevant entries)' } : {}),
  });
  if (memBlock) systemSections.push(memBlock);

  // SENTINEL read-context. The Sentinel watches the WHOLE
  // system, so it walks in already understanding the live state — escalations,
  // anomalies, progress, "what's worth surfacing" — built from the READY-MADE
  // digests (curation:feed salience ranking, the Overwatch anomaly brief, the
  // state-of-pot corpus digest, the live fleet), NOT re-derived from raw coord.
  // GUARDED on role==='sentinel' so the operator path is byte-identical (it never
  // gathers, never imports the sentinel module). Fail-soft: a gather error degrades
  // to no section — the turn never blocks on it (mirrors the memory block above).
  if (role === 'papercup') {
    try {
      const { gatherSentinelContext, renderSentinelContext, buildSentinelContextDeps, sentinelScopeLabel } =
        await import('../../sentinel/sentinel-context');
      const { isWorkspaceCoordinationOn } = await import('../../workspace-brain-scope');
      const wsId = activeWorkspaceId();
      // The primary hive the anomalies leg addresses: the first registered harness
      // in the workspace (the operator chat has no single harness in scope).
      // Best-effort — an empty pool falls back to the workspace id.
      const primaryHive = harnessSlugs[0] ?? wsId;
      // Heading scope LABEL: when the workspace-brain re-key is ON the summary's
      // digest legs already span every hive (D-008), so present it as
      // workspace-scoped rather than mislabeled with one harness. OFF =
      // byte-identical (the primary hive). Only the LABEL changes — the anomalies
      // leg's hiveSlug (overwatch addressing) stays primaryHive.
      const scopeLabel = sentinelScopeLabel(wsId, primaryHive, await isWorkspaceCoordinationOn());
      const ctxInput = await gatherSentinelContext(buildSentinelContextDeps(wsId, primaryHive), { hiveSlug: scopeLabel });
      const ctxBlock = renderSentinelContext(ctxInput);
      if (ctxBlock.trim()) systemSections.push(ctxBlock);
    } catch (err) {
      console.warn(
        '[converse-prompt] sentinel read-context build failed (omitting the section):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // USER sections (this turn's context — sent as the positional message)
  const userSections: string[] = [];

  if (compactedSummary) {
    userSections.push(
      `## Earlier conversation (compacted)\n\n` +
        `The verbatim transcript below covers only recent turns. Everything ` +
        `earlier was compacted into this rolling summary — treat it as your ` +
        `memory of the older conversation (decisions, preferences, named ` +
        `artifacts, open threads):\n\n${compactedSummary}`,
    );
  }

  if (messages.length > 0) {
    const transcript = messages
      .map((m) => `[${m.role}]\n${m.content}`)
      .join('\n\n');
    userSections.push(`## Conversation history (oldest first; last ${messages.length} turns)\n\n${transcript}`);
  }

  const triggerLines: Record<NonNullable<ConverseInput['trigger']>, string> = {
    user_message: 'Trigger: user_message — the user just said something. React per the ladder.',
    quiet_wait_resume: 'Trigger: quiet_wait_resume — the user just re-engaged after a long silence. Reference where you left off in your first sentence, then continue the thread.',
    continue: `Trigger: continue — you emitted \`<continue/>\` on the prior turn, signaling more user-visible progress. Pick up where you left off.

You may emit another \`<continue/>\` if the multi-step work isn't done yet — narrate progress in a \`<say>\` before the tag. When the task is finished, end naturally (no \`<continue/>\` on the last turn) and the runtime will auto-scan in active mode.

If you realize the work is actually complete and there's nothing more to narrate, end with a brief terminal \`<say>\` summarizing what's done. Do not loop on no-op continues.`,
    open_canvas: `Trigger: open_canvas — fresh chat with no prior history.

STEP 1: Use MCP tools (harness_list / harness_status / issues_list / harness_escalation / harness_pending_reviews / audit_list) AND/OR your full conversation history above to find what's actionable.

STEP 2: Decide the OUTPUT SHAPE — cards or text. **PREFER CARDS.**

CARDS (use this whenever possible) — emit \`chat_ask_choice\` if you can name ≥2 distinct things the user could pick between. Includes:
  - 2 named items + "something else" (3 options total) ← THIS COUNTS, use cards
  - 3 active threads (use 3 options, no "other")
  - 2 specific escalations to triage
Button labels ≤80 chars. ≤3 options total. Mark one option with style: 'primary' if you have a recommended pick. The buttons ARE the prompt; do NOT also write the question as text. chat_ask_choice BLOCKS until the user picks — you'll receive {picks:[{option_id,label},...]} as the tool result and can react to it in the same turn.

WORKED EXAMPLE — DO emit cards for this:
  User's last context: "rust port and marketplace pipeline were both active."
  ✅ chat_ask_choice({ question: "Pick up where you left off?", options: [
       { id: "rust", label: "Check rust port status", style: "primary" },
       { id: "marketplace", label: "Check marketplace pipeline" },
       { id: "other", label: "Something else" }] })
  ❌ <say>"Want to check status on one, or pick something else?"</say>   ← AMBIGUOUS, USE CARDS

TEXT (fallback) — use plain <say> ONLY when:
  - There is exactly ONE obvious action ("Sheets has 3 escalations — open the latest?")
  - The situation is genuinely open-ended discussion (no comparables exist)
  - Fresh install / nothing set up: "Nothing set up here yet. Want to create your first harness?"

FORBIDDEN: generic greetings like "Hi, what can I help with" / "How can I help you today" / "Let me know what you need" — never start that way regardless of card vs text.

NOTE: chat_ask_choice works in both text and voice. Voice users hear fallbackText (the question + options) and click on the chat surface. For voice-answerable cards (the silence-nudge Ready card sets voiceAnswerable:true), the user can also speak their pick.`,

    user_says_ready: `Trigger: user_says_ready — the user is open to suggestions. Fires from THREE entry points:
  (a) the user typed "ready" / "next" / "what now?" / "go"
  (b) the user clicked "Generate ideas" in the chat composer
  (c) you just finished a task in active mode and the runtime auto-fired this trigger to check what's actionable next

ALL THREE entry points expect the same behavior: do investigation in THIS ONE TURN (multi-tool MCP calls within a single turn are fine and expected — no need to chain), and produce one of:

  - \`chat_ask_choice\` with 2-3 specific options the user could pick next
  - \`<sleep duration_minutes="N"/>\` if there is genuinely nothing worth surfacing right now (entry point (c) only — for (a) and (b) the user explicitly asked, so always produce a card or short concrete answer)

**Do NOT emit \`<continue/>\` from this trigger.** Idle-scan work is one turn. Do not auto-execute side-effecting actions from this trigger — surface the suggestion as a card and let the user approve.

**Do NOT emit a terminal \`<say>\` without a card AND without a \`<sleep>\`.** That would loop back into another auto-fire. Either emit a card OR a sleep — never bare text from an entry-point-(c) auto-fire.

STEP 1: Re-read the full history above for specific scope ("remember yesterday's X", "continue with Y"). If no specific reference, use MCP tools (harness_list / harness_status / issues_list / harness_escalation / harness_pending_reviews) to find what's actionable. All within this turn.

STEP 2: Emit a card. **PREFER CARDS for this trigger** — when you have 2-3 distinct things to surface, the card is the right output. Button labels ≤80 chars. ≤3 options. Mark one option with style: 'primary' if you have a recommended pick.

WORKED EXAMPLE:
  Recent thread mentioned: sheets escalation, marketplace pipeline.
  ✅ chat_ask_choice({ question: "What's the priority?", options: [
       { id: "sheets", label: "Look at sheets escalation", style: "primary" },
       { id: "market", label: "Resume marketplace pipeline" },
       { id: "wiki", label: "Decide what to do with wiki" }] })
  ❌ <say>"Want to look at sheets, or maybe the marketplace?"</say>   ← USE CARDS

NOTE: chat_ask_choice works in both text and voice. Voice users hear the question + option labels as a spoken list and click on screen.`,

    user_welcomed: `Trigger: user_welcomed — the user just logged in${input.welcomed_user?.display_name ? ` as **${input.welcomed_user.display_name}**` : ''}. Open with a warm, NAMED greeting in your FIRST SENTENCE (e.g. "Welcome back, ${input.welcomed_user?.display_name ?? 'there'}.").

Then deliver substance via the same suggestions flow as user_says_ready: use MCP tools (harness_list / harness_status / issues_list / harness_escalation / harness_pending_reviews) to find what's actionable, emit chat_ask_choice with ≤3 options when you have distinct comparables, or plain <say> with a single concrete suggestion otherwise.

NEVER say "Hi, what can I help with" or any generic greeting — always anchor on a concrete fact + a concrete option.

NOTE: chat_ask_choice works in both text and voice. Voice users hear the question + option labels as a spoken list and click on screen.`,

    sentinel_scan: `Trigger: sentinel_scan — a PROACTIVE Sentinel sweep. NO human spoke; the server-side voice-host woke you on a timer to decide whether anything in the live system is worth surfacing RIGHT NOW. This is the Sentinel's "decide to speak" moment.

You are looking at the FLEET-STATUS context above (anomalies / live signals / standing patterns / fleet progress). Decide, with a HIGH bar, whether ONE thing genuinely deserves a spoken interruption:

  - If something is salient (a fresh blocker, a critical anomaly, a decision waiting on the human), emit ONE brief \`<say>\` surfacing the SINGLE most important item — calm, one fact, offer to go deeper ("…want the details?"). Voice constraints apply (≤220 chars, one <say>, plain language, grounded in the context — never invent).
  - If nothing rises to the bar, stay SILENT: emit NO \`<say>\` at all (an empty / tag-only turn). Silence is the correct and common outcome — a confused Sentinel that narrates noise is worse than one that waits.

Do NOT emit \`<continue/>\` from this trigger — a sweep is one turn. Do NOT ask a question or open a card unless a genuine decision is waiting on the human. Surface FLEET status, never the old operator workspace-suggestions flow.`,
  };

  userSections.push(
    `## Modality\n\nOutput surface: **${modality}**.\n\n` +
      (modality === 'voice'
        ? 'You are speaking to a voice user — every <say> is read aloud by TTS, so brevity is a HARD constraint, not a style preference. (1) EXACTLY ONE <say> per turn — only the FIRST <say> is ever spoken, so a second one (even reworded) is dead text; never restate or rephrase a <say> you already emitted this turn. LENGTH: ≤220 characters HARD / 1–2 short sentences — aim under 180; if you are near the cap, cut a clause rather than squeeze. NEVER read a list, multiple feature IDs, or a multi-item status dump in one <say>. When you have more than one fact, lead with the SINGLE most important one and OFFER to continue ("…want the rest?") — put the remainder in a later turn or a card, never in a longer <say>. If you also emit a card this turn, your <say> is ONLY a brief lead-in ("Which one?") — every option, candidate, and detail lives IN the card, NEVER spilled into a second <say>; a second <say> is dead text the user never hears. (2) ONE QUESTION per turn — never stack two. (3) DISAMBIGUATION: when the user is ambiguous and there are ≥2 plausible targets (e.g. "approve the busy one"), do NOT guess or pick one yourself — emit ONE chat_ask_choice card with voiceAnswerable:true listing the candidates (voice users hear the options and speak or click their pick). Disambiguate FIRST: at most 1-2 quick lookups to NAME the candidates, then the card — never sweep every status surface before asking. The card replaces speech — pair it with at most a short lead-in <say> ("Which one?"), NEVER a spoken list of the same options. CALL the chat_ask_choice tool for real — never write the call out as text or a code block in your reply; written-out calls do nothing and the user sees raw code. Even when your lookup identifies ONE clear best candidate for an indirect reference ("the busy one"), confirm it VIA A CARD (your pick as the primary option, the runner-up second) — never via a bare spoken yes/no question; the card is what a voice user can answer hands-free. A plain <say> with no card is acceptable only when the user named the target explicitly and unambiguously. chat_ask_choice supports ≤6 short options. (4) GROUNDED: never state a count or status before the tool result that supports it has come back — call the tool first, then speak the result; never invent a number and silently correct it next turn (if you have not fetched the COMPLETE set, say you are still getting the full count rather than guess a number you will have to revise). Speak ONLY what a tool result literally contains — never embellish with a mechanism, root cause, failure mode, or system/store name you did not read from a result (do NOT explain WHY a bug happens or name the component involved unless a tool result said so). Equally: never name or act on a project, harness, or work item that neither the user nor a tool result has surfaced in this conversation — if you are not sure it exists, look it up first. If a tool call fails or returns nothing, SAY you could not check ("I\'m having trouble reading that right now") — never substitute a guess, and never keep revising your story turn over turn. (5) PLAIN LANGUAGE — say only what a non-engineer can hear and act on. NEVER read aloud: internal jargon or raw IDs (not "F-FMT-002 dash-delimited parsing" / "dig the chunks"), AND code, shell commands, environment-variable names or their literal values, config/file syntax, URLs, or anything backtick-quoted — a voice user hears "heroku config colon set DATABASE underscore URL equals…" as gibberish. When the honest answer needs a literal command, snippet, path, or value, DESCRIBE the step in plain words ("set it in your hosting environment settings") and OFFER to send the exact text in writing ("want the exact command typed in the chat?") — never speak the literal in your <say>. (This is about WORDING, not output shape: it does NOT mean emit a card — keep your normal single-<say> turn.) Say what a thing means ("the formatting fix", "the items waiting on you"), never the symbol itself.'
        : 'You are talking to a user reading the chat sidebar. When you have 2-3 distinct, comparable options, emit chat_ask_choice to render clickable buttons. Otherwise use plain <say> text.'),
  );

  // Per-surface affordances (tui-operator-surface D-003). The persona is the
  // same across desktop and TUI; only the surface-appropriate control tools are
  // injected per turn. On the TUI the web UI is absent, so steer the brain to
  // the pui control surface (tui_dispatch) and away from web-only affordances.
  if (input.surface === 'tui') {
    const clientId = typeof input.uiClientId === 'string' && input.uiClientId.trim()
      ? input.uiClientId.trim()
      : null;
    const clientLine = clientId
      ? `Its \`client_id\` is **${clientId}** — pass that to every tui_dispatch call.`
      : 'Resolve its `client_id` with `tui_list_clients` if you need to target it (usually your turn already carries it).';
    userSections.push(
      `## Surface — terminal workbench (pui)\n\n` +
        `You are speaking through the **pui terminal workbench**, NOT the desktop web UI. ${clientLine}\n\n` +
        `Drive this surface with the \`tui_dispatch\` tool (the TUI analogue of \`ui_dispatch\`). Intents:\n` +
        `- \`open_chat\` ({}) — focus this operator chat pane.\n` +
        `- \`set_tab\` ({tab:"Operator"|"Plans"|"Inbox"|"Sessions"|"Harnesses"|"Docs"|"Activity"|"Testing"|"Config"|"Plugins"|"Settings"|"Fleet"}) — switch the workbench tab; e.g. set_tab "Sessions" or "Fleet" to show the live fleet.\n` +
        `- \`set_harness\` ({slug}) — change the active harness.\n` +
        `- \`select\` ({list, index}) — move a selection within a tab's list.\n` +
        `- \`focus_pane\` ({pane_id}) — focus a worker's zellij pane (pane ids come from \`get_state\`).\n` +
        `- \`get_state\` ({}) — read the workbench state (active tab, selections, counts, live panes).\n\n` +
        `Rules for this surface: (1) prefer \`tui_dispatch\` over \`ui_dispatch\` — the web UI isn't present here. ` +
        `(2) For a yes/no, accept/reject, or pick-one-of decision, CALL \`chat_ask_choice\` — the terminal renders it as an inline card the user answers with arrow/number keys, and the tool returns the pick (same as the desktop). Use plain \`<say>\` text only for open-ended questions. ` +
        `(3) Keep \`<say>\` concise — it renders in a terminal pane.`,
    );
  }

  userSections.push(`## Trigger\n\n${triggerLines[trigger]}`);

  if (mayAskActive) {
    userSections.push(`## [may_ask_active]\n\nThe runtime allows you to ask "Do you want me to go back into active mode?" at the end of your reply this turn — turns_in_last_2_min ≥ 3 AND sleep timer expired. Use only if it fits.`);
  }

  // Closing nudge so the model knows the spec ends and it should act now.
  userSections.push('Respond now per your operator instructions and trigger above.');

  return {
    systemPromptText: systemSections.join('\n\n---\n\n'),
    userPromptText: userSections.join('\n\n---\n\n'),
  };
}

export type { ConverseInput as OperatorConverseInput };
