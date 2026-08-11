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
import { listFederatedPresence } from './agent-tools/coordination/federated-presence';
import { machineFingerprint } from './identity/device-keychain-id';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { advSessionsByCoordOwner, isFailedTerminalLaunch, type AdvSessionRow } from './adv-sessions';
// WI-37841: the cause of a failed launch, from the boot log psu-launcher.mjs and
// launch-su.ts both write. One shared path derivation — see psu-launch-log.mjs.
import { readPsuLaunchLogTail } from './psu-launch-log.mjs';
import { deriveLiveness, LIVE_MS, type Liveness } from './liveness';
import { resolveSessionStates } from './agent-tools/coordination/liveness-oracle';
import type { SessionState } from './agent-tools/coordination/presence-wakeability';
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
import { getOwnerPinsMap, type OwnerPin } from './deployment/account-owner-pins';
import { activeWorkspaceId } from './workspace-registry';

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
/**
 * An OPEN `events:await` an agent is parked on (adv-hud-fleet-board-2026-07-25
 * P-001). "Open" = neither fired nor cancelled: a fired await is history, not a
 * block. This is what lets a supervision surface tell "parked because it
 * finished" apart from "parked forever on a gate nobody will open" — the failure
 * mode that costs the most, because nobody raises a hand for it.
 */
/** Per-owner fleet membership as the roster carries it: the soft coord_presence
 *  label, the fleet's bound accent, and the role within it. */
export interface FleetInfo {
  fleetSlug: string | null;
  fleetColor: string | null;
  fleetRole: string | null;
}

export interface OpenAwait {
  /** The event key being awaited (e.g. `fleet:release-gate:suite-green`). */
  eventKey: string;
  /** The agent's own note about what it is waiting for; null when it gave none. */
  note: string | null;
  /** When the await was registered — the "blocked for how long" clock. */
  sinceIso: string;
  /** When it times out, if it does. null = waits indefinitely, which is exactly
   *  the case a human most needs to see. */
  expiresIso: string | null;
}

/**
 * One standing mode on a session, as the GUI needs it.
 *
 * The roster USED to flatten agent_modes down to a bare id (`['auto']`) even
 * though the batched read already returns the full row — so a card could say
 * "AUTO" but never "…because you put it there". Provenance is what makes the
 * chip actionable: an owner-directed mode is sticky (a peer agent cannot
 * override it), a self-set one is the agent's own posture.
 */
