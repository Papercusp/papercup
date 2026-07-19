/**
 * set-compaction-limit-core — the shared CROSS-SESSION compaction-limit setter
 * (per-member-declarative-launch-specs P-006, owner directive 2026-07-19). A fleet
 * LEADER (or the queen / owner) sets a MEMBER's soft compaction limit DIRECTLY,
 * instead of dispatching "set your own limit" and hoping the member complies on its
 * next wake. Reused by config:set-compaction-limit (with a target `ownerId`) AND by
 * fleet:reconfigure-member (P-007 — D-003 runtime-adjustable settings).
 *
 * Auth reuses control-core's `classifyFleetControlInvoker` (one auth model, not a
 * fork): the caller must be the recorded leader of the fleet the TARGET belongs to,
 * the queen (mug|kettle pane), or the owner (su pane). The limit is clamped to the
 * TARGET's model-spec + fleet-role ceiling (a member's 300k [1m] cap, a leader's
 * 400k) — NEVER the caller's, since the caller and target can differ in both.
 */
import { classifyAgentPane } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import { setCompactionLimit, getPresence } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { resolveModelSpecForOwner } from '../../compaction-usage';
import { clampCompactionLimit, defaultCompactionLimitForSpec } from '../../agent-config-constants';
import { classifyFleetControlInvoker } from '../fleet_registry/fleet-auth';
import { resolveFleetCaller } from '../fleet_registry/_shared';
import type { ResolveIdentityCtx } from '../coordination/identity';

export interface CrossSessionLimitResult {
  ok: boolean;
  /** The session whose limit was (attempted to be) set. */
  targetOwnerId: string;
  /** The limit now stored for the target (null when no presence row persisted it). */
  compactionLimit?: number | null;
  /** The clamp ceiling used (the TARGET's spec + role default). */
  cap?: number;
  /** True + requested/note when the requested limit was clamped down to the cap. */
  clamped?: boolean;
  requested?: number;
  /** The target's fleet (null when the target is in no fleet). */
  fleet?: string | null;
  /** The target's fleet role, which selects the 300k member vs 400k leader ceiling. */
  targetRole?: string | null;
  /** How the caller was authorized. */
  invokedAs?: 'leader' | 'queen' | 'owner';
  error?: string;
  message?: string;
  note?: string;
}

/**
 * Set `targetOwnerId`'s soft compaction limit to `limit` (clamped to the target's
 * ceiling), authorized as the target's fleet leader / queen / owner. Best-effort on
 * the read-backs; the setCompactionLimit write is the authoritative effect.
 */
export async function setCompactionLimitForOwner(
  ctx: ResolveIdentityCtx,
  targetOwnerId: string,
  limit: number,
): Promise<CrossSessionLimitResult> {
  const { ownerId: callerId, workspaceId } = resolveFleetCaller(ctx);

  // 1. Resolve the TARGET's fleet membership (slug + role) — a separate read from
  //    the presence row (mirrors take-leadership-core / control-core).
  const targetFleet = (await fetchPresenceFleet([targetOwnerId]).catch(() => new Map())).get(
    targetOwnerId,
  );
  const fleetSlug: string | null = targetFleet?.fleetSlug ?? null;
  const targetRole: string | null = targetFleet?.fleetRole ?? null;

  // 2. GUARD — reuse the fleet-control auth classifier: leader of the TARGET's fleet,
  //    or queen (mug|kettle), or owner (su). A fleetless target has no leader, so only
  //    queen/owner can set it. Caller pane derives from live presence, never self-asserted.
  const fleet = fleetSlug ? await getFleet(workspaceId, fleetSlug).catch(() => null) : null;
  let paneKind = 'unknown';
  try {
    const pres = await getPresence(callerId).catch(() => null);
    paneKind = classifyAgentPane({ role: pres?.agentRole ?? null, ownerId: callerId }).kind;
  } catch {
    paneKind = classifyAgentPane({ role: null, ownerId: callerId }).kind;
  }
  const invokedAs = classifyFleetControlInvoker({
    callerOwnerId: callerId,
    leaderOwnerId: fleet?.leaderOwnerId ?? null,
    paneKind,
  });
  if (!invokedAs) {
    return {
      ok: false,
      targetOwnerId,
      fleet: fleetSlug,
      targetRole,
      error: 'not_authorized',
      message:
        `Setting ${targetOwnerId}'s compaction limit is restricted to the leader of its fleet ` +
        `(${fleet?.leaderOwnerId ?? (fleetSlug ? 'none recorded' : 'target is in no fleet')}), the ` +
        `queen, or the owner (an su session) — you are ${paneKind} (${callerId}). Ask that fleet's ` +
        `leader, or have the member run config:set-compaction-limit itself.`,
    };
  }

  // 3. Clamp to the TARGET's model-spec + role ceiling (a member's leaner [1m] cap when
  //    the target is a non-leader fleet member), then persist.
  const spec = await resolveModelSpecForOwner(targetOwnerId).catch(() => null);
  const fleetMember = targetRole != null && targetRole !== 'leader';
  const cap = defaultCompactionLimitForSpec(spec, { fleetMember });
  const applied = clampCompactionLimit(limit, spec, { fleetMember });
  await setCompactionLimit(targetOwnerId, applied);
  const after = await getPresence(targetOwnerId).catch(() => null);
  const persisted = after?.compactionLimit ?? null;

  return {
    ok: persisted != null,
    targetOwnerId,
    compactionLimit: persisted,
    cap,
    fleet: fleetSlug,
    targetRole,
    invokedAs,
    ...(applied !== limit
      ? {
          clamped: true,
          requested: limit,
          note: `requested limit clamped to the target's ${fleetMember ? 'fleet-member ' : ''}model-derived ceiling (${spec ?? 'unresolvable spec → fleet-default [1m]'})`,
        }
      : {}),
    ...(persisted == null
      ? { note: `no live presence row for ${targetOwnerId} — limit not persisted (it may have ended)` }
      : {}),
  };
}
