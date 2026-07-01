/**
 * mcp-dark-watchdog — the safety net (Layer 4) for the "tool-less session after a deploy" class.
 *
 * THE GAP: a :3070 (papercup-dev-api) restart on every deploy drops each agent's long-lived
 * HTTP-MCP socket. Layers 1–3 make reconnection automatic (permanent signed URLs · name-sticky
 * approval · the always-up :9071 proxy fronting :3070). But if a client STILL fails to re-attach,
 * an agent can silently work on with NO `mcp__papercusp*` tools — a "dark" session — burning a
 * whole run tool-less with nobody noticing. This watches for exactly that and raises it.
 *
 * THE SIGNAL (why this is robust, not a guess): the two heartbeats a spawned bee carries have
 * DIFFERENT couplings —
 *   • coord_presence.heartbeat_at is TOOL-CALL-COUPLED — bumped only when the bee makes an MCP
 *     tool call (dispatch-heartbeat / coord:inbox / bootstrap). A dark MCP ⇒ it FREEZES.
 *   • spawned_agents.heartbeat_at is the SUPERVISOR beat — written out-of-band by the nursery/
 *     bg-host (a SEPARATE process from :3070 that a deploy does NOT restart), every ~60s while it
 *     holds the child. A dark MCP ⇒ it stays FRESH (the process is alive).
 *   • spawned_agents.last_output_at is the child's stdout — FRESH ⇒ the bee is actively generating
 *     RIGHT NOW (a live turn that NEEDS its tools), not idle/parked.
 * So a running bee that is (a) alive (supervisor fresh), (b) actively generating output, yet (c)
 * has made ZERO successful MCP calls since the operator came back up (presence heartbeat predates
 * the restart), after (d) a grace window for the client's own reconnect — is working DARK. Very low
 * false-positive: the only benign match is a bee doing ONLY local tools (Read/Edit/Bash) for the
 * whole grace window post-restart, and the response is a claimable inbox nudge, not a page.
 *
 * Process-level (NOT a DBOS routine) for the same reason as the git-sync/green stall watchdogs: a
 * routine-based watchdog queues on the very engine a wedge would freeze.
 *
 * restartAt = this watchdog's own start time. It starts at operator boot, so "presence heartbeat
 * older than restartAt" == "no successful MCP call landed since :3070 came back". No restart-event
 * table needed.
 *
 * On alarm (per newly-dark owner, cross-process exactly-once via an INSERT…ON CONFLICT DO NOTHING
 * claim on harness_escalations): a consolidated owner `notifyAttention` + a fleet BROADCAST
 * (severe-event-broadcast — reaches the HEALTHY agents + the Queen, who can relaunch the dark bee;
 * the dark bee itself can't read its own inbox, which is the whole point). Recovery (the bee
 * reconnects — presence advances past restartAt — or exits) clears its escalation row idempotently.
 *
 * Kill-switch: PAPERCUSP_MCP_DARK_WATCHDOG='0'.
 */
import os from 'node:os';
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent } from '../severe-event-broadcast';

/** Supervisor beat is ~60s; fresh within 3× ⇒ the process is alive. */
const DEFAULT_SUPERVISOR_FRESH_MS = 3 * 60_000; // 3 min
/** Child stdout within this window ⇒ the bee is actively generating (a live turn that needs tools). */
const DEFAULT_WORKING_MS = 5 * 60_000; // 5 min
/** Grace after the restart for the client's OWN reconnect before we alarm. */
const DEFAULT_GRACE_MS = 5 * 60_000; // 5 min
/** How often the watchdog sweeps. Prompt enough to catch a dark run early, not spammy. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60_000; // 5 min

/** The per-owner harness_escalations phase prefix — one transient row per dark bee. */
const PHASE_PREFIX = 'mcp-dark:';

export interface McpDarkThresholds {
  supervisorFreshMs?: number;
  workingMs?: number;
  graceMs?: number;
}

/** The per-bee snapshot the verdict is computed from (all epoch ms; null = absent). */
export interface McpDarkSnapshot {
  ownerId: string;
  /** spawned_agents.started_at — the bee must predate the restart to be "should-have-reconnected". */
  startedMs: number | null;
  /** spawned_agents.heartbeat_at — the deploy-surviving supervisor beat (process-alive). */
  supervisorHeartbeatMs: number | null;
  /** spawned_agents.last_output_at — child stdout (actively-generating). */
  lastOutputMs: number | null;
  /** coord_presence.heartbeat_at — the TOOL-CALL-COUPLED beat (dark MCP ⇒ frozen). */
  presenceHeartbeatMs: number | null;
}

export interface McpDarkVerdict {
  dark: boolean;
  /** Human reason for the alarm body, or null when not dark. */
  reason: string | null;
}

const mins = (ms: number): number => Math.round(ms / 60_000);

/**
 * Pure: is this running bee working with a DARK MCP binding? All five gates must hold (see the
 * module header for the full rationale). Exported for unit testing; the DB wiring is in
 * checkMcpDark.
 */
