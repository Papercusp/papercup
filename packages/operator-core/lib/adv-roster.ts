/**
 * adv-roster.ts — the live "who's active, on what" roster for the /adv
 * Sessions view (plan adv-sessions-live-roster-2026-06-02, P-002).
 *
 * coord_presence is the PRIMARY roster: every active psu agent heartbeats on
 * each tool call (commit d33d07837), so it carries liveness + intent +
 * current_files for the whole fleet — plan-tied and ad-hoc alike. adv_sessions
 * is the ENRICHMENT (plan/role/feature + terminal handles for Focus/Resume),
 * LEFT-joined on coord_owner_id = coord_presence.owner_id (D-001/D-002). An
 * agent with no adv_sessions row (a plain SU shell) still appears; a plan-tied
 * one gets the richer metadata.
 *
 * The DB I/O is a thin wrapper (`mergeRoster`); the merge + liveness logic is
 * pure (`mergeRosterEntries` / `deriveLiveness`) so it unit-tests without PG
 * and without a real clock (now is injected).
 */

import os from 'node:os';
import { isSpawnProcessAlive } from './fleet/spawn-reclaim';
import { listPresence, type PresenceRecord } from './agent-tools/coordination/presence';
import { advSessionsByCoordOwner, type AdvSessionRow } from './adv-sessions';
import { deriveLiveness, LIVE_MS, type Liveness } from './liveness';
import {
  claimsByAgent,
  listFleetAssignments,
  orphanedClaims,
  summarizeOrphan,
  type AgentClaim,
  type OrphanedClaimSummary,
} from './fleet/assignments';
// fleet-color-schemes #3: the per-agent fleet label rides on coord_presence
// (fetchPresenceFleet, a soft label not on PresenceRecord), and the fleet's bound
// scheme resolves the colored group header the pui Fleet tab draws.
import { fetchPresenceFleet } from './agent-tools/coordination/presence-fleet';
import { getFleetScheme } from './agent-fleets-store';
// hive-agent-tabs-psu-tui P-001: the shared pane-kind taxonomy (one source of
// truth) — stamp each roster entry so pui renders/colors per type.
import { classifyAgentPane, type AgentPaneKind, type DriveMode } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import {
  nativeSessionHandleForAdvSession,
  nativeSessionHandleForSpawnedAgent,
  type NativeSessionHandle,
} from './native-session-handles';
import { resolveSpawnBackendModel } from './harness-invoke-once';
import {
  getAllWakeModeOverrides,
  getDefaultWakeMode,
  resolveWakeModeFrom,
  type WakeMode,
} from './agent-tools/coordination/wake-mode';
import { countAllPendingWakes } from './agent-tools/coordination/pending-wakes';

export type { AgentClaim, OrphanedClaimSummary };

// Re-export the liveness primitives (now sourced from the dep-free leaf so the
// client presence UI can share them) for existing importers.
export { deriveLiveness, LIVE_MS };
export type { Liveness };

/**
 * Drop ended adv_sessions whose coord owner is still live in the active
 * roster — that agent is already shown (with richer presence), so listing its
 * ended terminal row too would double-count it. Rows with no coord_owner_id
 * (console/legacy) can't collide, so they always pass. Pure → unit-tested.
 */
export function dedupeEndedAgainstActive(
  ended: AdvSessionRow[],
  active: { ownerId: string }[],
): AdvSessionRow[] {
  const liveOwners = new Set(active.map((a) => a.ownerId));
  return ended.filter((r) => !r.coordOwnerId || !liveOwners.has(r.coordOwnerId));
}

/** A presence row whose workspace is '*' is workspace-agnostic (an unscoped
 *  SU/engineer shell) — it belongs to every workspace's roster. */
export const GLOBAL_WORKSPACE = '*';

