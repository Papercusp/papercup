/**
 * scorecards — the structured-observation READ surface
 * (plan-templates-and-rubric-v2-2026-06-20 P-013 / D-005).
 *
 * A "scorecard" is a RUBRIC-GRADED structured observation: an
 * `engineer_issues.payload.observation` carrying a `rubricRef` + a `ratings`
 * Record (one rating+evidence per rubric criterion key). The Overwatch emits one
 * every turn against the `pot-coordination-health` rubric; Scout's digest (B9 /
 * rubric-driven-observations P-006) consumes them. Until now they were
 * WRITE-ONLY — invisible except via raw PG (the verification gap D-005 found:
 * partial scorecards + emission stalls could not be seen). This is the READ tool
 * that closes that gap and the linchpin the monitoring layer builds on (P-010
 * trend, P-014 emission-freshness, the Overwatch's own turn-over-turn
 * self-comparison).
 *
 * Reuse-first: the structured shape + parse come from the canonical
 * `observation-types.ts` (`asStructuredObservation`, the same validator the READ
 * path read-items.ts uses); `missingKeys` resolves through the existing
 * `getRubric` (so it survives v2's Phase-3 rubric-as-a-plan re-point — the seam
 * stays, the backing changes). Workspace scope reuses `issuesScopeWorkspace()` so
 * scorecards flip per-workspace exactly like the engineer_issues store they ride.
 */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import {
  asStructuredObservation,
  normalizeScorecardRatings,
  type ObservationRatings,
  type ScorecardRatingRubric,
} from './harness/improvements/observation-types';
import { issuesScopeWorkspace, issuesOutLinksMany } from './issues-engineer';
import { getRubric, rubricInstrumentContract, type Rubric, type RubricStatus } from './rubrics';

/** The owner-mandated built-in rubric whose prompt/backstop contract is fixed. */
export const HIVE_COORDINATION_HEALTH_RUBRIC = 'pot-coordination-health';

/** One deterministic measurement attached to a scorecard evaluation/emission. */
export interface ScorecardInstrumentSnapshot {
  verdict: 'pass' | 'fail' | 'unknown';
  measuredAt: string;
  /** Concrete evidence window/provenance, kept JSON-shaped for instrument diversity. */
  window?: Record<string, unknown>;
  /** Bounded deterministic measurement (count/rate/status payload). */
  value?: unknown;
  /** Stable ledger/query/run reference supporting the snapshot. */
  evidenceRef?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Stable evidence identity used by scorecards:evaluate/emit. Timestamps that are
 * measurement DATA remain significant; object insertion order and criterion order do
 * not. This keeps append-only history meaningful while declining byte-shuffled repeats.
 */
export function scorecardEvidenceFingerprint(input: {
  rubricRef: string;
  ratings: ObservationRatings;
  instrumentSnapshots?: Record<string, ScorecardInstrumentSnapshot>;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        rubricRef: input.rubricRef,
        ratings: input.ratings,
        instrumentSnapshots: input.instrumentSnapshots ?? {},
      }),
    )
    .digest('hex');
}

export interface ScorecardInstrumentContractEvaluation {
  valid: boolean;
  bindings: Record<string, string | null>;
  missingBindings: string[];
  duplicateBindings: string[];
  missingSnapshots: string[];
  extraSnapshots: string[];
  staleSnapshots: string[];
  windowMismatches: string[];
  verdictMismatches: string[];
}

function expectedInstrumentVerdict(rating: string): ScorecardInstrumentSnapshot['verdict'] | null {
  const key = rating.trim().toLowerCase();
  if (['pass', 'healthy', 'green', 'good', 'yes', 'exemplary', 'exceptional'].includes(key)) return 'pass';
  if (['fail', 'broken', 'red', 'bad', 'no', 'severe'].includes(key)) return 'fail';
  if (key === 'unknown') return 'unknown';
  return null;
}

/**
 * Validate the one-criterion↔one-instrument contract and the evidence freshness/window
 * that a release-gating scorecard claims. UNKNOWN or stale evidence is never silently
 * green: callers get exact missing/stale/mismatch arrays and must fix them before emit.
 */