export function evaluateMcpDark(
  s: McpDarkSnapshot,
  restartAtMs: number,
  nowMs: number,
  opts: McpDarkThresholds = {},
): McpDarkVerdict {
  const supervisorFreshMs = opts.supervisorFreshMs ?? DEFAULT_SUPERVISOR_FRESH_MS;
  const workingMs = opts.workingMs ?? DEFAULT_WORKING_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  // (e) grace: give the client's own reconnect time to land before we alarm.
  if (nowMs - restartAtMs <= graceMs) return { dark: false, reason: null };
  // (a) existed before the restart ⇒ it SHOULD have reconnected (a bee spawned after is just booting).
  if (s.startedMs == null || s.startedMs >= restartAtMs) return { dark: false, reason: null };
  // (b) process alive: the deploy-surviving supervisor beat is fresh.
  const alive = s.supervisorHeartbeatMs != null && nowMs - s.supervisorHeartbeatMs < supervisorFreshMs;
  if (!alive) return { dark: false, reason: null };
  // (c) actively generating output right now (a live turn that needs its tools — not idle/parked).
  const working = s.lastOutputMs != null && nowMs - s.lastOutputMs < workingMs;
  if (!working) return { dark: false, reason: null };
  // (d) NO successful MCP call since the restart — the tool-call-coupled beat predates it (or absent).
  const reconnected = s.presenceHeartbeatMs != null && s.presenceHeartbeatMs >= restartAtMs;
  if (reconnected) return { dark: false, reason: null };

  const lastMcp =
    s.presenceHeartbeatMs == null
      ? 'never (no coord_presence row)'
      : `~${mins(nowMs - s.presenceHeartbeatMs)}m ago, before the restart`;
  return {
    dark: true,
    reason:
      `alive (supervisor beat ~${mins(nowMs - s.supervisorHeartbeatMs!)}m) and generating output ` +
      `(~${mins(nowMs - s.lastOutputMs!)}m ago), but its last MCP tool call was ${lastMcp} — it has ` +
      `NOT re-attached its papercusp MCP since :3070 restarted ~${mins(nowMs - restartAtMs)}m ago, so ` +
      `it is working tool-less (dark).`,
  };
}

/** Pure: the harness_escalations body for one dark bee (testable). */
export function mcpDarkEscalationBody(opts: {
  ownerId: string;
  reason: string;
  restartAtMs: number;
  nowMs: number;
}): string {
  return JSON.stringify({
    kind: 'mcp-dark-watchdog',
    owner_id: opts.ownerId,
    boot_at: opts.restartAtMs,
    emitted_at: opts.nowMs,
    detail:
      `Agent ${opts.ownerId} is working with a DARK papercusp MCP binding: ${opts.reason} ` +
      `Layers 1–3 (permanent signed URLs · name-sticky approval · the :9071 proxy) should auto-heal ` +
      `this; if it persists, RELAUNCH the bee (its fresh process re-mints + re-approves a clean MCP ` +
      `config). It cannot read its own inbox (that needs MCP), so this must be actioned by a peer/owner.`,
  });
}

export interface McpDarkWatchdogResult {
  darkOwners: string[];
  /** Owners this pass NEWLY claimed (fired an alarm for) — cross-process exactly-once. */
  alarmed: string[];
  recovered: string[];
}

/**
 * One watchdog pass: scan every running/restarting spawned bee, join its tool-call-coupled presence
 * beat, evaluate darkness, claim each newly-dark owner exactly once (INSERT…ON CONFLICT DO NOTHING),
 * fire a consolidated owner notify + fleet broadcast for the claimed set, and clear the escalation
 * of any owner that has recovered (reconnected or exited). Never throws.
 */
