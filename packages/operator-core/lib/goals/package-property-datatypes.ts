/**
 * package-property-datatypes.ts — the first-party datatype(s) bundled goal
 * packages' property declarations reference (work-on-everything-goal-2026-08-23
 * P-025; D-005 §2 typed properties; D-004 plan-ref grammar).
 *
 * `validatePropertySchemaDeclaration` refuses a declaration whose datatype ref
 * does not resolve in the workspace's `datatype_registry` — right for user
 * declarations ("declare it via meta:define-datatype first"), but a BUNDLED
 * first-party package must land on a fresh workspace where nothing was ever
 * declared. So the seams that write a package's `propertySchema` onto a goal
 * row (the install seed, the start-from-package mint) ENSURE the first-party
 * datatypes exist first — insert-if-ABSENT, never overwrite: P-024 attaches
 * display specs to these same registry rows, and an ensure that clobbered them
 * would silently erase that lane's work on every install.
 *
 * The one datatype v1 needs: `plan-ref-list` — an ordered list of plan refs in
 * D-004's explicit `plan:` form, the type of the work-on-everything package's
 * `worklist` property (LIST ORDER IS PRIORITY; the owner curates it in the
 * HUD properties panel, the goal agent drives from it — P-025).
 */
import type postgres from 'postgres';
import { getDatatype, upsertDatatype, type DatatypeRow } from '../datatype-registry-store';

/** The datatype ref the work-on-everything `worklist` property declares (P-025). */
export const PLAN_REF_LIST_DATATYPE = 'plan-ref-list';

/**
 * D-004 ruling 1: a plan ref is `plan:<slug>` or `plan:<harness>/<slug>` — the
 * prefix is mandatory (a bare slug is indistinguishable from a goal id by
 * shape). Slug charset mirrors the store's kebab reality: lowercase
 * alphanumerics with `._-` separators, never leading with a separator.
 */
export const PLAN_REF_STRING_PATTERN = '^plan:[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)?$';

/** JSON-Schema payload for `plan-ref-list`: an ordered array of D-004 refs. */
export function planRefListPayloadSchema(): Record<string, unknown> {
  return {
    type: 'array',
    items: { type: 'string', pattern: PLAN_REF_STRING_PATTERN },
  };
}

export interface EnsurePlanRefListDeps {
  get: (sql: postgres.Sql, workspaceId: string, id: string) => Promise<DatatypeRow | null>;
  upsert: typeof upsertDatatype;
}

const DEFAULT_DEPS: EnsurePlanRefListDeps = { get: getDatatype, upsert: upsertDatatype };

/**
 * Ensure `plan-ref-list` exists in this workspace's registry. Insert-if-absent
 * ONLY — an existing row (whatever its content: a P-024 display spec, an owner
 * re-description) is left untouched, so this is safe to call on every seed.
 */
export async function ensurePlanRefListDatatype(
  sql: postgres.Sql,
  workspaceId: string,
  deps: EnsurePlanRefListDeps = DEFAULT_DEPS,
): Promise<{ created: boolean }> {
  const existing = await deps.get(sql, workspaceId, PLAN_REF_LIST_DATATYPE);
  if (existing) return { created: false };
  await deps.upsert(sql, {
    id: PLAN_REF_LIST_DATATYPE,
    workspaceId,
    title: 'Plan-ref list',
    description:
      "An ordered list of plan references in D-004's explicit `plan:` form " +
      '(`plan:<slug>` or `plan:<harness>/<slug>`). List order is priority. ' +
      "The type of a goal's `worklist` property (work-on-everything-goal-2026-08-23 P-025).",
    tier: 'first-class',
    payloadSchema: planRefListPayloadSchema(),
    createdBy: 'goal-package-seed',
  });
  return { created: true };
}
