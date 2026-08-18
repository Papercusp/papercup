/**
 * observation-types.ts — the canonical structured-observation v2 shape
 * (rubric-driven-observations-2026-06-20 P-001 / D-003).
 *
 * A NEUTRAL LEAF MODULE. Both the WRITE side (capture-core.ts + the
 * improvements:capture tool) and the READ side (read-items.ts issueToCandidate)
 * import the type + validator from HERE, so neither imports the other:
 * capture-core already imports read-items (OBSERVATION_TOPIC / issueToCandidate),
 * so a shared type defined IN capture-core that read-items imported would be a
 * read-items ↔ capture-core import cycle. This leaf has no improvement-loop
 * imports, so it breaks the cycle.
 *
 * The structured observation rides `engineer_issues.payload.observation`. v1
 * (turn-end-reflection-observations-2026-06-14 D-005) was
 * `{ kind, scope, confidence, refs }`. v2 (this plan) converges the source-hive
 * tag (workspace-scoped-coordination-2026-06-20 P-001) + the rubric grading
 * (this plan) into ONE coherent extension (D-002), adding:
 *   - sourceHive / targetHive — the hive the observation came FROM / is ABOUT.
 *   - rubricRef — a `rubrics.rubric_id` the observation grades against.
 *   - ratings   — per-criterion structured ratings; evidence MANDATORY per rating.
 * Free-text observations stay FIRST-CLASS: every field is optional; a plain
 * observation carries none of them (rubrics augment, never replace — D-001).
 */

/**
 * The shared rating-scale vocabulary (D-003). A rubric criterion MAY override
 * with its own ratingScale, but this is the default the Overwatch scorecard
 * (P-004) and the Scout digest grouping (P-006) line up on.
 *   - healthy  — the characteristic is working as its rubric model expects.
 *   - degraded — drifting, but not broken (a warning).
 *   - broken   — the characteristic has failed its model.
 *   - unknown  — not-assessable this wake (e.g. an idle subsystem with no signal).
 */
export const OBSERVATION_RATING_SCALE = ['healthy', 'degraded', 'broken', 'unknown'] as const;
export type ObservationRating = (typeof OBSERVATION_RATING_SCALE)[number];

/** One per-criterion rating against a rubric. `evidence` is MANDATORY + non-empty
 *  (D-002: "mandatory evidence per rated criterion") so a rating is never an
 *  unbacked assertion — `validateObservationRatings` rejects an empty one. */
export interface ObservationRatingEntry {
  /**
   * A value from the criterion's ratingScale (default OBSERVATION_RATING_SCALE).
   * Kept a free `string` (not the enum) so a rubric with a CUSTOM scale still
   * validates — the rubric, not this type, owns the per-criterion vocabulary.
   */
  rating: string;
  /** Concrete evidence backing the rating — a metric, a query result, a cite.
   *  MANDATORY + non-empty. */
  evidence: string;
  /** OPTIONAL grader suggestion (blender-self-learning-2026-07-12 P-005): the
   *  grader's own concrete improvement idea for THIS criterion, born of the
   *  specific context only the grader saw. Folded into the digest's
   *  rubric-rating pattern detail so the Blender's ideators SEE it and can
   *  adopt/adapt it (the owner's "graders also have more specific context"
   *  ruling — the Blender chooses, the grader seeds). */
  suggestion?: string;
}

/**
 * Per-criterion ratings, KEYED by rubric criterion `key` — one rating per
 * criterion (a scorecard). Record (not Array) by D-003: it encodes the
 * "all criteria present" invariant for a fixed-set scorecard, structurally
 * guarantees criterion-uniqueness (an array can double-list / silently drop),
 * and gives O(1) keyed access for the Scout digest grouping + the v2 trend view
 * (jsonb_each is as SQL-friendly as jsonb_array_elements).
 */
export type ObservationRatings = Record<string, ObservationRatingEntry>;

/** v1 free-text observation fields (turn-end-reflection-observations D-005). */
export type ObservationKind = 'friction' | 'workaround' | 'gap' | 'surprise' | 'reinforce';
export type ObservationScope = 'self' | 'role' | 'harness' | 'papercusp';
export type ObservationConfidence = 'low' | 'med' | 'high';

/**
 * The canonical structured-observation v2 record stored at
 * `engineer_issues.payload.observation`. All fields optional — free-text
 * observations carry none of them.
 */