/** One agent in the live roster: presence (primary) + adv_sessions enrichment. */
export interface RosterEntry {
  // ── presence (always present — the primary roster) ──
  ownerId: string;
  label: string;
  /** client/source: claude · codex · omp · … */
  source: string;
  intent: string;
  currentFiles: string[];
  host: string;
  pid: number | null;
  startedAt: string;
  heartbeatAt: string;
  /** Genuine-activity timestamp (coord_presence.last_active_at, mig 277) — bumped
   *  ONLY by real tool dispatch, NOT the 60s keepalive. The "since last turn" clock
   *  and the basis for activity-liveness. null when the row predates its first activity. */
  lastActiveAt: string | null;
  liveness: Liveness;
  /** The coord-store's own stale flag (heartbeat older than PRESENCE_STALE_MS). */
  stale: boolean;
  /** Whether an engine LOOP is armed for this agent (an active harness_shared.routines
   *  loop row targeting this ownerId). A loop-armed agent counts as "live" (it keeps
   *  working on a cadence) even when its presence has gone idle between wakes. */
  loopArmed: boolean;
  workspaceId: string;
  userId: string | null;
  revoked: boolean;
  /**
   * Is the OS process still alive? true/false only for same-host non-stale
   * entries we could check; null = unknown (different host, no pid, or stale).
   * A non-stale entry with pidAlive===false is a "zombie": fresh heartbeat but
   * the process is gone (P-008).
   */
  pidAlive: boolean | null;
  /** Nursery stream activity for spawned bees (P-008/P-013): ISO time of the
   *  last observed child output chunk; null for interactive sessions / no
   *  output yet. Fresh = generating right now, even with stale presence. */
  lastOutputAt: string | null;
  // ── canonical assignment enrichment (fleet_assignment view, state-not-chat-
  //    fleet-state D-002): what this agent actually HOLDS — plan-item claims,
  //    work-item claims, durable assignments. The roster reads the one canonical
  //    view instead of re-deriving claims per surface. ──
  claims: AgentClaim[];
  /** The declared-but-unclaimed smell (claim-discipline-enforcement-2026-06-10):
   *  a declared plan none of the agent's claims back — same semantics as the
   *  fleet_assignment view's flag. The colony roster renders it as a ⚠ so an
   *  "active" agent with no claimed lane is visibly different from a claimed one. */
  declaredUnclaimed: boolean;
  // ── adv_sessions enrichment (null when no joinable launch row) ──
  hasLaunchRecord: boolean;
  advSessionId: number | null;
  /** Live plan (presence) preferred; falls back to the launch-time plan. */
  currentPlanSlug: string | null;
  role: string | null;
  feature: string | null;
  agent: string | null;
  mode: 'omp' | 'console' | null;
  windowId: string | null;
  ompThreadId: string | null;
  cwd: string | null;
  launchStartedAt: string | null;
  // ── reactive workbench-pane hints (pui-reactive-session-panes D-002/D-006) ──
  /** 'workbench' on a PENDING launch the pui should reactively open a pane for;
   *  null on a normal presence/launch row. The pui panes only these. */
  display: string | null;
  /** The argv the pui pane runs for a pending workbench launch; [] otherwise. */
  launchArgv: string[];
  // ── agent pane-kind (hive-agent-tabs-psu-tui P-001) ──
  /** The dock pane kind classified from role/launch (queen|bee|sentinel|planner).
   *  One source of truth so pui renders + colors per type without re-deriving. */
  agentPaneKind: AgentPaneKind;
  /** The DEFAULT drive mode for the kind (auto|responsive). The per-agent wake
   *  mode (D-005) can still flip an `auto` agent to manual at runtime. */
  driveMode: DriveMode;
  /** The agent's native claude session id (mig 203 `spawned_agents.session_id`)
   *  when it's a claude bee — the `claude --resume <id>` handle for the bee pane
   *  (P-004). null for non-bee / omp / pre-flag / pending entries. */
  sessionId: string | null;
  /** Backend-neutral native session handle for attach/resume surfaces. The
   * legacy `sessionId` remains for Claude callers; this exposes Codex CODEX_HOME
   * and OMP thread semantics through the same contract. */
  nativeSession: NativeSessionHandle | null;
  /** The agent's effective wake mode (override ?? default ?? auto) — the P-008
   *  badge. null for pending (not-yet-spawned) entries. */
  wakeMode: WakeMode | null;
  /** Staged (manual-mode) wakes awaiting owner release — the P-008 badge's
   *  pending COUNT. 0 unless the P-007 gate staged something. */
  pendingWakes: number;
  // ── fleet membership (fleet-color-schemes #3) ──
  /** The named fleet this agent belongs to (coord_presence.fleet_slug; null = no
   *  fleet). The pui Fleet tab groups the roster by this. */
  fleetSlug: string | null;
  /** The fleet's bound color-scheme ACCENT (scheme.cursor hex, e.g. "#38bdf8") —
   *  what the pui paints the fleet's group header in. null when no fleet / the
   *  scheme didn't resolve (the pui falls back to a neutral header). */
  fleetColor: string | null;
  // ── live-thinking handle (agents-roster inspector) ──
  /** The agent's latest RUNNING spawned run-id — the `<runId>.jsonl` handle the
   *  live thinking stream (`/api/harness/:slug/agents/:runId/stream`) reads. null
   *  for interactive sessions / no running spawn. Drives the roster's
   *  live-thinking action (guarded — null ⇒ no action, never a dead button). */
  runId: string | null;
  /** The harness the run's log lives under (the stream's `:slug`). Paired with
   *  runId; null when runId is null. */
  harnessSlug: string | null;
  /** Whether this agent appears to be ACTIVELY THINKING right now — its session
   *  transcript was appended within SESSION_THINKING_ACTIVE_MS (the roster's
   *  "in the middle of thinking" indicator). Best-effort proxy; false for agents
   *  with no resolvable transcript. */
  thinking: boolean;
}

