/**
 * plan-slug-leg — the FIFTH retrieval leg of the Scout prior-art screen (WI-9476).
 *
 * ## Why a plan-slug leg exists at all
 *
 * The other retrieval legs find prior art that is NAMED close to the proposal:
 * `code-existence-probe`'s lexical leg greps the idea's own vocabulary, and the
 * self-id leg greps its work-item id. Both fail on the same shape — an
 * implementation whose MODULE NAME shares no token with the idea's phrasing.
 *
 * The worked case (su-b9269a31, msg `msdmrkli`) is exact and is the reason this
 * module exists: an idea phrased "signals fire with no acting consumer" is already
 * implemented by `orphaned-dispatch.ts` — 737 lines, shipped, three weeks OLDER
 * than the filing. Symbol-grep provably misses it: "orphaned" and "dispatch" appear
 * nowhere in the idea, and "consumer"/"signals" appear nowhere in the module. What
 * connected them was the PLAN the module was built under:
 *
 *     self-improvement-consume-edges-2026-06-12
 *
 * A plan slug is a hand-written, human-compressed statement of the CONDITION the
 * work addresses, while a module name is usually a statement of the MECHANISM. The
 * idea and the plan are both written in condition-language, so they share
 * vocabulary the idea and the code do not. That is the bridge — and the finding
 * worth carrying is that the bridge turned out to be **plan slugs, not embeddings**.
 *
 * ## Precision posture — CONTEXT ONLY, never a verdict
 *
 * This leg MUST NOT drive a DROP. The screen's standing rule (WI-9476 checkpoint)
 * is that only a high-precision leg — a terminal asserted ref, or a path-filtered
 * self-id hit — may drive a verdict, and a plan-slug overlap is neither: it is a
 * token-overlap inference with no measured precision, exactly like the lexical leg
 * that was already demoted to context for the same reason.
 *
 * It is reported in its OWN field and never unioned into `matches` or `semantic`,
 * so its precision stays separately measurable rather than blended into theirs. If
 * it turns out to add nothing above the noise floor, that is a publishable result
 * and it can be removed without disturbing the other legs.
 *
 * ## The status check is not decoration — it is defect #4, re-applied
 *
 * A plan that MATCHES is not a plan that SHIPPED. `draft`/`ready`/`active` plans
 * describe intended work; `superseded` plans were abandoned. Treating either as
 * evidence of an existing implementation is the same error as counting a `dropped`
 * work-item as prior art (WI-9476 defect #4: "abandoned ≠ built"), which produced
 * two of the screen's measured false positives. Each match therefore carries a
 * `statusClass`, and only `implemented` is evidence that something was built.
 */

/** A plan as the search backend returns it. Deliberately minimal. */
export interface PlanRecord {
  /** The plan slug — the only field this leg scores on. */
  slug: string;
  /** Human title, carried for display only; never scored (see `matchPlans`). */
  title?: string;
  /** Plan lifecycle status, if known. */
  status?: string;
}

/**
 * What a matched plan's status implies about whether code EXISTS.
 *
 *  - `implemented`  — the plan shipped; its items are real code.
 *  - `in-flight`    — draft/ready/active; intended work, NOT evidence of code.
 *  - `abandoned`    — superseded; explicitly NOT built (defect #4's class).
 *  - `unknown`      — no status, or one this module does not recognise.
 */
export type PlanStatusClass = 'implemented' | 'in-flight' | 'abandoned' | 'unknown';

/** One plan whose slug overlaps the idea's vocabulary. */
export interface PlanSlugMatch {
  slug: string;
  title?: string;
  status?: string;
  /** What the status implies about existing code — read this before believing a hit. */
  statusClass: PlanStatusClass;
  /** The overlapping STEMS (not raw words), sorted, so a reader can judge the hit. */
  overlap: string[];
  /**
   * Coverage of the plan's own name: `overlap.length / planStems.length`, in [0,1].
   *
   * Coverage rather than raw overlap count on purpose — a 2-token plan sharing 1
   * token is a much stronger signal than a 9-token plan sharing 1, and a bare count
   * cannot tell those apart. (Same defect as grading a lexical hit by bare file
   * count, which this screen already records as a known weakness.)
   */
  score: number;
}

