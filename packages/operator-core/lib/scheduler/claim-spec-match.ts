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

/** Project the fields available on an issue-family WorkItem into spec vocabulary. */
export function claimSpecSubjectFromWorkItem(item: WorkItem, topicTags: string[] = []): ClaimSpecSubject {
  const payload = record(item.payload);
  const planItem = record(payload.plan_item ?? payload.planItem);
  const plan =
    (typeof planItem.plan_slug === 'string' && planItem.plan_slug) ||
    (typeof planItem.slug === 'string' && planItem.slug) ||
    (typeof payload.source_plan_slug === 'string' && payload.source_plan_slug) ||
    null;
  const itemId =
    (typeof planItem.item_id === 'string' && planItem.item_id) ||
    (typeof planItem.itemId === 'string' && planItem.itemId) ||
    (typeof planItem.item === 'string' && planItem.item) ||
    null;
  const createdMs = Date.parse(item.createdAt);
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    priority: item.priority,
    tags: [...new Set([...strings(payload.tags), ...topicTags])],
    paths: strings(payload.paths),
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
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function compareScalar(actual: string | number | null, leaf: FilterLeaf): boolean {
  if (actual == null) return false; // mirrors SQL NULL comparison semantics
  const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
  if (leaf.op === 'in') return values.some((v) => String(actual) === String(v));
  if (leaf.op === 'glob') return globRegex(String(leaf.value)).test(String(actual));
  if (leaf.op === 'contains') return String(actual).toLowerCase().includes(String(leaf.value).toLowerCase());

  const numeric = typeof actual === 'number';
  const rhs = numeric ? Number(leaf.value) : String(leaf.value);
  if (numeric && !Number.isFinite(rhs as number)) return false;
  switch (leaf.op) {
    case '=': return actual === rhs;
    case '!=': return actual !== rhs;
    case '<': return actual < (rhs as never);
    case '<=': return actual <= (rhs as never);
    case '>': return actual > (rhs as never);
    case '>=': return actual >= (rhs as never);
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
  if (leaf.field === 'priority' && ['<', '<=', '>', '>='].includes(leaf.op)) {
    const inverted = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[leaf.op] as FilterLeaf['op'];
    return compareScalar(actual, { ...leaf, op: inverted });
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
