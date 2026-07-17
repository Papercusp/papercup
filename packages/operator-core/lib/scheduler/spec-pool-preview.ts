/**
 * spec-pool-preview.ts — write-time EFFECT preview for a dynamic claim spec (WI-5212).
 *
 * WHY THIS EXISTS. Both 2026-07-16/17 fleet starvations shared one root pattern: the
 * system VALIDATED the spec's intention (vocabulary, shape → ok:true) but never MEASURED
 * its effect. A spec scoped to kinds with zero rows, and a NULL-poisoned `not:{plan}`
 * fence that hid 99% of the pool (EI-13306), both armed silently and then presented as
 * honest-looking scoped misses that blamed the spec's members. Each was caught only by a
 * leader hand-running a COUNT against the pool before/after arming — this module is that
 * COUNT, institutionalized at the write path.
 *
 * WHAT IT MEASURES. For a candidate spec: how many rows of the CLAIMABLE POOL its
 * view.filter matches, using the SAME compiled WHERE fragment `get_next` executes
 * (compileFilter — so preview and pull cannot drift), against neutral floors:
 * status ∈ spec.states, unclaimed, not observation-lane (D-005), not claim-held.
 * Per-BEE floors (release cooldown, DAG-blocking, rig, admission) are deliberately NOT
 * applied — they vary by puller and by minute; the preview is a pool-shape check, not a
 * claim simulation. Both sides of every comparison (matched vs pool, new vs previous)
 * use the same basis, so the collapse ratios are meaningful even though the absolute
 * numbers slightly overcount what one specific bee could claim right now.
 *
 * THE GUARD (evaluateCollapseGuard — pure, unit-tested). Two refusal shapes, both
 * overridable with confirmCollapse:true:
 *  1. matched = 0 of a nonempty pool — the starved-by-construction shape (a kind/state
 *     scoping that matches nothing). Legit only for a pre-staged lane whose items have
 *     not been promoted yet, which is exactly what the confirm flag is for.
 *  2. an AUTHORED spec revision that craters the match count (< max(5, 5%) of the
 *     previous revision's) — the NULL-poisoned-fence shape. Narrowing from the DEFAULT
 *     spec never refuses (authoring a deliberately narrow lane is normal); only a
 *     revision of an existing lane that suddenly hides its own backlog does.
 *
 * Fail-open: a preview/count error must NEVER block a spec write (the guard is a safety
 * net, not a new single point of failure) — callers report previewError instead.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { ClaimSpec } from './claim-spec';
import { compileFilter } from './get-next';
import { observationLaneExclusionSql } from '../work-items';

export interface SpecPoolEffect {
  /** Rows of the pool the spec's view.filter matches. */
  matched: number;
  /** The claimable pool under neutral floors (see module doc — slight overcount vs per-bee reality). */
  pool: number;
  /** The states the count ran under (spec.states ?? ['todo']). */
  states: string[];
  /** Harness the count was scoped to; null = whole workspace. */
  harness: string | null;
}

/**
 * Count the claimable pool and the spec's matched subset in ONE query, using the same
 * compiled filter fragment `get_next` runs. Throws on SQL failure — the CALLER decides
 * fail-open (the set_claim_spec tool reports previewError and proceeds).
 */
export async function previewSpecPoolEffect(
  spec: ClaimSpec,
  opts: { workspaceId: string; harness?: string | null },
): Promise<SpecPoolEffect> {
  const sql = getOrgPg().sql;
  const states = [...(spec.states ?? ['todo'])];
  const harness = opts.harness ?? null;
  const filter = compileFilter(sql, spec.view.filter);
  const rows = (await sql`
    SELECT count(*)::int AS pool,
           (count(*) FILTER (WHERE ${filter}))::int AS matched
      FROM harness_shared.work_items wi
     WHERE wi.workspace_id = ${opts.workspaceId}
       AND (${harness}::text IS NULL OR wi.harness_slug = ${harness})
       AND wi.status = ANY(${states}::text[])
       AND wi.taken_by IS NULL
       -- D-005: observation-lane rows are never claimable — the same NULL-safe floor
       -- the claim path applies (a raw count without this overstates the pool ~7x).
       AND ${observationLaneExclusionSql(sql)}
       -- WI-2797 claim-holds are parked out of self-select; same IS DISTINCT FROM idiom.
       AND COALESCE(wi.payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true'
  `) as Array<{ pool: number; matched: number }>;
  const row = rows[0] ?? { pool: 0, matched: 0 };
  return { matched: row.matched, pool: row.pool, states, harness };
}

