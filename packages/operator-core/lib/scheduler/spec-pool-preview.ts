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
 *
 * KNOWN GAP (EI-18655873409999215, 2026-07-25): this is a WRITE-TIME check only — it can
 * be legitimately bypassed by design (the `isProvableSuperset` short-circuit above, and
 * the `noDelta` exemption for a previously-authored spec that already matched 0), so a
 * corrective widening write CAN silently land as a still-0-match no-op with nothing but a
 * low-visibility `warning` field on that one tool-call response. Confirmed live: a
 * `{any:[oldFilter, newClause]}` widening revision of an already-0-matching lane sat at 0
 * for 4.5h, unrefused (both exemptions applied), with the fleet reading it as a clean
 * scoped miss the whole time. The durable backstop for THIS shape is NOT here — it is the
 * STANDING alert `computeSpecStarvedFleetAlert` in
 * agent-tools/fleet/leader-brief.ts, which re-checks the fleet's live effective spec
 * against the live pool on every leader-brief call instead of relying on catching a
 * one-shot write-time warning. If you are tempted to make this write-time guard "smarter"
 * to close the gap instead, consider whether the standing check is the more robust fix —
 * a write-time-only guard can always be raced by the pool itself changing shape afterward.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { ClaimSpec, FilterLeaf, FilterNode } from './claim-spec';
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
  // Mirrors claimFloorsWhereSql's unified ['open'] default (work-item-status-full-unify P-004/P-005)
  // so the WI-5212 pool-effect preview counts the SAME pool the real claim runs against.
  const states = [...(spec.states ?? ['open'])];
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
  /** The candidate revision's view.filter — optional; enables the provable-superset short-circuit below. */
  filter?: FilterNode;
  /** The incumbent (previously-stored) spec's view.filter — same-key requirement as `filter`. */
  previousFilter?: FilterNode;
}

/**
 * Structural equality over the filter AST — order-independent for combinator arrays'
 * ELEMENTS content (not position: `all`/`any` are still compared positionally, since a
 * differently-ORDERED equivalent tree is a distinct-but-equivalent revision, not the
 * literal syntactic match `isProvableSuperset` needs). Leaves compare field/op/value;
 * an array `value` (an `in` leaf) compares element-wise.
 */
export function filterNodesEqual(a: FilterNode, b: FilterNode): boolean {
  const aAny = (a as { any?: FilterNode[] }).any;
  const bAny = (b as { any?: FilterNode[] }).any;
  if (aAny || bAny) {
    if (!aAny || !bAny || aAny.length !== bAny.length) return false;
    return aAny.every((child, i) => filterNodesEqual(child, bAny[i]));
  }
  const aAll = (a as { all?: FilterNode[] }).all;
  const bAll = (b as { all?: FilterNode[] }).all;
  if (aAll || bAll) {
    if (!aAll || !bAll || aAll.length !== bAll.length) return false;
    return aAll.every((child, i) => filterNodesEqual(child, bAll[i]));
  }
  const aNot = (a as { not?: FilterNode }).not;
  const bNot = (b as { not?: FilterNode }).not;
  if (aNot || bNot) {
    if (!aNot || !bNot) return false;
    return filterNodesEqual(aNot, bNot);
  }
  const al = a as FilterLeaf;
  const bl = b as FilterLeaf;
  if (al.field !== bl.field || al.op !== bl.op) return false;
  return filterValuesEqual(al.value, bl.value);
}

function filterValuesEqual(a: FilterLeaf['value'], b: FilterLeaf['value']): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * EI-18653814284166347 (SUPERSET BLINDNESS): a revision of the shape `{ any: [X, ...] }`
 * where `X` structurally equals the INCUMBENT filter is statically provable to match a
 * SUPERSET of the incumbent's rows — an `any` over the old filter plus more can only ever
 * match the same rows or more, never fewer. That is a cheap syntactic check, independent of
 * the measured counts, so a candidate satisfying it can never be the narrowing/starvation
 * shape the guard exists to catch (recurses into a nested `any` so `{any:[{any:[X,Y]},Z]}`
 * is still recognised as a superset of X).
 */
export function isProvableSuperset(candidate: FilterNode, previous: FilterNode): boolean {
  const children = (candidate as { any?: FilterNode[] }).any;
  if (!children) return false;
  return children.some((child) => filterNodesEqual(child, previous) || isProvableSuperset(child, previous));
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
  const { matched, pool, previousMatched, previousSource, confirm, filter, previousFilter } = input;

  // EI-18653814284166347 defect #2 (SUPERSET BLINDNESS): a statically-provable superset of
  // the incumbent filter cannot possibly be the narrowing shape either refusal below exists
  // to catch — skip the guard outright, whatever the measured matched/previousMatched say.
  // (If matched still comes back surprisingly low for a provable superset, that is a SEPARATE
  // bug — e.g. a SQL-vs-JS filter-evaluator disagreement — not a spec-authoring mistake, so
  // this guard must not conflate the two by refusing here.)
  if (filter && previousFilter && isProvableSuperset(filter, previousFilter)) {
    return {
      refuse: false,
      errors: [],
      ...(matched === 0 && pool > 0
        ? {
            warning:
              `spec matches 0 of ${pool} claimable row(s), but this revision is a statically-provable SUPERSET ` +
              `of the incumbent filter (an any:[...] containing it) — it cannot narrow the pool, so the ` +
              `pool-collapse guard does not apply. A still-zero match here points at a different bug (e.g. the ` +
              `SQL and JS filter evaluators disagreeing on a referenced field), not this spec revision.`,
          }
        : {}),
    };
  }

  // EI-18653814284166347 defect #1 (NO-DELTA REFUSAL): a revision that matches 0 changes
  // NOTHING about starvation when the INCUMBENT already matched 0 — refusing achieves no
  // protection (the pool was already just as starved under the spec being replaced) and only
  // trains callers to reflex-pass confirmCollapse:true, destroying the guard's value for a
  // revision that actually IS the first one to hide the backlog.
  const noDelta = previousSource === 'authored' && previousMatched === 0;
  const zeroMatch = matched === 0 && pool > 0 && !noDelta;
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