export interface StructuredObservation {
  // ── v1 free-text fields (D-005) — unchanged, still first-class.
  kind?: ObservationKind;
  scope?: ObservationScope;
  confidence?: ObservationConfidence;
  refs?: string[];
  // ── v2 fields (this plan / D-003).
  /**
   * The hive the observation came FROM. Auto-derived from ctx (the agent's
   * hive/harness) by the improvements:capture tool when omitted; explicit
   * callers (Overwatch / Scout) may set it. The Scout digest groups by it (P-006).
   */
  sourceHive?: string;
  /** Optional: the hive the observation is ABOUT (a cross-hive observation). */
  targetHive?: string;
  /**
   * A `rubrics.rubric_id` this observation grades against (e.g.
   * 'pot-coordination-health'). Present ⇒ a rubric-graded observation, and
   * `ratings` must be present + each rating backed by evidence.
   */
  rubricRef?: string;
  /** Per-criterion ratings against `rubricRef` — each carries MANDATORY evidence. */
  ratings?: ObservationRatings;
  /**
   * Stable SHA-256 of the canonical rubricRef + ratings + deterministic instrument
   * snapshots. Written by scorecards:emit so repeated grading of unchanged evidence
   * can be declined without creating a duplicate history row.
   */
  evidenceFingerprint?: string;
  /**
   * The scorecard issue this filing corrects. The target remains in the append-only
   * ledger for audit, but scorecard reads exclude it from the live sample by default.
   */
  supersedes?: string;
  /** A deliberate withdrawal of this scorecard, preserving the original evidence. */
  retracted?: ScorecardRetraction;
  /** Deterministic instrument snapshots attached by scorecards:emit/evaluate. */
  instrumentSnapshots?: Record<string, unknown>;
  /**
   * WHAT this scorecard grades — the per-RUN identity
   * (goal-mode-rubric-v2-2026-08-10 P-009).
   *
   * THE GAP THIS CLOSES: a PER-RUN rubric (goal-mode-e2e grades ONE run of ONE
   * agent) had nowhere structured to say WHICH run a scorecard is about.
   * `sourceHive`/`targetHive` answer which POT, never which RUN, so all five v1
   * goal-mode-e2e scorecards were indistinguishable from each other by field —
   * you could not re-derive one, compare two runs, or even attribute a grade to
   * its subject without reading prose.
   *
   * WHY THIS SHAPE, and not a free-form label: it is exactly the DRILL PARAMETER
   * BINDING. Measured across goal-mode-e2e v2's 25 criteria, the replication
   * drills are parameterized by three things and no others — `:subject` (20
   * criteria), `:run_start` (12), `:run_end` (11). Recording precisely those
   * makes a scorecard RE-RUNNABLE FROM ITS OWN RECORD: a reader can replay every
   * drill that produced it. A looser "notes"-style field would not have that
   * property, which is the whole point.
   *
   * Optional, like every other field here — a pot-level or free-text observation
   * carries no subject and is unaffected.
   */
  subject?: ObservationSubject;
  /**
   * P-008 (EI-20581177540737568): stamped SERVER-SIDE by scorecards:emit when this
   * scorecard rates 'violatable'-class criteria (monotonic-downward — one violation
   * falsifies permanently) without the emitter affirming the graded subject has
   * TERMINATED. A provisional card is a working note (plan D-004): trend/release
   * surfaces exclude it, and the terminal re-emit (terminal:true, superseding this
   * card) is what makes the grading final. Never caller-supplied.
   */
  provisional?: ScorecardProvisional;
  /**
   * The vetting linkage (consult-min-max-and-rubric-vetting-2026-08-17 P-004) —
   * present only on a vetting scorecard (meta-rubric grading of an acceptance
   * rubric; `subject` then names the vetted rubric). Stamped server-side by
   * scorecards:emit after validating the consult + subject rubric exist; never
   * caller-supplied directly. See {@link ScorecardVetting}.
   */
  vetting?: ScorecardVetting;
  /** P-013: the grade-the-grader audit stamp — see {@link ScorecardGradingAudit}. */
  gradingAudit?: ScorecardGradingAudit;
  /**
   * P-011 (owner-ratified D-006): grading-time DETERMINISTIC check runs, keyed by
   * criterion key — stamped server-side by scorecards:emit for every rated criterion
   * whose rubric check is kind:'tests'. Each record is a LIVE run performed at emit
   * time (never a stale ledger read), so a rating the run contradicts is machine-
   * detectable from the scorecard itself. Never caller-supplied.
   */
  checkRuns?: Record<string, ScorecardCheckRun>;
}

