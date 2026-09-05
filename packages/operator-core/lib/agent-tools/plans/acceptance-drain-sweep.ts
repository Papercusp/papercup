/**
 * ACCEPTANCE-DRAIN sweep — P-020 of design-to-code-coverage-seam-2026-09-02 (D-032).
 *
 * This is the half that makes the acceptance ceremony a QUEUE rather than a WALL.
 *
 * `plan-drain-rule.ts` + `plan-drain-sweep.ts` push plans INTO
 * `awaiting-acceptance` automatically the moment their last item goes terminal.
 * `evaluatePlanAcceptanceGate` then holds them there until a seven-step ceremony
 * completes. Between those two mechanisms there is nothing at all: no filing, no
 * routing, no signal. The refusal is visible only to someone who explicitly
 * attempts a ship. So the state accumulates and never drains — measured 187
 * plans, 86.1% of which have never had `plans:audit` run even once, oldest
 * 2026-06-04 (D-032, a full census via the same evaluator the ship write uses).
 *
 * This sweep is the exit: for every held plan it files ONE work item, unassigned,
 * which any agent can claim through the ordinary claim path. Exactly the pairing
 * `spec-triad-sweep.ts` already uses for the identical defect on the spec-triad
 * gate, and it obeys the same standing mandate — a design that routes a decision
 * to a person is a defect; nothing here escalates, notifies, or waits for
 * approval, it files claimable work.
 *
 * ## Safety rails, in the order they matter
 *
 *  1. **Bounded filing.** At most {@link ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN}
 *     items per run. The first tick faces a 187-plan accumulated backlog; filing
 *     all of it at once would be a real bulk write, and if the decision were
 *     wrong it would be wrong everywhere before anyone could look. A cap drains
 *     it over several ticks and costs nothing in the steady state, where a tick
 *     has 0–1 candidates.
 *  2. **Idempotent.** Each filing stamps `payload.acceptanceDrainPlan` and claims
 *     a unique condition key; a plan with a non-terminal filing already open is
 *     skipped BEFORE the gate runs. Re-running is a no-op.
 *  3. **The dedupe read precedes the expensive leg, not the other way round.**
 *     The gate is ~265ms per plan (five check families, citations re-resolved
 *     against the real tree). Evaluating first and deduping after would burn the
 *     whole budget re-deciding plans that are already filed — so candidates are
 *     filtered by the cheap payload read, and only the survivors are evaluated,
 *     and only up to the cap.
 *  4. **Never throws.** A thrown step makes DBOS mark the workflow permanently
 *     dead — a transient error would stop this sweep FOREVER, silently, which is
 *     precisely the invisible-stall shape it exists to fix. Every leg degrades to
 *     a warn.
 *
 * ## Why a plan that PASSES the gate is reported and not filed
 *
 * A plan sitting in `awaiting-acceptance` whose gate is satisfied is shippable
 * right now and owes nothing — filing work against it would be noise. But it is
 * also not nothing: it means a finished plan is one `plans:set-plan-status` call
 * from shipped and nobody has made it. It is counted as `shippableNow` so the
 * number is visible without manufacturing a task.
 *
 * Kill-switch: the `ACCEPTANCE_DRAIN_SWEEP` flag.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { evaluatePlanAcceptanceGate } from '../../plan-acceptance-gate';
import {
  ensureAcceptanceDrainFiling,
  ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES,
} from './acceptance-drain-filing';
import { listPlanIndexRowsForWorkspace, type PlanIndexRow } from './source';
import { activeWorkspaceId } from '../../workspace-registry';
import { isHarnessInScope } from '../../work-scope-policy';

/** Upper bound on work items filed in a single run. See the rails note above. */
export const ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN = 25;

/**
 * Plan `template` values this sweep never files against.
 *
 * A rubric-template plan is exempt from carrying an acceptance rubric of its own
 * (infinite regress — `evaluatePlanAcceptanceGate` exempts it explicitly), so
 * filing "unstick this rubric" work would be a task nobody can ever complete.
 */
export const ACCEPTANCE_DRAIN_EXEMPT_TEMPLATES = new Set(['rubric']);

export interface AcceptanceDrainSweepFiled {
  planSlug: string;
  harnessSlug: string;
  /** The gate's first refusal code — what this filing is actually about. */
  code: string;
  workItemId: string | null;
}

export interface AcceptanceDrainSweepResult {
  /** Plans enumerated in `awaiting-acceptance`. */
  scanned: number;
  /** Of those, how many already had an open filing (skipped before the gate ran). */
  alreadyFiled: number;
  /** Of those evaluated, how many the gate said are shippable right now. */
  shippableNow: number;
  filed: AcceptanceDrainSweepFiled[];
  /** Refusing plans left unfiled because the per-run cap was hit. */
  deferred: number;
  /** Per-plan failures, reported rather than thrown. */
  errors: string[];
  /** Set when the sweep declined to run at all. */
  skipped?: 'flag-off' | 'candidate-read-failed' | 'dedupe-read-failed';
  summary: string;
}

/**
 * The pure candidate filter — which enumerated rows this sweep may file against.
 *
 * Split out from the I/O so the exclusions (template exemption, already-filed
 * dedupe) are testable without a database, exactly as spec-triad-sweep splits
 * its decision from its plumbing.
 */
