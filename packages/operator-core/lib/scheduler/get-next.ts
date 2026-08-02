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
import { boundedOrgTxn, OrgTxnTimeoutError } from '../pg-bounded-txn';
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
import { isIssueLocallyClaimableWhereSql } from '../work-items-admission';

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
  /**
   * EI-18805386252364731: override the claim ladder's time budget in ms (default
   * CLAIM_LADDER_BUDGET_MS, per-attempt capped at CLAIM_ATTEMPT_BUDGET_MS). Lets a caller with
   * a tighter SLA than the transport bound the pull, and lets the recurrence guard assert that
   * an exhausted budget raises a TYPED error instead of a drain-shaped miss.
   */
  claimBudgetMs?: number;
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
 *    (`payload->>'risk_tier'`, `payload->'paths'`), so a spec can filter on them without
 *    a schema change. `risk_tier` is filter-ONLY: the jsonb accessor yields TEXT, so a
 *    bare rank on it sorts lexically (EI-19286311763526137 — see its FIELD_MAP entry).
 *  - `plan_item` ⇒ `source_plan_item_ids` (a text[]), the only array item-field.
 */
/**
 * Time budget for ONE claim attempt, and for the whole fallback ladder (EI-18805386252364731).
 *
 * The ladder runs its query up to three tiers plus a release-and-retry loop, so these are two
 * genuinely different bounds: the per-attempt value caps a single pathological statement, and
 * the ladder value caps their SUM — without the latter, several individually-affordable
 * attempts still add up to a pull that never returns.
 *
 * Sized to stay comfortably under the MCP transport's own patience so the failure surfaces as a
 * typed error from US, with a spec to blame, rather than as an opaque client-side abort.
 */
