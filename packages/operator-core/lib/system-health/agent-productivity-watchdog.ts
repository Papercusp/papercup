/**
 * agent-productivity-watchdog — the present-but-unproductive sweep, for EVERY
 * agent rather than only a goal's holder.
 *
 * SIBLING of goal-liveness-watchdog's wedge leg (EI-21578742955425881), and the
 * generalisation of it. That leg asks the question of goal HOLDERS only, which
 * is where the condition was first noticed but not where it lives: a wedge is a
 * property of an agent SESSION. Both legs now decide through the one rule in
 * `agent-wedge.ts`, so they cannot drift apart.
 *
 * ── WHAT IT SEES THAT NOTHING ELSE DOES ─────────────────────────────────────
 *
 * Measured workspace-wide 2026-08-27T06:08Z: of 166 sessions past the grace
 * window, 22 had made ZERO agent-origin tool calls since `started_at` — 11 of
 * them fleet members. Every one was reported `wakeable: true` by
 * `coord:presence`, which is exactly the field a dispatcher reads to decide who
 * can take work; one had been wakeable for eighteen hours having never made a
 * single call of any origin. No surface was wrong and nothing alarmed:
 * heartbeats fresh, `sessionState` a legitimate `parked`, claims empty. The
 * counts are all healthy because none of them counts THIS.
 *
 * The cost is paid by whoever dispatches to them. Waking a wedged session
 * succeeds — the wake lands, `woken: 1` comes back — and nothing happens.
 *
 * ── WHY ONE CORRELATED WAVE, NOT N ALARMS ───────────────────────────────────
 *
 * The single most important design choice here. Wedge causes are CORRELATED:
 * one throttled account pool, one unlaunchable model id, one bad launcher
 * generation wedges every session it touched, all at once. A detector that
 * escalates per victim turns one cause into twenty-two identical reports, and
 * twenty-two copies of the same sentence is not twenty-two times the signal —
 * it is noise that buries the one fact that matters (they share a cause).
 *
 * So victims are grouped into WAVES by (workspace, phase), with the fleet
 * breakdown carried inside the body. `phase` is the grouping dimension because
 * it IS the cause dimension:
 *
 *   `never-booted`        the session never ran its start hooks — nothing
 *                         executed in that process at all, yet presence exists
 *                         and its heartbeat is fresh. The fault is in the
 *                         LAUNCHER or the presence writer.
 *   `booted-never-worked` the process came up, ran its hooks, and never took a
 *                         turn — a first-turn 429, an unlaunchable model, a
 *                         wedged CLI. The fault is in the SESSION.
 *
 * Two phases, two unrelated repairs, and each repair is actively wrong for the
 * other population: respawning a `never-booted` row re-runs a launcher that has
 * already failed, and nothing about relaunching the presence layer helps a
 * session that is genuinely up.
 *
 * ── REPORT-ONLY, AND THAT IS A DECISION ─────────────────────────────────────
 *
 * It never respawns anything. The same correlation that makes one wave the
 * right report makes auto-recovery the wrong action: N respawns fired into the
 * wall that caused the wedge spend the little capacity left on relaunches that
 * will wedge again. Recovery belongs to a caller that can also see whether
 * capacity exists — which is why goal-holder respawn sits behind its own
 * default-OFF owner-authority flag rather than being wired to this signal.
 *
 * Design notes:
 *  - `managedSetInterval`, category 'watchdog' — visible in schedule:inventory.
 *  - Runtime gate: FLAGS.AGENT_PRODUCTIVITY_WATCHDOG (default ON; kill-switch
 *    at /admin/features), independent of the goal legs' flags.
 *  - Dedup is delegated to openEscalation's (dedupKind, subjectSignature) PG
 *    dedup — no new state surface.
 *  - UNKNOWN SUPPRESSES, throughout. `resolveSessionStates` omits an entry when
 *    its wakeability fetch degrades, and a subject missing from the productivity
 *    census is unmeasured, not idle. Both are skipped rather than reported, so a
 *    transient DB hiccup costs silence instead of a false wave across every
 *    agent at once.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  resolveSessionStates,
  type LivenessVerdict,
} from '../agent-tools/coordination/liveness-oracle';
// The alive predicate is generic in substance despite its goal-shaped NAME
// (ended ⇒ false; parked with no self-wake ⇒ false; otherwise present). Importing
// it keeps ONE definition of "will this session take a turn"; re-deriving it here
// would be the exact duplication this module exists to avoid.
import { holderCountsAsAlive } from '../goals/holder';
import {
  AGENT_PRODUCTIVITY_GRACE_MS,
  resolveAgentWedge,
  type AgentWedgePhase,
} from '../agent-wedge';

export const AGENT_PRODUCTIVITY_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * How stale a heartbeat may be for a row to remain a CANDIDATE.
 *
 * Deliberately generous, and not a liveness judgement — the oracle makes that.
 * This bound exists only to keep the candidate set (and therefore the census
 * query) bounded; erring wide costs a few extra oracle lookups, while erring
 * narrow would silently drop real victims before they are ever measured.
 */
