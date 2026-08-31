/**
 * Session turn index (chat-popup-turn-rail-2026-08-31 P-001) — the pure
 * derivation behind the conversation popup's TURN RAIL.
 *
 * [owner 2026-08-31] "In our hud tab->sessions tab-> conversation popups its
 * inceedibly annoying to have to scroll up to see prior turns... a turn sidebar
 * on the left, that shows a preview of the users questions, and then you click
 * and it scrolls to the answer(past all the tool calls etc)."
 *
 * A turn in this file is exactly what the reader means by one: a question and
 * everything that came back because of it. It is derived from the ALREADY
 * RENDERED `ChatMessage[]` — not from the raw timeline — for two reasons:
 *
 *   1. The rail must index what is actually on screen. `session-transcript-mapping`
 *      collapses tool_use into chips and DROPS tool_result/status entirely, and
 *      `mergeSentEchoes` / `mergeConversationProjectionMessages` then append and
 *      interleave more. An index built one layer upstream would address messages
 *      that are not in the list the reader is scrolling.
 *   2. It makes the rail work for any feed shaped like a conversation, not only
 *      the live session stream.
 *
 * ── What a row can honestly say, and what it cannot ─────────────────────────
 * Measured before designing the row (D-006): `ChatToolCall` is `{ name, input?,
 * answered? }` and `TimelineEntry` carries no error field on `tool_result` —
 * which the mapper drops anyway. So there is NO per-turn failure signal in this
 * data, and a red "something went wrong" pip on a rail row would be invented,
 * not derived. It is deliberately absent. What IS real: the question text, its
 * timestamp, the number of tool chips collapsed into the answer, the elapsed
 * time between question and answer when the feed stamps both, and whether the
 * turn has an answer at all.
 */
import type { ChatMessage } from './chat-types';

export interface SessionTurn {
  /** 1-based, as the reader counts them. Stable for a given message array. */
  turn: number;
  /** Index of the user message that opened this turn. */
  questionIndex: number;
  /**
   * Index of the message a rail click should land on: the turn's ANSWER.
   *
   * Null when the turn has no answer yet — a still-streaming final turn, or two
   * user messages in a row. The rail renders that state rather than pretending,
   * and `jumpIndex` below falls back to the question so a click is never inert.
   */
  answerIndex: number | null;
  /**
   * Where a click actually goes: `answerIndex` when there is one, else
   * `questionIndex`. Callers should use THIS rather than re-deriving the
   * fallback — landing on the question of an unanswered turn is correct, and is
   * the only case where the rail does not skip the tool chips (there are none
   * to skip yet).
   */
  jumpIndex: number;
  /** The question, trimmed. May be empty — a feed can carry an empty prompt. */
  question: string;
  /** ISO instant of the question, when the feed knows it (`ChatMessage.ts`). */
  askedAt: string | null;
  /** ISO instant of the answer, when known. */
  answeredAt: string | null;
  /**
   * Wall time between question and answer, when BOTH carry a stamp. Null
   * otherwise — never a zero, which would read as an instant reply.
   */
  durationMs: number | null;
  /** Tool chips collapsed into this turn, summed across its assistant messages. */
  toolCount: number;
  /** First message index this turn owns (always `questionIndex`). */
  firstIndex: number;
  /** Last message index this turn owns, inclusive. */
  lastIndex: number;
}

/** A non-empty assistant message is one with text OR a structured report card. */
function isAnswer(m: ChatMessage): boolean {
  return m.role === 'assistant' && (m.content.trim().length > 0 || m.report != null);
}

function parseMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Split a rendered conversation into turns, oldest first.
 *
 * A turn opens on each `role === 'user'` message and runs until the next one.
 * Messages BEFORE the first user message (a transcript that opens with the
 * agent's own text, or a projection row) belong to no turn — they are not an
 * answer to anything, and inventing a turn 0 for them would put a row in the
 * rail with no question to preview.
 */
export function deriveSessionTurns(messages: readonly ChatMessage[]): SessionTurn[] {
  const turns: SessionTurn[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== 'user') continue;

    // Everything up to the next user message, or the end.
    let end = messages.length - 1;
    for (let j = i + 1; j < messages.length; j += 1) {
      if (messages[j].role === 'user') {
        end = j - 1;
        break;
      }
    }

    /* The LAST non-empty assistant message in the range, not the first: a turn
       can emit several (a projection row, an echo, then the real reply), and
       the one the reader is looking for is the final response. */
    let answerIndex: number | null = null;
    let toolCount = 0;
    for (let j = i + 1; j <= end; j += 1) {
      const m = messages[j];
      if (m.role === 'assistant') {
        toolCount += m.tools?.length ?? 0;
        if (isAnswer(m)) answerIndex = j;
      }
    }

    const askedAt = messages[i].ts ?? null;
    const answeredAt = answerIndex == null ? null : (messages[answerIndex].ts ?? null);
    const askedMs = parseMs(askedAt);
    const answeredMs = parseMs(answeredAt);

    turns.push({
      turn: turns.length + 1,
      questionIndex: i,
      answerIndex,
      jumpIndex: answerIndex ?? i,
      question: messages[i].content.trim(),
      askedAt,
      answeredAt,
      durationMs:
        askedMs != null && answeredMs != null && answeredMs >= askedMs ? answeredMs - askedMs : null,
      toolCount,
      firstIndex: i,
      lastIndex: end,
    });

    i = end;
  }

  return turns;
}

/**
 * Which turn owns a given message index — the reverse binding that turns the
 * rail from a menu into a position indicator (P-005).
 *
 * Returns the turn's position in the array (0-based), or -1 when the index sits
 * before the first question or outside the conversation entirely. -1 is a real
 * answer, not a failure: it means "the reader is above the first turn", and the
 * rail should mark nothing live rather than guess at row 0.
 */
export function turnAtMessageIndex(turns: readonly SessionTurn[], messageIndex: number): number {
  if (messageIndex < 0) return -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (messageIndex >= turns[i].firstIndex) {
      return messageIndex <= turns[i].lastIndex ? i : -1;
    }
  }
  return -1;
}

/**
 * Relative size of each turn, 0..1, for the spine density's tick heights
 * (D-003). Scaled against the LARGEST turn in the session rather than an
 * absolute message count, so the shape of the session is legible whether it is
 * seven short turns or one enormous one.
 *
 * Sized by MESSAGE SPAN, not tool count: the tick is a minimap of the scroll
 * the reader is navigating, and what makes a turn long to scroll past is how
 * much transcript it occupies.
 */
export function turnSizeRatios(turns: readonly SessionTurn[]): number[] {
  const spans = turns.map((t) => t.lastIndex - t.firstIndex + 1);
  const max = Math.max(1, ...spans);
  return spans.map((s) => s / max);
}
