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

/** The four tagged-source forms the "Directive provenance" convention recognizes.
 *  The owner alternative accepts the same near-miss separator shapes as
 *  {@link OWNER_TAG_RE} (defined below) — kept as a literal here rather than an
 *  interpolated reference so this declaration doesn't have to move below its
 *  dependency; the two are asserted in sync by the module's own tests. */
const SOURCE_TAG_RE = /\[(?:\bowner\b\s*[:=\-]?\s*[^\]]+|self-imposed|peer:[^\]]+|inferred)\]/i;

/** P-014 (deterministic-context-carry): a turn ref `[turn:<session>@<ts>]` is the
 *  VERIFIABLE anchor for a directive — the stamper (carry-surface-provenance-stamp)
 *  resolves it against the writer's own transcript and classifies the referenced
 *  turn owner-vs-agent mechanically. A line carrying one is never lint-flagged. */
const TURN_REF_LINE_RE = /\[turn:[0-9a-f]{4,36}@[0-9T:.+Z-]{10,40}\]/i;

/**
 * EI-19988211953593959: the separator between the `owner` keyword and the tag's
 * content, matched permissively — colon (the documented form) plus the near-miss
 * shapes an agent actually types under compaction pressure (space, `=`, `-`). Every
 * detector below (detection, backtick-quoting, placeholder, mention-context) is
 * anchored on this SAME fragment so a near-miss shape is SEEN by the whole module —
 * at worst downgraded to `possible-owner-tag-mention` — instead of being invisible
 * to detection, quoting, AND mention-context alike (the prior colon-only anchor made
 * the gap module-wide, per this ticket). `\bowner\b` (not a bare `owner`) so this
 * never matches inside an unrelated word like "ownership".
 */
const OWNER_TAG_SEP = '\\bowner\\b\\s*[:=\\-]?\\s*';

/** A hand-written owner tag with NO turn ref. P-014 retires these as evidence:
 *  the tag asserts, a turn ref proves — and the WI-3532 drift showed asserted
 *  tags survive compaction hops while their truth decays. Warn-only, like all
 *  of this module. Widened (EI-19988211953593959) to see colon/space/equals/dash
 *  separator shapes, not just the literal colon — see {@link OWNER_TAG_SEP}. */
const OWNER_TAG_RE = new RegExp(`\\[\\s*${OWNER_TAG_SEP}[^\\]]+\\]`, 'i');

/**
 * EI-18672153930631150: `OWNER_TAG_RE` matches the literal token `[owner:` with
 * no regard for whether the surrounding text is USING the tag (attributing a
 * real directive) or MENTIONING it (documenting/comparing the convention's own
 * syntax — exactly what a doc, a test fixture, or a checkpoint ABOUT this lint
 * has to write). Two tiers of cheap, line-scoped anchors recover that
 * distinction without touching the tag-detection regex itself (which must
 * keep matching every real tag, including ones this module has never seen
 * before):
 *
 *  DEFINITE quoting — a backtick-fenced `` `[owner:...]` `` — never flags at
 *  all. This repo's actual convention is written BARE in prose (per root
 *  CLAUDE.md's own worked example), never as inline code, so a backtick-
 *  wrapped occurrence is how you quote a syntax you are talking ABOUT, not
 *  how you invoke it. (Only same-line inline-code is handled; a multi-line
 *  fenced ``` block is out of scope for this line-scoped scanner.)
 *
 *  AMBIGUOUS mention — downgraded to `possible-owner-tag-mention` (kept
 *  VISIBLE, per the filed suggestion, but out of the loud `manual-owner-tag`
 *  category so that category stays rare and keeps its meaning) — when either:
 *   - PLACEHOLDER content: a real use always names an actual owner (e.g.
 *     `[owner:Jane 2026-07-14]`); a mention illustrating the *form* almost
 *     always uses a generic stand-in (`[owner:Name]`, `[owner:<name>]`,
 *     `[owner:foo]`, `[owner:...]`), or
 *   - MENTION-CONTEXT words within a short window before the tag (`form`,
 *     `convention`, `pattern`, `syntax`, `example`, `e.g.`, `->`) — the
 *     grammatical company a citation of the syntax keeps, per the filed
 *     repro ("the detector matches the bracket form [owner:Name] ...").
 *
 * A tag naming a real owner with no such context — e.g.
 * `[owner:jane 2026-07-10]` — is untouched and still flags `manual-owner-tag`
 * exactly as before.
 */