const CANDIDATE_HEARTBEAT_WINDOW_MS = 10 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'agent-productivity-watchdog',
  ownerLabel: 'system · agent productivity',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One presence row, reduced to what this sweep needs. */
export interface AgentPresenceCandidate {
  ownerId: string;
  ownerLabel: string;
  workspaceId: string;
  agentRole: string | null;
  fleetSlug: string | null;
  source: string | null;
  host: string | null;
  pid: number | null;
  heartbeatAt: string;
  /** ms epoch the session's presence row was created. */
  startedAtMs: number;
}

/** The invocation census for one candidate. */
export interface AgentCallCensus {
  /** Hook-origin EXCLUDED — see makeReadAgentProductivity's warning. */
  agentOriginCalls: number;
  /** Every origin, hook included — the phase discriminator. */
  anyOriginCalls: number;
}

/** One wedged agent, as reported inside a wave. */
export interface AgentWedgeVictim {
  ownerId: string;
  ownerLabel: string;
  fleetSlug: string | null;
  agentRole: string | null;
  sessionState: string | null;
  presentForMs: number;
  agentOriginCalls: number;
  anyOriginCalls: number;
}

/** A correlated group of victims sharing a workspace and a phase. */
export interface AgentWedgeWave {
  workspaceId: string;
  phase: AgentWedgePhase;
  victims: AgentWedgeVictim[];
}

export interface AgentProductivitySweepDeps {
  /** Presence rows old enough to judge, with a heartbeat recent enough to bother. */
  readCandidates: (graceMs: number) => Promise<AgentPresenceCandidate[]>;
  /**
   * The liveness oracle over those rows. A subject ABSENT from the returned map
   * is UNKNOWN and is suppressed — never read as dead.
   */
  resolveLiveness: (
    candidates: readonly AgentPresenceCandidate[],
  ) => Promise<Map<string, LivenessVerdict>>;
  /**
   * The invocation census, keyed by ownerId. A candidate ABSENT from the map is
   * `not-measured` and is suppressed, so a degraded read costs silence rather
   * than a wave of false alarms.
   */
  readProductivity: (
    candidates: readonly AgentPresenceCandidate[],
  ) => Promise<Map<string, AgentCallCensus>>;
  escalateWave: (wave: AgentWedgeWave) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  graceMs: number;
}

/**
 * The candidate read. Bounded two ways on purpose: old enough that the grace
 * cannot have elapsed mid-flight, and heartbeating recently enough that the row
 * is worth an oracle lookup.
 */