/**
 * Native claude session ids keyed by the bee's coord owner (= its spawnId, which
 * is `spawned_agents.spawn_id`). Recorded by operator-spawn for CLAUDE bees only
 * (mig 203 / P-016); lets the roster hand pui a `claude --resume <id>` handle for
 * the bee pane (P-004). Best-effort: a read error yields an empty map (no resume
 * handle → the bee gets no dock pane; it stays visible in the colony roster).
 */
export async function spawnedAgentNativeSessionsByOwner(): Promise<Map<string, NativeSessionHandle>> {
  const out = new Map<string, NativeSessionHandle>();
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT spawn_id, session_owner, child_role, model_spec, session_id
      FROM harness_shared.spawned_agents
      WHERE COALESCE(session_owner, spawn_id) IS NOT NULL
    `;
    for (const r of rows as unknown as Array<{
      spawn_id: string;
      session_owner: string | null;
      child_role: string | null;
      model_spec: string | null;
      session_id: string | null;
    }>) {
      if (!r.spawn_id) continue;
      const backend = resolveSpawnBackendModel(
        r.child_role ?? 'worker',
        r.model_spec ?? undefined,
      ).backend;
      const handle = nativeSessionHandleForSpawnedAgent({
        spawnId: r.spawn_id,
        sessionOwner: r.session_owner,
        backend,
        sessionId: r.session_id,
      });
      out.set(r.spawn_id, handle);
      if (r.session_owner) out.set(r.session_owner, handle);
    }
  } catch {
    /* best-effort — no resume handles, those bees get no dock panes */
  }
  return out;
}

export async function spawnedAgentSessionsByOwner(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const handles = await spawnedAgentNativeSessionsByOwner();
  for (const [owner, handle] of handles) {
    if (handle.backend === 'claude' && handle.sessionId) out.set(owner, handle.sessionId);
  }
  return out;
}

/**
 * Nursery liveness for spawned bees (EI-348 / liveness-hardening P-013).
 * Presence heartbeats are tool-call-coupled, so a bee heads-down in LOCAL
 * tools (Read/Edit/Bash) goes presence-stale within LIVE_MS while its process
 * is alive and its supervisor keeps beating `spawned_agents.heartbeat_at`.
 * The roster must read BOTH legs — exactly like the stale-claims sweep does.
 */
export interface NurseryLiveness {
  spawnId: string;
  /** ISO supervisor heartbeat (60s cadence while the host holds the child). */
  heartbeatAt: string | null;
  /** ISO last observed child stdout/stderr chunk (mig 233, P-008). */
  lastOutputAt: string | null;
  /** Same-host /proc check (EI-85); null = different host / no pid recorded. */
  pidAlive: boolean | null;
}

/**
 * Running/restarting nursery rows keyed by session_owner (== the bee's coord
 * ownerId, the umbilical `client=` id). Same-host rows get a real pid-alive
 * verdict via the EI-85 /proc check. Best-effort: errors yield an empty map
 * (the roster degrades to presence-only, the pre-EI-348 behavior).
 */
export async function runningSpawnLivenessByOwner(
  localHost: string,
): Promise<Map<string, NurseryLiveness>> {
  const out = new Map<string, NurseryLiveness>();
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT spawn_id, session_owner, heartbeat_at, last_output_at, pid, launcher_host
        FROM harness_shared.spawned_agents
       WHERE status IN ('running', 'restarting') AND session_owner IS NOT NULL
    `;
    for (const r of rows as unknown as Array<{
      spawn_id: string;
      session_owner: string;
      heartbeat_at: Date | null;
      last_output_at: Date | null;
      pid: number | null;
      launcher_host: string | null;
    }>) {
      out.set(r.session_owner, {
        spawnId: r.spawn_id,
        heartbeatAt: r.heartbeat_at ? r.heartbeat_at.toISOString() : null,
        lastOutputAt: r.last_output_at ? r.last_output_at.toISOString() : null,
        pidAlive:
          r.launcher_host === localHost && r.pid != null
            ? isSpawnProcessAlive(Number(r.pid))
            : null,
      });
    }
  } catch {
    /* best-effort — presence-only roster */
  }
  return out;
}

