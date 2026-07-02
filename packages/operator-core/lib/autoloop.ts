/**
 * Autoloop fire-state + error-backoff — autoloop-pot-operator-rebuild-2026-06-05
 * P-009/P-010 (D-009).
 *
 * The two duplicate director-cadence loops are GONE:
 *   - the legacy in-process `setInterval` ticker that lived here, and
 *   - its DBOS twin (`dbos/autoloop-workflow.ts`) — both read
 *     `.papercusp/director-config.json` (`autoLoop:true`), an enablement
 *     surface nothing wrote (last fired 34 days before the rebuild).
 *
 * The surviving cadence loop is the BLUEPRINT path: a harness's blueprint
 * declares `triggers.schedule`, `harness:create` materializes them into
 * `harness_shared.routines`, and the durable DBOS `routinesTick` fires
 * `system:blueprint-run` (→ the blueprint's `spine.decider`) or an agent-role
 * routine directly. Enablement = the Pot creates a harness whose blueprint
 * carries its own autoloop — no `autoLoop:true` flag, no director-config.
 *
 * What REMAINS here is the per-(workspace, harness, role) fire-state on
 * `harness_shared.autoloop_state` — and the previously written-but-never-read
 * `consecutive_errors` is now READ (D-009): `evaluateFireGate` applies
 * exponential backoff to a repeatedly-failing role fire and opens the circuit
 * past a threshold, so a broken director can't be re-fired at full cadence
 * forever. The gate is consulted by the blueprint-run decider fire and the
 * role-routine fire (the live paths); `autoloop:control { op:'reset-errors' }`
 * closes the circuit by hand.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from './workspace-registry';

const at = generated.autoloopStateInHarnessShared;

/** Backoff doubles from this base per consecutive error. */
export function backoffBaseSec(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_BACKOFF_BASE_SEC ?? 60);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** Backoff never exceeds this cap (also the circuit-open retry window). */
export function backoffCapSec(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC ?? 3600);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

/** Consecutive errors at which the circuit OPENS (fires only once per cap window). */
export function circuitThreshold(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_CIRCUIT_THRESHOLD ?? 8);
  return Number.isFinite(n) && n >= 1 ? n : 8;
}

/**
 * The recovery-debounce window (B7 / autonomous-loop-hardening F3). An OPEN circuit that
 * has not fired AT ALL for this long is genuinely WEDGED — its next_fire_at got stuck in
 * the past and routinesTick keeps withholding, so it is no longer even taking its half-open
 * probe (last_fired_at goes stale). Past this window the circuit AUTO-CLOSES so the role
 * resumes cadence, instead of staying gated until a human runs `autoloop:control
 * reset-errors`. Default 6× the cap (~6h) — far beyond the ~hourly probe cadence, so a
 * circuit that IS still probing (recent last_fired_at) never trips it; only a stalled one
 * self-heals. A correctly-failing circuit is thus left open, a stuck one recovers.
 */
export function recoverySec(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_RECOVERY_SEC ?? backoffCapSec() * 6);
  return Number.isFinite(n) && n > 0 ? n : backoffCapSec() * 6;
}

export interface FireState {
  lastFiredAt: Date | null;
  consecutiveErrors: number;
}

export interface FireGateVerdict {
  allow: boolean;
  /** Why a fire was withheld. */
  reason?: 'backoff' | 'circuit-open';
  consecutiveErrors: number;
  /** Seconds until the next allowed attempt (when withheld). */
  retryAfterSec?: number;
  /** The circuit was open past the recovery window with no fire — the caller should
   *  ZERO consecutive_errors so the role returns to full cadence (self-heal, B7/F3).
   *  `checkFireGate` performs the reset; `evaluateFireGate` only flags it (stays pure). */
  autoReset?: boolean;
}

/**
 * The pure backoff decision (D-009). No errors ⇒ allow. With N consecutive
 * errors, a re-fire is allowed only after `base * 2^(N-1)` seconds (capped);
 * at ≥ the circuit threshold the circuit is OPEN — one attempt per cap window
 * (a half-open probe), so a persistently-broken role degrades to ~hourly
 * probes instead of full cadence. A success (`recordFire 'ok'`) closes it.
 */