const CLAIM_ATTEMPT_BUDGET_MS = 5_000;
const CLAIM_LADDER_BUDGET_MS = 15_000;

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
  // `severity` — WI-6675. Issue-family severity (critical|major|minor|nit) as a FILTER
  // field, so a drain lane can scope itself with `severity in ['critical','major']`.
  // The accessor is `payload->'_ei'->>'severity'` FIRST with a top-level fallback, which
  // is WI-6674's finding and matches this file's own projection at the claimable query
  // below: severity has two access paths (the TABLE keeps it under the `_ei` fold from
  // migration 374; the VIEW explodes `_ei` into real columns and DROPS the blob), and the
  // wrong path for a relation yields NULL for EVERY row without erroring — a query that
  // returns a well-formed, plausible, wrong answer. Measured 2026-08-01: 0 of 13,711 open
  // rows via the top-level path vs 13,711 via the correct one, reporting 30 genuine
  // criticals as none. The JS evaluator (claim-spec-match.ts) resolves this field in the
  // SAME precedence order deliberately — the two admission evaluators MUST agree on one
  // field's logical source or the same spec admits an item on one family's path and
  // refuses it on the other's (WI-5781, documented on `plan` below).
  // NOT rankable: RANKABLE_ITEM_FIELDS excludes it because severity is TEXT, so a bare
  // `severity desc` would sort nit > minor > major > critical — exactly backwards.
  // BOTH claim queries compile this same fragment, and the asymmetry is intended rather
  // than incidental: the issue-family query reads harness_shared.work_items, where the
  // `_ei` leg resolves; the feature-family query reads harness_features_consolidated,
  // where severity is structurally absent (work-items.ts maps feature rows `severity:
  // null`), so the expression yields NULL and a severity-scoped filter simply refuses
  // every feature row. That is the correct semantic — severity is an issue-family notion,
  // so a lane scoped to `severity in [critical,major]` SHOULD admit no features — and the
  // jsonb operators are valid on both relations (both carry a `payload` column, as the
  // `plan` entry below already relies on), so this is a clean NULL, never an error.
  severity: {
    col: (sql) => sql`COALESCE(payload->'_ei'->>'severity', payload->>'severity')`,
    kind: 'scalar-text',
  },
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
  // EI-18654360178824151: COALESCE the physical column with the SAME payload-derivation
  // fallback `planSlugOfWorkItem()` (claim-spec-match.ts) uses for the issue-family JS
  // evaluator — the two admission evaluators (this SQL compiler for feature-family items,
  // the JS evaluator for everything else) must resolve `plan`/`tags` from the SAME logical
  // source, or the SAME spec admits an item on one family's path and refuses it on the
  // other's (confirmed live: WI-5781 — plan linkage lived only in `payload.plan_item.*`,
  // the column was NULL, the JS-side issue-family path admitted it, the SQL-side
  // feature-family path did not). Mirrors `planSlugOfWorkItem`'s precedence exactly:
  // `payload.plan_item` (or `payload.planItem`) `.plan_slug`/`.slug`, then top-level
  // `payload.source_plan_slug` — column first because it's indexed (hfc_source_plan_slug_idx)
  // and authoritative whenever it's set; the payload legs are a fallback for items whose
  // plan linkage was only ever written to payload.
  plan: {
    col: (sql) => sql`COALESCE(
      source_plan_slug,
      payload->'plan_item'->>'plan_slug',
      payload->'plan_item'->>'slug',
      payload->'planItem'->>'plan_slug',
      payload->'planItem'->>'slug',
      payload->>'source_plan_slug'
    )`,
    kind: 'scalar-text',
  },
  plan_item: { col: (sql) => sql`source_plan_item_ids`, kind: 'text-array' },
  // Not first-class columns — projected out of payload jsonb (no schema change).
  // `risk_tier` is FILTER-ONLY (EI-19286311763526137): `payload->>'risk_tier'` is TEXT
  // however numeric the authored value looks, so a bare `risk_tier` rank sorts lexically
  // ('10' before '2'; high < low < medium for word-valued tiers) — severity's inversion
  // trap, which this field was flagged as "the next domino" for. Excluded from
  // RANKABLE_ITEM_FIELDS; filtering is unchanged and is the only way it has been used
  // (0 of 292 live specs rank on it, and no work_items row carries the key at all).
  risk_tier: { col: (sql) => sql`(payload->>'risk_tier')`, kind: 'scalar-text' },
  // EI-18654360178824151: same single-source fix as `plan` above — mirrors
  // `staticTagsOfWorkItem()`'s `payload.tags` fallback so a tags-filtered spec agrees
  // across both admission evaluators.
  tags: { col: (sql) => sql`COALESCE(tags, payload->'tags')`, kind: 'json-array' },
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
      if (leaf.op === 'word') {
        // Word-boundary literal match — see wordBoundaryPgRegex above.
        return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) e WHERE e ~* ${wordBoundaryPgRegex(String(v))})`;
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
      if (leaf.op === 'word') {
        // Word-boundary literal match — see wordBoundaryPgRegex above.
        return sql`${col}::text ~* ${wordBoundaryPgRegex(String(v))}`;
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
 * Escape a literal for interpolation into a Postgres ARE (advanced regular
 * expression), used by the `word` op below. Mirrors claim-spec-match.ts's
 * `escapeRegexLiteral` (JS regex metachars are the same set Postgres ARE uses).
 */
function escapePgRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The SQL mirror of the JS evaluator's `word` boundary (EI-18690730909662985):
 * a case-insensitive WHOLE-WORD substring match, unlike `glob`'s bare substring
 * ILIKE which false-positives on a literal nested inside a larger word (e.g.
 * `*p2p*` matching "nonp2p-bug-drain").
 *
 * Uses explicit `[^A-Za-z0-9]`/string-edge boundaries, NOT Postgres's `\m`/`\M`
 * word anchors: Postgres counts `_` as a word character exactly as JS `\b` does,
 * so `\mreplication\M` does not match "replication_soak" — the snake_case blind
 * spot that leaked WI-5639 into a non-P2P fleet. Verified both engines agree
 * before AND after this change. Keep in sync with claim-spec-match.ts's
 * `wordBoundaryRegex` (which carries the full rationale) and
 * claim-spec-payload-filter.ts's `wordBoundaryRegexSource`.
 */
function wordBoundaryPgRegex(literal: string): string {
  const lit = escapePgRegexLiteral(literal);
  return `(^|[^A-Za-z0-9])${lit}([^A-Za-z0-9]|$)`;
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
 * Tier-3 companion to {@link widenPastKind}: drop the `kind` leaves that admit ONLY
 * feature-family kinds, leaving the REST of the tree intact, so tier 3 can compile the
 * spec's real narrowings (title/paths/plan/tags/`not` legs) into the ISSUE-family claim
 * query without also carrying the feature-family `kind` constraint it is deliberately
 * widening past.
 *
 * Why this exists (the regression this fixes): threading the full compiled filter into
 * tier 3 (the line that re-unified the CLAIM path with the READ path — see
 * `getNextWorkItem`'s tier-3 block) ALSO carried leaves like `kind = 'feature'` into a
 * query over `harness_shared.work_items`, whose rows are all bug/change/task. That leaf can
 * never be true there, so the compiled filter was an unsatisfiable `FALSE` and tier 3 — the
 * ONLY tier that serves issue-family work — matched zero rows for every feature-narrowed
 * spec, silently re-breaking WI-1407's "feature family dry ⇒ fall through to an adjacent
 * open issue" contract (caught by its regression test).
 *
 * A kind leaf that admits an ISSUE kind (`kind in ['bug','change']`, `kind != 'feature'`,
 * a glob) is KEPT: there it is a genuine lane constraint, and compiling it is exactly the
 * narrowing tier 3 wants. It must NOT be delegated to `issueKindsForFallback` alone —
 * that extraction gives up (returns undefined ⇒ unrestricted) as soon as an `any`/`not`
 * appears anywhere in the tree, so a shape like `all[ kind in ['bug'], any[…] ]` would
 * lose the bug-only narrowing and let tier 3 claim a reserved task.
 *
 * Same conservative shapes as its siblings — a bare leaf, or a leaf directly inside a
 * top-level `all`. A `kind` leaf nested under `any`/`not` is left alone (dropping it would
 * change OR/NOT semantics); it stays compiled, which can only ever narrow, never over-serve.
 */
function stripFeatureOnlyKindLeaves(filter: FilterNode | undefined): FilterNode | undefined {
  const isFeatureOnlyKindLeaf = (node: FilterNode): boolean =>
    isLeaf(node) && node.field === 'kind' && kindLeafAdmitsNoIssueKind(node);

  if (!filter) return undefined;
  if (isLeaf(filter)) return isFeatureOnlyKindLeaf(filter) ? undefined : filter;
  if ('all' in filter) {
    const kept = filter.all.filter((node) => !isFeatureOnlyKindLeaf(node));
    if (kept.length === filter.all.length) return filter; // nothing dropped
    if (kept.length === 0) return undefined;
    return kept.length === 1 ? kept[0] : { all: kept };
  }
  // `any` / `not` — leave unrewritten (see doc comment above).
  return filter;
}

/**
 * True iff a `kind` leaf can admit NO issue-family kind at all — i.e. it is a purely
 * feature-family constraint, the one tier 3 widens past. Only the POSITIVE ops can rule
 * the issue family out; `!=` / glob / contains all still leave issue kinds in scope, so
 * they are (correctly) evaluated rather than dropped.
 */
function kindLeafAdmitsNoIssueKind(leaf: FilterLeaf): boolean {
  if (leaf.op !== '=' && leaf.op !== 'in') return false;
  const values = (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).map(String);
  return values.every((v) => !ISSUE_KIND_SET.has(v));
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
    /** WI-6409: a true-remote-origin row (federated in from a peer node, not authored by
     *  this node — see {@link isIssueLocallyClaimableWhereSql}). The real claim path
     *  (`claimNextIssueWorkItem`) and the READY miss-diagnosis have enforced this floor
     *  since work-item-status-full-unify (2026-07-20); this oracle did not apply it at
     *  all until WI-6409, so it OVER-COUNTED `claimable` by every untaken remote row —
     *  the confirmed root cause of the recurring "claim-path/read-path divergence"
     *  class (EI-10062/WI-4309/WI-5275/WI-5822/WI-6409): the oracle reported N
     *  survivors while `scheduler:get_next` claimed 0, because N of them were
     *  remote-origin and only the real claim path refused them. */
    remoteOrigin: number;
  };
}

/** The AND of every per-row claim-floor predicate (the `ok_*` booleans decorated by
 *  {@link issueClaimCandidateSubquery}). A row for which this holds AND `spec_match` is
 *  claimable RIGHT NOW. Defined ONCE so the survivors COUNT
 *  ({@link aggregateIssueClaimExclusions}'s `claimable`) and the survivors ROW LIST
 *  ({@link listIssueClaimableRows}) apply the byte-identical bar — add/remove a floor and
 *  both move together. Pure column identifiers, no bound values, so `sql.unsafe` is safe.
 *
 *  SCOPE OF THAT GUARANTEE (WI-5947): identical-bar is a SEMANTIC guarantee, per snapshot.
 *  It does NOT make two separate round-trips atomic — against a concurrently-mutating table
 *  they observe different snapshots and legitimately disagree. Callers that present the
 *  count and the list together as one verdict MUST read them through
 *  {@link readIssueClaimability}, which puts them in one REPEATABLE READ transaction. */
const ALL_ISSUE_CLAIM_FLOORS_PASS =
  `ok_untaken AND ok_claim_hold AND ok_needs_human AND ok_observation ` +
  `AND ok_external_blocker AND ok_plan_lane AND ok_federation AND ok_loop_noise ` +
  `AND ok_completed AND ok_rig AND ok_no_blocker AND ok_cooldown AND ok_origin`;

/**
 * The SHARED inner subquery for issue-family claimability: every candidate issue-family
 * row for the harness/workspace/states, decorated with `spec_match` + one `ok_<floor>`
 * boolean per claim floor — each computed by the SAME exported floor-predicate helper the
 * real claim path (`claimNextIssueWorkItem`) enforces. Both
 * {@link aggregateIssueClaimExclusions} (which COUNTs the booleans) and
 * {@link listIssueClaimableRows} (which SELECTs the rows passing {@link ALL_ISSUE_CLAIM_FLOORS_PASS})
 * wrap this ONE fragment, so the survivors count and the row list can never disagree with
 * each other or with the floors — a second SQL copy is exactly the drift
 * work-item-claimability-clarity removes. Projects `wi.*` so any consumer (a rank ORDER BY,
 * a row projection) can reference any base column; the aggregate wrapper ignores the extra
 * columns (a pure `count(*)` is unaffected).
 */
export function issueClaimCandidateSubquery(
  sql: OrgSql,
  args: {
    compiled: SqlFragment;
    assignee: string;
    cooldown: number;
    harness: string;
    states: readonly string[];
    issueWs: string;
    operatorScopeSlug: string;
    rigAvailable?: boolean;
  },
): SqlFragment {
  const { compiled, assignee, cooldown, harness, states, issueWs, operatorScopeSlug, rigAvailable } = args;
  return sql`
    SELECT
      wi.*,
      (${compiled})                                                     AS spec_match,
      (wi.taken_by IS NULL OR wi.taken_by = '')                         AS ok_untaken,
      (${claimHoldExclusionSql(sql)})                                   AS ok_claim_hold,
      (${needsHumanExclusionSql(sql)})                                  AS ok_needs_human,
      (${observationLaneExclusionSql(sql)})                             AS ok_observation,
      (${externalBlockersExclusionSql(sql)})                            AS ok_external_blocker,
      (${reservedPlanLaneExclusionSql(sql, assignee)})                  AS ok_plan_lane,
      (${federationDetectorExclusionSql(sql)})                          AS ok_federation,
      (${loopIterationNoiseExclusionSql(sql)})                          AS ok_loop_noise,
      (${alreadyTerminallyCompletedExclusionSql(sql)})                  AS ok_completed,
      (${crossMachineRigExclusionSql(sql, rigAvailable)})               AS ok_rig,
      -- WI-6409: mirror claimNextIssueWorkItem's own-node-aware origin floor (local OR our
      -- own author key) — previously absent from this shared subquery entirely, so a
      -- true-remote-origin row read as claimable here while the real claim refused it.
      (${isIssueLocallyClaimableWhereSql(sql, issueWs)})                AS ok_origin,
      (NOT EXISTS (
          SELECT 1 FROM harness_shared.work_item_deps d
           WHERE d.workspace_id = 'default'
             AND d.dep_type = 'blocks'
             AND d.blocked_ref = wi.feature_id
             AND (
               EXISTS (
                 SELECT 1 FROM harness_shared.harness_features_consolidated bf
                  WHERE (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                    AND bf.status NOT IN ('passed', 'deprecated', 'done', 'dropped')
               )
               OR EXISTS (
                 SELECT 1 FROM harness_shared.engineer_issues bi
                  WHERE bi.workspace_id = 'default'
                    AND bi.issue_id = d.blocker_ref
                    AND bi.state NOT IN ('resolved', 'closed', 'done', 'dropped')
               )
             )
      ))                                                                AS ok_no_blocker,
      (${
        cooldown > 0
          ? sql`(wi.last_released_by IS NULL
              OR wi.last_released_by <> ${assignee}
              OR wi.last_released_at IS NULL
              OR wi.last_released_at < now() - make_interval(secs => ${cooldown}))`
          : sql`TRUE`
      })                                                                AS ok_cooldown
    FROM harness_shared.work_items wi
    WHERE wi.item_kind IN ('bug', 'change', 'task')
      AND wi.workspace_id = ${issueWs}
      AND (wi.harness_slug = ${harness} OR wi.harness_slug = ${operatorScopeSlug})
      AND wi.status = ANY(${states as string[]}::text[])
  `;
}

export async function aggregateIssueClaimExclusions(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    /** Run on this handle instead of a fresh pool checkout — pass the `tx` from
     *  {@link readIssueClaimability} to share ONE snapshot with the sibling reads. */
    client?: OrgSql;
  },
): Promise<IssueClaimExclusionBreakdown> {
  const sql = opts.client ?? getOrgPg().sql;
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
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_cooldown)::int        AS cooldown,
      count(*) FILTER (WHERE spec_match AND ok_untaken AND NOT ok_origin)::int          AS remote_origin
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
    remote_origin: number;
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
      remoteOrigin: r?.remote_origin ?? 0,
    },
  };
}

/** Bounded per-floor SAMPLE of excluded row ids — the companion read to
 *  {@link aggregateIssueClaimExclusions}'s counts. Each array is capped at the caller's
 *  `sampleLimit`; buckets OVERLAP exactly like the counts (a row can appear in more than
 *  one floor's sample). `taken` samples rows failing `ok_untaken` alone (mirrors how the
 *  counts treat it); every other bucket samples the UNTAKEN subset, same as the counts. */
export interface IssueClaimExclusionSample {
  taken: string[];
  claimHold: string[];
  needsHuman: string[];
  observationLane: string[];
  externalBlocker: string[];
  planLaneReserved: string[];
  federationDetector: string[];
  loopNoise: string[];
  alreadyCompleted: string[];
  crossMachineRig: string[];
  blockedDep: string[];
  cooldown: string[];
  /** WI-6409: sampled ids of true-remote-origin rows — see {@link IssueClaimExclusionBreakdown.excluded}'s remoteOrigin. */
  remoteOrigin: string[];
}

/**
 * Bounded per-floor sample of excluded row IDS — answers "which items, not just how many"
 * without a hand-rolled raw-SQL query against `harness_shared.work_items` (a query that
 * silently returns 0 rows if it filters the table's legacy free-text `kind` column —
 * feature sub-category, e.g. infra/security — instead of the real family discriminator
 * `item_kind`; EI-18682848605075155). Wraps the SAME {@link issueClaimCandidateSubquery} +
 * floor predicates {@link aggregateIssueClaimExclusions} counts, materialized ONCE via a
 * `WITH` CTE and sampled per floor, so a sampled id applies the identical bar to what the
 * counts call excluded, and adding/removing a floor there automatically applies here too.
 * READ-ONLY, no claim side-effect — this is purely a diagnostic companion to the counts.
 *
 * ⚠ That agreement is PER SNAPSHOT (WI-5947). Called on its own this is a SEPARATE
 * round-trip from the counts, so under concurrent claims a sampled id CAN disagree with the
 * counts it is shown beside. To present the two together, read both through
 * {@link readIssueClaimability} — one REPEATABLE READ transaction over all of them.
 */
export async function sampleIssueClaimExclusions(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    /** Run on this handle instead of a fresh pool checkout — pass the `tx` from
     *  {@link readIssueClaimability} to share ONE snapshot with the sibling reads. */
    client?: OrgSql;
  },
  sampleLimit: number,
): Promise<IssueClaimExclusionSample> {
  const sql = opts.client ?? getOrgPg().sql;
  const states = [...(opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
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

  // Each floor's sample is its own bounded scalar subquery over the materialized `sub`
  // CTE — cheap (an index-friendly LIMIT-capped scan of an already-computed row set), and
  // structurally tied to the SAME ok_* booleans the counts filter on, never a re-derived
  // predicate that could drift from them.
  const sampleOf = (predicateSql: string, extraGuard = 'ok_untaken AND ') => sql`
    (SELECT COALESCE(array_agg(feature_id), ARRAY[]::text[]) FROM (
       SELECT feature_id FROM sub
        WHERE spec_match AND ${sql.unsafe(extraGuard)}${sql.unsafe(predicateSql)}
        ORDER BY updated_ts DESC NULLS LAST
        LIMIT ${sampleLimit}
     ) t)
  `;

  const rows = (await sql`
    WITH sub AS (${sub})
    SELECT
      ${sampleOf('NOT ok_untaken', '')}        AS taken,
      ${sampleOf('NOT ok_claim_hold')}          AS claim_hold,
      ${sampleOf('NOT ok_needs_human')}         AS needs_human,
      ${sampleOf('NOT ok_observation')}         AS observation_lane,
      ${sampleOf('NOT ok_external_blocker')}    AS external_blocker,
      ${sampleOf('NOT ok_plan_lane')}           AS plan_lane_reserved,
      ${sampleOf('NOT ok_federation')}          AS federation_detector,
      ${sampleOf('NOT ok_loop_noise')}          AS loop_noise,
      ${sampleOf('NOT ok_completed')}           AS already_completed,
      ${sampleOf('NOT ok_rig')}                 AS cross_machine_rig,
      ${sampleOf('NOT ok_no_blocker')}          AS blocked_dep,
      ${sampleOf('NOT ok_cooldown')}            AS cooldown,
      ${sampleOf('NOT ok_origin')}              AS remote_origin
  `) as Array<{
    taken: string[];
    claim_hold: string[];
    needs_human: string[];
    observation_lane: string[];
    external_blocker: string[];
    plan_lane_reserved: string[];
    federation_detector: string[];
    loop_noise: string[];
    already_completed: string[];
    cross_machine_rig: string[];
    blocked_dep: string[];
    cooldown: string[];
    remote_origin: string[];
  }>;
  const r = rows[0];
  return {
    taken: r?.taken ?? [],
    claimHold: r?.claim_hold ?? [],
    needsHuman: r?.needs_human ?? [],
    observationLane: r?.observation_lane ?? [],
    externalBlocker: r?.external_blocker ?? [],
    planLaneReserved: r?.plan_lane_reserved ?? [],
    federationDetector: r?.federation_detector ?? [],
    loopNoise: r?.loop_noise ?? [],
    alreadyCompleted: r?.already_completed ?? [],
    crossMachineRig: r?.cross_machine_rig ?? [],
    blockedDep: r?.blocked_dep ?? [],
    cooldown: r?.cooldown ?? [],
    remoteOrigin: r?.remote_origin ?? [],
  };
}

/** One claimable issue-family row surfaced by {@link listIssueClaimableRows} — a lean,
 *  self-selection-oriented projection (id/kind/title/status/severity/plan + the ordering
 *  keys). Full body via `work_items:get { id }`. */
export interface IssueClaimableRow {
  /** The work-item id (feature_id — WI-/EI-…). */
  id: string;
  /** item_kind (bug | change | task), COALESCEd over the legacy free-text `kind`. */
  kind: string;
  title: string | null;
  status: string;
  /** payload.severity for bugs (null when the row carries none). */
  severity: string | null;
  /** source_plan_slug — the plan this item belongs to, if any. */
  plan: string | null;
  /** feature_order (the prioritization key; null = unprioritized, sorts last). */
  featureOrder: number | null;
  /** created_ts (epoch ms). */
  createdTs: number | null;
}

/**
 * The companion row-lister to {@link aggregateIssueClaimExclusions}: the actual issue-family
 * rows that survive `spec_match` AND every claim floor — i.e. what a self-selecting caller
 * under this spec would see as claimable RIGHT NOW, ordered the way `get_next` would hand
 * them out (via {@link compileRank} over the same spec). Wraps the SAME
 * {@link issueClaimCandidateSubquery} + the SAME {@link ALL_ISSUE_CLAIM_FLOORS_PASS} bar the
 * survivors COUNT uses, so within ONE snapshot `rows.length` (uncapped) === the oracle's
 * `claimable` count — the list and the count cannot drift from each other or from the floors.
 * Read-only; NO claim side-effect (this is the diagnostic read `work_items:claimable`
 * exposes, never a claim path).
 *
 * ⚠ "Within one snapshot" is load-bearing (WI-5947). Issued as its OWN round-trip this
 * observes a LATER snapshot than a separately-issued count, and under fleet churn the two
 * genuinely disagree (observed live: `claimableCount:1, returned:0` under a limit of 50).
 * Any caller reporting the count and the list together must go through
 * {@link readIssueClaimability}.
 */
export async function listIssueClaimableRows(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    /** The validated claim spec whose rank orders the survivors (defaults to
     *  DEFAULT_CLAIM_SPEC's fixed feature_order→created ordering). Reusing compileRank
     *  makes the listing order match what get_next under this spec would actually claim. */
    spec?: ClaimSpec;
    /** Run on this handle instead of a fresh pool checkout — pass the `tx` from
     *  {@link readIssueClaimability} to share ONE snapshot with the sibling reads. */
    client?: OrgSql;
  },
  limit: number,
): Promise<IssueClaimableRow[]> {
  const sql = opts.client ?? getOrgPg().sql;
  const states = [...(opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
  const issueWs = issuesScopeWorkspace();
  const operatorScopeSlug = `operator:${issueWs}`;
  const assignee = opts.assignee ?? '';
  const compiled = compileFilter(sql, filter);
  const cooldown = releaseCooldownSec();
  const cap = Math.max(1, Math.min(Math.floor(limit) || 1, 200));
  // Reuse the resolver's OWN rank compiler so the diagnostic order == the claim order.
  // Empty heldPaths ⇒ the `affinity` term is NEUTRAL (dropped), leaving the spec's
  // deterministic feature_order→created ordering — exactly get_next's for a fresh bee.
  const order = compileRank(sql, opts.spec ?? DEFAULT_CLAIM_SPEC, { assignee });
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
      feature_id                AS id,
      COALESCE(item_kind, kind) AS kind,
      title,
      status,
      -- WI-6673: severity on harness_shared.work_items lives at payload._ei.severity
      -- (migration 374 fold), NOT top level. The old top-level accessor matched
      -- 1 of 13,731 open issue-family rows -- so EVERY claimable row came back
      -- severity:null, including genuine criticals, and a leader reading this tool
      -- concluded severity was simply not tracked on claimable work. _ei first, with
      -- the legacy top-level as fallback for stragglers that predate the fold.
      COALESCE(payload->'_ei'->>'severity', payload->>'severity') AS severity,
      source_plan_slug          AS plan,
      feature_order,
      created_ts
    FROM (${sub}) sub
    WHERE spec_match AND ${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)}
    ORDER BY ${order}
    LIMIT ${cap}
  `) as Array<{
    id: string;
    kind: string;
    title: string | null;
    status: string;
    severity: string | null;
    plan: string | null;
    feature_order: number | string | null;
    created_ts: number | string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    severity: r.severity,
    plan: r.plan,
    featureOrder: r.feature_order == null ? null : Number(r.feature_order),
    createdTs: r.created_ts == null ? null : Number(r.created_ts),
  }));
}

