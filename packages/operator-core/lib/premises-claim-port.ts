/**
 * premises-claim-port.ts — surface the load-bearing PREMISES a work-item's own
 * text rests on at CLAIM time (false-premise-in-prescriptive-artifacts-2026-08-02
 * P-001).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * A work-item body is a PRESCRIPTIVE artifact: it tells a claimant what to
 * build. Its prescription usually rests on a premise about the codebase — and
 * that premise is stated in the author's own confident voice, indistinguishable
 * from a checked fact. A claimant reads the prescription and builds. If the
 * premise was false, the work is wasted before the first line is written, and
 * nothing in the artifact said the premise was ever unverified.
 *
 * Root incident (WI-7042, the item this plan was filed from): the body asserted
 * "there is no exported read helper for `harness_shared.p2p_work_offers`" and
 * prescribed writing a new PG read module on it. FALSE — `offer-store.ts`
 * exports `getWorkOffer` + `listWorkOffers`. The premise came from grepping
 * `projections/work-offers.ts`, the receive/apply leg. The error was SCOPE OF
 * INFERENCE, not method: a real search, over the wrong scope, reported as an
 * absolute absence. Catching it deleted the prescribed module before it was
 * written.
 *
 * ── WHY ABSENCE CLAIMS SPECIFICALLY ─────────────────────────────────────────
 *
 * The asymmetry is what makes this cheap. An absence claim ("there is no X") is
 * EXPENSIVE to act on — you build X — and CHEAP to falsify — one search. No
 * other premise shape has that ratio, which is why this port keys on absence
 * rather than trying to detect wrong premises in general.
 *
 * ── WHY THE CLAIM EVENT IS THE PRODUCER ─────────────────────────────────────
 *
 * The predecessor plan's D-001 (agent-epistemics-2026-08-02) retired a drafted
 * dispute detector that fired ZERO times in 14 days, and recorded the rule: key
 * onto a substrate whose producer ALREADY EXISTS. The claim event is one — it
 * fires on every claim, at exactly the moment before the cost is paid, and it
 * already carries sibling hints (the checkpoint hint, the prior-work hint, the
 * memory recall, the plan-decisions brief) attached at this same seam.
 *
 * Crucially this needs NO new authoring behaviour. WI-7042's author BELIEVED the
 * premise; a "declare your premises" field would have been filled in with the
 * false premise stated just as confidently, or left empty. So the premises are
 * DERIVED from the text the author already wrote. A declared premise (below)
 * still wins where present — but nothing depends on anyone declaring one.
 *
 * ── MEASURED, NOT ASSUMED (D-001 of this plan) ──────────────────────────────
 *
 * The governing decision says a prescriptive artifact must VERIFY its
 * prescription before emitting it. This module is itself such an artifact, so
 * the detector was measured against the real corpus before being wired in
 * (harness `papercusp`, 31,090 work-item bodies, 2026-08-02):
 *
 *   - 1,442 bodies (4.6%) carry an absence-shaped claim — it fires on roughly
 *     1 claim in 22, not on everything. A detector that fires on most claims is
 *     noise, and this one measurably does not.
 *   - 1,431 of those 1,442 are in SUBSTANTIAL bodies (>200 chars), i.e. the
 *     class concentrates in real prescriptions rather than one-line stubs.
 *   - Hand-read precision sample of substantial recent hits: the dominant FALSE
 *     POSITIVE is an absence phrase inside QUOTED TOOL OUTPUT — WI-7132's only
 *     hit is entirely within a backticked `column "payload" does not exist`
 *     error string. That single measurement is why {@link stripNonProse} exists
 *     and runs first; without it the detector would fire hardest on pasted
 *     error messages, which are evidence, not premises.
 *
 * ── D-001 COMPLIANCE ────────────────────────────────────────────────────────
 *
 * (a) A refutation REPLACES the prescription, never annotates it. A DECLARED
 *     premise carrying evidence (`verified`) REPLACES the derived row for the
 *     same claim rather than sitting beside it — "here is a premise, and also
 *     it might be wrong" invites acting on it anyway.
 * (b) FAIL OPEN on every uncertainty. Every failure path returns null: this is
 *     decoration on a claim, never a new way for a claim to fail, and never a
 *     block. Ambiguity yields silence, not a false alarm.
 * (c) NAME THE REAL ANSWER, not just the refusal. Each derived premise carries
 *     a concrete `recheck` naming the SCOPE the search must cover — because
 *     scope of inference, not method, is the measured failure mode.
 */
