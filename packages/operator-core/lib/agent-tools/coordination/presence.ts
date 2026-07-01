/**
 * presence.ts — operator host adapter for the L1 liveness layer.
 *
 * The store implementation (upsert / heartbeat / delete / roster-join
 * over harness_shared.coord_presence + power_user_sessions) lives in
 * @papercusp/coordination/presence's PgPresenceStore; here we wire its
 * two host seams — the org PG handle and the table bootstrap — and keep
 * the original function surface so all callers + the /api/coord route
 * are unchanged.
 *
 * agent-coordination-architecture-v2 §4.2. Held locks are intentionally
 * NOT stored here — they live in the separate papercusp_su DB.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  PgPresenceStore,
  PRESENCE_STALE_MS,
  type PresenceInput,
  type PresenceRecord,
} from '@papercusp/coordination/presence';
import { deriveAgentRole, deriveFleetMembership, type AgentIdentity } from './identity';
import { writeSessionBrief } from '../../session-brief';
import {
  appendFleetMembershipEvent,
  appendFleetMembershipIfAbsent,
} from '../../fleet-membership-store';

export { PRESENCE_STALE_MS };
export type { PresenceInput, PresenceRecord };

const store = new PgPresenceStore({
  getSql: () => getOrgPg().sql,
  // Tables are defined by the migration baseline now; the host seam is a no-op.
  ensureSchema: async () => {},
});

/**
 * Upsert the caller's presence row — "set my presence to exactly this".
 * Always bumps heartbeat_at AND last_active_at (a declared write is genuine
 * activity, D-003). Resolves the populate-once scalars agentRole (D-004, from
 * the identity) + hiveSlug (from `harnessSlug` via hiveHomeSlugForHarness) when
 * the caller hasn't already set them. Omitted optional fields reset to defaults.
 */
export async function writePresence(
  identity: AgentIdentity,
  input: PresenceInput = {},
  harnessSlug?: string | null,
): Promise<void> {
  const agentRole = input.agentRole ?? deriveAgentRole(identity);
  let hiveSlug = input.hiveSlug ?? null;
  if (hiveSlug == null && harnessSlug) {
    try {
      const { hiveHomeSlugForHarness } = await import('../../hive-federation');
      hiveSlug = await hiveHomeSlugForHarness(identity.workspaceId ?? 'default', harnessSlug);
    } catch {
      hiveSlug = null; // best-effort: presence must write even if hive lookup fails
    }
  }
  await store.write(identity, { ...input, agentRole, hiveSlug });

  // Fleet membership (named-su-agent-fleets-2026-06-29 P-005): the SOFT presence label,
  // sourced from env at registration (PAPERCUSP_FLEET_SLUG / PAPERCUSP_FLEET_ROLE), the
  // per-agent mirror of hive_slug. The @papercusp/coordination store SELECT/INSERT does
  // not touch the fleet columns, so a follow-up FILL-IF-ABSENT update sets them here
  // (mig 407 added fleet_slug/fleet_role to coord_presence). COALESCE(existing, env)
  // means: the first declared write populates them, every later declare/heartbeat
  // PRESERVES them (like hive_slug's populate-once-then-keep), and a leader role a
  // handoff (P-007) promoted this row to is never clobbered back to the env default.
  // Only runs when the process actually carries a fleet, so non-fleet agents pay nothing.
  const { fleetSlug, fleetRole } = deriveFleetMembership();
  if (fleetSlug) {
    // WI-1345: membership is an APPEND-ONLY fact, never a direct coord_presence UPDATE
    // (a DB guard now rejects that). Populate-once: append the env-declared fleet fact
    // ONLY if this agent has no membership fact yet — the durable analog of the old
    // COALESCE(fleet_slug, env) "first write populates, later ones preserve" fill. A DB
    // projection trigger mirrors the fact onto the presence row (created by store.write
    // above), so the live fleet_slug label lands exactly as before.
    await appendFleetMembershipIfAbsent({
      workspaceId: identity.workspaceId ?? 'default',
      ownerId: identity.ownerId,
      ownerLabel: identity.ownerLabel,
      fleetSlug,
      fleetRole,
    });
  }

  // Spawned-bee fleet placement (fleet-color-schemes): a headless operator-spawn
  // bee's fleet can't ride the env-fold above (that reads the OPERATOR's env, not
  // the bee's), so fleet:spawn { fleet } registered a PENDING placement keyed by
  // the bee's spawnId. The row now exists (store.write above created/updated it),
  // so apply it as an authoritative hard-set, then it's cleared (one-shot). Only a
  // spawned bee with a pending placement pays anything.
  const pendingFleet = takePendingFleet(identity.ownerId);
  if (pendingFleet) {
    await setPresenceFleet(
      identity.workspaceId ?? 'default',
      identity.ownerId,
      pendingFleet.slug,
      pendingFleet.role,
    ).catch(() => {
      /* best-effort — a failed fleet stamp must never break the presence write */
    });
  }

  // WI-573 (honest-presence): a declared presence write is GENUINE activity — so if this owner's
  // adv_sessions row still carries a stale `ended_at` from a PRIOR incarnation (resumed via a path
  // that never re-POSTed bootstrap-su, e.g. harness compaction), clear it now so a LIVE agent never
  // reads as `ended`. Generalizes psu-launcher's `reportSessionResumed` (psu --resume only) to ANY
  // resume. Fully best-effort + idempotent (0-row no-op when already live); never affects the write
  // above or the brief below.
  try {
    const { reactivateAdvSessionByOwner } = await import('../../adv-sessions');
    await reactivateAdvSessionByOwner(identity.ownerId);
  } catch {
    /* best-effort: presence already wrote; honesty-reactivation must never block it */
  }

  // EI-1742: persist a durable successor brief on this write path so the agent's last
  // declared lane survives the coord_presence reaper sweep + abrupt session death
  // (a continuing session reads it instead of doing transcript archaeology). Fully
  // isolated/best-effort — never affects the presence write above.
  await writeSessionBrief(identity, {
    intent: input.intent,
    currentPlanSlug: input.currentPlanSlug,
    currentFiles: input.currentFiles,
    harnessSlug: harnessSlug ?? null,
    hiveSlug,
  });
}

