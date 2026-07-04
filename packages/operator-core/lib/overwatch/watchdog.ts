/**
 * overwatch/watchdog — the overwatch LIVENESS BACKSTOP
 * (overwatch-role-2026-06-15 B-09, D-004: who-watches-the-watcher).
 *
 * Overwatch is the system's watchdog actuator — but it can stall like any other
 * autonomous role (the Queen's opus-pacing stall, 2026-06-15). So overwatch gets
 * its OWN dead-man's switch, mirroring the hive watchdog (`hive/watchdog.ts`):
 * while overwatch is EXPECTED to run (its flag is on AND the monitored hive is
 * started), a wake is ALWAYS armed; when it left none, this module arms a
 * fallback SLEEP — never an immediate re-invoke (a broken-prompt overwatch must
 * fail toward "sleeps too long", cheap, never "runs continuously", expensive).
 *
 * Three seams, exactly like the hive (so a stalled overwatch is caught wherever
 * its turn died):
 *   - **turn-end** — B-04's invoke route calls `overwatchTurnEndCheck` after an
 *     overwatch launch finishes (the analogue of `hiveTurnEndCheck`).
 *   - **boot** — `overwatchBootCheck` re-arms after a host restart that killed a
 *     turn mid-flight (wired in agent-tools/index.ts boot, gated).
 *   - **tick** — `overwatchWatchdogSweep` rides the existing 30s routinesTick
 *     (zero tokens; the wake it MAY arm is the exception path, not a cadence).
 *
 * Everything here is GATED on the `papercusp-overwatch` flag (B-10/D-009): flag
 * off ⇒ `listGuardedOverwatches()` is empty ⇒ the backstop is fully inert. This
 * is what keeps the not-yet-proven role dark until B-12.
 *
 * Re-arm goes through `declareOverwatchTimeWake` (./liveness — the shared seam
 * B-04's declare-next-wake also uses). Fires are recorded in the existing
 * `harness_shared.hive_watchdog_fires` table with an `overwatch-*` source (no
 * new migration; `source` has no CHECK constraint).
 */
import { getOrgPg } from "@papercusp/db-org";
import { getFlag } from "@papercusp/flags/server";
import { FLAGS } from "@papercusp/flags";
import {
  getOverwatchStarted,
  listStartedWorkspaceOverwatches,
} from "./control-state";
import { declareOverwatchTimeWake, overwatchLivenessCheck } from "./liveness";

// ── tunables (env-overridable, mirroring the hive watchdog) ───────────────────

/** The fallback sleep the watchdog arms when overwatch forgot to declare a wake
 *  (default 30 min — failing toward "sleeps too long" is cheap). */
export function overwatchWatchdogSleepSec(): number {
  const n = Number(process.env.PAPERCUSP_OVERWATCH_WATCHDOG_SLEEP_SEC ?? 1800);
  return Number.isFinite(n) && n >= 60 ? n : 1800;
}

/** How long a guarded, unarmed overwatch must be quiet before the tick sweep
 *  fires (default 15 min). The turn-end + boot seams don't wait this out. */
export function overwatchWatchdogStaleSec(): number {
  const n = Number(process.env.PAPERCUSP_OVERWATCH_WATCHDOG_STALE_SEC ?? 900);
  return Number.isFinite(n) && n >= 30 ? n : 900;
}

/** Is the overwatch role activated (B-10/D-009 — the load-bearing gate)? */
export async function overwatchEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.OVERWATCH, "system");
  } catch {
    return false; // unknown ⇒ treat as off (the role ships dark)
  }
}

/**
 * The set of overwatches the backstop guards: those B-07's control bit marks
 * STARTED (`overwatch:start`), but ONLY while the overwatch flag is on
 * (B-10/D-009 — defence-in-depth: the start tool is itself flag-gated, so this
 * is belt-and-braces).
 *
 * K1 (workspace-scoped-coordination P-004 / D-006 — Phase C): consumes the
 * DE-DUPED supervisor set (`listStartedWorkspaceOverwatches`) so a workspace with
 * N started hives is guarded by ONE workspace supervisor when
 * WORKSPACE_COORDINATION is ON (the exact mirror of the Queen watchdog consuming
 * `listStartedWorkspaceLoops`). OFF (the dark default) ⇒ the raw per-(ws,install)
 * set, BYTE-IDENTICAL to today.
 */
