/**
 * watchdog.ts — the hive LIVENESS BACKSTOP
 * (start-hive-wake-orchestration-2026-06-09 Phase 3: P-008…P-012, D-002/D-003/D-004).
 *
 * One invariant (D-002): **a time wake is ALWAYS armed while the hive is
 * started.** The Queen sets her own cadence (hive:declare-wake — including
 * effectively-continuous); events move the next wake earlier; THIS module
 * guarantees the wake EXISTS when she forgot; Pause (started=false) is the only
 * thing allowed to clear it.
 *
 * This is a dead-man's switch, NOT a cadence (D-003): every check is a cheap
 * deterministic SQL read, and the wake it may arm is the exception path. Three
 * seams call in:
 *   - **turn-end** (P-009) — the invoke route, after a `bpkind=hive` launch
 *     finishes: started && no wake armed → arm the fallback.
 *   - **boot** (P-010) — host bootstrap: a started hive with no wake armed
 *     (the process died mid-turn, the turn-end hook never ran) → arm.
 *   - **tick** (P-011) — the 30s routinesTick sweep: started + demand + no wake
 *     + not mid-turn + stale → arm. Belt-and-braces.
 *
 * When she forgot, arm a default SLEEP — never an immediate re-invoke (D-004):
 * a broken-prompt Queen must fail toward "sleeps too long" (cheap), never
 * toward "runs continuously" (expensive). Every fire is recorded in
 * `harness_shared.hive_watchdog_fires` (mig 212) — frequent fires are a Queen
 * prompt bug to FIX, not a mechanism to lean on.
 *
 * Wake-mode composition (P-013): in global `manual` mode the fallback is not a
 * silent self-arm — it routes through `wakeRecipients` to the pinned brain
 * owner, where the SHIPPED gate stages it for owner review like any other wake.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { declareHiveTimeWake, getHiveTimeWake, readHiveWakeState } from './wake';
import { getHiveStarted, listStartedWorkspaceLoops } from './started';

// ── tunables (env-overridable, like the wake floor) ──────────────────────────

/** The fallback sleep the watchdog arms when the Queen forgot to declare
 *  (D-004 / OQ-3: default 30 min — failing toward "sleeps too long" is cheap). */
export function watchdogFallbackSleepSec(): number {
  const n = Number(process.env.PAPERCUSP_HIVE_WATCHDOG_SLEEP_SEC ?? 1800);
  return Number.isFinite(n) && n >= 60 ? n : 1800;
}

/** How long a started, unarmed, demand-bearing hive must be quiet before the
 *  routinesTick sweep fires (OQ-3: default 15 min). The turn-end + boot seams
 *  don't wait this out — they KNOW the turn just ended / the host just booted. */
export function watchdogStaleSec(): number {
  const n = Number(process.env.PAPERCUSP_HIVE_WATCHDOG_STALE_SEC ?? 900);
  return Number.isFinite(n) && n >= 30 ? n : 900;
}

// ── P-008: the pure liveness read ────────────────────────────────────────────

export interface HiveLiveness {
  /** D-002's one-row check: an ACTIVE hive-wake routine with a next_fire_at exists. */
  armed: boolean;
  nextFireAt: Date | null;
  lastFiredAt: Date | null;
  /** ms since the last wake activity (launch fire or routine fire); null = never. */
  staleForMs: number | null;
}

/**
 * The one-row liveness check the whole invariant rests on (P-008/D-002):
 * "is the Queen alive?" ⇒ does an active wake row exist, and how long since
 * the last wake activity if not.
 */
