/**
 * Canonical trigger-source ownership seam.
 *
 * `owner_user_id` is captured from the authenticated local connection flow.
 * Provider payload fields and `created_by` are deliberately absent from the
 * resolver API, so adapters cannot accidentally treat either as vault identity.
 */
import type postgres from 'postgres';

export interface ExternalTriggerSourceRow {
  id: string;
  workspaceId: string;
  kind: string;
  ownerUserId: string | null;
  credentialRef: string | null;
  status: string;
  config: Record<string, unknown>;
  cursor: Record<string, unknown>;
}

export interface CreateOwnedExternalTriggerSourceInput {
  workspaceId: string;
  kind: string;
  ownerUserId: string;
  credentialRef?: string | null;
  status?: string;
  config?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
  createdBy?: string | null;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`external_trigger_${field}_required`);
  return normalized;
}

/** Provision a user-owned source from an authenticated local connection. */
export async function createOwnedExternalTriggerSource(
  sql: postgres.Sql,
  input: CreateOwnedExternalTriggerSourceInput,
): Promise<ExternalTriggerSourceRow> {
  const workspaceId = required(input.workspaceId, 'workspace_id');
  const kind = required(input.kind, 'source_kind');
  const ownerUserId = required(input.ownerUserId, 'owner_user_id');
  const credentialRef = input.credentialRef?.trim() || null;
  const status = input.status?.trim() || 'unconfigured';
  const config = JSON.stringify(input.config ?? {});
  const cursor = JSON.stringify(input.cursor ?? {});
  const rows = await sql<ExternalTriggerSourceRow[]>`
    INSERT INTO harness_shared.trigger_sources
      (workspace_id, kind, owner_user_id, credential_ref, status, config, cursor, created_by)
    VALUES (
      ${workspaceId}, ${kind}, ${ownerUserId}::uuid, ${credentialRef}, ${status},
      ${config}::text::jsonb, ${cursor}::text::jsonb, ${input.createdBy?.trim() || null}
    )
    RETURNING id::text,
              workspace_id AS "workspaceId",
              kind,
              owner_user_id::text AS "ownerUserId",
              credential_ref AS "credentialRef",
              status,
              config,
              cursor`;
  if (!rows[0]) throw new Error('external_trigger_source_create_failed');
  return rows[0];
}

/** Read one source and its persisted local principal. */
export async function getExternalTriggerSource(
  sql: postgres.Sql,
  workspaceId: string,
  sourceId: string,
): Promise<ExternalTriggerSourceRow | null> {
  const rows = await sql<ExternalTriggerSourceRow[]>`
    SELECT id::text,
           workspace_id AS "workspaceId",
           kind,
           owner_user_id::text AS "ownerUserId",
           credential_ref AS "credentialRef",
           status,
           config,
           cursor
      FROM harness_shared.trigger_sources
     WHERE workspace_id = ${required(workspaceId, 'workspace_id')}
       AND id = ${required(sourceId, 'source_id')}::uuid
     LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Resolve the authoritative local principal for a source, failing closed when
 * an old/unowned row has not been connected through the authenticated flow.
 */
export async function requireExternalTriggerSourceOwner(
  sql: postgres.Sql,
  workspaceId: string,
  sourceId: string,
): Promise<string> {
  const source = await getExternalTriggerSource(sql, workspaceId, sourceId);
  if (!source) throw new Error(`external_trigger_unknown_source:${sourceId}`);
  if (!source.ownerUserId) throw new Error(`external_trigger_source_owner_required:${sourceId}`);
  return source.ownerUserId;
}
