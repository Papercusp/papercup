/**
 * get-next.ts — the deterministic, spec-driven `get_next` resolver
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, Phase 3 / D-002, D-003, D-010).
 *
 * A bee calls `getNextWorkItem(spec, bee)`; the resolver atomically claims the single
 * top-ranked eligible work-item by compiling:
 *
 *     (GLOBAL HARD FLOORS)  AND  (compiled spec.view.filter)
 *     ORDER BY (compiled spec.rank)
 *     LIMIT 1 FOR UPDATE SKIP LOCKED
 *
 * The model (D-002 — "centralize JUDGMENT, decentralize PICKUP"):
 *  - **Floors are the resolver's, never the spec's.** The eligibility floors
 *    (workspace + feature-family kind, G2 admission, unclaimed, claimable status,
 *    swarm affinity, redundancy fan-out, and the readiness/blocking `NOT EXISTS`
 *    clause) are the SHARED `claimFloorsWhereSql` fragment from work-items.ts — the
 *    EXACT floors `claimNextWorkItem` ANDs in, so the two claim paths can never drift.
 *    A spec can only NARROW (filter) + REORDER (rank); it can never widen past or
 *    re-assert a floor. (The validator already rejects a `blocked`/`cursed` filter
 *    term, so a validated spec is structurally floor-safe before it reaches here.)
 *  - **View, not copy** (D-003): the filter is compiled to a WHERE fragment evaluated
 *    against the LIVE DAG at claim time — never a frozen subgraph.
 *  - **SQL safety is structural.** The validator constrains the field/op/rank-term
 *    vocabulary to a closed set, so every field/op maps to a hand-written, SAFE
 *    `sql` fragment and every spec-supplied VALUE is bound as a parameter — a spec
 *    value is NEVER string-interpolated into SQL.
 *  - **`DEFAULT_CLAIM_SPEC` reproduces today's ordering** (the Queen's intended
 *    `(affinity) → feature_order → created_ts`): handing a bee no spec is equivalent
 *    to handing it the default, so the feature is a strict superset with zero behavior
 *    change until the Queen authors a narrower spec.
 *
 * Descoped-but-validated rank terms (D-010): `model_fit`, `tag_weight`, and
 * `redundancy_need` are in the spec vocabulary (so specs that reference them validate)
 * but the resolver compiles them to a NEUTRAL constant — they don't reorder until the
 * per-MODEL capability lane / tag-weight table ship behind their own flags. `affinity`
 * IS live (it's the reason within-hive push was chosen, preserved as a rank term).
 */
import type postgres from 'postgres';
import {
  type ClaimSpec,
  type FilterNode,
  type FilterLeaf,
  type RankTerm,
  DEFAULT_CLAIM_SPEC,
} from './claim-spec';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import {
  claimFloorsWhereSql,
  schedulerMaintainedReadyEnabled,
  schedulerIssuesClaimableEnabled,
  claimNextIssueWorkItem,
  featureRowToWorkItem,
  FEATURE_COLS,
  type FeatureRowDb,
  type OrgSql,
  type WorkItem,
} from '../work-items';

/** A composed `sql` WHERE/ORDER-BY fragment (porsager pending-query — the type a bare
 *  `sql`...`` tagged template returns, so fragments compose by `${}` interpolation). */
type SqlFragment = postgres.PendingQuery<postgres.Row[]>;

/**
 * The pulling bee's own state — the `bee.*` half of the spec vocabulary. Supplied by
 * the caller (launch handoff / durable spawn record); only `held_paths` is consulted
 * today (the live `affinity` rank term). `model` / `load` / `current_plan` are accepted
 * so a spec referencing them resolves, but they are neutral until their lanes ship.
 */
export interface BeeContext {
  /** The claiming agent id — written to `taken_by` (the claim owner). */
  assignee: string;
  /** Paths this bee already holds open — the `affinity` rank-term input (D-001). */
  heldPaths?: string[];
  /** The bee's model class (`model_fit`, descoped-neutral until P-004). */
  model?: string;
  /** Current load (accepted for vocabulary completeness; neutral today). */
  load?: number;
  /** The bee's current plan (accepted for vocabulary completeness; neutral today). */
  currentPlan?: string;
}

