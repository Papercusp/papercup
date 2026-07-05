/**
 * Loop dead-man guard — bound a runaway / forgotten / permanently-dead loop
 * (loop-wake-rate-limit-robustness-2026-06-23 P2a).
 *
 * The gap (agent-insights/loop-wake-turn-deaths-recorded-as-delivered #6): there is no
 * max-iterations / max-duration / dead-man's-switch, so a loop armed by a session that then
 * dies permanently is re-armed forever by the stuck-park backstop. This adds an OPTIONAL
 * upper bound — `maxFires` (total wake attempts) and/or `maxDurationSec` (wall-clock since
 * arm) — that auto-pauses the loop when crossed (the time/iteration sibling of the existing
 * cost-cap auto-pause, mirroring `checkLoopCostCap`).
 *
 * Config rides the routine's `payload_template` (exactly like `costCapCents`), and the live
 * fire count rides `metadata.fire_count` — so NO migration / new columns (reuse-first: extend
 * the existing jsonb seams rather than widen the routine table). No cap configured ⇒ zero
 * reads, byte-identical to today.
 *
 * EI-7613 — the max-duration clock must measure from the LATEST arm, not the routine row's
 * `created_at`. `materializeLoop` re-arms an EXISTING loop via `upsertRoutine`'s
 * `INSERT ... ON CONFLICT (id) DO UPDATE` (routines-runtime.ts) — an UPDATE never touches
 * `created_at` (it's only set by the true INSERT branch), so a loop armed on day 1 and
 * re-armed on day 2 with a FRESH `maxDurationSec` still measured its duration since day 1: the
 * re-armed loop was dead on arrival, its very first fire immediately breaching a bound that
 * had not actually elapsed since the re-arm. `stampLoopArmedAt` records the true latest-arm
 * instant in `metadata.armed_at` (mirrors the `fire_count` seam — no migration); the dead-man
 * read below prefers it, falling back to `created_at` for a loop armed before this fix ran.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { autoPauseLoopRoutine } from './loop-cost-cap';

/**
 * Pure dead-man decision. Duration is checked first (a forgotten loop is the headline case).
 * A null / non-positive bound is "no bound". `fireCount` is the count of PRIOR fires, so
 * `>= maxFires` withholds the (maxFires+1)-th — exactly `maxFires` fires occur.
 */
export function evaluateDeadManGuard(input: {
  armedAtMs: number;
  nowMs: number;
  fireCount: number;
  maxFires?: number | null;
  maxDurationSec?: number | null;
}): { breach: boolean; reason?: string } {
  const { armedAtMs, nowMs, fireCount, maxFires, maxDurationSec } = input;
  if (maxDurationSec != null && maxDurationSec > 0 && nowMs - armedAtMs > maxDurationSec * 1000) {
    return { breach: true, reason: `max-duration ${Math.round((nowMs - armedAtMs) / 1000)}s > ${maxDurationSec}s (since arm)` };
  }
  if (maxFires != null && maxFires > 0 && fireCount >= maxFires) {
    return { breach: true, reason: `max-fires ${fireCount} >= ${maxFires}` };
  }
  return { breach: false };
}

export interface LoopDeadManDeps {
  autoPause?: typeof autoPauseLoopRoutine;
}

/**
 * The dead-man gate the loop fire consults BEFORE waking. No bound configured ⇒ never breaches
 * (zero reads). With a bound: read the loop's arm time (created_at) + live fire count and, on
 * breach, auto-pause the routine and report it so the fire is withheld.
 */
export async function checkLoopDeadMan(
  input: { sql?: Sql; routineId: string; maxFires?: number | null; maxDurationSec?: number | null; nowMs?: number },
  deps: LoopDeadManDeps = {},
): Promise<{ breach: boolean; reason?: string }> {
  const hasFires = input.maxFires != null && input.maxFires > 0;
  const hasDuration = input.maxDurationSec != null && input.maxDurationSec > 0;
  if (!hasFires && !hasDuration) return { breach: false };

  const db = input.sql ?? getOrgPg().sql;
  const autoPause = deps.autoPause ?? autoPauseLoopRoutine;
  const nowMs = input.nowMs ?? Date.now();

  const rows = await db<Array<{ armed_ms: string | number | null; fire_count: string | number | null }>>`
    SELECT (EXTRACT(EPOCH FROM COALESCE((metadata->>'armed_at')::timestamptz, created_at)) * 1000)::bigint AS armed_ms,
           COALESCE((metadata->>'fire_count')::int, 0)    AS fire_count
      FROM harness_shared.routines
     WHERE id = ${input.routineId}`;
  const armedAtMs = Number(rows[0]?.armed_ms ?? nowMs);
  const fireCount = Number(rows[0]?.fire_count ?? 0);

  const verdict = evaluateDeadManGuard({
    armedAtMs,
    nowMs,
    fireCount,
    maxFires: input.maxFires,
    maxDurationSec: input.maxDurationSec,
  });
  if (verdict.breach) {
    await autoPause(db, input.routineId, `dead-man guard: ${verdict.reason}`);
  }
  return verdict;
}

/**
 * Read the loop's live fire count (`metadata.fire_count`) — the number of PRIOR fires (0 when
 * never fired). The cold-auto wakeCount cadence (su-cold-auto-mode-2026-07-03 P-003/P-005)
 * stamps wakeCount = priorFireCount + 1 on a cold wake so the consumer's coldWakeMode can
 * recycle every Nth wake. Best-effort; 0 on any miss. Reuses the same jsonb seam as the
 * dead-man guard (no new column).
 */
export async function readLoopFireCount(sql: Sql | undefined, routineId: string): Promise<number> {
  const db = sql ?? getOrgPg().sql;
  const rows = await db<Array<{ fire_count: string | number | null }>>`
    SELECT COALESCE((metadata->>'fire_count')::int, 0) AS fire_count
      FROM harness_shared.routines
     WHERE id = ${routineId}`;
  return Number(rows[0]?.fire_count ?? 0);
}

/**
 * EI-7613 — stamp the loop's LATEST arm instant (`metadata.armed_at`), called by
 * `materializeLoop` on EVERY `loop:arm` (a fresh arm and a re-arm alike). The dead-man
 * max-duration guard must measure "since arm" from the most recent arm — a re-arm goes
 * through `upsertRoutine`'s `ON CONFLICT DO UPDATE`, which never touches `created_at`, so
 * without this stamp a re-armed loop's clock kept running from the ORIGINAL arm and a fresh
 * `maxDurationSec` could breach instantly on the loop's very first post-re-arm fire. Mirrors
 * the `fire_count` seam (no migration, no new column). Best-effort: a stamp failure must
 * never fail the arm itself (the caller awaits this after the upsert has already succeeded).
 */
export async function stampLoopArmedAt(sql: Sql | undefined, routineId: string, atMs?: number): Promise<void> {
  const db = sql ?? getOrgPg().sql;
  const iso = new Date(atMs ?? Date.now()).toISOString();
  await db`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('armed_at', ${iso}::text)
     WHERE id = ${routineId}`;
}

/**
 * Bump the loop's live fire counter (`metadata.fire_count`) after a fire. Single-flight per
 * loop (parked at 'infinity' while a turn runs), so no concurrent-increment race. Stored as a
 * jsonb number; read back via `(metadata->>'fire_count')::int`.
 */
export async function incrementLoopFireCount(sql: Sql | undefined, routineId: string): Promise<void> {
  const db = sql ?? getOrgPg().sql;
  await db`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('fire_count', COALESCE((metadata->>'fire_count')::int, 0) + 1)
     WHERE id = ${routineId}`;
}
