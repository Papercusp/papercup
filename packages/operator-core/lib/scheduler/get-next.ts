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
 *
 * `states` (drain-claim-spec-hardening-2026-07-13 D-002, fixes EI-11300): the claimable-
 * status floor is likewise spec-carriable — `opts.states` (the caller's per-call arg) wins
 * when given; otherwise the resolver falls back to `spec.states` (the fleet leader's
 * standing policy) before `claimFloorsWhereSql`'s own `['todo']` default. Same NARROW-only
 * discipline as the filter/rank: a spec can set this floor's DEFAULT, never widen past it
 * (the values are still drawn from `CLAIM_STATES_ALLOWLIST`, so `blocked`/`cursed`/terminal
 * remain unreachable).
 */
import type postgres from 'postgres';
import {
  type ClaimSpec,
  type FilterNode,
  type FilterLeaf,
  type RankTerm,
  DEFAULT_CLAIM_SPEC,
  positiveIdCohortIds,
} from './claim-spec';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import {
  claimFloorsWhereSql,
  schedulerMaintainedReadyEnabled,
  schedulerIssuesClaimableEnabled,
  claimNextIssueWorkItem,
  featureRowToWorkItem,
  familyOf,
  FEATURE_COLS,
  ISSUE_FAMILY_KINDS,
  ISSUE_FAMILY_CLAIMABLE_STATES,
  releaseCooldownSec,
  claimHoldExclusionSql,
  needsHumanExclusionSql,
  observationLaneExclusionSql,
  externalBlockersExclusionSql,
  reservedPlanLaneExclusionSql,
  federationDetectorExclusionSql,
  loopIterationNoiseExclusionSql,
  alreadyTerminallyCompletedExclusionSql,
  crossMachineRigExclusionSql,
  type FeatureRowDb,
  type OrgSql,
  type WorkItem,
} from '../work-items';
import { issuesScopeWorkspace } from '../issues-engineer';

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
  /**
   * WI-5261: the caller's already-resolved workspace (e.g. resolveClaimSpecWorkspace's
   * output in getNextForBee) — explicitly threaded through so tier 1/2/3 don't have to
   * re-derive it via activeWorkspaceId()/issuesScopeWorkspace(), which depend on the
   * AsyncLocalStorage request-scope still being intact at the exact moment of the call.
   * Undefined ⇒ unchanged legacy behavior (falls back to activeWorkspaceId() /
   * issuesScopeWorkspace() exactly as before) — purely additive, no breaking change for
   * callers (tests, other entry points) that don't pass one.
   */
  workspaceId?: string;
  /** THIS Swarm's id — when set, the affinity/redundancy FLOORS honor it (per-Hive lease). */
  swarmId?: string;
  /** Skip high-stakes (redundancy > 1) items (redundancy flag on). */
  excludeRedundant?: boolean;
  /**
   * Claimable statuses floor (default ['todo']). An explicit `states` here is the caller's
   * per-call OVERRIDE and always wins; when omitted, `getNextWorkItem` falls back to the
   * claim spec's own `states` (D-002, EI-11300) before the ['todo'] default.
   */
  states?: string[];
  /** WI-2796: caller has/coordinates a live ≥2-machine rig — see crossMachineRigExclusionSql. */
  rigAvailable?: boolean;
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
  // `kind` — EI-11291/D-001 (drain-claim-spec-hardening-2026-07-13): the discriminator is
  // `item_kind` (NOT NULL, defaulted 'feature' by mig 136), never the legacy `kind` column
  // (unrelated free-text metadata on a handful of rows — 'security'/'infra'/etc — NOT an
  // item-kind value; always NULL for the vast majority of rows). COALESCE(item_kind, kind)
  // per D-001: item_kind is structurally never NULL today, so this is defense-in-depth (a
  // future schema regression that let item_kind go NULL would silently fall back to the
  // legacy column instead of never matching), not a behavior change.
  kind: { col: (sql) => sql`COALESCE(item_kind, kind)`, kind: 'scalar-text' },
  age: { col: (sql) => sql`created_ts`, kind: 'scalar-num' },
  est_cost: { col: (sql) => sql`expected_cost_cents`, kind: 'scalar-num' },
  redundancy: { col: (sql) => sql`COALESCE(redundancy, 1)`, kind: 'scalar-num' },
  assignee: { col: (sql) => sql`taken_by`, kind: 'scalar-text' },
  // `id` — the work-item id. A spec PINS a fixed set with `id in [...]` (scalar-text, so
  // the `in` op compiles to `feature_id::text = ANY(...)`). A STATIC pin (no auto-inflow),
  // the exception for a fixed wave; the floors (ready/lease/dedup) still apply on top.
  id: { col: (sql) => sql`feature_id`, kind: 'scalar-text' },
  // `title` — WI-3268: keyword exclusion (glob/contains/!=) so a constrained fleet can
  // durably filter out a class of work (e.g. `*p2p*`) that carries no `tags` data.
  title: { col: (sql) => sql`title`, kind: 'scalar-text' },
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
        // ILIKE (not LIKE): glob is used for human-authored keyword matching (e.g. a
        // path prefix or a tag), and WI-3268's title exclusion depends on
        // case-insensitivity — a proper-noun title like "Hyperswarm sidecar
        // isolation" must still match the lowercase pattern `*hyperswarm*`.
        return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) e WHERE e ILIKE ${globToLike(String(v))})`;
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
        // ILIKE — see the json-array glob branch above: WI-3268's title exclusion
        // (`*hyperswarm*` must match "Hyperswarm sidecar isolation") needs
        // case-insensitive matching, and there is no scalar-text use case that
        // wants case-SENSITIVE glob matching to break instead.
        return sql`${col}::text ILIKE ${globToLike(String(v))}`;
      }
      if (leaf.op === 'contains') {
        // substring containment for a scalar (text) field — same case-insensitivity
        // rationale as `glob` immediately above.
        return sql`${col}::text ILIKE ${'%' + String(v) + '%'}`;
      }
      // Relational + equality ops on a scalar column. `inverted` (feature_order /
      // priority): flip the comparator so the spec author's intent on the LOGICAL
      // field maps to the physical inverted column.
      const op = fm.inverted ? invertComparator(leaf.op) : leaf.op;
      const bound = fm.kind === 'scalar-num' ? sql`${Number(v)}` : sql`${String(v)}`;
      const cmp = fm.kind === 'scalar-num' ? sql`${col}` : sql`${col}::text`;
      switch (op) {
        case '=':
          // NULL never matches a positive `=` — correct, and matches the JS evaluator.
          return sql`${cmp} = ${bound}`;
        case '!=':
          // IS DISTINCT FROM, not `<>` (EI-13306). A NULL row is DISTINCT from any value, so
          // `plan != 'x'` ADMITS a row with no plan — which is what the author means, and what
          // the ARRAY branches above already do: text-array `!=` compiles to
          // `NOT (v = ANY(COALESCE(col, ARRAY[]::text[])))`, which on a NULL column is
          // `NOT false` = true. Scalar `<>` was the odd one out, yielding NULL -> row dropped.
          // The JS evaluator's compareScalar carries the matching null-admits case for `!=`.
          return sql`${cmp} IS DISTINCT FROM ${bound}`;
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
    if (filter.field !== 'kind') return filter;
    // Only a kind leaf that admits a FEATURE-family kind is widenable (EI-7481): an issue-only
    // constraint (e.g. kind='bug') has no feature-family sibling to widen to — dropping it here
    // would let a bug-only member claim a feature/research-task/chunk. Leave it in place so this
    // tier is a no-op and the kind-preserving tier-3 issue fallback handles the lane.
    return kindLeafWidensToFeatureFamily(filter) ? undefined : filter;
  }
  if ('all' in filter) {
    let changed = false;
    const kept = filter.all.filter((node) => {
      // Same family guard for a kind leaf nested in a top-level `all`: only drop a
      // feature-family-admitting kind leaf; keep an issue-only one so the `all` stays lane-safe.
      const isWidenableKindLeaf = isLeaf(node) && node.field === 'kind' && kindLeafWidensToFeatureFamily(node);
      if (isWidenableKindLeaf) changed = true;
      return !isWidenableKindLeaf;
    });
    if (!changed) return filter; // no widenable feature-family kind leaf inside this `all`
    if (kept.length === 0) return undefined;
    return kept.length === 1 ? kept[0] : { all: kept };
  }
  // `any` / `not` — leave unrewritten (see doc comment above).
  return filter;
}

/**
 * EI-7481: true iff a `kind` leaf admits at least one FEATURE-family kind — the only case
 * tier 2's "widen to the rest of the feature family" is meaningful. An issue-only kind
 * constraint (`kind='bug'`, `kind in ['bug','change']`, `kind='task'`) must NOT be widened
 * into the feature family; its lane is issues (the kind-preserving tier-3 fallback). `!=`
 * excludes one kind but still admits the rest of the feature family, so it stays widenable.
 */
function kindLeafWidensToFeatureFamily(leaf: FilterLeaf): boolean {
  const values = (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).map(String);
  if (leaf.op === '=' || leaf.op === 'in') {
    return values.some((v) => familyOf(v) === 'feature');
  }
  // `!=` / glob / contains — a negative or fuzzy kind match still leaves feature-family kinds
  // in scope, so widening to the feature family remains the intended fallback.
  return true;
}

const ISSUE_KIND_SET = new Set<string>(ISSUE_FAMILY_KINDS);
type IssueFallbackKind = (typeof ISSUE_FAMILY_KINDS)[number];

function intersectIssueKinds(
  current: Set<IssueFallbackKind> | undefined,
  next: Iterable<IssueFallbackKind>,
): Set<IssueFallbackKind> {
  const incoming = new Set(next);
  if (!current) return incoming;
  return new Set([...current].filter((kind) => incoming.has(kind)));
}

/**
 * Tier-3 issue fallback normally preserves WI-1407's "feature-family dry ⇒ adjacent
 * issues" behavior. When a spec explicitly names issue-family kinds, however, that
 * is a real lane constraint and must survive the fallback, or a bug-only fleet can
 * claim a task (WI-2118's ping-pong shape).
 *
 * Conservatively inspect `all`/leaf filters only. OR/NOT filters can express more
 * complex set logic; leave those as the legacy unrestricted issue fallback rather
 * than narrowing incorrectly.
 */
function issueKindsForFallback(filter: FilterNode | undefined): readonly IssueFallbackKind[] | undefined {
  let allowed: Set<IssueFallbackKind> | undefined;
  let sawIssueKindConstraint = false;

  function applyLeaf(leaf: FilterLeaf): boolean {
    if (leaf.field !== 'kind') return true;
    const values = (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).map(String);
    const issueValues = values.filter((v): v is IssueFallbackKind => ISSUE_KIND_SET.has(v));
    if (leaf.op === '=' || leaf.op === 'in') {
      if (issueValues.length > 0) {
        sawIssueKindConstraint = true;
        allowed = intersectIssueKinds(allowed, issueValues);
      }
      return true;
    }
    if (leaf.op === '!=') {
      if (issueValues.length > 0) {
        sawIssueKindConstraint = true;
        const base = allowed ?? new Set<IssueFallbackKind>(ISSUE_FAMILY_KINDS);
        for (const kind of issueValues) base.delete(kind);
        allowed = base;
      }
      return true;
    }
    return true;
  }

  function walk(node: FilterNode): boolean {
    if (isLeaf(node)) return applyLeaf(node);
    if ('all' in node) return node.all.every(walk);
    return false;
  }

  if (!filter || !walk(filter) || !sawIssueKindConstraint || !allowed) return undefined;
  return [...allowed];
}

/**
 * WI-5258/WI-5275 companion to tier 3's id handling above: extract the ids a `not`-wrapped id
 * leaf NEGATIVELY excludes — `{ not: { field:'id', op:'='|'in', value:[...] } }`, bare or
 * directly inside a top-level `all` (the same conservative bare/all-only shapes
 * {@link positiveIdCohortIds} and {@link issueKindsForFallback} handle; deeper nesting under
 * `any`/`not` is left alone rather than guessed at). Multiple such leaves union (excluding
 * from set A and set B excludes A∪B).
 *
 * The exclusion must be HONORED regardless of whether a positive id set was also extracted —
 * `claimNextIssueWorkItem` only ever received `issueKinds` + `ids` (the POSITIVE cohort), with
 * no way to see a negative exclusion, so without this a fleet's "already-handled, skip these"
 * ids came right back through the fallback (caught by this WI's own regression test before it
 * shipped: tier 3 claimed the excluded id, not the other open one). Threaded into
 * `claimNextIssueWorkItem`'s `excludeIds` opt.
 */
function negativeIdExclusions(filter: FilterNode | undefined): string[] {
  function idLeafValues(node: FilterNode): string[] | null {
    if (!isLeaf(node) || node.field !== 'id' || (node.op !== '=' && node.op !== 'in')) return null;
    const raw = Array.isArray(node.value) ? node.value : [node.value];
    return raw.map(String);
  }
  function notExclusion(node: FilterNode): string[] | null {
    if (isLeaf(node) || !('not' in node)) return null;
    return idLeafValues(node.not);
  }
  if (!filter) return [];
  const out = new Set<string>();
  const direct = notExclusion(filter);
  if (direct) {
    direct.forEach((v) => out.add(v));
  } else if (!isLeaf(filter) && 'all' in filter) {
    for (const node of filter.all) {
      const vals = notExclusion(node);
      if (vals) vals.forEach((v) => out.add(v));
    }
  }
  return [...out];
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
    // `not` — COALESCE to false BEFORE negating (EI-13306). SQL three-valued logic makes
    // a bare `NOT (...)` silently drop every row whose field is NULL: for a nullable column
    // (plan/assignee/risk_tier/...), `plan = 'x'` on a NULL row is NULL, and `NOT NULL` is
    // NULL — which a WHERE clause treats as not-TRUE, so the row VANISHES. That is the exact
    // inverse of what `not:` means to a spec author ("a row with no plan is certainly not in
    // plan X — admit it"), and it fails SILENT: the spec validates ok, and get_next reports an
    // honest-looking scoped miss while the whole backlog is invisible. It has starved this
    // fleet twice: `not:{plan glob 'p2p-*'}` and `not:{plan = '<slug>'}`, the latter measured
    // collapsing the claimable pool 2341 -> 4.
    //
    // COALESCE(inner, false) maps "unknown" to "did not match", so `not` then ADMITS the row.
    // This is also what the JS evaluator (claim-spec-match.ts `matchesClaimSpecFilter`) has
    // always done — `!matchLeaf(...)` on a null subject is `!false` = true. The two evaluators
    // of one spec language MUST agree; claim-spec-null-semantics.integration.test.ts pins that parity.
    return sql`NOT COALESCE((${walk(node.not)}), false)`;
  }
  return sql`(${walk(filter)})`;
}

/**
 * EI-13965 — the scoped-miss AGGREGATE floor breakdown for the common case
 * `explainIssueClaimFloors` cannot cover: a BROAD spec (a fleet member's plan/kind-scoped
 * view, no `id in [...]` clause to attribute per-id). Live incident (2026-07-17,
 * curation-signals fleet): a member drained its lane and reported "items visible in both
 * bound plans but none match the spec" — the leader took ~6 queries to discover the pool
 * was NOT empty, just stranded behind three DIFFERENT floors (claim-hold, taken-by-
 * outside-agents, plan-item-lane-guard release). A member with a broad spec has no named
 * ids for `explainIssueClaimFloors` to attribute, so it got nothing.
 *
 * ONE aggregate query: how many issue-family rows the caller's OWN `view.filter` selects
 * (`matchedByFilter`, via {@link compileFilter} — the SAME compiled fragment `get_next`'s
 * narrowing applies, so this can never disagree with what the spec would actually admit),
 * then — of the UNTAKEN subset — how many EACH floor independently would exclude (a row
 * can land in more than one bucket; this is "why is the pool stranded", not a partition).
 * Reuses the SAME exported floor predicates `diagnoseClaimNextMiss` /
 * `explainIssueClaimFloors` already evaluate — drift-proof by construction, never a
 * re-implementation that could disagree with the real claim.
 *
 * NOT covered: the plan-item-lane-guard's FINE-grained per-item check (a linked plan
 * item's own resolved status — blocked / cycle / terminal-residue) is deliberately a
 * POST-CLAIM, JS-side check over the plan's JSONB items index (see
 * scheduler/plan-item-lane-guard.ts's module doc) — not a cheap SQL predicate, so it
 * cannot be folded into this aggregate without either re-implementing it in SQL (a new
 * way to drift/lie) or paying a per-row plan-parse cost this "cheap, one aggregate query"
 * diagnosis is not meant to carry. `planLaneReserved` below only reflects the COARSER
 * floor (the linked plan is currently `active` at all) — a caller seeing zero excluded
 * here can still miss via that guard; the advice text says so.
 */
export interface IssueClaimExclusionBreakdown {
  /** Issue-family rows (claimable status, this harness/workspace) the spec's OWN
   *  view.filter matches — BEFORE taken/floors. 0 here means the spec itself is the
   *  problem (a kind/plan/tag scoping that matches nothing), not a floor. */
  matchedByFilter: number;
  /** Of matchedByFilter, how many survive spec_match AND EVERY floor — the count a
   *  self-selecting caller would actually see as claimable RIGHT NOW (identical to
   *  {@link listIssueClaimableRows}' total before its LIMIT). NOT `matched − Σexcluded`:
   *  the `excluded` buckets OVERLAP (a row can be counted under several floors at once),
   *  so this is a DISTINCT additive count of rows passing every predicate, computed by the
   *  SAME inner subquery. This is the ONE number the whole claimability-clarity plan makes
   *  trustworthy — the `0 claimable` a wind-down / drain decision hinges on. */
  claimable: number;
  /** Of matchedByFilter, counts of why each is NOT self-selectable right now. Every
   *  floor after `taken` is counted only among the UNTAKEN subset (a taken row is
   *  trivially excluded for that reason alone — counting it again under e.g. claimHold
   *  would double up and mislead). Buckets are INDEPENDENT, not a partition: a row can
   *  be counted under more than one floor. */
  excluded: {
    taken: number;
    claimHold: number;
    needsHuman: number;
    observationLane: number;
    externalBlocker: number;
    planLaneReserved: number;
    federationDetector: number;
    loopNoise: number;
    alreadyCompleted: number;
    crossMachineRig: number;
    blockedDep: number;
    cooldown: number;
  };
}

export async function aggregateIssueClaimExclusions(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
  },
): Promise<IssueClaimExclusionBreakdown> {
  const sql = getOrgPg().sql;
  const states = [...(opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
  // Mirror diagnoseClaimNextMiss's own resolution — the issue-family scope workspace,
  // never the caller's harness-scoped workspaceId (they can legitimately differ).
  const issueWs = issuesScopeWorkspace();
  const operatorScopeSlug = `operator:${issueWs}`;
  const assignee = opts.assignee ?? '';
  const compiled = compileFilter(sql, filter);
  const cooldown = releaseCooldownSec();
  const sub = issueClaimCandidateSubquery(sql, {
    compiled,
    assignee,
    cooldown,
    harness: opts.harness,
    states,
    issueWs,
    operatorScopeSlug,
    rigAvailable: opts.rigAvailable,
  });

  const rows = (await sql`
    SELECT
      count(*) FILTER (WHERE spec_match)::int                                         AS matched,
      count(*) FILTER (WHERE spec_match AND ${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)})::int AS claimable,
      count(*) FILTER (WHERE spec_match AND NOT ok_untaken)::int                       AS taken,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_claim_hold)::int      AS claim_hold,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_needs_human)::int     AS needs_human,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_observation)::int     AS observation_lane,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_external_blocker)::int AS external_blocker,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_plan_lane)::int       AS plan_lane_reserved,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_federation)::int      AS federation_detector,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_loop_noise)::int      AS loop_noise,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_completed)::int       AS already_completed,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_rig)::int             AS cross_machine_rig,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_no_blocker)::int      AS blocked_dep,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_cooldown)::int        AS cooldown
    FROM (${sub}) sub
  `) as Array<{
    matched: number;
    claimable: number;
    taken: number;
    claim_hold: number;
    needs_human: number;
    observation_lane: number;
    external_blocker: number;
    plan_lane_reserved: number;
    federation_detector: number;
    loop_noise: number;
    already_completed: number;
    cross_machine_rig: number;
    blocked_dep: number;
    cooldown: number;
  }>;
  const r = rows[0];
  return {
    matchedByFilter: r?.matched ?? 0,
    claimable: r?.claimable ?? 0,
    excluded: {
      taken: r?.taken ?? 0,
      claimHold: r?.claim_hold ?? 0,
      needsHuman: r?.needs_human ?? 0,
      observationLane: r?.observation_lane ?? 0,
      externalBlocker: r?.external_blocker ?? 0,
      planLaneReserved: r?.plan_lane_reserved ?? 0,
      federationDetector: r?.federation_detector ?? 0,
      loopNoise: r?.loop_noise ?? 0,
      alreadyCompleted: r?.already_completed ?? 0,
      crossMachineRig: r?.cross_machine_rig ?? 0,
      blockedDep: r?.blocked_dep ?? 0,
      cooldown: r?.cooldown ?? 0,
    },
  };
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
function compileRankExpr(sql: OrgSql, expr: string, bee: BeeContext): { value: SqlFragment; inverted: boolean } | null {
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
        const signed = compiled.inverted
          ? sql`(-1 * COALESCE((${compiled.value})::numeric, 0))`
          : sql`COALESCE((${compiled.value})::numeric, 0)`;
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
  const orderings = terms.map((t) => compileTermOrdering(sql, t, bee)).filter((o): o is SqlFragment => o != null);
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
  // WI-5261: prefer the caller's explicitly-resolved workspace (threaded via opts.workspaceId)
  // over re-deriving it here — activeWorkspaceId() depends on the AsyncLocalStorage request
  // scope still being intact at this exact point in the async call chain (tool handler ->
  // getNextForBee -> here -> tier 3's claimNextIssueWorkItem), several awaits deep. Falls back
  // to the legacy activeWorkspaceId() when omitted (unchanged behavior for other callers).
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const useMaintainedReady = await schedulerMaintainedReadyEnabled();

  // drain-claim-spec-hardening-2026-07-13 D-002 (fixes EI-11300): `states` is drain-wide
  // POLICY, so it rides the SPEC — a per-call `opts.states` (the caller's explicit
  // override) still WINS; only when the caller omits one do we fall back to the spec's
  // `states` (set once by the fleet leader / queen via scheduler:set_claim_spec, inherited
  // by every member); neither present ⇒ claimFloorsWhereSql's own `['todo']` default.
  const effectiveStates = opts.states ?? spec.states;

  const floors = claimFloorsWhereSql(sql, {
    harness: opts.harness,
    workspaceId: ws,
    states: effectiveStates,
    swarmId: opts.swarmId,
    excludeRedundant: opts.excludeRedundant,
    useMaintainedReady,
    // Release-cooldown floor (P-005 / EI-6956): a row THIS bee just released is
    // excluded for it (and only it) for the cooldown window — no claim/release
    // ping-pong under a stable rank.
    cooldownAssignee: bee.assignee,
    // EI-14806: the cross-machine-rig floor now applies to the FEATURE family too (tiers 1/2
    // query this fragment). Omitted/false ⇒ a payload.needs_2_machine_rig feature is excluded
    // for a single-box caller, matching the issue-family tier-3 floor (claimNextIssueWorkItem).
    rigAvailable: opts.rigAvailable,
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
  // on WHERE the ladder bottoms out. Most feature-family filters still have no issue-family
  // vocabulary, so they preserve WI-1407's unrestricted adjacent-issue fallback. Explicit
  // issue-kind filters are different: carry that lane constraint across so a bug/change fleet
  // does not claim a reserved task.
  //
  // EI-10062: an explicit `id`-allowlist spec has NO `kind` leaf for issueKindsForFallback to
  // find, so it read as "no lane constraint" and this tier claimed ANY open issue-family row —
  // not just the named ids. An id-allowlist is a closed-world set with no wider family to
  // widen into.
  //
  // WI-4309: EI-10062's original fix skipped tier 3 ENTIRELY whenever an id constraint was
  // present — which meant an issue-only id-allowlist spec (e.g. a leader's hand-curated
  // bug-drain wave of EI-/WI- ids, no `kind` leaf) could NEVER be served by get_next, even
  // while its named items sat open+unclaimed: tier 1 only queries the feature-family table
  // and structurally can't match an issue-family id, and tier 2 is a no-op with no `kind`
  // leaf to widen — so with tier 3 also skipped, the ladder had NO path left for such a spec
  // and always reported a false drain. Fix: extract the literal id set (when the shape allows
  // it — positiveIdCohortIds) and THREAD it through tier 3 so it narrows to exactly those ids,
  // instead of either ignoring the constraint (the original leak) or refusing to run at all.
  //
  // WI-5275 (live incident, 2026-07-17, backlog-drain-clean@12): the "when it can't be safely
  // extracted, skip tier 3 entirely" fallback above was ITSELF the bug, not just a conservative
  // edge case. It fires whenever an `id` leaf appears ANYWHERE in the tree (formerly detected by
  // the now-removed `filterHasIdConstraint`, which recursed into `any`) — but an id leaf reached
  // through a positive `any` (OR) branch does NOT establish a closed-world identity set at all:
  // `id in [...] OR <broad-condition>` WIDENS admission (admits strictly MORE than
  // <broad-condition> alone), it never narrows it. The live fleet spec here was exactly this
  // shape — `any: [{id in [WI-5270, WI-5272]}, {not: <p2p-title exclusion>}]`, ANDed with a
  // `kind in [bug,change,task,feature]` leaf — a normal, wide-open drain-spec pinning two extra
  // ids as a widening exception. Because the id leaf could not be *safely extracted* from that
  // `any` (positiveIdCohortIds correctly refuses to guess), the old code treated "can't extract"
  // as "conservatively skip tier 3 altogether" — which meant tier 3 (the ONLY path that serves
  // bug/change/task work; the feature-family tiers 1/2 structurally cannot see issue-family rows)
  // NEVER ran for this spec, permanently starving the WHOLE fleet of its entire non-p2p
  // bug/change/task backlog (hundreds of genuinely admissible, unclaimed items) while
  // scheduler:get_next kept reporting a clean drain.
  //
  // Fix: stop gating tier 3 on "does an id leaf exist anywhere". Just narrow by `ids` whenever
  // positiveIdCohortIds can SAFELY extract a genuine closed-world set (bare leaf, or ANDed at
  // the top level via `all` — unchanged, still exactly EI-10062/WI-4309's guarantee); otherwise
  // run tier 3 UNRESTRICTED by id (kind-narrowed when issueKindsForFallback can extract one) and
  // rely on the SAME safety net a no-id-leaf spec already depends on: getNextForBee's mandatory
  // post-claim `matchesWorkItemClaimSpec` re-check against the FULL filter tree (which correctly
  // evaluates `any`/`not` OR/NOT semantics, unlike this SQL-side narrowing) + its bounded
  // release-and-retry loop. This can never violate a genuine closed-world allowlist (that shape
  // is still always safely extracted and threaded through), and it can never serve a
  // spec-violating item (the post-claim check releases and retries) — it only stops the
  // ENTIRE-lane starvation that a merely-inconvenient-to-extract id leaf used to cause.
  if (!claimed && (await schedulerIssuesClaimableEnabled())) {
    const idValues = positiveIdCohortIds(spec.view.filter) ?? undefined;
    const issueKinds = issueKindsForFallback(spec.view.filter);
    // WI-5258: a positive allowlist (idValues) and a negative exclusion are mutually
    // exclusive in practice (a spec that already names a closed-world positive set has
    // nothing left to additionally exclude), but thread both regardless — the query
    // ANDs them, so an empty excludeIds is simply a no-op.
    const excludeIds = negativeIdExclusions(spec.view.filter);
    claimed = await claimNextIssueWorkItem(
      {
        harness: opts.harness,
        assignee: bee.assignee,
        states: effectiveStates,
        swarmId: opts.swarmId,
        excludeRedundant: opts.excludeRedundant,
        rigAvailable: opts.rigAvailable,
      },
      ws,
      { issueKinds, ids: idValues, excludeIds: excludeIds.length ? excludeIds : undefined },
    );
  }

  if (!claimed) return null;
  // Same claimed-event as the legacy claim path (best-effort fanout).
  void import('../work-items-events').then((m) => m.emitWorkItemClaimedEvent(claimed!, bee.assignee)).catch(() => {});
  return { workItem: claimed, claimedUnder: { specId: spec.specId, revision: spec.revision } };
}

/** Convenience: claim under the baseline spec (no spec = today's ordering, D-003). */
export function getNextWorkItemDefault(bee: BeeContext, opts: GetNextOpts): Promise<GetNextResult | null> {
  return getNextWorkItem(DEFAULT_CLAIM_SPEC, bee, opts);
}