// EI-18762822878138952: the repo's own documented tag SHAPE — e.g. `[owner:<name> <date>]`,
// written out verbatim in root CLAUDE.md's "Directive provenance" convention and reused by
// every agent that documents/implements it — chains TWO placeholder tokens ("<name>" then
// "<date>") separated by whitespace. The single-alternative form below only ever matched ONE
// token before the closing bracket, so that exact canonical example fell through to the loud
// `manual-owner-tag` category instead of being recognized as a placeholder mention. Allow one
// or more whitespace-separated placeholder tokens (each still restricted to the same known
// stand-ins) so a chained placeholder still reads as a placeholder, not a real attribution.
const OWNER_TAG_PLACEHOLDER_TOKEN = '(?:name|someone|tbd|foo|bar|x|<[^>]+>|\\.{3}|…)';
// EI-19988211953593959: anchored on the same OWNER_TAG_SEP fragment as OWNER_TAG_RE
// (colon/space/equals/dash) so a placeholder written in a near-miss shape — e.g.
// `[owner Name]` — still downgrades to possible-owner-tag-mention instead of being
// invisible to every tier the way it was under the colon-only anchor.
const OWNER_TAG_PLACEHOLDER_RE = new RegExp(
  `\\[\\s*${OWNER_TAG_SEP}${OWNER_TAG_PLACEHOLDER_TOKEN}(?:\\s+${OWNER_TAG_PLACEHOLDER_TOKEN})*\\s*\\]`,
  'i',
);
const BACKTICK_WRAPPED_OWNER_TAG_RE = new RegExp(`\`\\[\\s*${OWNER_TAG_SEP}[^\\]]*\\]\``, 'i');
const OWNER_TAG_MENTION_CONTEXT_RE = new RegExp(
  `(?:\\bforms?\\b|\\bconvention\\b|\\bpatterns?\\b|\\bsyntax\\b|\\bexamples?\\b|\\be\\.g\\.,?|->)[^[]{0,30}\\[\\s*\\bowner\\b`,
  'i',
);

/**
 * EI-19461711239876849: the module flagged `manual-owner-tag` on a line whose whole
 * purpose was to REFUSE an owner attribution and downgrade it — i.e. it penalised the
 * exact correction the convention exists to elicit. An agent that learns "writing
 * [owner:…] trips a lint" is nudged toward silently DROPPING an unverifiable
 * attribution rather than documenting that it is unverifiable, which re-creates the
 * WI-3532 telephone game from the other end.
 *
 * A withdrawal is recognized CONJUNCTIVELY — both halves required:
 *   1. a DOWNGRADE tag ([self-imposed] · [peer:…] · [inferred]) on the line, which a
 *      correctly-retracted attribution always carries (it must say what the source
 *      actually was), and
 *   2. an explicit NEGATION of owner authority nearby — "NOT as [owner:…]", "NOT an
 *      owner directive", "not a quoted owner turn", "could not verify it against an
 *      owner turn", "NOT anchored to an OWNER-stamped turn".
 *
 * The conjunction is what makes it safe, and it is MEASURED, not assumed. Corpus:
 * the 251 distinct carry-surface lines in this workspace's stored history
 * (harness_shared.carry_notes + agent_facts) carrying an owner-authority shape, of
 * which 222 flagged `manual-owner-tag` before this rule:
 *   - this rule reclassifies 17, and all 17 are genuine retractions / self-
 *     attributions ("[self-imposed gate — not an owner directive]", the PROVENANCE
 *     CORRECTION blocks the convention asks for);
 *   - every real ASSERTED owner attribution still flags.
 *
 * ⚠ The filed suggestion — "skip when a [peer:]/[self-imposed]/[inferred] tag appears
 * in the same sentence" — was measured against that corpus and REJECTED. The downgrade
 * tag ALONE suppresses 22, and 4 of the 5 extra are REAL owner attributions it would
 * silently launder: a verbatim relayed ask ("relayed VERBATIM by [peer:…] … treat as
 * owner-sourced: [owner:…]"), a dated pause directive, a plan reactivation, and an
 * owner DEMAND for GUI verification. Negation ALONE is worse in the other direction
 * (34). Requiring BOTH is what separates a retraction from an assertion that merely
 * happens to cite a peer alongside it — which is exactly what a relay looks like.
 */