export interface AdvRosterMode {
  /** Registry mode id — see MODES in modes/registry.ts for the live set. */
  mode: string;
  /** True when the human owner armed it (agent_modes.owner_directed). */
  ownerDirected: boolean;
  /** When it was set (agent_modes.set_at) — the "in this mode for how long" clock. */
  since: string | null;
  /**
   * WHAT the mode is about (agent_modes.subject) — mode-defined, usually null.
   * For GOAL it is the `harness_shared.goals.id` this session is running, which
   * makes it THE marker distinguishing a goal session from an ordinary one
   * (goals-tab-improvement-2026-08-09 D-007/P-020). The read already paid for
   * this column; it was simply dropped here, which is why the HUD could see
   * THAT an agent was in goal mode but never WHICH goal.
   *
   * Carried for every mode, not special-cased to GOAL: DRAIN's scope and
   * GRADE's rubric ref occupy the same slot, and a GOAL-only field would have
   * to be widened the first time either of them needs to render.
   */
  subject: string | null;
}

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
  /**
   * THE liveness verdict from the shared oracle (`resolveSessionStates`) — the
   * same derivation coord:presence, fleet:status, coord:roster and leader-brief
   * project from, so this roster cannot disagree with them (D-001: one
   * derivation, many lenses). null when the oracle degraded for this owner.
   *
   * Read THIS, not `liveness`, to answer "is it taking turns?". `liveness` is
   * derived from HEARTBEAT FRESHNESS alone, and a parked agent waiting on its
   * inbox keeps beating — so `liveness` reads 'live' for a session that has not
   * taken a turn in days. That gap put 110 parked agents in the HUD's "Stalled"
   * column on the default board (WI-6636); `sessionState` is 'parked' for them.
   */
  sessionState: SessionState | null;
  /** RAW heartbeat freshness from the same oracle — a process-keepalive signal,
   *  NOT a liveness verdict. Named to make that impossible to misread. */
  heartbeatFresh: boolean | null;
  /** The coord-store's own stale flag (heartbeat older than PRESENCE_STALE_MS). */
  stale: boolean;
  /** Whether an engine LOOP is armed for this agent (an active harness_shared.routines
   *  loop row targeting this ownerId). A loop-armed agent counts as "live" (it keeps
   *  working on a cadence) even when its presence has gone idle between wakes. */
  loopArmed: boolean;
  /** OFFICIAL standing modes (harness_shared.agent_modes) — the mode-rail state for the
   *  GUI mode chips (EI-7626). Distinct from `mode` below, which is the psu LAUNCH-time
   *  flag on the adv_sessions row. Empty when none set. */
  modes: AdvRosterMode[];
  /** The machine this agent runs on. For a LOCAL agent: this machine's fingerprint;
   *  for a FEDERATED (cross-machine, shared-hive) agent: its announced machine_label.
   *  The key the roster groups/tabs by. */
  machineLabel: string | null;
  /** True for an agent on THIS machine (coord_presence); false for a federated agent
   *  surfaced from another machine in the shared hive (shared_session_presence). */
  isLocal: boolean;
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
  /**
   * WI-6821: this launch is OBSERVED dead — its terminal process is gone and it
   * never registered a session. Only the `starting` tier ever sets it, and only
   * from persisted state (isFailedTerminalLaunch), so it survives a reload.
   *
   * Optional on purpose: every other RosterEntry producer describes a session
   * that was never a pending launch, and making it required would strand every
   * fixture that builds an entry. Absent/undefined means "not a failed launch",
   * never "unknown" — a reader may treat falsy as fine.
   */
  launchFailed?: boolean;
  /**
   * WI-37841: WHY that launch failed, in psu's own words — the tail of this
   * launch's boot log. Set only alongside `launchFailed`.
   *
   * `launchFailed` is DERIVED (ended, never registered), so it is structurally
   * incapable of carrying a cause, and the banner above it could only ever be a
   * fixed string. That one string has cost two full forensic sessions for two
   * different root causes, each of which psu had already printed — to a window
   * nobody could read afterwards.
   *
   * null vs '' matters and readers must keep them apart: null = no log (an old
   * launch, a pre-WI-37841 psu, a resume with no pre-pinned owner) ⇒ say nothing
   * and fall back to the generic copy; '' = the launch ran and printed NOTHING,
   * which is itself a finding worth showing rather than hiding behind the
   * generic line.
   */
  launchFailureHint?: string | null;
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
  /** Role within the named fleet ('leader' | 'member'); null when not in a fleet.
   *  fetchPresenceFleet has always READ this alongside fleet_slug — it was simply
   *  dropped on the floor here. /adv/HUD needs it for the LEAD badge + to sort a
   *  fleet's leader above its members (adv-hud-fleet-board-2026-07-25 P-001). */
  fleetRole: string | null;
  // ── context pressure (coord_presence, watchdog-cached — adv-hud P-001) ──
  /** Cached estimate of the session's current context size in tokens. null =
   *  untracked (federated peer, or the watchdog hasn't sampled it yet). NEVER
   *  coerce a null to 0: "unknown" and "empty" are different states. */
  contextTokens: number | null;
  /** The session's SOFT compaction limit in tokens. null ⇒ the per-model default
   *  applies, so a pressure percentage cannot be computed from this row alone. */
  compactionLimit: number | null;
  /**
   * The DURABLE dynamic account pin in force for this agent (`accounts:pin` →
   * `harness_shared.operator_owner_pins`), or null when it carries none
   * (hud-chat-owner-controls-2026-08-11 P-003 / D-009 §D).
   *
   * Sourced onto the row DELIBERATELY rather than fetched by the reader: the
   * chat footer's ACCOUNT pill reads its current value through
   * `ChatModeAction.current()`, which is required to be pure and synchronous
   * (chat-actions/types.ts) so the pill can never disagree with the rest of the
   * surface it was rendered from. The authoritative live read
   * (`gateway:owner_report`) is a per-agent fetch and would put a gateway round
   * trip on every popup open; this is ONE workspace-level row read for the
   * whole roster, in the same batch as every other join.
   *
   * ⚠ null means "NOT DYNAMICALLY PINNED", which is NOT the same as "routed
   * through the pool default". A session launched `--account=<id>` carries a
   * STATIC spawn pin this row cannot see, and a `--account=default` session
   * bypasses the gateway entirely. Read this as the dynamic-pin layer only.
   */
  accountPin: { account: string; hard: boolean } | null;
  /** When the CURRENT `intent` STRING was declared. Distinct from lastActiveAt,
   *  which also moves on activity that never touches the intent text — the pair
   *  is what separates "genuinely busy" from "stuck repeating itself", i.e. the
   *  input to HUD's stall detector. null until the row's first write. */
  intentDeclaredAt: string | null;
  /** The OPEN event-await this agent is parked on — the "blocked, and on WHAT"
   *  signal HUD's Blocked column is built from. null when the agent is not
   *  awaiting anything. Only awaits that have neither fired nor been cancelled
   *  count; a fired await is history, not a block. */
  openAwait: OpenAwait | null;
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
  /** Whether a transcript actually RESOLVES for this agent's live-thinking pane —
   *  i.e. clicking it would show turns rather than an empty "waiting/stalled" pane.
   *  Stamped for interactive CLAUDE sessions (sessionId): false when the recorded
   *  session_id resolves to no transcript (a parked/ended agent whose transcript is
   *  gone, or a stale id with no fallback) — the client then offers the honest
   *  "Live thinking unavailable" note instead of opening an empty modal (WI-2680).
   *  Defaults true for every other backend (bee run-log / codex / omp), whose
   *  own handle-presence gates the affordance. */
  thinkingResolvable: boolean;
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

