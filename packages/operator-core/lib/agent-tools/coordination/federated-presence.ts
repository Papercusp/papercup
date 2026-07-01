/**
 * federated-presence — surface the CROSS-MACHINE presence roster
 * (`harness_shared.shared_presence`) alongside the local per-session
 * `coord_presence`, so `coord:presence` is ONE unified roster (Phase 0.3 of
 * distributed-coordination-shared-harness-2026-06-04, D-007).
 *
 * Two presence systems exist (see the plan): `coord_presence` is the LOCAL,
 * per-session agent roster (su-<uuid>, with intent/files/plan) this machine
 * writes + heartbeats; `shared_presence` is the FEDERATED, per-(user,machine)
 * roster the Model-B peer-log projects from remote peers' announces. This module
 * reads the federated side + maps each peer to a `PresenceRecord`-compatible row
 * so the coord:presence tool can merge both into one "who is here, on which
 * machine, doing what" view.
 *
 * ADDITIVE: the local roster is unchanged. On a single box with no federated
 * peers (shared_presence empty — the current dev reality), this contributes
 * nothing; it lights up when real peers announce. Per-USER aggregation ("Avi is
 * here on 2 machines") is a display concern — group the records by `userId`.
 */

import { getOrgPg } from '@papercusp/db-org';
import { PRESENCE_STALE_MS, type PresenceRecord } from '@papercusp/coordination/presence';

/** A presence record that may originate from the federated swarm. Extends the
 *  local PresenceRecord with the federation-only attributes. */
export interface UnifiedPresenceRecord extends PresenceRecord {
  /** True for a row sourced from shared_presence (a remote peer). */
  federated?: boolean;
  /** The peer's device pubkey (federation identity). */
  devicePubkey?: string;
  /** The harness the peer is present in (shared_presence is per-harness). */
  harnessSlug?: string;
  /** The peer's current view (the federated analogue of currentPlanSlug). */
  currentView?: string | null;
}

interface SharedPresenceDbRow {
  workspace_id: string;
  harness_slug: string;
  hive_slug: string | null;
  github_user_id: number;
  machine_label: string;
  device_pubkey: string;
  intent: string | null;
  current_view: string | null;
  last_seen_ms: number;
}

export interface FederatedPresenceOpts {
  workspaceId?: string | null;
  /** Restrict to one harness (shared_presence is per-harness). */
  harnessSlug?: string | null;
  /** Restrict to one Hive (shared_presence is hive-keyed, mig 187) — the P-004
   *  hive-scoped read's federated leg. */
  hiveSlug?: string | null;
  /** Staleness window — a peer not seen within it is `stale`. Default = PRESENCE_STALE_MS. */
  staleMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Map one shared_presence row to a unified presence record. Pure — the synthetic
 * `ownerId` (`fed:<gh>@<machine>`) is distinct from any local su-<uuid> so the
 * two rosters never collide on merge.
 */
export function mapSharedPresenceRow(
  row: SharedPresenceDbRow,
  ctx: { now: number; staleMs: number },
): UnifiedPresenceRecord {
  const iso = new Date(row.last_seen_ms).toISOString();
  return {
    ownerId: `fed:${row.github_user_id}@${row.machine_label}`,
    ownerLabel: `gh:${row.github_user_id} · ${row.machine_label}`,
    workspaceId: row.workspace_id,
    source: 'federated',
    intent: row.intent ?? '',
    currentPlanSlug: null,
    currentFiles: [],
    host: row.machine_label,
    pid: null,
    startedAt: iso,
    heartbeatAt: iso,
    // A federated peer reports only last_seen (heartbeat-equivalent) — we don't
    // get its activity/keepalive split or role, so those stay null at the
    // federation boundary. hive_slug IS available (shared_presence is hive-keyed,
    // mig 187) — it's the federated leg of the P-004 hive-scoped read.
    lastActiveAt: null,
    agentRole: null,
    hiveSlug: row.hive_slug,
    stale: row.last_seen_ms < ctx.now - ctx.staleMs,
    userId: String(row.github_user_id),
    revoked: false,
    federated: true,
    devicePubkey: row.device_pubkey,
    harnessSlug: row.harness_slug,
    currentView: row.current_view,
  };
}

/**
 * The canonical shared_presence query, parameterized on `sql` so it runs against
 * the live org PG OR a test schema.
 */
export async function queryFederatedPresenceRows(
  sql: { <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> },
  opts: { workspaceId?: string | null; harnessSlug?: string | null; hiveSlug?: string | null } = {},
): Promise<SharedPresenceDbRow[]> {
  const rows = (await sql`
    SELECT workspace_id, harness_slug, hive_slug, github_user_id, machine_label, device_pubkey,
           intent, current_view,
           (extract(epoch FROM last_seen_at) * 1000)::bigint AS last_seen_ms
    FROM harness_shared.shared_presence
    WHERE device_pubkey <> ''
  `) as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({
      workspace_id: String(r.workspace_id ?? ''),
      harness_slug: String(r.harness_slug ?? ''),
      hive_slug: r.hive_slug == null ? null : String(r.hive_slug),
      github_user_id: Number(r.github_user_id),
      machine_label: String(r.machine_label ?? ''),
      device_pubkey: String(r.device_pubkey ?? ''),
      intent: r.intent == null ? null : String(r.intent),
      current_view: r.current_view == null ? null : String(r.current_view),
      last_seen_ms: Number(r.last_seen_ms),
    }))
    .filter((r) => (opts.workspaceId ? r.workspace_id === opts.workspaceId : true))
    .filter((r) => (opts.harnessSlug ? r.harness_slug === opts.harnessSlug : true))
    .filter((r) => (opts.hiveSlug ? r.hive_slug === opts.hiveSlug : true));
}