/**
 * What the ADMITTED set is MADE OF — the composition of the rows that passed, as opposed
 * to {@link IssueClaimExclusionBreakdown} which describes only what was REJECTED.
 *
 * WHY (WI-6673): a claimable COUNT with no composition is the single most misleading
 * number this system produces, because it looks like a measurement rather than an
 * interpretation and therefore resists suspicion. On 2026-08-01 a fleet was launched at a
 * lane reporting 1,252 claimable; 98.7% of it was nit-severity auto-filed OBSERVATIONS,
 * and the true bug backlog was ~285. Every count quoted along the way was arithmetically
 * correct and none of them answered "is this work?". The owner caught it by instinct after
 * three different correct numbers had been reported.
 *
 * This MUST be computed server-side. The obvious caller-side workaround — read the rows
 * and group them yourself — was impossible: the row projection handed back `severity:null`
 * for every row (the sibling half of WI-6673, fixed in the same change), so no amount of
 * caller diligence could characterize the pool.
 */
export interface IssueClaimAdmittedComposition {
  /**
   * Size of the ADMITTED population — the one `lowSeverityShare` is a share OF. Explicit
   * because a consumer that pairs the share with some other count it happens to have (e.g.
   * a spec's pre-floor `matched`) reports a percentage of one population against the size
   * of a larger one. That is precisely the "arithmetically correct, actually wrong" number
   * this whole structure exists to prevent, so the denominator travels WITH the share.
   */
  total: number;
  /** Admitted rows per issue kind (bug/change/task). */
  byKind: Record<string, number>;
  /** Admitted rows per severity; `unset` collects rows carrying none. */
  bySeverity: Record<string, number>;
  /** Fraction of the admitted set that is nit/minor severity, 0..1 (null when empty). */
  lowSeverityShare: number | null;
  /**
   * True when the admitted pool is BOTH large and compositionally degenerate — the
   * "this lane is an observation firehose, not a backlog" shape. Consumers surface this
   * instead of making every caller re-derive the same judgement from the raw buckets.
   */
  degenerate: boolean;
  /** Admitted rows created in the busiest single day, and that day — a burst-filing tell. */
  peakDay: { day: string; count: number } | null;
}