export interface GetNextOpts {
  harness: string;
  /** THIS Swarm's id — when set, the affinity/redundancy FLOORS honor it (per-Hive lease). */
  swarmId?: string;
  /** Skip high-stakes (redundancy > 1) items (redundancy flag on). */
  excludeRedundant?: boolean;
  /** Claimable statuses floor (default ['todo']). */
  states?: string[];
}

export interface GetNextResult {
  workItem: WorkItem;
  /** Provenance (D-003/D-006): WHICH spec revision selected this item. */
  claimedUnder: { specId: string; revision: number };
}

// ────────────────────────────────────────────────────────────────────────────
// Vocabulary → column mapping. The validator guarantees only these fields reach us.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Map a spec ITEM field to a SAFE, hand-written column expression over
 * `harness_features_consolidated`. Returns the `sql` fragment for the column AND its
 * kind (scalar vs. array/json), so the op-compiler can pick the right comparison.
 *
 * Notes on the non-obvious ones:
 *  - `priority` ⇒ `feature_order`, an INVERTED scale (LOWER feature_order = HIGHER
 *    priority, the Queen's steer lever). The op/rank compilers flip direction so a
 *    spec author's `priority desc` ("highest priority first") maps to
 *    `feature_order ASC` at the column.
 *  - `age` ⇒ `created_ts`. "Age asc" = oldest-first = `created_ts ASC` (the legacy
 *    work-stealing order); the column is the creation timestamp, so direction passes
 *    through unflipped (earlier ts sorts first under ASC).
 *  - `risk_tier` / `paths` are NOT first-class columns — they live in `payload` jsonb
 *    (`payload->>'risk_tier'`, `payload->'paths'`), so a spec can filter/rank on them
 *    without a schema change.
 *  - `plan_item` ⇒ `source_plan_item_ids` (a text[]), the only array item-field.
 */
type FieldKind = 'scalar-text' | 'scalar-num' | 'json-array' | 'text-array';
interface FieldMap {
  /** The column/expression `sql` fragment. */
  col: (sql: OrgSql) => SqlFragment;
  kind: FieldKind;
  /** True when the field is an INVERTED scale (rank/op direction flips). */
  inverted?: boolean;
}

const FIELD_MAP: Record<string, FieldMap> = {
  priority: { col: (sql) => sql`feature_order`, kind: 'scalar-num', inverted: true },
  kind: { col: (sql) => sql`item_kind`, kind: 'scalar-text' },
  age: { col: (sql) => sql`created_ts`, kind: 'scalar-num' },
  est_cost: { col: (sql) => sql`expected_cost_cents`, kind: 'scalar-num' },
  redundancy: { col: (sql) => sql`COALESCE(redundancy, 1)`, kind: 'scalar-num' },
  assignee: { col: (sql) => sql`taken_by`, kind: 'scalar-text' },
  // `id` — the work-item id. A spec PINS a fixed set with `id in [...]` (scalar-text, so
  // the `in` op compiles to `feature_id::text = ANY(...)`). A STATIC pin (no auto-inflow),
  // the exception for a fixed wave; the floors (ready/lease/dedup) still apply on top.
  id: { col: (sql) => sql`feature_id`, kind: 'scalar-text' },
  plan: { col: (sql) => sql`source_plan_slug`, kind: 'scalar-text' },
  plan_item: { col: (sql) => sql`source_plan_item_ids`, kind: 'text-array' },
  // Not first-class columns — projected out of payload jsonb (no schema change).
  risk_tier: { col: (sql) => sql`(payload->>'risk_tier')`, kind: 'scalar-text' },
  tags: { col: (sql) => sql`tags`, kind: 'json-array' },
  paths: { col: (sql) => sql`payload->'paths'`, kind: 'json-array' },
};

// ────────────────────────────────────────────────────────────────────────────
// Filter compiler — spec.view.filter → a parameterized WHERE fragment.
// ────────────────────────────────────────────────────────────────────────────

function isLeaf(node: FilterNode): node is FilterLeaf {
  return 'field' in node;
}

/**
 * Compile a single comparison leaf to a SAFE `sql` fragment. EVERY value is BOUND as
 * a parameter (`${value}`) — never interpolated. The op→SQL mapping is hand-written
 * per field kind, so an op that is meaningless for a kind (e.g. `<` on tags) can only
 * arise from a validated-coherent spec (the validator already enforces op/value
 * coherence) and still produces well-typed SQL.
 */
function compileLeaf(sql: OrgSql, leaf: FilterLeaf) {
  const fm = FIELD_MAP[leaf.field];
  if (!fm) {
    // Unreachable for a validated spec (the validator's field allow-list == FIELD_MAP
    // keys). Throw rather than silently emit TRUE — a missing mapping is a CODE bug.
    throw new Error(`get_next: no column mapping for filter field "${leaf.field}"`);
  }
  const col = fm.col(sql);
  const v = leaf.value;

  switch (fm.kind) {
    case 'json-array': {
      // tags / paths are jsonb arrays. `contains` ⇒ the array holds the scalar;
      // `glob` ⇒ ANY element matches the glob (translated to SQL LIKE). `in` ⇒ the
      // array overlaps the supplied set.
      if (leaf.op === 'contains') {
        // jsonb `?` "has top-level string key/element" — value bound as text.
        return sql`${col} ? ${String(v)}`;
      }
      if (leaf.op === 'glob') {
        return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) e WHERE e LIKE ${globToLike(String(v))})`;
      }
      if (leaf.op === 'in') {
        const arr = (Array.isArray(v) ? v : [v]).map(String);
        return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) e WHERE e = ANY(${arr}::text[]))`;
      }
      // = / != against a json array: compare membership-equality of the WHOLE set.
      if (leaf.op === '!=') return sql`NOT (${col} ? ${String(v)})`;
      return sql`${col} ? ${String(v)}`;
    }
    case 'text-array': {
      // source_plan_item_ids text[] — `contains`/`=` ⇒ membership; `in` ⇒ overlap.
      if (leaf.op === 'in') {
        const arr = (Array.isArray(v) ? v : [v]).map(String);
        return sql`${col} && ${arr}::text[]`;
      }
      if (leaf.op === '!=') return sql`NOT (${String(v)} = ANY(COALESCE(${col}, ARRAY[]::text[])))`;
      // = / contains ⇒ membership of the scalar in the array.
      return sql`${String(v)} = ANY(COALESCE(${col}, ARRAY[]::text[]))`;
    }
    default: {
      // scalar-text / scalar-num.
      if (leaf.op === 'in') {
        const arr = Array.isArray(v) ? v : [v];
        return fm.kind === 'scalar-num'
          ? sql`${col} = ANY(${arr.map(Number)}::numeric[])`
          : sql`${col}::text = ANY(${arr.map(String)}::text[])`;
      }
      if (leaf.op === 'glob') {
        return sql`${col}::text LIKE ${globToLike(String(v))}`;
      }
      if (leaf.op === 'contains') {
        // substring containment for a scalar (text) field.
        return sql`${col}::text LIKE ${'%' + String(v) + '%'}`;
      }
      // Relational + equality ops on a scalar column. `inverted` (feature_order /
      // priority): flip the comparator so the spec author's intent on the LOGICAL
      // field maps to the physical inverted column.
      const op = fm.inverted ? invertComparator(leaf.op) : leaf.op;
      const bound = fm.kind === 'scalar-num' ? sql`${Number(v)}` : sql`${String(v)}`;
      const cmp = fm.kind === 'scalar-num' ? sql`${col}` : sql`${col}::text`;
      switch (op) {
        case '=':
          return sql`${cmp} = ${bound}`;
        case '!=':
          return sql`${cmp} <> ${bound}`;
        case '<':
          return sql`${cmp} < ${bound}`;
        case '<=':
          return sql`${cmp} <= ${bound}`;
        case '>':
          return sql`${cmp} > ${bound}`;
        case '>=':
          return sql`${cmp} >= ${bound}`;
        default:
          throw new Error(`get_next: unhandled scalar op "${leaf.op}"`);
      }
    }
  }
}

