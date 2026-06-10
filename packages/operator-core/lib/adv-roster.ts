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
// hive-agent-tabs-psu-tui P-001: the shared pane-kind taxonomy (one source of
// truth) — stamp each roster entry so pui renders/colors per type.
import { classifyAgentPane, type AgentPaneKind, type DriveMode } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
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
  liveness: Liveness;
  /** The coord-store's own stale flag (heartbeat older than PRESENCE_STALE_MS). */
  stale: boolean;
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
  // ── canonical assignment enrichment (fleet_assignment view, state-not-chat-
  //    fleet-state D-002): what this agent actually HOLDS — plan-item claims,
  //    work-item claims, durable assignments. The roster reads the one canonical
  //    view instead of re-deriving claims per surface. ──
  claims: AgentClaim[];
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
  /** The agent's effective wake mode (override ?? default ?? auto) — the P-008
   *  badge. null for pending (not-yet-spawned) entries. */
  wakeMode: WakeMode | null;
  /** Staged (manual-mode) wakes awaiting owner release — the P-008 badge's
   *  pending COUNT. 0 unless the P-007 gate staged something. */
  pendingWakes: number;
}

/**
 * Native claude session ids keyed by the bee's coord owner (= its spawnId, which
 * is `spawned_agents.spawn_id`). Recorded by operator-spawn for CLAUDE bees only
 * (mig 203 / P-016); lets the roster hand pui a `claude --resume <id>` handle for
 * the bee pane (P-004). Best-effort: a read error yields an empty map (no resume
 * handle → pui falls back to the watch-pane view).
 */
export async function spawnedAgentSessionsByOwner(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT spawn_id, session_id
      FROM harness_shared.spawned_agents
      WHERE session_id IS NOT NULL
    `;
    for (const r of rows as Array<{ spawn_id: string; session_id: string }>) {
      if (r.spawn_id && r.session_id) out.set(r.spawn_id, r.session_id);
    }
  } catch {
    /* best-effort — no resume handles, pui falls back to watch-panes */
  }
  return out;
}

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
 * argv: `--brain` marks the Queen; `--role=planner` marks a Create → New-plan
 * Planner launch (P-006 — covers argv-only rows; launch-su also records
 * role='planner' on the adv row, which classifies on its own). Role-based
 * classification covers the rest, so undefined is the common case.
 */
function launchHintFromArgv(argv: string[] | null | undefined): 'brain' | 'planner' | undefined {
  if (!argv?.length) return undefined;
  if (argv.includes('--brain')) return 'brain';
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
  sessionsByOwner: Map<string, string> = new Map(),
  wakeModesByOwner: Map<string, WakeMode> = new Map(),
  defaultWakeMode: WakeMode = 'auto',
  pendingWakesByOwner: Map<string, number> = new Map(),
): RosterEntry[] {
  return presence.map((p) => {
    const adv = advByOwner.get(p.ownerId) ?? null;
    const pane = classifyAgentPane({ role: adv?.role ?? null });
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
      liveness: deriveLiveness(p.heartbeatAt, nowMs),
      stale: p.stale,
      workspaceId: p.workspaceId,
      userId: p.userId,
      revoked: p.revoked,
      pidAlive: null, // enriched by mergeRoster for same-host non-stale entries
      claims: claimsByOwner.get(p.ownerId) ?? [],
      hasLaunchRecord: adv != null,
      advSessionId: adv?.id ?? null,
      currentPlanSlug: p.currentPlanSlug ?? adv?.planSlug ?? null,
      role: adv?.role ?? null,
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
      sessionId: sessionsByOwner.get(p.ownerId) ?? null,
      wakeMode: resolveWakeModeFrom(wakeModesByOwner.get(p.ownerId) ?? null, defaultWakeMode),
      pendingWakes: pendingWakesByOwner.get(p.ownerId) ?? 0,
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
      liveness: 'pending' as Liveness,
      stale: false,
      workspaceId: r.workspaceId,
      userId: null,
      revoked: false,
      pidAlive: null,
      claims: [],
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
      wakeMode: null,
      pendingWakes: 0,
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
  ] = await Promise.all([
    listPresence(),
    advSessionsByCoordOwner(),
    listFleetAssignments({ workspaceId }).catch(() => []),
    spawnedAgentSessionsByOwner(),
    getAllWakeModeOverrides().catch(() => new Map<string, WakeMode>()),
    getDefaultWakeMode().catch(() => 'auto' as WakeMode),
    countAllPendingWakes().catch(() => new Map<string, number>()),
  ]);
  const presence = scopePresenceToWorkspace(presenceAll, workspaceId);
  const entries = mergeRosterEntries(
    presence,
    advByOwner,
    Date.now(),
    claimsByAgent(assignmentRows),
    sessionsByOwner,
    wakeModesByOwner,
    defaultWakeMode,
    pendingWakesByOwner,
  );
  return {
    active: enrichPidLiveness(entries, os.hostname()),
    orphanedClaims: orphanedClaims(assignmentRows).map(summarizeOrphan),
  };
}

/** The active roster alone (mergeRosterWithAssignments minus the orphan list). */
export async function mergeRoster(
  opts: { workspaceId?: string | null } = {},
): Promise<RosterEntry[]> {
  return (await mergeRosterWithAssignments(opts)).active;
}