export const DEGENERATE_LOW_SEVERITY_SHARE = 0.8;
export const DEGENERATE_MIN_POOL = 50;

/** One GROUP BY (kind, severity, day) tallied row — the shape {@link summarizeAdmittedRows} folds. */
export interface AdmittedCompositionRow {
  kind: string;
  severity: string;
  day: string | null;
  n: number;
}

/**
 * The PURE fold behind {@link aggregateAdmittedComposition} — grouped tallies in, composition
 * verdict out. Extracted (WI-6673) so the two thresholds that decide `degenerate` are
 * guardable without a database: the SQL above is a plain GROUP BY, but the JUDGEMENT it feeds
 * is the part that silently rots, and a DB-backed test cannot pin a threshold cheaply enough
 * to run on every edit. Keep it total and side-effect free.
 */
export function summarizeAdmittedRows(rows: readonly AdmittedCompositionRow[]): IssueClaimAdmittedComposition {
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  let total = 0;
  let low = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + r.n;
    if (r.day) byDay[r.day] = (byDay[r.day] ?? 0) + r.n;
    if (r.severity === 'nit' || r.severity === 'minor') low += r.n;
    total += r.n;
  }
  const lowSeverityShare = total > 0 ? low / total : null;
  // Deterministic peak: ties break on the EARLIER day, so the verdict does not flap between
  // reads just because Object.entries ordering shifted.
  const peak = Object.entries(byDay).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return {
    total,
    byKind,
    bySeverity,
    lowSeverityShare,
    degenerate:
      total >= DEGENERATE_MIN_POOL && lowSeverityShare !== null && lowSeverityShare >= DEGENERATE_LOW_SEVERITY_SHARE,
    peakDay: peak ? { day: peak[0], count: peak[1] } : null,
  };
}

