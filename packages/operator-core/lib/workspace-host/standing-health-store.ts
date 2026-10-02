/**
 * Target selection for the standing health pass (WI-10004950, see standing-health.ts).
 *
 * Cross-workspace by design: one controller serves hosts in every workspace it provisioned, so the
 * read uses the admin pool (`getOrgPg`, RLS-bypassing — `workspace_hosts` forces RLS) and scopes by
 * the controller authority stamped on each row instead of by workspace. The attestation WRITE stays
 * workspace-scoped (`recordWorkspaceHostHealth` → `withWorkspace`).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { WorkspaceHostStandingHealthTarget } from './standing-health';

/**
 * Lifecycle states in which a host is meant to be up. `repairing`, `provisioning`, `stopped` and the
 * teardown states are excluded: a lifecycle action owns those hosts and expects them to be down or
 * changing, so a standing "unreachable" there would be noise.
 */
export const WORKSPACE_HOST_STANDING_HEALTH_DESIRED_STATES = ['running', 'degraded'] as const;

/** The clouds with standing seams (`resolveWorkspaceHostSoakSeams` dispatches on the host's target). */
export const WORKSPACE_HOST_STANDING_HEALTH_TARGETS = ['gcp', 'aws'] as const;

interface TargetRow {
  workspace_id: string;
  id: string;
  health_attested_at: Date | string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Every live host whose controller authority is `controllerId`, in a stable order. */
export async function listWorkspaceHostStandingHealthTargets(
  controllerId: string,
  sql?: Sql,
): Promise<WorkspaceHostStandingHealthTarget[]> {
  const db = sql ?? getOrgPg().sql;
  const rows = await db<TargetRow[]>`
    SELECT workspace_id, id, health_attested_at
      FROM harness_shared.workspace_hosts
     WHERE controller_id = ${controllerId}
       AND target = ANY(${[...WORKSPACE_HOST_STANDING_HEALTH_TARGETS] as string[]}::text[])
       AND desired_state = ANY(${[...WORKSPACE_HOST_STANDING_HEALTH_DESIRED_STATES] as string[]}::text[])
       AND desired_spec IS NOT NULL
     ORDER BY workspace_id, id
  `;
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    hostId: row.id,
    healthAttestedAt: isoOrNull(row.health_attested_at),
  }));
}