export function evaluateFireGate(state: FireState | null, now: Date = new Date()): FireGateVerdict {
  const errors = state?.consecutiveErrors ?? 0;
  if (!state || errors <= 0) return { allow: true, consecutiveErrors: errors };
  const open = errors >= circuitThreshold();
  const lastMs = state.lastFiredAt ? state.lastFiredAt.getTime() : 0;
  const elapsedSec = (now.getTime() - lastMs) / 1000;
  // Recovery-debounce auto-heal (B7 / F3): an OPEN circuit that has not fired for the whole
  // recovery window is WEDGED (stuck next_fire_at, no half-open probe, stale last_fired_at).
  // Auto-close it — signal `autoReset` so checkFireGate zeroes the counter and the role
  // resumes cadence, rather than needing a manual `autoloop:control reset-errors`. A circuit
  // that is still probing keeps a recent last_fired_at, so it never trips this: only a
  // stalled circuit heals; a correctly-failing one stays open.
  if (open && elapsedSec >= recoverySec()) {
    return { allow: true, consecutiveErrors: errors, autoReset: true };
  }
  const requiredSec = open
    ? backoffCapSec()
    : Math.min(backoffBaseSec() * 2 ** (errors - 1), backoffCapSec());
  if (elapsedSec >= requiredSec) return { allow: true, consecutiveErrors: errors };
  return {
    allow: false,
    reason: open ? 'circuit-open' : 'backoff',
    consecutiveErrors: errors,
    retryAfterSec: Math.ceil(requiredSec - elapsedSec),
  };
}

/** Read the fire-state row for (active workspace, slug, role), or null. */
export async function readFireState(slug: string, role: string): Promise<FireState | null> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await db
    .select({ last_fired_at: at.lastFiredAt, consecutive_errors: at.consecutiveErrors })
    .from(at)
    .where(and(eq(at.workspaceId, ws), eq(at.harnessSlug, slug), eq(at.role, role)));
  if (rows.length === 0) return null;
  return {
    lastFiredAt: rows[0].last_fired_at ? new Date(rows[0].last_fired_at) : null,
    consecutiveErrors: Number(rows[0].consecutive_errors ?? 0),
  };
}

/** Read + evaluate in one call — the gate the live fire paths consult. */
export async function checkFireGate(slug: string, role: string, now: Date = new Date()): Promise<FireGateVerdict> {
  try {
    const state = await readFireState(slug, role);
    const verdict = evaluateFireGate(state, now);
    if (verdict.autoReset) {
      // Recovery-debounce: the circuit was open past the recovery window with no fire (a
      // wedged routine, not a probing one) — self-heal by zeroing the counter so the role
      // resumes cadence (B7 / F3). Best-effort: on a write failure we still allow this fire
      // (fail-open, matching the gate's protection-not-dependency contract below).
      const openForSec = Math.round((now.getTime() - (state?.lastFiredAt?.getTime() ?? 0)) / 1000);
      await resetFireErrors(slug, role).catch((e) =>
        console.warn(
          `[autoloop] auto-recovery reset failed (${slug}/${role}):`,
          e instanceof Error ? e.message : e,
        ),
      );
      console.log(
        `[autoloop] ${slug}/${role}: circuit AUTO-RECOVERED (was open ~${openForSec}s with no fire, past the ${recoverySec()}s recovery window) — resuming cadence`,
      );
      return { allow: true, consecutiveErrors: 0 };
    }
    return verdict;
  } catch (e) {
    // Fail OPEN (allow): the gate is a protection, not a dependency — a PG
    // hiccup must not stop the fleet's scheduled fires.
    console.warn(`[autoloop] fire-gate read failed (${slug}/${role}) — allowing:`, e instanceof Error ? e.message : e);
    return { allow: true, consecutiveErrors: 0 };
  }
}

/**
 * Record a fire-path event for (active workspace, slug, role).
 *
 * `outcome` semantics (P-009 — fixes the old write path where the pre-fire
 * `'firing'` record RESET the counter, so consecutive_errors could never
 * exceed 1):
 *   - 'attempt' — a fire was dispatched; status updated, counter PRESERVED.
 *   - 'ok'      — the fire succeeded; counter reset to 0 (closes the circuit).
 *   - 'error'   — the fire failed; counter incremented.
 */
/** WI-669 (2026-07-02): classify a fire-failure message as INFRA-shaped (transient:
 *  gateway stalls, host restarts, rate limits, timeouts, transport) vs a genuine
 *  role/turn failure. Infra failures record 'infra-error' — status stamped, counter
 *  PRESERVED — so a transient outage can't ratchet the exponential backoff to the
 *  ~1-fire/hour circuit that made a healthy loop look dead (observed 2026-06-23:
 *  consecutive_errors=7 → 3600s cap). Genuine failures still back off + trip the
 *  circuit. Pure; exported for tests. */