/**
 * Composition of the ADMITTED set, in the caller's snapshot. Same subquery + same floor
 * predicate as {@link listIssueClaimableRows}, so it describes exactly the population the
 * count reports and the queue serves — it cannot drift from either.
 */
export async function aggregateAdmittedComposition(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    client?: OrgSql;
  },
): Promise<IssueClaimAdmittedComposition> {
  const sql = opts.client ?? getOrgPg().sql;
  const states = [...(opts.states ?? ISSUE_FAMILY_CLAIMABLE_STATES)];
  const issueWs = issuesScopeWorkspace();
  const operatorScopeSlug = `operator:${issueWs}`;
  const sub = issueClaimCandidateSubquery(sql, {
    compiled: compileFilter(sql, filter),
    assignee: opts.assignee ?? '',
    cooldown: releaseCooldownSec(),
    harness: opts.harness,
    states,
    issueWs,
    operatorScopeSlug,
    rigAvailable: opts.rigAvailable,
  });

  const rows = (await sql`
    SELECT
      COALESCE(item_kind, kind)                                              AS kind,
      COALESCE(payload->'_ei'->>'severity', payload->>'severity', 'unset')   AS severity,
      to_char(to_timestamp(created_ts / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
      count(*)::int                                                          AS n
    FROM (${sub}) sub
    WHERE spec_match AND ${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)}
    GROUP BY 1, 2, 3
  `) as AdmittedCompositionRow[];

  return summarizeAdmittedRows(rows);
}