export interface CollapseGuardInput {
  matched: number;
  pool: number;
  /** Matched count under the previously-stored spec at the same target key; null = not measurable. */
  previousMatched: number | null;
  /** 'authored' = a cup/fleet row existed (someone set this lane); 'default' = no stored spec. */
  previousSource: 'authored' | 'default';
  /** The caller's confirmCollapse flag. */
  confirm: boolean;
}

export interface CollapseGuardVerdict {
  refuse: boolean;
  errors: string[];
  warning?: string;
}

/** Revision-collapse threshold: refuse when a previously ≥MIN_PREVIOUS-row lane drops below max(ABS_FLOOR, RATIO × previous). */
const MIN_PREVIOUS = 20;
const ABS_FLOOR = 5;
const RATIO = 0.05;

/**
 * Pure guard decision — see module doc for the two refusal shapes. Exported separately
 * from the COUNT so the thresholds are unit-testable without Postgres.
 */
export function evaluateCollapseGuard(input: CollapseGuardInput): CollapseGuardVerdict {
  const { matched, pool, previousMatched, previousSource, confirm } = input;

  const zeroMatch = matched === 0 && pool > 0;
  const revisionCollapse =
    previousSource === 'authored' &&
    previousMatched !== null &&
    previousMatched >= MIN_PREVIOUS &&
    matched < Math.max(ABS_FLOOR, Math.ceil(previousMatched * RATIO));

  if (confirm) {
    return {
      refuse: false,
      errors: [],
      ...(zeroMatch || revisionCollapse
        ? {
            warning:
              `pool-collapse confirmed by caller (confirmCollapse:true): spec matches ${matched} of ${pool} ` +
              `claimable row(s)${previousMatched !== null ? ` (previous spec matched ${previousMatched})` : ''}.`,
          }
        : {}),
    };
  }

  if (zeroMatch) {
    return {
      refuse: true,
      errors: [
        `spec matches 0 of ${pool} claimable row(s) — the starved-fleet shape (EI-13306/EI-11291): every ` +
          `member's get_next would miss while the pool sits full, reported as a clean scoped miss. If this is ` +
          `intentional (a pre-staged lane whose items are not promoted yet), re-send with confirmCollapse:true. ` +
          `Otherwise check the filter: kind/states that exist in this harness, and NO not:/!= fence over a ` +
          `NULLABLE field (plan/assignee/risk_tier) until the EI-13306 null-safe compiler is deployed.`,
      ],
    };
  }

  if (revisionCollapse) {
    return {
      refuse: true,
      errors: [
        `this revision collapses the claimable match from ${previousMatched} to ${matched} of ${pool} row(s) — ` +
          `the poisoned-fence shape (EI-13306: a not:{...}/!= over a NULLABLE field silently drops every NULL row). ` +
          `If the narrowing is intended, re-send with confirmCollapse:true; otherwise fix the filter before arming ` +
          `it fleet-wide.`,
      ],
    };
  }

  if (matched < ABS_FLOOR && pool >= MIN_PREVIOUS) {
    return {
      refuse: false,
      errors: [],
      warning:
        `narrow lane: spec matches only ${matched} of ${pool} claimable row(s). Fine for a deliberate ` +
        `pinned/narrow lane; if members report scoped misses, this spec is why.`,
    };
  }

  return { refuse: false, errors: [] };
}
