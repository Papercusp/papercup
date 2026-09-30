/**
 * The per-workspace Remote access switch (external-app-access-to-workspaces-2026-09-29 P-010,
 * decision D-025; migration 1263, harness_shared.connected_app_access_settings).
 *
 * On (the default — a workspace with no row is on): connected-app keys work as their own state
 * allows. Off: the instant kill switch — every app key, service key and client-credentials access
 * token of the workspace is refused on its next request with `remote_access_off` (R-24, R-41).
 *
 * This module only reads and writes the switch. ENFORCEMENT is in ./store.ts: `verifyAppKey` and
 * the token endpoint's `loadClientKeyRow` read the switch in the same query as the key, and
 * `appKeyVerdictOf` / `accessTokenVerdictOf` refuse on it. Nothing caches it, so turning it off
 * takes effect on the very next call.
 *
 * Both functions run inside `withWorkspace()`, so the table's RLS policy bounds them to the
 * caller's workspace.
 */

import { withWorkspace } from '@papercusp/db-org';

export interface RemoteAccessSetting {
  workspaceId: string;
  enabled: boolean;
  /** When the switch last changed. Null = never touched (on by default). */
  changedAt: Date | null;
  /** Who changed it last. Null = never touched. */
  changedBy: string | null;
}

interface SettingRow {
  workspace_id: string;
  enabled: boolean;
  changed_at: Date;
  changed_by: string | null;
}

function settingOf(workspaceId: string, row: SettingRow | undefined): RemoteAccessSetting {
  if (!row) return { workspaceId, enabled: true, changedAt: null, changedBy: null };
  return { workspaceId, enabled: row.enabled, changedAt: row.changed_at, changedBy: row.changed_by };
}

/** The workspace's switch. A workspace that never set it is on. */
export async function getRemoteAccess(workspaceId: string): Promise<RemoteAccessSetting> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<SettingRow[]>`
    SELECT workspace_id, enabled, changed_at, changed_by
      FROM harness_shared.connected_app_access_settings
     WHERE workspace_id = ${workspaceId}
  `);
  return settingOf(workspaceId, rows[0]);
}

/**
 * Turn the workspace's Remote access on or off. Takes effect on the next request of every
 * connected-app credential of the workspace. Returns the stored setting.
 */
export async function setRemoteAccess(
  workspaceId: string,
  enabled: boolean,
  changedBy: string | null,
): Promise<RemoteAccessSetting> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<SettingRow[]>`
    INSERT INTO harness_shared.connected_app_access_settings (workspace_id, enabled, changed_at, changed_by)
    VALUES (${workspaceId}, ${enabled}, now(), ${changedBy})
    ON CONFLICT (workspace_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, changed_at = EXCLUDED.changed_at, changed_by = EXCLUDED.changed_by
    RETURNING workspace_id, enabled, changed_at, changed_by
  `);
  return settingOf(workspaceId, rows[0]);
}