/**
 * EXPLICIT named-fleet membership setter (named-su-agent-fleets-2026-06-29 P-004;
 * WI-1345 made it append-only).
 *
 * `writePresence`'s fleet fill-if-absent is populate-once-then-keep — it can NEVER
 * OVERWRITE a label, which is exactly what the fleet REGISTRY tools must do: promote the
 * caller to `leader` on create / take-leadership, demote a prior leader to `member`, set
 * `member` on join, or clear both on leave. They go through this AUTHORITATIVE path.
 *
 * WI-1345: canonical membership is an APPEND-ONLY fact (harness_shared.fleet_membership_events),
 * so this APPENDS the fact rather than UPDATE-ing coord_presence.fleet_slug directly (a DB
 * guard now rejects a direct write). The DB projection trigger mirrors the latest fact onto
 * the live presence row and re-materializes it after the reaper deletes the row on death, so
 * membership survives death instead of vanishing. Pass (null, null) to record a leave. The
 * live effect on the presence row is unchanged: the projection is a no-op when the owner has
 * no presence row (a dead prior-leader's live label is untouched — D-002 — though the durable
 * fact is still recorded). `sql?` threads a transaction (atomic leadership transfer) or a test
 * schema.
 */
export async function setPresenceFleet(
  workspaceId: string,
  ownerId: string,
  fleetSlug: string | null,
  fleetRole: string | null,
  sql?: Sql,
): Promise<void> {
  await appendFleetMembershipEvent({ workspaceId, ownerId, fleetSlug, fleetRole }, sql);
}

// ── Spawned-bee pending fleet placement (fleet-color-schemes) ────────────────
// `fleet:spawn { fleet }` cannot deliver a HEADLESS bee's fleet via env: the
// env-fold above (deriveFleetMembership) reads the OPERATOR's process.env, but the
// bee's PAPERCUSP_FLEET_SLUG lands on the BEE's process. operator-spawn instead
// registers the placement HERE — keyed by the bee's spawnId/ownerId, in the SAME
// operator process — and `writePresence` applies it on the bee's FIRST presence
// write (when its coord_presence row exists, so the hard-set sticks), then clears
// it. In-memory + one-shot: an operator restart in the (seconds-long) window before
// the bee's first heartbeat drops the placement — the bee stays ungrouped, a
// cosmetic miss, never a correctness bug.
const pendingFleetByOwner = new Map<string, { slug: string; role: string }>();

/** Register a pending fleet placement for a spawned bee (operator-spawn → here). */
export function setPendingFleet(ownerId: string, slug: string, role: string): void {
  if (ownerId && slug) pendingFleetByOwner.set(ownerId, { slug, role: role || 'member' });
}

/** Take (read + remove) a bee's pending fleet placement. One-shot. Exported for tests. */
export function takePendingFleet(ownerId: string): { slug: string; role: string } | null {
  const p = pendingFleetByOwner.get(ownerId);
  if (p) pendingFleetByOwner.delete(ownerId);
  return p ?? null;
}

/** Bump heartbeat_at ONLY — the keepalive path (the 60s supervisor beat). No-op
 *  if the row does not exist. NEVER bumps last_active_at (D-003). */
export async function touchHeartbeat(ownerId: string): Promise<void> {
  await store.touchHeartbeat(ownerId);
}

/** Bump last_active_at AND heartbeat_at — the ACTIVITY path (tool dispatch via
 *  dispatch-heartbeat). No-op if the row does not exist (D-003). */
export async function touchActivity(ownerId: string): Promise<void> {
  await store.touchActivity(ownerId);
}

/** Ensure a presence row + bump heartbeat WITHOUT clobbering a declared
 *  intent — the read-driven liveness signal (piggybacked on coord:inbox).
 *  Makes coord:presence a complete live roster of active agents. */
export async function heartbeatPresence(identity: AgentIdentity): Promise<void> {
  await store.heartbeat(identity);
}

/** Remove the caller's presence row — the session_shutdown path. */
export async function clearPresence(ownerId: string): Promise<void> {
  await store.clear(ownerId);
}

/** List presence records in deterministic ownerId order (P-005), optionally
 *  scoped to a workspace and/or a Hive (hiveSlug — the P-004 hive-scoped read). */
export async function listPresence(
  opts: { workspaceId?: string | null; hiveSlug?: string | null } = {},
): Promise<PresenceRecord[]> {
  return store.list(opts);
}

/** Read one presence record by owner id, or null. */
export async function getPresence(ownerId: string): Promise<PresenceRecord | null> {
  return store.get(ownerId);
}

/** Delete presence rows whose heartbeat is older than maxAgeMs (true dead
 *  sessions). Best-effort GC so the roster doesn't accumulate hundreds of
 *  long-ended rows. Returns rows removed. */
export async function sweepStalePresence(maxAgeMs: number): Promise<number> {
  return store.sweepStale(maxAgeMs);
}