/** Flip a relational comparator for an inverted-scale column (feature_order). */
function invertComparator(op: FilterLeaf['op']): FilterLeaf['op'] {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
    default:
      return op; // =, != unaffected
  }
}

/** Translate a restricted glob (`*`, `?`) to a SQL LIKE pattern, escaping LIKE metachars. */
function globToLike(glob: string): string {
  // Escape LIKE's own metacharacters first, then map glob wildcards.
  const escaped = glob.replace(/([%_\\])/g, '\\$1');
  return escaped.replace(/\*/g, '%').replace(/\?/g, '_');
}

/**
 * fleet-backlog-lessons-2026-07-01 P-005 (WI-1407): strip a top-level `kind` leaf (or one
 * inside a top-level `all`) out of a filter tree, returning the WIDENED filter — used by
 * the resolver's tier-2 fallback so a spec narrowed to one feature-family `kind` widens to
 * the rest of the family before giving up, instead of exiting on that tier alone. Returns
 * `undefined` when there is nothing left to widen from (no `kind` leaf found at a shape this
 * can safely simplify), which the caller reads as "tier 2 is not applicable here" — a `kind`
 * leaf buried inside an `any`/`not` combinator changes OR/NOT semantics if dropped, so this
 * deliberately does NOT attempt to rewrite those shapes (conservative: no widening rather than
 * a wrong widening).
 */
