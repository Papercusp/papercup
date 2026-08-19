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
import type { AgentIdentity } from '../../agent-tools/coordination/identity';

/** The sweep acts under a per-row workspace SYSTEM identity when it wakes the
 * next cascade selectee — consult_state is workspace-partitioned and one sweep
 * serves every workspace, so identity cannot come from the routine's ALS scope
 * (mirrors probeIdentity in coord-invariant-actions.ts). */
function sweepIdentity(workspaceId: string): AgentIdentity {
  return {
    ownerId: 'system:consult-expiry-sweep',
    ownerLabel: 'consult expiry sweep',
    source: 'omp-hook-session',
    workspaceId,
    userId: null,
  } as AgentIdentity;
}

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
    // D-005 cascade advance: an unanswered window elapsing wakes the NEXT
    // selectee exactly like a decline does — notifyAgents (subscribe + ping +
    // wake, so the selectee joins the consult conversation durably).
    reach: async (opts) => {
      const { notifyAgents } = await import('../../agent-tools/coordination/notify-agents');
      const r = await notifyAgents(sweepIdentity(opts.workspaceId), {
        addressees: [opts.responder],
        objectRef: { kind: 'conversation', ref: opts.conversationId },
        summary: opts.summary,
        body: opts.body,
        wake: true,
      });
      return { woke: r.woke };
    },
    // EI-20864690354207496 refill-exhaustion revival: the sweep serves every
    // workspace, so the reviver context is built per row (mirrors reach) —
    // same WI-39852 reviver, launchedBy stamped as the sweep for provenance.
    revive: async (opts) => {
      const { reviveConsultResponder } = await import('../../consult/revive-responder');
      return reviveConsultResponder(
        { ownerId: opts.ownerId, conversationId: opts.conversationId, brief: opts.brief },
        { workspaceId: opts.workspaceId, harnessSlug: null, launchedBy: 'system:consult-expiry-sweep' },
      );
    },
  });
});
