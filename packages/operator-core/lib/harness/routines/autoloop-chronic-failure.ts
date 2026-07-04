/**
 * autoloop-chronic-failure — the CHRONIC-FAILURE ESCALATOR
 * (gym-unwedge-scout-novelty-2026-07-02 GYM-2, generalized across roles).
 *
 * THE GAP THIS CLOSES: a routine-driven cycle can fail EVERY fire and nothing
 * escalates — the gym-cycle sat at consecutive_errors=72 (12 days dead) and the
 * only witness was a bare `gym-cycle:error` literal nobody read. The fire-gate's
 * error backoff correctly SLOWS a failing cycle, but slowing is not surfacing:
 * a chronically-red autoloop row must become a visible, owned artifact.
 *
 * MECHANISM (the watchdog-sweep house pattern — pure decider + debounced
 * fail-soft PG sweep on the routines tick): any `autoloop_state` row with
 * `consecutive_errors >= threshold` files ONE improvements OBSERVATION
 * (kind bug, carrying the verbatim last_status) per breach, debounced 24h per
 * (harness, role) via the `hive_watchdog_fires` ledger. The observation enters
 * the SAME triage pipeline scout/queen already consume — no parallel alerting
 * system. Kill switch: PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD <= 0.
 *
 * SKIP AN ALREADY-PAUSED ROUTINE (found live: EI-6760/6761/6762 — a loop-arm
 * loop whose owner session died was correctly auto-paused by the pre-existing
 * stuck-park backstop / the WI-1399 dead-owner guard — `harness_shared.routines
 * .active = false` — 13+ hours before this sweep next ran, yet the sweep kept
 * re-escalating it as if it were still actively failing, because it only reads
 * `autoloop_state.consecutive_errors` and never checks whether the underlying
 * routine is still armed). A `consecutive_errors` streak is a STALE watermark —
 * it is only meaningfully "chronic" while the routine is still trying (and
 * failing) to fire. So this LEFT JOINs `harness_shared.routines` on
 * `(name, workspace_id)` and drops a row whose matching routine is explicitly
 * `active = false` — a resolved (already-paused) condition, not a live one.
 * A role with NO matching routines row (director/gym-cycle/overwatch/
 * scout-cycle — fixed system roles, not `loop:arm` rows) has nothing to join
 * against and is treated as still-live (fail-open: an unknown routine state
 * must never SUPPRESS a genuine chronic-failure alert).
 */
import { getOrgPg } from '@papercusp/db-org';
import { recentWatchdogFires, claimWatchdogFire } from '../../hive/watchdog';
import { activeWorkspaceId } from '../../workspace-registry';

/** Breach threshold (env-overridable; <=0 disables the sweep). */
export function chronicErrorThreshold(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD ?? 6);
  return Number.isFinite(n) ? n : 6;
}

/**
 * Staleness window (env-overridable). A `consecutive_errors` streak is only
 * meaningfully "chronic" while the routine is still TRYING to fire — a row whose
 * `last_fired_at` is older than this window is a FROZEN watermark, not a live
 * failure, and must not re-escalate forever.
 *
 * EI-6765 (overwatch@papercup, red 6 consecutive fires yet `last_fired_at` was
 * 8 DAYS stale): the active overwatch loop had moved to the `papercusp` home slug
 * (which is `ok`), leaving an orphaned `papercup` row frozen at 6 errors. The
 * pre-existing `routine_active = false` guard catches AUTO-PAUSED loops, but an
 * ORPHANED slug (rename/migration/one-time misfire) never fires again, so its
 * streak can NEVER reset — it re-escalated once every 24h debounce cycle in
 * perpetuity. Default 6h = 6× the 1h fire-gate backoff cap
 * (PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC), so a genuinely-failing loop (which fires
 * at least hourly even fully backed off) is NEVER suppressed. <=0 disables the
 * staleness guard (fail-open — every breaching row escalates as before).
 */
export function staleWindowMs(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_STALE_MS ?? 6 * 60 * 60 * 1000);
  return Number.isFinite(n) ? n : 6 * 60 * 60 * 1000;
}

