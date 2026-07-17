/**
 * Session transcript → chat-message mapping (owner-inbox-single-pane-2026-07-17
 * P-007) — turns an su/interactive agent's live "thinking" timeline into the
 * `ChatMessage[]` shape `OperatorChat` already renders, with TOOL-NOISE
 * FILTERING: an su transcript is ~90% tool_use/tool_result records, which is
 * unreadable as a "friendly, Papercup-chat-grade" conversation (the owner ask
 * this plan item exists for). This module does NOT re-parse raw transcripts —
 * it reuses the already-built, cross-client (claude/omp/codex), live-followed
 * `TimelineEntry` stream (`/api/adv/session/thinking`,
 * apps/operator/app/harness/AgentThinkingStream.tsx) that already backs
 * AgentInspectorModal's technical/debug view. That view is deliberately raw
 * (cost/tokens/every tool call, for engineers debugging a run); this mapping
 * is the OTHER rendering of the SAME data — collapsed to what an owner wants
 * to read.
 *
 * Filtering rules, per turn (groupEntriesIntoTurns already segments the flat
 * timeline on `prompt` boundaries — one turn = one wake + the agent's response):
 *   - `prompt`      → a user ChatMessage (the owner/wake message that started
 *                     the turn).
 *   - `text`        → joined into the turn's assistant message content (the
 *                     "per-turn final response").
 *   - `tool_use`    → collapsed into a `ChatToolCall` chip (name + input) on
 *                     that same assistant message — OperatorChat already knows
 *                     how to render these compactly (renderOperatorToolChip);
 *                     this is the "collapsed one-line tool summary".
 *   - `tool_result` → DROPPED. This is the actual noise (can be a whole file);
 *                     the paired tool_use chip is enough signal for a chat view
 *                     that isn't debugging the run.
 *   - `status`      → DROPPED (thinking-status chatter, not conversation).
 *   - `result`      → used as a content FALLBACK only when the turn produced
 *                     no `text` entries (covers a client whose only "final
 *                     answer" signal is the turn_end/result record).
 *
 * A turn with neither text nor tool calls produces no assistant message (a
 * pure-status/result-only turn stays invisible — still noise reduction).
 */

import type { ChatMessage, ChatToolCall } from './chat-types';
import { groupEntriesIntoTurns, type TimelineEntry } from '../../harness/AgentThinkingStream';

/**
 * Map a flat live-thinking timeline into chat messages, oldest-first — the
 * order `OperatorChat`/`ChatConversation` expect.
 */
export function sessionTimelineToChatMessages(entries: readonly TimelineEntry[]): ChatMessage[] {
  const turns = groupEntriesIntoTurns(entries);
  const messages: ChatMessage[] = [];

  for (const turn of turns) {
    if (turn.prompt) {
      const promptText = (turn.prompt.text ?? '').trim();
      if (promptText) {
        messages.push({ role: 'user', content: promptText, id: `prompt-${turn.seq}` });
      }
    }

    const textParts: string[] = [];
    const tools: ChatToolCall[] = [];
    let resultText = '';
    for (const e of turn.entries) {
      if (e.kind === 'text') {
        if (e.text) textParts.push(e.text);
      } else if (e.kind === 'tool_use') {
        tools.push({ name: e.toolName ?? 'tool', input: e.toolInput });
      } else if (e.kind === 'result') {
        if (e.text) resultText = e.text;
      }
      // tool_result / status: intentionally dropped — the tool-noise filter.
    }

    const joinedText = textParts.join('\n\n').trim();
    const content = joinedText || resultText.trim();

    if (content || tools.length > 0) {
      messages.push({
        role: 'assistant',
        content,
        ...(tools.length > 0 ? { tools } : {}),
        id: `turn-${turn.seq}`,
      });
    }
  }

  return messages;
}
