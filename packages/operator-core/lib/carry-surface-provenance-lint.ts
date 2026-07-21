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

/** P-014 (deterministic-context-carry): a turn ref `[turn:<session>@<ts>]` is the
 *  VERIFIABLE anchor for a directive — the stamper (carry-surface-provenance-stamp)
 *  resolves it against the writer's own transcript and classifies the referenced
 *  turn owner-vs-agent mechanically. A line carrying one is never lint-flagged. */
const TURN_REF_LINE_RE = /\[turn:[0-9a-f]{4,36}@[0-9T:.+Z-]{10,40}\]/i;

/** A hand-written owner tag with NO turn ref. P-014 retires these as evidence:
 *  the tag asserts, a turn ref proves — and the WI-3532 drift showed asserted
 *  tags survive compaction hops while their truth decays. Warn-only, like all
 *  of this module. */
const OWNER_TAG_RE = /\[owner:[^\]]+\]/i;

/** Phrases that attribute a claim/imperative to the owner, or a bare "do not X
 *  until Y" gate/permission imperative — the two shapes EI-9091 found drifting
 *  (a block AND a permission can both be manufactured the same way). Kept to a
 *  short, high-precision set on purpose: a broad/fuzzy match would nudge on
 *  ordinary prose and train agents to ignore the warning. */
const OWNER_ATTRIBUTION_RE =
  /\b(?:the )?owner\s+(?:said|says|wants|needs|requires|required|approved|approves|told me|instructed|directed|asked|demands|set an? (?:explicit )?gate|gave permission)\b/i;
/**
 * A "do not X until Y" match, but ONLY when it reads as an IMPERATIVE — no
 * expressed subject, the grammatical hallmark of a command — rather than a
 * DECLARATIVE description of some OTHER subject's behavior ("they do not
 * reorder until their lanes ship" is a measurement, not a directive). The
 * negative lookbehind requires "do not" NOT be immediately preceded (past any
 * intervening whitespace) by an alphanumeric character, i.e. by a word acting
 * as an explicit subject: a genuine imperative always opens a sentence/clause
 * (preceded only by punctuation, a list marker, a quote, or nothing at all).
 * EI-16031: found false-positiving on plain technical prose describing a
 * third party's ("they"/"it"/a system noun's) behavior with zero owner
 * attribution — the false alarm trains agents to dismiss the real ones.
 */
const BARE_GATE_IMPERATIVE_RE = /(?<![A-Za-z0-9]\s*)\bdo not\b.{0,80}\buntil\b/i;

/**
 * EI-18226077402946717: a narrated cross-agent / cross-item COORDINATION side-effect
 * stated as already DONE — a communication/handoff or evidence-posting verb in PAST
 * tense (a claim of having performed it, NOT a plan to: a plan uses the base form
 * "post"/"message"/"comment" and is intentionally NOT matched) followed within a short
 * window by a COORDINATION TARGET (a work-item id, a peer session id, a post id, or a
 * named fleet role). This is the exact shape that, when fabricated, silently drops a
 * handoff: a WI-5137 checkpoint claimed "Posted full evidence to WI-5672 (posts
 * 53500-53501) ... Messaged fleet leader su-bce40c51 directly" — NEITHER left any
 * trace in the systems it named, and a successor (or the fleet leader via leader-brief)
 * trusting the narrated action believed evidence was shared / a peer notified when
 * neither occurred. Deliberately NARROW (a comm/post verb AND a coordination target)
 * so ordinary in-file progress prose ("refactored X", "added a test", "committed the
 * fix", "posted the results") never matches — the module's high-precision discipline
 * (a fuzzy match would nudge on routine prose and train agents to ignore the warning).
 * Cleared ONLY by a [turn:<session>@<ts>] ref (the whole line is skipped above): the
 * ONE valid completion anchor is the turn where the action's tool call actually
 * returned ok — the filer's recommendation, made mechanical.
 */
const UNVERIFIED_ACTION_CLAIM_RE =
  /\b(?:posted|messaged|commented|notified|pinged|dispatched|replied|escalated|sent|handed(?:\s+it)?\s+off|reached\s+out|wrote\s+to)\b[^\n]{0,60}?(?:\b(?:WI|EI|F)-\d|\bsu-[0-9a-f]{4}|\bposts?\s*\d|\bfleet\s+leader\b|\bthe\s+leader\b|\bthe\s+queen\b|\bthe\s+fleet\b|\bpeer\b|\bmsg[\s-])/i;

/**
 * An explicit PROVENANCE-block header. An agent complies with the nudge by writing a block
 * like `PROVENANCE: the 'do not widen X until Y' constraint above is [self-imposed] by …` —
 * which necessarily RESTATES the imperative it is attributing so the reader knows WHICH one.
 * That restatement would otherwise re-trip BARE_GATE_IMPERATIVE_RE on the very line carrying
 * the attribution, so compliance could never clear the flag and the act of complying ADDED a
 * violation (EI-10994). When a write carries such an explicit block AND a source tag, we treat
 * its bare gate imperatives as attributed and stop nudging them. Owner-attribution phrases
 * (`the owner said X`) stay LINE-scoped and are never suppressed this way — a factual
 * owner-claim must not be laundered by an unrelated tagged block.
 */