export interface AutoloopStateRow {
  harness_slug: string;
  role: string;
  consecutive_errors: number;
  last_status: string | null;
  /** The matching `harness_shared.routines.active` for this (workspace, role) — from a LEFT
   *  JOIN, so `null` means no matching routine row exists (a fixed system role, not a
   *  loop:arm-materialized routine). `false` is the ONLY value that suppresses escalation —
   *  the routine engine itself has already resolved this condition (auto-paused). */
  routine_active: boolean | null;
  /** When this autoloop row last FIRED. A streak whose last fire is older than
   *  `staleWindowMs()` is a frozen watermark (EI-6765) — the row stopped firing
   *  (orphaned/renamed slug) so its error count can never reset. `null`/absent =
   *  unknown → fail-OPEN (treated as live, never silently suppressed). */
  last_fired_at?: string | Date | null;
  /** The matching `harness_shared.routines.target_owner_id` — the warm coord owner of a
   *  `loop:arm`-materialized loop (`loop-su-<uuid>` role, `target_role = system:loop-wake`).
   *  NON-NULL ⇒ this is an EPHEMERAL loop:arm OWNER loop, not a fixed system role
   *  (director/gym-cycle/overwatch/scout-cycle, which carry `null`). EI-6727: such loops are
   *  owner-witnessed AND managed end-to-end by the reconcile terminal-guard autonomy — a dead
   *  owner is auto-paused with its OWN dedicated human escalation (`escalateDeadLoop`,
   *  WI-2339 fix E). So the chronic-failure sweep escalating them is a PREMATURE DUPLICATE
   *  (fired in the window before the guard pauses the routine), flooding the queue with
   *  un-actionable "loop-su-<uuid> red N fires" tickets (28 accumulated). NON-NULL suppresses
   *  escalation; `null`/absent (a fixed system role, the sweep's intended scope) does NOT. */
  routine_target_owner_id?: string | null;
}

/** PURE: is this row's error streak a FROZEN watermark rather than a live failure —
 *  i.e. has it not fired within the staleness window? `null`/absent `last_fired_at`
 *  (or an unparseable value) fails OPEN (returns false: treat as live), matching the
 *  `routine_active: null` fail-open philosophy — never silently suppress on unknown. */
export function isStaleWatermark(
  row: Pick<AutoloopStateRow, 'last_fired_at'>,
  now: number,
  staleMs: number,
): boolean {
  if (staleMs <= 0) return false;
  const raw = row.last_fired_at;
  if (raw == null) return false;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t > staleMs;
}

/** PURE: which rows breach the threshold (highest streak first), EXCLUDING any row that is
 *  (a) an EPHEMERAL `loop:arm` OWNER loop (`routine_target_owner_id` non-null — EI-6727: managed
 *  end-to-end by the reconcile terminal-guard autonomy with its own dedicated dead-owner
 *  escalation, so a chronic-failure ticket is a premature duplicate); (b) already auto-paused
 *  (`routine_active: false` — a resolved condition, not a live chronic failure; see this module's
 *  header comment); or (c) a FROZEN watermark (EI-6765 — `last_fired_at` older than the staleness
 *  window; the row stopped firing so its error count can never reset). `routine_target_owner_id`
 *  null (a fixed system role — director/gym-cycle/overwatch/scout-cycle, the sweep's intended
 *  scope), `routine_active: null`, and absent `last_fired_at` are NOT excluded — fail-open, never
 *  silently suppress an unknown state. */
export function selectChronicFailures(
  rows: readonly AutoloopStateRow[],
  threshold: number,
  opts?: { now?: number; staleMs?: number },
): AutoloopStateRow[] {
  if (threshold <= 0) return [];
  const now = opts?.now ?? Date.now();
  const staleMs = opts?.staleMs ?? staleWindowMs();
  return rows
    .filter(
      (r) =>
        r.consecutive_errors >= threshold &&
        !isLoopArmOwnerLoop(r) &&
        r.routine_active !== false &&
        !isStaleWatermark(r, now, staleMs),
    )
    .sort((a, b) => b.consecutive_errors - a.consecutive_errors);
}

/** PURE: is this an ephemeral `loop:arm` OWNER loop (EI-6727)? A non-null
 *  `routine_target_owner_id` marks a `loop-su-<uuid>` warm-coord loop — owner-witnessed and
 *  auto-terminated by the reconcile dead-owner guard (which fires its OWN escalation), so the
 *  chronic-failure sweep must not also escalate it. `null`/absent = a fixed system role → not a
 *  loop:arm loop → fail-OPEN (still eligible to escalate), never silently suppressed. */
export function isLoopArmOwnerLoop(row: Pick<AutoloopStateRow, 'routine_target_owner_id'>): boolean {
  return row.routine_target_owner_id != null && row.routine_target_owner_id !== '';
}

export interface ChronicFailureResult {
  harnessSlug: string;
  role: string;
  outcome: 'escalated' | 'debounced' | 'skipped-paused' | 'skipped-stale' | 'skipped-loop-arm' | 'error';
  reason: string;
}