/** Injectable plan-search backend, so tests never touch Postgres. */
export interface PlanSearchDeps {
  /**
   * Candidate plans for this idea text. The implementation decides recall — a
   * full-text prefilter, or simply every plan in the harness. This module only
   * SCORES what it is handed, which is what keeps the ranking logic pure.
   *
   * ⚠ Implementations reading `harness_shared.harness_plans` directly MUST scope on
   * BOTH `workspace_id` AND `harness_slug` — that table is multi-tenant, and a
   * slug-only filter silently returns another tenant's plans.
   */
  searchPlans(text: string): Promise<PlanRecord[]>;
}

export interface PlanSlugOptions {
  /** Minimum overlapping stems for a plan to be reported at all (default 1). */
  minOverlap?: number;
  /** Minimum `score` for a plan to be reported (default 0.2). */
  minScore?: number;
  /** Max matches retained, highest score first (default 5). */
  maxMatches?: number;
  /** Extra slug tokens to treat as generic, on top of `GENERIC_SLUG_TOKENS`. */
  extraGenericTokens?: string[];
}

const DEFAULTS = {
  minOverlap: 1,
  minScore: 0.2,
  maxMatches: 5,
  minStemLength: 4,
  minTokenLength: 3,
} as const;

/** Plan statuses that mean the work SHIPPED. */
const IMPLEMENTED_PLAN_STATUSES = new Set(['shipped']);
/** Plan statuses that mean the work is intended but not yet built. */
const IN_FLIGHT_PLAN_STATUSES = new Set(['draft', 'ready', 'active']);
/** Plan statuses that mean the work was explicitly NOT built. */
const ABANDONED_PLAN_STATUSES = new Set(['superseded']);

/**
 * Slug tokens that appear across a large share of plan names and therefore
 * discriminate nothing. Kept small and literal on purpose: this leg is
 * context-only, so an over-eager stoplist (which suppresses real bridges) costs
 * more than an over-permissive one (which surfaces a hit a reader then discards).
 */
export const GENERIC_SLUG_TOKENS = new Set([
  'papercusp',
  'papercup',
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'plan',
  'plans',
  'work',
  'task',
  'tasks',
  'phase',
  'wave',
  'pass',
  'fix',
  'fixes',
  'v1',
  'v2',
  'v3',
]);

