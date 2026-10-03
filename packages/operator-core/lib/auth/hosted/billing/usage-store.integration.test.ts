/** Real roles, transactions, concurrent writers and tenant boundaries (monetization P-004). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { PILOT_COST_CATEGORIES } from './unit-economics';
import { buildHostedUsageStatement, type HostedUsageRecord, type HostedUsageScope } from './usage-statement';
import { PostgresHostedUsageStore } from './usage-store';
import { OpenRouterHostedUsageCollector, type OpenRouterUsageBinding } from './openrouter-usage';

const { createOrgTestDb } = await import('../../../../test/_org-test-db');
let db: OrgTestDb;
const T = Date.UTC(2026, 9, 2);
const MONTH = '2026-10';
const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
const store = () => new PostgresHostedUsageStore(runService);

async function tenant(controlWorkspaceId: string = randomUUID(), organizationId: string = randomUUID()): Promise<HostedUsageScope & { customerWorkspaceId: string }> {
  const customerWorkspaceId = randomUUID();
  await db.adminSql`
    INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
    VALUES (${organizationId}::uuid, ${'usage-org-' + organizationId}, 'Usage fixture')
    ON CONFLICT (id) DO NOTHING`;
  await db.adminSql`
    INSERT INTO harness_shared.workspace_host_connections (workspace_id, id, target, label, credential_ref, status)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, 'gcp', 'Usage fixture', 'delegation://fixture/gcp', 'connected')`;
  await db.adminSql`
    INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region, size, image, disk_gib, network, desired_state, observed_state)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, 'Usage fixture', ${customerWorkspaceId},
            'gcp', 'fixture-project', 'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')`;
  await db.adminSql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name, state, created_by_principal_kind, created_by_principal_id)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, ${organizationId}, ${customerWorkspaceId},
            'Usage fixture', 'active', 'user', 'fixture-user')`;
  return { controlWorkspaceId, organizationId, customerWorkspaceId };
}

function record(scope: HostedUsageScope & { customerWorkspaceId: string }, changes: Partial<HostedUsageRecord> = {}): HostedUsageRecord {
  return {
    ...scope, provider: 'fixture-provider', recordId: randomUUID(), usageId: randomUUID(), revision: 1,
    category: 'compute', payer: 'consumption', occurredAtMs: T, observedAtMs: T,
    quantity: 60, unit: 'seconds', costSource: 'estimate', costMicros: 10_001,
    sourceRef: 'provider-fixture:receipt', ...changes,
  };
}
const read = (scope: HostedUsageScope, asOfMs = T + 1000) => store().readRecords({ scope, month: MONTH, asOfMs });

describe('PostgresHostedUsageStore (real Postgres and hosted_service)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    // A reserved draft cannot auto-apply to the shared workspace. Exercise the
    // exact migration in this disposable database, including its second apply.
    const migrationUrl = new URL('../../../../../../libs/papercusp/libs/db/sql/1351-hosted-usage-receipts.sql.DRAFT', import.meta.url);
    const armedUrl = new URL('../../../../../../libs/papercusp/libs/db/sql/1351-hosted-usage-receipts.sql', import.meta.url);
    let migration: string;
    try { migration = readFileSync(migrationUrl, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      migration = readFileSync(armedUrl, 'utf8');
    }
    await db.adminSql.unsafe(migration);
    await db.adminSql.unsafe(migration);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  it('records an exact receipt once across concurrent deliveries and a new store instance', async () => {
    const scope = await tenant(); const r = record(scope);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().append(r)));
    expect(outcomes.filter(x => x === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(x => x === 'duplicate')).toHaveLength(7);
    expect(await read(scope)).toEqual([r]);
    expect(await store().append({ ...r, costMicros: 99 })).toBe('replay-mismatch');
    expect(await read(scope)).toEqual([r]);
  });

  it('serializes conflicting revisions and catches a receipt-id collision across different usage streams', async () => {
    const scope = await tenant(); const r = record(scope);
    const revisions = await Promise.all([store().append(r), store().append({ ...r, recordId: randomUUID(), costMicros: 99 })]);
    expect(revisions.sort()).toEqual(['recorded', 'revision-conflict']);
    expect(await read(scope)).toHaveLength(1);
    const id = randomUUID();
    const races = await Promise.all([
      store().append(record(scope, { recordId: id })), store().append(record(scope, { recordId: id })),
    ]);
    expect(races.sort()).toEqual(['recorded', 'replay-mismatch']);
    expect(await read(scope)).toHaveLength(2);
  });

  it('preserves delayed corrections without summing an estimate and its eventual provider bill', async () => {
    const scope = await tenant(); const estimated = record(scope);
    const billed = { ...estimated, recordId: randomUUID(), revision: 2, observedAtMs: T + 100, costSource: 'provider-billed' as const, costMicros: 20_003 };
    // Deliver the correction first: arrival order does not invent a new usage.
    expect(await store().append(billed)).toBe('recorded');
    expect(await store().append(estimated)).toBe('recorded');
    expect(await read(scope, T + 50)).toEqual([estimated]);
    const records = await read(scope);
    expect(records).toEqual([estimated, billed]);
    const statement = buildHostedUsageStatement({ scope, month: MONTH, asOfMs: T + 1000,
      source: { complete: true, observedAtMs: T + 1000, maximumAgeMs: 0, evidenceRef: 'fixture:complete-census' }, records });
    expect(statement.consumptionBilled).toEqual({ micros: 20_003, wholeCents: 2, roundingMicros: 3 });
    expect(statement.lines[0]?.usages).toBe(1);
    expect(statement.lines[0]?.estimatedMicros).toBe(0);
  });

  it('rejects conflicting correction history atomically, including a late downgrade', async () => {
    const scope = await tenant(); const r = record(scope, { costSource: 'provider-reported' });
    await store().append(r);
    for (const change of [
      { category: 'egress' as const }, { payer: 'platform' as const }, { unit: 'bytes' },
      { costSource: 'estimate' as const }, { occurredAtMs: T - 1 }, { observedAtMs: T - 1, occurredAtMs: T - 1 },
    ]) {
      await expect(store().append({ ...r, recordId: randomUUID(), revision: 2, observedAtMs: T + 10, ...change })).rejects.toThrow();
    }
    expect(await read(scope)).toEqual([r]);
  });

  it('filters the full composite scope and rejects a foreign organization/customer pair on write', async () => {
    const a = await tenant(); const b = await tenant(a.controlWorkspaceId); const c = await tenant(randomUUID(), a.organizationId);
    const ra = record(a); const rb = record(b); const rc = record(c);
    await Promise.all([store().append(ra), store().append(rb), store().append(rc)]);
    expect(await read(a)).toEqual([ra]);
    expect(await read({ ...a, customerWorkspaceId: null })).toEqual([ra]);
    expect(await read({ ...a, customerWorkspaceId: b.customerWorkspaceId })).toEqual([]);
    await expect(store().append(record({ ...a, customerWorkspaceId: b.customerWorkspaceId }))).rejects.toMatchObject({ code: '23503' });
    expect(await read(b)).toEqual([rb]); expect(await read(c)).toEqual([rc]);
  });

  it('keeps unknown costs distinct from an explicit zero, with exact safe integer round trips', async () => {
    const scope = await tenant();
    const unknown = record(scope, { costSource: 'unpriced', costMicros: null });
    const zero = record(scope, { costSource: 'provider-billed', costMicros: 0 });
    const maximum = record(scope, { revision: Number.MAX_SAFE_INTEGER, quantity: Number.MAX_SAFE_INTEGER, costMicros: Number.MAX_SAFE_INTEGER });
    await Promise.all([unknown, zero, maximum].map(r => store().append(r)));
    const records = await read(scope);
    expect(records).toEqual(expect.arrayContaining([unknown, zero, maximum]));
    expect(records).toHaveLength(3);
  });

  it('accepts every canonical cost category, including retained disks and external IPs', async () => {
    const scope = await tenant();
    for (const category of PILOT_COST_CATEGORIES) expect(await store().append(record(scope, { category }))).toBe('recorded');
    expect((await read(scope)).map(r => r.category).sort()).toEqual([...PILOT_COST_CATEGORIES].sort());
  });

  it('uses an exclusive UTC month end and hides observations not yet known', async () => {
    const scope = await tenant();
    const before = record(scope, { occurredAtMs: Date.UTC(2026, 8, 30), observedAtMs: T });
    const end = record(scope, { occurredAtMs: Date.UTC(2026, 10, 1), observedAtMs: Date.UTC(2026, 10, 1) });
    const later = record(scope, { observedAtMs: T + 2000 });
    await Promise.all([before, end, later].map(r => store().append(r)));
    expect(await read(scope)).toEqual([]);
    expect(await read(scope, T + 2000)).toEqual([later]);
  });

  it('denies public/app reads and changes while even a privileged writer cannot rewrite history', async () => {
    const scope = await tenant(); const r = record(scope); await store().append(r);
    await expect(db.appSql`SELECT * FROM papercusp_auth.hosted_usage_receipts`).rejects.toMatchObject({ code: '42501' });
    await expect(runService(sql => sql`UPDATE papercusp_auth.hosted_usage_receipts SET cost_micros = 1`)).rejects.toMatchObject({ code: '42501' });
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_usage_receipts SET cost_micros = 1`).rejects.toThrow('append-only');
    await expect(db.adminSql`DELETE FROM papercusp_auth.hosted_usage_receipts`).rejects.toThrow('append-only');
    expect(await read(scope)).toEqual([r]);
  });

  it('refuses unsupported content fields and invalid scope/counter inputs instead of returning a free statement', async () => {
    const scope = await tenant();
    await expect(store().append({ ...record(scope), customerContent: 'private' } as HostedUsageRecord)).rejects.toThrow('unsupported fields');
    await expect(store().append(record(scope, { costSource: 'unpriced', costMicros: 0 }))).rejects.toThrow('unknown cost');
    await expect(read({ ...scope, organizationId: '' })).rejects.toThrow('identifier');
    await expect(read(scope, Number.NaN)).rejects.toThrow('safe integers');
    expect(await read(scope)).toEqual([]);
  });

  it('persists authenticated OpenRouter reports once and replaces corrections using real service transactions', async () => {
    const scope = await tenant(); const foreign = await tenant(scope.controlWorkspaceId);
    const generationId = 'gen-' + randomUUID();
    let binding: OpenRouterUsageBinding = { scope, generationId, payer: 'consumption', isByok: true,
      credentialRef: 'secret-ref:fixture-account', revision: 1, occurredAtMs: T,
      observedAtMs: T + 100, evidenceRef: 'receipt:openrouter-report-1' };
    let cost = 0.0015; let keyReads = 0;
    const collector = new OpenRouterHostedUsageCollector({
      readBinding: async () => binding,
      readCredential: async () => { keyReads++; return 'fixture-account-secret'; },
      fetch: async () => new Response(JSON.stringify({ data: {
        id: generationId, is_byok: true, total_cost: cost, cancelled: true,
        upstream_inference_cost: 9, prompts: ['private fixture content'], api_key: 'private fixture key',
      } })),
      append: r => store().append(r),
    });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => collector.collect({ scope, generationId })));
    expect(outcomes.filter(o => o.outcome === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(o => o.outcome === 'duplicate')).toHaveLength(7);
    const initial = await read(scope); expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ usageId: generationId, costSource: 'provider-reported', costMicros: 1500, payer: 'consumption' });
    expect(JSON.stringify(initial)).not.toMatch(/private|secret|prompts|upstream/);
    expect(keyReads).toBe(8);
    expect((await collector.collect({ scope: foreign, generationId })).outcome).toBe('unavailable');
    expect(keyReads).toBe(8); expect(await read(foreign)).toEqual([]);
    cost = 0.002;
    expect((await collector.collect({ scope, generationId })).outcome).toBe('revision-conflict');
    expect(await read(scope)).toEqual(initial);
    binding = { ...binding, revision: 2, observedAtMs: T + 200, evidenceRef: 'receipt:openrouter-report-2' };
    expect((await collector.collect({ scope, generationId })).outcome).toBe('recorded');
    const records = await read(scope); expect(records).toHaveLength(2);
    const result = buildHostedUsageStatement({ scope, month: MONTH, asOfMs: T + 1000,
      source: { complete: false, observedAtMs: T + 200, maximumAgeMs: 1000, evidenceRef: 'fixture:partial-census' }, records });
    expect(result.lines[0]).toMatchObject({ usages: 1, reportedMicros: 2000, billedMicros: 0 });
    expect(result.settlementEligible).toBe(false);
  });
});