export function selectAcceptanceDrainCandidates(
  rows: PlanIndexRow[],
  alreadyFiledRefs: Set<string>,
  workspaceId: string,
): PlanIndexRow[] {
  return rows.filter((row) => {
    // `PlanIndexRow` is camelCase (`Omit<PlanRow, 'content'>`), NOT the snake_case
    // of the underlying `harness_plans` columns. Reading the column names here
    // yields `undefined` for every row and silently drops the whole population —
    // which reads as "everything is already filed", i.e. a clean no-op tick. That
    // is the false-negative this comment exists to stop coming back; the fixture
    // in the sibling test uses the real row shape for the same reason.
    if (!row.planSlug || !row.harnessSlug) return false;
    if (row.template && ACCEPTANCE_DRAIN_EXEMPT_TEMPLATES.has(row.template)) return false;
    return !alreadyFiledRefs.has(`${workspaceId}/${row.harnessSlug}/${row.planSlug}`);
  });
}

export interface AcceptanceDrainSweepOptions {
  /** Defaults to the active workspace. */
  workspaceId?: string;
  /** Override the per-run filing cap (tests). */
  maxFilings?: number;
}

function empty(summary: string, skipped?: AcceptanceDrainSweepResult['skipped']): AcceptanceDrainSweepResult {
  return {
    scanned: 0,
    alreadyFiled: 0,
    shippableNow: 0,
    filed: [],
    deferred: 0,
    errors: [],
    ...(skipped ? { skipped } : {}),
    summary,
  };
}

/**
 * One sweep pass. Never throws.
 */
export async function runAcceptanceDrainSweepOnce(
  opts: AcceptanceDrainSweepOptions = {},
): Promise<AcceptanceDrainSweepResult> {
  const enabled = await getFlag(FLAGS.ACCEPTANCE_DRAIN_SWEEP, 'system').catch(() => true);
  if (!enabled) return empty('acceptance-drain sweep: flag off', 'flag-off');

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const maxFilings = opts.maxFilings ?? ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN;

  // Phase 1 — cheap metadata scan. Instances are excluded by default, matching
  // plan-drain-sweep: a scheduled run instance is an auto-generated recurrence,
  // not authored work owed an acceptance ceremony.
  let rows: PlanIndexRow[];
  try {
    rows = await listPlanIndexRowsForWorkspace({
      workspaceId,
      status: 'awaiting-acceptance',
    });
  } catch (err) {
    return empty(
      `acceptance-drain sweep: candidate read failed: ${(err as Error).message}`,
      'candidate-read-failed',
    );
  }

  // Phase 2 — the dedupe read, BEFORE the expensive gate (rail 3).
  const alreadyFiledRefs = new Set<string>();
  try {
    const { sql } = getOrgPg();
    const existing = (await sql`
      SELECT payload->>'acceptanceDrainPlan' AS ref
        FROM harness_shared.work_items
       WHERE payload->>'acceptanceDrainPlan' IS NOT NULL
         AND status = ANY(${ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES})
    `) as unknown as { ref: string | null }[];
    for (const e of existing) if (e.ref) alreadyFiledRefs.add(e.ref);
  } catch (err) {
    return empty(
      `acceptance-drain sweep: dedupe read failed: ${(err as Error).message}`,
      'dedupe-read-failed',
    );
  }

  const candidates = selectAcceptanceDrainCandidates(rows, alreadyFiledRefs, workspaceId);
  const alreadyFiled = rows.length - candidates.length;

  // Phase 3 — evaluate and file, capped.
  const filed: AcceptanceDrainSweepFiled[] = [];
  const errors: string[] = [];
  let shippableNow = 0;
  let deferred = 0;
  let scopeSkipped = 0;

  for (const row of candidates) {
    // workspace-work-scope-policy-2026-09-04 P-007: a plan homed outside the workspace
    // work-scope policy gets no acceptance-drain filing — filing it would place work in an
    // out-of-scope harness. Counted, never dropped. No policy ⇒ never skips.
    if (!isHarnessInScope(row.harnessSlug)) {
      scopeSkipped++;
      continue;
    }
    if (filed.length >= maxFilings) {
      deferred++;
      continue;
    }
    const planSlug = row.planSlug;
    const harnessSlug = row.harnessSlug;
    try {
      const verdict = await evaluatePlanAcceptanceGate(planSlug);
      if (verdict.satisfied) {
        shippableNow++;
        continue;
      }
      // A verdict that could not be EVALUATED is not a refusal to file work
      // against: "could not evaluate" and "is blocked" are different claims, and
      // filing the first as the second would put a fabricated blocker code in
      // front of whoever picks the item up.
      if (!verdict.code) {
        errors.push(`${planSlug}: refused with no code (unavailable?), not filed`);
        continue;
      }
      const res = await ensureAcceptanceDrainFiling({
        workspaceId,
        harnessSlug,
        planSlug,
        code: verdict.code,
        message: verdict.message ?? `(gate refused with ${verdict.code} and no message)`,
      });
      if (res.outcome === 'created') {
        filed.push({ planSlug, harnessSlug, code: verdict.code, workItemId: res.id });
      } else if (res.outcome === 'error') {
        errors.push(`${planSlug}: filing failed: ${res.error}`);
      }
    } catch (err) {
      errors.push(`${planSlug}: ${(err as Error).message}`);
    }
  }

  const byCode = new Map<string, number>();
  for (const f of filed) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
  const codeBreakdown = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}×${n}`)
    .join(', ');

  const summary =
    `acceptance-drain sweep: ${rows.length} in awaiting-acceptance · ` +
    `${alreadyFiled} already filed · ${shippableNow} SHIPPABLE NOW · ` +
    `${filed.length} filed${codeBreakdown ? ` (${codeBreakdown})` : ''}` +
    (deferred > 0 ? ` · ${deferred} DEFERRED past the ${maxFilings}/run cap` : '') +
    (scopeSkipped > 0 ? ` · ${scopeSkipped} skipped (harness outside the work-scope policy)` : '') +
    (errors.length > 0 ? ` · ${errors.length} error(s)` : '');

  return { scanned: rows.length, alreadyFiled, shippableNow, filed, deferred, scopeSkipped, errors, summary };
}