/**
 * One criterion's grading-time deterministic check run — see
 * {@link StructuredObservation.checkRuns}. The emit path REFUSES a contradicted
 * pass-claiming rating outright, so a persisted 'fail' verdict coexists only with a
 * rating that honestly reflects it (or a bespoke scale word outside the pass map).
 */
export type ScorecardCheckRun = ScorecardTestsCheckRun | ScorecardCoverageCheckRun;

export interface ScorecardTestsCheckRun {
  kind: 'tests';
  /** The repo-root-relative files that ran. */
  files: string[];
  verdict: 'pass' | 'fail';
  /** Test counts from the run (complete, never truncated). */
  passed: number;
  failed: number;
  /** Run correlation id (PAPERCUSP_TEST_RUN_GROUP) — ledger rows findable by it. */
  runId: string | null;
  /** ISO instant the run finished (emit time). */
  measuredAt: string;
  /** Bounded failing-test names ("file: test"), only on a 'fail' verdict. */
  failures?: string[];
}

/**
 * One criterion's grading-time SURFACE-CENSUS measurement (deterministic-coverage-census
 * P-006). Persisted so the verdict stays auditable after the census itself has moved on.
 *
 * ⚠ Every count here is an aggregate over the WHOLE in-scope population, taken from
 * `readCoverage` — never from its `limit`-capped row list. `belowSurfaces` IS bounded
 * (it is a message, not a measurement), which is exactly why `belowUnwaived` is stored
 * beside it: a reader must be able to see that 3 named surfaces stand for 40.
 */
export interface ScorecardCoverageCheckRun {
  kind: 'coverage';
  /** The scope as RESOLVED at grading time (planTouched already expanded to files). */
  scope: { surfaceKind?: string; sourceFiles?: string[]; planTouched?: true };
  /** The rung asserted — the census's own l1..l4 vocabulary. */
  floor: 'l1' | 'l2' | 'l3' | 'l4';
  verdict: 'pass' | 'fail';
  /** Censused surfaces in scope (the denominator; a 0 here REFUSES rather than passing). */
  surfaces: number;
  /** In-scope surfaces meeting `floor`. */
  meets: number;
  /** In-scope surfaces below `floor` and NOT waived — the pass condition (0 ⇒ pass). */
  belowUnwaived: number;
  /** meets/surfaces as a percentage; NULL when there is no denominator, never 0 or 100. */
  pct: number | null;
  /**
   * The honest ceiling on what the numbers mean. `weakest` is the flimsiest fidelity
   * present in the counted population — 90% over a 'file-only' census is not 90% over a
   * 'declared' one — and a partial census always flatters, because surfaces that were
   * never enumerated cannot appear as gaps.
   */
  fidelity: { weakest: string | null; declaredPct: number | null };
  /** BOUNDED sample of the surfaces below the floor, for the refusal message. */
  belowSurfaces?: string[];
  /** ISO instant the census was read (emit time). */
  measuredAt: string;
}

/** The provisional stamp — see {@link StructuredObservation.provisional}. */
export interface ScorecardProvisional {
  /** The rated 'violatable' criterion keys that make this card provisional. */
  violatableKeys: string[];
  /** ISO instant the stamp was applied (emit time). */
  stampedAt: string;
}

/** What kind of thing a scorecard's `subject` names. Open-ended by design: the
 *  grading substrate is per-run TODAY (agent-run/session), but the same identity
 *  gap applies to grading a work-item, a plan, or a pot. 'rubric' = a vetting
 *  scorecard grading a rubric itself against the meta-rubric
 *  (consult-min-max-and-rubric-vetting-2026-08-17 P-004). */
export type ObservationSubjectKind =
  | 'agent-run'
  | 'session'
  | 'work-item'
  | 'plan'
  | 'pot'
  | 'rubric'
  // P-013 (goal-mode-design-intent-hardening-2026-08-16): a grading-integrity AUDIT
  // scorecard grades another SCORECARD (`ref` = the graded card's issue id).
  | 'scorecard';