/**
 * Batched official-modes read for the roster (EI-7626): agent_modes is
 * workspace-keyed, so group owners by their presence row's workspaceId and
 * merge the per-workspace batch reads. Best-effort — a modes-read failure
 * yields an empty map and the roster renders without mode chips.
 */
/** ISO-8601 or null — tolerant of a raw PG timestamp string and of garbage. */
function toIsoOrNull(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function agentModesByOwner(
  presence: Array<{ ownerId: string; workspaceId: string }>,
): Promise<Map<string, AdvRosterMode[]>> {
  const out = new Map<string, AdvRosterMode[]>();
  try {
    const { getModesForOwners } = await import('./modes/store');
    const byWs = new Map<string, string[]>();
    for (const p of presence) {
      if (!p.workspaceId) continue;
      const arr = byWs.get(p.workspaceId) ?? [];
      arr.push(p.ownerId);
      byWs.set(p.workspaceId, arr);
    }
    await Promise.all(
      [...byWs.entries()].map(async ([ws, owners]) => {
        const m = await getModesForOwners(ws, owners);
        for (const [owner, rows] of m) {
          // Carry provenance through — the read already paid for it, and the
          // chip is only actionable with it (owner-set is sticky vs self-set).
          if (rows.length) {
            out.set(
              owner,
              rows.map((r) => ({
                mode: r.mode,
                ownerDirected: Boolean(r.ownerDirected),
                // Normalized to ISO: agent_modes.set_at arrives as a raw PG
                // timestamp string ("2026-07-25 15:17:38.438801-04"), which no
                // Date parser on the client is required to accept. Every other
                // timestamp on this payload is ISO; this one has to match.
                since: toIsoOrNull(r.setAt),
                // The GOAL marker (D-007/P-020). `toRow` already normalizes ''
                // to null, so an empty subject cannot masquerade as a goal id.
                subject: r.subject ?? null,
              })),
            );
          }
        }
      }),
    );
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
  fleetByOwner: Map<string, FleetInfo> = new Map(),
  runInfoByOwner: Map<string, { runId: string; harness: string }> = new Map(),
  loopArmedOwners: Set<string> = new Set(),
  modesByOwner: Map<string, AdvRosterMode[]> = new Map(),
  /**
   * Trailing OPTIONS bag for every join added from here on. Deliberately an
   * object rather than a 14th positional: this signature is already at twelve
   * positionals, and each new one makes every call site a counting exercise.
   * New joins go in here so the arity stops growing.
   */
  extra: {
    awaitByOwner?: Map<string, OpenAwait>;
    /** P-007 finding: fallback harnessSlug source for interactive psu/su
     *  sessions — see sessionBriefHarnessByOwner's docblock. */
    sessionBriefHarness?: Map<string, string>;
    /** WI-6636: the shared liveness oracle's verdict per owner. Absent (or
     *  missing an owner) degrades to sessionState null, which every reader
     *  must treat as "unknown", never as "not live". */
    verdictByOwner?: Map<string, { sessionState: SessionState; heartbeatFresh: boolean }>;
    /** P-003: the workspace's dynamic account pins, keyed by ownerId. Absent
     *  degrades every entry to `accountPin: null` — "no dynamic pin", which is
     *  what an unpinned agent reads as anyway. */
    accountPinByOwner?: Map<string, { account: string; hard: boolean }>;
  } = {},
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
      sessionState: extra.verdictByOwner?.get(p.ownerId)?.sessionState ?? null,
      heartbeatFresh: extra.verdictByOwner?.get(p.ownerId)?.heartbeatFresh ?? null,
      stale: p.stale,
      loopArmed: loopArmedOwners.has(p.ownerId),
      modes: modesByOwner.get(p.ownerId) ?? [],
      // Federated (cross-machine) rows carry federated:true + machineLabel; local
      // rows get their machine label stamped in mergeRosterWithAssignments.
      machineLabel: (p as { federated?: boolean }).federated
        ? ((p as { machineLabel?: string | null }).machineLabel ?? p.host ?? null)
        : null,
      isLocal: !(p as { federated?: boolean }).federated,
      workspaceId: p.workspaceId,
      userId: p.userId,
      revoked: p.revoked,
      pidAlive: nursery?.pidAlive ?? null, // sessions: enriched by mergeRoster same-host pass
      lastOutputAt: nursery?.lastOutputAt ?? null,
      claims,
      declaredUnclaimed: Boolean(
        currentPlanSlug &&
          !loopArmedOwners.has(p.ownerId) &&
          !claims.some((c) => c.planSlug === currentPlanSlug),
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
      // WI-6510: was hardcoded `[]` while the joined adv row carried the argv all
      // along — the pending/starting tiers already pass `r.launchArgv ?? []`, so an
      // ACTIVE agent was the one tier that lost it. Carrying it costs no extra query
      // (the adv row is already joined by owner) and is what lets the chat MODEL pill
      // report the spec its session was launched on from data the surface already
      // holds, keeping `ChatModeAction.current()` pure and synchronous.
      launchArgv: adv?.launchArgv ?? [],
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
      fleetRole: fleetByOwner.get(p.ownerId)?.fleetRole ?? null,
      // Context pressure + intent age ride straight off the presence row — no
      // extra read. `?? null` (not `?? 0`): an unsampled context is UNKNOWN, and
      // rendering unknown as 0% would read as "plenty of room left".
      contextTokens: p.contextTokens ?? null,
      compactionLimit: p.compactionLimit ?? null,
      accountPin: extra.accountPinByOwner?.get(p.ownerId) ?? null,
      intentDeclaredAt: p.intentDeclaredAt ?? null,
      openAwait: extra.awaitByOwner?.get(p.ownerId) ?? null,
      runId: runInfoByOwner.get(p.ownerId)?.runId ?? null,
      // Fallback order: a classic harness-spawned run (paired with the runId
      // above, for the live-thinking-stream URL) first, else the interactive
      // psu/su session's own declared harness (P-007 finding — see
      // sessionBriefHarnessByOwner's docblock for why this fallback exists).
      harnessSlug: runInfoByOwner.get(p.ownerId)?.harness ?? extra.sessionBriefHarness?.get(p.ownerId) ?? null,
      thinking: false, // annotated by mergeRosterWithAssignments (transcript mtime)
      // Default true (non-claude backends gate on their own handle); a claude session
      // whose transcript doesn't resolve is flipped false in mergeRosterWithAssignments.
      thinkingResolvable: true,
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
      // No presence row yet, so the shared oracle has no verdict for this owner.
      // null is "unknown", NOT "not live" — no reader may treat it as dead.
      sessionState: null,
      heartbeatFresh: null,
      stale: false,
      loopArmed: false,
      modes: [],
      machineLabel: null,
      isLocal: true,
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
      // A pending launch hasn't joined a fleet yet — no group, no color, no role.
      fleetSlug: null,
      fleetColor: null,
      fleetRole: null,
      // Nothing has run, so there is no context to measure, no intent declared,
      // and nothing to be blocked on.
      contextTokens: null,
      compactionLimit: null,
      // A launch that has not come online has no owner id in the pin store yet.
      accountPin: null,
      intentDeclaredAt: null,
      openAwait: null,
      // Not yet running → no thinking stream.
      runId: null,
      harnessSlug: null,
      thinking: false,
      thinkingResolvable: true,
    };
  });
}