const OWNER_TAG_DOWNGRADE_TAG_RE = /\[(?:self-imposed|peer:|inferred)\b[^\]]*\]/i;
/** An owner-AUTHORITY reference: the bracket tag, or "owner" as an authority noun. */
const OWNER_AUTHORITY_REF =
  '(?:\\[owner:|\\bowner(?:[-\\s](?:directive|mandate|turn|tag|stamped|sourced|typed|authoriz\\w*)\\b|\\b))';
/** A negator governing an owner-authority reference within one clause (no sentence
 *  boundary crossed, short window) — "NOT as [owner:…]", "NOT an owner directive". */
const NEGATED_OWNER_AUTHORITY_RE = new RegExp(
  `(?:\\bnot\\b|\\bnever\\b|n't\\b|\\bcannot\\b)[^.!?\\n]{0,40}?${OWNER_AUTHORITY_REF}`,
  'i',
);

/**
 * A line that RETRACTS an owner attribution rather than asserting one. Applies to both
 * the bracket tag and the `owner directive|mandate` noun phrase — a retraction is
 * written in whichever form the thing being retracted used.
 */
function isProvenanceWithdrawal(line: string): boolean {
  return OWNER_TAG_DOWNGRADE_TAG_RE.test(line) && NEGATED_OWNER_AUTHORITY_RE.test(line);
}

/** Definite quoting of the tag's syntax — never flag, not even as a mention. */
function isOwnerTagQuotedForm(line: string): boolean {
  return BACKTICK_WRAPPED_OWNER_TAG_RE.test(line);
}

/** Ambiguous — likely documenting/comparing the form, not attributing. */
function isOwnerTagPossibleMention(line: string): boolean {
  return OWNER_TAG_PLACEHOLDER_RE.test(line) || OWNER_TAG_MENTION_CONTEXT_RE.test(line);
}

/** Phrases that attribute a claim/imperative to the owner, or a bare "do not X
 *  until Y" gate/permission imperative — the two shapes EI-9091 found drifting
 *  (a block AND a permission can both be manufactured the same way). Kept to a
 *  short, high-precision set on purpose: a broad/fuzzy match would nudge on
 *  ordinary prose and train agents to ignore the warning. */
const OWNER_ATTRIBUTION_RE =
  /\b(?:the )?owner\s+(?:said|says|wants|needs|requires|required|approved|approves|told me|instructed|directed|asked|demands|set an? (?:explicit )?gate|gave permission)\b/i;
/**
 * EI-19393929983792049: a bare NOUN-PHRASE attribution — "owner directive 1: …",
 * "Directive 2 (…): …" re-emitted from a loop goal, "owner mandate: …" — asserts the
 * exact same authority as a hand-written `[owner:…]` tag or an `OWNER_ATTRIBUTION_RE`
 * verb phrase, but slips past BOTH: it names no verb from that list ("directive" is a
 * noun, not "directed"), and it carries no `[owner:` bracket at all. Measured live: the
 * filer's own self-compaction turn wrote "start owner directive 1: the READ-ONLY P-011
 * audit … Directive 2 … comes after" — an AGENT-authored line asserting owner authority
 * that neither existing detector catches, so it re-emitted from every subsequent loop
 * wake with no nudge to tag or verify it. This convention ("owner directive <date>: …")
 * is also the repo's own standard citation form for a REAL owner directive (see e.g.
 * agent-insights/p2p-not-a-v1-target.md, RELEASE-RUNBOOK.md) — so flagging it here is
 * not a new restriction on real usage, it is applying P-014's existing rule (a manual
 * attribution asserts, only a turn ref proves) to a form the rule already covers in
 * spirit but the regex never matched syntactically.
 */
const OWNER_DIRECTIVE_NOUN_RE = /\bowner\s+(?:directive|mandate)s?\b/i;