/**
 * The vetting linkage stamped by scorecards:emit on a VETTING scorecard — a
 * meta-rubric grading of an acceptance rubric (consult-min-max-and-rubric-vetting-
 * 2026-08-17 P-004). The acceptance gate's `acceptance_rubric_unvetted` check keys
 * off this block: the CURRENT rubric revision must carry a complete meta-scorecard
 * with a linked consult. Stamped server-side only after both halves are validated
 * to exist (a dangling consult or subject rubric is refused at emit, mirroring the
 * acceptance-kind link guards — a dangling link is a booby trap).
 */
/**
 * P-013 (goal-mode-design-intent-hardening-2026-08-16, D-004): the grade-the-grader
 * audit stamp on a TERMINAL standard-rubric scorecard. 'pending' = the grading is
 * final but UNAUDITED — excluded from the trend like a provisional card until a
 * NON-AUTHOR auditor grades it against the grading-integrity meta-rubric (mirror of
 * the acceptance grader ≠ author rule). ONE level deep by construction: the audit
 * card itself (rubricRef = grading-integrity) is never stamped pending.
 */
export interface ScorecardGradingAudit {
  state: 'pending' | 'passed' | 'failed';
  /** The meta-rubric the audit grades against (grading-integrity). */
  metaRubricRef: string;
  stampedAt: string;
  /** The audit scorecard's issue id, once audited. */
  auditIssueId?: string;
  /** The auditor's ownerId (verified ≠ the graded card's author at emit). */
  auditor?: string;
  auditedAt?: string;
}

export interface ScorecardVetting {
  /** conversation_id of the get_feedback consult that critiqued the vetted rubric. */
  consultId: string;
  /** The vetted rubric's plan-row `version` (harness_plans.version) at emit time —
   *  how the gate decides the attestation covers the CURRENT revision. Absent when
   *  the version read failed at emit; the gate then treats the card as NOT current
   *  whenever a current revision IS known (strict toward re-vetting). */
  rubricRevision?: number;
}

/**
 * The graded subject + its measurement window — the binding a replication drill
 * needs to be replayed (`:subject`, `:run_start`, `:run_end`).
 */
export interface ObservationSubject {
  /** What `ref` names. Omitted when the emitter did not classify it. */
  kind?: ObservationSubjectKind;
  /**
   * The graded thing's id — the drills' `:subject`. An ownerId for an agent-run,
   * a session id, a WI-/EI- id, a plan slug, a pot/harness slug. REQUIRED: a
   * subject block that cannot say WHAT it graded is the very gap this closes.
   */
  ref: string;
  /** ISO — start of the graded window; the drills' `:run_start`. */
  windowStart?: string;
  /** ISO — end of the graded window; the drills' `:run_end`. */
  windowEnd?: string;
}

/** Machine-readable scorecard withdrawal metadata. */
export interface ScorecardRetraction {
  at: string;
  by: string;
  reason: string;
}

/** Thrown by `validateObservationRatings` when a rating lacks required evidence
 *  (or a ratings block is malformed). A contract violation, not a soft outcome. */
export class ObservationEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationEvidenceError';
  }
}

/**
 * Enforce D-002's "MANDATORY evidence per rated criterion": every rating in a
 * structured observation MUST carry non-empty `rating` + `evidence`, and a
 * ratings block MUST name its `rubricRef`. Called from the capture CORE so BOTH
 * writers — the improvements:capture tool AND the watchdog — are covered by one
 * gate. Throws `ObservationEvidenceError` on the first offending entry. A
 * free-text / no-rubric observation (no `ratings`, or an empty `ratings`) passes
 * unconditionally — rubrics augment, they never force.
 */
export function validateObservationRatings(obs: StructuredObservation | undefined | null): void {
  if (!obs || typeof obs !== 'object' || !obs.ratings) return;
  const entries = Object.entries(obs.ratings);
  if (entries.length === 0) return;
  if (!obs.rubricRef || !String(obs.rubricRef).trim()) {
    throw new ObservationEvidenceError(
      'a structured observation with ratings must name the rubric it grades against (observation.rubricRef)',
    );
  }
  for (const [criterion, entry] of entries) {
    if (!criterion || !criterion.trim()) {
      throw new ObservationEvidenceError('observation.ratings has an empty criterion key');
    }
    if (!entry || typeof entry !== 'object') {
      throw new ObservationEvidenceError(`observation.ratings['${criterion}'] is not a {rating, evidence} object`);
    }
    if (!entry.rating || !String(entry.rating).trim()) {
      throw new ObservationEvidenceError(`observation.ratings['${criterion}'].rating is required`);
    }
    if (!entry.evidence || !String(entry.evidence).trim()) {
      throw new ObservationEvidenceError(
        `observation.ratings['${criterion}'] is missing required evidence — a rubric rating must cite ` +
          'concrete evidence (a metric, a query result, a reference)',
      );
    }
  }
}

