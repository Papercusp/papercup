/**
 * Pure claim-spec predicate evaluation for assignment-admission checks.
 *
 * The atomic scheduler compiles feature-family filters to SQL. Assignment seams
 * also need to answer the inverse question for one already-known (or not-yet-
 * created) item: "would this target member's spec admit this item?" Keeping the
 * evaluator here gives by-id claims, create+assign, plan-item dispatch, and the
 * issue-family fallback one shared decision instead of four approximations.
 */
import type { WorkItem } from '../work-items';
import type { ClaimSpec, FilterLeaf, FilterNode } from './claim-spec';

export interface ClaimSpecSubject {
  id: string | null;
  title: string | null;
  kind: string | null;
  priority: number | null;
  tags: string[];
  paths: string[];
  plan: string | null;
  planItem: string[];
  age: number | null;
  riskTier: string | null;
  redundancy: number | null;
  estCost: number | null;
  assignee: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive the plan slug an item belongs to from its payload, single-sourced so
 * every consumer (the spec subject below, the `work-item:claimable` event
 * payload — EI-15185) agrees on the exact same derivation. Returns null when the
 * item is plan-less.
 */
export function planSlugOfWorkItem(item: WorkItem): string | null {
  const payload = record(item.payload);
  // WI-5832 / EI-18666217180294576 follow-up (confirmed by direct code read against
  // plan-items/convert.ts, NOT hypothetical): scheduled-recurring-plans (D-016) mint a
  // plan-RUN work-item with `sourcePlanSlug: opts.planRun?.templateSlug ?? opts.planSlug`
  // (written to the `source_plan_slug` COLUMN, which the SQL FIELD_MAP.plan compiler
  // reads FIRST) while `payload.plan_item.plan_slug` gets the RUN's own (different)
  // slug — the two are DELIBERATELY distinct identities by design, not a data bug. This
  // evaluator used to fall through to `plan_item.plan_slug` without ever considering
  // `payload.plan_run`, so on any plan-run item a `plan = '<template slug>'` claim-spec
  // matched via the SQL admission path (get-next.ts, reads the column) but NOT via this
  // JS evaluator (work_items:claim / by-id admission / the work-item:claimable event
  // payload) — a real split-brain the moment the first scheduled-recurring plan fires
  // (none has yet in production, which is why this was still dormant). Check
  // `payload.plan_run.templateSlug` FIRST so both evaluators agree on the STABLE
  // template identity for a plan-run item, exactly mirroring the column's write-time
  // derivation above.
  const planRun = record(payload.plan_run);
  if (typeof planRun.templateSlug === 'string' && planRun.templateSlug) return planRun.templateSlug;
  const planItem = record(payload.plan_item ?? payload.planItem);
  return (
    (typeof planItem.plan_slug === 'string' && planItem.plan_slug) ||
    (typeof planItem.slug === 'string' && planItem.slug) ||
    (typeof payload.source_plan_slug === 'string' && payload.source_plan_slug) ||
    null
  );
}

/**
 * Derive the item's own STATIC `payload.tags` (never the viewer-relative
 * `topicTags` a caller may merge in on top) — single-sourced so the spec
 * subject below AND the `work-item:claimable` event payload (EI-14161) agree
 * on exactly the same tag set. Returns `[]` when the item carries no tags.
 */
export function staticTagsOfWorkItem(item: WorkItem): string[] {
  return strings(record(item.payload).tags);
}

/** Project the fields available on an issue-family WorkItem into spec vocabulary. */
export function claimSpecSubjectFromWorkItem(item: WorkItem, topicTags: string[] = []): ClaimSpecSubject {
  const payload = record(item.payload);
  const planItem = record(payload.plan_item ?? payload.planItem);
  const plan = planSlugOfWorkItem(item);
  const itemId =
    (typeof planItem.item_id === 'string' && planItem.item_id) ||
    (typeof planItem.itemId === 'string' && planItem.itemId) ||
    (typeof planItem.item === 'string' && planItem.item) ||
    null;
  const createdMs = Date.parse(item.createdAt);
  // WI-5272: quarantine/de-quarantine-family items (testing:flakiness) stamp a single
  // `payload.filePath` string, not the plural `payload.paths` array most other creators
  // use — fold it in so a `paths`-based spec filter can see it too. Without this, a claim
  // spec has no structural signal to distinguish "a de-quarantine item whose TITLE happens
  // to name a file under lib/memory/**" from a genuine p2p/federation/rig item, and falls
  // back to an unreliable title-substring glob (see the *federation* false-positive class:
  // WI-5184/WI-5270 refused admission for merely naming federation-slug-stamp.test.ts).
  const filePathPaths = typeof payload.filePath === 'string' && payload.filePath ? [payload.filePath] : [];
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    priority: item.priority,
    tags: [...new Set([...staticTagsOfWorkItem(item), ...topicTags])],
    paths: [...new Set([...strings(payload.paths), ...filePathPaths])],
    plan,
    planItem: itemId ? [itemId] : strings(payload.source_plan_item_ids),
    age: Number.isFinite(createdMs) ? createdMs : null,
    riskTier: typeof payload.risk_tier === 'string' ? payload.risk_tier : null,
    redundancy: finiteNumber(payload.redundancy),
    estCost: finiteNumber(payload.est_cost ?? payload.expected_cost_cents),
    assignee: item.assignee,
  };
}

