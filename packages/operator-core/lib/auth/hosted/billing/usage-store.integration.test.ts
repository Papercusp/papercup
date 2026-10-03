/** Real roles, transactions, concurrent writers and tenant boundaries (monetization P-004). */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { PILOT_COST_CATEGORIES } from './unit-economics';
import { buildHostedUsageStatement, type HostedUsageRecord, type HostedUsageScope } from './usage-statement';
import { PostgresHostedUsageStore, type OpenRouterGenerationBinding } from './usage-store';
import { OpenRouterHostedUsageCollector, createOpenRouterHostedUsageCollector, type OpenRouterUsageBinding } from './openrouter-usage';
import { createHostedUsageSource } from './usage-service';

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
    let exactMigration: string;
    try { exactMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1354-hosted-usage-exact-micros.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exactMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1354-hosted-usage-exact-micros.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(exactMigration); await db.adminSql.unsafe(exactMigration);
    let bindingMigration: string;
    try { bindingMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1355-hosted-openrouter-generation-binding.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      bindingMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1355-hosted-openrouter-generation-binding.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(bindingMigration); await db.adminSql.unsafe(bindingMigration);
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

  it('persists submicro provider charges exactly across concurrent replay, corrections and tenant scopes', async () => {
    const scope = await tenant(); const foreign = await tenant(scope.controlWorkspaceId);
    const a = record(scope, { costSource: 'provider-billed', costMicros: 4999, costMicrosExact: '4999.6' });
    const b = record(scope, { costSource: 'provider-billed', costMicros: 5000, costMicrosExact: '5000.6' });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().append(a)));
    expect(outcomes.filter(x => x === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(x => x === 'duplicate')).toHaveLength(7);
    expect(await store().append({ ...a, costMicrosExact: '4999.7' })).toBe('replay-mismatch');
    expect(await store().append(b)).toBe('recorded');
    const records = await read(scope); expect(records).toHaveLength(2);
    expect(records.find(r => r.recordId === a.recordId)).toEqual(a);
    const projected = () => read(scope).then(records => buildHostedUsageStatement({ scope, month: MONTH, asOfMs: T + 1000,
      source: { complete: true, observedAtMs: T + 1000, maximumAgeMs: 0, evidenceRef: 'fixture:exact-census' }, records }));
    expect((await projected()).consumptionBilled).toMatchObject({ wholeCents: 1, microsExact: '10000.2', roundingMicrosExact: '0.2' });
    expect(await store().append({ ...a, recordId: randomUUID(), revision: 2, observedAtMs: T + 1, costMicrosExact: '4999.3' })).toBe('recorded');
    expect((await projected()).consumptionBilled).toMatchObject({ wholeCents: 0, microsExact: '9999.9' });
    expect(await read(foreign)).toEqual([]);
    const tiny = record(scope, { costSource: 'provider-reported', costMicros: 0, costMicrosExact: '0.' + '0'.repeat(317) + '5' });
    expect(await store().append(tiny)).toBe('recorded');
    expect((await read(scope)).find(r => r.recordId === tiny.recordId)).toEqual(tiny);
    await expect(runService(sql => sql`INSERT INTO papercusp_auth.hosted_usage_receipts
      (control_workspace_id, organization_id, customer_workspace_id, provider, record_id, usage_id,
       revision, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source, cost_micros, source_ref, received_at)
      SELECT control_workspace_id, organization_id, customer_workspace_id, provider, ${randomUUID()}, ${randomUUID()},
        1, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source,
        9007199254740991.1, source_ref, received_at FROM papercusp_auth.hosted_usage_receipts WHERE record_id = ${a.recordId}`))
      .rejects.toMatchObject({ code: '23514' });
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

  const captured = (scope: OpenRouterGenerationBinding['scope']): OpenRouterGenerationBinding => ({
    scope, generationId: 'gen-' + randomUUID(), payer: 'consumption', isByok: false,
    credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: createHash('sha256').update('execution-key').digest('hex'),
    occurredAtMs: T, observedAtMs: T + 10, evidenceRef: 'execution:bound-generation',
  });
  const bindings = (scope: HostedUsageScope, asOfMs = T + 1000) => store().readOpenRouterBindings({ scope, month: MONTH, asOfMs });

  it('durably binds once across concurrent execution receipts, survives restart and excludes private metadata from public records', async () => {
    const scope = await tenant(); const b = captured(scope);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().bindOpenRouterGeneration(b)));
    expect(outcomes.filter(x => x === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(x => x === 'duplicate')).toHaveLength(7);
    const stored = await read(scope); expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ usageId: b.generationId, costSource: 'unpriced', costMicros: null, revision: 1 });
    expect(JSON.stringify(stored)).not.toMatch(/credential|sha256|execution-key|FIXTURE_OPENROUTER/);
    expect(await bindings(scope)).toEqual([{ ...b, revision: 2, observedAtMs: T + 1000, evidenceRef: 'openrouter:metadata-read' }]);
    const changed = { ...b, credentialSha256: createHash('sha256').update('other-account').digest('hex') };
    expect(await store().bindOpenRouterGeneration(changed)).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, credentialRef: 'env:OTHER_ACCOUNT' })).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, isByok: true })).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, payer: 'customer-direct' })).toBe('replay-mismatch');
    expect(await read(scope)).toEqual(stored);
  });

  it('prevents global generation reassignment across racing tenants and hides foreign/time/month bindings', async () => {
    const a = await tenant(); const otherOrg = await tenant(a.controlWorkspaceId);
    const otherWorkspace = await tenant(a.controlWorkspaceId, a.organizationId); const otherControl = await tenant();
    const b = captured(a);
    const outcomes = await Promise.all([store().bindOpenRouterGeneration(b), store().bindOpenRouterGeneration({ ...b, scope: otherOrg })]);
    expect(outcomes.sort()).toEqual(['recorded', 'replay-mismatch']);
    const winner = (await read(a)).length ? a : otherOrg; const loser = winner === a ? otherOrg : a;
    expect(await bindings(loser)).toEqual([]); expect(await bindings(otherWorkspace)).toEqual([]);
    expect(await bindings(otherControl)).toEqual([]); expect(await bindings(winner, T + 9)).toEqual([]);
    expect(await store().readOpenRouterBindings({ scope: winner, month: '2026-11', asOfMs: T + 1000 })).toEqual([]);
    expect(await bindings({ ...winner, customerWorkspaceId: null })).toHaveLength(1);
    const report = record(loser, { provider: 'openrouter', usageId: b.generationId, revision: 2,
      category: 'inference-fees', quantity: 1, unit: 'generations', costSource: 'provider-reported' });
    expect(await store().append(report)).toBe('replay-mismatch'); expect(await read(loser)).toEqual([]);
  });

  it('collects through a new store instance, keeps exact corrections, and refuses changed keys before provider reads', async () => {
    const scope = await tenant(); const b = captured(scope); await store().bindOpenRouterGeneration(b);
    let key = 'other-key'; let calls = 0; let cost = '0.001234560000000000001';
    const fresh = store();
    const source = createHostedUsageSource({ store: fresh, maximumAgeMs: 1000, collectors: [createOpenRouterHostedUsageCollector({
      store: fresh, readCredential: async () => key, fetch: async () => {
        calls++;
        return new Response('{"data":{"id":"' + b.generationId + '","is_byok":false,"total_cost":' + cost + ',"prompt":"private"}}');
      },
    })] });
    const input = { scope, month: MONTH, asOfMs: T + 1000 };
    expect((await source(input)).lines[0]).toMatchObject({ unpricedUsages: 1, reportedMicros: 0 });
    expect(calls).toBe(0); expect(await read(scope)).toHaveLength(1);
    key = 'execution-key';
    const first = await source(input); expect(first.lines[0]).toMatchObject({ usages: 1, reportedMicrosExact: '1234.560000000000001' });
    expect(first.settlementEligible).toBe(false); expect(first.forecast.unavailableReason).toBe('incomplete-source');
    expect(JSON.stringify(first)).not.toMatch(/private|credential|execution-key|FIXTURE_OPENROUTER/);
    expect((await bindings(scope))[0]?.revision).toBe(3);
    cost = '0.0000001';
    const correction = await source({ ...input, asOfMs: T + 2000 });
    expect(correction.lines[0]).toMatchObject({ usages: 1, reportedMicrosExact: '0.1', billedMicros: 0 });
    expect(await bindings(scope, T + 1000)).toEqual([]); // Newer committed report cannot reuse its old revision.
    expect(await read(scope, T + 2000)).toHaveLength(3); expect(calls).toBe(2);
  });

  it('rejects malformed durable bindings and SQL bypasses of the private binding constraint', async () => {
    const scope = await tenant(); const b = captured(scope);
    for (const change of [{ credentialRef: 'raw-key-value' }, { credentialSha256: 'not-a-fingerprint' },
      { credentialRef: 'env:KEY\nInjected' }, { generationId: 'not-a-generation' }, { revision: 7 }, { customerContent: 'private' }]) {
      await expect(store().bindOpenRouterGeneration({ ...b, ...change } as OpenRouterGenerationBinding)).rejects.toThrow(/binding/);
    }
    await store().bindOpenRouterGeneration(b);
    const rows = await runService(sql => sql`SELECT openrouter_credential_ref, openrouter_key_sha256, openrouter_is_byok
      FROM papercusp_auth.hosted_usage_receipts WHERE usage_id = ${b.generationId}`);
    expect(rows[0]).toMatchObject({ openrouter_credential_ref: b.credentialRef, openrouter_key_sha256: b.credentialSha256, openrouter_is_byok: false });
    await expect(runService(sql => sql`INSERT INTO papercusp_auth.hosted_usage_receipts
      (control_workspace_id, organization_id, customer_workspace_id, provider, record_id, usage_id,
       revision, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source, cost_micros, source_ref,
       openrouter_credential_ref, openrouter_key_sha256, openrouter_is_byok)
      SELECT control_workspace_id, organization_id, customer_workspace_id, provider, ${randomUUID()}, ${'gen-' + randomUUID()},
        1, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source, cost_micros, source_ref,
        openrouter_credential_ref, NULL, openrouter_is_byok
      FROM papercusp_auth.hosted_usage_receipts WHERE usage_id = ${b.generationId}`)).rejects.toMatchObject({ code: '23514' });
  });
});