export function makeReadCandidates(sql: Sql): AgentProductivitySweepDeps['readCandidates'] {
  return async (graceMs) => {
    const rows = await sql<
      {
        owner_id: string;
        owner_label: string;
        workspace_id: string;
        agent_role: string | null;
        fleet_slug: string | null;
        source: string | null;
        host: string | null;
        pid: number | null;
        heartbeat_at: Date;
        started_at: Date;
      }[]
    >`
      SELECT owner_id, owner_label, workspace_id, agent_role, fleet_slug,
             source, host, pid, heartbeat_at, started_at
        FROM harness_shared.coord_presence
       WHERE heartbeat_at > now() - make_interval(secs => ${CANDIDATE_HEARTBEAT_WINDOW_MS / 1000})
         AND started_at   < now() - make_interval(secs => ${graceMs / 1000})`;

    return rows.map((r) => ({
      ownerId: r.owner_id,
      ownerLabel: r.owner_label,
      workspaceId: r.workspace_id,
      agentRole: r.agent_role,
      fleetSlug: r.fleet_slug,
      source: r.source,
      host: r.host,
      pid: r.pid,
      heartbeatAt: r.heartbeat_at.toISOString(),
      startedAtMs: r.started_at.getTime(),
    }));
  };
}

/**
 * The measurement, from the invocation ledger.
 *
 * ⚠ `call_origin IS DISTINCT FROM 'hook'`, NOT `<> 'hook'`. Excluding
 * hook-origin calls IS the signal — a session that boots and immediately fails
 * still emits hook-fired calls (`coord:glance`, `activity:report` on the
 * session-start hook), so a raw count is non-zero for an agent that never ran an
 * instruction of its own (measured: raw 2–5, agent-origin 0). But `<> 'hook'` is
 * FALSE for a NULL origin, which would silently drop those rows and undercount
 * toward a FALSE WEDGE — the one direction this must never err in.
 * `IS DISTINCT FROM` counts a NULL (and the `unknown`/`ui` origins the column
 * actually carries) as work, erring toward silence.
 *
 * `since` travels PER ROW: an owner is answerable only for calls made after ITS
 * session started, so a floor shared across candidates would credit one session
 * with a predecessor's work.
 */
export function makeReadAgentProductivity(
  sql: Sql,
): AgentProductivitySweepDeps['readProductivity'] {
  return async (candidates) => {
    const out = new Map<string, AgentCallCensus>();
    if (candidates.length === 0) return out;

    const ownerIds = candidates.map((c) => c.ownerId);
    const workspaceIds = candidates.map((c) => c.workspaceId);
    const sinceIso = candidates.map((c) => new Date(c.startedAtMs).toISOString());

    const rows = await sql<{ owner_id: string; agent_calls: string; any_calls: string }[]>`
      WITH subjects AS (
        SELECT * FROM unnest(
          ${ownerIds}::text[],
          ${workspaceIds}::text[],
          ${sinceIso}::timestamptz[]
        ) AS t(owner_id, workspace_id, since)
      )
      SELECT s.owner_id,
             count(ti.id) FILTER (
               WHERE ti.call_origin IS DISTINCT FROM 'hook'
             ) AS agent_calls,
             count(ti.id) AS any_calls
        FROM subjects s
        LEFT JOIN harness_shared.tool_invocations ti
               ON ti.coord_owner_id = s.owner_id
              AND ti.workspace_id   = s.workspace_id
              AND ti.invoked_at    >= s.since
       GROUP BY 1`;

    for (const r of rows) {
      out.set(r.owner_id, {
        agentOriginCalls: Number(r.agent_calls),
        anyOriginCalls: Number(r.any_calls),
      });
    }
    return out;
  };
}

function defaultResolveLiveness(): AgentProductivitySweepDeps['resolveLiveness'] {
  return async (candidates) =>
    // `selfWake: true` is REQUIRED, not an optimisation: without it every parked
    // session looks equally wakeable, and `holderCountsAsAlive` cannot tell a
    // session that will wake itself from one waiting for a wake that never comes.
    await resolveSessionStates(
      candidates.map((c) => ({
        ownerId: c.ownerId,
        heartbeatAt: c.heartbeatAt,
        host: c.host,
        pid: c.pid,
        source: c.source,
        agentRole: c.agentRole,
      })),
      { selfWake: true },
    );
}