import { type CheckEntry, renderCheckLine } from './carry-note';
import { planSlugOfWorkItem } from './scheduler/claim-spec-match';
import type { WorkItem } from './work-items';
import { getPlanRow } from './agent-tools/plans/source';
import { parsePlan } from './agent-tools/plans/parser';

/** Where a premise was found. A plan-item premise governs every work-item
 *  promoted from it, so it is worth naming separately from the item's own body. */
export type PremiseSource = 'work-item' | 'plan-item';

export interface DerivedPremise extends CheckEntry {
  /** Only 'absence' today — the shape with the payoff asymmetry. Kept explicit so
   *  P-002's absence-specific strictness has something to key on rather than
   *  re-deriving the classification. */
  kind: 'absence';
  source: PremiseSource;
}

export interface ClaimTimePremisesBrief {
  /** Rows in the shared {@link CheckEntry} shape — the SAME primitive
   *  work_items:checkpoint / loop:checkpoint already carry, so a claimant reads
   *  one row format everywhere. */
  premises: CheckEntry[];
  /** Pre-rendered `✓`/`?` lines (renderCheckLine), so a caller inlines them
   *  without re-deriving the badge convention. */
  rendered: string[];
  total: number;
  unverified: number;
  /** The leading directive. Frames the item as a HYPOTHESIS — see D-001 (a). */
  note: string;
}

/** Bound on premises attached to a claim payload — past a handful this is a
 *  poorly-scoped item, not a brief worth growing. */
const MAX_PREMISES = 4;
/** Bound on a single rendered claim sentence. */
const CLAIM_CHARS = 220;

/**
 * Strip the spans of a body that are QUOTED MATERIAL rather than the author's
 * own assertions: fenced code blocks and inline code spans.
 *
 * ⚠ THIS IS THE MEASURED FALSE-POSITIVE FIX, not a stylistic nicety. In the
 * precision sample, the single clearest false positive (WI-7132) matched
 * entirely inside a backticked error message — `column "payload" does not
 * exist`. A pasted error string is EVIDENCE the author gathered; treating it as
 * the author's own absence claim inverts its meaning and would make the
 * detector fire hardest on the best-evidenced items.
 *
 * Replaces with spaces rather than deleting so sentence boundaries survive and a
 * stripped span cannot glue two unrelated clauses into a phantom match.
 */