export async function hiveLivenessCheck(
  sql: Sql,
  installSlug: string,
  opts: { workspaceId?: string; now?: number } = {},
): Promise<HiveLiveness> {
  const now = opts.now ?? Date.now();
  // K1 (workspace-scoped-coordination P-003): thread the workspace so the
  // read-fallback resolves the workspace-sentinel wake routine when the flag is
  // ON (OFF ⇒ per-hive, unchanged).
  const time = await getHiveTimeWake(sql, installSlug, opts.workspaceId ? { workspaceId: opts.workspaceId } : {});
  const state = await readHiveWakeState(opts.workspaceId);
  const armed = Boolean(time?.active && time.nextFireAt);
  const lastActivity = Math.max(state.lastWakeAt ?? 0, time?.lastFiredAt?.getTime() ?? 0);
  return {
    armed,
    nextFireAt: time?.nextFireAt ?? null,
    lastFiredAt: time?.lastFiredAt ?? null,
    staleForMs: lastActivity > 0 ? Math.max(0, now - lastActivity) : null,
  };
}

// ── demand (the P-011 gate: never wake an empty frontier) ────────────────────

export interface HiveDemand {
  demand: boolean;
  todoItems: number;
  startedPlans: number;
}

/** Cheap deterministic demand counts (D-003): queued feature-family work +
 *  started plans. Escalations are not re-checked here — they wake the Queen at
 *  raise time via the P-002 event subscription; the watchdog needs only the
 *  STANDING demand a forgotten wake would strand. */
export async function hiveDemandCheck(workspaceId: string): Promise<HiveDemand> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ todo_items: number; started_plans: number }>>`
    SELECT
      (SELECT count(*) FROM harness_shared.harness_features_consolidated
        WHERE workspace_id = ${workspaceId} AND status = 'todo')::int AS todo_items,
      (SELECT count(*) FROM harness_shared.harness_plans
        WHERE workspace_id = ${workspaceId} AND op_status = 'started')::int AS started_plans
  `;
  const todoItems = Number(rows[0]?.todo_items ?? 0);
  const startedPlans = Number(rows[0]?.started_plans ?? 0);
  return { demand: todoItems > 0 || startedPlans > 0, todoItems, startedPlans };
}

/** Is a tracked hive turn LIVE right now (the invoke route's bpkind=hive
 *  adv_sessions row, not yet ended)? The tick sweep must not arm a "you're
 *  asleep" wake at a Queen who is mid-turn. */
export async function hiveMidTurn(installSlug: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT 1 FROM harness_shared.adv_sessions
    WHERE label LIKE ${'hive · ' + installSlug + '/%'} AND ended_at IS NULL
    LIMIT 1`;
  return rows.length > 0;
}

// ── the fallback arm (P-009/P-010/P-011 share; P-012 records) ────────────────

export type WatchdogSource = 'turn-end' | 'boot' | 'tick';

export interface FallbackArmResult {
  /** 'armed' = time wake declared; 'staged' = routed to the manual-mode review
   *  queue; 'skipped' = nothing to do (not started / already armed / no brain
   *  to stage at); 'error' = the arm itself failed (recorded, never thrown). */
  outcome: 'armed' | 'staged' | 'skipped' | 'error';
  at?: string;
  reason: string;
}

async function recordFire(opts: {
  workspaceId: string;
  installSlug: string;
  source: WatchdogSource;
  reason: string;
  wakeAt: Date | null;
  demand?: HiveDemand | null;
}): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.hive_watchdog_fires
        (workspace_id, install_slug, source, reason, wake_at, demand)
      VALUES (
        ${opts.workspaceId}, ${opts.installSlug}, ${opts.source}, ${opts.reason},
        ${opts.wakeAt ? opts.wakeAt.toISOString() : null}, ${JSON.stringify(opts.demand ?? {})}::jsonb
      )`;
  } catch (e) {
    // Observability must never break the arm (or boot) — mig 212 may be pending.
    console.warn(`[hive-watchdog] fire record failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Recent fallback-fire count — the "watchdog fired N times" health signal
 *  (P-012/D-004) surfaced in hive:status. */
export async function recentWatchdogFires(
  workspaceId: string,
  installSlug: string,
  windowHours = 24,
): Promise<number> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT count(*)::int AS n FROM harness_shared.hive_watchdog_fires
      WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}
        AND fired_at > now() - make_interval(hours => ${windowHours})`;
    return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
  } catch {
    return 0; // mig 212 pending → no signal, not an error
  }
}