/** The whole claimability reading — counts, survivor rows, and (optionally) the per-floor
 *  excluded sample — as observed at ONE instant. Returned by {@link readIssueClaimability}. */
export interface IssueClaimabilityReading {
  breakdown: IssueClaimExclusionBreakdown;
  /** Survivors, capped at the caller's `limit`. Empty when `breakdownOnly`. */
  rows: IssueClaimableRow[];
  /** Only when `sampleLimit` was passed. */
  sample?: IssueClaimExclusionSample;
  /** What the admitted set is MADE OF (WI-6673) — always present, same snapshot. */
  admitted: IssueClaimAdmittedComposition;
}

/**
 * Read the FULL claimability picture — {@link aggregateIssueClaimExclusions}'s counts,
 * {@link listIssueClaimableRows}' survivor rows, and optionally
 * {@link sampleIssueClaimExclusions}' per-floor id sample — inside ONE read-only
 * REPEATABLE READ transaction, so all three observe the SAME snapshot.
 *
 * WHY (WI-5947): sharing the inner subquery + the floor predicate makes the three reads
 * SEMANTICALLY identical; it does NOT make them ATOMIC, which is the property their
 * docstrings were actually asserting. Issued as three separate round-trips against a
 * concurrently-mutating table, a peer's claim landing BETWEEN them is counted by one and
 * absent from the next — observed live on 2026-07-26 as `claimableCount:1, returned:0`
 * under a limit of 50 (a limit of 50 cannot truncate one row). That impossible-looking pair
 * is then read as a defect in the claim path: `scheduler:get_next` reported a
 * "CLAIM-PATH/READ-PATH DIVERGENCE" and instructed the agent to file a claim-path bug that
 * did not exist. One snapshot removes the race at the source, and makes the "cannot
 * diverge" guarantee TRUE rather than aspirational.
 *
 * REPEATABLE READ (not SERIALIZABLE): these are pure reads, so a stable snapshot is the
 * entire requirement — and a read-only REPEATABLE READ transaction cannot raise a
 * serialization failure, so this adds a consistency guarantee without adding a retry path.
 * A stalled read surfaces as a bounded statement_timeout error rather than hanging: the
 * admin pool deliberately carries NO statement_timeout (migrations run on it).
 *
 * The reading is ALL-OR-NOTHING BY DESIGN: if the transaction fails, this throws. It never
 * degrades to unsynchronized reads or to a synthesised zero — "could not measure" must stay
 * distinguishable from "measured none", because the caller's whole purpose is deciding
 * whether a lane is drained, and a fabricated 0 is indistinguishable from a real drain.
 */
