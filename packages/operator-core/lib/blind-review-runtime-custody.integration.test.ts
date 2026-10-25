import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setupPlanPgFixture, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { assertMigrationPassesPreApplyLints } from './migration-preapply-lint';
import { createRuntimeCustodyStore, RUNTIME_RESOURCE_KINDS, runtimeCustodyFingerprint,
  type RuntimeReviewerIdentity, type RuntimeSourceAdmission } from './blind-review-runtime-custody';

// These exercise the real transaction/locking boundary, not native identity or
// source-image admission. Those production adapters must be qualified separately.
let fx: PlanPgFixture;
let serial = 0;
const migrationName = '1578-blind-review-runtime-custody.sql';
const sqlRoot = new URL('../../../libs/papercusp/libs/db/sql/', import.meta.url);
function migration(name: string) {
  return readFileSync(new URL(existsSync(new URL(name, sqlRoot)) ? name : name + '.DRAFT', sqlRoot), 'utf8');
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  const [replacement] = await fx.admin`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'plan_blind_review_sessions' AND column_name = 'attempt_seq'`;
  if (!replacement) await fx.admin.begin(tx => tx.unsafe(migration('1567-blind-review-replacement-attempts.sql')));
  const [present] = await fx.admin`SELECT to_regclass('harness_shared.blind_review_runtime_leases') AS table_name`;
  if (!present!.table_name) await fx.admin.begin(tx => tx.unsafe(migration(migrationName)));
}, 120_000);
afterAll(async () => { await fx?.dispose(); });

async function fixture() {
  const n = ++serial;
  const owner = 'su-custody-' + n, native = 'native-custody-' + n;
  const [adv] = await fx.admin`INSERT INTO harness_shared.adv_sessions
    (workspace_id, mode, coord_owner_id, session_id, agent)
    VALUES ('default', 'omp', ${owner}, ${native}, 'codex') RETURNING id`;
  const [binding] = await fx.admin`INSERT INTO harness_shared.plan_blind_review_sessions
    (workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id,
     adv_session_id, native_session_id, launch_parent_owner, confinement_snapshot, status)
    VALUES ('default', 'custody-fixture', ${'custody-fixture-' + n}, 1, ${owner}, ${adv!.id}, ${native},
      'system:blind-gap-review', '{}', 'ready') RETURNING id`;
  const identity: RuntimeReviewerIdentity = { workspaceId: 'default', bindingId: Number(binding!.id),
    activationAuditSeq: 1, replacementEpoch: 0, reviewerOwnerId: owner, nativeSessionId: native,
    confinementFingerprint: 'c'.repeat(64) };
  const source: RuntimeSourceAdmission = { repositoryId: 'custody-fixture', sourceCommit: 'a'.repeat(40),
    sourceTreeHash: 'b'.repeat(64), sourceInputsHash: 'd'.repeat(64), censusGeneration: 'fixture-1',
    censusStatus: 'admit', sourceImageNonce: randomUUID() };
  let allowed = true;
  const makeStore = () => createRuntimeCustodyStore({ sql: fx.admin as never,
    checkAuthority: async (_tx, current) => allowed && runtimeCustodyFingerprint(current) === runtimeCustodyFingerprint(identity) });
  const store = makeStore();
  const reserve = () => store.reserve(identity, 'request-' + n, 'e'.repeat(64));
  const allocate = async () => {
    const lease = await reserve();
    const receipt = await store.recordAdmission(identity, lease.id, source);
    return { lease: await store.consumeAdmission(identity, lease.id, receipt), receipt };
  };
  return { identity, source, store, makeStore, reserve, allocate, deny: () => { allowed = false; } };
}