/**
 * Enforce the scorecard COMPLETENESS mandate (plan-templates-and-rubric-v2 P-014a / D-005):
 * a rubric-graded observation (a scorecard) MUST rate EXACTLY the criteria the rubric declares.
 * An omitted criterion is a silent partial-truncation — D-005 caught a pressured Overwatch
 * emitting 3–4 of 13 keys with no error — NOT a pass. A not-assessable criterion is rated
 * 'unknown' (with evidence, e.g. "no signal this wake"), never dropped. The sibling of
 * `validateObservationRatings`: together they make the every-turn "all keys present, each
 * backed by evidence" mandate a RUNTIME gate, not prompt-only.
 *
 * `requiredKeys` is the rubric's criterion `key` set — the CALLER loads it (via getRubric),
 * keeping this leaf sync + rubrics-import-free (no leaf→rubrics dependency). `null` ⇒ the
 * rubric is unknown/unloaded, so completeness can't be enforced → skip (rubricRef *validity*
 * is a separate concern). A free-text / no-rubric / empty-ratings observation passes
 * unconditionally (rubrics augment, never force). Throws `ObservationEvidenceError` (the
 * capture tool catches it into a clean `{ ok:false, error }`), naming missing and
 * unexpected keys. Extras are not harmless metadata: they become permanent fake
 * dimensions in rubric trends (WI-4761 / EI-11617).
 */
export function validateScorecardCompleteness(
  obs: StructuredObservation | undefined | null,
  requiredKeys: string[] | null,
): void {
  if (!obs || typeof obs !== 'object' || !obs.ratings) return;
  const ratedKeys = Object.keys(obs.ratings);
  if (ratedKeys.length === 0) return; // empty ratings → validateObservationRatings owns that case
  if (!requiredKeys || requiredKeys.length === 0) return; // unknown / criteria-less rubric → can't enforce
  const rated = new Set(ratedKeys);
  const required = new Set(requiredKeys);
  const missing = requiredKeys.filter((k) => !rated.has(k));
  const unexpected = ratedKeys.filter((k) => !required.has(k));
  if (missing.length > 0 || unexpected.length > 0) {
    const mismatch = [
      ...(missing.length > 0 ? [`missing required criterion key(s): ${missing.join(', ')}`] : []),
      ...(unexpected.length > 0 ? [`unexpected criterion key(s): ${unexpected.join(', ')}`] : []),
    ].join('; ');
    throw new ObservationEvidenceError(
      `scorecard for rubric '${obs.rubricRef ?? '(unnamed)'}' is INVALID/INCOMPLETE — ${mismatch}. ` +
        `A rubric scorecard must rate exactly the declared criteria (rate a not-assessable one 'unknown' ` +
        `WITH evidence, never omit or invent a key) — a key mismatch corrupts completeness and trend history.`,
    );
  }
}

/**
 * Enforce rating-VALUE validity (rubric-system-improvements-2026-07-12 P-002):
 * every rating in a rubric-graded scorecard must be a value from the criterion's
 * ratingScale (falling back to the rubric's default scale), case-insensitive;
 * 'unknown' is always accepted (the universal not-assessable rating). Without
 * this, a typo'd rating ("pas", "helthy") files fine and is then silently
 * EXCLUDED from trend direction / staleness — the same silent-exclusion class
 * as the P-004 missing-pass-vocabulary bug, but per-filing. The sibling of
 * `validateScorecardCompleteness` and shaped the same way: the CALLER loads the
 * rubric (this leaf stays sync + rubrics-import-free); `null` rubric ⇒ can't
 * validate ⇒ skip. Throws `ObservationEvidenceError` naming the offending key,
 * the bad value, and the allowed values.
 */
