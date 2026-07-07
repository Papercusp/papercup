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
  // `id` — the work-item id (feature_id). Filterable so a spec can PIN a specific
  // finite set (`id in [...]`), composing with the rest of the grammar. It is a STATIC
  // pin (no auto-inflow / work-stealing — a frozen candidate set), so it is the
  // exception for a fixed wave (hotfix / cutover / re-drive), NOT a standing lane (use a
  // property filter for that). NOT rankable (ordering by id is meaningless) and the
  // observability tripwire `isIdOnlySelector` flags specs that select on id ALONE.
  'id',
  // `title` — the work-item title text. Filterable (WI-3268) so a constrained fleet can
  // durably EXCLUDE a class of work the `tags`/`redundancy` columns don't classify — e.g.
  // `{ not: { field:'title', op:'glob', value:'*p2p*' } }` to stop re-encountering p2p work
  // whose items carry no `tags` at all (the pre-existing tag-based exclusion path is a
  // no-op when tags are unpopulated, which is the common case today). Composes with `not`/
  // `any`/`all` like every other leaf. NOT rankable (ordering by title text is meaningless,
  // same rationale as `id`) — excluded from `RANKABLE_ITEM_FIELDS` below.
  'title',
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

/** Item fields that may be used as a bare rank term (everything sortable). `id` is
 *  filterable (pin a set) but NOT rankable — ordering by id is meaningless, and an
 *  id-pin is about WHICH items, never their order (use priority/age for that). `title`
 *  is the same shape: filterable for keyword exclusion (WI-3268), not a sort key. */
export const RANKABLE_ITEM_FIELDS = FILTERABLE_ITEM_FIELDS.filter(
  (f) => f !== 'id' && f !== 'title',
);

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

/**
 * `viewSchema` carries the filter as an UNVALIDATED record. The strict
 * `filterNodeSchema` above is a deeply-nested union, and Zod collapses any leaf
 * failure (an unknown `field`, a bad `op`) into a single useless
 * `"view.filter: Invalid input"` at the union root — it can't tell you *which*
 * leaf or *why*. Since the whole point of the validator is a CLEAR error, the
 * filter tree is instead walked semantically by `validateFilterNode`, which
 * names the offending field/op/combinator at its exact path. The exported
 * `filterNodeSchema` / `FilterNode` type stay available for consumers that want
 * a strict structural Zod parse (e.g. the resolver compiling the query).
 */