const PHASE_PROSE: Record<AgentWedgePhase, string> = {
  'never-booted':
    'These sessions made NO tool calls at all — not even the hook-origin calls every ' +
    'session emits on start-up. Nothing ran in those processes, yet a presence row exists ' +
    'for each with a fresh heartbeat. The fault is in the LAUNCHER or the presence writer, ' +
    'not in the sessions: there is nothing there to restart.',
  'booted-never-worked':
    'These sessions came up and ran their start-up hooks, then never took a turn — the ' +
    'classic wedge (a first-turn 429, a model id that resolves to no CLI backend, a wedged ' +
    'CLI). The processes are genuinely there, so this is the phase where a respawn is even ' +
    'a candidate — but only once the shared cause below is understood.',
};

/**
 * Report-only. NEVER respawns, and that is a decision rather than an omission —
 * see the module header on correlation.
 */
async function defaultEscalateWave(wave: AgentWedgeWave): Promise<void> {
  const n = wave.victims.length;
  const byFleet = new Map<string, AgentWedgeVictim[]>();
  for (const v of wave.victims) {
    const key = v.fleetSlug ?? '(no fleet)';
    const list = byFleet.get(key);
    if (list) list.push(v);
    else byFleet.set(key, [v]);
  }

  const fleetLines = [...byFleet.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([fleet, vs]) => {
      const oldest = Math.max(...vs.map((v) => v.presentForMs));
      return `  • ${fleet} — ${vs.length} session(s), oldest present ${formatDuration(oldest)}: ${vs
        .slice(0, 6)
        .map((v) => v.ownerLabel)
        .join(', ')}${vs.length > 6 ? `, +${vs.length - 6} more` : ''}`;
    });

  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${n} agent session(s) are present and have NEVER produced work (${wave.phase}) ` +
      `in workspace ${wave.workspaceId}`,
    body:
      `${n} session(s) resolve as present — the liveness oracle reports them wakeable, so ` +
      `every dispatcher counts them as able to take work — and have made ZERO agent-origin ` +
      `tool calls since they started.\n\n` +
      `${PHASE_PROSE[wave.phase]}\n\n` +
      `Grouped by fleet:\n${fleetLines.join('\n')}\n\n` +
      `ONE report, not ${n}: wedge causes are CORRELATED — a throttled account pool, an ` +
      `unlaunchable model id, a bad launcher generation takes out everything it touched at ` +
      `once — so the fact worth acting on is that these share a cause, which ${n} separate ` +
      `alarms would bury. Look for what they have in common (launch window, account, model, ` +
      `fleet) before looking at any one of them.\n\n` +
      `Reported, never auto-recovered: respawning N wedged sessions fires them straight back ` +
      `into the wall that wedged them, spending the capacity that is already short. Recovery ` +
      `belongs to a caller that can also see whether capacity exists.\n\n` +
      `Hook-origin calls are excluded from the count deliberately — a session that boots and ` +
      `fails its first turn still emits those, which is why a raw invocation count reads ` +
      `healthy for an agent that never ran an instruction of its own.`,
    meta: {
      dedupKind: 'agent-productivity-wedge',
      subjectSignature: `${wave.workspaceId}:${wave.phase}`,
      workspaceId: wave.workspaceId,
      phase: wave.phase,
      victimCount: n,
      victims: wave.victims.slice(0, 40),
    },
  });
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 90) return `${min}m`;
  return `${Math.round(min / 6) / 10}h`;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.AGENT_PRODUCTIVITY_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

export function agentProductivitySweepDeps(
  sql: Sql,
  overrides: Partial<AgentProductivitySweepDeps> = {},
): AgentProductivitySweepDeps {
  return {
    readCandidates: makeReadCandidates(sql),
    resolveLiveness: defaultResolveLiveness(),
    readProductivity: makeReadAgentProductivity(sql),
    escalateWave: defaultEscalateWave,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    graceMs: AGENT_PRODUCTIVITY_GRACE_MS,
    ...overrides,
  };
}

/**
 * One sweep: read candidates, resolve presence, measure productivity, group the
 * wedged into correlated waves, escalate one report per wave.
 *
 * A failed escalate is swallowed per wave so one bad group cannot cost the rest
 * of the batch; the escalation-side dedup makes the next tick's retry idempotent.
 * Exported for tests.
 */
export async function runAgentProductivitySweepOnce(
  sql: Sql,
  overrides: Partial<AgentProductivitySweepDeps> = {},
): Promise<{
  scanned: number;
  present: number;
  wedged: number;
  unmeasured: number;
  wavesEscalated: number;
}> {
  const deps = agentProductivitySweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) {
    return { scanned: 0, present: 0, wedged: 0, unmeasured: 0, wavesEscalated: 0 };
  }

  const candidates = await deps.readCandidates(deps.graceMs);
  if (candidates.length === 0) {
    return { scanned: 0, present: 0, wedged: 0, unmeasured: 0, wavesEscalated: 0 };
  }

  const [verdicts, census] = await Promise.all([
    deps.resolveLiveness(candidates),
    deps.readProductivity(candidates),
  ]);

  const now = deps.now();
  const waves = new Map<string, AgentWedgeWave>();
  let present = 0;
  let wedged = 0;
  let unmeasured = 0;

  for (const c of candidates) {
    const verdict = verdicts.get(c.ownerId);
    // Absent from the oracle ⇒ UNKNOWN, never dead and never present.
    if (!verdict) continue;
    if (!holderCountsAsAlive(verdict)) continue;
    present += 1;

    const measured = census.get(c.ownerId);
    const v = resolveAgentWedge({
      presence: 'present',
      productivity: measured
        ? {
            agentOriginCalls: measured.agentOriginCalls,
            anyOriginCalls: measured.anyOriginCalls,
            presentForMs: now - c.startedAtMs,
          }
        : null,
      graceMs: deps.graceMs,
    });

    if (v.reason === 'not-measured') unmeasured += 1;
    // `phase` is null only when the census did not supply anyOriginCalls, which
    // cannot happen on this path — but a wave keyed on a null phase would be a
    // group with no repair, so it is skipped rather than invented.
    if (!v.wedged || v.phase === null || !measured) continue;
    wedged += 1;

    const key = `${c.workspaceId}:${v.phase}`;
    const wave =
      waves.get(key) ?? ({ workspaceId: c.workspaceId, phase: v.phase, victims: [] } as AgentWedgeWave);
    wave.victims.push({
      ownerId: c.ownerId,
      ownerLabel: c.ownerLabel,
      fleetSlug: c.fleetSlug,
      agentRole: c.agentRole,
      sessionState: verdict.sessionState,
      presentForMs: now - c.startedAtMs,
      agentOriginCalls: measured.agentOriginCalls,
      anyOriginCalls: measured.anyOriginCalls,
    });
    waves.set(key, wave);
  }

  let wavesEscalated = 0;
  for (const wave of waves.values()) {
    try {
      await deps.escalateWave(wave);
      wavesEscalated += 1;
    } catch (e) {
      console.warn(
        `[agent-productivity-watchdog] escalate failed for ${wave.workspaceId}:${wave.phase} ` +
          `(non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { scanned: candidates.length, present, wedged, unmeasured, wavesEscalated };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Idempotent. Runtime gate: FLAGS.AGENT_PRODUCTIVITY_WATCHDOG (checked per tick,
 * so the kill-switch takes effect without a restart).
 */
export function startAgentProductivityWatchdog(
  sql: Sql,
  opts: { intervalMs?: number } = {},
): void {
  const intervalMs = opts.intervalMs ?? AGENT_PRODUCTIVITY_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'agent-productivity-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runAgentProductivitySweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[agent-productivity-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // The alarm condition is an agent present for a WINDOW without having
    // worked. Nothing emits an event for work that never happened, so the
    // passage of time in that state is the only trigger available.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
