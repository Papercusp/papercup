/**
 * release-force-guard — WI-4198: `work_items:release force:true` is no longer an
 * unconditional bypass of the EI-7588 compare-and-release.
 *
 * Incident (2026-07-11 19:40Z, owner-confirmed): a fleet leader executing a
 * backlog-drain mandate force-released a LIVE, progressing claim held by an agent
 * OUTSIDE their fleet — mid-deploy — with no authority check, no liveness check,
 * no recorded reason, no audit row, and no notification to holder or owner. The
 * tool description said "leader/reaper override only", but that was unenforced
 * prose. This module makes it a checked contract:
 *
 *   force on ANOTHER agent's claim is allowed iff
 *     (a) the holder is NOT live (presence stale/absent AND no recent item
 *         progress — the reaper case), or
 *     (b) the caller has hive-level authority (queen pane), or
 *     (c) the caller LEADS THE HOLDER'S fleet (not merely *a* fleet — the
 *         incident actor led their own).
 *   A cross-holder force additionally REQUIRES a `reason`, writes a
 *   harness_shared.audit_log row, and notifies the holder + the owner.
 *
 * `classifyFleetControlInvoker`'s 'owner' grade (any su pane) deliberately does
 * NOT authorize: the incident actor was itself an su pane, and with ~dozens of
 * su agent sessions in this hive "is an su" distinguishes nothing. The
 * su-as-owner convention grants fleet control, not peer-claim seizure.
 *
 * The reaper's direct releaseWorkItem() lib path is intentionally unaffected —
 * this guard is tool-layer only.
 */
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';

export type ForceReleaseBasis = 'holder-not-live' | 'queen' | 'leads-holder-fleet';

export interface HolderLiveness {
  presenceFound: boolean;
  heartbeatAt: string | null;
  lastActiveAt: string | null;
  itemLastProgressAt: string | null;
  /** ms since the FRESHEST of the three signals; null when none parses. */
  freshestAgeMs: number | null;
  live: boolean;
}

export interface ForceReleaseVerdict {
  allowed: boolean;
  basis?: ForceReleaseBasis;
  holderLiveness: HolderLiveness;
}

export interface ForceReleaseDeps {
  getPresence?: (
    ownerId: string,
  ) => Promise<{ heartbeatAt: string; lastActiveAt: string | null; agentRole: string | null } | null>;
  latestFleetMembership?: (
    workspaceId: string,
    ownerId: string,
  ) => Promise<{ fleetSlug: string | null; fleetRole: string | null } | null>;
  getFleet?: (
    workspaceId: string,
    fleetSlug: string,
  ) => Promise<{ leaderOwnerId: string | null } | null>;
  now?: () => number;
}