const LIVENESS_RANK: Record<Liveness, number> = { live: 3, idle: 2, stale: 1, pending: 0 };

/**
 * Filter a presence list to a workspace's roster: rows in that workspace PLUS
 * the workspace-agnostic '*' rows (unscoped SU shells). A null workspaceId =
 * the "All" scope → every row.
 */
export function scopePresenceToWorkspace(
  presence: PresenceRecord[],
  workspaceId: string | null | undefined,
): PresenceRecord[] {
  if (workspaceId == null) return presence;
  return presence.filter(
    (p) => p.workspaceId === workspaceId || p.workspaceId === GLOBAL_WORKSPACE,
  );
}

/**
 * Derive the AgentLaunchHint for classifyAgentPane from a pending launch's psu
 * argv: `--role=planner` marks a Create → New-plan
 * Planner launch (P-006 — covers argv-only rows; launch-su also records
 * role='planner' on the adv row, which classifies on its own). Role-based
 * classification covers the rest, so undefined is the common case.
 */
function launchHintFromArgv(argv: string[] | null | undefined): 'brain' | 'planner' | undefined {
  if (!argv?.length) return undefined;
  if (argv.includes('--role=planner')) return 'planner';
  return undefined;
}

/**
 * Pure merge: presence rows (primary) LEFT-joined to adv_sessions by owner id.
 * Order is preserved (listPresence already returns newest-heartbeat-first).
 */
