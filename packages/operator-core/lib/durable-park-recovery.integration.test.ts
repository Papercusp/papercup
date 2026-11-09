/** Real PostgreSQL admission, public-call and actual process/store restart tests. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FreshPgDb } from '../test/_pg-helpers';
import { createPublicParkTestDb } from '../test/_public-park-pg';
import type {} from '../test/_park-recovery-child';
import type { ParkRecoveryAdmission } from './durable-park-recovery';
import type { SessionState } from './agent-tools/coordination/presence-wakeability';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', async original => ({
  ...(await original<typeof import('./workspace-registry')>()), activeWorkspaceId: () => 'default',
}));
vi.mock('./harness-core', async original => ({
  ...(await original<typeof import('./harness-core')>()), resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
vi.mock('./blueprint/operation-worker-binding', async original => ({
  ...(await original<typeof import('./blueprint/operation-worker-binding')>()), readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' as const }),
}));
vi.mock('./agent-tools/coordination/federation-scope', async original => ({
  ...(await original<typeof import('./agent-tools/coordination/federation-scope')>()), resolveWorkspaceHiveScope: async () => ({ kind: 'none' as const }),
}));
const { admitParkRecoveryInTransaction, checkParkRecoveryInTransaction,
  ParkRecoveryAdmissionUnchanged, parkRecoveryCertificate,
  routeParkRecoveryDeliveryInTransaction } = await import('./durable-park-recovery');
const { registerAnnouncement, registerAwait, inspectEventKey, claimDueVerifiedAwaits,
  settleVerifiedAwaitTimeout, insertDeliveries, reconcileFiredWakeDeliveries } = await import('./events/await/store');
const EVENT = 'fixture:automatic-park-complete';
const OWNER = 'su-park-custodian';
const HARNESS = 'automatic-park';
const ID = 'WI-park-obligation';
const input = { workspaceId: 'default', harness: HARNESS, workItemId: ID, parkedBy: OWNER,
  releaseContract: { condition: 'Every input is qualified', trigger: EVENT, owner: OWNER,
    reachability: 'reachable' as const, evidence: 'Current complete condition is pending' } };
let db: FreshPgDb;
let declarationId: number;

async function snapshot() {
  const [row] = await db.sql`SELECT status, taken_by, taken_at::text, payload
    FROM harness_shared.work_items WHERE feature_id=${ID}`;
  return row;
}
async function releaseAndAdmit(tx: postgres.TransactionSql) {
  // Lock order matches producer fire/declaration: event key before item row.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + EVENT}, 0))`;
  await tx`UPDATE harness_shared.work_items SET taken_by=NULL, status='open'
    WHERE feature_id=${ID} AND taken_by=${OWNER}`;
  return admitParkRecoveryInTransaction(tx, input);
}
async function qualify(tx: postgres.TransactionSql, payload = { ready: true, usable: true }) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + EVENT}, 0))`;
  await tx`UPDATE harness_shared.event_awaits SET fired_at=now(), fired_reason='event',
    fired_payload=${JSON.stringify(payload)}::text::jsonb WHERE id=${declarationId}`;
}
beforeAll(async () => {
  db = await createPublicParkTestDb('automatic-park-admission');
  h.sql = db.sql;
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.event_awaits,
    harness_shared.event_wake_deliveries, harness_shared.event_key_fires,
    harness_shared.carry_notes RESTART IDENTITY CASCADE`;
  await db.sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, title, item_kind, status, taken_by, taken_at, payload)
    VALUES ('default', ${HARNESS}, ${ID}, 'Deliver qualified inputs', 'feature', 'wip', ${OWNER}, now(),
    '{"keep":"original","qualification":"pending","safetyHold":{"id":"hold-1","state":"on"},"acceptance":["failing-check","usability"]}'::jsonb)`;
  declarationId = (await registerAnnouncement({ subscriberId: 'fixture-producer', eventKey: EVENT,
    scopeKind: 'harness', scopeRef: HARNESS,
    expectedCondition: { kind: 'predicate', predicate: { ready: { eq: true }, usable: { eq: true } } } })).id;
});

const checkpointScope = (id = ID) => `workitem:${HARNESS}:${id}`;
async function progress(at: number, body: string, id = ID) {
  await db.sql`INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, updated_ts, body_ts)
    VALUES ('default', ${checkpointScope(id)}, ${body}, ${at}, ${at})
    ON CONFLICT (workspace_id, scope) DO UPDATE
      SET note=EXCLUDED.note, updated_ts=EXCLUDED.updated_ts, body_ts=EXCLUDED.body_ts`;
}
function check(admission: ParkRecoveryAdmission, nowMs: number) {
  return db.sql.begin(tx => checkParkRecoveryInTransaction(tx,
    { awaitId: admission.awaitId, receipt: admission.receipt, nowMs }));
}
async function actions() {
  return db.sql`SELECT feature_id, condition_key, taken_by, payload FROM harness_shared.work_items
    WHERE feature_id <> ${ID}`;
}
async function persisted(admission: ParkRecoveryAdmission) {
  const [awaited] = await db.sql`SELECT producer_health, expires_ts, cancelled_at, verification_claimed_at
    FROM harness_shared.event_awaits WHERE id=${admission.awaitId}`;
  const current = (await snapshot()).payload.claim_hold_release.recovery as ParkRecoveryAdmission;
  expect(awaited.producer_health.details.parkRecovery).toEqual(current.receipt);
  expect(new Date(awaited.expires_ts).getTime()).toBe(current.receipt.deadlineMs);
  return current;
}
function protectedItem(row: Awaited<ReturnType<typeof snapshot>>) {
  const copy = structuredClone(row);
  delete copy.payload.claim_hold_release.recovery;
  return copy;
}

async function restartController(mode: 'crash' | 'recover', cut: string, successor = '') {
  const child = spawn(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('../test/_park-recovery-child.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', PARK_RESTART_DSN: db.url, PARK_RESTART_ITEM: ID,
      PARK_RESTART_HARNESS: HARNESS, PARK_RESTART_MODE: mode, PARK_RESTART_CUT: cut,
      PARK_RESTART_SUCCESSOR: successor },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(timedOut, output).toBe(false);
    if (mode === 'crash') {
      expect(result.signal, output).toBe('SIGKILL');
      expect(output).toContain('PARK_RESTART_CUT ' + cut);
      return null;
    }
    expect(result.code, output).toBe(0);
    const line = output.split('\n').find(row => row.startsWith('PARK_RESTART_RESULT '));
    expect(line, output).toBeTruthy();
    return JSON.parse(line!.slice('PARK_RESTART_RESULT '.length));
  } finally { clearTimeout(timer); }
}

describe('PARK-RECOVERY causal unchanged-call silent-prerequisite restart', () => {
  it.each(['before-commit', 'after-commit', 'after-enqueue'])(
    'the same outcome oracle rejects missing admission and survives actual controller death %s', async cut => {
      const { default: release } = await import('./agent-tools/work_items/release');
      const args = release.args.parse({ id: ID, harness: HARNESS, claimHold: true,
        claimHoldRelease: { condition: input.releaseContract.condition, trigger: EVENT, owner: OWNER } });
      const context = { isSuperuser: true, uiClientId: OWNER, workspaceId: 'default', role: 'su',
        signal: new AbortController().signal, log() {}, progress() {}, metadata() {} } as never;
      const call = async () => {
        const result = await release.handler(args, context) as { data: { results: Array<{ ok: boolean }> } };
        expect(result.data.results[0], JSON.stringify(result)).toMatchObject({ ok: true });
      };
      await call();
      const admitted = (await snapshot()).payload.claim_hold_release.recovery as ParkRecoveryAdmission;
      const protectedBefore = protectedItem(await snapshot());
      const [timer] = await db.sql`SELECT * FROM harness_shared.event_awaits WHERE id=${admitted.awaitId}`;
      // Deliberate missing-admission mutation: same public call/obligation,
      // unchanged producer silence and protected state, only the mechanism absent.
      await db.sql`DELETE FROM harness_shared.event_awaits WHERE id=${admitted.awaitId}`;
      await db.sql`UPDATE harness_shared.work_items SET payload=payload #- '{claim_hold_release,recovery}' WHERE feature_id=${ID}`;
      const boundedOutcome = (outcome: NonNullable<Awaited<ReturnType<typeof restartController>>>, owner: string) => {
        expect(outcome.producerFires).toBe(0);
        expect(outcome.admission.receipt.id).toBe(admitted.receipt.id);
        expect(outcome.actions).toHaveLength(1);
        expect(outcome.actions[0].taken_by).toBe(owner);
        expect(outcome.deliveries).toHaveLength(1);
        expect(outcome.deliveries[0].subscriber_id).toBe(owner);
        expect(outcome.beforeSources).toEqual(outcome.afterSources);
      };
      const missing = await restartController('recover', cut);
      expect(missing).toMatchObject({ admission: null, actions: [], deliveries: [], producerFires: 0 });
      expect(() => boundedOutcome(missing, OWNER)).toThrow();
      expect(protectedItem(await snapshot())).toEqual(protectedBefore);
      // Restore precisely the admission created by the identical unchanged
      // call, then replay that call rather than constructing another receipt.
      await db.sql`INSERT INTO harness_shared.event_awaits OVERRIDING SYSTEM VALUE
        SELECT * FROM jsonb_populate_record(NULL::harness_shared.event_awaits, ${JSON.stringify(timer)}::text::jsonb)`;
      await db.sql`UPDATE harness_shared.work_items SET payload=jsonb_set(payload,
        '{claim_hold_release,recovery}', ${JSON.stringify(admitted)}::text::jsonb) WHERE feature_id=${ID}`;
      await call();
      await restartController('crash', cut);
      const recovered = await restartController('recover', cut);
      boundedOutcome(recovered, OWNER);
      const replayed = await restartController('recover', cut);
      boundedOutcome(replayed, OWNER);
      expect(replayed.actions[0].feature_id).toBe(recovered.actions[0].feature_id);
      expect(replayed.deliveries[0].id).toBe(recovered.deliveries[0].id);
      expect(replayed.pid).not.toBe(recovered.pid);
      const successor = 'su-restarted-successor';
      const succeeded = await restartController('recover', cut, successor);
      boundedOutcome(succeeded, successor);
      expect(succeeded.actions[0].feature_id).toBe(recovered.actions[0].feature_id);
      expect(protectedItem(await snapshot())).toEqual(protectedBefore);
    }, 180_000);
});

describe('serialized progress and timeout recovery (PARK-PROGRESS / PARK-RECOVERY)', () => {
  it('checks fresh checkpoint bodies before expiry, consumes once, and preserves custody/safety', async () => {
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    const before = protectedItem(await snapshot());
    await progress(admitted.receipt.admittedAtMs + 1, 'completed the first relevant subtask');
    const first = await check(admitted, admitted.receipt.deadlineMs - 1);
    expect(first.disposition).toBe('renewed');
    expect((await persisted(admitted)).receipt).toMatchObject({ extensions: 1,
      deadlineMs: admitted.receipt.deadlineMs + 30 * 60_000, state: 'waiting' });
    expect((await check(admitted, admitted.receipt.deadlineMs - 1)).disposition).toBe('waiting');
    expect((await persisted(admitted)).receipt.extensions).toBe(1);
    expect(await actions()).toHaveLength(0);
    expect(protectedItem(await snapshot())).toEqual(before);
  });

  it('ignores baseline, unrelated work, unchanged-body touches and regressing evidence', async () => {
    const baselineAt = Date.now() - 5_000;
    await progress(baselineAt, 'original checkpoint');
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    const at = admitted.receipt.admittedAtMs + 10;
    await db.sql`UPDATE harness_shared.carry_notes SET updated_ts=${at} WHERE scope=${checkpointScope()}`;
    await progress(at, 'different work advanced', 'WI-other');
    expect((await check(admitted, at + 1)).disposition).toBe('waiting');
    await progress(at, 'original checkpoint'); // same body, later writer timestamp
    expect((await check(admitted, at + 1)).disposition).toBe('waiting');
    await progress(at, 'new body');
    expect((await check(admitted, at + 1)).disposition).toBe('renewed');
    await progress(at - 1, 'older revision, different body');
    expect((await check(admitted, at + 2)).disposition).toBe('waiting');
    expect((await persisted(admitted)).receipt.extensions).toBe(1);
  });

  it.each([0, 1])('expiry at deadline+%s freezes renewal and replay keeps one action', async offset => {
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    const before = protectedItem(await snapshot());
    await progress(admitted.receipt.deadlineMs - 1, 'late but persisted before expiry');
    const results = await Promise.all([check(admitted, admitted.receipt.deadlineMs + offset),
      check(admitted, admitted.receipt.deadlineMs + offset)]);
    expect(results.every(r => r.disposition === 'recovery')).toBe(true);
    expect(results[0].admission?.recoveryWorkItemId).toBe(results[1].admission?.recoveryWorkItemId);
    expect((await check(admitted, admitted.receipt.deadlineMs - 1)).disposition).toBe('recovery');
    expect((await persisted(admitted)).receipt).toMatchObject({ state: 'recovery', extensions: 0,
      deadlineMs: admitted.receipt.deadlineMs });
    expect(await actions()).toHaveLength(1);
    expect(protectedItem(await snapshot())).toEqual(before);
  });

  it('caps the final accepted extension at absolute age and rejects the next evidence', async () => {
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    // A valid stored policy with a nominal extension that crosses the absolute bound.
    admitted.receipt.policy.extensionMs = 40 * 60_000;
    await db.sql`UPDATE harness_shared.work_items SET payload=jsonb_set(payload,
      '{claim_hold_release,recovery}', ${JSON.stringify(admitted)}::text::jsonb) WHERE feature_id=${ID}`;
    await progress(admitted.receipt.admittedAtMs + 1, 'first advance');
    const first = (await check(admitted, admitted.receipt.deadlineMs - 1)).admission!;
    await progress(admitted.receipt.admittedAtMs + 2, 'second advance');
    const second = (await check(first, first.receipt.deadlineMs - 1)).admission!;
    expect(second.receipt).toMatchObject({ extensions: 2, deadlineMs: admitted.receipt.absoluteDeadlineMs });
    await progress(admitted.receipt.admittedAtMs + 3, 'third advance');
    expect((await check(second, second.receipt.deadlineMs - 1)).disposition).toBe('waiting');
    expect((await persisted(admitted)).receipt.extensions).toBe(2);
    expect((await check(second, second.receipt.absoluteDeadlineMs)).disposition).toBe('recovery');
  });

  it.each(['renewal', 'timeout'] as const)('serializes the forced %s-first lock order', async winner => {
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    await progress(admitted.receipt.deadlineMs - 2, 'new checkpoint');
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const firstAt = admitted.receipt.deadlineMs + (winner === 'renewal' ? -1 : 0);
    const first = db.sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + EVENT}, 0))`;
      acquired();
      await gate;
      return checkParkRecoveryInTransaction(tx, { awaitId: admitted.awaitId, receipt: admitted.receipt, nowMs: firstAt });
    });
    await ready;
    const second = check(admitted, admitted.receipt.deadlineMs + (winner === 'renewal' ? 0 : -1));
    unblock();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes[0].disposition).toBe(winner === 'renewal' ? 'renewed' : 'recovery');
    expect(outcomes[1].disposition).toBe(winner === 'renewal' ? 'waiting' : 'recovery');
    expect((await persisted(admitted)).receipt.extensions).toBe(winner === 'renewal' ? 1 : 0);
    expect(await actions()).toHaveLength(winner === 'renewal' ? 0 : 1);
  });

  it('retires only after a separate complete current-condition evaluation', async () => {
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    const before = protectedItem(await snapshot());
    await db.sql.begin(tx => qualify(tx, { ready: true, usable: false }));
    expect((await check(admitted, admitted.receipt.admittedAtMs + 1)).disposition).toBe('waiting');
    await db.sql.begin(tx => qualify(tx));
    expect((await check(admitted, admitted.receipt.deadlineMs)).disposition).toBe('retired');
    expect((await persisted(admitted)).receipt.state).toBe('retired');
    expect(await actions()).toHaveLength(0);
    expect(protectedItem(await snapshot())).toEqual(before);
  });

  it('rolls expiry, action and certificate back together before commit, then replays once', async () => {
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    await expect(db.sql.begin(async tx => {
      await checkParkRecoveryInTransaction(tx,
        { awaitId: admitted.awaitId, receipt: admitted.receipt, nowMs: admitted.receipt.deadlineMs });
      throw new Error('cut after recovery registration');
    })).rejects.toThrow('cut after recovery registration');
    expect(await actions()).toHaveLength(0);
    expect((await persisted(admitted)).receipt).toEqual(admitted.receipt);
    await check(admitted, admitted.receipt.deadlineMs);
    expect(await actions()).toHaveLength(1);
  });

  it('claims only automatic checks early and leaves the original expires_ts unchanged', async () => {
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    const certificate = parkRecoveryCertificate(admitted.receipt);
    certificate.details!.nextCheckAtMs = Date.now() - 1;
    await db.sql`UPDATE harness_shared.event_awaits SET producer_health=${JSON.stringify(certificate)}::text::jsonb
      WHERE id=${admitted.awaitId}`;
    await registerAwait({ subscriberId: OWNER, eventKey: 'fixture:ordinary-verified', policy: 'wake',
      timeoutSec: 1_800, producerHealthCertificate: { ...certificate,
        producer: { kind: 'other-producer', id: 'ordinary' } } });
    const checks = await claimDueVerifiedAwaits();
    expect(checks.map(row => row.id)).toEqual([admitted.awaitId]);
    expect(Date.parse(checks[0].expiresTs!)).toBe(admitted.receipt.deadlineMs);
    expect(await claimDueVerifiedAwaits()).toHaveLength(0);
  });
});

describe('same-identity recovery delivery and successor election', () => {
  async function expired() {
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    const recovery = (await check(admitted, admitted.receipt.deadlineMs)).admission!;
    const certificate = parkRecoveryCertificate(recovery.receipt);
    const fired = await settleVerifiedAwaitTimeout({ id: admitted.awaitId, result: {
      classification: 'stalled', nextAction: 'wake-owner-or-takeover', producer: certificate.producer,
      owner: certificate.owner, checkedAtMs: recovery.receipt.deadlineMs,
      verificationDeadlineMs: recovery.receipt.deadlineMs, lastProgressAtMs: null, lastFireAtMs: null,
    } });
    return { recovery, fired: fired! };
  }
  const owners = (states: Map<string, SessionState | null>, successors: string[] = []) =>
    async () => ({ states, successors });

  it('recovers a crash after action commit / before enqueue and replays one delivery', async () => {
    const { recovery, fired } = await expired();
    // The durable fired intent, rather than an in-memory callback, repairs this cut.
    await reconcileFiredWakeDeliveries();
    await insertDeliveries({ awaits: [fired] });
    await reconcileFiredWakeDeliveries();
    const deliveries = await db.sql`SELECT id, await_id FROM harness_shared.event_wake_deliveries`;
    expect(deliveries).toHaveLength(1);
    expect(Number(deliveries[0].await_id)).toBe(recovery.awaitId);
    const original = protectedItem(await snapshot());
    const route = await db.sql.begin(tx => routeParkRecoveryDeliveryInTransaction(tx, {
      awaitId: recovery.awaitId, deliveryId: Number(deliveries[0].id),
      owners: owners(new Map([[OWNER, 'parked']])),
    }));
    expect(route).toMatchObject({ disposition: 'target', ownerId: OWNER, actionId: recovery.recoveryWorkItemId });
    expect((await actions())[0].taken_by).toBe(OWNER);
    expect(protectedItem(await snapshot())).toEqual(original);
  });

  it('races concurrent successor election and reopens the same delivery after owner death', async () => {
    const { recovery, fired } = await expired();
    await insertDeliveries({ awaits: [fired] });
    const [delivery] = await db.sql`SELECT id FROM harness_shared.event_wake_deliveries`;
    const deliveryId = Number(delivery.id);
    const original = protectedItem(await snapshot());
    const route = (states: Map<string, SessionState | null>, successors: string[] = []) => db.sql.begin(tx =>
      routeParkRecoveryDeliveryInTransaction(tx, { awaitId: recovery.awaitId, deliveryId,
        owners: owners(states, successors) }));
    await route(new Map([[OWNER, 'live']]));
    const successor = 'su-live-recovery-successor';
    const states = new Map<string, SessionState>([[OWNER, 'ended'], [successor, 'live']]);
    const elected = await Promise.all([route(states, [successor]), route(states, [successor])]);
    expect(elected.every(r => r.ownerId === successor && r.actionId === recovery.recoveryWorkItemId)).toBe(true);
    // Compaction keeps the logical owner while changing its live/parked state.
    expect((await route(new Map([[OWNER, 'ended'], [successor, 'parked']]), [successor])).ownerId).toBe(successor);
    const rows = await db.sql`SELECT id, subscriber_id FROM harness_shared.event_wake_deliveries`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: delivery.id, subscriber_id: successor });
    expect(await actions()).toHaveLength(1);
    expect((await actions())[0].taken_by).toBe(successor);
    expect((await persisted(recovery)).recoveryWorkItemId).toBe(recovery.recoveryWorkItemId);
    expect(protectedItem(await snapshot())).toEqual(original);
  });

  it('does not elect an unknown, recorded or dead session as an actionable recovery owner', async () => {
    const { recovery, fired } = await expired();
    await insertDeliveries({ awaits: [fired] });
    const [delivery] = await db.sql`SELECT id FROM harness_shared.event_wake_deliveries`;
    const result = await db.sql.begin(tx => routeParkRecoveryDeliveryInTransaction(tx, {
      awaitId: recovery.awaitId, deliveryId: Number(delivery.id),
      owners: owners(new Map([[OWNER, 'ended'], ['su-not-live', 'recorded']]), ['su-not-live', 'su-unknown']),
    }));
    expect(result.disposition).toBe('pending');
    expect((await actions())[0].taken_by).toBeNull();
  });

  it('routes to the parking custodian independently of the producer named in the condition', async () => {
    const admitted = await db.sql.begin(tx => admitParkRecoveryInTransaction(tx,
      { ...input, parkedBy: 'su-delivery-custodian' }));
    expect(admitted.receipt.custodianId).toBe('su-delivery-custodian');
    expect(admitted.receipt.condition.owner).toBe(OWNER);
    const recovery = (await check(admitted, admitted.receipt.deadlineMs)).admission!;
    const route = await db.sql.begin(tx => routeParkRecoveryDeliveryInTransaction(tx, {
      awaitId: admitted.awaitId, deliveryId: -1,
      owners: owners(new Map([['su-delivery-custodian', 'parked'], [OWNER, 'ended']])),
    }));
    // The canonical row still has a live explicit claim, which outranks a saved
    // parker. In this fixture it is the producer, and it is known ended.
    expect(route.disposition).toBe('pending');
    await db.sql`UPDATE harness_shared.work_items SET taken_by=NULL WHERE feature_id=${ID}`;
    const routed = await db.sql.begin(tx => routeParkRecoveryDeliveryInTransaction(tx, {
      awaitId: admitted.awaitId, deliveryId: -1,
      owners: owners(new Map([['su-delivery-custodian', 'parked'], [OWNER, 'ended']])),
    }));
    expect(routed).toMatchObject({ ownerId: 'su-delivery-custodian', actionId: recovery.recoveryWorkItemId });
  });
});

describe('automatic recovery atomic admission prerequisite (PARK-ADMISSION)', () => {
  it('commits exactly one bounded receipt/await with its park and preserves manual sibling waits', async () => {
    const manual = await registerAwait({ subscriberId: OWNER, eventKey: EVENT, policy: 'wake', timeoutSec: 50 });
    const admission = await db.sql.begin(tx => releaseAndAdmit(tx));
    const row = await snapshot();
    expect(row).toMatchObject({ taken_by: null, status: 'open', payload: {
      keep: 'original', qualification: 'pending', safetyHold: { id: 'hold-1', state: 'on' },
      acceptance: ['failing-check', 'usability'], _claimHold: true,
      claim_hold_release: { condition: input.releaseContract.condition, recovery: admission },
    } });
    const awaits = await db.sql`SELECT * FROM harness_shared.event_awaits WHERE policy='wake' ORDER BY id`;
    expect(awaits).toHaveLength(2);
    expect(Number(awaits[0].id)).toBe(manual.id);
    expect(awaits[0].cancelled_at).toBeNull();
    expect(Number(awaits[1].id)).toBe(admission.awaitId);
    expect(awaits[1]).toMatchObject({ subscriber_id: admission.receipt.id, bound_to: null,
      cancelled_at: null, timeout_behavior: 'wake', producer_health: { details: { parkRecovery: admission.receipt } } });
    expect(new Date(awaits[1].expires_ts).getTime()).toBe(admission.receipt.deadlineMs);
  });

  it.each(['after park before await', 'after await before commit'])(
    'rolls custody, park, receipt and await back together: %s', async cut => {
      const before = await snapshot();
      if (cut === 'after park before await') await db.sql.unsafe(`
        CREATE FUNCTION harness_shared.reject_park_wait() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN IF NEW.policy = 'wake' THEN RAISE EXCEPTION 'fixture admission cut'; END IF; RETURN NEW; END $f$;
        CREATE TRIGGER reject_park_wait BEFORE INSERT ON harness_shared.event_awaits
        FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_park_wait()`);
      try {
        await expect(db.sql.begin(async tx => {
          await releaseAndAdmit(tx);
          throw new Error('fixture admission cut');
        })).rejects.toThrow('fixture admission cut');
        expect(await snapshot()).toEqual(before);
        expect(await db.sql`SELECT id FROM harness_shared.event_awaits WHERE policy='wake'`).toHaveLength(0);
      } finally {
        if (cut === 'after park before await') await db.sql.unsafe(`
          DROP TRIGGER reject_park_wait ON harness_shared.event_awaits;
          DROP FUNCTION harness_shared.reject_park_wait()`);
      }
      const retry = await db.sql.begin(tx => releaseAndAdmit(tx));
      expect((await snapshot()).payload.claim_hold_release.recovery).toEqual(retry);
      expect(await db.sql`SELECT id FROM harness_shared.event_awaits WHERE policy='wake'`).toHaveLength(1);
    });

  it('rolls a retry back to the same committed receipt without extending its clock', async () => {
    const admitted = await db.sql.begin(tx => releaseAndAdmit(tx));
    const before = await snapshot();
    await expect(db.sql.begin(tx => releaseAndAdmit(tx))).rejects.toMatchObject({
      code: 'park_recovery_admission_unchanged', disposition: 'replayed', admission: admitted,
    });
    expect(await snapshot()).toEqual(before);
    expect(await db.sql`SELECT id FROM harness_shared.event_awaits WHERE policy='wake'`).toHaveLength(1);
  });

  it('takes the complete already-qualified path with no artifacts and unchanged custody', async () => {
    await db.sql.begin(tx => qualify(tx));
    const before = await snapshot();
    await expect(db.sql.begin(tx => releaseAndAdmit(tx))).rejects.toBeInstanceOf(ParkRecoveryAdmissionUnchanged);
    expect(await snapshot()).toEqual(before);
    expect(await db.sql`SELECT id FROM harness_shared.event_awaits WHERE policy='wake'`).toHaveLength(0);
  });

  it('does not treat subset or unusable inputs as complete qualification', async () => {
    await db.sql.begin(tx => qualify(tx, { ready: true, usable: false }));
    const admission = await db.sql.begin(tx => releaseAndAdmit(tx));
    expect(admission.receipt.state).toBe('waiting');
    expect((await snapshot()).payload.qualification).toBe('pending');
  });

  it('reads producer state through the caller transaction rather than a second snapshot', async () => {
    const before = await snapshot();
    await expect(db.sql.begin(async tx => {
      await qualify(tx);
      expect((await inspectEventKey(EVENT, tx)).announcements[0].firedReason).toBe('event');
      await releaseAndAdmit(tx);
    })).rejects.toMatchObject({ disposition: 'already-satisfied' });
    expect(await snapshot()).toEqual(before);
    expect((await inspectEventKey(EVENT)).announcements[0].firedAt).toBeNull();
  });
});