/** PG timestamps arrive as `2026-07-11 16:38:41.614276-04` — normalize for Date.parse. */
function parseTs(v: unknown): number {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  const s = String(v);
  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return direct;
  return Date.parse(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
}

/**
 * Decide whether `callerOwnerId` may force-release `holderOwnerId`'s claim.
 * Never throws; a lookup failure degrades to "signal absent", which only ever
 * makes the guard STRICTER on authority (an unresolvable fleet grants nothing)
 * and looser on liveness only when every signal is genuinely missing.
 */
export async function assessForceRelease(
  input: {
    callerOwnerId: string;
    holderOwnerId: string;
    workspaceId: string;
    itemLastProgressAt: string | Date | null;
  },
  deps: ForceReleaseDeps = {},
): Promise<ForceReleaseVerdict> {
  const now = (deps.now ?? Date.now)();
  const getPresence =
    deps.getPresence ??
    (async (o: string) => (await import('../coordination/presence')).getPresence(o));
  const holderPres = await getPresence(input.holderOwnerId).catch(() => null);

  const signals = [
    holderPres ? parseTs(holderPres.heartbeatAt) : NaN,
    holderPres ? parseTs(holderPres.lastActiveAt) : NaN,
    parseTs(input.itemLastProgressAt),
  ].filter((t) => Number.isFinite(t));
  const freshest = signals.length ? Math.max(...signals) : null;
  const live = freshest != null && now - freshest < PRESENCE_STALE_MS;
  const holderLiveness: HolderLiveness = {
    presenceFound: holderPres != null,
    heartbeatAt: holderPres?.heartbeatAt ?? null,
    lastActiveAt: holderPres?.lastActiveAt ?? null,
    itemLastProgressAt:
      input.itemLastProgressAt == null ? null : String(input.itemLastProgressAt),
    freshestAgeMs: freshest == null ? null : now - freshest,
    live,
  };

  // (a) reaper case: no live session and no recent progress — the claim is abandoned.
  if (!live) return { allowed: true, basis: 'holder-not-live', holderLiveness };

  // Holder is LIVE — authority required. Classify the caller against the
  // HOLDER's fleet (control-core's classifier, per coord-authority-hardening).
  const [{ classifyFleetControlInvoker }, { classifyAgentPane }] = await Promise.all([
    import('../fleet_registry/control-core'),
    import('@papercusp/agent-mcp'),
  ]);
  const callerPres = await getPresence(input.callerOwnerId).catch(() => null);
  const paneKind = classifyAgentPane({
    role: callerPres?.agentRole ?? null,
    ownerId: input.callerOwnerId,
  }).kind;

  const membershipOf =
    deps.latestFleetMembership ??
    (async (ws: string, o: string) =>
      (await import('../../fleet-membership-store')).latestFleetMembership(ws, o));
  const fleetOf =
    deps.getFleet ??
    (async (ws: string, slug: string) => (await import('../../agent-fleets-store')).getFleet(ws, slug));

  const holderFleet =
    (await membershipOf(input.workspaceId, input.holderOwnerId).catch(() => null))?.fleetSlug ?? null;
  const leaderOwnerId = holderFleet
    ? ((await fleetOf(input.workspaceId, holderFleet).catch(() => null))?.leaderOwnerId ?? null)
    : null;

  const invokedAs = classifyFleetControlInvoker({
    callerOwnerId: input.callerOwnerId,
    leaderOwnerId,
    paneKind,
  });
  if (invokedAs === 'leader') return { allowed: true, basis: 'leads-holder-fleet', holderLiveness };
  if (invokedAs === 'queen') return { allowed: true, basis: 'queen', holderLiveness };
  return { allowed: false, holderLiveness };
}

/** The refusal names what WOULD authorize — so the caller coordinates instead of retrying blind. */
export function forceRefusalHint(holder: string): string {
  return (
    `${holder} holds a LIVE claim (fresh presence/progress) and you have no authority over it — force refused (WI-4198). ` +
    `What authorizes a force here: the holder's session going stale (reaper case), queen/hive authority, or leading ${holder}'s OWN fleet. ` +
    `Otherwise coordinate with the holder (coord:send) — or with their fleet leader — instead of forcing.`
  );
}

/** Forensic audit row — mirrors release/deploy.ts's canonical full-column shape.
 *  Fire-and-forget; never throws (the release already happened). */
export async function recordForceReleaseAudit(
  actor: string,
  itemId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../workspace-registry'),
    ]);
    const { sql } = getOrgPg();
    const id = `wi-force-release-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, 'work_items:release:force', itemId, JSON.stringify(details), activeWorkspaceId()],
    );
  } catch (err) {
    console.warn('[work_items:release] force audit write failed:', (err as Error)?.message);
  }
}

/** Notify the displaced holder (coord inbox — read on resume even if dead now)
 *  and the owner (attention channel). Never throws. */
export async function notifyForceRelease(
  ident: { ownerId: string },
  input: {
    itemId: string;
    holder: string;
    basis: ForceReleaseBasis;
    reason: string;
    harness?: string | null;
  },
): Promise<void> {
  try {
    const { sendMessage } = await import('../coordination/messages');
    await sendMessage(ident as never, {
      to: [input.holder],
      summary: `⚠ Your claim on ${input.itemId} was FORCE-RELEASED by ${ident.ownerId} (basis: ${input.basis}) — ${input.reason.slice(0, 140)}`,
      harnessSlug: input.harness ?? undefined,
      extra: { auto: true, lifecycle: 'force_release', work_item: input.itemId, basis: input.basis },
    });
  } catch (err) {
    console.warn('[work_items:release] force holder-notify failed:', (err as Error)?.message);
  }
  try {
    const { notifyAttention } = await import('../../attention-notify');
    await notifyAttention({
      kind: 'intervention',
      title: `work_items:release force — ${input.itemId}`,
      body: `${ident.ownerId} force-released ${input.holder}'s claim on ${input.itemId} (basis: ${input.basis}): ${input.reason}`,
      importance: 'high',
      harnessSlug: input.harness ?? undefined,
      data: { workItem: input.itemId, holder: input.holder, basis: input.basis },
    });
  } catch (err) {
    console.warn('[work_items:release] force owner-notify failed:', (err as Error)?.message);
  }
}
