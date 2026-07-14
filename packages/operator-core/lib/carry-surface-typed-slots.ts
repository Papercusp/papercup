/**
 * carry-surface-typed-slots — owner-blocking QUESTIONS must be coord:ask-owner
 * records, not carry-surface prose (deterministic-context-carry-2026-07-14
 * P-015, plan D-003 "tracking is system-owned").
 *
 * WHY: an owner-blocking question written as checkpoint/fact/carry-note prose
 * ("waiting on the owner to decide X") is a commitment that only survives as
 * long as the prose does — compaction re-summarization dissolves it, and no
 * system surface (owner inbox, walls, escalations) ever hears about it, so the
 * owner is never actually asked and a successor can't tell whether the question
 * was ever posed. The TYPED slot for this is `coord:ask-owner` — it opens a
 * durable question thread, lands in the human inbox, and returns a
 * `conversation_id`. A carry surface then CITES the record with an ask ref:
 *
 *   [ask:<conversation_id>]
 *
 * (For a standing owner-gated commitment that is not a question — "capital
 * arming is owner-walled" — the typed slot is `loop:checkpoint { walls }`,
 * which re-renders into every wake until cleared.)
 *
 * THIS module is the write-time detector: a WARN-ONLY, line-scoped lint that
 * flags owner-question-shaped prose with no [ask:…] ref on the same line. Same
 * contract as ./carry-surface-provenance-lint.ts (never block a carry write —
 * a blocked checkpoint strands more state than an untyped question), same
 * high-precision-over-recall pattern discipline (a broad match trains agents
 * to ignore the nudge). Enforcement is P-016's job.
 */

/** An ask ref citing a coord:ask-owner record (its `conversation_id`). A line
 *  carrying one has its question IN the typed slot — never flagged. */
export const ASK_REF_RE = /\[ask:[a-z0-9][a-z0-9_-]{3,63}\]/i;

/** A loop-wall row rendered back into prose carries this marker — the walls
 *  slot is ALSO typed (loop:checkpoint { walls }), so its rendering clears. */
const WALL_MARKER_RE = /\bOWNER-WALL\b|\[wall\]/i;

/**
 * Owner-blocking-question shapes. Two families, kept deliberately narrow:
 *  - directed ask: "ask the owner", "question for the owner", "ask the human";
 *  - blocked-on-answer: "waiting on the owner", "blocked on owner input",
 *    "needs the owner's decision/approval/go".
 * Plain mentions of the owner ("the owner said X" — provenance lint's beat) or
 * of owner-walled facts with the wall marker do not match.
 */
const OWNER_QUESTION_RES: RegExp[] = [
  /\b(?:ask|asking|need(?:s)? to ask|should ask|must ask)\s+(?:the\s+)?(?:owner|human)\b/i,
  /\bquestion\s+for\s+(?:the\s+)?(?:owner|human)\b/i,
  /\b(?:waiting|waits?|blocked|pending|holding|held)\s+(?:on|for)\s+(?:the\s+)?owner(?:'s)?\s*(?:input|answer|decision|confirmation|approval|response|reply|ruling|go|sign-?off)?\b/i,
  /\bneeds?\s+(?:the\s+)?owner(?:'s)?\s+(?:input|answer|decision|confirmation|approval|response|reply|ruling|go|sign-?off)\b/i,
  /\bowner\s+(?:to\s+)?(?:decide|confirm|answer|approve|weigh in|choose)\b/i,
];

export interface TypedSlotLintMatch {
  /** The offending line, trimmed and capped for display. */
  line: string;
  kind: 'owner-question-prose';
}

export interface TypedSlotLintResult {
  flagged: boolean;
  matches: TypedSlotLintMatch[];
}

const MAX_MATCH_LINES = 5;
const MATCH_LINE_CAP = 200;

/**
 * Scan `text` line-by-line for owner-blocking-question prose with no [ask:…]
 * ref (and no wall marker) on that same line. Line-scoped for the same reason
 * the provenance lint is: an ask ref elsewhere in a long checkpoint must not
 * mask a different, never-asked question. Pure, synchronous, side-effect-free.
 */
export function lintOwnerQuestionSlots(text: string | null | undefined): TypedSlotLintResult {
  if (!text) return { flagged: false, matches: [] };
  const matches: TypedSlotLintMatch[] = [];
  for (const rawLine of text.split('\n')) {
    if (matches.length >= MAX_MATCH_LINES) break;
    const line = rawLine.trim();
    if (!line) continue;
    if (ASK_REF_RE.test(line)) continue; // the question IS a typed record
    if (WALL_MARKER_RE.test(line)) continue; // the walls slot is the typed form
    if (OWNER_QUESTION_RES.some((re) => re.test(line))) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'owner-question-prose' });
    }
  }
  return { flagged: matches.length > 0, matches };
}

/** The advisory note a consumer folds into its response when flagged. */
export const OWNER_QUESTION_SLOT_NOTE =
  'typed_slot: owner-blocking question written as carry-surface prose. Prose dissolves under compaction and ' +
  'never reaches the owner — open it as a typed record instead: coord:ask-owner { question } (opens a question ' +
  'thread + lands in the human inbox, returns conversation_id), then cite it here as [ask:<conversation_id>]. ' +
  'A standing owner-gated commitment that is not a question belongs in loop:checkpoint { walls } (re-rendered ' +
  'into every wake until cleared). deterministic-context-carry P-015.';

/** Convenience: the `{ flagged, note, matches }` response field — undefined on
 *  the clean case, mirroring provenanceLintField's contract. */
export function ownerQuestionSlotField(text: string | null | undefined):
  | { flagged: true; note: string; matches: TypedSlotLintMatch[] }
  | undefined {
  const result = lintOwnerQuestionSlots(text);
  if (!result.flagged) return undefined;
  return { flagged: true, note: OWNER_QUESTION_SLOT_NOTE, matches: result.matches };
}