export async function listGuardedOverwatches(): Promise<
  Array<{ workspaceId: string; installSlug: string }>
> {
  if (!(await overwatchEnabled())) return [];
  try {
    return await listStartedWorkspaceOverwatches();
  } catch {
    return [];
  }
}

export type OverwatchWatchdogSource = "turn-end" | "boot" | "tick";

export interface OverwatchFallbackArmResult {
  /** 'armed' = a fallback wake declared; 'skipped' = nothing to do (flag off /
   *  hive paused / already armed); 'error' = the arm itself failed (recorded,
   *  never thrown). */
  outcome: "armed" | "skipped" | "error";
  at?: string;
  reason: string;
}

async function recordOverwatchFire(opts: {
  workspaceId: string;
  installSlug: string;
  source: OverwatchWatchdogSource;
  reason: string;
  wakeAt: Date | null;
}): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.hive_watchdog_fires
        (workspace_id, install_slug, source, reason, wake_at, demand)
      VALUES (
        ${opts.workspaceId}, ${opts.installSlug}, ${"overwatch-" + opts.source}, ${opts.reason},
        ${opts.wakeAt ? opts.wakeAt.toISOString() : null}, ${"{}"}::text::jsonb
      )`;
  } catch (e) {
    // Observability must never break the arm.
    console.warn(
      `[overwatch-watchdog] fire record failed: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** Recent overwatch fallback-fire count — the "overwatch watchdog fired N times"
 *  health signal (surfaced in the overwatch pane / hive:status). Filters the
 *  shared table to `overwatch-*` sources so it never counts the hive's. */
export async function recentOverwatchWatchdogFires(
  workspaceId: string,
  installSlug: string,
  windowHours = 24,
): Promise<number> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT count(*)::int AS n FROM harness_shared.hive_watchdog_fires
      WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}
        AND source LIKE ${"overwatch-%"}
        AND fired_at > now() - make_interval(hours => ${windowHours})`;
    return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
  } catch {
    return 0;
  }
}

/** Is an overwatch turn LIVE right now (an invoke-route adv_sessions row not yet
 *  ended)? Best-effort: matches B-04's expected label shape `overwatch · <slug>/…`.
 *  A miss only means the sweep might arm during a turn — idempotent + the
 *  routine's `concurrency:'skip'` prevents a double-fire, so it is harmless. */
export async function overwatchMidTurn(installSlug: string): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT 1 FROM harness_shared.adv_sessions
      WHERE label LIKE ${"overwatch · " + installSlug + "/%"} AND ended_at IS NULL
      LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Arm the FALLBACK wake for a guarded overwatch with none armed. Idempotent +
 * self-checking (re-verifies enabled + started + not-already-armed) so racing
 * seams collapse to one arm. Never throws — every caller is a fail-soft seam.
 */
export async function armFallbackOverwatchWake(opts: {
  workspaceId: string;
  installSlug: string;
  source: OverwatchWatchdogSource;
  reason: string;
  now?: number;
}): Promise<OverwatchFallbackArmResult> {
  const { workspaceId, installSlug, source } = opts;
  try {
    if (!(await overwatchEnabled())) {
      return { outcome: "skipped", reason: "overwatch flag off" };
    }
    if (!(await getOverwatchStarted(workspaceId, installSlug))) {
      return { outcome: "skipped", reason: "overwatch not started" };
    }
    const { sql } = getOrgPg();
    const live = await overwatchLivenessCheck(sql, installSlug, {
      now: opts.now,
      workspaceId,
    });
    if (live.armed) {
      return { outcome: "skipped", reason: "a wake is already armed" };
    }
    const kickoff =
      `Overwatch watchdog wake (${source}): ${opts.reason} — your previous turn ended without declaring a wake. ` +
      `Survey system health (the brief), act on the anomalies, and ALWAYS declare your next wake before ending a turn. ` +
      `Frequent watchdog wakes are a prompt bug to fix.`;
    const at = new Date(
      (opts.now ?? Date.now()) + overwatchWatchdogSleepSec() * 1_000,
    );
    const armed = await declareOverwatchTimeWake(sql, {
      workspaceId,
      installSlug,
      at,
      kickoff,
      ...(opts.now ? { now: new Date(opts.now) } : {}),
    });
    await recordOverwatchFire({
      workspaceId,
      installSlug,
      source,
      reason: opts.reason,
      wakeAt: armed.at,
    });
    return {
      outcome: "armed",
      at: armed.at.toISOString(),
      reason: opts.reason,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[overwatch-watchdog] fallback arm failed (${installSlug}, ${source}): ${msg}`,
    );
    return { outcome: "error", reason: msg };
  }
}