export async function checkMcpDark(
  sql: Sql,
  restartAtMs: number,
  opts: McpDarkThresholds = {},
): Promise<McpDarkWatchdogResult> {
  const out: McpDarkWatchdogResult = { darkOwners: [], alarmed: [], recovered: [] };
  try {
    const rows = await sql<
      {
        owner_id: string;
        harness_slug: string | null;
        workspace_id: string | null;
        presence_label: string | null;
        started_ms: string | number | null;
        supervisor_heartbeat_ms: string | number | null;
        last_output_ms: string | number | null;
        presence_heartbeat_ms: string | number | null;
      }[]
    >`
      SELECT sa.session_owner AS owner_id,
             sa.harness_slug,
             sa.workspace_id,
             cp.owner_label AS presence_label,
             extract(epoch from sa.started_at) * 1000     AS started_ms,
             extract(epoch from sa.heartbeat_at) * 1000   AS supervisor_heartbeat_ms,
             extract(epoch from sa.last_output_at) * 1000 AS last_output_ms,
             extract(epoch from cp.heartbeat_at) * 1000   AS presence_heartbeat_ms
        FROM harness_shared.spawned_agents sa
        LEFT JOIN harness_shared.coord_presence cp
               ON cp.owner_id = sa.session_owner
       WHERE sa.status IN ('running', 'restarting')
         AND sa.session_owner IS NOT NULL`;

    const now = Date.now();
    const num = (v: string | number | null): number | null => (v != null ? Number(v) : null);

    const dark: Array<{
      ownerId: string;
      harnessSlug: string;
      workspaceId: string | null;
      reason: string;
    }> = [];
    for (const row of rows) {
      const verdict = evaluateMcpDark(
        {
          ownerId: row.owner_id,
          startedMs: num(row.started_ms),
          supervisorHeartbeatMs: num(row.supervisor_heartbeat_ms),
          lastOutputMs: num(row.last_output_ms),
          presenceHeartbeatMs: num(row.presence_heartbeat_ms),
        },
        restartAtMs,
        now,
        opts,
      );
      if (verdict.dark && verdict.reason) {
        dark.push({
          ownerId: row.owner_id,
          harnessSlug: row.harness_slug ?? 'unknown',
          workspaceId: row.workspace_id,
          reason: verdict.reason,
        });
      }
    }
    out.darkOwners = dark.map((d) => d.ownerId);

    // ── Claim each newly-dark owner exactly once (cross-process safe). ──
    const newly: typeof dark = [];
    for (const d of dark) {
      const claimed = await sql`
        INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES (${d.harnessSlug}, ${PHASE_PREFIX + d.ownerId}, ${mcpDarkEscalationBody({
          ownerId: d.ownerId,
          reason: d.reason,
          restartAtMs,
          nowMs: now,
        })}, ${now}, ${d.workspaceId})
        ON CONFLICT (harness_slug, phase) DO NOTHING
        RETURNING phase`;
      if (claimed.length === 1) newly.push(d);
    }

    if (newly.length > 0) {
      out.alarmed = newly.map((d) => d.ownerId);
      const list = newly.map((d) => d.ownerId).join(', ');
      const summary = `${newly.length} agent(s) working MCP-DARK after a :3070 restart — tool-less, need a reconnect/relaunch: ${list}.`;
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: `${newly.length} agent(s) working MCP-dark (tool-less) after a restart`,
          body:
            `${summary}\n\n${newly[0].reason}\n\nLayers 1–3 should auto-heal this; if it persists, ` +
            `relaunch the bee(s). They can't read their own inbox (needs MCP), so a peer/owner must act.`,
          importance: 'high',
          workspaceId: newly[0].workspaceId ?? undefined,
          data: { darkOwners: newly.map((d) => d.ownerId) },
        });
      } catch (e) {
        console.warn(`[mcp-dark-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      // Fleet broadcast: inject-only (wake=false). Reaches the HEALTHY agents + the Queen (the dark
      // bee itself can't — its inbox read needs MCP), so someone relaunches it.
      await broadcastSevereEvent({
        summary,
        body:
          `These agents are alive + actively generating output but have NOT re-attached their papercusp ` +
          `MCP since :3070 last restarted, so they're burning a run tool-less. Claim it: relaunch the ` +
          `listed bee(s) (a fresh process re-mints + re-approves a clean MCP config). Owners: ${list}.`,
        category: 'severe-event',
      });
      console.warn(`[mcp-dark-watchdog] ALARM: ${list}`);
    }

    // ── Recovery: clear the escalation of any previously-dark owner no longer dark. ──
    const alertedRows = await sql<{ phase: string }[]>`
      SELECT phase FROM harness_shared.harness_escalations
       WHERE phase LIKE ${PHASE_PREFIX + '%'} AND escalation IS NOT NULL`;
    const darkPhases = new Set(dark.map((d) => PHASE_PREFIX + d.ownerId));
    const toRecover = alertedRows.map((r) => r.phase).filter((p) => !darkPhases.has(p));
    if (toRecover.length > 0) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE phase = ANY(${toRecover}) AND escalation IS NOT NULL`;
      out.recovered = toRecover.map((p) => p.slice(PHASE_PREFIX.length));
    }
    return out;
  } catch (e) {
    console.warn(`[mcp-dark-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ManagedHandle | null = null;
let restartAtMs: number | null = null;

/**
 * Start the watchdog: a grace-delayed boot check + a recurring process-level sweep. restartAt is
 * pinned to this call (== operator boot). Idempotent. Kill-switch: PAPERCUSP_MCP_DARK_WATCHDOG='0'.
 */
export function startMcpDarkWatchdog(
  sql: Sql,
  opts: McpDarkThresholds & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_MCP_DARK_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
  restartAtMs = Date.now();
  const bootAt = restartAtMs;

  const run = (): void => {
    void checkMcpDark(sql, bootAt, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[mcp-dark-watchdog] alarmed on: ${r.alarmed.join(', ')} (host ${os.hostname()})`);
      }
    });
  };

  if (watchdogTimer) watchdogTimer.stop();
  // No immediate boot check: within the grace window every session legitimately predates the
  // restart, so the first useful sweep is one interval in (past the grace gate).
  watchdogTimer = managedSetInterval('mcp-dark-watchdog', intervalMs, run, { category: 'watchdog' });
}