export function classifyFireError(message: string): 'infra-error' | 'error' {
  return /HTTP 5\d\d|HTTP 404|unknown project|ECONNREFUSED|ECONNRESET|EPIPE|fetch failed|socket hang up|timed out|timeout|deadline|rate.?limit|429|overloaded|infra_loss|gateway (stall|throttl|unavailable)|reclaimed at operator|dead\/restarting launcher|resume-turn-death:(rate-limit|infra|transport)|no (Overwatch |queen )?turn/i.test(
    message,
  )
    ? 'infra-error'
    : 'error';
}

export async function recordFire(
  slug: string,
  role: string,
  status: string,
  outcome: 'attempt' | 'ok' | 'error' | 'infra-error',
): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const insertErrors = outcome === 'error' ? 1 : 0;
  const onUpdateErrors =
    outcome === 'error'
      ? dsql`${at.consecutiveErrors} + 1`
      : outcome === 'ok'
        ? dsql`0`
        : dsql`${at.consecutiveErrors}`; // attempt / infra-error (WI-669): preserve
  await db
    .insert(at)
    .values({
      harnessSlug: slug,
      role,
      lastFiredAt: dsql`now()` as any,
      lastStatus: status,
      consecutiveErrors: insertErrors,
      workspaceId: ws,
    })
    .onConflictDoUpdate({
      target: [at.workspaceId, at.harnessSlug, at.role],
      set: {
        lastFiredAt: dsql`now()`,
        lastStatus: dsql`EXCLUDED.last_status`,
        consecutiveErrors: onUpdateErrors,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
  // Health-signal hygiene (autonomous-loop-hardening F6): piggyback a throttled prune of
  // long-dead fire-state rows on the existing fire path, so the table self-maintains without a
  // new scheduler. Fire-and-forget + time-gated, so it adds no per-fire cost in the common case
  // and never blocks or fails a fire.
  maybePruneStaleFireState(Date.now());
}

/** How stale a zero-error fire-state row must be before the hygiene prune retires it. A live
 *  autoloop role fires every minutes–hours, so a row untouched this long belongs to a
 *  since-deleted harness/role — never an active one. Env-overridable, floored at 1 day. */
export function pruneMaxAgeDays(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_PRUNE_MAX_AGE_DAYS ?? 14);
  return Number.isFinite(n) && n >= 1 ? n : 14;
}

/**
 * Retire long-dead fire-state rows (autonomous-loop-hardening F6 — health-signal hygiene).
 * DELETEs rows that have not fired for `maxAgeDays` AND carry no error signal
 * (`consecutive_errors = 0`) — a role that fired once for a since-deleted harness and went
 * quiet, leaving cruft that clutters `autoloop:status` and any health read. GLOBAL (every
 * workspace): the accumulation is old dead harnesses across workspaces, and a ≥14-day-stale
 * zero-error row cannot belong to a live role. Rows with a non-zero error counter are
 * PRESERVED (real circuit signal for reset-errors / investigation), and recently-fired rows
 * are untouched — so this can never disturb an active or a legitimately-failing circuit.
 * Returns the number of rows retired.
 */
export async function pruneStaleFireState(opts: { maxAgeDays?: number } = {}): Promise<number> {
  const maxAgeDays = opts.maxAgeDays && opts.maxAgeDays > 0 ? opts.maxAgeDays : pruneMaxAgeDays();
  const { db } = getOrgPg();
  const res = await db
    .delete(at)
    .where(
      and(
        dsql`${at.lastFiredAt} IS NOT NULL`,
        dsql`${at.lastFiredAt} < now() - (${maxAgeDays}::int * interval '1 day')`,
        eq(at.consecutiveErrors, 0),
      ),
    );
  return Number((res as unknown as { count?: number }).count ?? 0);
}

/** Hygiene-prune cadence (per process): at most one prune per this window. */
export const PRUNE_THROTTLE_MS = 6 * 3600_000;

/** Pure throttle gate — a prune is due when it has never run (lastPruneAtMs ≤ 0, the sentinel)
 *  or the window has elapsed. The never-run case is explicit so it holds for any clock, not
 *  only real epoch-ms. Extracted so the cadence is unit-testable without a DB or a clock. */
export function isPruneDue(
  nowMs: number,
  lastPruneAtMs: number,
  throttleMs: number = PRUNE_THROTTLE_MS,
): boolean {
  if (lastPruneAtMs <= 0) return true; // never pruned this process — always due
  return nowMs - lastPruneAtMs >= throttleMs;
}

let lastPruneAtMs = 0;

/** Fire-and-forget, time-gated hygiene prune (F6). Called from the fire path; runs the DELETE
 *  at most once per `PRUNE_THROTTLE_MS` per process, swallowing errors so it never affects a
 *  fire. The first call after process start runs it, clearing accumulated cruft on startup. */
export function maybePruneStaleFireState(nowMs: number): void {
  if (!isPruneDue(nowMs, lastPruneAtMs)) return;
  lastPruneAtMs = nowMs;
  void pruneStaleFireState().then(
    (n) => {
      if (n > 0) {
        console.log(
          `[autoloop] hygiene: retired ${n} stale fire-state row(s) (≥${pruneMaxAgeDays()}d idle, no errors)`,
        );
      }
    },
    (e) => console.warn('[autoloop] hygiene prune failed (non-fatal):', e instanceof Error ? e.message : e),
  );
}

/**
 * Atomically claim a fire slot for (active workspace, slug, role) — the
 * single-flight guard for schedulers whose check-then-act window can overlap
 * (EI-304: two concurrent Scout ticks both snapshot stale cadence state, both
 * pass the min-interval floor, both spend a full budgeted cycle).
 *
 * CAS on `last_fired_at`: the claim succeeds only while the row's value still
 * matches what the caller read (compared at ms precision — JS readers get a
 * Date and lose PG's µs), stamping `now()` so every concurrent loser's
 * expected value is stale by the time its UPDATE runs. A never-fired slot
 * (expected null) is claimed by insert, falling back to a NULL-guarded UPDATE
 * when the row exists unstamped. Each path is a single statement, so the
 * guard holds across processes, not just within one event loop.
 */
export async function claimFire(
  slug: string,
  role: string,
  expectedLastFiredAtMs: number | null,
  status = 'claimed',
): Promise<boolean> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  if (expectedLastFiredAtMs == null) {
    const ins = await db
      .insert(at)
      .values({
        harnessSlug: slug,
        role,
        lastFiredAt: dsql`now()` as any,
        lastStatus: status,
        consecutiveErrors: 0,
        workspaceId: ws,
      })
      .onConflictDoNothing({ target: [at.workspaceId, at.harnessSlug, at.role] });
    if (Number((ins as unknown as { count?: number }).count ?? 0) > 0) return true;
    const upd = await db
      .update(at)
      .set({ lastFiredAt: dsql`now()`, lastStatus: status })
      .where(
        and(
          eq(at.workspaceId, ws),
          eq(at.harnessSlug, slug),
          eq(at.role, role),
          dsql`${at.lastFiredAt} IS NULL`,
        ),
      );
    return Number((upd as unknown as { count?: number }).count ?? 0) > 0;
  }
  const upd = await db
    .update(at)
    .set({ lastFiredAt: dsql`now()`, lastStatus: status })
    .where(
      and(
        eq(at.workspaceId, ws),
        eq(at.harnessSlug, slug),
        eq(at.role, role),
        dsql`date_trunc('milliseconds', ${at.lastFiredAt}) = to_timestamp(${expectedLastFiredAtMs}::double precision / 1000.0)`,
      ),
    );
  return Number((upd as unknown as { count?: number }).count ?? 0) > 0;
}

/** Close the circuit by hand: zero the error counters for a harness (all roles,
 *  or one). The `autoloop:control { op:'reset-errors' }` target. */
export async function resetFireErrors(slug: string, role?: string): Promise<number> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const where = role
    ? and(eq(at.workspaceId, ws), eq(at.harnessSlug, slug), eq(at.role, role))
    : and(eq(at.workspaceId, ws), eq(at.harnessSlug, slug));
  const res = await db
    .update(at)
    .set({ consecutiveErrors: 0, lastStatus: 'errors-reset' })
    .where(where);
  return Number((res as unknown as { count?: number }).count ?? 0);
}

/** Diagnostic read for a harness (all roles) — the autoloop:status surface. */
export async function getAutoLoopState(slug: string): Promise<any[] | null> {
  const { db } = getOrgPg();
  const rows = await db
    .select({
      harness_slug: at.harnessSlug,
      role: at.role,
      last_fired_at: at.lastFiredAt,
      last_status: at.lastStatus,
      consecutive_errors: at.consecutiveErrors,
    })
    .from(at)
    .where(eq(at.harnessSlug, slug))
    .orderBy(at.role);
  return rows.length > 0 ? rows : null;
}
