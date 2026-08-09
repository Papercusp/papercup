/**
 * Shared operative/supersession-clause extraction.
 *
 * Multiple carry surfaces excerpt long verbatim text (a fact body, a held
 * work-item checkpoint) down to a head-only slice to fit a response budget. A
 * head-only slice optimizes for "identify what this is" but discards
 * whatever falls AFTER the cut — and on append-style text, the NEWEST and
 * most-binding content is written last, i.e. exactly what a head-only slice
 * throws away first.
 *
 * Two independent incidents hit the same defect at two different call sites:
 *
 * - facts:list (P-002, knowledge-at-symptom-time-2026-08-09): a fact's
 *   IMPERATIVE was severed mid-word — "ALWAYS cross-read accounts:status"
 *   rendered as "ALWAYS cross-read acco…". The excerpt kept the fact's
 *   evidence (re-derivable) and discarded its instruction (the only part
 *   that changes behaviour).
 * - the carry-brief held-item checkpoint render (EI-19952485326105760): a
 *   checkpoint held an older plan followed by a LATER, SUPERSEDING owner
 *   directive that revoked it. The truncation cut landed between the two, so
 *   the successor's context inherited the superseded plan with no trace of
 *   what revoked it — the same head-only-slice defect, applied to a
 *   directive instead of an instruction.
 *
 * `extractOperativeClauses` is the one fix for both: pull any clause
 * matching an operative/supersession MARKER out of the FULL body (not just
 * the head) and let the caller append it verbatim, bounded by its own small
 * budget so this can never blow out the response the excerpt exists to
 * shrink.
 */

/** Total char budget across all preserved clauses, when the caller doesn't override it. */
export const OPERATIVE_CLAUSE_CHARS_DEFAULT = 220;
/** Max number of clauses preserved, when the caller doesn't override it. */
export const OPERATIVE_CLAUSE_MAX_CLAUSES_DEFAULT = 2;

/**
 * Shapes this corpus uses when a line is telling the reader to do (or stop
 * doing) something, or is REVOKING a prior instruction. Case-sensitive on
 * the shouted words on purpose — authors upper-case these deliberately, and
 * matching case-insensitively would drag in ordinary prose ("we must have
 * missed it") and spend the whole budget on narration. `⛔` / `SUPERSEDING` /
 * `SUPERSEDED` / `NO MORE` and an inline `[owner:...]` tag are the
 * supersession shapes `carry-surface-provenance-lint.ts` already recognizes
 * (its `OWNER_TAG_RE`) — a clause carrying one of these is, by construction,
 * the thing most likely to revoke an earlier plan sitting earlier in the
 * same body.
 *
 * ⚠ The owner-tag alternative is DELIBERATELY WIDER than `OWNER_TAG_RE`, which
 * matches `[owner:` only. Measured 2026-08-09 over the population that actually
 * feeds this function — `harness_shared.work_items.payload`, where checkpoints
 * live — 43 of 50 tag-bearing rows use `[owner:` but 6 use a SPACE
 * (`[owner 2026-08-09]`). Colon-only therefore drops ~12% of real owner tags
 * past a cut, which is precisely the class EI-19952485326105760 is about: the
 * heading matches on `⛔` and survives, while the line carrying the owner's
 * actual WORDS does not, so the reader is told a directive exists and never
 * told what it says. Widening only ever preserves MORE, so it cannot cause the
 * inverse failure. (`OWNER_TAG_RE` itself still has this gap — filed
 * separately; it is a lint-detection question, not a preservation one.)
 * Note a source-tree grep suggests the opposite ratio (89 space / 81 colon) —
 * that corpus is comments and prompts, NOT checkpoints. Measure the population
 * the code actually reads.
 */
export const OPERATIVE_MARKERS =
  /\b(ALWAYS|NEVER|MUST|DO NOT|DON'T|REQUIRED|RULE:|NO MORE)\b|⛔|SUPERSED(?:ING|ED)|\[owner[:\s][^\]]*\]/;

export interface ExtractOperativeClausesOptions {
  /** Total char budget across all preserved clauses. */
  maxChars?: number;
  /** Max number of clauses to preserve. */
  maxClauses?: number;
}

/**
 * Pull the operative/supersession clauses out of `body` that are not already
 * visible in `head`. Returns clauses that begin AT the marker (not the whole
 * sentence — the lead-in is usually evidence the head already carries) and
 * run to the end of their sentence/line, skipping any already visible in
 * `head` (no point spending budget repeating what the reader can see),
 * bounded by both a clause count and a total char budget so a pathological
 * body cannot blow the response. Pure and directly testable — no I/O.
 */
export function extractOperativeClauses(
  body: string,
  head: string,
  opts: ExtractOperativeClausesOptions = {},
): string[] {
  const maxChars = opts.maxChars ?? OPERATIVE_CLAUSE_CHARS_DEFAULT;
  const maxClauses = opts.maxClauses ?? OPERATIVE_CLAUSE_MAX_CLAUSES_DEFAULT;
  const out: string[] = [];
  let spent = 0;
  // Split on sentence ends AND newlines — these bodies are frequently
  // bulleted/blocked, where a "sentence" never terminates in punctuation at all.
  for (const rawSentence of body.split(/(?<=[.!?])\s+|\n+/)) {
    if (out.length >= maxClauses || spent >= maxChars) break;
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    const m = OPERATIVE_MARKERS.exec(sentence);
    if (!m) continue;
    // Start AT the marker, not at the sentence start — the lead-in is
    // usually the evidence the head already carried.
    const clause = sentence.slice(m.index).trim();
    // Already legible in the excerpt head ⇒ spend nothing on it.
    if (head.includes(clause)) continue;
    const room = maxChars - spent;
    const kept = clause.length > room ? `${clause.slice(0, Math.max(0, room - 1))}…` : clause;
    if (!kept || kept === '…') break;
    out.push(kept);
    spent += kept.length;
  }
  return out;
}

/**
 * Cap `s` to `max` chars, but — unlike a plain head-only slice — never let
 * the cut discard an operative/supersession clause: any such clause found
 * past the cut is appended verbatim after a `⚠ OPERATIVE:` marker. Shared
 * excerpt shape for any carry surface that truncates long verbatim text.
 */
export function capPreservingOperative(
  s: string,
  max: number,
  opts?: ExtractOperativeClausesOptions,
): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, Math.max(0, max - 1));
  const operative = extractOperativeClauses(t, head, opts);
  return operative.length ? `${head}… ⚠ OPERATIVE: ${operative.join(' ')}` : `${head}…`;
}