/**
 * Map TERMINAL-spawned psu launches (display='terminal', still inside the boot
 * window) into RosterEntry-shaped rows for the roster's `starting` tier
 * (WI-6376). The board's whole promise is that a session shows up "whether or
 * not they are launched with the new session button or if they are launched with
 * the psu utility" [owner 2026-07-25]; the roster is presence-primary, so
 * until psu registers its own coord_presence there is nothing to render and the
 * session appeared in no column at all.
 *
 * Two differences from `pendingLaunchesToRosterEntries`, both load-bearing:
 *
 *  1. `ownerId` is the REAL pre-pinned coord owner id (launch-su mints it and
 *     passes `psu --owner-id=`), not a synthetic `pending:adv:<id>`. That makes
 *     the card the same identity the chat modal opens, and it is what lets the
 *     caller drop this row the instant the session comes online — otherwise a
 *     booted session would render twice, once from here and once from presence.
 *  2. `display` stays 'terminal', so the pui's `is_displayable` (which requires
 *     'workbench') can never pane one of these even if it read this tier. The
 *     primary guard is that the pui reads only `pending`; this is the backstop.
 */
export function startingLaunchesToRosterEntries(
  rows: AdvSessionRow[],
  localHost: string,
): RosterEntry[] {
  return rows.map((r) => {
    // `ownerId` is passed for the same reason the ACTIVE path passes it
    // (mergeRosterEntries): classifyAgentPane only returns kind 'su' for a
    // role-less session whose coord id carries the psu `su-` prefix. Without it a
    // terminal launch classified as 'cup', and the board's DEFAULT "su sessions
    // only" filter (isSuSession — agentPaneKind === 'su') hid the card outright:
    // found live 2026-07-27, the card existed but was visible only with
    // ?hudall=true. Passing it also holds the invariant that matters here — the
    // card must not CHANGE KIND the moment the session registers its presence,
    // which is the one thing that would make it flicker or jump columns.
    // The pending tier cannot do this: its owner id is synthetic.
    const pane = classifyAgentPane({
      role: r.role,
      launch: launchHintFromArgv(r.launchArgv),
      ownerId: r.coordOwnerId,
    });
    // WI-6821: a launch whose terminal died before it ever registered. Read from
    // PERSISTED state, so it is the same verdict after a reload and identical for
    // every surface — the board, the modal and the pui cannot disagree about it.
    const failed = isFailedTerminalLaunch(r);
    return {
      // Fall back to a synthetic id only for a pre-WI-6363 row that carries no
      // pre-pinned owner; such a row can still be SEEN, it just cannot be opened.
      ownerId: r.coordOwnerId ?? `starting:adv:${r.id}`,
      label: r.label ?? `${r.agent ?? 'session'}${r.planSlug ? ` · ${r.planSlug}` : ''}`,
      source: r.agent ?? '',
      // Present tense for a live boot; past tense once we have OBSERVED the
      // death. Saying "starting up" about a corpse is the lie WI-6821 filed.
      intent: failed ? 'launch failed' : 'starting up',
      launchFailed: failed,
      // WI-37841: read the cause ONLY for a launch already known to have failed.
      // Gating on `failed` keeps this off the hot path entirely — a healthy boot
      // window does no file I/O — and a failed launch is both rare and bounded
      // by STARTING_LAUNCH_WINDOW_SEC. Never throws (see readPsuLaunchLogTail):
      // a missing or unreadable log degrades to today's generic copy.
      launchFailureHint: failed ? readPsuLaunchLogTail(r.coordOwnerId) : null,
      currentFiles: [],
      host: localHost,
      pid: r.pid,
      startedAt: r.startedAt,
      heartbeatAt: r.startedAt,
      // Never taken a turn — this is what puts the card in `needs-you` via
      // deriveColumn step 1c rather than in `parked`.
      lastActiveAt: null,
      liveness: 'pending' as Liveness,
      // No presence row yet, so the shared oracle has no verdict for this owner.
      // null is "unknown", NOT "not live" — no reader may treat it as dead.
      sessionState: null,
      heartbeatFresh: null,
      stale: false,
      loopArmed: false,
      modes: [],
      machineLabel: null,
      isLocal: true,
      workspaceId: r.workspaceId,
      userId: null,
      revoked: false,
      pidAlive: null,
      lastOutputAt: null,
      claims: [],
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
      fleetSlug: null,
      fleetColor: null,
      fleetRole: null,
      contextTokens: null,
      compactionLimit: null,
      accountPin: null,
      intentDeclaredAt: null,
      openAwait: null,
      runId: null,
      harnessSlug: null,
      thinking: false,
      thinkingResolvable: true,
    };
  });
}