export function mergeRosterEntries(
  presence: PresenceRecord[],
  advByOwner: Map<string, AdvSessionRow>,
  nowMs: number,
  claimsByOwner: Map<string, AgentClaim[]> = new Map(),
  sessionsByOwner: Map<string, string | NativeSessionHandle> = new Map(),
  wakeModesByOwner: Map<string, WakeMode> = new Map(),
  defaultWakeMode: WakeMode = 'auto',
  pendingWakesByOwner: Map<string, number> = new Map(),
  nurseryByOwner: Map<string, NurseryLiveness> = new Map(),
  fleetByOwner: Map<string, { fleetSlug: string | null; fleetColor: string | null }> = new Map(),
  runInfoByOwner: Map<string, { runId: string; harness: string }> = new Map(),
  loopArmedOwners: Set<string> = new Set(),
): RosterEntry[] {
  return presence.map((p) => {
    const adv = advByOwner.get(p.ownerId) ?? null;
    // The autonomous Queen + Overwatch are invoke-route launches with NO
    // adv_sessions row (adv?.role would be null) — but their presence row
    // carries agentRole (deriveAgentRole, stamped on each heartbeat). Fall back
    // to it so they classify as queen/overwatch and surface in the dock
    // --queen/--overwatch panes instead of dropping to the generic bee arm.
    const pane = classifyAgentPane({ role: adv?.role ?? p.agentRole ?? null, ownerId: p.ownerId });
    const claims = claimsByOwner.get(p.ownerId) ?? [];
    const currentPlanSlug = p.currentPlanSlug ?? adv?.planSlug ?? null;
    // EI-348 (P-013): for a spawned bee, the RUNNING nursery row is a first-
    // class liveness leg — presence is tool-call-coupled and goes stale during
    // heads-down local work while the supervisor keeps beating (and pid-alive
    // proves the process). Take the BEST of the two legs; same-host pid-alive
    // is definitive. Presence still owns intent/claims enrichment.
    const nursery = nurseryByOwner.get(p.ownerId) ?? null;
    let liveness = deriveLiveness(p.heartbeatAt, nowMs);
    if (nursery) {
      const nurseryLiveness: Liveness =
        nursery.pidAlive === true
          ? 'live'
          : nursery.heartbeatAt
            ? deriveLiveness(nursery.heartbeatAt, nowMs)
            : 'stale';
      if (LIVENESS_RANK[nurseryLiveness] > LIVENESS_RANK[liveness]) liveness = nurseryLiveness;
    }
    const spawnedHandleOrSessionId = sessionsByOwner.get(p.ownerId) ?? null;
    const spawnedNativeSession =
      typeof spawnedHandleOrSessionId === 'string'
        ? nativeSessionHandleForSpawnedAgent({
          spawnId: nursery?.spawnId ?? p.ownerId,
          sessionOwner: p.ownerId,
          backend: 'claude-code',
          sessionId: spawnedHandleOrSessionId,
        })
        : spawnedHandleOrSessionId;
    const sessionId =
      spawnedNativeSession?.backend === 'claude'
        ? spawnedNativeSession.sessionId
        : adv?.sessionId ?? null;
    const nativeSession = spawnedNativeSession ?? (adv ? nativeSessionHandleForAdvSession(adv) : null);
    return {
      ownerId: p.ownerId,
      label: p.ownerLabel,
      source: p.source,
      intent: p.intent,
      currentFiles: p.currentFiles,
      host: p.host,
      pid: p.pid,
      startedAt: p.startedAt,
      heartbeatAt: p.heartbeatAt,
      lastActiveAt: p.lastActiveAt ?? null,
      liveness,
      stale: p.stale,
      loopArmed: loopArmedOwners.has(p.ownerId),
      workspaceId: p.workspaceId,
      userId: p.userId,
      revoked: p.revoked,
      pidAlive: nursery?.pidAlive ?? null, // sessions: enriched by mergeRoster same-host pass
      lastOutputAt: nursery?.lastOutputAt ?? null,
      claims,
      declaredUnclaimed: Boolean(
        currentPlanSlug && !claims.some((c) => c.planSlug === currentPlanSlug),
      ),
      hasLaunchRecord: adv != null,
      advSessionId: adv?.id ?? null,
      currentPlanSlug,
      role: adv?.role ?? p.agentRole ?? null,
      feature: adv?.feature ?? null,
      agent: adv?.agent ?? null,
      mode: adv?.mode ?? null,
      windowId: adv?.windowId ?? null,
      ompThreadId: adv?.ompThreadId ?? null,
      cwd: adv?.cwd ?? null,
      launchStartedAt: adv?.startedAt ?? null,
      // A presence-backed entry is never a pending workbench launch — those are
      // synthesized separately (pendingLaunchesToRosterEntries) into the roster's
      // `pending` tier, never `active` (D-006).
      display: null,
      launchArgv: [],
      agentPaneKind: pane.kind,
      driveMode: pane.driveMode,
      // The agent's native claude session uuid (the `claude --resume <id>` /
      // transcript-file handle). A spawned bee records it in spawned_agents
      // (sessionsByOwner); a psu-launched agent (queen / overwatch / brain) has
      // no spawned_agents row but DOES stamp it on its adv_sessions row
      // (mig 115). Both are the same native uuid — fall back to the adv row so
      // the autonomous Queen/Overwatch carry a resolvable session id (the dock's
      // read-only `pui brain-view` pane locates the transcript by this uuid).
      sessionId,
      nativeSession,
      wakeMode: resolveWakeModeFrom(wakeModesByOwner.get(p.ownerId) ?? null, defaultWakeMode),
      pendingWakes: pendingWakesByOwner.get(p.ownerId) ?? 0,
      fleetSlug: fleetByOwner.get(p.ownerId)?.fleetSlug ?? null,
      fleetColor: fleetByOwner.get(p.ownerId)?.fleetColor ?? null,
      runId: runInfoByOwner.get(p.ownerId)?.runId ?? null,
      harnessSlug: runInfoByOwner.get(p.ownerId)?.harness ?? null,
      thinking: false, // annotated by mergeRosterWithAssignments (transcript mtime)
    };
  });
}

