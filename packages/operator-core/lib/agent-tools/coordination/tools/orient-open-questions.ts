/**
 * orient-open-questions.ts — the coord:orient OPEN-QUESTIONS fold
 * (WI-5807 / P-007 of surface-every-routine-and-unbreak-automation-panes-2026-07-25).
 *
 * WHY THIS EXISTS — the measured finding, so it is not "simplified" back out:
 * `coord:ask` fans a question out to TOPIC subscribers. Measured 2026-07-25:
 * there are ZERO live topic subscriptions in the entire workspace. 30 distinct
 * topics were used by open questions; not one has a single subscriber. The proof
 * row: 13 open questions WERE correctly topic-tagged and still sat at exactly one
 * subscriber (the asker alone) with a 100% zero-reply rate. Doing it RIGHT reached
 * nobody. Workspace-wide the result is 39 open questions, every one of them with
 * zero replies, the oldest from 2026-06-06.
 *
 * So the PUSH half of Q&A is structurally dead. The fix is deliberately NOT another
 * opt-in subscription mechanism — the existing one having zero uptake IS the finding,
 * and a second one would inherit the same zero. Instead questions get a PULL surface:
 * agents meet the open ones on WAKE, on the read they already make, with no
 * subscription to remember and nothing to opt into.
 *
 * Reuse-first: this is one more fold on coord:orient (which already folds inbox +
 * assignments + claimable + recall) reading through the EXISTING conversations:list
 * tool, not a new surface. Cost discipline matches the other full-mode legs:
 * skipped entirely on a monitor tick, capped tiny, and fail-soft.
 */

/** How many open questions the fold shows. Deliberately tiny — orient is the
 *  hottest read in the system and this is a nudge, not a queue. */
export const OPEN_QUESTIONS_CAP = 3;

/** Questions older than this are NOT surfaced. Without a cliff the same three
 *  never-answered questions would ride every agent's every wake forever and
 *  become wallpaper; with it, a question nobody answered in a month ages out on
 *  its own instead of needing a reaper. */
export const OPEN_QUESTIONS_MAX_AGE_DAYS = 30;

/** The shape conversations:list returns (only the fields this fold reads). */
export interface OpenQuestionRow {
  id?: unknown;
  title?: unknown;
  asker_id?: unknown;
  harness_slug?: unknown;
  topics?: unknown;
  created_ts?: unknown;
}

/** One surfaced question — compact by construction (orient pays for every field). */
export interface OpenQuestionEntry {
  id: string;
  title: string;
  asker: string;
  ageDays: number;
  harness?: string;
}

export interface OpenQuestionsFold {
  /** How many open, unanswered, in-window questions exist for this caller —
   *  NOT `questions.length`, which is capped. The honest total. */
  count: number;
  /** The newest few, most recent first (≤ OPEN_QUESTIONS_CAP). */
  questions: OpenQuestionEntry[];
  /** What to do about them. */
  hint: string;
}

const TITLE_CAP = 120;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * PURE: shape the conversations:list page into the fold.
 *
 * Filters applied here rather than in SQL because they are caller-relative or
 * cheap-in-memory: (a) drop the caller's OWN questions — an agent does not need
 * to be told about the question it asked, and its own unanswered question is
 * already reported to it by coord:ask's hint; (b) drop anything older than
 * OPEN_QUESTIONS_MAX_AGE_DAYS. The state/kind/unanswered/harness filtering is
 * the store's job and is assumed already applied by the caller.
 *
 * Returns null when nothing survives — the fold is then ABSENT from the orient
 * result entirely rather than present-and-empty, so the common case costs zero
 * tokens (this fires on most wakes: an answered-out workspace is the goal).
 */
export function shapeOpenQuestions(
  rows: readonly OpenQuestionRow[],
  opts: { selfOwnerId?: string; nowMs?: number; cap?: number; maxAgeDays?: number } = {},
): OpenQuestionsFold | null {
  const nowMs = opts.nowMs ?? Date.now();
  const cap = opts.cap ?? OPEN_QUESTIONS_CAP;
  const maxAgeDays = opts.maxAgeDays ?? OPEN_QUESTIONS_MAX_AGE_DAYS;
  const self = opts.selfOwnerId?.trim();

  const entries: OpenQuestionEntry[] = [];
  for (const r of rows ?? []) {
    const id = str(r.id);
    if (!id) continue;
    const asker = str(r.asker_id) ?? 'unknown';
    if (self && asker === self) continue;
    const createdMs = Date.parse(String(r.created_ts ?? ''));
    if (!Number.isFinite(createdMs)) continue;
    const ageDays = Math.floor((nowMs - createdMs) / 86_400_000);
    if (ageDays > maxAgeDays) continue;
    const harness = str(r.harness_slug);
    entries.push({
      id,
      title: (str(r.title) ?? '(untitled)').slice(0, TITLE_CAP),
      asker,
      ageDays: Math.max(0, ageDays),
      ...(harness ? { harness } : {}),
    });
  }
  if (entries.length === 0) return null;

  // conversations:list already orders newest-first, but this fold must not
  // depend on a caller's ordering to stay correct under a re-limit.
  entries.sort((a, b) => a.ageDays - b.ageDays);

  return {
    count: entries.length,
    questions: entries.slice(0, cap),
    hint:
      `${entries.length} open question${entries.length === 1 ? '' : 's'} in this workspace ` +
      'has gone UNANSWERED (nobody replied). Topic push reaches nobody — there are no topic ' +
      'subscribers — so these only get answered if someone pulls them here. If you know an ' +
      'answer, conversations:answer { id, body } — it costs you a minute and unblocks the asker. ' +
      'conversations:list { kind:"question", state:"open", unansweredOnly:true } for the rest.',
  };
}