export function evaluateScorecardInstrumentContract(input: {
  rubric: Rubric;
  ratings: ObservationRatings;
  instrumentSnapshots?: Record<string, ScorecardInstrumentSnapshot>;
  nowMs?: number;
}): ScorecardInstrumentContractEvaluation {
  const contract = rubricInstrumentContract(input.rubric);
  const snapshots = input.instrumentSnapshots ?? {};
  const required = new Set(
    Object.values(contract.bindings).filter((key): key is string => Boolean(key) && key !== 'none'),
  );
  const missingSnapshots = [...required].filter((key) => !snapshots[key]);
  const extraSnapshots = Object.keys(snapshots).filter((key) => !required.has(key));
  const staleSnapshots: string[] = [];
  const windowMismatches: string[] = [];
  const verdictMismatches: string[] = [];
  const nowMs = input.nowMs ?? Date.now();

  for (const criterion of input.rubric.criteria) {
    const instrumentKey = contract.bindings[criterion.key];
    if (!instrumentKey || instrumentKey === 'none') continue;
    const snapshot = snapshots[instrumentKey];
    if (!snapshot) continue;
    const measuredAtMs = Date.parse(snapshot.measuredAt);
    if (!Number.isFinite(measuredAtMs) || measuredAtMs > nowMs + 60_000) {
      staleSnapshots.push(instrumentKey);
      continue;
    }
    if (criterion.window?.kind === 'rolling') {
      const rollingMs = criterion.window.ms;
      if (typeof rollingMs !== 'number' || !Number.isFinite(rollingMs) || rollingMs <= 0) {
        windowMismatches.push(instrumentKey);
      } else if (nowMs - measuredAtMs > rollingMs) {
        staleSnapshots.push(instrumentKey);
      }
    } else if (criterion.window?.kind === 'post-watermark') {
      const window = snapshot.window ?? {};
      const sinceMs = typeof window.sinceMs === 'number' ? window.sinceMs : null;
      const watermarkRef = typeof window.watermarkRef === 'string' ? window.watermarkRef : null;
      if (
        watermarkRef !== criterion.window.watermarkRef ||
        sinceMs === null ||
        !Number.isFinite(sinceMs) ||
        measuredAtMs < sinceMs
      ) {
        windowMismatches.push(instrumentKey);
      }
    }
    const expected = expectedInstrumentVerdict(input.ratings[criterion.key]?.rating ?? '');
    if (expected && expected !== snapshot.verdict) verdictMismatches.push(instrumentKey);
  }

  return {
    valid:
      contract.valid &&
      missingSnapshots.length === 0 &&
      extraSnapshots.length === 0 &&
      staleSnapshots.length === 0 &&
      windowMismatches.length === 0 &&
      verdictMismatches.length === 0,
    bindings: contract.bindings,
    missingBindings: contract.criteriaWithoutInstrument,
    duplicateBindings: contract.duplicateInstrumentKeys,
    missingSnapshots,
    extraSnapshots,
    staleSnapshots: [...new Set(staleSnapshots)],
    windowMismatches: [...new Set(windowMismatches)],
    verdictMismatches: [...new Set(verdictMismatches)],
  };
}

/** The canonical 14 keys for pot-coordination-health. This is a fallback for
 * read-side completeness only: if the rubric-template store is temporarily
 * unreachable/unresolvable, the monitor-of-monitor must not mark a 14-key
 * owner-mandated scorecard partial. Unknown rubrics still stay unresolved. */
export const HIVE_COORDINATION_HEALTH_KEYS = [
  'end-to-end-flow',
  'ideation-quality',
  'queen-workitem-selection',
  'queen-plan-selection',
  'parallel-distribution',
  'bee-execution',
  'bee-observation-quality',
  'overwatch-observation-quality',
  'watchdog-determinism',
  'coordination-comms',
  'chatter-economy',
  'coordination-utilization',
  'tool-utilization',
  'scheduler-usage',
] as const;

export function builtInCriterionKeysForRubric(rubricRef: string): string[] | null {
  return rubricRef === HIVE_COORDINATION_HEALTH_RUBRIC ? [...HIVE_COORDINATION_HEALTH_KEYS] : null;
}

/** One scorecard row — a rubric-graded observation projected for monitoring. */
export interface ScorecardRow {
  /** The engineer_issue id (EI-/WI-…) — the drill-back key. */
  issueId: string;
  /** ISO timestamp the scorecard was filed. */
  createdAt: string;
  /** Who emitted it (ownerId), when recorded. */
  createdBy: string | null;
  /** The hive the observation came FROM (the grouping axis), when set. */
  sourceHive?: string;
  /** The rubric graded against (a `rubrics.rubric_id`). */
  rubricRef: string;
  /** Per-criterion ratings, keyed by rubric criterion `key` (each {rating, evidence}). */
  ratings: ObservationRatings;
  /** How many criteria this scorecard rated (`Object.keys(ratings).length`). */
  nKeys: number;
  /**
   * Rubric criterion keys the scorecard did NOT rate — the completeness signal
   * (P-014's gate reads this). Empty when the scorecard is complete OR when the
   * rubric can't be resolved (then `rubricResolved` is false, so an empty list is
   * never misread as "complete"). Sorted in the rubric's own criteria order.
   */
  missingKeys: string[];
  /**
   * Rated keys that the current rubric does NOT declare. Historical malformed
   * scorecards remain auditable, but are incomplete and never become trend axes.
   */
  extraKeys: string[];
  /** Whether `rubricRef` resolved to a known rubric (so `missingKeys` is meaningful). */
  rubricResolved: boolean;
  /** Stable canonical evidence identity when filed through scorecards:emit. */
  evidenceFingerprint?: string;
  /**
   * True when this scorecard is a SYNTHESIZED floor (`payload.observation.synthesized`),
   * not an agent emission — the deterministic backstop filed by overwatch/scorecard-backstop
   * when an Overwatch turn ended without one. EXCLUDED by default (see `includeSynthesized`)
   * so the agent-emission freshness/trend/staleness signals never count the floor as the
   * agent doing its job.
   */
  synthesized: boolean;
  /**
   * READ-TIME 0–10 projection of this scorecard (rubrics-tab-scorecard-ui-2026-07-09
   * P-004 / D-001): the mean of the per-criterion numeric projections
   * ({@link ratingScore10}) over the criteria whose rating maps (unknown/custom
   * ratings are excluded, never counted as 0). Null when NO rating maps. Grading
   * stays CATEGORICAL at capture time — this number is derived on read, so past
   * scorecards get it automatically (numeric "backfill" with no migration).
   */
  score10: number | null;
  /**
   * Outbound coord_links edges from this scorecard's issue (WI-3594: the
   * scorecard→improvement flow) — e.g. a `relates`/`fixes` edge to the
   * improvement/work-item this grading is about, when one was linked at file
   * time (via `improvements:capture`'s `observation.linkTo`, or `work_items:link`
   * after the fact). Empty when nothing is linked; excludes `tagged` (topic tags
   * are not references).
   */
  linkedItems: { rel: string; dst: { kind: string; ref: string } }[];
  /**
   * The GENERATION this scorecard graded (EI-12147; reworked WI-5397): stamped
   * SERVER-SIDE by improvements:capture at file time (never caller-supplied) via
   * generation-watermark.ts's readRunningGeneration(). A reader comparing an older
   * `hostStartedAt` to the current one knows the scorecard judged a DIFFERENT
   * generation (stale evidence after a restart/deploy), which is the ambiguity
   * that stalled the 2026-07-14 GO call. WI-5397 widened the stamp to make that
   * staleness EXPLICIT (`staleHost`) instead of relying on the reader to notice a
   * hostStartedAt mismatch by hand — see generation-watermark.ts's RunningGeneration
   * doc comment for the full shape rationale. Absent on pre-stamp scorecards.
   */
  gradedGeneration?: GradedGeneration;
}