export const viewSchema = z
  .object({
    filter: z.record(z.string(), z.unknown()).optional(),
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

/**
 * The full claim spec type. The Zod schema keeps `view.filter` permissive (an
 * unvalidated record — see `viewSchema`) so leaf errors stay clear, but consumers
 * (notably the `get_next` resolver) want the structured tree, so the exported
 * type narrows `view.filter` to the typed `FilterNode` — the semantic walk in
 * `validateClaimSpec` guarantees that shape at runtime once `ok === true`.
 */
export type ClaimSpec = Omit<z.infer<typeof claimSpecSchema>, 'view'> & {
  view: { filter?: FilterNode };
};

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
const ARRAY_OPS = new Set<string>(['in']);
/** Operators whose `value` must be a single scalar. */
const SCALAR_OPS = new Set<string>(['=', '!=', '<', '<=', '>', '>=', 'contains', 'glob']);
/** Operators that require a numeric `value`. */
const NUMERIC_OPS = new Set<string>(['<', '<=', '>', '>=']);

const FILTERABLE_FIELD_SET = new Set<string>(FILTERABLE_ITEM_FIELDS);
const FILTER_OP_SET = new Set<string>(FILTER_OPS);
/** Floor/derived fields that are never spec-controlled — named so the error explains WHY. */
const FLOOR_FIELDS = new Set<string>(['blocked', 'cursed']);

/**
 * Parse the `expr` head of a rank term: `model_fit(...)` → `model_fit`,
 * `priority` → `priority`. Returns the bare identifier before any `(`.
 */
function rankExprHead(expr: string): string {
  const paren = expr.indexOf('(');
  return (paren === -1 ? expr : expr.slice(0, paren)).trim();
}

const FILTER_SCALAR_TYPES = new Set(['number', 'string', 'boolean']);
function isFilterScalar(v: unknown): boolean {
  return FILTER_SCALAR_TYPES.has(typeof v);
}

/**
 * Walk the filter combinator tree, pushing a CLEAR, path-named error for each
 * problem (the reason this is hand-walked rather than left to a Zod union — see
 * `viewSchema`). A node is exactly one of: a `{field,op,value}` leaf, `{all:[…]}`,
 * `{any:[…]}`, or `{not:…}`. Anything else (multiple keys, unknown key, non-object)
 * is reported at its path. `node` is `unknown` because `viewSchema` keeps the
 * filter unvalidated.
 */
function validateFilterNode(node: unknown, path: string, errors: string[]): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${path}: filter node must be an object (a leaf, or all/any/not), got ${Array.isArray(node) ? 'array' : typeof node}`);
    return;
  }
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Combinators — each takes exactly its own key.
  if ('all' in obj || 'any' in obj || 'not' in obj) {
    const combinator = ('all' in obj ? 'all' : 'any' in obj ? 'any' : 'not') as 'all' | 'any' | 'not';
    if (keys.length !== 1) {
      errors.push(`${path}: combinator "${combinator}" must be the only key, found {${keys.join(', ')}}`);
      return;
    }
    if (combinator === 'not') {
      validateFilterNode(obj.not, `${path}.not`, errors);
      return;
    }
    const children = obj[combinator];
    if (!Array.isArray(children) || children.length === 0) {
      errors.push(`${path}.${combinator}: must be a non-empty array of filter nodes`);
      return;
    }
    children.forEach((child, i) => validateFilterNode(child, `${path}.${combinator}[${i}]`, errors));
    return;
  }

  // Otherwise it must be a leaf: {field, op, value}.
  const extraKeys = keys.filter((k) => k !== 'field' && k !== 'op' && k !== 'value');
  if (extraKeys.length > 0) {
    errors.push(`${path}: unknown filter key(s) {${extraKeys.join(', ')}} — a leaf is {field, op, value}`);
  }
  const { field, op, value } = obj as { field?: unknown; op?: unknown; value?: unknown };

  if (typeof field !== 'string') {
    errors.push(`${path}: leaf "field" is required and must be a string`);
  } else if (FLOOR_FIELDS.has(field)) {
    errors.push(
      `${path}: field "${field}" is a global hard floor, not spec-controlled — a spec can only narrow+reorder, never re-assert a floor`,
    );
  } else if (!FILTERABLE_FIELD_SET.has(field)) {
    errors.push(`${path}: unknown filter field "${field}" (allowed: ${FILTERABLE_ITEM_FIELDS.join(', ')})`);
  }

  if (typeof op !== 'string' || !FILTER_OP_SET.has(op)) {
    errors.push(`${path}: unknown filter op ${JSON.stringify(op)} (allowed: ${FILTER_OPS.join(', ')})`);
    return; // op-dependent value checks below are meaningless without a known op
  }

  // value coherence — only meaningful once field+op are sane.
  const isArray = Array.isArray(value);
  if (isArray) {
    if (!(value as unknown[]).every(isFilterScalar)) {
      errors.push(`${path}: every element of an array value must be a number, string, or boolean`);
    }
  } else if (!isFilterScalar(value)) {
    errors.push(`${path}: value must be a number, string, boolean, or array thereof`);
  }
  if (ARRAY_OPS.has(op) && !isArray) {
    errors.push(`${path}: op "${op}" on field "${String(field)}" requires an array value`);
  }
  if (SCALAR_OPS.has(op) && isArray) {
    errors.push(`${path}: op "${op}" on field "${String(field)}" requires a single scalar value, got an array`);
  }
  if (NUMERIC_OPS.has(op) && !isArray && typeof value !== 'number') {
    errors.push(`${path}: op "${op}" on field "${String(field)}" requires a numeric value`);
  }
}

/**
 * Validate a claim spec, returning `{ ok, errors, warnings, spec }`. Never throws
 * (an authoring agent wants the issues back, not an exception — same contract as
 * `blueprint:validate`). Checks, in order:
 *   1. the Zod shape (unknown top-level keys, wrong types, bad rank mode/limits);
 *   2. `specVersion` ∈ supported versions;
 *   3. the filter tree — combinator structure, known/non-floor field, known op,
 *      op/value coherence — each problem named at its exact path;
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

  // The semantic walk above guarantees `view.filter` (when present) is a valid
  // `FilterNode` once there are no errors; surface the narrowed `ClaimSpec` type.
  return { ok: errors.length === 0, errors, warnings, spec: spec as ClaimSpec };
}

// ────────────────────────────────────────────────────────────────────────────
// Observability tripwire — id-only specs (a static pin, not a lane).
// ────────────────────────────────────────────────────────────────────────────

/** Collect every item-field referenced anywhere in a filter node tree. Defensive
 *  over the raw record shape so it works on a validated OR an as-stored filter. */
function collectFilterFields(node: unknown, acc: Set<string>): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.field === 'string') { acc.add(obj.field); return; }
  if (Array.isArray(obj.all)) { obj.all.forEach((n) => collectFilterFields(n, acc)); return; }
  if (Array.isArray(obj.any)) { obj.any.forEach((n) => collectFilterFields(n, acc)); return; }
  if ('not' in obj) collectFilterFields(obj.not, acc);
}

/**
 * True when a spec's `view.filter` selects on the `id` field ALONE — a STATIC pin
 * (a frozen, finite candidate set, e.g. `{ field:'id', op:'in', value:[...] }`), with
 * no property selector (plan / paths / tags / priority / …) to make it a standing,
 * auto-inflowing lane.
 *
 * The discipline tripwire: an id-pin is the intended EXCEPTION for a fixed wave
 * (hotfix / cutover / re-drive); a Queen who pins by id for ONGOING work has quietly
 * fallen back to hand-listing items. `setClaimSpec` records this per stored spec so
 * over-reliance is countable (`bee_claim_specs.id_only`), not silent. No filter at
 * all ⇒ false (the whole ready frontier — the opposite of a pin).
 */
export function isIdOnlySelector(spec: { view?: { filter?: unknown } } | null | undefined): boolean {
  const filter = spec?.view?.filter;
  if (filter == null) return false;
  const fields = new Set<string>();
  collectFilterFields(filter, fields);
  return fields.size > 0 && [...fields].every((f) => f === 'id');
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
