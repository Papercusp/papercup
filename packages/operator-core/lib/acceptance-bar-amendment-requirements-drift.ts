/**
 * EI-24816459669484550: does an acceptance-rubric amendment leave the subject plan's
 * `## Requirements` block disagreeing with the rubric?
 *
 * WHY. Once a plan's acceptance rubric is seeded, the rubric criterion is the canonical BAR
 * text (`acceptance-bar-seed.ts` header; the amendment refreshes execution projections "from the
 * canonical rubric, never from its old Requirements seed"). Nothing re-renders the plan's R-N
 * block after an amendment, so the plan and the rubric hold two hand-maintained copies of one
 * truth (R-N condition -> criterion `model`, R-N falsifier -> criterion `driftMarkers`) with no
 * reconciler. Measured twice on enterprise-data-sources-2026-10-01 (R-13): the plan's falsifier
 * was edited, the amendment patched `model` only, the rubric kept the superseded falsifier in
 * `driftMarkers`, and only an outside reviewer caught it.
 *
 * WHAT. A pure comparison of the amended criteria against the plan's parsed Requirements,
 * surfaced on the amendment preview (dry run) as an ADVISORY. It never refuses: the rubric is
 * canonical, so a plan block that lags is legitimate. The point is that the author sees the
 * divergence before applying, instead of an outside reviewer finding it after.
 *
 * `driftMarkers` is compared only for explicit three-section (```requirement JSON) R-N blocks.
 * A legacy prose R-N has no falsifier of its own: its seeded `driftMarkers` is a generated
 * sentence, so comparing it would report drift that does not exist.
 *
 * WI-10006829: the Verification section (`method`, `check`, `replication`) is compared too, and
 * so is any Acceptance metadata the plan block states explicitly. Comparing only model and
 * driftMarkers reported `inSync:true` after an amendment moved `check.files` to a different test,
 * so a reviewer who read the plan graded a stale file list (pui-chat-first-ux rev 10). The
 * Verification fields are compared whenever the block is explicit, because the seeder never
 * defaults them; requiredScope/requiredTestLayers/evidencePlane/evidenceRuntime only when the
 * block states them, because the seeder fills those from the Bar-to-work map otherwise.
 */
import type { ParsedRequirementBar } from './acceptance-bar-seed';

export type RequirementsDriftField =
  | 'model'
  | 'driftMarkers'
  | 'method'
  | 'check'
  | 'replication'
  | 'requiredScope'
  | 'requiredTestLayers'
  | 'evidencePlane'
  | 'evidenceRuntime';

/** Compared whenever the plan block is explicit: the seeder never supplies a default for them. */
const VERIFICATION_FIELDS = ['method', 'check', 'replication'] as const;
/** Compared only when the plan block states them: otherwise the seeder derives them from the map. */
const STATED_ACCEPTANCE_FIELDS = ['requiredScope', 'requiredTestLayers', 'evidencePlane', 'evidenceRuntime'] as const;

export interface RequirementsDriftEntry {
  barKey: string;
  /** True when this amendment changes the BAR; false means the drift predates this amendment. */
  changedByAmendment: boolean;
  /** `missing-from-plan`: the rubric carries a BAR the plan's Requirements block does not. */
  kind: 'missing-from-plan' | 'text-differs';
  /** Which criterion fields disagree with the plan (empty for `missing-from-plan`). */
  fields: RequirementsDriftField[];
}

export interface RequirementsDrift {
  /** True when every surviving amended BAR agrees with the plan's Requirements block. */
  inSync: boolean;
  entries: RequirementsDriftEntry[];
  /** What to do about the drift; null when in sync. */
  action: string | null;
  /**
   * WI-10006835: BARs whose drift the APPLY resolves on its own. An amended BAR with an explicit
   * ```requirement block is re-rendered from the amended criterion in the same transaction as the
   * rubric revision (`rerenderAmendedRequirementBlocks`). Present only when out of sync.
   */
  rerenderedOnApply?: string[];
}

/** Whitespace-insensitive, since the canonical writer trims and collapses BAR text. */
const comparable = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/**
 * Structural form for the non-text fields (`check` objects, set-valued arrays): object keys sorted,
 * arrays compared as sets, strings whitespace-collapsed. Absent and null both read as absent.
 */
const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return comparable(value);
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};
const sameStructure = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

const barNumber = (barKey: string): number => {
  const match = /^R-(\d+)$/.exec(barKey);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

export function diffAmendedCriteriaAgainstRequirements(input: {
  requirementBars: readonly ParsedRequirementBar[];
  nextCriteria: ReadonlyArray<Record<string, unknown>>;
  changedBars: Iterable<string>;
  removedBars?: Iterable<string>;
}): RequirementsDrift {
  const planByBar = new Map(input.requirementBars.map((bar) => [bar.barKey, bar]));
  const changed = new Set(input.changedBars);
  const removed = new Set(input.removedBars ?? []);
  const entries: RequirementsDriftEntry[] = [];

  for (const criterion of input.nextCriteria) {
    const barKey = typeof criterion.barKey === 'string' ? criterion.barKey.trim() : '';
    // Non-BAR criteria (no barKey) are not projected from the Requirements block.
    if (!barKey || removed.has(barKey)) continue;
    const changedByAmendment = changed.has(barKey);
    const plan = planByBar.get(barKey);
    if (!plan) {
      entries.push({ barKey, changedByAmendment, kind: 'missing-from-plan', fields: [] });
      continue;
    }
    const fields: RequirementsDriftField[] = [];
    if (comparable(criterion.model) !== comparable(plan.model)) fields.push('model');
    if (plan.criterion) {
      const stated = plan.criterion as Record<string, unknown>;
      if (comparable(criterion.driftMarkers) !== comparable(stated.driftMarkers)) fields.push('driftMarkers');
      for (const field of VERIFICATION_FIELDS) {
        if (!sameStructure(criterion[field], stated[field])) fields.push(field);
      }
      for (const field of STATED_ACCEPTANCE_FIELDS) {
        if (stated[field] !== undefined && !sameStructure(criterion[field], stated[field])) fields.push(field);
      }
    }
    if (fields.length) entries.push({ barKey, changedByAmendment, kind: 'text-differs', fields });
  }

  entries.sort((a, b) => barNumber(a.barKey) - barNumber(b.barKey) || a.barKey.localeCompare(b.barKey));
  if (!entries.length) return { inSync: true, entries, action: null };

  const named = entries
    .map((entry) => (entry.kind === 'missing-from-plan' ? `${entry.barKey} (missing from plan)` : `${entry.barKey} (${entry.fields.join(', ')})`))
    .join('; ');
  return {
    inSync: false,
    entries,
    action:
      `The plan's ## Requirements block disagrees with the amended rubric on ${named}. The rubric is ` +
      'canonical after seeding and nothing re-renders the plan block, so this drift persists unless you ' +
      'fix it: update the plan R-N block to match (plans:set-content), or make the amendment match the ' +
      'plan on every field named, before vetting. Reviewers who read the plan block grade the stale copy.',
  };
}