/**
 * Drop starting-tier rows whose session has since come online (WI-6376). The
 * `starting` row and the live presence row describe the SAME session — they
 * share the pre-pinned coord owner id — so without this the board would show a
 * duplicate card for every session during the overlap. Presence always wins: it
 * is the one with real state.
 */
export function dedupeStartingAgainstActive(
  starting: RosterEntry[],
  active: RosterEntry[],
): RosterEntry[] {
  if (starting.length === 0) return starting;
  const online = new Set(active.map((e) => e.ownerId));
  return starting.filter((e) => !online.has(e.ownerId));
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
): Promise<Map<string, FleetInfo>> {
  const out = new Map<string, FleetInfo>();
  let fleetByOwner: Awaited<ReturnType<typeof fetchPresenceFleet>>;
  try {
    fleetByOwner = await fetchPresenceFleet(presence.map((p) => p.ownerId));
  } catch {
    return out; // presence-fleet read failed → no grouping (flat roster)
  }
  const colorCache = new Map<string, string | null>(); // `${workspaceId}\0${slug}` → accent
  for (const p of presence) {
    const membership = fleetByOwner.get(p.ownerId);
    const slug = membership?.fleetSlug ?? null;
    if (!slug) {
      out.set(p.ownerId, { fleetSlug: null, fleetColor: null, fleetRole: null });
      continue;
    }
    const key = `${p.workspaceId}\0${slug}`;
    if (!colorCache.has(key)) {
      const scheme = await getFleetScheme(p.workspaceId, slug).catch(() => null);
      colorCache.set(key, scheme?.cursor ?? null);
    }
    out.set(p.ownerId, {
      fleetSlug: slug,
      fleetColor: colorCache.get(key) ?? null,
      // Already present on the membership row fetchPresenceFleet returns — this
      // used to be discarded here, which is why no surface could show LEAD.
      fleetRole: membership?.fleetRole ?? null,
    });
  }
  return out;
}

