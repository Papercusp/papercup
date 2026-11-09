/** Fresh controller for the declared park-recovery crash integration tests.
 * No producer event or native agent launch is performed. */
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';

const dsn = process.env.PARK_RESTART_DSN!;
const id = process.env.PARK_RESTART_ITEM!;
const harness = process.env.PARK_RESTART_HARNESS!;
const target = process.env.PARK_RESTART_CUT;
const mode = process.env.PARK_RESTART_MODE;
if (!dsn || !id || !harness || !['crash', 'recover'].includes(mode ?? '') ||
    !['localhost', '127.0.0.1', '::1'].includes(new URL(dsn).hostname)) {
  throw new Error('isolated park-recovery fixture required');
}
process.env.HARNESS_ADMIN_DATABASE_URL = dsn;
process.env.HARNESS_DATABASE_URL = dsn;
process.env.DATABASE_URL = dsn;
const sourcePaths = ['../lib/durable-park-recovery.ts', '../lib/events/await/store.ts', './_park-recovery-child.ts'];
const sources = () => Object.fromEntries(sourcePaths.map(path => [path,
  createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')]));
const beforeSources = sources();
const { getOrgPg } = await import('@papercusp/db-org');
const { checkParkRecoveryInTransaction, parkRecoveryCertificate,
  routeParkRecoveryDeliveryInTransaction } = await import('../lib/durable-park-recovery');
const { settleVerifiedAwaitTimeout, insertDeliveries, reconcileFiredWakeDeliveries } = await import('../lib/events/await/store');
const sql = postgres(dsn, { max: 2, prepare: false, onnotice: () => {} });
const [direct] = await sql`SELECT current_database() AS name`;
const [ambient] = await getOrgPg().sql`SELECT current_database() AS name`;
if (direct.name !== ambient.name) throw new Error('restart store escaped isolated database');
function cut(point: string) {
  if (mode === 'crash' && point === target) {
    writeSync(1, 'PARK_RESTART_CUT ' + point + '\n');
    process.kill(process.pid, 'SIGKILL');
  }
}
const [item] = await sql`SELECT payload FROM harness_shared.work_items WHERE feature_id=${id} AND harness_slug=${harness}`;
const admission = item.payload.claim_hold_release?.recovery;
if (admission) {
  await sql.begin(async tx => {
    await checkParkRecoveryInTransaction(tx, {
      awaitId: admission.awaitId, receipt: admission.receipt, nowMs: admission.receipt.deadlineMs,
    });
    cut('before-commit');
  });
  cut('after-commit');
  const certificate = parkRecoveryCertificate(admission.receipt);
  const fired = await settleVerifiedAwaitTimeout({ id: admission.awaitId, result: {
    classification: 'stalled', nextAction: 'wake-owner-or-takeover', producer: certificate.producer,
    owner: certificate.owner, checkedAtMs: admission.receipt.deadlineMs,
    verificationDeadlineMs: admission.receipt.deadlineMs, lastProgressAtMs: null, lastFireAtMs: null,
  } });
  if (fired) await insertDeliveries({ awaits: [fired] });
  else await reconcileFiredWakeDeliveries();
  cut('after-enqueue');
  const [delivery] = await sql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id=${admission.awaitId}`;
  const owner = process.env.PARK_RESTART_SUCCESSOR || admission.receipt.custodianId;
  await sql.begin(tx => routeParkRecoveryDeliveryInTransaction(tx, {
    awaitId: admission.awaitId, deliveryId: Number(delivery.id),
    // Deterministic liveness facts isolate routing from the real fleet. Claim
    // mutation and durable target selection are the production implementation.
    owners: async () => ({ states: new Map([[owner, 'parked' as const]]), successors: [owner] }),
  }));
}
const [saved] = await sql`SELECT payload FROM harness_shared.work_items WHERE feature_id=${id} AND harness_slug=${harness}`;
const actions = await sql`SELECT feature_id, taken_by, payload FROM harness_shared.work_items
  WHERE payload->'parkRecovery'->>'workItemId'=${id}`;
const deliveries = await sql`SELECT d.id, d.subscriber_id, d.await_id
  FROM harness_shared.event_wake_deliveries d JOIN harness_shared.event_awaits a ON a.id=d.await_id
  WHERE a.producer_health->'details'->'parkRecovery'->>'workItemId'=${id}`;
const [producer] = await sql`SELECT count(*)::int AS fires FROM harness_shared.event_key_fires
  WHERE event_key=${saved.payload.claim_hold_release.trigger}`;
const afterSources = sources();
process.stdout.write('PARK_RESTART_RESULT ' + JSON.stringify({ pid: process.pid,
  admission: saved.payload.claim_hold_release?.recovery ?? null, actions, deliveries,
  producerFires: producer.fires, beforeSources, afterSources }) + '\n');
await sql.end({ timeout: 2 });
await getOrgPg().sql.end({ timeout: 2 });
process.exit(0);
