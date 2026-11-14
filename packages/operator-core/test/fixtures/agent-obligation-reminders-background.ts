/** Private background mechanism proof. Host ACKs are simulated, never LLM acceptance. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { defineAgentObligation, evaluateAgentObligations, goalPlanPlacementChangedKey } from '../../lib/agent-obligations';
import { reconcileAgentObligationReminders, type AgentObligationReminderDeps } from '../../lib/agent-obligation-reminders';
import { pumpWakeDeliveries, setAutoPumpEnabledForTests } from '../../lib/events/await/engine';
import { cancelAwait, claimSpecificOnceAwaits, insertDeliveries, listLifecycleBoundAwaits,
  listRecentDeliveries, registerAwait } from '../../lib/events/await/store';
import type { ExecuteWakeDeps } from '../../lib/events/await/wake-executor';
import { runWithWorkspace } from '../../lib/workspace-als';

async function main() {
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  assert.match(workspace ?? '', /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.equal(process.env.PC_ISOLATED_RUNTIME_PROOF, '1');
  const dsn = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  assert.notEqual(dsn.port, '5432');
  assert.notEqual(dsn.port, '6432');
  const evidenceDir = process.env.OBLIGATION_BACKGROUND_EVIDENCE_DIR!;
  assert.ok(evidenceDir);
  // Enable only this explicitly driven pump; never start a background sweeper.
  process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
  setAutoPumpEnabledForTests(false);
  const ownerId = 'su-private-reminder-' + randomUUID();
  const goalId = 'private-reminder-' + randomUUID();
  const startedAt = new Date().toISOString();
  const eventKey = goalPlanPlacementChangedKey(goalId);
  const obligation = defineAgentObligation({
    ruleId: 'goal-plan-placement', ruleRevision: 'v1', family: 'plan-placement',
    title: 'Private goal placement changed', scope: { workspaceId: workspace!, ownerId, goalId },
    responsibleOwnerId: ownerId, episode: 'private-probe', status: 'due',
    authority: { kind: 'policy', sourceRef: 'private-background-proof', revision: 'v1' },
    reason: 'Exercise the maintained reminder route against private PostgreSQL', priority: 'high',
    causalRank: 1, applicableDemand: 1, sourceGeneration: 'current-source-private-runtime', evidence: [],
    action: { kind: 'report', summary: 'Observe the private reminder' },
    clearsWhen: { id: 'private-delivery', summary: 'The exact delivery settles',
      evidenceKind: 'delivery', sourceRef: 'event_wake_deliveries' },
    changeSignal: { event: eventKey, cancellationRef: 'goal:' + goalId },
  });
  const { sql } = getOrgPg();
  let settled = false;
  const injections: Array<{ deliveryId: string; data: string }> = [];
  const deps: ExecuteWakeDeps = {
    getSession: async () => null,
    getLatestSessionForOwner: async () => null,
    getSessionLifecycle: async () => null,
    resolveWakeModeFn: async () => 'auto',
    workspaceForCoordOwnerFn: async () => workspace!,
    presence: async () => ({ stale: false, revoked: false }) as never,
    findPsuHost: async () => ({ sock: join(evidenceDir, 'simulated-host.sock'), ownerId }) as never,
    injectPsuHostWithConfirmation: async (_sock, message) => {
      assert.equal(message.ownerId, ownerId);
      assert.equal(message.mode, 'turn');
      assert.ok(message.deliveryId);
      injections.push({ deliveryId: message.deliveryId!, data: message.data ?? '' });
      return { ok: true, confirmation: 'acked',
        reason: settled ? 'delivery-already-started' : 'pending-delivery-id' };
    },
    readPsuHostEventTail: () => [],
    tagTurn: input => ({ taggedText: input.text, envelope: '', nonce: 'private-mechanism-proof' }) as never,
    observeFallback: () => false,
    prepareInboxWakeHeldWorkReminder: async () => '',
  };
  try {
    await runWithWorkspace(workspace!, async () => {
      const reminderDeps: AgentObligationReminderDeps = {
        captureHandle: async () => ({ handle: null, note: 'private simulated host' }),
        listHistory: listLifecycleBoundAwaits, register: registerAwait, cancel: cancelAwait,
      };
      const agenda = evaluateAgentObligations([obligation], startedAt);
      const registered = await reconcileAgentObligationReminders({ ownerId, agenda }, reminderDeps);
      assert.equal(registered.error, undefined);
      assert.equal(registered.registered, 1);
      const retained = await reconcileAgentObligationReminders({ ownerId, agenda }, reminderDeps);
      assert.equal(retained.retained, 1);
      const history = await listLifecycleBoundAwaits(ownerId, 'agent-obligation');
      assert.equal(history.length, 1, 'reconciliation must retain one durable reminder');
      const reminder = history[0];
      assert.equal(reminder.eventKey, eventKey);
      assert.equal(reminder.boundTo?.ref, obligation.id);
      // Use the same maintained claim/insert writers as the event emitter. No
      // live event bus or global periodic reconciler participates in this proof.
      const fired = await claimSpecificOnceAwaits([reminder.id], 'event');
      assert.equal(fired.length, 1);
      await insertDeliveries({ awaits: fired, urgent: true, source: 'private-background-proof',
        payload: { goalId, obligationId: obligation.id }, summary: 'Private reminder ' + goalId });
      let [delivery] = await listRecentDeliveries(ownerId, 2, reminder.id);
      assert.ok(delivery);
      // Cross the actual pump ceiling without sleeping through seven retries.
      await sql`UPDATE harness_shared.event_wake_deliveries SET attempts = 7,
        next_attempt_at = now() WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND id = ${delivery.id}`;
      const pending = await pumpWakeDeliveries(workspace, deps);
      assert.equal(pending.parked, 1, JSON.stringify(pending));
      assert.equal(pending.inbox, 0);
      [delivery] = await listRecentDeliveries(ownerId, 2, reminder.id);
      assert.equal(delivery.status, 'parked');
      assert.equal(delivery.attempts, 8);
      assert.match(delivery.lastError ?? '', /pending-delivery-id/);
      assert.notEqual(delivery.channel, 'inbox');
      assert.equal(delivery.turnProof, null);
      settled = true;
      await sql`UPDATE harness_shared.event_wake_deliveries SET next_attempt_at = now()
        WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND id = ${delivery.id}`;
      const terminal = await pumpWakeDeliveries(workspace, deps);
      assert.equal(terminal.delivered, 1, JSON.stringify(terminal));
      assert.equal(terminal.inbox, 0);
      [delivery] = await listRecentDeliveries(ownerId, 2, reminder.id);
      assert.equal(delivery.status, 'delivered');
      assert.equal(delivery.channel, 'psu-socket-inject');
      assert.equal(delivery.turnProof, 'host-attested');
      assert.equal(delivery.attempts, 9);
      assert.equal(injections.length, 2);
      assert.deepEqual(injections.map(row => row.deliveryId), [String(delivery.id), String(delivery.id)]);
      assert.ok(injections.every(row => row.data.includes(goalId)));
      const sourcePaths = ['packages/operator-core/lib/agent-obligation-reminders.ts',
        'packages/operator-core/lib/events/await/engine.ts', 'packages/operator-core/lib/events/await/store.ts',
        'packages/operator-core/lib/events/await/wake-executor.ts'];
      const receipt = { workspace, ownerId, goalId, observationWindow: { startedAt, endedAt: new Date().toISOString() },
        source: sourcePaths.map(path => ({ path,
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })),
        awaitId: reminder.id, deliveryId: delivery.id, pendingAttempt: 8, settledAttempt: delivery.attempts,
        channel: delivery.channel, turnProof: delivery.turnProof, hostReceiptSimulated: true,
        actualLlmConsumptionProved: false, duplicateReminderCount: history.length,
        exposedPayloadSha256: injections.map(row => createHash('sha256').update(row.data).digest('hex')) };
      writeFileSync(join(evidenceDir, 'reminder-background-receipt.json'), JSON.stringify(receipt, null, 2));
      console.log('OBLIGATION_BACKGROUND_RECEIPT ' + JSON.stringify(receipt));
    });
  } finally { await sql.end({ timeout: 5 }); }
}

main().catch(error => {
  console.error('OBLIGATION_BACKGROUND_FAILURE ' + String(error?.stack ?? error));
  process.exitCode = 1;
});
