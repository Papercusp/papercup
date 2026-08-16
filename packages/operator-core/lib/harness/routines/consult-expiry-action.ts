/**
 * `system:consult-expiry-sweep` — the consult lifecycle expiry sweep's
 * routine-engine registration (get-feedback-relevance-consults-2026-08-16
 * P-005 / D-005). The sweep logic lives in `../../consult/consult-expiry-core.ts`
 * (pure + integration-tested against the real migration-834 tables); this module
 * is the thin adapter wiring it into the ephemeral-executor's dispatch
 * (`system-actions.ts`) with production deps (org PG + emitAwaitedEvent).
 *
 * Seeded as a bespoke `tier:'ephemeral'` routine (300s cadence) by
 * `seed-consult-expiry-routine.ts` — an operator-HOME-level substrate concern
 * (one sweep serves every workspace's consult rows), not a per-blueprint-install
 * one; mirrors `supervision-reconcile-action.ts`'s documented deviation.
 */
import { registerSystemAction } from './system-actions';

registerSystemAction('consult-expiry-sweep', async () => {
  const [{ getOrgPg }, { sweepExpiredConsults }, { emitAwaitedEvent }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../../consult/consult-expiry-core'),
    import('../../events/await/engine'),
  ]);
  await sweepExpiredConsults({
    getSql: () => getOrgPg().sql,
    emitReplyEvent: async (e) => {
      // Per-row workspace: consult_state is workspace-partitioned and one sweep
      // covers them all, so the emit must land in the ROW's workspace, not the
      // routine's ALS scope.
      await emitAwaitedEvent({
        key: e.key,
        summary: e.summary,
        payload: e.payload,
        to: e.to,
        workspaceId: e.workspaceId,
        source: 'consult-expiry-sweep',
      });
    },
  });
});
