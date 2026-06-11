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
  const requiredSec = open
    ? backoffCapSec()
    : Math.min(backoffBaseSec() * 2 ** (errors - 1), backoffCapSec());
  const lastMs = state.lastFiredAt ? state.lastFiredAt.getTime() : 0;
  const elapsedSec = (now.getTime() - lastMs) / 1000;
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
    return evaluateFireGate(await readFireState(slug, role), now);
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
export async function recordFire(
  slug: string,
  role: string,
  status: string,
  outcome: 'attempt' | 'ok' | 'error',
): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const insertErrors = outcome === 'error' ? 1 : 0;
  const onUpdateErrors =
    outcome === 'error'
      ? dsql`${at.consecutiveErrors} + 1`
      : outcome === 'ok'
        ? dsql`0`
        : dsql`${at.consecutiveErrors}`; // attempt: preserve
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