export function stripNonProse(text: string): string {
  return (text ?? '')
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/** Trim a matched sentence to a bounded, readable claim. */
function clampClaim(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > CLAIM_CHARS ? `${t.slice(0, CLAIM_CHARS - 1)}…` : t;
}

/**
 * The absence patterns. Each captures the SUBJECT of the absence, so the
 * generated `recheck` can name what to search for instead of saying "verify
 * this" — D-001 (c).
 *
 * Bounded character classes throughout (no nested quantifiers over `.*`) so a
 * pathological body cannot cause catastrophic backtracking on the claim path.
 */
const ABSENCE_PATTERNS: ReadonlyArray<{ re: RegExp; subject: (m: RegExpMatchArray) => string }> = [
  { re: /\bthere (?:is|are|was|were) no ([^.;\n]{3,120})/gi, subject: (m) => m[1] },
  { re: /\bno such ([^.;\n]{3,120})/gi, subject: (m) => m[1] },
  { re: /\b([A-Za-z_][\w.$:/-]{1,60}) (?:does|do|did) not exist\b/gi, subject: (m) => m[1] },
  {
    re: /\bnothing (?:currently |ever )?(?:reads|writes|calls|uses|consumes|handles) ([^.;\n]{3,120})/gi,
    subject: (m) => m[1],
  },
  { re: /\b(?:we|it|they) (?:currently )?(?:lacks?|ha(?:s|ve) no) ([^.;\n]{3,120})/gi, subject: (m) => m[1] },
];

/**
 * Deictic subjects. "…and IT does not exist" is a genuine, load-bearing absence
 * premise in the corpus (WI-7187 prescribes building the very guard it says is
 * absent), so dropping it would be a false negative on a real case. But its
 * subject is a pronoun, and a `recheck` that told a claimant to search the repo
 * for the literal string "it" would be worse than useless — it would look like a
 * named search term while naming nothing.
 *
 * So the premise still fires, and the re-check asks the reader to NAME the
 * referent first. D-001 (c) requires naming the real answer where one is
 * knowable; where it genuinely is not, say so rather than fabricate one.
 */
const DEICTIC = new Set(['it', 'this', 'that', 'they', 'these', 'those', 'one', 'there', 'he', 'she']);

/** The concrete probe attached to a derived premise. */
function recheckFor(subject: string): string {
  const scopeRule =
    'across the WHOLE repo (not the one file that suggested it), then state the scope you searched — ' +
    'an absence found in one module is not an absence.';
  return DEICTIC.has(subject.toLowerCase())
    ? `NAME what this sentence claims is absent (the subject is a pronoun here), then search for it ${scopeRule}`
    : `Search for "${subject.slice(0, 80)}" ${scopeRule}`;
}

/** The sentence containing an offset — the unit a human reads as "the claim". */
function sentenceAt(text: string, index: number): string {
  const start = Math.max(
    text.lastIndexOf('.', index),
    text.lastIndexOf('\n', index),
    text.lastIndexOf(';', index),
  );
  let end = text.length;
  for (const mark of ['.', '\n', ';']) {
    const i = text.indexOf(mark, index);
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(start + 1, end);
}

/**
 * Derive absence premises from an artifact's own text. PURE and exported for
 * tests — the measurement above is only meaningful if the thing measured is the
 * thing that ships.
 *
 * Returns [] for blank/short text and for text whose absence phrases live
 * entirely inside quoted spans (fail open — silence, never a guess).
 */
export function detectAbsencePremises(text: string, source: PremiseSource): DerivedPremise[] {
  const prose = stripNonProse(text ?? '');
  if (prose.trim().length < 20) return [];
  const out: DerivedPremise[] = [];
  const seen = new Set<string>();
  for (const { re, subject } of ABSENCE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of prose.matchAll(re)) {
      const subj = (subject(m) ?? '').replace(/\s+/g, ' ').trim();
      if (!subj) continue;
      const claim = clampClaim(sentenceAt(prose, m.index ?? 0));
      if (!claim) continue;
      const key = claim.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'absence',
        source,
        claim,
        // D-001 (c): name the SCOPE requirement, not just "verify this". Scope of
        // inference — a real search over too narrow a scope — is the measured
        // failure mode, so a recheck that omits its scope reproduces the bug.
        recheck: recheckFor(subj),
      });
      if (out.length >= MAX_PREMISES) return out;
    }
  }
  return out;
}

/** Declared premises stored on the artifact, in the shared CheckEntry shape. */
function readDeclaredPremises(payload: unknown): CheckEntry[] {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const raw = p.premises;
  if (!Array.isArray(raw)) return [];
  const out: CheckEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const claim = typeof row.claim === 'string' ? row.claim.trim() : '';
    if (!claim) continue;
    out.push({
      claim: clampClaim(claim),
      ...(typeof row.recheck === 'string' && row.recheck.trim() ? { recheck: row.recheck.trim() } : {}),
      ...(typeof row.verified === 'string' && row.verified.trim() ? { verified: row.verified.trim() } : {}),
    });
    if (out.length >= MAX_PREMISES) break;
  }
  return out;
}

/** Loose overlap test between a declared claim and a derived one. Deliberately
 *  cheap: this only decides whether a declared row REPLACES a derived row, and
 *  the fail-open direction (keeping both) is merely redundant, not wrong. */
function overlaps(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const xs = new Set(x.split(' ').filter((w) => w.length > 4));
  const ys = y.split(' ').filter((w) => w.length > 4);
  if (xs.size === 0 || ys.length === 0) return false;
  const shared = ys.filter((w) => xs.has(w)).length;
  return shared >= 3 && shared / Math.min(xs.size, ys.length) >= 0.6;
}

