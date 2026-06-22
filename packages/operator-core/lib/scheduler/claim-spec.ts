/**
 * Per-bee claim SPEC — the versioned, blueprint-style scheduling artifact the
 * Queen hands each bee (`hybrid-bee-scheduler-work-stealing-2026-06-22`,
 * Phases 1–2).
 *
 * A claim spec is a declarative, validated JSON artifact = a scoped **VIEW**
 * (filter) + an **ORDERING** (rank) over the live work-item DAG. A bee calls
 * `get_next`; the resolver compiles `(global hard floors AND spec.view.filter)`,
 * orders the survivors by `spec.rank`, and leases the top item (D-002, D-003).
 *
 * This module is ONLY the spec schema + the `validateClaimSpec` validator. The
 * `get_next` resolver is deliberately NOT here — it depends on the maintained
 * `ready` column owned by `work-item-deps-and-readiness-2026-06-22` (D-010).
 *
 * Design invariants this schema encodes:
 *  - **View, not copy** (D-003): the filter is a query over the live DAG, never
 *    a frozen subgraph. The schema describes the query; evaluation is the
 *    resolver's job.
 *  - **Versioned, not immutable** (D-003/D-006): `revision` bumps on every Queen
 *    re-steer; `get_next` records `specId@revision` per claim for provenance.
 *  - **Floors are not in the spec** (D-002): a spec can only NARROW + REORDER;
 *    `ready`/`cursed`/lease/dedup/risk-ceiling/admission/file-lock floors are
 *    ANDed in by the resolver and CANNOT appear in `view.filter`. The validator
 *    rejects a `blocked`/`cursed` filter term so a spec can never "un-floor"
 *    itself by re-asserting a floor it doesn't control.
 *
 * The vocabulary (item/bee fields, predicate ops, rank terms) is fixed: the
 * plan's "primitive vocabulary" + "global hard floors" sections. Adding a field
 * or term is a deliberate edit here (and a matching resolver change), so a
 * malformed spec is caught at author time with a clear error.
 */
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// Vocabulary — the fixed primitive set the Queen composes a spec from.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Item fields a `view.filter` predicate or a `rank` term may reference. Grounded
 * in `work_items` columns + derived fields (the plan's "Item fields" list).
 *
 * `blocked` + `cursed` are DERIVED/floor fields — readable conceptually but
 * NOT filterable in a spec (they are global floors the resolver owns); they are
 * excluded from `FILTERABLE_ITEM_FIELDS` below.
 */
export const ITEM_FIELDS = [
  'priority',
  'tags',
  'kind',
  'risk_tier',
  'paths',
  'plan',
  'plan_item',
  'age',
  'blocked',
  'cursed',
  'redundancy',
  'est_cost',
  'assignee',
] as const;
export type ItemField = (typeof ITEM_FIELDS)[number];

/**
 * Bee/context fields — the pulling bee's own state, available to filters and
 * rank terms (the plan's "Bee/context fields" list). Referenced in the spec as
 * `bee.<field>` (e.g. `bee.held_paths` inside an `affinity(...)` term).
 */
export const BEE_FIELDS = ['model', 'held_paths', 'load', 'current_plan'] as const;
export type BeeField = (typeof BEE_FIELDS)[number];

/**
 * Fields a `view.filter` predicate may target. EXCLUDES the floor/derived fields
 * `blocked` + `cursed`: those are global hard floors the resolver ANDs in, never
 * spec-controlled (D-002). A spec that filters on them is rejected — it would be
 * either redundant (re-asserting a floor) or, worse, an attempt to widen past one.
 */
export const FILTERABLE_ITEM_FIELDS = ITEM_FIELDS.filter(
  (f) => f !== 'blocked' && f !== 'cursed',
) as Exclude<ItemField, 'blocked' | 'cursed'>[];

/** Predicate operators usable in a `view.filter` leaf (the plan's "Predicates"). */
export const FILTER_OPS = ['=', '!=', '<', '<=', '>', '>=', 'in', 'contains', 'glob'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * Rank term expressions (the plan's "Rank terms"). Two flavours:
 *  - a bare item field name (`priority`, `age`, `est_cost`, …) — order by that column;
 *  - a function term — `affinity(bee.held_paths,item.paths)`,
 *    `model_fit(bee.model,item)`, `tag_weight(tags)`, `redundancy_need`.
 *
 * Function terms are matched by their *head* (the identifier before `(`), so the
 * Queen may write the documented argument forms verbatim. `redundancy_need` is
 * accepted both bare and called. `model_fit` is in the vocabulary (so specs that
 * reference it validate) even though the resolver leaves it neutral until the
 * per-MODEL capability lane ships behind its own flag (D-010).
 */
export const RANK_FUNCTIONS = ['affinity', 'model_fit', 'tag_weight', 'redundancy_need'] as const;
export type RankFunction = (typeof RANK_FUNCTIONS)[number];

/** Item fields that may be used as a bare rank term (everything sortable). */
export const RANKABLE_ITEM_FIELDS = FILTERABLE_ITEM_FIELDS;

export const CURRENT_SPEC_VERSION = '1.0' as const;
/** Schema versions this validator understands. Bump + branch when the shape changes. */
export const SUPPORTED_SPEC_VERSIONS = ['1.0'] as const;

// ────────────────────────────────────────────────────────────────────────────
// Zod schema — the wire/persisted shape of a claim spec.
// ────────────────────────────────────────────────────────────────────────────

const filterableFieldSchema = z.enum(FILTERABLE_ITEM_FIELDS as [string, ...string[]]);
const filterOpSchema = z.enum(FILTER_OPS);

/** A scalar a predicate compares against: a number, string, boolean, or list thereof. */
const filterScalarSchema = z.union([z.number(), z.string(), z.boolean()]);
const filterValueSchema = z.union([filterScalarSchema, z.array(filterScalarSchema)]);

/**
 * A single comparison leaf: `{ field, op, value }`. The op/value coherence (e.g.
 * `in` wants an array; `<=` wants a number) is checked semantically in
 * `validateClaimSpec` so the error names the field, not a deep Zod union path.
 */
export const filterLeafSchema = z
  .object({
    field: filterableFieldSchema,
    op: filterOpSchema,
    value: filterValueSchema,
  })
  .strict();

export type FilterLeaf = z.infer<typeof filterLeafSchema>;

/**
 * The boolean combinator tree. A node is exactly ONE of: a leaf, `{ all: [...] }`,
 * `{ any: [...] }`, or `{ not: <node> }`. Recursive, so `z.lazy`.
 */
export type FilterNode =
  | FilterLeaf
  | { all: FilterNode[] }
  | { any: FilterNode[] }
  | { not: FilterNode };

export const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    filterLeafSchema,
    z.object({ all: z.array(filterNodeSchema).min(1) }).strict(),
    z.object({ any: z.array(filterNodeSchema).min(1) }).strict(),
    z.object({ not: filterNodeSchema }).strict(),
  ]),
);

