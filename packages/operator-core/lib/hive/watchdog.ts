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

/** The fallback sleep when the Queen didn't self-arm BUT there is STANDING DEMAND (todo work / started plans).
 *  Much shorter than the idle fallback so a crashed / non-self-arming Queen re-wakes FAST to drain the backlog
 *  (or retry a mid-turn crash) instead of stranding hundreds of open items for up to 30 min (2026-07-01: the
 *  Queen `infra_loss`/`usage_limit`-crashed mid-turn and the fixed 1800s fallback left ~395 open items idle
 *  ~30 min per gap; there was no fast crash re-wake). Floored at the wake floor (60s). The demand GATE (never
 *  wake an empty frontier) still applies, so an IDLE hive keeps the long sleep and isn't hammered. */
export function watchdogDemandSleepSec(): number {
  const n = Number(process.env.PAPERCUSP_HIVE_WATCHDOG_DEMAND_SLEEP_SEC ?? 120);
  return Number.isFinite(n) && n >= 60 ? n : 120;
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
 *  STANDING demand a forgotten wake would strand.
 *
 *  STOPPED hives' backlog is NOT demand (owner model 2026-07-01: the start/stop
 *  popup is the Queen's scope control): waking her for work the survey's
 *  stop-list then withholds is pure wake-noise. A stop-list, not an allow-list —
 *  standalone/unhived work still counts. Fail-open (a split read error ⇒
 *  workspace-wide counts, today's behavior). */
export async function hiveDemandCheck(workspaceId: string): Promise<HiveDemand> {
  const { sql } = getOrgPg();
  const stopped = await import('./queen-brief-launch')
    .then(({ computeHivePlacementSplit }) => computeHivePlacementSplit(workspaceId))
    .then((s) => s.stopped)
    .catch(() => [] as string[]);
  const rows = await sql<Array<{ todo_items: number; started_plans: number }>>`
    SELECT
      (SELECT count(*) FROM harness_shared.harness_features_consolidated
        WHERE workspace_id = ${workspaceId} AND status = 'todo'
        ${stopped.length > 0 ? sql`AND harness_slug != ALL(${stopped})` : sql``})::int AS todo_items,
      (SELECT count(*) FROM harness_shared.harness_plans
        WHERE workspace_id = ${workspaceId} AND op_status = 'started'
        ${stopped.length > 0 ? sql`AND harness_slug != ALL(${stopped})` : sql``})::int AS started_plans
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

export type WatchdogSource =
  | 'turn-end'
  | 'boot'
  | 'tick'
  | 'paused-recovery'
  | 'scout-draft-review'
  // WI-1574: the ready-plan autostart sweep's decompose-wake (a ratified scout
  // plan with no open items cannot start — the Queen is woken to add items).
  | 'scout-ready-decompose'
  // GYM-2 (gym-unwedge): the chronic-autoloop-failure escalator's per-(harness,role)
  // 24h debounce (a cycle red >= threshold consecutive fires files an observation).
  | 'autoloop-chronic'
  // WI-1623: the release-deploy staleness recurrence guard — the green pin has
  // sat deployable-but-not-live longer than the threshold (a genuinely wedged
  // pipeline OR a lying deployedAt field; either way, worth an alert).
  | 'release-deploy-staleness'
  // hive-seed-bundle P-008 (D-007): the cold-join canary's per-interval fire —
  // a scheduled FULL cold join (seed disabled) keeps the whole-history join path
  // exercised now that seeded installs only carry the delta. A fire records each
  // canary run (pass or fail) + doubles as the interval debounce clock.
  | 'cold-join-canary';

export interface FallbackArmResult {
  /** 'armed' = time wake declared; 'staged' = routed to the manual-mode review
   *  queue; 'skipped' = nothing to do (not started / already armed / no brain
   *  to stage at); 'error' = the arm itself failed (recorded, never thrown). */
  outcome: 'armed' | 'staged' | 'skipped' | 'error';
  at?: string;
  reason: string;
}

export async function recordFire(opts: {
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
        ${opts.wakeAt ? opts.wakeAt.toISOString() : null}, ${JSON.stringify(opts.demand ?? {})}::text::jsonb
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
  source?: WatchdogSource,
): Promise<number> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT count(*)::int AS n FROM harness_shared.hive_watchdog_fires
      WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}
        AND fired_at > now() - make_interval(hours => ${windowHours})
        AND ${source ? sql`source = ${source}` : sql`TRUE`}`;
    return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
  } catch {
    return 0; // mig 212 pending → no signal, not an error
  }
}

/**
 * EI-6777: atomically claim the "should I fire?" debounce slot for
 * (workspaceId, installSlug, source, windowHours).
 *
 * `recentWatchdogFires(...) > 0` then, later, `recordFire(...)` is a
 * classic check-then-act race: when multiple sweep ticks/processes race for
 * the SAME debounce key, every one of them can observe "not fired yet" (the
 * SELECT) before any of them commits the INSERT, producing N duplicate
 * escalations instead of 1 (root-caused via EI-6760/6761/6762 — 3
 * near-identical escalations filed within 20ms of each other). There is no
 * unique constraint to lean on here (see mig 212's header: the ledger is
 * plain append-only, and callers use varying, arbitrary `windowHours`
 * sliding windows rather than a fixed calendar bucket a unique index could
 * key on) — so this uses a Postgres advisory transaction lock scoped to the
 * debounce key to serialize the check+insert instead.
 *
 * Callers should use this as a DOUBLE-CHECKED-LOCKING re-verification: do
 * the ordinary cheap `recentWatchdogFires` read first (as before, to decide
 * whether the OTHER, non-debounce conditions — staleness, demand, threshold
 * — even warrant firing at all), and only when that says "yes" call this to
 * atomically re-check + claim the slot immediately before performing the
 * one-time side effect (captureImprovement, alertOwnerPausedOutage, ...).
 * Returns true iff THIS call won the race and recorded the fire — proceed.
 * Returns false iff a fire is already recorded within the window (either
 * from before, or a concurrent racer who claimed it first) — skip the side
 * effect; do NOT also call `recordFire` (this already recorded it).
 *
 * `pg_advisory_xact_lock` auto-releases at transaction end (commit OR
 * rollback) — unlike a session-level `pg_advisory_lock`/`_unlock` pair, a
 * crash or thrown error mid-claim can never leak the lock.
 *
 * Fail-open on any DB error (mirrors recordFire/recentWatchdogFires'
 * existing fail-soft contract — mig 212 may be pending, or a transient PG
 * hiccup; observability must never SUPPRESS a real watchdog escalation, only
 * best-effort dedupe it).
 */
export async function claimWatchdogFire(opts: {
  workspaceId: string;
  installSlug: string;
  source: WatchdogSource;
  reason: string;
  wakeAt: Date | null;
  demand?: HiveDemand | null;
  windowHours?: number;
}): Promise<boolean> {
  const { workspaceId, installSlug, source, windowHours = 24 } = opts;
  try {
    const { sql } = getOrgPg();
    return await sql.begin(async (tx) => {
      // hashtextextended gives a stable 64-bit lock key from the 3-part
      // debounce key; `0` (the salt arg) keeps it deterministic across calls.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}::${installSlug}::${source}`}, 0))`;
      const rows = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM harness_shared.hive_watchdog_fires
        WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}
          AND fired_at > now() - make_interval(hours => ${windowHours})
          AND source = ${source}`;
      if (Number(rows[0]?.n ?? 0) > 0) return false;
      await tx`
        INSERT INTO harness_shared.hive_watchdog_fires
          (workspace_id, install_slug, source, reason, wake_at, demand)
        VALUES (
          ${workspaceId}, ${installSlug}, ${source}, ${opts.reason},
          ${opts.wakeAt ? opts.wakeAt.toISOString() : null}, ${JSON.stringify(opts.demand ?? {})}::text::jsonb
        )`;
      return true;
    });
  } catch (e) {
    console.warn(`[hive-watchdog] claimWatchdogFire failed (fail-open — proceeding as if unfired): ${e instanceof Error ? e.message : e}`);
    return true;
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

    // Demand-adaptive fallback (2026-07-01): a crashed / non-self-arming Queen WITH standing demand re-wakes
    // FAST (drain the backlog / retry the crash) instead of idling the full 1800s; an IDLE hive keeps the long
    // sleep (and the demand gate means the watchdog never wakes an empty frontier at all). `opts.demand` is the
    // deterministic demand snapshot the caller already computed for the fire record.
    const fallbackSleepSec = opts.demand?.demand ? watchdogDemandSleepSec() : watchdogFallbackSleepSec();
    const at = new Date((opts.now ?? Date.now()) + fallbackSleepSec * 1_000);
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
  // Thread the standing demand so the fallback sleep is DEMAND-ADAPTIVE (a crashed / non-self-arming Queen with
  // a backlog re-wakes in ~2 min, not 30). This is NOT a gate — the turn-end seam still arms unconditionally
  // (D-002); demand only sizes the SLEEP. Fail-soft: a read error → null → the long idle sleep, unchanged.
  const demand = await hiveDemandCheck(opts.workspaceId).catch(() => null);
  return armFallbackHiveWake({
    ...opts,
    source: 'turn-end',
    reason: 'hive turn finished with no next wake armed',
    demand,
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
      // Demand-adaptive: a host that booted mid-crash with a backlog re-wakes the Queen fast, not in 30 min.
      const demand = await hiveDemandCheck(workspaceId).catch(() => null);
      results.push(
        await armFallbackHiveWake({
          workspaceId,
          installSlug,
          source: 'boot',
          reason: 'host booted; started hive had no wake armed',
          demand,
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

// ── P-003 (autonomous-loop-canary-reliability-2026-06-29): paused-hive recovery ─
// The three seams above are STARTED-only — armFallbackHiveWake returns early
// ('hive not started') and listStartedWorkspaceLoops omits paused hives. So a hive
// that is PAUSED while real work is queued is a SILENT OUTAGE: nothing re-arms it
// and the health panel only yellowed (the multi-day daily-canary stall that
// motivated this). This sweep is the missing detector — it alerts the owner and
// (unless disabled) auto-resumes a hive paused past the stale threshold WITH
// standing demand. Like hiveWatchdogSweep it is a cheap deterministic read on the
// 30s tick; the alert/resume is the exception path, not a cadence.

/** A paused hive quiet THIS long (with demand) is treated as a silent outage, not
 *  a deliberate brief pause. Default 24h; env-tunable; <= 0 DISABLES the whole
 *  paused-recovery sweep (kill switch). */
export function pausedRecoveryStaleSec(): number {
  const n = Number(process.env.PAPERCUSP_HIVE_PAUSED_RECOVERY_SEC ?? 86_400);
  return Number.isFinite(n) ? n : 86_400;
}

/** Whether a detected silent-paused-outage is AUTO-RESUMED (default) or only
 *  ALERTED. Set PAPERCUSP_HIVE_PAUSED_AUTO_RESUME=off to alert-without-resuming
 *  (respect a deliberate long pause while still surfacing it loudly). */
export function pausedRecoveryAutoResume(): boolean {
  const v = (process.env.PAPERCUSP_HIVE_PAUSED_AUTO_RESUME ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/**
 * PURE: should the paused-recovery sweep ACT on a paused hive this tick? Acts only
 * when we KNOW when it paused (never act blind on a missing timestamp), it has been
 * paused past the stale threshold, it has standing demand, and we have not already
 * fired within the window (debounce, so alert-only mode does not re-fire every 30s).
 * Whether the act is auto-resume or alert-only is the env's call
 * (pausedRecoveryAutoResume), not this decision's.
 */
export function shouldActOnPausedHive(args: {
  pausedAtMs: number | null;
  now: number;
  thresholdMs: number;
  hasDemand: boolean;
  alreadyFiredRecently: boolean;
}): boolean {
  if (args.pausedAtMs == null) return false;
  if (args.now - args.pausedAtMs < args.thresholdMs) return false;
  if (!args.hasDemand) return false;
  if (args.alreadyFiredRecently) return false;
  return true;
}

/** Surface a silent paused-outage to the pinned brain owner (best-effort, never
 *  throws) — the alert the old started-only watchdog never sent. */
async function alertOwnerPausedOutage(opts: {
  workspaceId: string;
  installSlug: string;
  reason: string;
  autoResume: boolean;
}): Promise<void> {
  try {
    const { resolveBrainOwner } = await import('../harness/routines/wake-brain-action');
    const owner = await resolveBrainOwner(opts.workspaceId).catch(() => null);
    if (!owner) return;
    const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
    const tail = opts.autoResume
      ? 'Auto-resuming it now. If the pause was intentional, hive:pause again or set PAPERCUSP_HIVE_PAUSED_AUTO_RESUME=off.'
      : 'Left paused (auto-resume disabled). hive:start to resume.';
    await wakeRecipients([owner], {
      summary: `⚠️ Hive "${opts.installSlug}" ${opts.reason}. ${tail}`,
      source: 'hive-paused-recovery',
      workspaceId: opts.workspaceId,
    });
  } catch (e) {
    console.warn(`[hive-watchdog] paused-outage alert failed: ${e instanceof Error ? e.message : e}`);
  }
}

export interface PausedRecoveryResult {
  workspaceId: string;
  installSlug: string;
  // 'debounced' (EI-6777): the cheap pre-check said act, but the atomic
  // re-check lost the race to a concurrent claim — a real "another racer
  // already fired this window" outcome, distinct from 'skipped' (the
  // non-debounce staleness/demand gate said not to act at all).
  outcome: 'resumed' | 'alerted' | 'skipped' | 'debounced' | 'error';
  reason: string;
  pausedForMs: number | null;
}

/**
 * The paused-hive recovery sweep (P-003). For each currently-paused hive with a
 * known pause time, past the stale threshold, WITH standing demand, and not already
 * fired this window: alert the owner and (unless disabled) auto-resume + re-arm the
 * wake (armFallbackHiveWake now permits it once started=true). Never throws — a
 * watchdog that crashes its host guards nothing.
 */
export async function pausedHiveRecoverySweep(opts: { now?: number } = {}): Promise<PausedRecoveryResult[]> {
  const results: PausedRecoveryResult[] = [];
  const staleSec = pausedRecoveryStaleSec();
  if (staleSec <= 0) return results; // kill switch
  try {
    const { listPausedHives, setHiveStarted } = await import('./started');
    const paused = await listPausedHives();
    if (paused.length === 0) return results;
    const now = opts.now ?? Date.now();
    const thresholdMs = staleSec * 1_000;
    const windowHours = Math.max(1, Math.round(staleSec / 3_600));
    const autoResume = pausedRecoveryAutoResume();
    for (const { workspaceId, installSlug, pausedAtMs } of paused) {
      const demand = await hiveDemandCheck(workspaceId).catch(() => ({
        demand: false,
        todoItems: 0,
        startedPlans: 0,
      }));
      const alreadyFiredRecently =
        (await recentWatchdogFires(workspaceId, installSlug, windowHours, 'paused-recovery')) > 0;
      if (
        !shouldActOnPausedHive({ pausedAtMs, now, thresholdMs, hasDemand: demand.demand, alreadyFiredRecently })
      ) {
        continue;
      }
      const pausedForMs = pausedAtMs == null ? null : Math.max(0, now - pausedAtMs);
      const reason =
        `paused ${pausedForMs == null ? '?' : Math.round(pausedForMs / 3_600_000)}h with demand queued ` +
        `(${demand.todoItems} todo item(s), ${demand.startedPlans} started plan(s)) — silent outage`;
      // EI-6777: the cheap `alreadyFiredRecently` read above only tells us
      // whether the OTHER (non-debounce) conditions warrant firing at all —
      // it is racy against a concurrent tick/process doing the same read.
      // Atomically re-check + claim the debounce slot right before the
      // one-time side effect so only one racer ever proceeds past this line.
      const claimedFire = await claimWatchdogFire({
        workspaceId,
        installSlug,
        source: 'paused-recovery',
        windowHours,
        reason,
        wakeAt: null,
        demand,
      });
      if (!claimedFire) {
        results.push({ workspaceId, installSlug, outcome: 'debounced', reason, pausedForMs });
        continue;
      }
      await alertOwnerPausedOutage({ workspaceId, installSlug, reason, autoResume });
      if (!autoResume) {
        // claimWatchdogFire already recorded the fire atomically above —
        // no separate recordFire call here (that was the race this closes).
        results.push({ workspaceId, installSlug, outcome: 'alerted', reason, pausedForMs });
        continue;
      }
      try {
        await setHiveStarted(workspaceId, installSlug, true);
        // armFallbackHiveWake records the 'paused-recovery' fire (the debounce row).
        await armFallbackHiveWake({
          workspaceId,
          installSlug,
          source: 'paused-recovery',
          reason: `auto-resumed after silent pause: ${reason}`,
          demand,
          now,
        });
        results.push({ workspaceId, installSlug, outcome: 'resumed', reason, pausedForMs });
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'error',
          reason: `resume failed: ${e instanceof Error ? e.message : String(e)}`,
          pausedForMs,
        });
      }
    }
  } catch (e) {
    console.warn(`[hive-watchdog] paused-recovery sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
