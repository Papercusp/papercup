/**
 * Per-project duplicate screening: which newly filed work-items are held back from every
 * claim until the scheduled duplicate review has looked at them.
 *
 * The hold exists for projects where many agents file at once: a hundred agents on one
 * project filed the same problem many times over, the quick check at filing missed the
 * reworded ones, and the scheduled model review is what catches them. Which filings that is
 * worth an hour's wait for differs by project, so the project says, with a FILTER:
 *
 *   - a filter  — a new item the filter selects is held; one it does not select is claimable
 *                 at once. The filter is a rules-engine condition (`@papercusp/rules`
 *                 `DataCondition`, the shape a reaction rule's `when` has) over the item being
 *                 filed (`ScreenedItem`): `{ "kind": "bug" }`, `{ "kind": { "in": ["bug",
 *                 "task"] } }`, `{ "all": [{ "kind": "bug" }, { "not": { "severity": "nit" } }] }`.
 *                 `{}` selects every item.
 *   - `"off"`   — nothing is held.
 *
 * A project that names neither uses `DEFAULT_DUPLICATE_SCREENING_FILTER`: bugs. Bugs are what
 * agents file as they run into things, with the least context and the most duplicates; work
 * broken down on purpose (changes, tasks) is not held unless the project's filter says so.
 *
 * The value is one key of the project's `configOverrides` (`harness:configure`, or
 * `pot:update` for a pot). The quick check at filing runs whatever the value and still
 * refuses an identical title; only the hold changes. The filing-time bypasses of
 * `work-items-admission` (a plan item, critical severity, a security topic, a named owner)
 * are unchanged and come first.
 *
 * FAIL DIRECTION: a project that cannot be read or is not registered, and a stored value that
 * is neither `"off"` nor a valid condition, are treated as the default filter. A filter that
 * throws while it is evaluated (a bad pattern) holds the item: a broken filter must not turn
 * the hold off for a project that asked for it.
 */
import { dataConditionSchema, evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import { loadHarnessRegistry } from './harness-registry';

export const DUPLICATE_SCREENING_KEY = 'duplicateScreening';
export const DUPLICATE_SCREENING_OFF = 'off';
/** The filter of a project that sets none: bugs are held, nothing else. */
export const DEFAULT_DUPLICATE_SCREENING_FILTER: DataCondition = { kind: 'bug' };

export type DuplicateScreening = typeof DUPLICATE_SCREENING_OFF | DataCondition;

/** What a screening filter is evaluated over: the item as it is being filed. */
export interface ScreenedItem {
  kind: string;
  severity?: string | null;
  title?: string | null;
  summary?: string | null;
  topics?: readonly string[] | null;
  /** The outside reference the item is filed under, when it has one. */
  planRef?: string | null;
  source?: string | null;
  createdBy?: string | null;
}

function isCondition(value: unknown): value is DataCondition {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && dataConditionSchema.safeParse(value).success;
}

/** The screening a project's overrides name; the default filter when they name none or one that is not valid. */
export function duplicateScreeningOf(configOverrides: Record<string, unknown> | null | undefined): DuplicateScreening {
  const value = configOverrides?.[DUPLICATE_SCREENING_KEY];
  if (value === DUPLICATE_SCREENING_OFF) return DUPLICATE_SCREENING_OFF;
  return isCondition(value) ? value : DEFAULT_DUPLICATE_SCREENING_FILTER;
}

/** Whether `item` is held for the duplicate review under `screening`. */
export function screeningHolds(screening: DuplicateScreening, item: ScreenedItem): boolean {
  if (screening === DUPLICATE_SCREENING_OFF) return false;
  try {
    return evaluateDataCondition(screening, item);
  } catch {
    return true;
  }
}

/**
 * Why `item` is NOT held under `screening`, for the row's `admitted_by`; null when it is held.
 * A policy reason, not a filing-time bypass: nothing the filer did earned it.
 */
export function screeningExemption(screening: DuplicateScreening, item: ScreenedItem): string | null {
  if (screeningHolds(screening, item)) return null;
  return screening === DUPLICATE_SCREENING_OFF ? 'policy:duplicate-screening-off' : 'policy:duplicate-screening-filter';
}

/**
 * What is wrong with the screening value in a set of overrides about to be written, or null.
 * `harness:configure` and `pot:update` refuse with it, so a mistyped value is not stored and
 * then read back as the default with nobody told.
 */
export function duplicateScreeningComplaint(configOverrides: Record<string, unknown>): string | null {
  if (!(DUPLICATE_SCREENING_KEY in configOverrides)) return null;
  const value = configOverrides[DUPLICATE_SCREENING_KEY];
  if (value === null || value === undefined || value === DUPLICATE_SCREENING_OFF || isCondition(value)) return null;
  return (
    `\`${DUPLICATE_SCREENING_KEY}\` must be "${DUPLICATE_SCREENING_OFF}", a filter over the item being filed ` +
    `(a rules condition such as {"kind":"bug"}; {} selects every item), or null to go back to the default ` +
    `(${JSON.stringify(DEFAULT_DUPLICATE_SCREENING_FILTER)}); got ${JSON.stringify(value)}.`
  );
}

/** The screening of the project `harnessSlug` in `workspaceId`; the default filter when it cannot be told. */
export async function projectDuplicateScreening(
  workspaceId: string | null | undefined,
  harnessSlug: string | null | undefined,
): Promise<DuplicateScreening> {
  const slug = harnessSlug?.trim();
  if (!slug || slug === '*') return DEFAULT_DUPLICATE_SCREENING_FILTER;
  try {
    const registry = await loadHarnessRegistry(workspaceId && workspaceId !== '*' ? workspaceId : undefined);
    const entry = registry.projects.find((project) => project.slug === slug);
    return duplicateScreeningOf(entry?.configOverrides as Record<string, unknown> | undefined);
  } catch {
    return DEFAULT_DUPLICATE_SCREENING_FILTER;
  }
}

/** `screeningExemption` for a project read from the registry: the one call the filing paths make. */
export async function projectScreeningExemption(
  workspaceId: string | null | undefined,
  harnessSlug: string | null | undefined,
  item: ScreenedItem,
): Promise<string | null> {
  return screeningExemption(await projectDuplicateScreening(workspaceId, harnessSlug), item);
}