/**
 * Arm the FALLBACK wake for a started hive with none armed. Idempotent and
 * self-checking: re-verifies started + not-already-armed so racing seams
 * (turn-end vs tick) collapse to one arm. Never throws (every caller is a
 * fail-soft seam — a watchdog that crashes its host guards nothing).
 */
export async function armFallbackHiveWake(opts: {
  workspaceId: string;
  installSlug: string;
  source: WatchdogSource;
  /** Why the watchdog fired — becomes the kickoff's self-announcement (D-004). */
  reason: string;
  demand?: HiveDemand | null;
  now?: number;
}): Promise<FallbackArmResult> {
  const { workspaceId, installSlug, source } = opts;
  try {
    if (!(await getHiveStarted(workspaceId, installSlug))) {
      return { outcome: 'skipped', reason: 'hive not started' };
    }
    const { sql } = getOrgPg();
    const live = await hiveLivenessCheck(sql, installSlug, { workspaceId, now: opts.now });
    if (live.armed) {
      return { outcome: 'skipped', reason: 'a wake is already armed' };
    }

    const kickoff =
      `Watchdog wake (${source}): ${opts.reason} — your previous turn ended without declaring a wake. ` +
      `You are the Queen/operator in charge; survey the frontier and ALWAYS declare your next wake ` +
      `(hive:declare-wake) before ending a turn. Frequent watchdog wakes are a prompt bug to fix.`;

    // P-013: compose with the wake-mode gate. Global `manual` = the owner wants
    // every wake reviewable — route through wakeRecipients to the pinned brain
    // owner, where the shipped gate STAGES it (pending_wakes) instead of firing.
    const { getDefaultWakeMode } = await import('../agent-tools/coordination/wake-mode');
    if ((await getDefaultWakeMode()) === 'manual') {
      const { resolveBrainOwner } = await import('../harness/routines/wake-brain-action');
      // EI-908: the brain pin is workspace-scoped — thread this hive's workspace
      // through so the manual-mode liveness backstop resolves the RIGHT pinned
      // brain (an unscoped call resolved owner against `undefined` → always null
      // → the backstop silently staged nothing).
      const owner = await resolveBrainOwner(workspaceId).catch(() => null);
      if (!owner) {
        const reason = `${opts.reason} (wake-mode manual, no pinned brain — nothing staged)`;
        await recordFire({ workspaceId, installSlug, source, reason, wakeAt: null, demand: opts.demand });
        return { outcome: 'skipped', reason };
      }
      // EI-312 leg 1: a staged wake arms NO time wake, so without this check
      // the `live.armed` idempotence above never engages in manual mode — every
      // seam (boot, 30s tick, turn-end) staged ANOTHER watchdog wake forever.
      // A watchdog wake already sitting in the owner's review queue IS the
      // armed state; mirror the auto-mode "already armed" skip (no fire record).
      const { hasPendingWakeFromSource } = await import('../agent-tools/coordination/pending-wakes');
      if (await hasPendingWakeFromSource(owner, 'hive-watchdog:').catch(() => false)) {
        return { outcome: 'skipped', reason: 'a watchdog wake is already staged for review' };
      }
      const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
      await wakeRecipients([owner], {
        summary: kickoff,
        source: `hive-watchdog:${source}`,
        workspaceId,
      });
      const reason = `${opts.reason} (staged for review: wake-mode manual)`;
      await recordFire({ workspaceId, installSlug, source, reason, wakeAt: null, demand: opts.demand });
      return { outcome: 'staged', reason };
    }

    const at = new Date((opts.now ?? Date.now()) + watchdogFallbackSleepSec() * 1_000);
    const armed = await declareHiveTimeWake(sql, {
      workspaceId,
      installSlug,
      at,
      kickoff,
      ...(opts.now ? { now: new Date(opts.now) } : {}),
    });
    await recordFire({
      workspaceId,
      installSlug,
      source,
      reason: opts.reason,
      wakeAt: armed.at,
      demand: opts.demand,
    });
    return { outcome: 'armed', at: armed.at.toISOString(), reason: opts.reason };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[hive-watchdog] fallback arm failed (${installSlug}, ${source}): ${msg}`);
    return { outcome: 'error', reason: msg };
  }
}

// ── the three seams ──────────────────────────────────────────────────────────

/**
 * P-009 — turn-end hook. Called by the invoke route after a `bpkind=hive`
 * launch finishes: the Queen's turn just ended; if she left no wake armed,
 * arm the fallback. No staleness/demand gate — "turn ended, nothing armed"
 * IS the violation at this seam (the liveness invariant is unconditional
 * while started, D-002). Fail-soft, fire-and-forget from the route.
 */
export async function hiveTurnEndCheck(opts: {
  workspaceId: string;
  installSlug: string;
}): Promise<FallbackArmResult> {
  return armFallbackHiveWake({
    ...opts,
    source: 'turn-end',
    reason: 'hive turn finished with no next wake armed',
  });
}

/**
 * P-010 — boot check (crash recovery: the turn-end hook can't run if the
 * process died mid-turn). For every STARTED hive with no wake armed, arm the
 * fallback. Fail-soft; never blocks boot.
 */
export async function hiveBootCheck(): Promise<FallbackArmResult[]> {
  const results: FallbackArmResult[] = [];
  try {
    // K1 (workspace-scoped-coordination P-003): the de-duped liveness set — ONE
    // loop per workspace when WORKSPACE_COORDINATION is ON, the raw per-hive set
    // (byte-identical) when OFF.
    for (const { workspaceId, installSlug } of await listStartedWorkspaceLoops()) {
      results.push(
        await armFallbackHiveWake({
          workspaceId,
          installSlug,
          source: 'boot',
          reason: 'host booted; started hive had no wake armed',
        }),
      );
    }
  } catch (e) {
    console.warn(`[hive-watchdog] boot check failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}

/**
 * P-011 — the routinesTick sweep (every 30s, zero tokens). Fires ONLY when the
 * full invariant is violated: started + demand + no wake armed + not mid-turn
 * + stale (quiet ≥ watchdogStaleSec, or never woken at all). Every condition
 * is a cheap query; the wake it MAY arm is the exception path, not the engine
 * (D-003).
 */
export async function hiveWatchdogSweep(opts: { now?: number } = {}): Promise<FallbackArmResult[]> {
  const results: FallbackArmResult[] = [];
  try {
    // K1 (workspace-scoped-coordination P-003): ONE loop per workspace when
    // WORKSPACE_COORDINATION is ON; the raw per-hive set (byte-identical) OFF.
    const started = await listStartedWorkspaceLoops();
    if (started.length === 0) return results;
    const { sql } = getOrgPg();
    const now = opts.now ?? Date.now();
    for (const { workspaceId, installSlug } of started) {
      const live = await hiveLivenessCheck(sql, installSlug, { workspaceId, now });
      if (live.armed) continue;
      // Stale gate: a just-finished turn belongs to the turn-end seam; a fresh
      // boot to the boot seam. The sweep only catches the long-quiet case —
      // EXCEPT a hive that has never woken (staleForMs null), which would
      // otherwise never trip the threshold.
      if (live.staleForMs !== null && live.staleForMs < watchdogStaleSec() * 1_000) continue;
      if (await hiveMidTurn(installSlug)) continue;
      const demand = await hiveDemandCheck(workspaceId);
      if (!demand.demand) continue;
      results.push(
        await armFallbackHiveWake({
          workspaceId,
          installSlug,
          source: 'tick',
          reason:
            `started hive quiet with demand queued ` +
            `(${demand.todoItems} todo item(s), ${demand.startedPlans} started plan(s)) and no wake armed`,
          demand,
          now,
        }),
      );
    }
  } catch (e) {
    console.warn(`[hive-watchdog] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
