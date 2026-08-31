/**
 * learning.releaseReadiness — the Verify stage's GO/NO-GO strip read
 * (learning-tab-alignment-2026-07-13 P-001).
 *
 * The learning system's actual release gate — blender:success-metrics' six bars plus the
 * blender-release-readiness rubric's governance state — had NO UI surface at all: the one
 * verdict that decides "is this thing ready?" was visible only to agents. This read powers
 * the strip at the top of the Verify stage.
 *
 * D-001 (instrument integrity): derives from the SAME readers the MCP tools serve —
 * `buildProgramSuccessReport` (blender:success-metrics) and `getRubric`/`listScorecards`
 * (rubrics:get / scorecards:list) — never a parallel UI-side reimplementation that can
 * drift from what agents see.
 *
 * Fail-soft per leg: a broken ledger read must not blank the rubric line and vice versa —
 * the strip degrades, it never throws (the sibling learning.* reads' posture).
 */
import { buildProgramSuccessReport, type ProgramSuccessReport } from '../scout/success-metrics';
import type { RubricStatus } from '../rubrics';
// The settled-evidence admission policy, from the neutral leaf rather than from
// scorecards.ts — a static import of the STORE here would pull PG into this read's
// module graph for one pure predicate (EI-21949865560276745).
import { scorecardAdmissionExclusion } from '../harness/improvements/observation-types';
import { createReadDeadline } from './read-deadline';

/**
 * Whole-read budget for the readiness strip, in ms — under the ~10s
 * RESOLVER_READ_TIMEOUT_MS. See ./read-deadline: the per-leg `.catch`es below
 * fail-soft a leg that THROWS but bound nothing for a leg that HANGS, and
 * `Promise.all` waits for the slowest — so one wedged reader 500s the whole
 * strip, which cannot then show the degraded state it carefully computed
 * (EI-20801200386596605, the sibling of WI-39813).
 */
const RELEASE_READINESS_BUDGET_MS = 6_000;

/** The gate rubric's id — proposed on 2026-07-13 as the public-release testing gate (WI-4497). */
export const RELEASE_READINESS_RUBRIC_ID = 'blender-release-readiness';

/**
 * Scorecard-history page size. Named (not an inline `100`) because every count derived
 * from this page is a FLOOR once the page fills — `scoreEvidence.countTruncated` is what
 * says so, and the two must be read together.
 */
const SCORECARD_PAGE = 100;

/**
 * How much evidence the displayed score actually rests on (EI-21949865560276745).
 *
 * The strip used to render a bare `latest N/10` beside a raw card count. Both numbers
 * were wrong in the same direction — they OVERSTATED confidence — and the failure was
 * silent because a one-sample score and a hundred-sample score render identically:
 *
 *  - the score came from the newest row `listScorecards` returned, which includes
 *    PROVISIONAL working notes and audit-PENDING gradings — the two classes the trend
 *    explicitly refuses to count as settled evidence;
 *  - the count was taken over a page capped at {@link SCORECARD_PAGE}, so a floor was
 *    rendered as a total (this repo's own rule: a caller's `limit` bounds row lists,
 *    never an aggregate);
 *  - and the row's `generationFreshness` — the read-time verdict on whether the
 *    generation the card graded has since ENDED — was dropped on the floor, which is
 *    precisely the 2026-07-17 shape where a 4.5h soak and a 6/6 verdict were voided by
 *    a restart three minutes after emit and nothing downstream noticed.
 *
 * Every field here is disclosure, not a new judgement: the strip keeps showing the
 * score, and now shows what it is worth.
 */
export interface ReleaseReadinessScoreEvidence {
  /** Admissible (settled) cards on the page — the population the score summarises. */
  sampleCount: number;
  /** Excluded, by reason. Reported, never silent — the trend's own posture. */
  excluded: { provisional: number; gradingAuditPending: number };
  /** Oldest / newest admissible card — the window the sample spans. Null when none. */
  windowStart: string | null;
  windowEnd: string | null;
  /** Age of the newest admissible card at read time, ms. Null when none. */
  latestAgeMs: number | null;
  /**
   * Whether the generation the newest admissible card graded is still running.
   * Null when no admissible card, or when the card predates the generation stamp —
   * absence is "not recorded", never "fresh".
   */
  latestGenerationFreshness: 'fresh' | 'stale' | 'unknown' | null;
  /**
   * TRUE when the page hit its cap: every count above is then a FLOOR, not a total.
   * Authoritative (`listScorecardPage` over-fetches one row) rather than inferred from
   * `rows.length === limit`, which cannot tell a full page from an exactly-full one.
   */
  countTruncated: boolean;
}