function widenPastKind(filter: FilterNode | undefined): FilterNode | undefined {
  if (!filter) return undefined;
  if (isLeaf(filter)) {
    return filter.field === 'kind' ? undefined : filter;
  }
  if ('all' in filter) {
    let changed = false;
    const kept = filter.all.filter((node) => {
      const isKindLeaf = isLeaf(node) && node.field === 'kind';
      if (isKindLeaf) changed = true;
      return !isKindLeaf;
    });
    if (!changed) return filter; // no top-level kind leaf inside this `all` — nothing to widen
    if (kept.length === 0) return undefined;
    return kept.length === 1 ? kept[0] : { all: kept };
  }
  // `any` / `not` — leave unrewritten (see doc comment above).
  return filter;
}

/**
 * Recursively compile the filter combinator tree to ONE parameterized `sql` fragment.
 * `all` ⇒ AND, `any` ⇒ OR, `not` ⇒ NOT; a leaf ⇒ {@link compileLeaf}. An undefined
 * filter ⇒ `TRUE` (the empty view — every floor-eligible item).
 */
export function compileFilter(sql: OrgSql, filter: FilterNode | undefined) {
  if (!filter) return sql`TRUE`;
  function walk(node: FilterNode): SqlFragment {
    if (isLeaf(node)) return compileLeaf(sql, node);
    if ('all' in node) {
      const parts = node.all.map(walk);
      return parts.reduce((acc, p) => sql`${acc} AND ${p}`);
    }
    if ('any' in node) {
      const parts = node.any.map(walk);
      // Parenthesize the OR so it binds correctly when ANDed into the floors.
      return parts.reduce((acc, p) => sql`(${acc} OR ${p})`);
    }
    // not
    return sql`NOT (${walk(node.not)})`;
  }
  return sql`(${walk(filter)})`;
}

// ────────────────────────────────────────────────────────────────────────────
// Rank compiler — spec.rank → an ORDER BY fragment.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compile a single rank term's EXPRESSION to a sortable `sql` value, ignoring its
 * direction (the caller appends ASC/DESC). Returns null when the term is a NEUTRAL
 * (descoped) function — the caller drops it from the ORDER BY so it doesn't perturb
 * ordering. A bare item field maps through {@link FIELD_MAP}; an `inverted` field
 * (feature_order) flags the caller to flip the direction.
 */
function compileRankExpr(
  sql: OrgSql,
  expr: string,
  bee: BeeContext,
): { value: SqlFragment; inverted: boolean } | null {
  const head = expr.includes('(') ? expr.slice(0, expr.indexOf('(')).trim() : expr.trim();

  // Live function term: affinity(bee.held_paths, item.paths) — count of item paths that
  // share a directory-prefix relationship with any path the bee already holds.
  if (head === 'affinity') {
    const held = (bee.heldPaths ?? []).filter((p) => typeof p === 'string' && p.length > 0);
    // No held paths ⇒ affinity is a constant for every row, so it can't reorder
    // anything: drop it from the ORDER BY (NEUTRAL). This also keeps the DEFAULT spec's
    // affinity term from emitting a bare `0` that PG would mis-read as a column position.
    if (held.length === 0) return null;
    // For each held path, count item paths where one is a prefix of the other. Bound the
    // held paths as a text[] parameter — never interpolated.
    return {
      value: sql`(
        SELECT count(*) FROM jsonb_array_elements_text(COALESCE(payload->'paths', '[]'::jsonb)) ip
         WHERE EXISTS (
           SELECT 1 FROM unnest(${held}::text[]) hp
            WHERE ip LIKE hp || '%' OR hp LIKE ip || '%'
         )
      )`,
      inverted: false,
    };
  }

  // Descoped-but-validated function terms (D-010) ⇒ NEUTRAL: kept in the vocabulary so
  // specs referencing them validate, but they don't reorder until their lanes ship.
  if (head === 'model_fit' || head === 'tag_weight' || head === 'redundancy_need') {
    return null;
  }

  // Bare item field.
  const fm = FIELD_MAP[head];
  if (!fm) return null; // unreachable for a validated spec; defensively neutral
  return { value: fm.col(sql), inverted: fm.inverted ?? false };
}