/**
 * The sweep. Fail-soft by contract; debounced 24h per (harness, role) so a
 * still-red row escalates once a day, not every 30s tick.
 */
export async function autoloopChronicFailureSweep(): Promise<ChronicFailureResult[]> {
  const results: ChronicFailureResult[] = [];
  const threshold = chronicErrorThreshold();
  if (threshold <= 0) return results;
  try {
    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    const now = Date.now();
    const staleMs = staleWindowMs();
    const allRows = await sql<AutoloopStateRow[]>`
      SELECT s.harness_slug, s.role, s.consecutive_errors, s.last_status, s.last_fired_at, r.active AS routine_active
        FROM harness_shared.autoloop_state s
   LEFT JOIN harness_shared.routines r
          ON r.name = s.role AND r.workspace_id = s.workspace_id
       WHERE s.consecutive_errors >= ${threshold}`;
    const pausedSkipped = allRows.filter((r) => r.consecutive_errors >= threshold && r.routine_active === false);
    // EI-6765: a breaching, non-paused row whose last fire is older than the staleness
    // window is a FROZEN watermark (orphaned/renamed slug that stopped firing), not a
    // live chronic failure — report it as skipped-stale for observability, never escalate.
    const staleSkipped = allRows.filter(
      (r) =>
        r.consecutive_errors >= threshold &&
        r.routine_active !== false &&
        isStaleWatermark(r, now, staleMs),
    );
    const breaches = selectChronicFailures(allRows, threshold, { now, staleMs });
    for (const p of pausedSkipped) {
      results.push({
        harnessSlug: p.harness_slug,
        role: p.role,
        outcome: 'skipped-paused',
        reason: `routine already auto-paused (active:false) — resolved, not a live chronic failure`,
      });
    }
    for (const s of staleSkipped) {
      results.push({
        harnessSlug: s.harness_slug,
        role: s.role,
        outcome: 'skipped-stale',
        reason: `no fire within ${Math.round(staleMs / 3_600_000)}h (last_fired_at ${s.last_fired_at ?? 'null'}) — frozen watermark, not a live chronic failure`,
      });
    }
    for (const b of breaches) {
      try {
        const source = 'autoloop-chronic' as const;
        const installSlug = `${b.harness_slug}::${b.role}`;
        const alreadyFired = (await recentWatchdogFires(workspaceId, installSlug, 24, source)) > 0;
        if (alreadyFired) {
          results.push({ harnessSlug: b.harness_slug, role: b.role, outcome: 'debounced', reason: 'escalated within 24h' });
          continue;
        }
        const reason = `${b.role}@${b.harness_slug}: ${b.consecutive_errors} consecutive errors — last_status: ${(b.last_status ?? '').slice(0, 200)}`;
        // EI-6777: the `alreadyFired` read above is a cheap, racy pre-check —
        // multiple concurrent sweep ticks/processes can all observe "not fired
        // yet" before any of them records a fire. Atomically re-check + claim
        // the debounce slot right before the one-time escalation side effect
        // so only one racer ever proceeds to captureImprovement below.
        const claimedFire = await claimWatchdogFire({ workspaceId, installSlug, source, windowHours: 24, reason, wakeAt: null });
        if (!claimedFire) {
          results.push({ harnessSlug: b.harness_slug, role: b.role, outcome: 'debounced', reason: 'escalated within 24h (raced)' });
          continue;
        }
        const { captureImprovement } = await import('../improvements/capture-core');
        await captureImprovement({
          title: `CHRONIC autoloop failure: ${b.role}@${b.harness_slug} red ${b.consecutive_errors} consecutive fires`,
          kind: 'bug',
          severity: 'major',
          body:
            `${reason}\n\nThe fire-gate backoff is slowing this cycle but nothing was surfacing it — ` +
            `a chronically-red autoloop row is dead capability (the gym ran 12 days dead this way, WI plan ` +
            `gym-unwedge-scout-novelty-2026-07-02). Read the recorded last_status verbatim FIRST ` +
            `(runbook driving-the-autonomous-hive-loop), fix the root cause, then autoloop:control reset-errors.`,
          scope: `harness:${b.harness_slug}`,
          foundDuring: 'autoloop-chronic-failure sweep (routines tick)',
        });
        // claimWatchdogFire already recorded the fire atomically above —
        // no separate recordFire call here (that was the race this closes).
        results.push({ harnessSlug: b.harness_slug, role: b.role, outcome: 'escalated', reason });
      } catch (e) {
        results.push({
          harnessSlug: b.harness_slug,
          role: b.role,
          outcome: 'error',
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[autoloop-chronic] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