/**
 * Batch-read the OPEN event-await per owner (adv-hud-fleet-board-2026-07-25
 * P-001) — the "blocked on a gate, and WHICH gate" join behind HUD's Blocked
 * column.
 *
 * "Open" is the load-bearing predicate: `fired_at IS NULL AND cancelled_at IS
 * NULL`. A fired await is history — counting it would park an agent in Blocked
 * forever after the gate it was waiting on already opened. `superseded_at` is
 * excluded for the same reason (a superseded await was replaced, not honoured).
 *
 * An agent may hold several awaits; the roster shows the OLDEST open one,
 * because that is the one that has been costing time. DISTINCT ON does the pick
 * in the database rather than shipping every await to the caller.
 *
 * ⚠ The `coord:inbox-wake:<self>` exclusion is LOAD-BEARING, not a tidy-up.
 * Every agent carries a permanently-armed inbox-wake row (migration 183 /
 * inbox-wake-arm.ts arms it at SessionStart, one per agent, re-upserted for
 * life). It means "I am reachable by a wake" — the OPPOSITE of blocked.
 * Measured on this box while building /adv/HUD: 126 of 139 open awaits were
 * inbox-wakes, one per live agent, versus 13 genuine work gates. Counting them
 * would have put ~93% of sessions in the Blocked column, which does not just
 * add noise — it destroys the column, because a signal that fires for almost
 * everyone tells you nothing about anyone. Any future filtering here must keep
 * this predicate.
 *
 * ⚠ Scoped by the ROSTER'S OWNER IDS, never by workspace_id — and that is not a
 * style choice. The two tables do not share a workspace vocabulary: on this box
 * every open await carries `workspace_id = 'default'` while every presence row
 * carries `workspace_id = 'papercusp-workspace'`. An earlier version filtered
 * `event_awaits.workspace_id = <the roster's workspace>` and therefore matched
 * ZERO rows on any workspace-scoped read — the Blocked column silently rendered
 * empty in the app while an unscoped curl of the same endpoint returned 13, which
 * is precisely the "looks stale but is actually cross-tenant" failure the
 * raw-SQL-scope runbook describes. `subscriber_id` is a globally-unique owner id
 * and the caller's roster is already scoped, so filtering by the owner set is
 * both correct and tighter (it also bounds the scan, mirroring fetchPresenceFleet).
 *
 * Best-effort by design: a read failure yields an empty map, so the Blocked
 * column degrades to empty and every agent still renders. A roster read must
 * never fail because one enrichment leg did.
 */