/**
 * Compile `spec.rank` to an ORDER BY `sql` fragment. `lexicographic` ⇒ each term is a
 * hard precedence (term 1, then term 2, …). `weighted` ⇒ a single Σ wᵢ·termᵢ sort key
 * (only numeric terms contribute; affinity/feature_order are numeric). NULLs sort LAST
 * (a NULL feature_order = unprioritized = claimed after prioritized work, matching the
 * legacy `feature_order ASC NULLS LAST`). A trailing `created_ts ASC` tiebreaker makes
 * the order TOTAL ⇒ the resolver is deterministic for a fixed DAG + spec.
 */
export function compileRank(sql: OrgSql, spec: ClaimSpec, bee: BeeContext) {
  const terms = spec.rank.terms;

  if (spec.rank.mode === 'weighted') {
    // Σ wᵢ·termᵢ — only terms that compile to a numeric value contribute. An inverted
    // field is negated (so "more important" is a LARGER contribution). Sort DESC of the
    // weighted sum = best-first; then the deterministic tiebreaker.
    const contribs = terms
      .map((t) => {
        const compiled = compileRankExpr(sql, t.expr, bee);
        if (!compiled) return null;
        const w = Number.isFinite(t.weight) ? (t.weight as number) : 0;
        const signed = compiled.inverted ? sql`(-1 * COALESCE((${compiled.value})::numeric, 0))` : sql`COALESCE((${compiled.value})::numeric, 0)`;
        // A `dir: 'asc'` weighted term contributes with a flipped sign (smaller = better).
        const dirSign = t.dir === 'asc' ? sql`(-1 * ${signed})` : signed;
        return sql`(${w} * ${dirSign})`;
      })
      .filter((c): c is SqlFragment => c != null);
    if (contribs.length === 0) return sql`created_ts ASC`;
    const sum = contribs.reduce((acc, c) => sql`${acc} + ${c}`);
    return sql`(${sum}) DESC, created_ts ASC`;
  }

  // lexicographic: each term ASC/DESC in order, then the total-order tiebreaker.
  const orderings = terms
    .map((t) => compileTermOrdering(sql, t, bee))
    .filter((o): o is SqlFragment => o != null);
  if (orderings.length === 0) return sql`created_ts ASC`;
  const joined = orderings.reduce((acc, o) => sql`${acc}, ${o}`);
  // created_ts ASC as the final tiebreaker (skip if already the last bare term).
  return sql`${joined}, created_ts ASC`;
}

/** One lexicographic term → `<col> ASC|DESC NULLS LAST`, honoring inversion. */
function compileTermOrdering(sql: OrgSql, term: RankTerm, bee: BeeContext): SqlFragment | null {
  const compiled = compileRankExpr(sql, term.expr, bee);
  if (!compiled) return null;
  // An inverted field flips the effective direction: spec `priority desc` ("highest
  // first") ⇒ feature_order ASC.
  const effectiveDesc = compiled.inverted ? term.dir === 'asc' : term.dir === 'desc';
  return effectiveDesc ? sql`${compiled.value} DESC NULLS LAST` : sql`${compiled.value} ASC NULLS LAST`;
}

