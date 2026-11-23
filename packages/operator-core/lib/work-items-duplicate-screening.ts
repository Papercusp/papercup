/**
 * Per-project duplicate screening: which newly filed work-items are held back from every
 * claim until the scheduled duplicate review has looked at them.
 *
 * The hold exists for projects where many agents file at once: a hundred agents on one
 * project filed the same problem many times over, the quick check at filing missed the
 * reworded ones, and the scheduled model review is what catches them. On a project with a
 * handful of agents the same hold only delays the work: an item waits most of an hour for
 * a review that has nothing to compare it with. So the level is the project's own:
 *
 *   - `all`  — every new item is held (the behaviour before this setting, and the default);
 *   - `bugs` — only bugs are held;
 *   - `off`  — nothing is held.
 *
 * The level is one key of the project's `configOverrides` (`harness:configure`, or
 * `pot:update` for a pot). The quick check at filing runs at every level and still refuses
 * an identical title; only the hold changes. The filing-time bypasses of
 * `work-items-admission` (a plan item, critical severity, a security topic, a named owner)
 * are unchanged and come first.
 *
 * FAIL DIRECTION: a project that cannot be read, is not registered, or carries a value this
 * module does not know is treated as `all`. A reader that fell open here would turn the
 * hold off for a project that asked for it.
 */
export const DUPLICATE_SCREENING_KEY = 'duplicateScreening';
export const DUPLICATE_SCREENING_LEVELS = ['all', 'bugs', 'off'] as const;
export type DuplicateScreening = (typeof DUPLICATE_SCREENING_LEVELS)[number];
export const DEFAULT_DUPLICATE_SCREENING: DuplicateScreening = 'all';

export function isDuplicateScreening(value: unknown): value is DuplicateScreening {
  return typeof value === 'string' && (DUPLICATE_SCREENING_LEVELS as readonly string[]).includes(value);
}

/** The level a project's overrides name; `all` when they name none or one this module does not know. */
export function duplicateScreeningOf(configOverrides: Record<string, unknown> | null | undefined): DuplicateScreening {
  const value = configOverrides?.[DUPLICATE_SCREENING_KEY];
  return isDuplicateScreening(value) ? value : DEFAULT_DUPLICATE_SCREENING;
}

/** Whether a new item of `kind` is held for the duplicate review at `level`. */
export function screeningHolds(level: DuplicateScreening, kind: string): boolean {
  if (level === 'off') return false;
  if (level === 'bugs') return kind === 'bug';
  return true;
}

/**
 * Why a new item of `kind` is NOT held at `level`, for the row's `admitted_by`; null when it
 * is held. A policy reason, not a filing-time bypass: nothing the filer did earned it.
 */
export function screeningExemption(level: DuplicateScreening, kind: string): string | null {
  return screeningHolds(level, kind) ? null : `policy:duplicate-screening-${level}`;
}

/**
 * What is wrong with the screening level in a set of overrides about to be written, or null.
 * `harness:configure` and `pot:update` refuse with it, so a typo is not stored and then read
 * back as `all` with nobody told.
 */
export function duplicateScreeningComplaint(configOverrides: Record<string, unknown>): string | null {
  if (!(DUPLICATE_SCREENING_KEY in configOverrides)) return null;
  const value = configOverrides[DUPLICATE_SCREENING_KEY];
  if (value === null || value === undefined || isDuplicateScreening(value)) return null;
  return (
    `\`${DUPLICATE_SCREENING_KEY}\` must be one of ${DUPLICATE_SCREENING_LEVELS.map((l) => `'${l}'`).join(', ')} ` +
    `(or null to go back to the default, '${DEFAULT_DUPLICATE_SCREENING}'); got ${JSON.stringify(value)}.`
  );
}

/** The screening level of the project `harnessSlug` in `workspaceId`; `all` when it cannot be told. */
export async function projectDuplicateScreening(
  workspaceId: string | null | undefined,
  harnessSlug: string | null | undefined,
): Promise<DuplicateScreening> {
  const slug = harnessSlug?.trim();
  if (!slug || slug === '*') return DEFAULT_DUPLICATE_SCREENING;
  try {
    // Loaded at the call, not with this module: the filing paths import this file, and the
    // registry's own imports reach back into the work-item store.
    const { loadHarnessRegistry } = await import('./harness-registry');
    const registry = await loadHarnessRegistry(workspaceId && workspaceId !== '*' ? workspaceId : undefined);
    const entry = registry.projects.find((project) => project.slug === slug);
    return duplicateScreeningOf(entry?.configOverrides as Record<string, unknown> | undefined);
  } catch {
    return DEFAULT_DUPLICATE_SCREENING;
  }
}

/** `screeningExemption` for a project read from the registry: the one call the filing paths make. */
export async function projectScreeningExemption(
  workspaceId: string | null | undefined,
  harnessSlug: string | null | undefined,
  kind: string,
): Promise<string | null> {
  return screeningExemption(await projectDuplicateScreening(workspaceId, harnessSlug), kind);
}