export async function readIssueClaimability(
  filter: FilterNode | undefined,
  opts: {
    harness: string;
    states?: readonly string[];
    assignee?: string;
    rigAvailable?: boolean;
    spec?: ClaimSpec;
    /** Inject the sql client (tests / a non-default backend). Default getOrgPg().sql. */
    client?: OrgSql;
  },
  readOpts: {
    /** Max survivor rows to return. Ignored when `breakdownOnly`. */
    limit: number;
    /** Skip the row list entirely (counts only). */
    breakdownOnly?: boolean;
    /** When set, also sample up to this many excluded ids PER FLOOR. */
    sampleLimit?: number;
    /** Per-statement cap for the snapshot txn, ms (default 15000). */
    statementTimeoutMs?: number;
  },
): Promise<IssueClaimabilityReading> {
  const sql = opts.client ?? getOrgPg().sql;
  const stmtMs = Math.max(100, Math.trunc(readOpts.statementTimeoutMs ?? 15_000));
  const shared = {
    harness: opts.harness,
    states: opts.states,
    assignee: opts.assignee,
    rigAvailable: opts.rigAvailable,
  };

  return (await sql.begin(async (tx) => {
    // Both must precede the first DATA statement of the transaction: PG rejects
    // SET TRANSACTION once a query has run, which would silently leave the reads on
    // READ COMMITTED — i.e. exactly the unsynchronized behaviour this removes.
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await tx.unsafe(`SET LOCAL statement_timeout = ${stmtMs}`);
    const client = tx as unknown as OrgSql;

    const breakdown = await aggregateIssueClaimExclusions(filter, { ...shared, client });
    const rows = readOpts.breakdownOnly
      ? []
      : await listIssueClaimableRows(filter, { ...shared, spec: opts.spec, client }, readOpts.limit);
    const sample = readOpts.sampleLimit
      ? await sampleIssueClaimExclusions(filter, { ...shared, client }, readOpts.sampleLimit)
      : undefined;
    // WI-6673: composition of the ADMITTED set, in the SAME snapshot as the count it
    // describes. Unconditional — it is not an opt-in extra, because the whole failure
    // mode is a caller quoting the count WITHOUT having thought to ask for composition.
    //
    // COST NOTE (measured 2026-08-01): this is a FOURTH serial aggregation in this
    // transaction, and postgres.js serialises on the single tx connection, so it adds
    // roughly one more floor-stack pass per call. That is deliberate for `work_items:
    // claimable`, which EXISTS to be quoted. It is pure waste for
    // harness/routines/unguarded-halt-rescue-action.ts, which destructures only
    // `{ breakdown }` and cannot quote a count to anyone — worth folding the composition
    // into aggregateIssueClaimExclusions' single pass (same snapshot, one query) rather
    // than making it opt-in, since an opt-out flag would just recreate the original bug.
    // NOT urgent: `scheduler:get_next` does NOT route through this function, so the
    // fleet's hot claim path is unaffected by this cost.
    const admitted = await aggregateAdmittedComposition(filter, { ...shared, client });

    return { breakdown, rows, admitted, ...(sample ? { sample } : {}) };
  })) as IssueClaimabilityReading;
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
): { value: SqlFragment; inverted: boolean; numeric: boolean } | null {
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
      // A count() — numerically summable, so it may contribute to a weighted rank.
      numeric: true,
    };
  }

  // Ordinal severity term (EI-19286355119013384) — the supported way to order by severity,
  // and the reason the bare `severity` field stays out of RANKABLE_ITEM_FIELDS. Severity is
  // TEXT, so a bare `severity desc` sorts LEXICALLY (nit > minor > major > critical, exactly
  // backwards); this CASE gives it a real ordinal so `severity_rank desc` means what it reads
  // as. Uses the SAME accessor precedence as the `severity` filter above (payload._ei first,
  // then top-level) — the two MUST agree or a spec would rank on one source and filter on
  // another. An absent/unrecognized severity sorts LAST (0) rather than NULL, so it can never
  // outrank a real one; on the feature-family relation, where severity is structurally
  // absent, every row scores 0 — a clean no-op, never an error.
  if (head === 'severity_rank') {
    return {
      value: sql`CASE COALESCE(payload->'_ei'->>'severity', payload->>'severity')
        WHEN 'critical' THEN 4
        WHEN 'major' THEN 3
        WHEN 'minor' THEN 2
        WHEN 'nit' THEN 1
        ELSE 0
      END`,
      inverted: false,
      // A CASE over integer literals — casts cleanly to ::numeric, so unlike the bare
      // `severity` field this is safe to sum in a weighted rank.
      numeric: true,
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
  // `numeric` gates weighted-mode participation ONLY: a weighted rank casts each term to
  // ::numeric, which on a text/array/jsonb column is a hard PG error that aborts the claim
  // query (measured: text[] ⇒ "cannot cast type text[] to numeric"; item_kind ⇒ "invalid
  // input syntax for type numeric: \"feature\""). The validator now rejects that spec shape
  // up front (claim-spec.ts NUMERIC_ITEM_FIELDS); this flag is the defense-in-depth leg, so
  // a spec stored BEFORE that rule degrades to a neutral term instead of wedging the lane.
  // Lexicographic ordering is unaffected — ORDER BY on a text column is well-defined there.
  return { value: fm.col(sql), inverted: fm.inverted ?? false, numeric: fm.kind === 'scalar-num' };
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
    // Σ wᵢ·termᵢ — only terms that compile to a numeric value contribute, which this
    // now ENFORCES rather than merely asserting: a non-numeric term is dropped here
    // instead of reaching the `::numeric` cast below, where it would be a hard PG error
    // that aborts the entire claim query (see compileRankExpr's `numeric`). An inverted
    // field is negated (so "more important" is a LARGER contribution). Sort DESC of the
    // weighted sum = best-first; then the deterministic tiebreaker.
    const contribs = terms
      .map((t) => {
        const compiled = compileRankExpr(sql, t.expr, bee);
        if (!compiled || !compiled.numeric) return null;
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

  const floorOpts = {
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
  };

  // EI-18805386252364731: the claim query runs on the `harness_admin` pool, which carries a
  // role-default lock_timeout but DELIBERATELY NO statement_timeout (migrations share it and
  // must run unbounded). An over-cost claim spec therefore did not fail — it HUNG, until the
  // MCP client transport gave up minutes later, and a JS-side AbortController cannot rescue it
  // because postgres-js does not cancel an in-flight query. The member then reads a pull that
  // never returned as "the lane is drained" and parks, while the lane is in fact full.
  //
  // So every attempt runs inside a BOUNDED txn, and the whole ladder shares ONE budget: a spec
  // too expensive to decide now surfaces as a typed OrgTxnTimeoutError the tool reports, never
  // as a drain-shaped `null`. Bounding each attempt alone would not be enough — the ladder runs
  // this query up to three tiers plus a release-and-retry loop, so N individually-affordable
  // attempts can still sum past any caller's patience.
  const ladderBudgetMs = opts.claimBudgetMs ?? CLAIM_LADDER_BUDGET_MS;
  const ladderDeadline = Date.now() + ladderBudgetMs;

  /** One attempt at the compiled query under a given (possibly widened) filter node. */
  const attempt = async (filterNode: FilterNode | undefined): Promise<WorkItem | null> => {
    const remainingMs = ladderDeadline - Date.now();
    if (remainingMs <= 0) {
      // The budget is gone. Report it as the same typed contention error a per-statement
      // timeout raises — the caller must never mistake this for "nothing matched".
      throw new OrgTxnTimeoutError('57014', new Error('claim ladder budget exhausted'));
    }
    const rows = await boundedOrgTxn(
      async (tx) => {
        // Compile against the TRANSACTION client so the fragments belong to the connection
        // that carries the SET LOCAL statement_timeout.
        const floors = claimFloorsWhereSql(tx, floorOpts);
        const order = compileRank(tx, spec, bee);
        const filter = compileFilter(tx, filterNode);
        return tx<FeatureRowDb[]>`
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
      RETURNING ${tx.unsafe(FEATURE_COLS)}`;
      },
      { client: sql, statementTimeoutMs: Math.min(remainingMs, ladderBudgetMs, CLAIM_ATTEMPT_BUDGET_MS) },
    );
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
    // Compile the FULL filter tree (correct `any`/`not` semantics, paths/plan/title/tags —
    // everything the id/kind extraction above structurally cannot express) and hand it to
    // the claim query, so tier 3 atomically claims a SPEC-MATCHING row on the first attempt
    // instead of claiming a violator and depending on claim-spec-store.ts's post-claim
    // release-and-retry to bounce it. That retry shares MAX_PLAN_LANE_ATTEMPTS (5) with the
    // plan-lane-blocked path; for a narrow lane (measured: 26 spec-matching of 1073
    // lane-wide claimable on p2p-release-lane@9 = 2.4%) five draws almost never land a
    // match, so get_next reported a FALSE drain on ~88% of pulls while
    // work_items:claimable — which already compiles this same filter via
    // issueClaimCandidateSubquery — correctly reported 26 claimable. This is the line that
    // re-unifies the CLAIM path with the READ path. The post-claim re-check remains as
    // defense-in-depth (and still covers topicTags, which is not a SQL-side field).
    //
    // EI-18665895916759270: compile the filter with the FEATURE-ONLY `kind` leaves stripped
    // (stripFeatureOnlyKindLeaves — see its doc comment). This query runs over
    // `harness_shared.work_items`, where every row is bug/change/task, so a surviving
    // `kind = 'feature'` leaf would compile to an unsatisfiable predicate and zero out the
    // ONLY tier that serves issue-family work — silently re-breaking WI-1407's "feature
    // family dry ⇒ fall through to an adjacent open issue" contract. Widening past exactly
    // that leaf is what tier 3 IS; every other narrowing (including an issue-kind lane
    // constraint) still compiles through.
    // EI-18805386252364731: do not ENTER tier 3 with the ladder budget already spent — tiers 1/2
    // may have consumed it. This bounds tier-3 ENTRY only: `claimNextIssueWorkItem` still runs
    // its own queries on the raw unbounded `harness_admin` pool, so a stall INSIDE it is not yet
    // rescued (JS cannot cancel an in-flight postgres-js query). Tracked separately — see the
    // residual noted on this item; do not read this line as the issue-family path being bounded.
    if (Date.now() >= ladderDeadline) {
      throw new OrgTxnTimeoutError('57014', new Error('claim ladder budget exhausted before tier 3'));
    }
    const specFilterSql = compileFilter(sql, stripFeatureOnlyKindLeaves(spec.view.filter));
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
      {
        issueKinds,
        ids: idValues,
        excludeIds: excludeIds.length ? excludeIds : undefined,
        specFilterSql,
      },
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
