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
 * a rubric-graded observation (a scorecard) MUST rate EVERY criterion the rubric declares.
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
 * capture tool catches it into a clean `{ ok:false, error }`), naming the missing keys.
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
  const missing = requiredKeys.filter((k) => !rated.has(k));
  if (missing.length > 0) {
    throw new ObservationEvidenceError(
      `scorecard for rubric '${obs.rubricRef ?? '(unnamed)'}' is INCOMPLETE — missing required criterion ` +
        `key(s): ${missing.join(', ')}. A rubric scorecard must rate every criterion (rate a not-assessable ` +
        `one 'unknown' WITH evidence, never omit it) — a partial scorecard is a silent truncation, not a pass.`,
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
      throw new ObservationEvidenceError(
        `observation.ratings['${criterion}'].rating '${entry.rating}' is not on the rubric's rating scale — ` +
          `allowed: ${[...scale, 'unknown'].join(' | ')}. An off-scale rating would be silently excluded ` +
          'from trends/staleness, so it is rejected at capture instead.',
      );
    }
  }
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
        ratings[k] = { rating: e.rating, evidence: e.evidence };
      }
    }
    if (Object.keys(ratings).length > 0) out.ratings = ratings;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
