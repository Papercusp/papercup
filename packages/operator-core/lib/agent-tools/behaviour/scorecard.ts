/**
 * behaviour/scorecard — the DUAL-EMIT half of behaviour:run (WI-3340): after the suite
 * scores a run, ALSO file ONE su-agent-behavior rubric scorecard into the observation
 * lane (improvements capture-core, lane:'observation'), so the deterministic behaviour
 * checks feed rubrics:trend instead of evaporating as a transient pass/fail report.
 *
 * The hard critical-check gate is UNCHANGED — this module never touches the verdict.
 * Emission is best-effort (a capture error never fails the run) and OFF under vitest
 * (test suites must not file observations into the live store).
 *
 * Grader-independence: the EMITTER is the behaviour-check harness (the agent that ran
 * behaviour:run); the SUBJECT is the checked run — the title names the subject session.
 */
import type { BehaviourCheck, BehaviourCheckId } from '../../behaviour-suite/assertions';
import type { BehaviourReport } from '../../behaviour-suite/report';
import type { ObservationRatings } from '../../harness/improvements/observation-types';

export const SU_AGENT_BEHAVIOR_RUBRIC_ID = 'su-agent-behavior';

/** The rubric's 12 criterion keys (store-ratified 2026-07-06; bundled at
 *  rubrics/su-agent-behavior/rubric.json). The scorecard completeness gate
 *  (validateScorecardCompleteness) requires EVERY key on every emit — a
 *  not-exercised criterion is rated 'unknown' with a why, never omitted. */
export const SU_AGENT_BEHAVIOR_CRITERIA = [
  'tool-discipline',
  'orientation-and-task-reach',
  'papercusp-way-routing',
  'coordination-discipline',
  'engineering-discipline',
  'routing-appropriateness',
  'work-correctness',
  'comprehension-right-target',
  'completion-integrity-and-bounds',
  'reporting-integrity',
  'resource-discipline',
  'constraint-compliance',
] as const;
export type SuAgentBehaviorCriterion = (typeof SU_AGENT_BEHAVIOR_CRITERIA)[number];

/**
 * criterion → the behaviour check that exercises it (the WI-3340 audit mapping).
 * model-routing / context-fit stay deterministic-only infra checks (no subjective
 * criterion measures "the served window fit the first turn"); lock-discipline has no
 * near-1:1 criterion — its result stays visible in the report, not the scorecard.
 * scope-adherence deliberately feeds TWO criteria (staying in scope is both spending
 * proportionally AND honoring the plan boundary).
 */
const CRITERION_TO_CHECK: Partial<Record<SuAgentBehaviorCriterion, BehaviourCheckId>> = {
  'papercusp-way-routing': 'routing-gate',
  'completion-integrity-and-bounds': 'plan-execution',
  'resource-discipline': 'scope-adherence',
  'constraint-compliance': 'scope-adherence',
  'tool-discipline': 'fleet-launch',
  'reporting-integrity': 'completion-evidence',
};

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * PURE: behaviour check results → a full su-agent-behavior ratings record (all 12
 * criterion keys, evidence on every entry — the shape validateObservationRatings +
 * validateScorecardCompleteness accept). Scale: pass/partial/fail/unknown; a
 * deterministic binary check rates pass|fail, an n/a or unexercised criterion rates
 * 'unknown' with a one-line why. Evidence is the check's deterministic result string.
 */
export function mapChecksToRubricRatings(checks: BehaviourCheck[]): ObservationRatings {
  const byId = new Map(checks.map((c) => [c.id, c]));
  const ratings: ObservationRatings = {};
  for (const key of SU_AGENT_BEHAVIOR_CRITERIA) {
    const checkId = CRITERION_TO_CHECK[key];
    const check = checkId ? byId.get(checkId) : undefined;
    if (!checkId) {
      ratings[key] = {
        rating: 'unknown',
        evidence: 'not exercised by the desktop behaviour suite (no mapped deterministic check)',
      };
    } else if (!check) {
      ratings[key] = { rating: 'unknown', evidence: `mapped check '${checkId}' absent from this report` };
    } else if (check.na) {
      ratings[key] = { rating: 'unknown', evidence: clip(`check '${checkId}' n/a for this run: ${check.detail}`) };
    } else {
      ratings[key] = { rating: check.passed ? 'pass' : 'fail', evidence: clip(`[${checkId}] ${check.detail}`) };
    }
  }
  return ratings;
}