/**
 * Map pending workbench-launch adv_sessions rows (display='workbench', not yet
 * consumed by the pui) into RosterEntry-shaped rows for the roster's `pending`
 * tier (pui-reactive-session-panes D-006). These have no coord_presence (nothing
 * runs yet), so the fields are synthesized: liveness 'pending', a synthetic owner
 * id, host = the local box (the pui that panes them runs here). The pui reads ONLY
 * `pending` to drive reactive panes — they never enter `active`.
 */
export function pendingLaunchesToRosterEntries(
  rows: AdvSessionRow[],
  localHost: string,
): RosterEntry[] {
  return rows.map((r) => {
    const pane = classifyAgentPane({ role: r.role, launch: launchHintFromArgv(r.launchArgv) });
    return {
      ownerId: `pending:adv:${r.id}`,
      label: r.label ?? `${r.agent ?? 'session'}${r.planSlug ? ` · ${r.planSlug}` : ''}`,
      source: r.agent ?? '',
      intent: 'pending workbench launch',
      currentFiles: [],
      host: localHost,
      pid: null,
      startedAt: r.startedAt,
      heartbeatAt: r.startedAt,
      lastActiveAt: null,
      liveness: 'pending' as Liveness,
      stale: false,
      loopArmed: false,
      workspaceId: r.workspaceId,
      userId: null,
      revoked: false,
      pidAlive: null,
      lastOutputAt: null,
      claims: [],
      // A pending launch hasn't run a turn yet — nothing to have claimed.
      declaredUnclaimed: false,
      hasLaunchRecord: true,
      advSessionId: r.id,
      currentPlanSlug: r.planSlug,
      role: r.role,
      feature: r.feature,
      agent: r.agent,
      mode: r.mode,
      windowId: null,
      ompThreadId: null,
      cwd: r.cwd,
      launchStartedAt: r.startedAt,
      display: r.display,
      launchArgv: r.launchArgv ?? [],
      agentPaneKind: pane.kind,
      driveMode: pane.driveMode,
      sessionId: null,
      nativeSession: null,
      wakeMode: null,
      pendingWakes: 0,
      // A pending launch hasn't joined a fleet yet — no group, no color.
      fleetSlug: null,
      fleetColor: null,
      // Not yet running → no thinking stream.
      runId: null,
      harnessSlug: null,
      thinking: false,
    };
  });
}

/**
 * Whether a roster entry's OS process is worth a `process.kill(pid, 0)` probe:
 * it must have a pid, be non-stale (a stale entry is already known-gone, and
 * the probe would only add noise), and live on THIS host (a pid on another
 * machine can't be checked — and could collide with an unrelated local pid).
 * Pure → unit-tested; the probe itself stays in mergeRoster.
 */
export function shouldProbePid(entry: RosterEntry, localHost: string): boolean {
  return (
    entry.pid != null &&
    entry.liveness !== 'stale' &&
    (entry.host === '' || entry.host === localHost)
  );
}

/** Is `pid` a live OS process? Signal 0 = existence check; EPERM = alive-not-ours. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Enrich same-host non-stale entries with `pidAlive` so the UI can flag
 * zombies (fresh heartbeat, dead process). Mutates + returns `entries`.
 * Cheap: a syscall per eligible entry, no actual signal sent.
 */
export function enrichPidLiveness(entries: RosterEntry[], localHost: string): RosterEntry[] {
  for (const e of entries) {
    if (shouldProbePid(e, localHost) && e.pid != null) {
      e.pidAlive = isPidAlive(e.pid);
    }
  }
  return entries;
}

