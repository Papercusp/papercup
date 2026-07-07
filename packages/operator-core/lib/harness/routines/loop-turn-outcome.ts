/**
 * Loop turn-outcome handler — feed a DEAD loop wake turn back into the autoloop circuit
 * (loop-wake-rate-limit-robustness-2026-06-23 P0b + P1a).
 *
 * THE GAP (agent-insights/loop-wake-turn-deaths-recorded-as-delivered): a loop's re-wake
 * runs a DETACHED `claude --resume … -p` turn whose delivery is recorded `delivered` on
 * SPAWN. If that turn then 429s and dies, the failure-streak fire-gate never sees it
 * (`fireLoopWake` records the enqueue as success), so the loop keeps firing empty wakes
 * into a rate-limited void and only the ≥30-minute stuck-park backstop ever recovers it —
 * blind, with no backoff.
 *
 * This is the registered `onResumeTurnExit` handler (wired into the await pump via
 * `registerResumeTurnOutcomeHandler`, the seam that avoids the harness/routines → engine
 * import cycle). For a LOOP-sourced (`source = loop:<routineId>`) resume turn that DIED, it:
 *   1. feeds the EXISTING autoloop circuit — `recordFire(installSlug, name, …, 'error')` —
 *      so a storm of dead loop turns backs off + opens the circuit (P0b), and
 *   2. re-arms the loop's `next_fire_at` by the 429 `retry-after` (P1a) instead of blindly
 *      retrying into the same wall — only while the loop is still parked at 'infinity' (the
 *      very turn we observed die), so a healthy/already-re-armed loop is never disturbed.
 *
 * Success (a clean exit) is a NO-OP here: the reconcile-loop completion-rebase owns the
 * `recordFire('ok')` circuit reset when it sees the turn's lifecycle 'ended' marker — the
 * channel-agnostic success signal (a live-INJECT wake has no subprocess to observe). The
 * reconcile stuck-park backstop is the channel-agnostic FAILURE fallback for the rare cases
 * this fast/precise observer misses (an inject-path death, or an operator restart between
 * spawn and exit).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { runWithWorkspace } from '../../workspace-als';
import { classifyFireError, recordFire as defaultRecordFire } from '../../autoloop';
import { getLoopCarryNote as defaultGetLoopCarryNote, splitCarryNoteWalls } from '../../carry-note';
import { detectOwnerAsk, stashLoopWallNag as defaultStashLoopWallNag } from './loop-wall-nag';
import { registerResumeTurnOutcomeHandler } from '../../events/await/engine';
import {
  classifyResumeTurnExit,
  type ResumeTurnExitRaw,
  type ResumeTurnOutcome,
} from '../../events/await/resume-turn-outcome';
import type { DeliveryWork } from '../../events/await/types';

const log = (msg: string) => console.warn(`[loop-turn-outcome] ${msg}`);

/** The loop wake `source` convention (loop-fire.ts): `loop:<routineId>`. */
const LOOP_SOURCE_PREFIX = 'loop:';

/** Recover the loop routine id from a delivery's source (`loop:<routineId>`), else null
 *  (a non-loop wake — we never attribute its turn death to a loop). */
export function loopRoutineIdFromSource(source: string | null | undefined): string | null {
  if (!source || !source.startsWith(LOOP_SOURCE_PREFIX)) return null;
  const id = source.slice(LOOP_SOURCE_PREFIX.length).trim();
  return id || null;
}

/** Re-arm backoff is never longer than this (also the autoloop circuit cap). */
const REARM_BACKOFF_CAP_MS = 3_600_000;

/**
 * The re-arm delay (ms from now) for a DEAD loop turn (P1a). A rate-limit / usage-cap death
 * backs off by the classified `retry-after` (or `resetAt - now`), floored at the loop's own
 * interval (never fire sooner than the cadence) and capped. Any other death (crash / empty)
 * re-arms at the plain interval — the failure-streak fire-gate (fed by recordFire('error'))
 * owns escalation for repeated non-rate-limit failures. Pure + injectable `now` for tests.
 */