describe('blind reviewer runtime custody on private PostgreSQL', () => {
  it('passes migration safety and gives metadata reservations no runtime authority', async () => {
    expect(() => assertMigrationPassesPreApplyLints({ filename: migrationName, sqlText: migration(migrationName),
      sqlDir: sqlRoot.pathname })).not.toThrow();
    const f = await fixture();
    const row = await f.reserve();
    expect(row).toMatchObject({ state: 'requested', receipt_id: null, admission: null, expires_at: null });
    await expect(f.store.intendResource(f.identity, row.id, 'managed-scope', 'main'))
      .rejects.toMatchObject({ code: 'lease_identity_mismatch' });
    const resources = await fx.admin`SELECT * FROM harness_shared.blind_review_runtime_resources WHERE lease_id = ${row.id}`;
    expect(resources).toHaveLength(0);
  });

  it('serializes duplicate request and receipt retries across independent store instances', async () => {
    const f = await fixture();
    const reserved = await Promise.all(Array.from({ length: 8 }, () => f.makeStore().reserve(f.identity, 'request-' + serial, 'e'.repeat(64))));
    expect(new Set(reserved.map(x => x.id)).size).toBe(1);
    const id = reserved[0]!.id;
    const receipt = await f.store.recordAdmission(f.identity, id, f.source);
    const allocated = await Promise.all(Array.from({ length: 8 }, () => f.makeStore().consumeAdmission(f.identity, id, receipt)));
    expect(allocated.every(x => x.id === id && x.state === 'allocating' && x.receipt_id === receipt)).toBe(true);
    const receipts = await fx.admin`SELECT * FROM harness_shared.blind_review_runtime_admissions WHERE lease_id = ${id}`;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.consumed_at).not.toBeNull();
    expect((await f.reserve()).id).toBe(id);
  });

  it('refuses changed request hashes, foreign receipts, and source tuple changes without allocating', async () => {
    const f = await fixture(), other = await fixture();
    const lease = await f.reserve(), foreign = await other.reserve();
    const receipt = await f.store.recordAdmission(f.identity, lease.id, f.source);
    await expect(f.store.reserve(f.identity, lease.request_id, 'f'.repeat(64)))
      .rejects.toMatchObject({ code: 'allocation_request_conflict' });
    await expect(f.store.reserve(f.identity, 'another-request', lease.request_hash))
      .rejects.toMatchObject({ code: 'allocation_request_conflict' });
    await expect(other.store.consumeAdmission(other.identity, foreign.id, receipt))
      .rejects.toMatchObject({ code: 'admission_invalid_or_expired' });
    await expect(f.store.recordAdmission(f.identity, lease.id, { ...f.source, sourceInputsHash: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'admission_tuple_changed' });
    const [stored] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`;
    expect(stored!.state).toBe('requested');
    expect((await f.store.consumeAdmission(f.identity, lease.id, receipt)).state).toBe('allocating');
  });

  it('refuses expired, unknown, and tampered admission while the valid control consumes', async () => {
    const f = await fixture();
    const lease = await f.reserve(), receipt = await f.store.recordAdmission(f.identity, lease.id, f.source);
    await expect(f.store.consumeAdmission(f.identity, lease.id, randomUUID())).rejects.toMatchObject({ code: 'admission_invalid_or_expired' });
    await fx.admin`UPDATE harness_shared.blind_review_runtime_admissions SET issued_at = clock_timestamp() - interval '2 minutes',
      expires_at = clock_timestamp() - interval '1 minute' WHERE id = ${receipt}`;
    await expect(f.store.consumeAdmission(f.identity, lease.id, receipt)).rejects.toMatchObject({ code: 'admission_invalid_or_expired' });
    await fx.admin`UPDATE harness_shared.blind_review_runtime_admissions SET expires_at = clock_timestamp() + interval '1 minute',
      tuple = tuple || '{"censusStatus":"unknown"}'::jsonb WHERE id = ${receipt}`;
    await expect(f.store.consumeAdmission(f.identity, lease.id, receipt)).rejects.toMatchObject({ code: 'admission_tuple_mismatch' });
    const control = await fixture();
    expect((await control.allocate()).lease.state).toBe('allocating');
  });

  it('rolls back receipt consumption when custody commit fails, then recovers the same request', async () => {
    const f = await fixture();
    const lease = await f.reserve(), receipt = await f.store.recordAdmission(f.identity, lease.id, f.source);
    await fx.admin.unsafe(`CREATE FUNCTION harness_shared.custody_test_crash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state = 'allocating' THEN RAISE EXCEPTION 'custody commit crash'; END IF; RETURN NEW; END $$`);
    await fx.admin.unsafe(`CREATE TRIGGER custody_test_crash BEFORE UPDATE ON harness_shared.blind_review_runtime_leases
      FOR EACH ROW EXECUTE FUNCTION harness_shared.custody_test_crash()`);
    try {
      await expect(f.store.consumeAdmission(f.identity, lease.id, receipt)).rejects.toThrow('custody commit crash');
      const [r] = await fx.admin`SELECT consumed_at FROM harness_shared.blind_review_runtime_admissions WHERE id = ${receipt}`;
      const [l] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`;
      expect(r!.consumed_at).toBeNull(); expect(l!.state).toBe('requested');
    } finally {
      await fx.admin.unsafe('DROP TRIGGER custody_test_crash ON harness_shared.blind_review_runtime_leases');
      await fx.admin.unsafe('DROP FUNCTION harness_shared.custody_test_crash()');
    }
    expect((await f.makeStore().consumeAdmission(f.identity, lease.id, receipt)).state).toBe('allocating');
  });

  it('retains create-before-append intents and permits cleanup after reviewer authority ends', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    const intent = await f.store.intendResource(f.identity, lease.id, 'process', 'driver');
    expect(intent.identity).toBeNull();
    expect((await f.makeStore().intendResource(f.identity, lease.id, 'process', 'driver')).id).toBe(intent.id);
    f.deny();
    await expect(f.store.intendResource(f.identity, lease.id, 'process', 'another'))
      .rejects.toMatchObject({ code: 'reviewer_authority_invalid' });
    const cutoff = await f.store.revoke(f.identity, lease.id, 'native-ended');
    expect(cutoff.state).toBe('releasing'); expect(cutoff.revoked_at).not.toBeNull();
    const observed = { pid: '123', startTicks: '456', namespace: intent.ownership_tag };
    await f.makeStore().recordResource(f.identity, lease.id, intent.id, observed);
    await expect(f.store.recordResource(f.identity, lease.id, intent.id, { ...observed, startTicks: '789' }))
      .rejects.toMatchObject({ code: 'resource_identity_changed' });
    const again = await f.store.revoke(f.identity, lease.id, 'retry');
    expect(again.revoked_at).toEqual(cutoff.revoked_at);
  });

  it('refuses ready until the complete boot inventory is recorded and blocks expired allocation', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    await expect(f.store.markReady(f.identity, lease.id)).rejects.toMatchObject({ code: 'runtime_inventory_incomplete' });
    for (const kind of RUNTIME_RESOURCE_KINDS.filter(k => k !== 'capture')) {
      const intent = await f.store.intendResource(f.identity, lease.id, kind, 'main');
      await f.store.recordResource(f.identity, lease.id, intent.id, { fixtureIdentity: intent.ownership_tag });
    }
    expect((await f.store.markReady(f.identity, lease.id)).state).toBe('ready');
    const capture = await f.store.intendResource(f.identity, lease.id, 'capture', 'first');
    await f.store.recordResource(f.identity, lease.id, capture.id, { opaqueId: randomUUID() });
    await fx.admin`UPDATE harness_shared.blind_review_runtime_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${lease.id}`;
    await expect(f.store.intendResource(f.identity, lease.id, 'capture', 'second')).rejects.toMatchObject({ code: 'lease_expired_or_revoked' });
  });

  it('never marks release from unknown, surviving, or incomplete discovery; a complete absent census releases', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    const resource = await f.store.intendResource(f.identity, lease.id, 'managed-scope', 'main');
    await f.store.revoke(f.identity, lease.id, 'exercise-ended');
    const proof = { scopeAbsent: true, absentIntentIds: [resource.id], checkedKinds: [...RUNTIME_RESOURCE_KINDS] };
    expect(await f.store.confirmReleased(f.identity, lease.id, async () => { throw new Error('unknown discovery'); })).toBe(false);
    expect(await f.store.confirmReleased(f.identity, lease.id, async () => ({ ...proof, scopeAbsent: false }))).toBe(false);
    expect(await f.store.confirmReleased(f.identity, lease.id, async () => ({ ...proof, absentIntentIds: [] }))).toBe(false);
    expect(await f.store.confirmReleased(f.identity, lease.id, async () => ({ ...proof, checkedKinds: ['managed-scope'] }))).toBe(false);
    // The resource was created but not identity-appended; discovery must still
    // establish absence using its durable ownership tag, not drop it from scope.
    expect(await f.makeStore().confirmReleased(f.identity, lease.id, async resources => {
      expect(resources[0]).toMatchObject({ id: resource.id, identity: null }); return proof;
    })).toBe(true);
    const [row] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`;
    expect(row!.state).toBe('released');
    await expect(f.store.intendResource(f.identity, lease.id, 'process', 'late')).rejects.toMatchObject({ code: 'allocation_not_active' });
  });

  it('keeps workspace rows isolated through RLS and composite resource foreign keys', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    await fx.admin.begin(async tx => {
      await tx`SET LOCAL ROLE harness_app`;
      await tx`SELECT set_config('app.workspace_id', 'foreign-workspace', true)`;
      expect(await tx`SELECT * FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`).toHaveLength(0);
    });
    await expect(fx.admin`INSERT INTO harness_shared.blind_review_runtime_resources
      (id, workspace_id, lease_id, kind, slot, ownership_tag)
      VALUES (${randomUUID()}, 'foreign-workspace', ${lease.id}, 'process', 'foreign', ${'f'.repeat(64)})`)
      .rejects.toMatchObject({ code: '23503' });
  });
});