// ── the three seams ───────────────────────────────────────────────────────────

/**
 * turn-end hook — B-04's invoke route calls this after an overwatch launch
 * finishes: the turn just ended; if overwatch left no wake armed, arm the
 * fallback. No staleness gate — "turn ended, nothing armed" IS the violation
 * here (the liveness invariant is unconditional while running). Fail-soft.
 */
export async function overwatchTurnEndCheck(opts: {
  workspaceId: string;
  installSlug: string;
}): Promise<OverwatchFallbackArmResult> {
  return armFallbackOverwatchWake({
    ...opts,
    source: "turn-end",
    reason: "overwatch turn finished with no next wake armed",
  });
}

/**
 * boot check (crash recovery): the turn-end hook can't run if the process died
 * mid-turn. For every GUARDED overwatch with no wake armed, arm the fallback.
 * Fail-soft; never blocks boot.
 */
export async function overwatchBootCheck(): Promise<
  OverwatchFallbackArmResult[]
> {
  const results: OverwatchFallbackArmResult[] = [];
  try {
    for (const { workspaceId, installSlug } of await listGuardedOverwatches()) {
      results.push(
        await armFallbackOverwatchWake({
          workspaceId,
          installSlug,
          source: "boot",
          reason: "host booted; guarded overwatch had no wake armed",
        }),
      );
    }
  } catch (e) {
    console.warn(
      `[overwatch-watchdog] boot check failed: ${e instanceof Error ? e.message : e}`,
    );
  }
  return results;
}

/**
 * the routinesTick sweep (every 30s, zero tokens). Fires ONLY when the invariant
 * is violated: guarded (flag on + hive started) + no wake armed + not mid-turn +
 * stale (quiet ≥ staleSec, or never woken at all). Every condition is a cheap
 * query; the wake it MAY arm is the exception path.
 */
export async function overwatchWatchdogSweep(
  opts: { now?: number } = {},
): Promise<OverwatchFallbackArmResult[]> {
  const results: OverwatchFallbackArmResult[] = [];
  try {
    const guarded = await listGuardedOverwatches();
    if (guarded.length === 0) return results;
    const { sql } = getOrgPg();
    const now = opts.now ?? Date.now();
    for (const { workspaceId, installSlug } of guarded) {
      const live = await overwatchLivenessCheck(sql, installSlug, {
        now,
        workspaceId,
      });
      if (live.armed) continue;
      // Stale gate: a just-finished turn belongs to the turn-end seam; a fresh
      // boot to the boot seam. The sweep only catches the long-quiet case —
      // EXCEPT an overwatch that has never woken (staleForMs null), which would
      // otherwise never trip the threshold.
      if (
        live.staleForMs !== null &&
        live.staleForMs < overwatchWatchdogStaleSec() * 1_000
      )
        continue;
      if (await overwatchMidTurn(installSlug)) continue;
      results.push(
        await armFallbackOverwatchWake({
          workspaceId,
          installSlug,
          source: "tick",
          reason: "guarded overwatch quiet with no wake armed",
          now,
        }),
      );
    }
  } catch (e) {
    console.warn(
      `[overwatch-watchdog] sweep failed: ${e instanceof Error ? e.message : e}`,
    );
  }
  return results;
}
