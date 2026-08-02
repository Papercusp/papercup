/**
 * Readiness-drift monitor — `system:readiness-drift-monitor`
 * (work-item-dependency-edges-2026-08-02 P-004).
 *
 * WHY THIS EXISTS. `reconcileReadiness` (lib/scheduler/readiness-reconcile.ts) has
 * been the designated detector for maintained-readiness drift since
 * work-item-deps-and-readiness-2026-06-22 P-005, and its own doc comment says it is
 * "a detector the scheduler/health surface reads". Nothing read it: the only caller
 * in the tree was its integration test. A detector nobody runs is not a safety net,
 * it is a comment — this action is the cadence that actually runs it.
 *
 * WHAT DRIFT MEANS. The `work_item_blocked` sidecar is trigger-maintained; PRESENCE
 * of a row = the feature item is NOT ready. Both drift directions are live hazards:
 *   • MISSING — blocked per the oracle, no sidecar row ⇒ the indexed anti-join claim
 *     HANDS OUT BLOCKED WORK. The dangerous direction.
 *   • EXTRA   — a sidecar row for an item that is not actually blocked ⇒ ready work
 *     STARVES, never claimed.
 *
 * DETECT **AND** REPAIR. `reconcileReadiness` stays a pure detector — that seam is
 * deliberate and unchanged. Repair lives here, and is simply `sync_work_item_blocked`
 * (the SAME function the wir_* triggers call) re-applied to the drifted keys, so it
 * is idempotent and cannot invent state the triggers wouldn't. Set
 * `payload_template.repair = false` for a detect-only tick.
 *
 * ⚠ SCOPE LIMIT — this catches a TRIGGER that has fallen out of step with the
 * ORACLE. It cannot catch an oracle that is itself wrong: when the predicate is
 * defective, the sidecar and the oracle agree perfectly and drift reads 0. That is
 * not hypothetical — it is exactly how EI-19313459163394127 hid. Every issue-family
 * blocking edge in the system was inert for months while this reconciliation would
 * have reported a clean missing=0/extra=0. Correctness of the predicate is the job
 * of migration 719's regression tests, NOT of this monitor; do not read a green tick
 * here as "blocking works".
 *
 * Never throws (the routine engine treats a throw as a failed step, and a monitor
 * must not be able to wedge the tick).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { reconcileReadiness, type ReadinessKey } from '../../scheduler/readiness-reconcile';

/** Max keys named in a log line — the rest are summarized by count. */
const SAMPLE = 10;

const fmt = (keys: readonly ReadinessKey[]): string =>
  keys
    .slice(0, SAMPLE)
    .map((k) => `${k.workspace_id}/${k.harness_slug}#${k.feature_id}`)
    .join(', ') + (keys.length > SAMPLE ? ` …+${keys.length - SAMPLE} more` : '');

/**
 * Re-apply the trigger's own maintenance function to a set of drifted keys.
 * Returns how many were re-synced. Best-effort per key: one bad row never aborts
 * the sweep.
 */
async function repairKeys(keys: readonly ReadinessKey[]): Promise<number> {
  if (keys.length === 0) return 0;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  let repaired = 0;
  for (const k of keys) {
    try {
      await sql`SELECT harness_shared.sync_work_item_blocked(
        ${k.workspace_id}, ${k.harness_slug}, ${k.feature_id})`;
      repaired++;
    } catch (e) {
      console.warn(
        `[readiness-drift-monitor] repair failed for ${k.workspace_id}/${k.harness_slug}#${k.feature_id}: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }
  return repaired;
}

registerSystemAction('readiness-drift-monitor', async (ctx: SystemActionCtx) => {
  try {
    const repairEnabled = ctx.payloadTemplate?.repair !== false;

    const before = await reconcileReadiness();
    if (before.drift === 0) {
      console.log('[readiness-drift-monitor] sidecar agrees with the oracle (drift=0)');
      return;
    }

    // MISSING is the direction that hands out blocked work, so it leads the line.
    console.warn(
      `[readiness-drift-monitor] DRIFT drift=${before.drift} ` +
        `missing=${before.missing.length} (blocked per oracle, no sidecar row → served as ready) ` +
        `extra=${before.extra.length} (sidecar row but not blocked → starving)`,
    );
    if (before.missing.length > 0) console.warn(`[readiness-drift-monitor] missing: ${fmt(before.missing)}`);
    if (before.extra.length > 0) console.warn(`[readiness-drift-monitor] extra: ${fmt(before.extra)}`);

    if (!repairEnabled) {
      console.warn('[readiness-drift-monitor] repair disabled (payload_template.repair=false) — detect only');
      return;
    }

    const repaired = await repairKeys([...before.missing, ...before.extra]);
    const after = await reconcileReadiness();

    if (after.drift === 0) {
      console.log(`[readiness-drift-monitor] repaired ${repaired} key(s); sidecar now agrees with the oracle`);
      return;
    }
    // Residual drift after re-applying the triggers' own function means the fault is
    // NOT a missed trigger firing — it is the maintenance path itself. Say so loudly;
    // that distinction is the whole diagnostic value of the second pass.
    console.warn(
      `[readiness-drift-monitor] RESIDUAL drift=${after.drift} after repairing ${repaired} key(s) — ` +
        're-applying sync_work_item_blocked did not converge, so the fault is in the maintenance ' +
        'function or the oracle, not a missed trigger firing. Investigate rather than re-running.',
    );
  } catch (e) {
    // A monitor must never wedge the routine tick.
    console.warn(
      '[readiness-drift-monitor] sweep failed (non-fatal): ' + (e instanceof Error ? e.message : String(e)),
    );
  }
});