// ────────────────────────────────────────────────────────────────────────────
// The resolver.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Deterministically claim the next eligible work-item for a bee under its validated
 * claim spec. Atomic: `UPDATE … WHERE (pk) = (SELECT … floors AND filter ORDER BY rank
 * LIMIT 1 FOR UPDATE SKIP LOCKED)`, so two concurrent `get_next` calls claim DIFFERENT
 * items (SKIP LOCKED) and a floored-out item is NEVER claimed even if the spec filter
 * would select it.
 *
 * Returns the claimed item + the spec revision that selected it (provenance), or null
 * when nothing is eligible.
 *
 * PRECONDITION: `spec` is VALIDATED (`validateClaimSpec(spec).ok === true`). The field/
 * op/rank-term vocabulary is closed by the validator, so the compiled SQL is safe; this
 * function does NOT re-validate (the caller — the launch handoff / `set_claim_spec` —
 * validates before persisting the spec on the bee).
 */
export async function getNextWorkItem(
  spec: ClaimSpec,
  bee: BeeContext,
  opts: GetNextOpts,
): Promise<GetNextResult | null> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const useMaintainedReady = await schedulerMaintainedReadyEnabled();

  const floors = claimFloorsWhereSql(sql, {
    harness: opts.harness,
    workspaceId: ws,
    states: opts.states,
    swarmId: opts.swarmId,
    excludeRedundant: opts.excludeRedundant,
    useMaintainedReady,
  });
  const order = compileRank(sql, spec, bee);

  /** One attempt at the compiled query under a given (possibly widened) filter node. */
  const attempt = async (filterNode: FilterNode | undefined): Promise<WorkItem | null> => {
    const filter = compileFilter(sql, filterNode);
    const rows = await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET taken_by = ${bee.assignee}, taken_at = now(), last_progress_at = NULL, updated_ts = ${Date.now()}
       WHERE (harness_slug, feature_id) = (
         SELECT harness_slug, feature_id
           FROM harness_shared.harness_features_consolidated
          WHERE ${floors}
            AND ${filter}
          ORDER BY ${order}
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING ${sql.unsafe(FEATURE_COLS)}`;
    return rows[0] ? featureRowToWorkItem(rows[0]) : null;
  };

  // Tier 1: the spec's view exactly as authored.
  let claimed = await attempt(spec.view.filter);

  // Tier 2 (fallback-ladder P-005, fleet-backlog-lessons-2026-07-01, WI-1407): a spec that
  // narrowed to one feature-family `kind` and drained it must not exit — widen to the REST
  // of the feature family (dropping just the `kind` leaf, keeping every other narrowing —
  // plan/tags/risk_tier/etc — intact) before reporting a miss. `widenPastKind` only rewrites
  // shapes it can simplify safely (a bare leaf or one inside a top-level `all`); when it can't
  // (kind nested in an `any`/`not`), it hands back the SAME node and this tier is a no-op.
  const widened = widenPastKind(spec.view.filter);
  if (!claimed && widened !== spec.view.filter) {
    claimed = await attempt(widened);
  }

  // Tier 3 (SCHEDULER_ISSUES_CLAIMABLE, owner-authority-gated): the whole feature family the
  // spec can see is exhausted — widen to the adjacent ISSUE family too, the SAME additive
  // fallback `claimNextWorkItem` (work-items.ts) applies, so the two claim paths never drift
  // on WHERE the ladder bottoms out. A claim spec has no vocabulary over issue-family fields,
  // so there is nothing spec-specific to carry across — this tier is the shared, unconditional
  // "any open, unblocked bug/change/task" claim.
  if (!claimed && (await schedulerIssuesClaimableEnabled())) {
    claimed = await claimNextIssueWorkItem(
      {
        harness: opts.harness,
        assignee: bee.assignee,
        states: opts.states,
        swarmId: opts.swarmId,
        excludeRedundant: opts.excludeRedundant,
      },
      ws,
    );
  }

  if (!claimed) return null;
  // Same claimed-event as the legacy claim path (best-effort fanout).
  void import('../work-items-events')
    .then((m) => m.emitWorkItemClaimedEvent(claimed!, bee.assignee))
    .catch(() => {});
  return { workItem: claimed, claimedUnder: { specId: spec.specId, revision: spec.revision } };
}

/** Convenience: claim under the baseline spec (no spec = today's ordering, D-003). */
export function getNextWorkItemDefault(bee: BeeContext, opts: GetNextOpts): Promise<GetNextResult | null> {
  return getNextWorkItem(DEFAULT_CLAIM_SPEC, bee, opts);
}