/** The roster + the claim-keyed canonical projection in one read. */
export interface RosterWithAssignments {
  active: RosterEntry[];
  /**
   * Active claims whose holder is absent/stale from the presence roster — the
   * abandoned-work signal (state-not-chat-fleet-state D-002). Claim-primary:
   * these rows would be invisible in a presence-keyed roster, so they ride
   * alongside it rather than inside it.
   */
  orphanedClaims: OrphanedClaimSummary[];
}

/**
 * Resolve each presence owner's fleet membership + the fleet's bound color-scheme
 * ACCENT (scheme.cursor hex), for the pui Fleet-tab roster grouping (#3). The
 * fleet label rides on coord_presence (fetchPresenceFleet — a soft label NOT on
 * PresenceRecord); the accent resolves ONCE per distinct (workspace, fleet) via
 * getFleetScheme. Best-effort: a presence-fleet read failure yields an empty map
 * (the roster degrades to flat/ungrouped), and an unresolved scheme leaves the
 * color null (the pui draws a neutral header).
 */
async function resolveFleetInfoByOwner(
  presence: PresenceRecord[],
): Promise<Map<string, { fleetSlug: string | null; fleetColor: string | null }>> {
  const out = new Map<string, { fleetSlug: string | null; fleetColor: string | null }>();
  let fleetByOwner: Awaited<ReturnType<typeof fetchPresenceFleet>>;
  try {
    fleetByOwner = await fetchPresenceFleet(presence.map((p) => p.ownerId));
  } catch {
    return out; // presence-fleet read failed → no grouping (flat roster)
  }
  const colorCache = new Map<string, string | null>(); // `${workspaceId}\0${slug}` → accent
  for (const p of presence) {
    const slug = fleetByOwner.get(p.ownerId)?.fleetSlug ?? null;
    if (!slug) {
      out.set(p.ownerId, { fleetSlug: null, fleetColor: null });
      continue;
    }
    const key = `${p.workspaceId}\0${slug}`;
    if (!colorCache.has(key)) {
      const scheme = await getFleetScheme(p.workspaceId, slug).catch(() => null);
      colorCache.set(key, scheme?.cursor ?? null);
    }
    out.set(p.ownerId, { fleetSlug: slug, fleetColor: colorCache.get(key) ?? null });
  }
  return out;
}

/**
 * The latest RUNNING spawned run per agent (session_owner) → its run-id + harness.
 * The run-id is the `<runId>.jsonl` handle the live "thinking" stream reads
 * (`/api/harness/:slug/agents/:runId/stream`), and harness_slug is its logs dir.
 * Only running/restarting spawns (a finished run's thinking is history). Feeds the
 * roster's live-thinking action. Best-effort: empty map on any read error (⇒ no
 * action shown — never a dead button).
 */
async function spawnedAgentRunInfoByOwner(): Promise<Map<string, { runId: string; harness: string }>> {
  const out = new Map<string, { runId: string; harness: string }>();
  try {
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT DISTINCT ON (session_owner) session_owner, run_id, harness_slug
        FROM harness_shared.spawned_agents
       WHERE session_owner IS NOT NULL AND status IN ('running', 'restarting')
       ORDER BY session_owner, started_at DESC
    `) as unknown as Array<{ session_owner: string | null; run_id: string | null; harness_slug: string | null }>;
    for (const r of rows) {
      if (r.session_owner && r.run_id && r.harness_slug) {
        out.set(r.session_owner, { runId: r.run_id, harness: r.harness_slug });
      }
    }
  } catch {
    /* best-effort — no thinking action if this read fails */
  }
  return out;
}

/**
 * Owner ids that currently have an ARMED engine loop — an active
 * harness_shared.routines loop row (reschedule_interval_sec IS NOT NULL) pinned to
 * that owner (target_owner_id). A loop-armed agent counts as "live" in the roster
 * (it keeps working on a cadence) even when its presence has gone idle between
 * wakes. Best-effort: empty set on any read error.
 */
export async function activeLoopOwners(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT DISTINCT target_owner_id
        FROM harness_shared.routines
       WHERE reschedule_interval_sec IS NOT NULL
         AND target_owner_id IS NOT NULL
         AND active = true
    `) as unknown as Array<{ target_owner_id: string | null }>;
    for (const r of rows) if (r.target_owner_id) out.add(r.target_owner_id);
  } catch {
    /* best-effort — no loop-armed annotation if this read fails */
  }
  return out;
}