export interface BehaviourScorecardMeta {
  sessionId?: string;
  transcriptPath?: string;
}

export interface BehaviourScorecardFields {
  title: string;
  body: string;
  refs: string[];
  ratings: ObservationRatings;
}

/** PURE: report + run metadata → the capture fields (title names the SUBJECT run;
 *  the emitter is the check harness — grader-independence). */
export function buildBehaviourScorecard(
  report: BehaviourReport,
  meta: BehaviourScorecardMeta,
): BehaviourScorecardFields {
  const subject = meta.sessionId
    ? `session ${meta.sessionId}`
    : (meta.transcriptPath ?? report.meta.sessionId ?? 'unidentified transcript');
  const applicable = report.passed + report.failed;
  const title = clip(
    `behaviour:run graded ${subject}: ${report.verdict.toUpperCase()} (${report.passed}/${applicable} checks)`,
    200,
  );
  const refs = ['tool:behaviour:run'];
  if (meta.sessionId) refs.push(clip(`session:${meta.sessionId}`, 200));
  if (meta.transcriptPath) refs.push(clip(`file:${meta.transcriptPath}`, 200));
  return { title, body: clip(report.summary, 2000), refs, ratings: mapChecksToRubricRatings(report.checks) };
}

export interface ScorecardEmitResult {
  emitted: boolean;
  observationId?: string;
  reason?: string;
}

/**
 * Best-effort side effect: file the scorecard as a rubric-graded observation via the
 * capture CORE (the internal lib behind improvements:capture — same evidence +
 * completeness gates, no MCP round-trip). NEVER throws — a failure comes back as
 * { emitted:false, reason } so behaviour:run's verdict is untouched. Gated OFF under
 * vitest so suites don't file observations. Dynamic imports keep capture-core (and its
 * rubrics/DB graph) out of the module graph of the pure-mapping unit tests.
 */
export async function emitBehaviourScorecard(
  report: BehaviourReport,
  meta: BehaviourScorecardMeta,
  ctx: unknown,
): Promise<ScorecardEmitResult> {
  if (process.env.VITEST) return { emitted: false, reason: 'vitest' };
  try {
    const [{ captureImprovement }, identity, presence] = await Promise.all([
      import('../../harness/improvements/capture-core'),
      import('../coordination/identity'),
      import('../coordination/presence'),
    ]);
    const id = identity.resolveAgentIdentity(ctx as Parameters<typeof identity.resolveAgentIdentity>[0]);
    const source = id.source === 'omp-hook-session' || id.source === 'static-client' ? 'su' : 'engineer';
    const filedByRole =
      (await presence.getPresence(id.ownerId).catch(() => null))?.agentRole ??
      identity.deriveAgentRole(id) ??
      undefined;
    const fields = buildBehaviourScorecard(report, meta);
    const result = await captureImprovement({
      title: fields.title,
      kind: 'change', // ignored for lane:observation (stored as a non-bug nit)
      body: fields.body,
      foundDuring: 'behaviour:run',
      lane: 'observation',
      payloadExtra: {
        observation: {
          rubricRef: SU_AGENT_BEHAVIOR_RUBRIC_ID,
          ratings: fields.ratings,
          refs: fields.refs,
        },
      },
      createdBy: id.ownerId,
      filedByRole,
      source,
    });
    return { emitted: Boolean(result.created), observationId: result.issue?.id };
  } catch (e) {
    return { emitted: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