/** Classify a plan status into what it implies about existing code. */
export function classifyPlanStatus(status?: string): PlanStatusClass {
  const s = (status ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (IMPLEMENTED_PLAN_STATUSES.has(s)) return 'implemented';
  if (IN_FLIGHT_PLAN_STATUSES.has(s)) return 'in-flight';
  if (ABANDONED_PLAN_STATUSES.has(s)) return 'abandoned';
  return 'unknown';
}

/**
 * Suffixes stripped by {@link lightStem}, LONGEST FIRST so that "consumers" loses
 * "ers" rather than "s".
 */
const SUFFIXES = [
  'ations',
  'ation',
  'ements',
  'ement',
  'ings',
  'ing',
  'ers',
  'er',
  'ions',
  'ion',
  'ors',
  'or',
  'ies',
  'ed',
  'es',
  's',
  'e',
  'y',
];

/**
 * Strip one common English suffix. Deliberately light — a real stemmer is neither
 * needed nor safe here, because both sides are stemmed by this same function, so
 * self-consistency matters far more than linguistic correctness.
 *
 * **Stemming is load-bearing, not a nicety.** The worked case connects ONLY through
 * it: the plan slug says `consume`, the idea says `consumer`, and an exact-token
 * matcher scores those two at zero — i.e. the one case that motivated this whole
 * leg fails without stemming.
 *
 * The `minStemLength` guard is what keeps it self-consistent on short words:
 * without it "edges" → "edg" but "edge" → "edg" only by luck, and "fires" → "fir"
 * while "fire" → "fir" — pairs that silently stop matching whenever exactly one of
 * two rules fires. Refusing to strip below 4 characters makes both sides land on
 * the same stem.
 */
export function lightStem(word: string, minStemLength = DEFAULTS.minStemLength): string {
  const w = word.toLowerCase();
  if (w.length <= minStemLength) return w;
  for (const suf of SUFFIXES) {
    if (!w.endsWith(suf)) continue;
    const stem = w.slice(0, w.length - suf.length);
    if (stem.length >= minStemLength) return stem;
  }
  return w;
}

/** Is this token a bare date fragment produced by kebab-splitting a dated slug? */
function isDateFragment(token: string): boolean {
  return /^\d+$/.test(token);
}

/**
 * The meaningful tokens of a plan slug. PURE — no I/O, so the precision risk is
 * unit-testable on its own.
 *
 * Drops, in order: the conventional trailing `-YYYY-MM-DD` date, any remaining
 * bare-numeric fragment (the kebab split turns `2026-06-12` into three separate
 * tokens, so stripping the date as one span is not sufficient), very short tokens,
 * and generic slug vocabulary.
 *
 * Returns RAW tokens, not stems — {@link matchPlans} stems them. Keeping the two
 * steps apart means a caller can see which words a slug actually contributed.
 */
export function planSlugTokens(slug: string, extraGeneric: string[] = []): string[] {
  const generic = new Set([...GENERIC_SLUG_TOKENS, ...extraGeneric.map((t) => t.toLowerCase())]);
  const base = (slug ?? '')
    .toLowerCase()
    // The conventional dated suffix, removed as one span before splitting.
    .replace(/[-_]?\d{4}-\d{2}-\d{2}$/, '');

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of base.split(/[-_/\s.]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (isDateFragment(token)) continue;
    if (token.length < DEFAULTS.minTokenLength) continue;
    if (generic.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * The stems of an idea's free text — the set a plan slug is scored against.
 *
 * Exported so a caller can see exactly what the idea contributed, and so the
 * "no usable vocabulary" case is detectable BEFORE the backend is called (see the
 * zero-work guard in {@link probePlanSlugs}).
 */
export function ideaTextStems(text: string, extraGeneric: string[] = []): Set<string> {
  const generic = new Set([...GENERIC_SLUG_TOKENS, ...extraGeneric.map((t) => t.toLowerCase())]);
  const out = new Set<string>();
  for (const m of (text ?? '').toLowerCase().matchAll(/[a-z][a-z0-9]{2,}/g)) {
    const token = m[0];
    if (generic.has(token)) continue;
    out.add(lightStem(token));
  }
  return out;
}

/**
 * Score plans against an idea's text by overlapping slug STEMS. PURE — no I/O.
 *
 * Scores the SLUG ONLY, never the title. That is a deliberate design choice, not an
 * omission: the whole premise is that a hand-written slug is a compressed statement
 * of the CONDITION, whereas a title is prose that repeats the mechanism. Folding
 * titles in would turn this into a second, weaker lexical leg — duplicating a leg
 * that already exists rather than adding the independent signal this one is for.
 * The title is carried through purely so a reader can judge a hit without a lookup.
 */
export function matchPlans(
  ideaText: string,
  plans: PlanRecord[],
  opts: PlanSlugOptions = {},
): PlanSlugMatch[] {
  const minOverlap = opts.minOverlap ?? DEFAULTS.minOverlap;
  const minScore = opts.minScore ?? DEFAULTS.minScore;
  const maxMatches = opts.maxMatches ?? DEFAULTS.maxMatches;
  const extraGeneric = opts.extraGenericTokens ?? [];

  const textStems = ideaTextStems(ideaText, extraGeneric);
  if (textStems.size === 0) return [];

  const out: PlanSlugMatch[] = [];
  for (const plan of plans ?? []) {
    const tokens = planSlugTokens(plan.slug ?? '', extraGeneric);
    if (tokens.length === 0) continue;

    const planStems = new Set(tokens.map((t) => lightStem(t)));
    const overlap = [...planStems].filter((s) => textStems.has(s)).sort();
    if (overlap.length < minOverlap) continue;

    const score = overlap.length / planStems.size;
    if (score < minScore) continue;

    out.push({
      slug: plan.slug,
      title: plan.title,
      status: plan.status,
      statusClass: classifyPlanStatus(plan.status),
      overlap,
      score,
    });
  }

  // Highest coverage first; on a tie, more overlapping stems, then stable by slug.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.overlap.length !== a.overlap.length) return b.overlap.length - a.overlap.length;
    return a.slug.localeCompare(b.slug);
  });

  return out.slice(0, maxMatches);
}

/** What the plan-slug leg reports. Its own shape — never merged into another leg. */
export interface PlanSlugLegReport {
  /** Matching plans, best first. Empty is a real answer ONLY when `searched` is true. */
  planMatches: PlanSlugMatch[];
  /**
   * Did the plan backend actually run? `false` = the empty `planMatches` carries NO
   * information, and must never be read as "no plan covers this".
   *
   * Two causes set it false, distinguished by `unavailableReason`: the backend
   * threw, or the idea text yielded no usable vocabulary so the backend was never
   * called at all. The second is the one that masquerades as a clean miss — the
   * `tsc -p .` class, and the same defect this screen already shipped once
   * (WI-9476 defect #1), so it is guarded explicitly rather than left implicit.
   */
  searched: boolean;
  /** Present when `searched` is false — why the leg could not run. */
  unavailableReason?: string;
}

/**
 * Run the plan-slug leg. Report-only and fail-open, matching every other leg: a
 * throwing backend degrades to `searched: false` with no matches, because a backend
 * outage reported as "nothing found" is the false negative this screen exists to
 * prevent.
 */
export async function probePlanSlugs(
  text: string,
  deps: PlanSearchDeps,
  opts: PlanSlugOptions = {},
): Promise<PlanSlugLegReport> {
  // ZERO-WORK GUARD — do not "simplify" this into a plain empty result.
  //
  // No stems means there is nothing to score a slug against, so calling the
  // backend would be meaningless and reporting `searched: true` would claim a
  // completed probe that never ran.
  if (ideaTextStems(text, opts.extraGenericTokens ?? []).size === 0) {
    return {
      planMatches: [],
      searched: false,
      unavailableReason:
        'no usable vocabulary could be extracted from the idea text — the plan backend was never called',
    };
  }

  let plans: PlanRecord[];
  try {
    plans = (await deps.searchPlans(text)) ?? [];
  } catch (err) {
    return {
      planMatches: [],
      searched: false,
      unavailableReason: err instanceof Error ? err.message : String(err),
    };
  }

  return { planMatches: matchPlans(text, plans, opts), searched: true };
}

/**
 * One-line summary of the leg, for a screening report.
 *
 * Wording is constrained by the leg's context-only posture: it must describe what
 * was FOUND without inviting a close. It also leads with the status class, because
 * a matching `active` plan means "someone intends to build this", which is nearly
 * the opposite of what a matching `shipped` plan means.
 */
export function summarisePlanSlugLeg(report: PlanSlugLegReport): string {
  if (!report.searched) {
    return `plan-slug leg UNAVAILABLE (${report.unavailableReason ?? 'unknown'}) — NOT evidence of absence`;
  }
  if (report.planMatches.length === 0) return 'plan-slug leg: no plan name overlaps this idea';

  const shipped = report.planMatches.filter((m) => m.statusClass === 'implemented');
  const shown = (shipped.length > 0 ? shipped : report.planMatches).slice(0, 3);
  const bits = shown
    .map((m) => `${m.slug} [${m.statusClass}] via ${m.overlap.join('+')} (${m.score.toFixed(2)})`)
    .join('; ');

  return shipped.length > 0
    ? `plan-slug leg — SHIPPED plan(s) overlap this idea, read them before building: ${bits}`
    : `plan-slug leg — overlapping plan(s), none shipped (context only, not prior art): ${bits}`;
}