export interface ReleaseReadinessRubricInfo {
  rubricId: string;
  title: string;
  status: RubricStatus;
  criteriaCount: number;
  /** D-012 governance provenance: author ≠ ratifier is what makes the gate honest. */
  proposedBy: string | null;
  ratifiedBy: string | null;
  updatedAt: string;
  /**
   * ADMISSIBLE scorecards on the page — provisional and audit-pending cards are NOT
   * counted (EI-21949865560276745). The UI labels this "evidence"; it now is.
   * A floor when {@link ReleaseReadinessScoreEvidence.countTruncated}.
   */
  scorecardCount: number;
  latestScorecardAt: string | null;
  /** 0–10 projection of the latest ADMISSIBLE scorecard (null when none / all-unknown). */
  latestScore10: number | null;
  /** What the score rests on. Null only when the scorecard read itself failed. */
  scoreEvidence: ReleaseReadinessScoreEvidence | null;
}

export interface ReleaseReadinessSnapshot {
  /** blender:success-metrics' EXACT report (same reader); null when the ledger read failed. */
  report: ProgramSuccessReport | null;
  /** The gate rubric's governance state; null while no such rubric exists. */
  rubric: ReleaseReadinessRubricInfo | null;
  readAt: string;
  /** Present when a leg failed — the strip shows a degraded state instead of lying. */
  errors?: string[];
}

export async function readReleaseReadiness(opts: { budgetMs?: number } = {}): Promise<ReleaseReadinessSnapshot> {
  const errors: string[] = [];
  // Budgeted so a leg that HANGS degrades exactly like one that throws — the
  // `.catch`es alone only ever covered the throwing case.
  const withinBudget = createReadDeadline(opts.budgetMs ?? RELEASE_READINESS_BUDGET_MS);

  const [report, rubric] = await Promise.all([
    withinBudget(buildProgramSuccessReport({}), 'success-metrics').catch((e: unknown) => {
      errors.push(`success-metrics: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
      return null;
    }),
    withinBudget(readRubricInfo(), 'rubric').catch((e: unknown) => {
      errors.push(`rubric: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
      return null;
    }),
  ]);

  return {
    report,
    rubric,
    readAt: new Date().toISOString(),
    ...(errors.length ? { errors } : {}),
  };
}

async function readRubricInfo(): Promise<ReleaseReadinessRubricInfo | null> {
  const [{ getRubric }, { listScorecardPage }] = await Promise.all([import('../rubrics'), import('../scorecards')]);
  const rubric = await getRubric(RELEASE_READINESS_RUBRIC_ID);
  if (!rubric) return null;
  // Scorecards are a decoration on the governance line — their read failing must not
  // hide the rubric's status/provenance (the more load-bearing half).
  let scorecardCount = 0;
  let latestScorecardAt: string | null = null;
  let latestScore10: number | null = null;
  let scoreEvidence: ReleaseReadinessScoreEvidence | null = null;
  try {
    // listScorecardPage, not listScorecards: same query, but it over-fetches one row and
    // reports `hasMore`, which is the only way to know the counts below are a floor.
    const page = await listScorecardPage({ rubricRef: RELEASE_READINESS_RUBRIC_ID, limit: SCORECARD_PAGE });

    // The trend's admission policy, imported rather than re-derived. A provisional
    // working note or an unaudited grading must never BE the release score.
    const excluded = { provisional: 0, gradingAuditPending: 0 };
    const admissible: typeof page.rows = [];
    for (const s of page.rows) {
      const why = scorecardAdmissionExclusion(s);
      if (why === 'provisional') excluded.provisional += 1;
      else if (why === 'grading-audit-pending') excluded.gradingAuditPending += 1;
      else admissible.push(s);
    }

    let newest: (typeof page.rows)[number] | null = null;
    let windowStart: string | null = null;
    for (const s of admissible) {
      if (!newest || s.createdAt > newest.createdAt) newest = s;
      if (!windowStart || s.createdAt < windowStart) windowStart = s.createdAt;
    }

    scorecardCount = admissible.length;
    latestScorecardAt = newest?.createdAt ?? null;
    latestScore10 = newest?.score10 ?? null;
    scoreEvidence = {
      sampleCount: admissible.length,
      excluded,
      windowStart,
      windowEnd: latestScorecardAt,
      latestAgeMs: latestScorecardAt ? Math.max(0, Date.now() - Date.parse(latestScorecardAt)) : null,
      latestGenerationFreshness: newest?.generationFreshness?.status ?? null,
      countTruncated: page.hasMore,
    };
  } catch {
    // degrade to governance-only
  }
  return {
    rubricId: rubric.rubricId,
    title: rubric.title,
    status: rubric.status,
    criteriaCount: rubric.criteria.length,
    proposedBy: rubric.proposedBy,
    ratifiedBy: rubric.ratifiedBy,
    updatedAt: rubric.updatedAt,
    scorecardCount,
    latestScorecardAt,
    latestScore10,
    scoreEvidence,
  };
}