/**
 * The live roster for a workspace (or all workspaces when workspaceId is
 * null/omitted): coord_presence primary + adv_sessions enrichment + per-agent
 * claims from the canonical fleet_assignment view, liveness derived from the
 * heartbeat, pidAlive probed for same-host non-stale entries. The three reads
 * run concurrently. Also returns the view's orphaned-claim list (work held by
 * dead/stale agents) — the claim-keyed half a presence-primary roster can't see.
 */
export async function mergeRosterWithAssignments(
  opts: { workspaceId?: string | null } = {},
): Promise<RosterWithAssignments> {
  const workspaceId = opts.workspaceId ?? null;
  const [
    presenceAll,
    advByOwner,
    assignmentRows,
    sessionsByOwner,
    wakeModesByOwner,
    defaultWakeMode,
    pendingWakesByOwner,
    runInfoByOwner,
    loopArmedOwners,
  ] = await Promise.all([
    listPresence(),
    advSessionsByCoordOwner(),
    listFleetAssignments({ workspaceId }).catch(() => []),
    spawnedAgentNativeSessionsByOwner(),
    getAllWakeModeOverrides().catch(() => new Map<string, WakeMode>()),
    getDefaultWakeMode().catch(() => 'auto' as WakeMode),
    countAllPendingWakes().catch(() => new Map<string, number>()),
    spawnedAgentRunInfoByOwner(),
    activeLoopOwners().catch(() => new Set<string>()),
  ]);
  // EI-348: nursery liveness join — sequential (not in the Promise.all) only
  // because it needs the hostname; one indexed query, still cheap.
  const nurseryByOwner = await runningSpawnLivenessByOwner(os.hostname());
  const presence = scopePresenceToWorkspace(presenceAll, workspaceId);
  // #3: per-owner fleet label + the fleet's accent color, for the pui roster grouping.
  const fleetInfoByOwner = await resolveFleetInfoByOwner(presence);
  const entries = mergeRosterEntries(
    presence,
    advByOwner,
    Date.now(),
    claimsByAgent(assignmentRows),
    sessionsByOwner,
    wakeModesByOwner,
    defaultWakeMode,
    pendingWakesByOwner,
    nurseryByOwner,
    fleetInfoByOwner,
    runInfoByOwner,
    loopArmedOwners,
  );
  const active = enrichPidLiveness(entries, os.hostname());
  // "In the middle of thinking" (roster indicator): a session whose transcript was
  // appended within SESSION_THINKING_ACTIVE_MS reads as actively thinking. Resolved
  // in PARALLEL (never a serial fs loop, per the perf docs) and best-effort — every
  // backend's transcript path is cached, so this is one cheap stat/agent. Claude
  // sessions key by sessionId (+owner fast path); codex by the adv row id (its
  // CODEX_HOME key); omp by thread id.
  const { isSessionThinking, SESSION_THINKING_ACTIVE_MS } = await import('./claude-sessions');
  const { isCodexSessionThinking, isOmpThreadThinking } = await import('./session-transcript-resolvers');
  const nowMs = Date.now();
  await Promise.all(
    active.map(async (e) => {
      if (e.sessionId) {
        e.thinking = await isSessionThinking(e.sessionId, { owner: e.ownerId, nowMs }).catch(() => false);
      } else if (e.agent === 'codex' && e.advSessionId != null) {
        e.thinking = await isCodexSessionThinking(e.advSessionId, { nowMs, activeMs: SESSION_THINKING_ACTIVE_MS }).catch(() => false);
      } else if (e.ompThreadId) {
        e.thinking = await isOmpThreadThinking(e.ompThreadId, { nowMs, activeMs: SESSION_THINKING_ACTIVE_MS }).catch(() => false);
      }
    }),
  );
  return {
    active,
    orphanedClaims: orphanedClaims(assignmentRows).map(summarizeOrphan),
  };
}

/** The active roster alone (mergeRosterWithAssignments minus the orphan list). */
export async function mergeRoster(
  opts: { workspaceId?: string | null } = {},
): Promise<RosterEntry[]> {
  return (await mergeRosterWithAssignments(opts)).active;
}
