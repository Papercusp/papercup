/**
 * Persistence for paired mobile devices and their push tokens.
 *
 * Goes through `withWorkspace()` so RLS on harness_shared.mobile_devices
 * actually enforces the workspace boundary; app-role connections without
 * the GUC bypass it (canonical Drizzle/Knex RLS regression — see
 * spec/workspace-scoping).
 */
import { withWorkspace, getOrgPg } from '@papercusp/db-org';

export interface DeviceRow {
  device_id: string;
  user_email: string;
  workspace_id: string;
  device_kind: 'mobile';
  device_label: string | null;
  paired_at: Date;
  last_seen: Date | null;
  revoked_at: Date | null;
}

export interface PushTokenRow {
  device_id: string;
  platform: 'apns' | 'fcm';
  token: string;
  registered_at: Date;
}

export async function insertDevice(opts: {
  deviceId: string;
  userEmail: string;
  workspaceId: string;
  deviceLabel?: string;
}): Promise<void> {
  await withWorkspace(opts.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.mobile_devices
        (device_id, user_email, workspace_id, device_label, paired_at)
      VALUES (${opts.deviceId}, ${opts.userEmail}, ${opts.workspaceId}, ${opts.deviceLabel ?? null}, now())
      ON CONFLICT (device_id) DO NOTHING
    `;
  });
}

export async function listDevices(workspaceId: string): Promise<DeviceRow[]> {
  return withWorkspace(workspaceId, async (tx) => {
    return tx<DeviceRow[]>`
      SELECT device_id, user_email, workspace_id, device_kind, device_label,
             paired_at, last_seen, revoked_at
      FROM harness_shared.mobile_devices
      WHERE revoked_at IS NULL
      ORDER BY paired_at DESC
    `;
  });
}

export async function touchLastSeen(deviceId: string, workspaceId: string): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.mobile_devices
      SET last_seen = now()
      WHERE device_id = ${deviceId}
    `;
  });
}

export async function revokeDevice(deviceId: string, workspaceId: string): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.mobile_devices
      SET revoked_at = now()
      WHERE device_id = ${deviceId}
    `;
  });
}

export async function isRevoked(deviceId: string): Promise<boolean> {
  // Read without workspace context — the auth middleware needs to check
  // before knowing which workspace the device belongs to. Uses admin role.
  const { sql } = getOrgPg();
  const rows = await sql<{ revoked_at: Date | null }[]>`
    SELECT revoked_at FROM harness_shared.mobile_devices WHERE device_id = ${deviceId} LIMIT 1
  `;
  if (rows.length === 0) return true; // unknown device → treat as revoked
  return rows[0].revoked_at != null;
}

/**
 * Every paired device across all workspaces — for the desktop "Manage
 * paired devices" panel. Admin role, no workspace GUC (same pattern as
 * `isRevoked`): a local Papercup install is single-user, so the desktop
 * legitimately sees every paired phone, and it has no device JWT to
 * scope by.
 */
export async function listAllDevices(): Promise<DeviceRow[]> {
  const { sql } = getOrgPg();
  return sql<DeviceRow[]>`
    SELECT device_id, user_email, workspace_id, device_kind, device_label,
           paired_at, last_seen, revoked_at
    FROM harness_shared.mobile_devices
    WHERE revoked_at IS NULL
    ORDER BY paired_at DESC
  `;
}

/**
 * Revoke a device by id alone — for the desktop revoke flow, which holds
 * the device id but no workspace context. `device_id` is globally unique
 * (PK — see the `ON CONFLICT (device_id)` in `insertDevice`); the
 * workspace-scoped `revokeDevice` is the phone-facing path.
 */
export async function revokeDeviceById(deviceId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.mobile_devices
    SET revoked_at = now()
    WHERE device_id = ${deviceId}
  `;
}

export async function upsertPushToken(opts: {
  deviceId: string;
  workspaceId: string;
  platform: 'apns' | 'fcm';
  token: string;
}): Promise<void> {
  await withWorkspace(opts.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.mobile_push_tokens (device_id, platform, token, registered_at)
      VALUES (${opts.deviceId}, ${opts.platform}, ${opts.token}, now())
      ON CONFLICT (device_id, platform)
      DO UPDATE SET token = EXCLUDED.token, registered_at = EXCLUDED.registered_at
    `;
  });
}

/** Push targets for everyone in a workspace (used by the dispatcher). */
export async function pushTargetsForWorkspace(
  workspaceId: string,
): Promise<Array<{ platform: 'apns' | 'fcm'; token: string }>> {
  return withWorkspace(workspaceId, async (tx) => {
    return tx<{ platform: 'apns' | 'fcm'; token: string }[]>`
      SELECT t.platform, t.token
      FROM harness_shared.mobile_push_tokens t
      JOIN harness_shared.mobile_devices d ON d.device_id = t.device_id
      WHERE d.revoked_at IS NULL
    `;
  });
}