/**
 * Combine declared + derived premises into the claim-time brief.
 *
 * D-001 (a) — a DECLARED premise carrying evidence REPLACES the derived row it
 * overlaps, rather than annotating it. Stating "this rests on X, and also X may
 * be wrong" next to each other invites acting on X anyway; an author who
 * actually checked the premise should silence the warning, and only that.
 * A declared premise WITHOUT evidence does not replace anything — it is the same
 * unverified assertion the derived row already caught.
 *
 * PURE and exported for tests.
 */
export function buildPremisesBrief(
  declared: CheckEntry[],
  derived: DerivedPremise[],
): ClaimTimePremisesBrief | null {
  const verifiedDeclared = declared.filter((d) => (d.verified ?? '').trim().length > 0);
  const keptDerived = derived.filter((row) => !verifiedDeclared.some((d) => overlaps(d.claim, row.claim)));
  const premises: CheckEntry[] = [...declared, ...keptDerived.map(({ claim, recheck }) => ({ claim, recheck }))].slice(
    0,
    MAX_PREMISES,
  );
  if (premises.length === 0) return null;
  const unverified = premises.filter((p) => (p.verified ?? '').trim().length === 0).length;
  if (unverified === 0) return null; // nothing to warn about — stay silent (D-001 b).
  return {
    premises,
    rendered: premises.map(renderCheckLine),
    total: premises.length,
    unverified,
    note:
      `This item's text PRESCRIBES an approach that rests on ${unverified} UNVERIFIED premise(s) — ` +
      `treat the item as a HYPOTHESIS, not a spec, and run the re-check BEFORE building. ` +
      `Absence claims ("there is no X") are the expensive shape: acting on one means building X, while ` +
      `falsifying one costs a single search — and the measured failure is SCOPE OF INFERENCE, a real ` +
      `search over too narrow a scope reported as an absolute absence (WI-7042 prescribed a PG module ` +
      `that already existed). If a premise turns out false, fix the ITEM before building.`,
  };
}

/**
 * The port. Resolves declared + derived premises for a just-claimed work-item,
 * scanning BOTH the item's own body and — when the item came from a plan — the
 * plan-item text that governs it.
 *
 * Fail-soft by contract, like every sibling claim port: a lookup miss, an
 * unresolved plan slug, or a parse error degrades to `null`. Returns `null`
 * (silent) for the common case of an item with no absence-shaped premise.
 */
export async function getClaimTimePremises(opts: {
  workItem: Pick<WorkItem, 'payload'> & { title?: string | null; summary?: string | null };
  harness?: string | null;
  workspaceId?: string | null;
}): Promise<ClaimTimePremisesBrief | null> {
  try {
    const wi = opts.workItem;
    const body = `${wi.title ?? ''}\n${wi.summary ?? ''}`;
    const derived: DerivedPremise[] = detectAbsencePremises(body, 'work-item');

    // The plan-item half of P-001: a premise in the plan item's text governs
    // every work-item promoted from it, and is the artifact a claimant is least
    // likely to re-read. Best-effort — a plan miss must never cost the item's
    // own premises.
    if (derived.length < MAX_PREMISES) {
      try {
        const planSlug = planSlugOfWorkItem(wi as WorkItem);
        const itemId = planItemIdOf(wi.payload);
        if (planSlug && itemId) {
          const row = await getPlanRow(planSlug, {
            ...(opts.harness ? { harnessSlug: opts.harness } : {}),
            ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
          });
          if (row) {
            const item = parsePlan(row.content).items.find((i) => i.id === itemId);
            if (item?.text) derived.push(...detectAbsencePremises(item.text, 'plan-item'));
          }
        }
      } catch {
        /* fail open — the item's own premises still stand */
      }
    }

    return buildPremisesBrief(readDeclaredPremises(wi.payload), derived.slice(0, MAX_PREMISES));
  } catch {
    return null;
  }
}

/** The plan item id a work-item was promoted from, if any. */
function planItemIdOf(payload: unknown): string | null {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const planItem =
    p.plan_item && typeof p.plan_item === 'object'
      ? (p.plan_item as Record<string, unknown>)
      : p.planItem && typeof p.planItem === 'object'
        ? (p.planItem as Record<string, unknown>)
        : {};
  for (const k of ['item_id', 'itemId', 'id']) {
    const v = planItem[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
