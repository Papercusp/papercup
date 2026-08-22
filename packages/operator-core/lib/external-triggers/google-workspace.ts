/** Shared Google Workspace OAuth → owned trigger-source connection seam. */
import type postgres from 'postgres';
import {
  type ExternalTriggerSourceRow,
  upsertOwnedExternalTriggerSource,
} from './source-store';

export const GOOGLE_WORKSPACE_OAUTH_PLUGIN = 'google-workspace';
export const GOOGLE_WORKSPACE_SOURCE_KINDS = ['gmail', 'gcal'] as const;
const OAUTH_FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function googleWorkspaceOAuthField(credentialRef: string | null): string {
  const prefix = `${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:`;
  if (!credentialRef?.startsWith(prefix)) {
    throw new Error('google_workspace_credential_ref_invalid');
  }
  const field = credentialRef.slice(prefix.length);
  if (!OAUTH_FIELD.test(field)) throw new Error('google_workspace_credential_ref_invalid');
  return field;
}

export function googleWorkspaceCredentialRef(field: string): string {
  if (!OAUTH_FIELD.test(field)) throw new Error('google_workspace_oauth_field_invalid');
  return `${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:${field}`;
}

export function assertGoogleWorkspaceOwnerUserId(ownerUserId: string | undefined): string {
  const normalized = ownerUserId?.trim() ?? '';
  if (!UUID.test(normalized)) throw new Error('google_workspace_owner_user_id_invalid');
  return normalized;
}

/**
 * One OAuth consent backs both provider adapters. They remain separate source
 * rows because canonical event keys and replay cursors are source-kind scoped,
 * while both rows point at the same opaque OAuth credential reference.
 */
export async function provisionOwnedGoogleWorkspaceSources(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    field: string;
    createdBy?: string | null;
  },
): Promise<ExternalTriggerSourceRow[]> {
  const ownerUserId = assertGoogleWorkspaceOwnerUserId(input.ownerUserId);
  const credentialRef = googleWorkspaceCredentialRef(input.field);
  const rows: ExternalTriggerSourceRow[] = [];
  for (const kind of GOOGLE_WORKSPACE_SOURCE_KINDS) {
    rows.push(await upsertOwnedExternalTriggerSource(sql, {
      workspaceId: input.workspaceId,
      kind,
      ownerUserId,
      credentialRef,
      status: 'connected',
      createdBy: input.createdBy ?? `owner:${ownerUserId}`,
    }));
  }
  return rows;
}
