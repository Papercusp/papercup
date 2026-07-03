/**
 * session-presence-store — the `harness_shared.shared_session_presence` writer
 * + TTL reader (cross-machine-coord-parity-and-trust-2026-07-01 P-005, mig 434).
 *
 * GOSSIP-ONLY surface: written by presence-gossip 'sessions' frames (remote
 * devices) and by the local announcer's self-apply (so this machine sees its
 * own sessions through the same table the roster merges). Never rides the
 * peer-log (plan D-002 — beats must not be immortalized).
 *
 * FULL-SET REPLACE semantics: one frame carries a device's WHOLE current
 * session set, so applying it upserts every entry and deletes the device's
 * rows NOT in the set — self-healing against missed frames, no per-session
 * tombstones needed. A stale frame (frameTs older than a device row's
 * last_seen_at) never regresses newer state: upserts are last_seen_at-guarded
 * and the not-in-set delete only removes rows older than the frame.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { SessionPresenceEntry } from './presence-gossip';

export interface ApplySessionSetInput {
  workspaceId: string;
  devicePubkey: string;
  githubUserId: number;
  machineLabel: string;
  hiveSlug: string | null;
  sessions: SessionPresenceEntry[];
  /** The frame's ts (epoch ms) — the set's coherence point. */
  frameTs: number;
}

/** Replace one device's session-presence set (upsert entries + drop absentees). */
export async function applySessionPresenceSet(
  input: ApplySessionSetInput,
  sqlIn?: postgres.Sql,
): Promise<void> {
  const sql = sqlIn ?? getOrgPg().sql;
  const keep: string[] = [];
  for (const s of input.sessions) {
    keep.push(s.owner_id);
    await sql`
      INSERT INTO harness_shared.shared_session_presence
        (workspace_id, hive_slug, harness_slug, owner_id, kind, intent, plan_slug,
         github_user_id, machine_label, device_pubkey, last_seen_at, schema_version,
         fleet_slug, fleet_role)
      VALUES
        (${input.workspaceId}, ${input.hiveSlug}, ${s.harness_slug}, ${s.owner_id},
         ${s.kind}, ${s.intent}, ${s.plan_slug}, ${input.githubUserId},
         ${input.machineLabel}, ${input.devicePubkey},
         to_timestamp(${input.frameTs} / 1000.0), 1,
         ${s.fleet_slug ?? null}, ${s.fleet_role ?? null})
      ON CONFLICT (workspace_id, owner_id, machine_label) DO UPDATE SET
        hive_slug = EXCLUDED.hive_slug,
        harness_slug = EXCLUDED.harness_slug,
        kind = EXCLUDED.kind,
        intent = EXCLUDED.intent,
        plan_slug = EXCLUDED.plan_slug,
        github_user_id = EXCLUDED.github_user_id,
        device_pubkey = EXCLUDED.device_pubkey,
        last_seen_at = EXCLUDED.last_seen_at,
        fleet_slug = EXCLUDED.fleet_slug,
        fleet_role = EXCLUDED.fleet_role
      -- Never regress a newer beat with an out-of-order stale frame.
      WHERE shared_session_presence.last_seen_at <= EXCLUDED.last_seen_at
    `;
  }
  // Drop this device's rows absent from the set — but only rows OLDER than the
  // frame (an out-of-order stale frame must not delete a newer session row).
  // An empty set clears everything older ("all my agents ended").
  if (keep.length > 0) {
    await sql`
      DELETE FROM harness_shared.shared_session_presence
      WHERE workspace_id = ${input.workspaceId}
        AND device_pubkey = ${input.devicePubkey}
        AND machine_label = ${input.machineLabel}
        AND last_seen_at <= to_timestamp(${input.frameTs} / 1000.0)
        AND owner_id NOT IN ${sql(keep)}
    `;
  } else {
    await sql`
      DELETE FROM harness_shared.shared_session_presence
      WHERE workspace_id = ${input.workspaceId}
        AND device_pubkey = ${input.devicePubkey}
        AND machine_label = ${input.machineLabel}
        AND last_seen_at <= to_timestamp(${input.frameTs} / 1000.0)
    `;
  }
}

export interface SessionPresenceRowOut {
  workspace_id: string;
  hive_slug: string | null;
  harness_slug: string;
  owner_id: string;
  kind: string;
  intent: string | null;
  plan_slug: string | null;
  github_user_id: number;
  machine_label: string;
  device_pubkey: string;
  /** epoch ms */
  last_seen_ms: number;
  /** The remote session's named-fleet membership (mig 479, P-301). Null for a
   *  session in no fleet / a pre-mig-479 frame. */
  fleet_slug?: string | null;
  fleet_role?: string | null;
}

/** Live (within staleMs) session-presence rows, optionally hive-scoped —
 *  the unified roster's federated session leg (P-006). */
export async function listLiveSessionPresence(
  opts: { workspaceId: string; hiveSlug?: string | null; staleMs: number; nowMs?: number },
  sqlIn?: postgres.Sql,
): Promise<SessionPresenceRowOut[]> {
  const sql = sqlIn ?? getOrgPg().sql;
  const now = opts.nowMs ?? Date.now();
  const floor = new Date(now - opts.staleMs);
  const rows = await sql<
    Array<Omit<SessionPresenceRowOut, 'last_seen_ms'> & { last_seen_at: Date }>
  >`
    SELECT workspace_id, hive_slug, harness_slug, owner_id, kind, intent, plan_slug,
           github_user_id, machine_label, device_pubkey, last_seen_at
    FROM harness_shared.shared_session_presence
    WHERE workspace_id = ${opts.workspaceId}
      AND last_seen_at > ${floor}
      ${opts.hiveSlug ? sql`AND hive_slug = ${opts.hiveSlug}` : sql``}
    ORDER BY last_seen_at DESC
  `;
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    hive_slug: r.hive_slug,
    harness_slug: r.harness_slug,
    owner_id: r.owner_id,
    kind: r.kind,
    intent: r.intent,
    plan_slug: r.plan_slug,
    github_user_id: Number(r.github_user_id),
    machine_label: r.machine_label,
    device_pubkey: r.device_pubkey,
    last_seen_ms: new Date(r.last_seen_at).getTime(),
  }));
}