export function computeDeathRearmMs(outcome: ResumeTurnOutcome, intervalMs: number, now: number = Date.now()): number {
  if (outcome.ok) return intervalMs; // not expected here (handler only re-arms deaths)
  const { error } = outcome;
  if (error.class === 'rate_limited' || error.class === 'usage_limit') {
    const fromRetryAfter = error.retryAfterMs != null && error.retryAfterMs > 0 ? error.retryAfterMs : undefined;
    const fromReset = error.resetAt != null ? error.resetAt - now : undefined;
    const hint = fromRetryAfter ?? (fromReset != null && fromReset > 0 ? fromReset : undefined);
    if (hint != null) return Math.min(Math.max(hint, intervalMs), REARM_BACKOFF_CAP_MS);
  }
  return intervalMs;
}

interface LoopRoutineRef {
  id: string;
  name: string;
  installSlug: string;
  workspaceId: string;
  intervalSec: number | null;
  /** The pinned session the loop wakes — the carry-note / wall-nag scope key (P-006). */
  targetOwnerId: string | null;
}

/** Resolve a loop routine's fire-gate key (install_slug + name) + workspace + interval. */
async function getLoopRoutineRef(sql: Sql, routineId: string): Promise<LoopRoutineRef | null> {
  const rows = await sql<
    Array<{
      id: string;
      name: string;
      install_slug: string;
      workspace_id: string;
      reschedule_interval_sec: number | null;
      target_owner_id: string | null;
    }>
  >`
    SELECT id, name, install_slug, workspace_id, reschedule_interval_sec, target_owner_id
      FROM harness_shared.routines
     WHERE id = ${routineId} AND reschedule_interval_sec IS NOT NULL
     LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    installSlug: r.install_slug,
    workspaceId: r.workspace_id,
    intervalSec: r.reschedule_interval_sec == null ? null : Number(r.reschedule_interval_sec),
    targetOwnerId: r.target_owner_id ?? null,
  };
}

/**
 * Re-arm a loop's `next_fire_at` after its turn died — ONLY while it is still parked at
 * 'infinity' (the turn we observed die). Idempotent + never-backwards: a loop already
 * re-armed (by a racing reconcile) or cron-advanced no longer matches the guard, so this
 * never disturbs a healthy loop nor double-re-arms.
 */
async function rearmLoopAfterDeath(sql: Sql, routineId: string, delayMs: number, now: number): Promise<boolean> {
  const iso = new Date(now + delayMs).toISOString();
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET next_fire_at = ${iso}::timestamptz, updated_at = now()
     WHERE id = ${routineId}
       AND active = TRUE
       AND next_fire_at = 'infinity'::timestamptz
    RETURNING id
  `;
  return rows.length > 0;
}

export interface LoopTurnOutcomeDeps {
  sql?: Sql;
  recordFire?: typeof defaultRecordFire;
  now?: number;
  /** P-006 turn-settle nag seams. */
  getLoopCarryNote?: typeof defaultGetLoopCarryNote;
  stashWallNag?: typeof defaultStashLoopWallNag;
}

/**
 * Handle a resume turn's observed exit for a LOOP-sourced wake. Fail-soft (never throws):
 * the outcome feed is a protection layer, and the reconcile stuck-park backstop is the
 * durable fallback. Returns a small result for tests/observability.
 */