function valueFor(subject: ClaimSpecSubject, field: FilterLeaf['field']): string | number | string[] | null {
  switch (field) {
    case 'id': return subject.id;
    case 'title': return subject.title;
    case 'kind': return subject.kind;
    case 'priority': return subject.priority;
    case 'tags': return subject.tags;
    case 'paths': return subject.paths;
    case 'plan': return subject.plan;
    case 'plan_item': return subject.planItem;
    case 'age': return subject.age;
    case 'risk_tier': return subject.riskTier;
    case 'redundancy': return subject.redundancy;
    case 'est_cost': return subject.estCost;
    case 'assignee': return subject.assignee;
  }
  return null;
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function compareScalar(actual: string | number | null, leaf: FilterLeaf): boolean {
  if (actual == null) {
    // A NULL/absent field has NO value, so it matches no positive predicate (`=`, `glob`,
    // `in`, relational) — but it IS distinct from every concrete value, so `!=` MATCHES.
    // This mirrors the SQL compiler's `IS DISTINCT FROM` (get-next.ts) and the array
    // branches in matchLeaf below, where `!=` on an absent field is likewise true.
    // (EI-13306: the previous blanket `return false` claimed to "mirror SQL NULL comparison
    // semantics" — it did not. SQL's bare `NOT (...)` DROPS null rows while this evaluator's
    // `!matchLeaf(...)` ADMITS them, so the two evaluators of one spec language disagreed on
    // exactly the filter shape that starved a 10-agent fleet twice. Both are now null-safe
    // and claim-spec-null-semantics.integration.test.ts pins their parity.)
    return leaf.op === '!=';
  }
  const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
  if (leaf.op === 'in') return values.some((v) => String(actual) === String(v));
  if (leaf.op === 'glob') return globRegex(String(leaf.value)).test(String(actual));
  if (leaf.op === 'contains') return String(actual).toLowerCase().includes(String(leaf.value).toLowerCase());

  if (typeof actual === 'number') {
    const rhs = Number(leaf.value);
    if (!Number.isFinite(rhs)) return false;
    switch (leaf.op) {
      case '=': return actual === rhs;
      case '!=': return actual !== rhs;
      case '<': return actual < rhs;
      case '<=': return actual <= rhs;
      case '>': return actual > rhs;
      case '>=': return actual >= rhs;
      default: return false;
    }
  }

  const rhs = String(leaf.value);
  switch (leaf.op) {
    case '=': return actual === rhs;
    case '!=': return actual !== rhs;
    case '<': return actual < rhs;
    case '<=': return actual <= rhs;
    case '>': return actual > rhs;
    case '>=': return actual >= rhs;
    default: return false;
  }
}

function matchLeaf(subject: ClaimSpecSubject, leaf: FilterLeaf): boolean {
  const actual = valueFor(subject, leaf.field);
  if (Array.isArray(actual)) {
    const wanted = (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).map(String);
    if (leaf.op === 'in') return actual.some((v) => wanted.includes(v));
    if (leaf.op === 'glob') return actual.some((v) => globRegex(String(leaf.value)).test(v));
    if (leaf.op === '!=') return !actual.includes(String(leaf.value));
    // SQL compiler treats array '=' and 'contains' as membership.
    return actual.includes(String(leaf.value));
  }

  // priority is stored physically as feature_order (lower = more important), so
  // the SQL compiler inverts relational comparators. Mirror that logical mapping.
  if (leaf.field === 'priority') {
    switch (leaf.op) {
      case '<': return compareScalar(actual, { ...leaf, op: '>' });
      case '<=': return compareScalar(actual, { ...leaf, op: '>=' });
      case '>': return compareScalar(actual, { ...leaf, op: '<' });
      case '>=': return compareScalar(actual, { ...leaf, op: '<=' });
    }
  }
  return compareScalar(actual, leaf);
}

export function matchesClaimSpecFilter(subject: ClaimSpecSubject, filter: FilterNode | undefined): boolean {
  if (!filter) return true;
  if ('field' in filter) return matchLeaf(subject, filter);
  if ('all' in filter) return filter.all.every((node) => matchesClaimSpecFilter(subject, node));
  if ('any' in filter) return filter.any.some((node) => matchesClaimSpecFilter(subject, node));
  return !matchesClaimSpecFilter(subject, filter.not);
}

export function matchesWorkItemClaimSpec(item: WorkItem, spec: ClaimSpec, topicTags: string[] = []): boolean {
  return matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(item, topicTags), spec.view.filter);
}