/**
 * Map one shared_session_presence row (P-006) to a unified record carrying the
 * session's REAL ownerId — the row P-007's recipient resolver admits, so a
 * remote su-<uuid>/bee is addressable exactly like a local one. Pure.
 */
export function mapSessionPresenceRow(
  row: SessionPresenceRowOut,
  ctx: { now: number; staleMs: number },
): UnifiedPresenceRecord {
  const iso = new Date(row.last_seen_ms).toISOString();
  return {
    ownerId: row.owner_id,
    ownerLabel: `${row.kind} · ${row.owner_id.slice(0, 8)} @ ${row.machine_label}`,
    workspaceId: row.workspace_id,
    source: 'federated',
    intent: row.intent ?? '',
    currentPlanSlug: row.plan_slug,
    currentFiles: [],
    host: row.machine_label,
    pid: null,
    startedAt: iso,
    heartbeatAt: iso,
    lastActiveAt: iso,
    agentRole: row.kind,
    hiveSlug: row.hive_slug,
    stale: row.last_seen_ms < ctx.now - ctx.staleMs,
    userId: String(row.github_user_id),
    revoked: false,
    federated: true,
    remoteSession: true,
    machineLabel: row.machine_label,
    devicePubkey: row.device_pubkey,
    harnessSlug: row.harness_slug,
    currentView: null,
  };
}

/**
 * List the federated (cross-machine) presence peers as unified records. Returns
 * [] when shared_presence is empty (single box). Best-effort — a query error
 * yields [] so the local roster always renders.
 */
export async function listFederatedPresence(
  opts: FederatedPresenceOpts = {},
): Promise<UnifiedPresenceRecord[]> {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? PRESENCE_STALE_MS;
  let rows: SharedPresenceDbRow[];
  try {
    const { sql } = getOrgPg();
    rows = await queryFederatedPresenceRows(sql as never, opts);
  } catch {
    return [];
  }
  const nowMs = now();
  const machineRows = rows.map((r) => mapSharedPresenceRow(r, { now: nowMs, staleMs }));
  // P-006: the SESSION-GRAIN leg — remote agents as first-class rows with their
  // real ownerIds (shared_session_presence, gossip-fed). Best-effort: a query
  // error (e.g. mig 434 not yet applied) degrades to machine rows only. A wide
  // read window (4x stale) keeps rows visible-but-stale rather than vanishing
  // at the exact staleness boundary the flag/badge logic uses.
  let sessionRows: UnifiedPresenceRecord[] = [];
  if (opts.workspaceId) {
    try {
      const sessions = await listLiveSessionPresence({
        workspaceId: opts.workspaceId,
        hiveSlug: opts.hiveSlug ?? null,
        staleMs: staleMs * 4,
        nowMs,
      });
      sessionRows = sessions.map((s) => mapSessionPresenceRow(s, { now: nowMs, staleMs }));
    } catch {
      sessionRows = [];
    }
  }
  return [...machineRows, ...sessionRows];
}