export async function handleLoopResumeTurnExit(
  d: DeliveryWork,
  raw: ResumeTurnExitRaw,
  deps: LoopTurnOutcomeDeps = {},
): Promise<{ handled: boolean; routineId?: string; class?: string; rearmedMs?: number; nagged?: boolean }> {
  try {
    const routineId = loopRoutineIdFromSource(d.source);
    if (!routineId) return { handled: false }; // not a loop wake — nothing to attribute
    const now = deps.now ?? Date.now();
    const outcome = classifyResumeTurnExit(raw, now);
    if (outcome.ok) {
      // Survived — reconcile owns the 'ok' circuit reset. P-006 turn-settle nag: a clean
      // detached turn's stdout tail IS its final text — an owner-ask there with ZERO wall
      // rows is a commitment about to dissolve; stash the nag for the next fire. Pure
      // detect FIRST (no DB unless it hits), then everything fail-soft.
      let nagged = false;
      try {
        const excerpt = detectOwnerAsk(raw.stdoutTail);
        if (excerpt) {
          const sql = deps.sql ?? getOrgPg().sql;
          const ref = await getLoopRoutineRef(sql, routineId);
          if (ref?.targetOwnerId) {
            const getNote = deps.getLoopCarryNote ?? defaultGetLoopCarryNote;
            const note = await getNote({ harness: ref.installSlug, ownerId: ref.targetOwnerId });
            if (splitCarryNoteWalls(note).walls.length === 0) {
              const stash = deps.stashWallNag ?? defaultStashLoopWallNag;
              nagged = await stash({ harness: ref.installSlug, ownerId: ref.targetOwnerId }, excerpt, now);
              if (nagged) log(`loop '${routineId}' turn ended on a row-less owner-ask — nag stashed for the next wake`);
            }
          }
        }
      } catch { /* the nag is best-effort — never disturb the outcome contract */ }
      return { handled: false, routineId, ...(nagged ? { nagged: true } : {}) };
    }

    const sql = deps.sql ?? getOrgPg().sql;
    const recordFire = deps.recordFire ?? defaultRecordFire;
    const ref = await getLoopRoutineRef(sql, routineId);
    if (!ref) return { handled: false, routineId }; // loop ended / not a loop routine

    const klass = outcome.error.class;
    // 1. Feed the EXISTING autoloop circuit (P0b). recordFire keys off activeWorkspaceId(),
    //    so run it under the loop's workspace (the delivery lives in the coord workspace).
    await runWithWorkspace(ref.workspaceId, () =>
      recordFire(
        ref.installSlug,
        ref.name,
        `resume-turn-death:${klass}`,
        // WI-669: an infra-shaped death (rate-limit/transport/timeout) must not
        // ratchet the exponential backoff — classify; genuine turn deaths still count.
        classifyFireError(`resume-turn-death:${klass}`),
      ),
    ).catch((e) => log(`recordFire failed for loop ${routineId}: ${e instanceof Error ? e.message : e}`));

    // 2. 429-aware re-arm (P1a) — only while still parked at 'infinity' (the dead turn).
    const intervalMs = (ref.intervalSec ?? 60) * 1000;
    const delayMs = computeDeathRearmMs(outcome, intervalMs, now);
    const rearmed = await rearmLoopAfterDeath(sql, routineId, delayMs, now).catch((e) => {
      log(`re-arm failed for loop ${routineId}: ${e instanceof Error ? e.message : e}`);
      return false;
    });
    log(
      `loop '${routineId}' turn DIED (${klass}) → recorded error + ${rearmed ? `re-armed +${Math.round(delayMs / 1000)}s` : 'not re-armed (already advanced)'}`,
    );
    return { handled: true, routineId, class: klass, rearmedMs: rearmed ? delayMs : undefined };
  } catch (e) {
    log(`handler failed (fail-soft): ${e instanceof Error ? e.message : e}`);
    return { handled: false };
  }
}

// ── Registration (module side-effect, mirroring lock-grant-bridge's reconciler) ─────────
// Wire this handler into the await pump so every resume-headless turn's exit is observed.
// Fire-and-forget: the pump's onResumeTurnExit is sync (a child 'close' listener), so we
// kick the async handler and never block the close.
registerResumeTurnOutcomeHandler((d, exit) => {
  void handleLoopResumeTurnExit(d, exit);
});