/** The projected {@link parseGradedGeneration} shape — see RunningGeneration
 *  (generation-watermark.ts) for what each field means. `bootHeadSha`/`scoutCodeHash`/
 *  `staleHost` are optional: a pre-WI-5397 stamp (or a row this parser degrades) never
 *  carried them, so their ABSENCE means "not recorded", never "known false/null". */
export interface GradedGeneration {
  deployedSha: string | null;
  hostStartedAt: string | null;
  bootHeadSha?: string | null;
  scoutCodeHash?: string | null;
  staleHost?: boolean;
}

/**
 * PURE: validate a raw payload `gradedGeneration` into the projected shape.
 * Backward-compatible with pre-WI-5397 rows, which carried `{ sha, hostStartedAt }`
 * only — `sha` is read as `deployedSha` when the new key is absent (a read-time
 * projection of history, not a write-time shim: every NEW stamp writes
 * `deployedSha` directly). Anything unparseable (malformed / absent / pre-stamp
 * rows) is null so a bad row degrades, never throws.
 */
export function parseGradedGeneration(raw: unknown): GradedGeneration | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const deployedShaRaw = 'deployedSha' in o ? o.deployedSha : o.sha;
  const deployedSha = typeof deployedShaRaw === 'string' && deployedShaRaw ? deployedShaRaw : null;
  const hostStartedAt = typeof o.hostStartedAt === 'string' && o.hostStartedAt ? o.hostStartedAt : null;
  const bootHeadSha = typeof o.bootHeadSha === 'string' && o.bootHeadSha ? o.bootHeadSha : null;
  const scoutCodeHash = typeof o.scoutCodeHash === 'string' && o.scoutCodeHash ? o.scoutCodeHash : null;
  const staleHost = typeof o.staleHost === 'boolean' ? o.staleHost : undefined;
  // An all-null/absent stamp carries no identity at all.
  if (deployedSha === null && hostStartedAt === null && bootHeadSha === null && scoutCodeHash === null) return null;
  return {
    deployedSha,
    hostStartedAt,
    ...(bootHeadSha !== null ? { bootHeadSha } : {}),
    ...(scoutCodeHash !== null ? { scoutCodeHash } : {}),
    ...(staleHost !== undefined ? { staleHost } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Numeric projection (P-004 / D-001) — capture stays categorical; 0–10 is a
// READ-TIME projection so history is "backfilled" for free and the categorical
// evidence trail stays the source of truth.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The default rating→score map, covering the shared rating vocabularies
 * (pass/partial/fail and healthy/degraded/broken plus common synonyms).
 * `unknown` and any unmapped custom rating project to null (EXCLUDED from
 * means — an unassessed criterion must never drag a score toward 0).
 * A rubric wanting different weights passes `overrides` (per-rubric map).
 */
export const DEFAULT_RATING_SCORE10: Record<string, number> = {
  exemplary: 10, exceptional: 10,
  pass: 10, healthy: 10, good: 10, yes: 10, green: 10,
  partial: 5, degraded: 5, mixed: 5, warn: 5,
  fail: 0, broken: 0, bad: 0, no: 0, red: 0,
  severe: 0,
};

/** Project one categorical rating to 0–10 (null = unmapped/excluded). */
export function ratingScore10(rating: string, overrides?: Record<string, number>): number | null {
  const key = rating.toLowerCase();
  const v = overrides?.[key] ?? DEFAULT_RATING_SCORE10[key];
  return v === undefined ? null : v;
}

/**
 * The extended-scale re-map: a rubric whose ratingScale carries the EXTENDED
 * vocabulary (exemplary above pass / severe below fail) spreads its five levels
 * monotonically — exemplary 10 / pass 8 / partial 5 / fail 2 / severe 0.
 * A plain pass/partial/fail rubric keeps pass=10/fail=0: pass IS its ceiling,
 * so its historical projections never shift when OTHER rubrics adopt the
 * extended scale.
 */
export const EXTENDED_SCALE_OVERRIDES: Record<string, number> = { pass: 8, fail: 2 };

/**
 * Derive the per-rubric score overrides from the rubric's own ratingScale
 * (scale-aware read-time projection): extended vocabulary present → the
 * {@link EXTENDED_SCALE_OVERRIDES} re-map; otherwise undefined (default map fits).
 */
export function scoreOverridesForScale(
  ratingScale: readonly string[] | null | undefined,
): Record<string, number> | undefined {
  if (!ratingScale?.length) return undefined;
  const s = ratingScale.map((r) => r.toLowerCase());
  return s.includes('exemplary') || s.includes('severe') ? EXTENDED_SCALE_OVERRIDES : undefined;
}

/**
 * A whole scorecard's 0–10 score: the mean of its mappable criterion ratings,
 * rounded to 1 decimal. Null when no rating maps (e.g. an all-unknown idle
 * scorecard — "no signal", not "0/10").
 */
export function scorecardScore10(
  ratings: Record<string, { rating: string }>,
  overrides?: Record<string, number>,
): number | null {
  const nums = Object.values(ratings)
    .map((r) => ratingScore10(r.rating, overrides))
    .filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

export interface ListScorecardsFilter {
  /** Restrict to one rubric (e.g. 'pot-coordination-health'). */
  rubricRef?: string;
  /** Restrict to scorecards from one source-hive. */
  sourceHive?: string;
  /** Only scorecards filed at/after this ISO timestamp (the time-window). */
  since?: string;
  /** Max rows (newest-first). Default 100, max 500. */
  limit?: number;
  /**
   * Include SYNTHESIZED floor scorecards (`payload.observation.synthesized`). Default
   * FALSE — every monitoring consumer (the agent-emission freshness detector, the trend,
   * the staleness signal, Scout's digest) reads AGENT scorecards only, so the deterministic
   * floor (overwatch/scorecard-backstop) never masks an agent skip nor pollutes the trend.
   * Set true only for an explicit "did the monitor speak at all (incl. the floor)" read.
   */
  includeSynthesized?: boolean;
}

interface ScorecardRowDb {
  issue_id: string;
  created_by: string | null;
  created_at: string | Date;
  payload: unknown | null;
}

function tsIso(v: string | Date): string {
  return typeof v === 'string' ? v : v.toISOString();
}

/**
 * List rubric-graded scorecards (newest-first), optionally filtered by rubric,
 * source-hive, and time-window. A direct, workspace-scoped jsonb query over
 * `engineer_issues` (only rows whose `payload.observation.rubricRef` is set —
 * indexed by the sourceHive backfill), parsed through the canonical
 * `asStructuredObservation`, with `missingKeys` resolved via `getRubric`
 * (cached per rubric within the call). Organic emissions only — synthetic
 * (drill/replay/shadow) scorecards are not real Overwatch output and must not
 * pollute the monitoring read (mirrors read-items.ts's organic provenance gate;
 * a NULL origin reads organic, the backfill default).
 */
export async function listScorecards(filter: ListScorecardsFilter = {}): Promise<ScorecardRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);

  const rows = await sql<ScorecardRowDb[]>`
    SELECT issue_id, created_by, created_at, payload
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND COALESCE(signal_origin, 'organic') = 'organic'
       AND payload -> 'observation' ->> 'rubricRef' IS NOT NULL
       AND ${filter.rubricRef ? sql`payload -> 'observation' ->> 'rubricRef' = ${filter.rubricRef}` : sql`TRUE`}
       AND ${filter.sourceHive ? sql`payload -> 'observation' ->> 'sourceHive' = ${filter.sourceHive}` : sql`TRUE`}
       AND ${filter.since ? sql`created_at >= ${filter.since}` : sql`TRUE`}
       AND ${filter.includeSynthesized ? sql`TRUE` : sql`payload -> 'observation' ->> 'synthesized' IS DISTINCT FROM 'true'`}
     ORDER BY created_at DESC
     LIMIT ${limit}`;

  // Resolve each distinct rubric ONCE (a scorecard read touches a handful of rubrics):
  // its criterion keys (completeness) + its scale-aware score overrides (projection).
  const rubricMeta = new Map<
    string,
    {
      keys: string[] | null;
      overrides?: Record<string, number>;
      ratingRubric: ScorecardRatingRubric | null;
    }
  >();
  const out: ScorecardRow[] = [];
  // WI-3594: batch-fetch every row's outbound links in ONE query (no N+1) rather
  // than a per-row listOut — a scorecard page can be up to `limit` (500) rows.
  const linksByIssue = await issuesOutLinksMany(rows.map((r) => r.issue_id));

  for (const row of rows) {
    const observation = asStructuredObservation((row.payload as { observation?: unknown } | null)?.observation);
    // The SQL guarantees rubricRef is set, but parse defensively (a malformed
    // payload yields no structured view) so a bad row degrades, never throws.
    if (!observation?.rubricRef || !observation.ratings) continue;
    if (!rubricMeta.has(observation.rubricRef)) {
      const rubric = await getRubric(observation.rubricRef);
      rubricMeta.set(observation.rubricRef, {
        keys: rubric ? rubric.criteria.map((c) => c.key) : builtInCriterionKeysForRubric(observation.rubricRef),
        overrides: scoreOverridesForScale(rubric?.ratingScale),
        ratingRubric: rubric
          ? { ratingScale: rubric.ratingScale, criteria: rubric.criteria }
          : null,
      });
    }
    const meta = rubricMeta.get(observation.rubricRef)!;
    // Canonical READ boundary: historic `PASS`/`pass` rows project to the rubric's
    // exact scale spelling, so distributions, RLE, and direction math never split a
    // semantic rating merely because an older writer used different case.
    const ratings = normalizeScorecardRatings(observation.ratings, meta.ratingRubric);
    const ratedKeys = new Set(Object.keys(ratings));
    const criteriaKeys = meta.keys;
    const rubricResolved = criteriaKeys !== null;
    const missingKeys = rubricResolved ? criteriaKeys!.filter((k) => !ratedKeys.has(k)) : [];
    const criterionKeySet = rubricResolved ? new Set(criteriaKeys!) : null;
    const extraKeys = criterionKeySet ? [...ratedKeys].filter((k) => !criterionKeySet.has(k)) : [];
    // Preserve raw ratings for audit, but project the numeric score only across
    // the rubric's declared dimensions. A historical extra must not inflate or
    // depress the score while still being visible via `extraKeys`.
    const projectionRatings = criterionKeySet
      ? Object.fromEntries(Object.entries(ratings).filter(([k]) => criterionKeySet.has(k)))
      : ratings;
    // Read the synthesized marker from the RAW payload (not the parsed observation,
    // which may strip unknown keys) so the floor stays distinguishable.
    const synthRaw = (row.payload as { observation?: { synthesized?: unknown } } | null)?.observation?.synthesized;
    const synthesized = synthRaw === true || synthRaw === 'true';
    // EI-12147: the generation stamp, also from the RAW payload — the parsed structured
    // observation may strip keys it does not know.
    const gradedGeneration = parseGradedGeneration(
      (row.payload as { observation?: { gradedGeneration?: unknown } } | null)?.observation?.gradedGeneration,
    );

    out.push({
      issueId: row.issue_id,
      createdAt: tsIso(row.created_at),
      createdBy: row.created_by,
      ...(observation.sourceHive ? { sourceHive: observation.sourceHive } : {}),
      rubricRef: observation.rubricRef,
      ratings,
      nKeys: ratedKeys.size,
      missingKeys,
      extraKeys,
      rubricResolved,
      ...(observation.evidenceFingerprint ? { evidenceFingerprint: observation.evidenceFingerprint } : {}),
      synthesized,
      score10: scorecardScore10(projectionRatings, meta.overrides),
      linkedItems: linksByIssue.get(row.issue_id) ?? [],
      ...(gradedGeneration ? { gradedGeneration } : {}),
    });
  }

  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Trend aggregation (P-010) — the qualitative health TREND over the scorecard
// time-series. The "data already exists" quick-win: every-turn scorecards ARE a
// per-criterion rating time-series; this rolls them up per criterion + computes
// a direction so the Queen/owner sees "queen-placement-health: degraded, worsening
// over 5 ratings / 3 days" instead of re-reading raw scorecards.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Trend direction over the window, from the FIRST→LATEST assessable rating:
 *  - improving  — severity fell (e.g. broken → degraded → healthy)
 *  - worsening  — severity rose (e.g. healthy → degraded → broken)
 *  - stable     — first and latest assessable ratings are equal
 *  - unknown    — fewer than 2 assessable ratings (can't tell a direction)
 * It is the NET first→latest trend; the RLE `series` (opt-in, `includeSeries`) shows
 * the within-window oscillation the single direction summarises.
 */
export type TrendDirection = 'improving' | 'worsening' | 'stable' | 'unknown';

/** Default-scale ordinal severity (healthy < degraded < broken; pass < partial < fail
 *  — the pass vocabulary was MISSING until P-004, so every pass-scale rubric's
 *  direction silently read 'unknown'). `unknown` and any custom per-criterion rating
 *  are NOT ordered (returns null → excluded from the direction calc) — only the
 *  shared default vocabularies have a meaningful order. */
const TREND_SEVERITY: Record<string, number> = {
  exemplary: -1, exceptional: -1,
  healthy: 0, degraded: 1, broken: 2,
  pass: 0, partial: 1, fail: 2,
  severe: 3,
};
function trendSeverity(rating: string): number | null {
  const s = TREND_SEVERITY[rating.toLowerCase()];
  return s === undefined ? null : s;
}

/**
 * An IDLE unknown: the grader saying "this stage did not RUN" (no signal),
 * vs a bare unknown = "I cannot assess it" (the drift signal staleness needs).
 * Canonical form is the `idle:` evidence prefix (EI-7624), but the convention
 * only surfaces in rubrics:trend's description — graders naturally write
 * "not exercised…" instead and silently poison staleness (rubric-system-
 * improvements-2026-07-12 P-001: three real scorecards did exactly that on
 * day one). Normalized READ-time so already-filed scorecards are fixed
 * retroactively: common not-run phrasings at the START of the evidence count
 * as idle. Exported for unit tests.
 */
export function isIdleUnknown(rating: string, evidence: string | undefined): boolean {
  if (rating.toLowerCase() !== 'unknown') return false;
  return /^\s*(idle\s*:|not\s+(exercised|applicable|assessable|observed)\b|n\/a\b|not\s+apply)/i.test(
    evidence ?? '',
  );
}

/**
 * The net first→latest trend direction of a chronological rating series (default
 * ordinal healthy<degraded<broken; `unknown`/custom ratings are excluded as
 * unassessable). Exported so the (pure, DB-free) direction logic is unit-tested
 * exhaustively; `scorecardTrend` applies it per criterion.
 */
export function computeTrendDirection(series: readonly { at: string; rating: string }[]): TrendDirection {
  const assessable = series.map((s) => trendSeverity(s.rating)).filter((s): s is number => s !== null);
  if (assessable.length < 2) return 'unknown';
  const first = assessable[0];
  const last = assessable[assessable.length - 1];
  if (last > first) return 'worsening';
  if (last < first) return 'improving';
  return 'stable';
}

/**
 * One run of consecutive identical ratings — the series' run-length encoding.
 * A 500-scorecard series is mostly long runs of one rating, so RLE keeps the
 * within-window oscillation signal at ~10× less payload than per-scorecard
 * entries (WI-2943: the raw series made every realistic rubrics:trend result
 * blow the MCP token cap).
 */
export interface SeriesRun {
  rating: string;
  /** Timestamp of the first scorecard in the run (chronological). */
  from: string;
  /** Timestamp of the last scorecard in the run. */
  to: string;
  /** # consecutive scorecards in the run. */
  n: number;
}

/** Run-length encode a chronological rating series (WI-2943). Pure; exported for tests. */
export function compressSeries(series: readonly { at: string; rating: string }[]): SeriesRun[] {
  const runs: SeriesRun[] = [];
  for (const s of series) {
    const last = runs[runs.length - 1];
    if (last && last.rating === s.rating) {
      last.to = s.at;
      last.n += 1;
    } else {
      runs.push({ rating: s.rating, from: s.at, to: s.at, n: 1 });
    }
  }
  return runs;
}

/** One criterion's standing over the window: its rating series + trend direction. */
export interface CriterionTrend {
  criterion: string;
  /** # scorecards (in-window) that rated this criterion. */
  count: number;
  /** rating value → how many scorecards gave it. */
  distribution: Record<string, number>;
  /**
   * # in-window ratings that are IDLE-tagged unknowns: rating 'unknown' with
   * evidence prefixed `idle:` — the grader saying "this stage did not RUN in the
   * window" (no signal), not "I cannot assess it" (drift signal). Excluded from
   * the staleness calc (EI-7624: an idle/frozen hive flatlined 6 criteria to
   * 'unknown' and false-positived the model-drift detector).
   */
  idleCount: number;
  /** The earliest rating in the window (chronological). */
  first: { rating: string; at: string };
  /** The most-recent rating in the window. */
  latest: { rating: string; at: string };
  /** Net first→latest trend (see {@link TrendDirection}). */
  direction: TrendDirection;
  /**
   * Mean 0–10 numeric projection over the window's mappable ratings
   * (P-004 / D-001 read-time scale; unknown/custom excluded, null when none map).
   */
  mean10: number | null;
  /**
   * The criterion's machine-readable instrument binding, parsed from a trailing
   * `[instrumentKey: <key>|none]` token on the rubric criterion's `model` (WI-4607).
   * A real key = the concrete instrument that grades this criterion; `'none'` =
   * explicitly un-instrumented; `null`/absent = the criterion definition carries no
   * such token. Lets the trend view show which instrument backs each criterion.
   */
  instrumentKey?: string | null;
  /** The chronological series as RLE runs (oldest → newest). Only present when
   *  requested (`includeSeries`, WI-2943) — the summary fields above are the
   *  default payload. */
  series?: SeriesRun[];
}

// ───────────────────────────────────────────────────────────────────────────
// Staleness signal (P-011 / D-004) — flag a rubric whose MODEL has drifted from
// reality. The signal: criteria the Overwatch persistently rates 'unknown' (it
// cannot ASSESS them) — the rubric's model/method for that criterion no longer
// matches how the system works. A stale rubric re-enters the queen↔scout loop for
// re-ratification (a new revision). "Start with a simple flag; don't over-automate"
// (D-004): this is detection only — surfaced on rubrics:trend so the Queen decides.
//
// Why 'unknown' (not persistent 'broken'): an unassessable criterion means the
// rubric drifted; a persistently-BROKEN criterion usually means the SYSTEM is broken
// (a real finding the trend's worsening/broken distribution already surfaces) — NOT a
// stale rubric. Defaulting to 'unknown' avoids false-positiving staleness onto a
// working rubric correctly reporting a broken system. Override `staleRatings` to widen.
// ───────────────────────────────────────────────────────────────────────────

/** One criterion flagged as stale (persistently unassessable). */
export interface CriterionStaleness {
  criterion: string;
  /** Fraction of NON-IDLE in-window ratings that are a "stale" rating (default 'unknown'). */
  staleFraction: number;
  /** # non-idle in-window ratings for this criterion (the evidence base). */
  samples: number;
  /** # idle-tagged unknowns excluded from the calc (see {@link CriterionTrend.idleCount}). */
  idleExcluded: number;
  reason: string;
}

/** A rubric's staleness assessment over the scorecard window. */
export interface RubricStaleness {
  /** true when ≥1 criterion is flagged stale — the rubric's model may have drifted. */
  stale: boolean;
  /** The criteria flagged stale + why (empty when not stale). */
  staleCriteria: CriterionStaleness[];
  /** Human-readable rubric-level summary. */
  reason: string;
}

export interface RubricStalenessOpts {
  /** Min in-window ratings for a criterion before staleness is judged (default 3) —
   *  too few ratings is "unknown", not "stale". */
  minSamples?: number;
  /** Stale-rating fraction at/above which a criterion is flagged (default 0.5). */
  staleFraction?: number;
  /** Ratings that count as "stale" evidence (default ['unknown']). Case-insensitive. */
  staleRatings?: readonly string[];
}

const STALENESS_DEFAULTS = {
  minSamples: 3,
  staleFraction: 0.5,
  staleRatings: ['unknown'] as readonly string[],
};

/**
 * Detect rubric staleness from its per-criterion trends (P-011). A criterion with
 * ≥ `minSamples` in-window ratings of which ≥ `staleFraction` are a stale rating
 * (default 'unknown') is flagged — the Overwatch keeps being unable to assess it, so
 * the rubric's model for it no longer matches reality. Pure (DB-free) so it unit-tests
 * exhaustively; `scorecardTrend` applies it over the criteria it builds.
 */
export function computeRubricStaleness(
  criteria: readonly CriterionTrend[],
  opts: RubricStalenessOpts = {},
): RubricStaleness {
  const minSamples = opts.minSamples ?? STALENESS_DEFAULTS.minSamples;
  const staleFraction = opts.staleFraction ?? STALENESS_DEFAULTS.staleFraction;
  const staleRatings = new Set(
    (opts.staleRatings ?? STALENESS_DEFAULTS.staleRatings).map((r) => r.toLowerCase()),
  );

  const staleCriteria: CriterionStaleness[] = [];
  for (const c of criteria) {
    // Idle-tagged unknowns are "the stage did not run" — no signal either way
    // (EI-7624). Exclude them from BOTH sides of the fraction, so a mostly-idle
    // window neither manufactures staleness nor dilutes a real drift signal in
    // the few non-idle samples.
    const idle = staleRatings.has('unknown') ? (c.idleCount ?? 0) : 0;
    const samples = c.count - idle;
    if (samples < minSamples) continue; // too little non-idle evidence → not "stale", just quiet
    const rawStale = Object.entries(c.distribution).reduce(
      (n, [rating, k]) => (staleRatings.has(rating.toLowerCase()) ? n + k : n),
      0,
    );
    const staleCount = rawStale - idle;
    const fraction = staleCount / samples;
    if (fraction >= staleFraction) {
      staleCriteria.push({
        criterion: c.criterion,
        staleFraction: fraction,
        samples,
        idleExcluded: idle,
        reason: `${staleCount}/${samples} recent non-idle ratings are ${[...staleRatings].join('/')}${idle > 0 ? ` (${idle} idle-tagged excluded)` : ''} — the criterion's model may no longer match how the system works`,
      });
    }
  }

  const stale = staleCriteria.length > 0;
  return {
    stale,
    staleCriteria,
    reason: stale
      ? `${staleCriteria.length} criteri${staleCriteria.length === 1 ? 'on' : 'a'} persistently unassessable (${staleCriteria
          .map((s) => s.criterion)
          .join(', ')}) — the rubric model may have drifted; re-ratify via the queen↔scout loop`
      : 'no staleness detected (criteria are being assessed)',
  };
}

/** A rubric's qualitative health trend — per-criterion rating time-series + direction. */
export interface RubricTrend {
  rubricRef: string;
  sourceHive?: string;
  /** # scorecards aggregated in the window. */
  scorecardCount: number;
  /** The observed time span (oldest..newest scorecard) + the requested `since`. */
  window: { since?: string; from?: string; to?: string };
  /** Per-criterion trends, criterion key ASC (stable output). */
  criteria: CriterionTrend[];
  /** Governance provenance (WI-4607, D-012): the rubric's status + who proposed vs.
   *  ratified it, so the detail panel can surface author≠ratifier the same way the
   *  RubricsPanel list does. Sourced from the same getRubric() read the mean10 scale
   *  projection already runs — no extra store hit. Absent only for a missing rubric. */
  status?: RubricStatus;
  proposedBy?: string | null;
  ratifiedBy?: string | null;
  /** Staleness signal (P-011): criteria the Overwatch persistently can't assess,
   *  suggesting the rubric's model has drifted and should re-enter the queen↔scout
   *  loop for re-ratification. */
  staleness: RubricStaleness;
}

export interface ScorecardTrendFilter {
  /** The rubric to trend (required — a trend is per-rubric). */
  rubricRef: string;
  /** Restrict to one source-hive (trends are per-hive when set). */
  sourceHive?: string;
  /** Only scorecards filed at/after this ISO timestamp (the window). */
  since?: string;
  /** Max scorecards to aggregate (newest-first read; default 500). */
  limit?: number;
  /**
   * Include each criterion's chronological series as RLE runs (WI-2943). Default
   * FALSE: the raw per-scorecard series dominated the payload (~84% at 200
   * scorecards × 14 criteria, guaranteed over the MCP result cap at the default
   * limit) while every known consumer wants the summary fields.
   */
  includeSeries?: boolean;
}

/**
 * Parse a criterion's instrument binding from a trailing `[instrumentKey: <key>|none]`
 * token on its `model` prose (WI-4607). The token is greppable text, not a schema
 * field. Returns the key (or the literal `'none'` when explicitly un-instrumented),
 * or `null` when the model carries no such trailing token. Only a TRAILING token
 * binds — a mention mid-prose is not a binding, so a criterion that merely discusses
 * instrument keys does not accidentally acquire one.
 */
export function parseCriterionInstrumentKey(
  model: string | null | undefined,
  instrumentKey?: string | null,
): string | null {
  if (instrumentKey?.trim()) return instrumentKey.trim();
  const m = /\[instrumentKey:\s*([a-z0-9-]+|none)\]\s*$/.exec(model ?? '');
  return m ? m[1] : null;
}

/**
 * Aggregate a rubric's scorecards into a per-criterion rating time-series + a
 * trend direction (P-010). Reads {@link listScorecards} (P-013) — the trend is a
 * pure roll-up of the scorecard read, so it inherits the same workspace scope +
 * organic-only + rubric filtering, and stays correct as the storage evolves.
 */
export async function scorecardTrend(filter: ScorecardTrendFilter): Promise<RubricTrend> {
  const rows = await listScorecards({
    rubricRef: filter.rubricRef,
    sourceHive: filter.sourceHive,
    since: filter.since,
    limit: filter.limit ?? 500,
  });
  // listScorecards is newest-first; the series wants chronological (oldest→newest).
  const chrono = [...rows].reverse();

  // Scale-aware numeric projection for mean10 (one rubric per trend → one resolve).
  const trendRubric = await getRubric(filter.rubricRef);
  const scoreOverrides = scoreOverridesForScale(trendRubric?.ratingScale);
  const declaredCriterionKeys = trendRubric
    ? new Set(trendRubric.criteria.map((c) => c.key))
    : null;

  // WI-4607: parse each criterion's instrument binding once per key so the trend
  // view can show which instrument grades each criterion.
  const instrumentKeyByCriterion = new Map<string, string>();
  for (const c of trendRubric?.criteria ?? []) {
    const key = parseCriterionInstrumentKey(c.model, c.instrumentKey);
    if (key) instrumentKeyByCriterion.set(c.key, key);
  }

  const byCriterion = new Map<string, { at: string; rating: string; idle: boolean }[]>();
  for (const sc of chrono) {
    for (const [criterion, entry] of Object.entries(sc.ratings)) {
      // Historical writers could store ad-hoc rating keys while still passing
      // the old missing-only completeness gate (EI-11617). Keep those visible
      // on scorecards:list via extraKeys, but never promote them to rubric trend
      // dimensions. Unknown rubrics remain readable because there is no declared
      // key set to filter against.
      if (declaredCriterionKeys && !declaredCriterionKeys.has(criterion)) continue;
      const arr = byCriterion.get(criterion) ?? [];
      arr.push({ at: sc.createdAt, rating: entry.rating, idle: isIdleUnknown(entry.rating, entry.evidence) });
      byCriterion.set(criterion, arr);
    }
  }

  const criteria: CriterionTrend[] = [...byCriterion.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([criterion, series]) => {
      const distribution: Record<string, number> = {};
      for (const s of series) distribution[s.rating] = (distribution[s.rating] ?? 0) + 1;
      const nums = series
        .map((s) => ratingScore10(s.rating, scoreOverrides))
        .filter((n): n is number => n !== null);
      return {
        criterion,
        count: series.length,
        distribution,
        idleCount: series.reduce((n, s) => n + (s.idle ? 1 : 0), 0),
        first: { rating: series[0].rating, at: series[0].at },
        latest: { rating: series[series.length - 1].rating, at: series[series.length - 1].at },
        direction: computeTrendDirection(series),
        mean10: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null,
        instrumentKey: instrumentKeyByCriterion.get(criterion) ?? null,
        ...(filter.includeSeries ? { series: compressSeries(series) } : {}),
      };
    });

  return {
    rubricRef: filter.rubricRef,
    ...(filter.sourceHive ? { sourceHive: filter.sourceHive } : {}),
    scorecardCount: rows.length,
    window: {
      ...(filter.since ? { since: filter.since } : {}),
      ...(chrono.length ? { from: chrono[0].createdAt, to: chrono[chrono.length - 1].createdAt } : {}),
    },
    criteria,
    ...(trendRubric ? { status: trendRubric.status } : {}),
    proposedBy: trendRubric?.proposedBy ?? null,
    ratifiedBy: trendRubric?.ratifiedBy ?? null,
    staleness: computeRubricStaleness(criteria),
  };
}
