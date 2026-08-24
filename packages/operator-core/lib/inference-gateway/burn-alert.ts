/**
 * burn-alert.ts — WI-41147 leg c: the STATED WALL. When an account's burn verdict ACTION
 * transitions to/from `throttle`/`shed`, that fact must never be silent: it is asserted as a
 * standing fact (folded into every orient until it clears) and broadcast on the severe-event
 * coord rail (condition-lifecycle keyed, so a recovery annotates the alarm resolved).
 *
 * SEAM DISCIPLINE (the settled WI-41147 design): the alert fires from the observation WRITE
 * path only — every window write flows through {@link recordAccountWindowWithBurnAlert} —
 * NEVER from the `accounts:status` READ path (a read-path alert fires once per read). The
 * transition edge is detected by diffing the PERSISTED `rate.lastBurnAction` stamp
 * (`accountBurnTransition`), not by re-evaluating pre/post verdicts in context: the persisted
 * stamp survives the stale-gate window, so a re-probe of a still-burning account whose reading
 * aged out does NOT re-alarm none→shed every probe cycle.
 *
 * DELIBERATELY UN-GATED by ACCOUNT_BURN_GOVERNOR: the flag gates ENFORCEMENT (selection +
 * concurrency shed); visibility of a pool burning toward its wall must survive the owner
 * turning enforcement off — knowing is not acting.
 *
 * Fail-soft throughout: an alert failure must never break the observation write that carries
 * it (the write is the durable half).
 */
import type { AccountPool, BurnTransition } from '../deployment/account-pool';

const FACT_TTL_SEC = 6 * 3600;
const FACT_CREATED_BY = 'system:burn-governor';

const factKey = (accountId: string): string => `account-burn:${accountId}`;

/**
 * Record one account's observed usage window into the pool projection AND state any burn-verdict
 * wall it implies — the ONE wrapper every observation write seam (the `accounts:probe-capacity`
 * tool, the live-traffic window projector) calls instead of hand-composing
 * `updateAccountPool(recordAccountWindow(...))`. Returns the updated pool plus the transition
 * (null when the verdict action did not change), so callers can surface it in their own results.
 */
export async function recordAccountWindowWithBurnAlert(
  accountId: string,
  w: { utilization?: number; windowResetAt?: number; utilization7d?: number; windowResetAt7d?: number },
  now: number,
  ws?: string,
): Promise<{ pool: AccountPool; transition: BurnTransition | null }> {
  const [{ updateAccountPool }, { recordAccountWindow, accountBurnTransition }] = await Promise.all([
    import('../deployment/account-pool-store'),
    import('../deployment/account-pool'),
  ]);
  let transition: BurnTransition | null = null;
  let action: 'none' | 'throttle' | 'shed' | undefined;
  const pool = await updateAccountPool((p) => {
    const next = recordAccountWindow(p, accountId, w, now);
    // Captured inside the mutator so the diff sees the exact pre-write row the transaction
    // read (a snapshot loaded before the txn could race a peer's write). On a txn retry the
    // capture re-runs and the final attempt wins.
    transition = accountBurnTransition(p, next, accountId, now);
    action = next.accounts.find((a) => a.id === accountId)?.rate.lastBurnAction ?? undefined;
    return next;
  }, ws);
  await stateBurnWall(accountId, action, transition, ws).catch(() => {});
  return { pool, transition };
}

/**
 * The never-silent half. Two independent legs:
 *  - FACT: while the freshest observation says throttle/shed, `account-burn:<id>` is
 *    (re-)asserted on EVERY observation write — the upsert refreshes the TTL, so the standing
 *    fact lives exactly as long as the condition is being OBSERVED and expires honestly when
 *    observations stop. A recovery transition retracts it immediately.
 *  - BROADCAST: severe-event rail, on the TRANSITION edge only (throttle/shed escalations and
 *    de-escalations broadcast the new level; recovery to none broadcasts resolved). Keyed by
 *    conditionKey so coord:inbox annotates stale alarms resolved.
 */
async function stateBurnWall(
  accountId: string,
  action: 'none' | 'throttle' | 'shed' | undefined,
  transition: BurnTransition | null,
  ws?: string,
): Promise<void> {
  if (action === undefined) return; // unknown account — the write was a no-op
  const burning = action === 'throttle' || action === 'shed';
  if (!burning && !transition) return; // healthy and unchanged — nothing to state

  if (burning) {
    const reason = transition?.reason ?? '';
    const { assertFact } = await import('../agent-facts/store');
    await assertFact({
      scope: 'workspace',
      key: factKey(accountId),
      body: `Account '${accountId}' burn verdict ${action.toUpperCase()}${reason ? ` — ${reason}` : ''} (burn governor WI-41147; verify: accounts:status).`,
      createdBy: FACT_CREATED_BY,
      ttlSec: FACT_TTL_SEC,
      ...(ws ? { workspaceId: ws } : {}),
    }).catch((e) => {
      console.warn(`[burn-alert] fact assert failed for '${accountId}' (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  if (!transition) return;

  if (transition.to === 'none') {
    // Recovery: retract the standing fact + resolve the alarm.
    const { retractFact } = await import('../agent-facts/store');
    await retractFact({
      scope: 'workspace',
      key: factKey(accountId),
      ...(ws ? { workspaceId: ws } : {}),
      retractedBy: FACT_CREATED_BY,
      reason: `burn verdict recovered to none (was ${transition.from})`,
    }).catch(() => {});
    const { broadcastSevereEventResolved } = await import('../severe-event-broadcast');
    await broadcastSevereEventResolved({
      conditionKey: factKey(accountId),
      summary: `account '${accountId}' burn RECOVERED (${transition.from} → none): ${transition.reason}`,
    });
    return;
  }

  const { broadcastSevereEvent } = await import('../severe-event-broadcast');
  await broadcastSevereEvent({
    summary: `account '${accountId}' burn verdict ${transition.to.toUpperCase()} (was ${transition.from}): ${transition.reason}`,
    body:
      `The burn governor (WI-41147) projects this account's rolling 7-day window exhausts on its current trajectory. ` +
      `Verdict: ${transition.to} — ${transition.reason}\n` +
      `Selection already ${transition.to === 'shed' ? 'refuses' : 'deprioritizes'} this account while the verdict stands; ` +
      `the pool-aggregate lever sheds fleet concurrency if EVERY account is burning. ` +
      `Verify with accounts:status (rows[].burn); accounts:probe-capacity refreshes a stale projection.`,
    category: 'account-burn',
    conditionKey: factKey(accountId),
    // Edge-triggered by construction: this emitter alarms on the TRANSITION and stays silent
    // while the verdict persists — declare it so the staleness reconciler doesn't read the
    // deliberate silence as recovery (WI-6228).
    oneShot: true,
  });
}