/**
 * EI-20234090473445932: a status/evidence sentence can mention a recorded owner
 * directive without asserting that the current writer received owner authority.
 * Keep this exclusion narrow: a numbered directive whose state is being reported,
 * or an explicitly checked/listed directive, is factual runtime evidence. An
 * imperative citation such as "owner directive 1: hold the deploy" still falls
 * through to OWNER_DIRECTIVE_NOUN_RE and remains a manual-owner-tag warning.
 */
const OWNER_DIRECTIVE_STATUS_REFERENCE_RE =
  /\b(?:owner\s+(?:directive|mandate)s?\s+#?\d+\s+(?:is|are|was|were|remains?|stays?|has\s+been|have\s+been)\s+(?:open|closed|pending|acknowledged|declined|resolved|completed|recorded)|(?:the\s+)?(?:open|closed|pending|current|existing|recorded)\s+owner\s+(?:directive|mandate)s?\b(?=[^.\n]*(?:is|are|was|were|remains?|stays?|checked|listed|returned|acknowledged|declined|resolved|completed|recorded|status|orders:list|tools:invoke)\b))/i;

function isOwnerDirectiveStatusReference(line: string): boolean {
  return OWNER_DIRECTIVE_STATUS_REFERENCE_RE.test(line);
}

/** Mirrors OWNER_TAG_MENTION_CONTEXT_RE's mention-vs-use distinction for the bracket
 *  tag, generalized to the noun phrase: a nearby word that reads as DOCUMENTING the
 *  convention ("never manufacture an owner directive", "the term owner directive")
 *  rather than ASSERTING one. Kept in the same short, high-precision spirit as the
 *  rest of this module — this repo's own compaction-strategy prose uses exactly this
 *  shape ("manufactures owner directives", "a claimed owner directive") when an agent
 *  quotes it into a carry note, and that quoting must not misread as a real claim. */
const OWNER_DIRECTIVE_MENTION_CONTEXT_RE =
  /(?:\bforms?\b|\bconventions?\b|\bpatterns?\b|\bsyntax\b|\bexamples?\b|\be\.g\.,?|->|\bmanufactur\w*|\bfabricat\w*|\bmint(?:ed|ing|s)?\b|\bcoin(?:ed|ing|s)?\b|\bthe\s+terms?\b|\bthe\s+phrases?\b|\bthe\s+notion\b|\bthe\s+concept\b|\bcall(?:ed|ing|s)?\b|\bclaimed\b)[^.\n]{0,40}\bowner\s+(?:directive|mandate)s?\b/i;

const BACKTICK_WRAPPED_OWNER_DIRECTIVE_RE = /`[^`\n]*\bowner\s+(?:directive|mandate)s?\b[^`\n]*`/i;

/** Definite quoting — never flag, mirrors {@link isOwnerTagQuotedForm}. */
function isOwnerDirectiveNounQuotedForm(line: string): boolean {
  return BACKTICK_WRAPPED_OWNER_DIRECTIVE_RE.test(line);
}

/** Ambiguous — likely documenting/comparing the convention, not asserting a directive. */
function isOwnerDirectiveNounPossibleMention(line: string): boolean {
  return OWNER_DIRECTIVE_MENTION_CONTEXT_RE.test(line);
}

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
const INLINE_CODE_SEGMENT_RE = /`([^`\n]*)`/g;

// EI-20246140574201628: a backtick-quoted gate is a cited phrase, not a new directive.
function isBareGateInsideInlineCode(line: string, match: RegExpExecArray): boolean {
  for (const segmentMatch of line.matchAll(INLINE_CODE_SEGMENT_RE)) {
    const segmentStart = (segmentMatch.index ?? 0) + 1;
    const segmentEnd = segmentStart + segmentMatch[1].length;
    if (match.index >= segmentStart && match.index + match[0].length <= segmentEnd) return true;
  }
  return false;
}

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
 * P-014 (fleet-lead-instrumentation-audit-2026-08-09) — the THIRD-PARTY actor test.
 *
 * {@link UNVERIFIED_ACTION_CLAIM_RE} matches a comm verb plus a coordination target and
 * has no notion of WHO ACTED, so it cannot tell "I messaged the leader" from
 * "su-6dc49b99 replied about WI-37162". The first is the claim the lint exists to
 * police — the author asserting a side-effect only they could have produced. The second
 * is the author RECORDING A PEER'S REPORT, which is exactly the attribution discipline
 * this module asks for everywhere else; flagging it punishes compliance, and a lint that
 * fires on the correct behaviour is how a leg that catches a real class gets ignored.
 *
 * Matched against the text PRECEDING the verb on the same line, so the actor must sit
 * immediately before it (modulo a short closed set of adverbs/auxiliaries). A line that
 * OPENS with the verb — "Messaged fleet leader su-bce40c51 directly", the motivating
 * WI-5137 fabrication — has an implicit first-person subject and is still flagged.
 */
const THIRD_PARTY_ACTOR_RE =
  /\b(?:su-[0-9a-f]{4,}|they|he|she|a\s+peer|the\s+peer|another\s+agent|the\s+(?:fleet\s+)?leader|the\s+queen|the\s+owner)\b(?:\s+(?:has|had|have|just|already|then|also|apparently|reportedly|since))*\s+$/i;

/** Whether the matched action verb's own subject is someone OTHER than the author. */
function isPeerReportedAction(line: string): boolean {
  const m = UNVERIFIED_ACTION_CLAIM_RE.exec(line);
  if (!m || m.index === undefined) return false;
  return THIRD_PARTY_ACTOR_RE.test(line.slice(0, m.index));
}

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
   *  consumer already checks, instead of a separate field nobody reads.
   *  'possible-owner-tag-mention' (EI-18672153930631150) is the DOWNGRADED
   *  sibling of 'manual-owner-tag': a `[owner:...]`-shaped token that reads as
   *  documentation/comparison of the tag convention itself (a placeholder name,
   *  a backtick-quoted form, or "form"/"convention"/"e.g." nearby) rather than
   *  an actual attribution — still surfaced (never silently dropped), but out
   *  of the loud category so that category keeps its high-precision meaning.
   *  'peer-reported-action' (P-014) is the same downgrade applied to the ACTOR
   *  rather than the tag: the comm verb's subject is a THIRD PARTY, so the line
   *  records a peer's action as a peer's action — attribution done right, not an
   *  unprovable claim about the author's own side-effects. Still second-hand and
   *  still surfaced; just not accused. */
  kind:
    | 'owner-attribution'
    | 'bare-gate-imperative'
    | 'peer-reported-action'
    | 'manual-owner-tag'
    | 'possible-owner-tag-mention'
    | 'quote-mismatch'
    | 'unverified-action-claim';
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
      // P-014: same mention-vs-use split the owner-tag legs already make, applied to the
      // ACTOR. A peer's action recorded as a peer's action is attribution done right, so
      // it is DOWNGRADED rather than silenced — a reader still sees it is second-hand and
      // unverified, without being told they claimed something they cannot prove.
      matches.push({
        line: line.slice(0, MATCH_LINE_CAP),
        kind: isPeerReportedAction(line) ? 'peer-reported-action' : 'unverified-action-claim',
      });
      if (matches.length >= MAX_MATCH_LINES) continue;
    }
    if (OWNER_TAG_RE.test(line)) {
      // EI-18672153930631150: a `[owner:...]`-shaped token that reads as
      // documentation of the convention, not an attribution, should not be
      // treated as an asserted directive.
      if (isOwnerTagQuotedForm(line)) continue; // definite quoting — never flag
      // EI-19461711239876849: a line RETRACTING an owner attribution is the compliance
      // this convention asks for, not a violation of it — never nudge it.
      if (isProvenanceWithdrawal(line)) continue;
      if (isOwnerTagPossibleMention(line)) {
        matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'possible-owner-tag-mention' });
        continue;
      }
      // P-014: a bare [owner:…] tag no longer clears the line — it asserts an
      // owner directive without a verifiable anchor. Nudge for a [turn:…] ref.
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'manual-owner-tag' });
      continue;
    }
    if (SOURCE_TAG_RE.test(line)) continue; // [self-imposed]/[peer:]/[inferred] — not owner-authority
    if (OWNER_ATTRIBUTION_RE.test(line)) {
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'owner-attribution' });
      continue;
    }
    if (OWNER_DIRECTIVE_NOUN_RE.test(line)) {
      // EI-20234090473445932: factual status/runtime evidence about a recorded
      // directive is not an assertion of owner authority by the current writer.
      if (isOwnerDirectiveStatusReference(line)) continue;
      // EI-19393929983792049: same mention-vs-use split as the bracket tag above,
      // generalized to the noun phrase.
      if (isOwnerDirectiveNounQuotedForm(line)) continue; // definite quoting — never flag
      // EI-19461711239876849: same retraction carve-out as the bracket tag above — the
      // noun form is what a retraction of a noun-form assertion ("this is [self-imposed],
      // NOT an owner directive") is necessarily written in.
      if (isProvenanceWithdrawal(line)) continue;
      if (isOwnerDirectiveNounPossibleMention(line)) {
        matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'possible-owner-tag-mention' });
        continue;
      }
      // Same treatment as a bare [owner:…] tag: it asserts owner authority with no
      // verifiable anchor, so it gets the SAME kind (and the SAME P-005 owner-typed-
      // turn auto-verify path when the line's own date matches today's turn).
      matches.push({ line: line.slice(0, MATCH_LINE_CAP), kind: 'manual-owner-tag' });
      continue;
    }
    const bareGateMatch = BARE_GATE_IMPERATIVE_RE.exec(line);
    if (!hasTaggedProvenanceBlock && bareGateMatch && !isBareGateInsideInlineCode(line, bareGateMatch)) {
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

/**
 * The kinds that are SURFACED but not ACCUSED — a mention of the tag convention rather
 * than an attribution, or an action attributed to a peer rather than claimed as one's
 * own. Kept as data (not a boolean on each match) so the note selection below cannot
 * disagree with the kind a consumer reads.
 */
const DOWNGRADED_KINDS: ReadonlySet<ProvenanceLintMatch['kind']> = new Set([
  'possible-owner-tag-mention',
  'peer-reported-action',
]);

/**
 * P-014 — the note for a write whose matches are ALL downgraded. The main note opens
 * with "contains an owner-attributed directive and/or a claimed COMPLETED action … with
 * no verifiable turn ref", which is simply FALSE of such a write, and being told to
 * anchor a peer's reported action to a turn of your own is impossible advice. A lint
 * that misdescribes the compliant case is how the whole leg gets tuned out.
 */
export const PROVENANCE_LINT_DOWNGRADED_NOTE =
  'provenance_lint (FYI — nothing to fix): every match on this write is a DOWNGRADED kind. Either a ' +
  '[owner:…]-shaped token used to DESCRIBE the convention rather than to attribute a directive, or an ' +
  'action whose subject is a PEER ("su-… replied about WI-…") — i.e. a peer\'s claim recorded AS a ' +
  "peer's claim, which is the attribution discipline this lint asks for, not a violation of it. Surfaced " +
  'so a reader treats the line as second-hand and unverified; no [turn:…] ref of your own is required (and ' +
  'for a peer\'s action you could not supply one). See the `matches[].kind` for which line is which.';

/** Convenience: build the `{ flagged, note?, matches? }` shape every consumer
 *  tool folds into its JSON response — `undefined` fields when clean, so a clean
 *  write's response shape is unchanged (no `provenanceLint: { flagged: false }`
 *  noise on the overwhelming common case). */
export function provenanceLintField(text: string | null | undefined):
  | { flagged: true; note: string; matches: ProvenanceLintMatch[] }
  | undefined {
  const result = lintCarrySurfaceProvenance(text);
  if (!result.flagged) return undefined;
  // A single LOUD match makes the write accusable, so the softer note applies only when
  // EVERY match is downgraded — never let one real violation ride in under the FYI.
  const allDowngraded = result.matches.every((m) => DOWNGRADED_KINDS.has(m.kind));
  return {
    flagged: true,
    note: allDowngraded ? PROVENANCE_LINT_DOWNGRADED_NOTE : PROVENANCE_LINT_NOTE,
    matches: result.matches,
  };
}