const PROVENANCE_BLOCK_MARKER_RE = /\bprovenance\b/i;

export interface ProvenanceLintMatch {
  /** The offending line, trimmed and capped for display (never the full body). */
  line: string;
  /** Which heuristic matched. 'quote-mismatch' is added asynchronously by
   *  carry-surface-provenance-stamp.ts (EI-12890): a `[turn:…]` ref resolves
   *  to a real, owner-typed turn, but the QUOTE attached to it does not
   *  appear in that turn's actual text — the exact guard-defeat where a
   *  resolvable ref reads as sufficient evidence but the claim was fabricated
   *  by splicing/paraphrasing. This module's own sync scan cannot detect it
   *  (that needs the transcript read the stamp already does); it exists here
   *  purely so the mismatch shows up in the SAME `flagged`/`matches` shape a
   *  consumer already checks, instead of a separate field nobody reads. */
  kind: 'owner-attribution' | 'bare-gate-imperative' | 'manual-owner-tag' | 'quote-mismatch' | 'unverified-action-claim';
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
  const lines = text.split('\n');
  // EI-10994: an explicit, source-tagged PROVENANCE block means the writer HAS attributed
  // their gate imperatives, so complying with the nudge must CLEAR it — not add a second
  // violation on the block's own restatement of the imperative. Suppress bare-gate-imperative
  // matches for the whole write when such a block is present. Owner-attribution stays
  // line-scoped (below): an affirmative "the owner said X" is a factual claim a tagged block
  // must not launder, so it is still flagged per line.
  const hasTaggedProvenanceBlock =
    SOURCE_TAG_RE.test(text) && lines.some((l) => PROVENANCE_BLOCK_MARKER_RE.test(l));
  const matches: ProvenanceLintMatch[] = [];
  for (const rawLine of lines) {
    if (matches.length >= MAX_MATCH_LINES) break;
    const line = rawLine.trim();
    if (!line) continue;
    if (TURN_REF_LINE_RE.test(line)) continue; // turn-ref'd — mechanically verifiable (P-014):
    //   the ONE valid anchor for BOTH a directive AND a completed-action claim.
    // EI-18226077402946717: a narrated coordination side-effect stated as DONE with a
    // coordination target and no turn ref. Runs INDEPENDENTLY of the directive
    // source-tag chain below (a [self-imposed]/[peer:]/[inferred] tag attributes the
    // DIRECTIVE that ordered the action — it does not prove the action happened), so a
    // line can carry both a directive match and this one. Guarded against the cap.
    if (UNVERIFIED_ACTION_CLAIM_RE.test(line)) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'unverified-action-claim' });
      if (matches.length >= MAX_MATCH_LINES) continue;
    }
    if (OWNER_TAG_RE.test(line)) {
      // P-014: a bare [owner:…] tag no longer clears the line — it asserts an
      // owner directive without a verifiable anchor. Nudge for a [turn:…] ref.
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'manual-owner-tag' });
      continue;
    }
    if (SOURCE_TAG_RE.test(line)) continue; // [self-imposed]/[peer:]/[inferred] — not owner-authority
    if (OWNER_ATTRIBUTION_RE.test(line)) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'owner-attribution' });
    } else if (!hasTaggedProvenanceBlock && BARE_GATE_IMPERATIVE_RE.test(line)) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'bare-gate-imperative' });
    }
  }
  return { flagged: matches.length > 0, matches };
}

/** The advisory note a consumer tool folds into its response when flagged. */
export const PROVENANCE_LINT_NOTE =
  'provenance_lint: this carry-surface write contains an owner-attributed directive and/or a claimed COMPLETED ' +
  'action (e.g. "posted evidence to WI-####", "messaged the fleet leader su-…") with no verifiable turn ref. ' +
  'Anchor each to the turn where it ACTUALLY happened with [turn:<session>@<iso-ts>] (the system verifies it ' +
  'against your own transcript and stamps owner-vs-agent origin — P-014); a hand-written [owner:…] tag alone ' +
  'asserts but does not prove. A checkpoint that NARRATES an action ("I did X") is only valid AFTER X\'s tool ' +
  'call returned ok in the SAME turn — a specific artifact id (post/msg/WI ref) is NOT proof it happened ' +
  '(they can be fabricated, EI-18226077402946717), so a downstream reader must independently verify it, never ' +
  'trust it as evidence-of-action. Non-owner sources still tag [self-imposed] · [peer:<sid>] · [inferred]. ' +
  "Verify a remembered directive or action via sessions:search { session:'self', mode:'verbatim' }. " +
  'See WI-3532 / EI-9091 / EI-18226077402946717.';

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
