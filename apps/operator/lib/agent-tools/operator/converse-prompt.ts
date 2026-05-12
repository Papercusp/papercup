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

import { selectHistoryWithinBudget } from '@/lib/operator-converse-history';
import { loadVoicePrefs } from '@/lib/voice-prefs';
import { ALL_AGENT_MCP_TOOLS } from '@/lib/operator-mcp-tools';
import {
  loadRolePersona,
  loadRoleToolsMd,
  loadRoleConverse,
  renderToolsCatalog,
} from '@/lib/prompt-assembly';
import { buildMemoryContextBlock, lastUserContext } from '@/lib/memory/injection';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export interface ConverseInput {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?: 'user_message' | 'silence_after_question' | 'quiet_wait_resume' | 'open_canvas' | 'user_says_ready' | 'user_welcomed';
  welcomed_user?: { display_name?: string };
  mayAskActive?: boolean;
  modality?: 'voice' | 'text';
}

export interface ConverseSessionUser {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

export async function buildOperatorPrompt(
  input: ConverseInput,
  sessionUser: ConverseSessionUser | null,
): Promise<string> {
  const prefs = await loadVoicePrefs().catch(() => null);
  const budget = prefs?.operatorHistoryTokenBudget ?? 40000;
  const messages = selectHistoryWithinBudget(
    (input.messages ?? []).filter(
      (m) => m && typeof m.role === 'string' && typeof m.content === 'string',
    ),
    budget,
  );
  const modality: 'voice' | 'text' = input.modality === 'voice' ? 'voice' : 'text';
  const trigger = input.trigger ?? 'user_message';
  const mayAskActive = !!input.mayAskActive;

  const sections: string[] = [];
  sections.push(loadRoleConverse('operator'));
  sections.push(loadRolePersona('operator'));

  const operatorToolNames: string[] = [];
  for (const fullName of ALL_AGENT_MCP_TOOLS) {
    const stripped = fullName.replace(/^mcp__agentmcp__/, '');
    operatorToolNames.push(stripped);
    if (stripped.includes('_')) {
      operatorToolNames.push(stripped.replace(/_/g, '.'));
    }
  }
  const catalog = renderToolsCatalog('operator', operatorToolNames);
  if (catalog) sections.push(catalog);

  const playbook = loadRoleToolsMd('operator');
  if (playbook) sections.push(playbook);

  // Operator memory pre-turn injection — best-effort, via the shared
  // helper. Same source of truth as architect/brainstorm prompts +
  // operator:delegate (each picks its own user/workspace scope).
  // Falls through silently when mem0 is unavailable.
  const memBlock = await buildMemoryContextBlock({
    userId: sessionUser?.id ?? null,
    workspaceId: activeWorkspaceId(),
    queryContext: lastUserContext(messages, 3),
  });
  if (memBlock) sections.push(memBlock);

  if (messages.length > 0) {
    const transcript = messages
      .map((m) => `[${m.role}]\n${m.content}`)
      .join('\n\n');
    sections.push(`## Conversation history (oldest first; last ${messages.length} turns)\n\n${transcript}`);
  }

  const triggerLines: Record<NonNullable<ConverseInput['trigger']>, string> = {
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

    user_welcomed: `Trigger: user_welcomed — the user just logged in${input.welcomed_user?.display_name ? ` as **${input.welcomed_user.display_name}**` : ''}. Open with a warm, NAMED greeting in your FIRST SENTENCE (e.g. "Welcome back, ${input.welcomed_user?.display_name ?? 'there'}.").

Then deliver substance via the same suggestions flow as user_says_ready: use MCP tools (harness:list / harness:status / issues:list / harness:escalation / harness:pending_reviews) to find what's actionable, emit chat:ask_choice with ≤3 options when you have distinct comparables, or plain <say> with a single concrete suggestion otherwise.

NEVER say "Hi, what can I help with" or any generic greeting — always anchor on a concrete fact + a concrete option.

NOTE: when modality is 'voice', do NOT emit chat:ask_choice — speak the suggestions aloud as a short list instead.`,
  };

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

export type { ConverseInput as OperatorConverseInput };
