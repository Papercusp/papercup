/**
 * carry-surface-provenance-lint — write-time nudge for UNTAGGED owner-attributed
 * imperatives on a carry-surface write (WI-3801, deferred item 3 of EI-9091's fix;
 * items 1/2/4 landed in apps/operator/prompts/papercusp-compaction.base.md's
 * "Directive provenance" section).
 *
 * WHY: EI-9091 root-caused (traced end-to-end on WI-3532) that carry surfaces
 * (work_items:checkpoint, facts:assert, loop:checkpoint, session:request-compaction
 * focus/continueNote) store directives as bare imperatives with no source
 * attribution, so repeated re-summarization drifts an agent's own note-to-self
 * ("do NOT resolve WI-3532 until the UI pass is done") into "the owner said X" —
 * manufacturing a directive (or worse, a PERMISSION) the owner never gave. The doc
 * fix (papercusp-compaction.base.md) instructs agents to tag every directive with
 * its source: `[owner:<name> <date>]` · `[self-imposed]` · `[peer:<sid>]` ·
 * `[inferred]`. THIS module is the tooling backstop: a best-effort, WARN-ONLY
 * heuristic that flags a carry-surface write containing an owner-attributed
 * imperative phrase with NO adjacent source tag, so the writing agent gets a
 * nudge (verify via sessions:search, or tag it) at the moment of write — not
 * seven compactions later when the drift has already compounded.
 *
 * DELIBERATELY WARN, NEVER BLOCK: a false positive on a write-time gate for the
 * exact tool an agent calls to persist critical continuity state (often near a
 * compaction/context limit) would be worse than the drift this catches — a
 * blocked checkpoint write strands MORE state than an untagged one. Every
 * consumer surfaces the result as an advisory field in its response, never a
 * rejected write.
 */

/** The four tagged-source forms the "Directive provenance" convention recognizes. */
const SOURCE_TAG_RE = /\[(?:owner:[^\]]+|self-imposed|peer:[^\]]+|inferred)\]/i;

/** Phrases that attribute a claim/imperative to the owner, or a bare "do not X
 *  until Y" gate/permission imperative — the two shapes EI-9091 found drifting
 *  (a block AND a permission can both be manufactured the same way). Kept to a
 *  short, high-precision set on purpose: a broad/fuzzy match would nudge on
 *  ordinary prose and train agents to ignore the warning. */
const OWNER_ATTRIBUTION_RE =
  /\b(?:the )?owner\s+(?:said|says|wants|needs|requires|required|approved|approves|told me|instructed|directed|asked|demands|set an? (?:explicit )?gate|gave permission)\b/i;
const BARE_GATE_IMPERATIVE_RE = /\bdo not\b.{0,80}\buntil\b/i;

export interface ProvenanceLintMatch {
  /** The offending line, trimmed and capped for display (never the full body). */
  line: string;
  /** Which heuristic matched. */
  kind: 'owner-attribution' | 'bare-gate-imperative';
}

export interface ProvenanceLintResult {
  flagged: boolean;
  matches: ProvenanceLintMatch[];
}

const MAX_MATCH_LINES = 5;
const MATCH_LINE_CAP = 200;

/**
 * Scan `text` line-by-line for an owner-attributed imperative with no source tag
 * ON THAT SAME LINE. Line-scoped (not whole-body) deliberately: a tag elsewhere in
 * a long checkpoint must not mask an untagged imperative on a different line.
 * Pure, synchronous, side-effect-free — safe to call inline on every write.
 */
export function lintCarrySurfaceProvenance(text: string | null | undefined): ProvenanceLintResult {
  if (!text) return { flagged: false, matches: [] };
  const matches: ProvenanceLintMatch[] = [];
  for (const rawLine of text.split('\n')) {
    if (matches.length >= MAX_MATCH_LINES) break;
    const line = rawLine.trim();
    if (!line) continue;
    if (SOURCE_TAG_RE.test(line)) continue; // already tagged on this line — not flagged
    if (OWNER_ATTRIBUTION_RE.test(line)) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'owner-attribution' });
    } else if (BARE_GATE_IMPERATIVE_RE.test(line)) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'bare-gate-imperative' });
    }
  }
  return { flagged: matches.length > 0, matches };
}

/** The advisory note a consumer tool folds into its response when flagged. */
export const PROVENANCE_LINT_NOTE =
  'provenance_lint: untagged owner-attributed imperative(s) detected in this carry-surface write. ' +
  'Tag the source ([owner:<name> <date>] · [self-imposed] · [peer:<sid>] · [inferred]) or verify against ' +
  "the verbatim transcript (sessions:search { session:'self', mode:'verbatim' }) before this is read back as " +
  'an owner directive. See "Directive provenance" (papercusp-compaction.base.md) / WI-3532 / EI-9091.';

/** Convenience: build the `{ flagged, note?, matches? }` shape every consumer
 *  tool folds into its JSON response — `undefined` fields when clean, so a clean
 *  write's response shape is unchanged (no `provenanceLint: { flagged: false }`
 *  noise on the overwhelming common case). */
export function provenanceLintField(text: string | null | undefined):
  | { flagged: true; note: string; matches: ProvenanceLintMatch[] }
  | undefined {
  const result = lintCarrySurfaceProvenance(text);
  if (!result.flagged) return undefined;
  return { flagged: true, note: PROVENANCE_LINT_NOTE, matches: result.matches };
}