export async function openAwaitsByOwner(ownerIds: string[]): Promise<Map<string, OpenAwait>> {
  const out = new Map<string, OpenAwait>();
  if (ownerIds.length === 0) return out;
  try {
    const { sql } = getOrgPg();
    // P-016: read the EFFECTIVE view, not the raw table. A composed leaf's own
    // expires_ts is NULL by design (the root node owns the tree's deadline), and NULL
    // here renders as "waits forever" — the exact misreading that turned a healthy
    // 30-minute park into a reported deadlock.
    const rows = (await sql`
      SELECT DISTINCT ON (subscriber_id)
             subscriber_id, event_key, note, created_at,
             effective_expires_ts AS expires_ts
        FROM harness_shared.event_awaits_effective
       WHERE fired_at IS NULL
         AND cancelled_at IS NULL
         AND superseded_at IS NULL
         AND event_key NOT LIKE 'coord:inbox-wake:%'
         AND subscriber_id = ANY(${ownerIds}::text[])
       ORDER BY subscriber_id, created_at ASC
    `) as unknown as Array<{
      subscriber_id: string;
      event_key: string;
      note: string | null;
      created_at: Date | string;
      expires_ts: Date | string | null;
    }>;
    for (const r of rows) {
      if (!r.subscriber_id || !r.event_key) continue;
      out.set(r.subscriber_id, {
        eventKey: r.event_key,
        note: r.note ?? null,
        sinceIso: new Date(r.created_at).toISOString(),
        expiresIso: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
      });
    }
  } catch {
    /* best-effort: no awaits join → Blocked column empty, roster still renders */
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
 * chat-ref-pills-2026-07-26 P-007 finding: `spawnedAgentRunInfoByOwner` above
 * is the ONLY source `RosterEntry.harnessSlug` had, and it is scoped to
 * classic harness-SPAWNED runs (spawned_agents, paired with a runId for the
 * live-thinking-stream URL) — it has ZERO rows for an interactive psu/su
 * session (the entire live fleet today; verified 2026-07-26: `SELECT * FROM
 * spawned_agents WHERE status='running' AND session_owner IS NOT NULL` = 0
 * rows fleet-wide). That silently starved every OTHER `harnessSlug` consumer
 * that has nothing to do with the thinking-stream (SessionChatModal's
 * WI-/EI-/F- ref-pill popup destination, P-008), which no-ops for every real
 * session even though the pill itself renders + hydrates correctly.
 *
 * `harness_shared.session_briefs` is a second, already-populated per-owner
 * source: `writeSessionBrief` (presence.ts) upserts `harness_slug` on EVERY
 * presence declaration (coord:orient / declare-intent / bootstrap), so any
 * live psu/su session scoped to a harness has a fresh row here. Used ONLY as
 * a FALLBACK (spawned-run harness still wins when both exist) so the
 * thinking-stream's own runId-paired semantics are undisturbed.
 */
async function sessionBriefHarnessByOwner(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT owner_id, harness_slug
        FROM harness_shared.session_briefs
       WHERE harness_slug IS NOT NULL
    `) as unknown as Array<{ owner_id: string | null; harness_slug: string | null }>;
    for (const r of rows) {
      if (r.owner_id && r.harness_slug) out.set(r.owner_id, r.harness_slug);
    }
  } catch {
    /* best-effort — falls back to null harnessSlug (today's behavior) on any read error */
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
/**
 * "In the middle of thinking" (roster indicator) resolution for a set of
 * entries: a session whose transcript was appended within
 * SESSION_THINKING_ACTIVE_MS reads as actively thinking. Resolved in PARALLEL
 * (never a serial fs loop, per the perf docs) and best-effort — every backend's
 * transcript path is cached, so this is one cheap stat/agent. Claude sessions
 * key by sessionId (+owner fast path); codex by the adv row id (its CODEX_HOME
 * key); omp by thread id.
 *
 * Extracted from mergeRosterWithAssignments (WI-4734) so a latency-critical
 * caller can run the roster merge CONCURRENTLY with other work (thinking fully
 * deferred via `thinkingFor: () => false`) and resolve thinking POST-HOC for
 * just the entries it will actually surface — same safety condition as the
 * WI-3924 `thinkingFor` gate: only ever skip entries the caller never exposes.
 */
export async function resolveThinkingForEntries(
  entries: RosterEntry[],
  opts: { nowMs?: number } = {},
): Promise<void> {
  if (entries.length === 0) return;
  const { resolveSessionThinkingState, SESSION_THINKING_ACTIVE_MS } = await import('./claude-sessions');
  const { isCodexSessionThinking, isOmpThreadThinking } = await import('./session-transcript-resolvers');
  const nowMs = opts.nowMs ?? Date.now();
  await Promise.all(
    entries.map(async (e) => {
      if (e.sessionId) {
        // ONE resolve → both signals: `thinking` (transcript mtime recent) AND
        // `thinkingResolvable` (a transcript exists to stream at all). A parked/ended
        // claude session whose transcript is gone flips resolvable→false so the client
        // shows the honest "Live thinking unavailable" note, not an empty pane (WI-2680).
        const state = await resolveSessionThinkingState(e.sessionId, { owner: e.ownerId, nowMs })
          .catch(() => ({ resolvable: false, thinking: false }));
        e.thinking = state.thinking;
        e.thinkingResolvable = state.resolvable;
      } else if (e.agent === 'codex' && e.advSessionId != null) {
        e.thinking = await isCodexSessionThinking(e.advSessionId, { nowMs, activeMs: SESSION_THINKING_ACTIVE_MS }).catch(() => false);
      } else if (e.ompThreadId) {
        e.thinking = await isOmpThreadThinking(e.ompThreadId, { nowMs, activeMs: SESSION_THINKING_ACTIVE_MS }).catch(() => false);
      }
    }),
  );
}

export async function mergeRosterWithAssignments(
  opts: {
    workspaceId?: string | null;
    /**
     * WI-3924: gate the per-entry "thinking" resolution loop below. When
     * omitted (the default — EVERY existing caller), every active entry is
     * resolved, exactly as before. When provided, only entries the filter
     * accepts pay the per-entry transcript-stat cost; skipped entries keep
     * whatever pre-loop thinking/thinkingResolvable value they were created
     * with (NOT necessarily false — varies by roster source).
     *
     * SAFE ONLY for a caller that never exposes a skipped entry's
     * thinking/thinkingResolvable to its consumer — e.g. search-transcripts,
     * which only surfaces entries reachable via matchActiveEntry (built with
     * the IDENTICAL match rules via buildActiveEntryMatchFilter, so a
     * skipped entry is, by construction, one the caller never returns). Do
     * not pass this for a caller that displays the full active roster.
     */
    thinkingFor?: (entry: RosterEntry) => boolean;
  } = {},
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
    nurseryByOwner,
    sessionBriefHarness,
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
    // EI-348: nursery liveness join — needs only os.hostname() (sync, no
    // dependency on the other reads), so it belongs in this batch, not a
    // sequential await after it (WI-3924: every needless serialization point
    // adds to the roster-merge baseline the search-transcripts endpoint pays
    // on every query).
    runningSpawnLivenessByOwner(os.hostname()),
    // P-007 finding (see sessionBriefHarnessByOwner docblock): harnessSlug
    // fallback for interactive psu/su sessions, which spawnedAgentRunInfoByOwner
    // alone never covers.
    sessionBriefHarnessByOwner(),
  ]);
  const localPresence = scopePresenceToWorkspace(presenceAll, workspaceId);
  // Shared-hive federation: when presence-gossip is on, fold in cross-machine agents
  // (session-grain remote rows, each with its real ownerId + machineLabel) so the
  // roster spans every machine in the hive. Dedup against local owners; a read
  // failure degrades to the local roster. Flag-gated so a single-machine setup (flag
  // off) is unchanged. Enrichment (adv_sessions/claims/pid/thinking) is local-only;
  // federated rows degrade gracefully (no runId, no pid probe, thinking=false).
  let presence = localPresence;
  try {
    if (await getFlag(FLAGS.PRESENCE_GOSSIP, 'system')) {
      const fed = (await listFederatedPresence({ workspaceId }).catch(() => [])).filter(
        (r) => r.remoteSession,
      );
      const localOwners = new Set(localPresence.map((p) => p.ownerId));
      presence = [...localPresence, ...fed.filter((r) => !localOwners.has(r.ownerId))];
    }
  } catch {
    presence = localPresence;
  }
  // #3: per-owner fleet label + the fleet's accent color, for the pui roster grouping —
  // and the official standing-modes read (EI-7626), both batched, in parallel.
  const [fleetInfoByOwner, modesByOwner, awaitByOwner, verdictByOwner, accountPinByOwner] = await Promise.all([
    resolveFleetInfoByOwner(presence),
    agentModesByOwner(presence),
    // adv-hud P-001: the open-await join (HUD's Blocked column). Batched here
    // rather than awaited after — a serial hop would add to the roster-merge
    // baseline every caller pays (see the perf docs' serial-loop anti-pattern).
    // Scoped by the roster's OWNER IDS, not workspace — see openAwaitsByOwner.
    openAwaitsByOwner(presence.map((p) => p.ownerId)),
    // WI-6636: the SHARED liveness oracle. This roster used to derive liveness
    // from heartbeat freshness alone and so disagreed with every other surface —
    // it read 110 parked agents as "Stalled" on the default HUD board while
    // coord:presence called the same sessions `parked`. Batched here (one call
    // for the whole roster, never per-subject) beside the other joins.
    //
    // hydratePerId stays OFF: these subjects already carry heartbeat/stale/
    // host/pid/source from their presence rows, and per-id hydration is a
    // point-read per owner — right for the small-N bare-id callers, wrong for a
    // whole roster. Fail-soft is the caller's choice per the oracle's contract:
    // an empty map degrades every entry to sessionState null ("unknown"), which
    // deriveColumn treats as "fall back to the heartbeat legs", never as dead.
    resolveSessionStates(
      presence.map((p) => ({
        ownerId: p.ownerId,
        heartbeatAt: p.heartbeatAt,
        stale: p.stale,
        host: p.host,
        pid: p.pid,
        source: p.source,
        agentRole: p.agentRole ?? null,
      })),
    ).catch(() => new Map()),
    // P-003 (hud-chat-owner-controls): the workspace's dynamic account pins, so
    // the chat footer's ACCOUNT pill can read its current value synchronously
    // off the row it already rendered from (D-005 §6 / D-009 §D) instead of a
    // per-agent gateway:owner_report fetch on every popup open. ONE
    // single-row read for the WHOLE roster, batched here beside the other
    // joins rather than awaited after — a serial hop would add to the
    // roster-merge baseline every caller pays. Fail-soft: an empty map means
    // every entry reads `accountPin: null`, which is what an unpinned agent
    // reads anyway.
    getOwnerPinsMap(workspaceId ?? activeWorkspaceId()).catch(() => new Map<string, OwnerPin>()),
  ]);
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
    modesByOwner,
    { awaitByOwner, sessionBriefHarness, verdictByOwner, accountPinByOwner },
  );
  const active = enrichPidLiveness(entries, os.hostname());
  // Stamp local agents with this machine's label (federated rows already carry their
  // announced machineLabel) so the roster can group/tab by machine.
  const localLabel = machineFingerprint();
  for (const e of active) if (e.isLocal && !e.machineLabel) e.machineLabel = localLabel;
  // "In the middle of thinking" (roster indicator): a session whose transcript was
  // appended within SESSION_THINKING_ACTIVE_MS reads as actively thinking. Resolved
  // in PARALLEL (never a serial fs loop, per the perf docs) and best-effort — every
  // backend's transcript path is cached, so this is one cheap stat/agent. Claude
  // sessions key by sessionId (+owner fast path); codex by the adv row id (its
  // CODEX_HOME key); omp by thread id.
  // WI-3924: `thinkingFor`, when passed, restricts this loop to the entries
  // the caller will actually use — skipped entries pay no per-entry
  // transcript-stat cost (see the opts.thinkingFor doc comment above for the
  // safety condition this relies on).
  const thinkingCandidates = opts.thinkingFor ? active.filter(opts.thinkingFor) : active;
  await resolveThinkingForEntries(thinkingCandidates);
  return {
    active,
    // WI-5975: explicit single-arg — `.map(summarizeOrphan)` would pass the array
    // INDEX into the holder-activity parameter. This surface lists only genuine
    // orphans (holder dead), so the row's own liveness is the right input and the
    // verdict resolves to 'orphan'/'reclaim' as before.
    orphanedClaims: orphanedClaims(assignmentRows).map((r) => summarizeOrphan(r)),
  };
}

/** The active roster alone (mergeRosterWithAssignments minus the orphan list). */
export async function mergeRoster(
  opts: { workspaceId?: string | null } = {},
): Promise<RosterEntry[]> {
  return (await mergeRosterWithAssignments(opts)).active;
}
