/**
 * Integration test for SIEM export delivery over the organization-audit stream (P-008b,
 * WI-6554700010012184; plan papercusp-enterprise-readiness-roadmap-2026-10-09 D-018/D-019):
 * next → ack → replay → resume, the settle window, key rotation, and the access rail — against a
 * throwaway database carrying the REAL governance migrations, migration 1499 and the real
 * organization_audit_events DDL from migration 907.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { grantDelegation, recordBootstrapDelegation } from '../governance-policy/authority';
import { upsertLayer } from '../governance-policy/store';
import { ORGANIZATION_DATA_RECEIPT_VERSION, RECEIPT_ACTIONS } from './organization-data-receipts';
import { SiemExportAccessError, verifySiemBatchJsonl } from './siem-export';
import {
  loadSiemStream,
  siemExportAck,
  siemExportNext,
  siemKeyId,
  type SiemExportKey,
  type SiemStreamRef,
} from './siem-export-delivery';

const sqlFile = (name: string): string => fileURLToPath(new URL(`../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url));
// The 1499 migration is armed (.sql) once finished; before that it is a .DRAFT the runner ignores.
const MIGRATION_1499 = ['1499-siem-export-streams.sql', '1499-siem-export-streams.sql.DRAFT'].map(sqlFile).find((p) => existsSync(p));
const MIGRATIONS = ['1497-governance-policy-layers.sql', '1498-governance-sensitive-actions.sql'].map(sqlFile);

const HOUR = 60 * 60_000;
const ORG = '33333333-3333-4333-8333-333333333333';
const stream: SiemStreamRef = { kind: 'org-audit', organizationId: ORG };
const keyOf = (bytes: Buffer): SiemExportKey => {
  const key = new Uint8Array(bytes);
  return { key, keyId: siemKeyId(key) };
};
const KEY_A = keyOf(randomBytes(32));
const KEY_B = keyOf(randomBytes(32));

let sql: postgres.Sql;
let clock: Date;

function orgAuditDdl(): string {
  const text = readFileSync(sqlFile('907-hosted-governance.sql'), 'utf8');
  // The table's metadata CHECK calls 907's governance_json_is_safe, so that function comes too.
  const safeFn = /CREATE OR REPLACE FUNCTION papercusp_auth\.governance_json_is_safe\([\s\S]*?\$safe\$;/.exec(text)?.[0];
  const ddl = /CREATE TABLE IF NOT EXISTS papercusp_auth\.organization_audit_events \([\s\S]*?\n\);/.exec(text)?.[0];
  if (!safeFn || !ddl) {
    throw new Error('907-hosted-governance.sql no longer defines governance_json_is_safe and organization_audit_events');
  }
  return `${safeFn}\n${ddl}`;
}

beforeAll(async () => {
  if (!MIGRATION_1499) throw new Error('migration 1499-siem-export-streams is missing (neither .sql nor .sql.DRAFT)');
  const adminUri = await getTestPg();
  const dbName = `siemdelivery_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared; CREATE SCHEMA papercusp_auth;`);
  // 907's table first: 1499 adds its export index, exactly as the real migration order does.
  await sql.unsafe(orgAuditDdl());
  for (const file of [...MIGRATIONS, MIGRATION_1499]) await sql.unsafe(readFileSync(file, 'utf8'));
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  clock = new Date();
  await sql.unsafe(`TRUNCATE harness_shared.siem_export_deliveries, harness_shared.siem_export_streams,
    papercusp_auth.organization_audit_events, harness_shared.governance_delegations,
    harness_shared.governance_policy_layer_versions, harness_shared.governance_policy_layers CASCADE`);
  await upsertLayer(
    { layerId: 'org-acme', level: 'organization', scopeRef: ORG, parentLayerId: null, rules: {}, exceptions: [], actor: 'admin:root', reason: 'pilot baseline' },
    sql,
  );
  await recordBootstrapDelegation(sql, { principal: 'admin:root', layerId: 'org-acme', now: clock });
  await grantDelegation(
    {
      grantor: 'admin:root',
      principal: 'admin:alice',
      layerId: 'org-acme',
      capabilities: ['prepare', 'approve'],
      reason: 'pilot administration',
      expiresAt: new Date(clock.getTime() + 24 * HOUR),
      now: clock,
    },
    sql,
  );
});

async function auditEvent(minutesAgo: number, action = 'organization.member.invited', metadata: Record<string, unknown> = { role: 'admin' }) {
  const at = new Date(clock.getTime() - minutesAgo * 60_000);
  await sql`
    INSERT INTO papercusp_auth.organization_audit_events
      (organization_id, actor_kind, actor_id, action, purpose, target_type, target_id, metadata, occurred_at, recorded_at)
    VALUES (${ORG}, 'customer_user', ${`user-${minutesAgo}`}, ${action}, 'support', 'organization', ${ORG},
            ${sql.json(metadata as postgres.JSONValue)}, ${at}, ${at})`;
}

const exportReceipt = {
  receiptVersion: ORGANIZATION_DATA_RECEIPT_VERSION,
  operation: 'export',
  workspaceIds: [],
  populationSize: 1,
  stores: [],
  limitations: [],
  codeVersion: 'c1',
  schemaVersion: 's1',
};

const op = (over: Partial<Parameters<typeof siemExportNext>[0]> = {}) => ({
  principal: 'admin:alice',
  stream,
  sql,
  now: clock,
  key: KEY_A,
  ...over,
});

describe('org-audit SIEM delivery', () => {
  it('delivers, acknowledges, replays idempotently and resumes from the stored cursor', async () => {
    await auditEvent(120);
    await auditEvent(119);
    await auditEvent(118, RECEIPT_ACTIONS.export, exportReceipt);

    const b1 = await siemExportNext({ ...op(), limit: 2 });
    expect(b1.manifest.length).toBe(2);
    expect(b1.manifest.keyId).toBe(KEY_A.keyId);
    expect(b1.stream.persisted).toBe(false);
    expect(b1.keyRotated).toBe(false);
    expect(verifySiemBatchJsonl(b1.jsonl).ok).toBe(true);

    const ack = { ...op(), idempotencyKey: b1.manifest.idempotencyKey, cursorTo: b1.manifest.cursorTo };
    const a1 = await siemExportAck(ack);
    expect(a1.status).toBe('acknowledged');
    expect(a1.stream).toMatchObject({ persisted: true, cursor: b1.manifest.cursorTo, keyId: KEY_A.keyId, deliveredBatches: 1 });

    const replay = await siemExportAck(ack);
    expect(replay.status).toBe('already-acknowledged');
    expect(replay.delivery.deliveryId).toBe(a1.delivery.deliveryId);
    expect(replay.stream.deliveredBatches).toBe(1);

    const b2 = await siemExportNext(op());
    expect(b2.manifest.length).toBe(1);
    expect(b2.manifest.startAfter).toEqual(b1.manifest.head);
    const v2 = verifySiemBatchJsonl(b2.jsonl, { startAfter: b1.manifest.head });
    expect(v2.ok).toBe(true);
    const receipt = v2.ok ? (v2.events[0] as { unmapped: { papercusp_metadata: { kind: string } } }) : null;
    expect(receipt?.unmapped.papercusp_metadata.kind).toBe('receipt');

    await expect(siemExportAck({ ...op(), idempotencyKey: 'a'.repeat(64), cursorTo: b1.manifest.cursorTo })).rejects.toMatchObject({
      code: 'nothing_to_ack',
    });
    await expect(siemExportAck({ ...op(), idempotencyKey: '0'.repeat(64), cursorTo: b2.manifest.cursorTo })).rejects.toMatchObject({
      code: 'idempotency_mismatch',
    });

    const a2 = await siemExportAck({ ...op(), idempotencyKey: b2.manifest.idempotencyKey, cursorTo: b2.manifest.cursorTo });
    expect(a2.status).toBe('acknowledged');
    expect((await loadSiemStream(sql, stream)).deliveredBatches).toBe(2);
    expect((await siemExportNext(op())).manifest.length).toBe(0);
  });

  it('holds back events younger than the settle window', async () => {
    await auditEvent(120);
    await auditEvent(1);
    const batch = await siemExportNext(op());
    expect(batch.manifest.length).toBe(1);
    expect(batch.horizon.bound.getTime()).toBeLessThanOrEqual(clock.getTime() - 60_000);
  });

  it('refuses a rotated key unless the rotation is acknowledged, then continues under the new key', async () => {
    await auditEvent(120);
    await auditEvent(119);
    const b1 = await siemExportNext({ ...op(), limit: 1 });
    await siemExportAck({ ...op(), idempotencyKey: b1.manifest.idempotencyKey, cursorTo: b1.manifest.cursorTo });

    await expect(siemExportNext(op({ key: KEY_B }))).rejects.toMatchObject({ code: 'key_rotated' });
    const b2 = await siemExportNext({ ...op({ key: KEY_B }), acknowledgeKeyRotation: true });
    expect(b2.keyRotated).toBe(true);
    expect(b2.manifest.keyId).toBe(KEY_B.keyId);
    await siemExportAck({
      ...op({ key: KEY_B }),
      idempotencyKey: b2.manifest.idempotencyKey,
      cursorTo: b2.manifest.cursorTo,
      acknowledgeKeyRotation: true,
    });
    expect((await loadSiemStream(sql, stream)).keyId).toBe(KEY_B.keyId);
  });

  it('refuses agents and humans without approve, and leaves no stream state behind', async () => {
    await auditEvent(120);
    await expect(siemExportNext(op({ principal: 'su-agent-1' }))).rejects.toBeInstanceOf(SiemExportAccessError);
    await expect(siemExportNext(op({ principal: 'admin:bob' }))).rejects.toBeInstanceOf(SiemExportAccessError);
    await expect(
      siemExportAck({ ...op({ principal: 'su-agent-1' }), idempotencyKey: 'a'.repeat(64), cursorTo: 'x' }),
    ).rejects.toBeInstanceOf(SiemExportAccessError);
    expect((await loadSiemStream(sql, stream)).persisted).toBe(false);
  });
});