export const viewSchema = z
  .object({
    /** The query over the live DAG. Omit to match every item (then rank + floors decide). */
    filter: filterNodeSchema.optional(),
  })
  .strict();

const rankDirSchema = z.enum(['asc', 'desc']);

/**
 * A rank term: an `expr` (a bare item field OR a function term) + a direction.
 * `weight` is required only in `mode: "weighted"` (checked semantically).
 */
export const rankTermSchema = z
  .object({
    expr: z.string().min(1),
    dir: rankDirSchema,
    weight: z.number().finite().optional(),
  })
  .strict();

export type RankTerm = z.infer<typeof rankTermSchema>;

export const rankSchema = z
  .object({
    mode: z.enum(['lexicographic', 'weighted']),
    terms: z.array(rankTermSchema).min(1),
  })
  .strict();

export type Rank = z.infer<typeof rankSchema>;

export const limitsSchema = z
  .object({
    maxConcurrentClaims: z.number().int().positive().optional(),
    claimTtlSec: z.number().int().positive().optional(),
  })
  .strict();

/**
 * The full claim spec. `specVersion` is validated against `SUPPORTED_SPEC_VERSIONS`
 * semantically (so the error is "unsupported spec version 0.9", not a Zod enum dump);
 * the Zod field only checks it is a non-empty string.
 */
export const claimSpecSchema = z
  .object({
    specVersion: z.string().min(1),
    specId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    basedOn: z.string().min(1).optional(),
    boundModel: z.string().min(1).optional(),
    view: viewSchema,
    rank: rankSchema,
    limits: limitsSchema.optional(),
  })
  .strict();

export type ClaimSpec = z.infer<typeof claimSpecSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Validator — returns issues, never throws (mirrors blueprint:validate).
// ────────────────────────────────────────────────────────────────────────────

export interface ClaimSpecValidation {
  /** True only when there are zero errors. Warnings still allow `ok`. */
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** The parsed spec, present when the Zod shape passed (even if semantics added errors). */
  spec?: ClaimSpec;
}

/** Operators whose `value` must be a list. */
const ARRAY_OPS = new Set<FilterOp>(['in']);
/** Operators whose `value` must be a single scalar. */
const SCALAR_OPS = new Set<FilterOp>(['=', '!=', '<', '<=', '>', '>=', 'contains', 'glob']);
/** Operators that require a numeric `value`. */
const NUMERIC_OPS = new Set<FilterOp>(['<', '<=', '>', '>=']);

/**
 * Parse the `expr` head of a rank term: `model_fit(...)` → `model_fit`,
 * `priority` → `priority`. Returns the bare identifier before any `(`.
 */
