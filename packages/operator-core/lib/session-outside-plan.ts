import { getOrgPg } from '@papercusp/db-org';
import { z } from 'zod';
import type { Sql, TransactionSql } from 'postgres';
import { activeWorkspaceId } from './workspace-registry';

/** Opaque client label. Do not trim, parse, dereference, or infer authority from it. */
export const sessionOutsidePlanRefSchema = z.string().min(1).max(200).refine(
  value => !value.includes('\0'),
  'planRef must be representable in PostgreSQL (no NUL characters)',
);

export function resolveSessionOutsidePlanRef(
  requested: unknown,
  stored: string | null = null,
  planSlug?: string | null,
): string | null {
  const planRef = requested === undefined || requested === null
    ? stored : sessionOutsidePlanRefSchema.parse(requested);
  if (planRef !== null && planSlug) {
    throw new Error('planRef and a Papercusp plan binding (plan/plan_slug) are mutually exclusive');
  }
  if (stored !== null && planRef !== stored) {
    throw new Error('planRef conflicts with the persisted session outside plan reference');
  }
  return planRef;
}

/** Always use the authenticated workspace, never caller environment or presence text. */
export async function readSessionOutsidePlanRef(
  ownerId: string,
  workspaceId = activeWorkspaceId(),
  sql: Sql | TransactionSql = getOrgPg().sql,
): Promise<string | null> {
  const [row] = await sql<Array<{ outside_plan_ref: string | null }>>`
    SELECT to_jsonb(adv_sessions)->>'outside_plan_ref' AS outside_plan_ref FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId} AND coord_owner_id = ${ownerId}
     ORDER BY started_at DESC, id DESC LIMIT 1`;
  return row?.outside_plan_ref ?? null;
}

/** Trusted bootstrap only. A conflicting binding fails closed before the CLI starts. */
export async function bindSessionOutsidePlanRef(input: {
  ownerId: string;
  advSessionId: number;
  workspaceId: string;
  planRef: string;
}): Promise<void> {
  const planRef = sessionOutsidePlanRefSchema.parse(input.planRef);
  const { sql } = getOrgPg();
  const [row] = await sql<Array<{ id: number }>>`
    UPDATE harness_shared.adv_sessions SET outside_plan_ref = ${planRef}
     WHERE id = ${input.advSessionId} AND workspace_id = ${input.workspaceId}
       AND coord_owner_id = ${input.ownerId} AND plan_slug IS NULL
       AND (outside_plan_ref IS NULL OR outside_plan_ref = ${planRef})
     RETURNING id`;
  if (!row) throw new Error('planRef could not bind: missing session or conflicting Papercusp/outside plan binding');
}