export function validateScorecardRatingValues(
  obs: StructuredObservation | undefined | null,
  rubric: {
    ratingScale?: readonly string[];
    criteria: readonly { key: string; ratingScale?: readonly string[] }[];
  } | null,
): void {
  if (!obs || typeof obs !== 'object' || !obs.ratings || !rubric) return;
  const rubricScale = (rubric.ratingScale ?? []).filter((v) => typeof v === 'string' && v.trim());
  const byKey = new Map(rubric.criteria.map((c) => [c.key, c.ratingScale]));
  for (const [criterion, entry] of Object.entries(obs.ratings)) {
    if (!entry || typeof entry !== 'object' || !entry.rating) continue; // evidence gate owns malformed entries
    const scale = (byKey.get(criterion) ?? rubricScale).filter((v) => typeof v === 'string' && v.trim());
    if (scale.length === 0) continue; // scale-less rubric/criterion → nothing to validate against
    const allowed = new Set(scale.map((v) => v.toLowerCase()));
    allowed.add('unknown');
    if (!allowed.has(String(entry.rating).trim().toLowerCase())) {
      const allowedList = allowed.has('unknown') && scale.some((v) => v.toLowerCase() === 'unknown') ? scale : [...scale, 'unknown'];
      throw new ObservationEvidenceError(
        `observation.ratings['${criterion}'].rating '${entry.rating}' is not on the rubric's rating scale — ` +
          `allowed: ${allowedList.join(' | ')}. An off-scale rating would be silently excluded ` +
          'from trends/staleness, so it is rejected at capture instead.',
      );
    }
  }
}

/** The minimal rubric shape needed to canonicalize scorecard rating values. */
export interface ScorecardRatingRubric {
  ratingScale?: readonly string[];
  criteria: readonly { key: string; ratingScale?: readonly string[] }[];
}

/**
 * Resolve a case-insensitive caller rating to the rubric's EXACT canonical spelling.
 * `unknown` is universal; when the rubric omits it we still canonicalize it to the
 * shared lower-case spelling. Unknown/off-scale values are returned unchanged so the
 * existing validation gate can reject them with its teaching error.
 */
export function canonicalScorecardRating(
  rating: string,
  scale: readonly string[] | null | undefined,
): string {
  const trimmed = String(rating).trim();
  const match = (scale ?? []).find((candidate) => candidate.trim().toLowerCase() === trimmed.toLowerCase());
  if (match) return match;
  return trimmed.toLowerCase() === 'unknown' ? 'unknown' : trimmed;
}

/**
 * Canonicalize every rating against its criterion scale (or rubric default). Pure:
 * callers may safely use it at both write and read boundaries, which repairs historic
 * `PASS`/`pass` splits without rewriting the append-only observation ledger.
 */
export function normalizeScorecardRatings(
  ratings: ObservationRatings,
  rubric: ScorecardRatingRubric | null | undefined,
): ObservationRatings {
  if (!rubric) return { ...ratings };
  const rubricScale = rubric.ratingScale ?? [];
  const criterionScales = new Map(rubric.criteria.map((criterion) => [criterion.key, criterion.ratingScale]));
  return Object.fromEntries(
    Object.entries(ratings).map(([criterion, entry]) => [
      criterion,
      {
        ...entry,
        rating: canonicalScorecardRating(entry.rating, criterionScales.get(criterion) ?? rubricScale),
      },
    ]),
  );
}

/**
 * Narrow an unknown `payload.observation` field to the StructuredObservation
 * shape (a cheap structural check, mirroring read-items' isIdeaLifecycle). Used
 * by the READ side to surface the structured view onto a candidate without a
 * hard dependency on how it was written.
 */