function rankExprHead(expr: string): string {
  const paren = expr.indexOf('(');
  return (paren === -1 ? expr : expr.slice(0, paren)).trim();
}

function validateFilterNode(node: FilterNode, path: string, errors: string[]): void {
  if ('all' in node) {
    node.all.forEach((child, i) => validateFilterNode(child, `${path}.all[${i}]`, errors));
    return;
  }
  if ('any' in node) {
    node.any.forEach((child, i) => validateFilterNode(child, `${path}.any[${i}]`, errors));
    return;
  }
  if ('not' in node) {
    validateFilterNode(node.not, `${path}.not`, errors);
    return;
  }
  // Leaf. Field membership is already enforced by the Zod enum, but op/value
  // coherence is not — name the concrete problem here.
  const { op, value } = node;
  const isArray = Array.isArray(value);
  if (ARRAY_OPS.has(op) && !isArray) {
    errors.push(`${path}: op "${op}" on field "${node.field}" requires an array value`);
  }
  if (SCALAR_OPS.has(op) && isArray) {
    errors.push(`${path}: op "${op}" on field "${node.field}" requires a single scalar value, got an array`);
  }
  if (NUMERIC_OPS.has(op) && !isArray && typeof value !== 'number') {
    errors.push(`${path}: op "${op}" on field "${node.field}" requires a numeric value`);
  }
}

/**
 * Validate a claim spec, returning `{ ok, errors, warnings, spec }`. Never throws
 * (an authoring agent wants the issues back, not an exception — same contract as
 * `blueprint:validate`). Checks, in order:
 *   1. the Zod shape (unknown keys, wrong types, unknown filter fields/ops);
 *   2. `specVersion` ∈ supported versions;
 *   3. per-leaf op/value coherence;
 *   4. each rank term's `expr` resolves to a known field or rank function, and
 *      `weighted` mode supplies a finite weight on every term.
 */
export function validateClaimSpec(input: unknown): ClaimSpecValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = claimSpecSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.join('.') || '(root)';
      errors.push(`${where}: ${issue.message}`);
    }
    return { ok: false, errors, warnings };
  }
  const spec = parsed.data;

  // (2) Spec version must be one this validator understands.
  if (!(SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(spec.specVersion)) {
    errors.push(
      `specVersion: unsupported spec version "${spec.specVersion}" (supported: ${SUPPORTED_SPEC_VERSIONS.join(', ')})`,
    );
  }

  // (3) Filter op/value coherence.
  if (spec.view.filter) {
    validateFilterNode(spec.view.filter, 'view.filter', errors);
  }

  // (4) Rank term expressions + weighted-mode weights.
  const knownRankHeads = new Set<string>([...RANKABLE_ITEM_FIELDS, ...RANK_FUNCTIONS]);
  spec.rank.terms.forEach((term, i) => {
    const head = rankExprHead(term.expr);
    if (!knownRankHeads.has(head)) {
      errors.push(
        `rank.terms[${i}]: unknown rank term "${term.expr}" — expr head "${head}" is not a known field or rank function ` +
          `(fields: ${RANKABLE_ITEM_FIELDS.join(', ')}; functions: ${RANK_FUNCTIONS.join(', ')})`,
      );
    }
    if (spec.rank.mode === 'weighted' && (term.weight == null || !Number.isFinite(term.weight))) {
      errors.push(`rank.terms[${i}]: mode "weighted" requires a finite "weight" on every term`);
    }
    if (spec.rank.mode === 'lexicographic' && term.weight != null) {
      warnings.push(`rank.terms[${i}]: "weight" is ignored in mode "lexicographic"`);
    }
  });

  return { ok: errors.length === 0, errors, warnings, spec };
}

// ────────────────────────────────────────────────────────────────────────────
// The default spec — "no spec = today's behavior" (D-003).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The DEFAULT claim spec: an empty view (every ready item) ordered by the current
 * fixed `claim_next` ordering — swarm-affinity → priority/feature_order → age
 * (created_ts). Handing a bee no spec is equivalent to handing it this one, so
 * the feature is a strict superset and ships zero behavior change until the Queen
 * authors a narrower spec (D-003).
 *
 * `revision: 0` marks it as the unmodified baseline; `specId` is stable so the
 * provenance record reads `default-fixed-ordering@0` for a baseline pull.
 */
export const DEFAULT_CLAIM_SPEC: ClaimSpec = {
  specVersion: CURRENT_SPEC_VERSION,
  specId: 'default-fixed-ordering',
  revision: 0,
  view: {},
  rank: {
    mode: 'lexicographic',
    terms: [
      { expr: 'affinity(bee.held_paths,item.paths)', dir: 'desc' },
      { expr: 'priority', dir: 'desc' },
      { expr: 'age', dir: 'asc' },
    ],
  },
  limits: { maxConcurrentClaims: 1 },
};
