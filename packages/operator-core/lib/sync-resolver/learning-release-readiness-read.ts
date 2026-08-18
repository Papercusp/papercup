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

export interface ReleaseReadinessRubricInfo {
  rubricId: string;
  title: string;
  status: RubricStatus;
  criteriaCount: number;
  /** D-012 governance provenance: author ≠ ratifier is what makes the gate honest. */
  proposedBy: string | null;
  ratifiedBy: string | null;
  updatedAt: string;
  scorecardCount: number;
  latestScorecardAt: string | null;
  /** 0–10 projection of the latest scorecard (null when all-unknown / none filed). */
  latestScore10: number | null;
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
  const [{ getRubric }, { listScorecards }] = await Promise.all([import('../rubrics'), import('../scorecards')]);
  const rubric = await getRubric(RELEASE_READINESS_RUBRIC_ID);
  if (!rubric) return null;
  // Scorecards are a decoration on the governance line — their read failing must not
  // hide the rubric's status/provenance (the more load-bearing half).
  let scorecardCount = 0;
  let latestScorecardAt: string | null = null;
  let latestScore10: number | null = null;
  try {
    const scorecards = await listScorecards({ rubricRef: RELEASE_READINESS_RUBRIC_ID, limit: 100 });
    scorecardCount = scorecards.length;
    for (const s of scorecards) {
      if (!latestScorecardAt || s.createdAt > latestScorecardAt) {
        latestScorecardAt = s.createdAt;
        latestScore10 = s.score10;
      }
    }
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
  };
}