export function asStructuredObservation(v: unknown): StructuredObservation | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: StructuredObservation = {};
  if (typeof o.kind === 'string') out.kind = o.kind as ObservationKind;
  if (typeof o.scope === 'string') out.scope = o.scope as ObservationScope;
  if (typeof o.confidence === 'string') out.confidence = o.confidence as ObservationConfidence;
  if (Array.isArray(o.refs)) out.refs = o.refs.filter((x): x is string => typeof x === 'string');
  if (typeof o.sourceHive === 'string' && o.sourceHive.trim()) out.sourceHive = o.sourceHive;
  if (typeof o.targetHive === 'string' && o.targetHive.trim()) out.targetHive = o.targetHive;
  if (typeof o.rubricRef === 'string' && o.rubricRef.trim()) out.rubricRef = o.rubricRef;
  if (o.ratings && typeof o.ratings === 'object' && !Array.isArray(o.ratings)) {
    const ratings: ObservationRatings = {};
    for (const [k, raw] of Object.entries(o.ratings as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      if (typeof e.rating === 'string' && typeof e.evidence === 'string') {
        ratings[k] = {
          rating: e.rating,
          evidence: e.evidence,
          ...(typeof e.suggestion === 'string' && e.suggestion.trim() ? { suggestion: e.suggestion } : {}),
        };
      }
    }
    if (Object.keys(ratings).length > 0) out.ratings = ratings;
  }
  if (typeof o.evidenceFingerprint === 'string' && o.evidenceFingerprint.trim()) {
    out.evidenceFingerprint = o.evidenceFingerprint;
  }
  if (typeof o.supersedes === 'string' && o.supersedes.trim()) {
    out.supersedes = o.supersedes;
  }
  if (o.retracted && typeof o.retracted === 'object' && !Array.isArray(o.retracted)) {
    const r = o.retracted as Record<string, unknown>;
    if (
      typeof r.at === 'string' && r.at.trim() &&
      typeof r.by === 'string' && r.by.trim() &&
      typeof r.reason === 'string' && r.reason.trim()
    ) {
      out.retracted = { at: r.at, by: r.by, reason: r.reason };
    }
  }
  if (o.instrumentSnapshots && typeof o.instrumentSnapshots === 'object' && !Array.isArray(o.instrumentSnapshots)) {
    out.instrumentSnapshots = o.instrumentSnapshots as Record<string, unknown>;
  }
  // P-008: the provisional stamp. violatableKeys is load-bearing (an empty stamp says
  // nothing was provisional), so a malformed block is discarded rather than half-kept.
  if (o.provisional && typeof o.provisional === 'object' && !Array.isArray(o.provisional)) {
    const p = o.provisional as Record<string, unknown>;
    const keys = Array.isArray(p.violatableKeys)
      ? p.violatableKeys.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : [];
    if (keys.length > 0 && typeof p.stampedAt === 'string' && p.stampedAt.trim()) {
      out.provisional = { violatableKeys: keys, stampedAt: p.stampedAt };
    }
  }
  // P-013: the grade-the-grader audit stamp. state + metaRubricRef + stampedAt are
  // load-bearing (a stamp that cannot say WHAT state or AGAINST WHICH meta-rubric is
  // meaningless), so a malformed block is discarded rather than half-kept — same
  // discipline as `provisional` above.
  if (o.gradingAudit && typeof o.gradingAudit === 'object' && !Array.isArray(o.gradingAudit)) {
    const g = o.gradingAudit as Record<string, unknown>;
    if (
      (g.state === 'pending' || g.state === 'passed' || g.state === 'failed') &&
      typeof g.metaRubricRef === 'string' && g.metaRubricRef.trim() &&
      typeof g.stampedAt === 'string' && g.stampedAt.trim()
    ) {
      out.gradingAudit = {
        state: g.state,
        metaRubricRef: g.metaRubricRef,
        stampedAt: g.stampedAt,
        ...(typeof g.auditIssueId === 'string' && g.auditIssueId.trim() ? { auditIssueId: g.auditIssueId } : {}),
        ...(typeof g.auditor === 'string' && g.auditor.trim() ? { auditor: g.auditor } : {}),
        ...(typeof g.auditedAt === 'string' && g.auditedAt.trim() ? { auditedAt: g.auditedAt } : {}),
      };
    }
  }
  // P-009: the graded subject. This parse is an explicit ALLOWLIST — a key absent
  // here is silently dropped on READ even though it persisted fine on write, so
  // the field is invisible to every reader that goes through this narrowing
  // (listScorecards included). `ref` is load-bearing: a subject block without it
  // cannot say what it graded, so it is discarded rather than half-kept.
  if (o.subject && typeof o.subject === 'object' && !Array.isArray(o.subject)) {
    const s = o.subject as Record<string, unknown>;
    if (typeof s.ref === 'string' && s.ref.trim()) {
      out.subject = {
        ref: s.ref,
        ...(typeof s.kind === 'string' && s.kind.trim()
          ? { kind: s.kind as ObservationSubjectKind }
          : {}),
        ...(typeof s.windowStart === 'string' && s.windowStart.trim()
          ? { windowStart: s.windowStart }
          : {}),
        ...(typeof s.windowEnd === 'string' && s.windowEnd.trim() ? { windowEnd: s.windowEnd } : {}),
      };
    }
  }
  // P-004 (consult-min-max-and-rubric-vetting-2026-08-17): the vetting stamp.
  // `consultId` is load-bearing (a vetting block that cannot name its consult is
  // exactly the unlinked attestation the gate refuses), so a malformed block is
  // discarded rather than half-kept — same posture as `provisional` above.
  if (o.vetting && typeof o.vetting === 'object' && !Array.isArray(o.vetting)) {
    const vet = o.vetting as Record<string, unknown>;
    if (typeof vet.consultId === 'string' && vet.consultId.trim()) {
      out.vetting = {
        consultId: vet.consultId,
        ...(typeof vet.rubricRevision === 'number' && Number.isFinite(vet.rubricRevision)
          ? { rubricRevision: vet.rubricRevision }
          : {}),
      };
    }
  }
  // P-011 (D-006): the deterministic check-run stamps. This parse is the same explicit
  // ALLOWLIST as `subject` above — a key absent here is silently dropped on READ even
  // though it persisted fine on write. verdict + files are load-bearing (a run record
  // that cannot say what it judged or how it came out detects nothing), so a malformed
  // entry is discarded rather than half-kept.
  if (o.checkRuns && typeof o.checkRuns === 'object' && !Array.isArray(o.checkRuns)) {
    const runs: Record<string, ScorecardCheckRun> = {};
    for (const [key, raw] of Object.entries(o.checkRuns as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      const files = Array.isArray(r.files)
        ? r.files.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        : [];
      if (
        r.kind === 'tests' &&
        files.length > 0 &&
        (r.verdict === 'pass' || r.verdict === 'fail') &&
        typeof r.passed === 'number' &&
        typeof r.failed === 'number' &&
        typeof r.measuredAt === 'string' &&
        r.measuredAt.trim() !== ''
      ) {
        runs[key] = {
          kind: 'tests',
          files,
          verdict: r.verdict,
          passed: r.passed,
          failed: r.failed,
          runId: typeof r.runId === 'string' && r.runId.trim() ? r.runId : null,
          measuredAt: r.measuredAt,
          ...(Array.isArray(r.failures)
            ? { failures: r.failures.filter((x): x is string => typeof x === 'string') }
            : {}),
        };
      } else if (
        r.kind === 'coverage' &&
        (r.verdict === 'pass' || r.verdict === 'fail') &&
        (r.floor === 'l1' || r.floor === 'l2' || r.floor === 'l3' || r.floor === 'l4') &&
        typeof r.surfaces === 'number' &&
        typeof r.meets === 'number' &&
        typeof r.belowUnwaived === 'number' &&
        typeof r.measuredAt === 'string' &&
        r.measuredAt.trim() !== ''
      ) {
        // Load-bearing on READ: verdict + floor + the three counts. Without them the
        // record cannot say what it judged or how it came out, so a malformed entry is
        // discarded rather than half-kept — the same posture as the tests arm above.
        const rawScope = (r.scope && typeof r.scope === 'object' && !Array.isArray(r.scope)
          ? (r.scope as Record<string, unknown>)
          : {}) as Record<string, unknown>;
        const rawFid = (r.fidelity && typeof r.fidelity === 'object' && !Array.isArray(r.fidelity)
          ? (r.fidelity as Record<string, unknown>)
          : {}) as Record<string, unknown>;
        runs[key] = {
          kind: 'coverage',
          scope: {
            ...(typeof rawScope.surfaceKind === 'string' && rawScope.surfaceKind.trim()
              ? { surfaceKind: rawScope.surfaceKind }
              : {}),
            ...(Array.isArray(rawScope.sourceFiles)
              ? {
                  sourceFiles: rawScope.sourceFiles.filter(
                    (x): x is string => typeof x === 'string' && x.trim() !== '',
                  ),
                }
              : {}),
            ...(rawScope.planTouched === true ? { planTouched: true as const } : {}),
          },
          floor: r.floor,
          verdict: r.verdict,
          surfaces: r.surfaces,
          meets: r.meets,
          belowUnwaived: r.belowUnwaived,
          pct: typeof r.pct === 'number' && Number.isFinite(r.pct) ? r.pct : null,
          fidelity: {
            weakest: typeof rawFid.weakest === 'string' && rawFid.weakest.trim() ? rawFid.weakest : null,
            declaredPct:
              typeof rawFid.declaredPct === 'number' && Number.isFinite(rawFid.declaredPct)
                ? rawFid.declaredPct
                : null,
          },
          ...(Array.isArray(r.belowSurfaces)
            ? { belowSurfaces: r.belowSurfaces.filter((x): x is string => typeof x === 'string') }
            : {}),
          measuredAt: r.measuredAt,
        };
      }
    }
    if (Object.keys(runs).length > 0) out.checkRuns = runs;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
