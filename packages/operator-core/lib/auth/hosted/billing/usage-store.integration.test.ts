/** Real roles, transactions, concurrent writers and tenant boundaries (monetization P-004). */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { PILOT_COST_CATEGORIES } from './unit-economics';
import { buildHostedUsageStatement, type HostedUsageRecord, type HostedUsageScope } from './usage-statement';
import { PostgresHostedUsageStore, type OpenRouterGenerationBinding } from './usage-store';
import { OpenRouterHostedUsageCollector, createOpenRouterHostedUsageCollector, openRouterUsageRecord, type OpenRouterUsageBinding } from './openrouter-usage';
import { createHostedUsageSource } from './usage-service';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';
import { PostgresHostedBudgetStore, type HostedBudgetContextReader, type HostedBudgetExecutionGrant } from './budget-store';
import { createRoutedModelPort } from '../../../agent-loop/provider-router';
import { runAgentLoop } from '../../../agent-loop/loop';

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

async function tenant(controlWorkspaceId: string = randomUUID(), organizationId: string = randomUUID(), state: 'active' | 'deleted' = 'active'): Promise<HostedUsageScope & { customerWorkspaceId: string }> {
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
      (workspace_id, id, organization_id, workspace_host_id, display_name, state, deleted_at, created_by_principal_kind, created_by_principal_id)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, ${organizationId}, ${customerWorkspaceId},
            'Usage fixture', ${state}, ${state === 'deleted' ? new Date(T) : null}, 'user', 'fixture-user')`;
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
    let populationMigration: string;
    try { populationMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1382-hosted-usage-population-lock.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      populationMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1382-hosted-usage-population-lock.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(populationMigration); await db.adminSql.unsafe(populationMigration);
    let grantMigration: string;
    try { grantMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1391-hosted-openrouter-budget-binding.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      grantMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1391-hosted-openrouter-budget-binding.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(grantMigration); await db.adminSql.unsafe(grantMigration);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  async function withPopulationHeld(fn: () => Promise<void>, rollback = false) {
    let ready!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const sentinel = new Error('usage population rollback');
    const held = runService(async sql => {
      await store().readLockedPopulation(sql); ready(); await released;
      if (rollback) throw sentinel;
    }).catch(error => { if (error !== sentinel) throw error; });
    try { await Promise.race([started, held]); await fn(); }
    finally { release(); await held; }
  }
  const boundedWriter = () => new PostgresHostedUsageStore(fn => runService(async sql => {
    await sql.unsafe("SET LOCAL lock_timeout = '100ms'"); return fn(sql);
  }));

  it('locks an empty local population against real receipt/binding writers and direct SQL until commit', async () => {
    const a = await tenant(); const r = record(a); const b: OpenRouterGenerationBinding = {
      scope: a, generationId: 'gen-' + randomUUID(), payer: 'consumption', isByok: false,
      credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: 'a'.repeat(64),
      occurredAtMs: T, observedAtMs: T, evidenceRef: 'execution:population-binding',
    };
    await runService(async sql => {
      const population = await store().readLockedPopulation(sql);
      expect(population).toEqual({ records: [], openRouterBindings: [] });
      expect(Object.hasOwn(population, 'complete')).toBe(false);
    });
    await withPopulationHeld(async () => {
      await expect(boundedWriter().append(r)).rejects.toMatchObject({ code: '55P03' });
      await expect(boundedWriter().bindOpenRouterGeneration(b)).rejects.toMatchObject({ code: '55P03' });
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await tx`INSERT INTO papercusp_auth.hosted_usage_receipts
          (control_workspace_id, organization_id, customer_workspace_id, provider, record_id,
           usage_id, revision, category, payer, occurred_at_ms, observed_at_ms, quantity,
           unit, cost_source, cost_micros, source_ref)
          VALUES (${a.controlWorkspaceId}, ${a.organizationId}, ${a.customerWorkspaceId}, 'fixture-provider',
            ${r.recordId}, ${r.usageId}, 1, 'compute', 'consumption', ${T}, ${T}, 60, 'seconds', 'estimate', 10001,
            'provider-fixture:receipt')`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    expect(await store().append(r)).toBe('recorded');
    expect(await store().bindOpenRouterGeneration(b)).toBe('recorded');
    expect(await read(a)).toHaveLength(2);
  });

  it('retains all providers, scopes, times and revisions beyond the rotating 25-binding batch', async () => {
    const a = await tenant(); const otherOrg = await tenant(a.controlWorkspaceId);
    const otherControl = await tenant();
    const old = record(a, { occurredAtMs: Date.UTC(2026, 7, 1), observedAtMs: Date.UTC(2026, 7, 2),
      costSource: 'unpriced', costMicros: null });
    const future = record(otherOrg, { occurredAtMs: Date.UTC(2026, 10, 1), observedAtMs: Date.UTC(2026, 10, 1),
      costSource: 'provider-billed', costMicros: 0, costMicrosExact: '0.0000001' });
    const revised = { ...future, recordId: randomUUID(), revision: 2, observedAtMs: future.observedAtMs + 1,
      costMicrosExact: '0.0000002' };
    const foreign = record(otherControl, { payer: 'customer-direct' });
    for (const r of [old, future, revised, foreign]) expect(await store().append(r)).toBe('recorded');
    const capturedBindings: OpenRouterGenerationBinding[] = Array.from({ length: 30 }, (_, index) => ({
      scope: index % 2 ? a : otherControl, generationId: 'gen-' + randomUUID(),
      payer: index % 2 ? 'consumption' : 'customer-direct', isByok: index % 2 === 0,
      credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: 'b'.repeat(64),
      occurredAtMs: old.occurredAtMs, observedAtMs: old.observedAtMs,
      evidenceRef: 'execution:population-capture',
    }));
    for (const b of capturedBindings) expect(await store().bindOpenRouterGeneration(b)).toBe('recorded');
    // The constructor's scoped runner cannot substitute a different transaction.
    const localReader = new PostgresHostedUsageStore(async () => { throw new Error('separate runner must not execute'); });
    const population = await runService(sql => localReader.readLockedPopulation(sql));
    expect(population.records).toEqual(expect.arrayContaining([old, future, revised, foreign]));
    const ids = new Set(capturedBindings.map(b => b.generationId));
    expect(population.openRouterBindings.filter(b => ids.has(b.generationId))).toEqual(expect.arrayContaining(capturedBindings));
    expect(population.openRouterBindings.filter(b => ids.has(b.generationId))).toHaveLength(30);
    const allRows = await db.adminSql`SELECT record_id FROM papercusp_auth.hosted_usage_receipts`;
    expect(population.records.map(r => r.recordId).sort()).toEqual(allRows.map(r => r.record_id).sort());
    expect(Object.isFrozen(population)).toBe(true);
    expect(Object.isFrozen(population.records)).toBe(true);
    expect(Object.isFrozen(population.openRouterBindings)).toBe(true);
    expect(population.records.every(Object.isFrozen)).toBe(true);
    expect(population.openRouterBindings.every(b => Object.isFrozen(b) && Object.isFrozen(b.scope))).toBe(true);
    expect(JSON.stringify(population.records)).not.toMatch(/credential|sha256|FIXTURE_OPENROUTER/);
    expect(Object.hasOwn(population, 'complete')).toBe(false);
  });

  it('reads its own uncommitted binding and releases receipt locks and rows on rollback', async () => {
    const a = await tenant(); const generationId = 'gen-' + randomUUID();
    await expect(runService(async sql => {
      const sameTransaction = new PostgresHostedUsageStore(fn => fn(sql));
      expect(await sameTransaction.bindOpenRouterGeneration({ scope: a, generationId, payer: 'consumption', isByok: false,
        credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: 'c'.repeat(64),
        occurredAtMs: T, observedAtMs: T + 1, evidenceRef: 'execution:uncommitted-binding' })).toBe('recorded');
      const population = await sameTransaction.readLockedPopulation(sql);
      expect(population.openRouterBindings.some(b => b.generationId === generationId)).toBe(true);
      expect(population.records.some(r => r.usageId === generationId)).toBe(true);
      throw new Error('uncommitted population rollback');
    })).rejects.toThrow('uncommitted population rollback');
    expect(await read(a)).toEqual([]);
    const r = record(a);
    await withPopulationHeld(async () => {
      await expect(boundedWriter().append(r)).rejects.toMatchObject({ code: '55P03' });
    }, true);
    expect(await store().append(r)).toBe('recorded');
    expect(await read(a)).toEqual([r]);
  });

  it('includes a writer that commits while the population lock is waiting', async () => {
    const a = await tenant(); const r = record(a);
    let inserted!: () => void; let release!: () => void; let readerPid = 0;
    const started = new Promise<void>(resolve => { inserted = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const writer = runService(async sql => {
      expect(await new PostgresHostedUsageStore(fn => fn(sql)).append(r)).toBe('recorded');
      inserted(); await released;
    });
    let reader: ReturnType<PostgresHostedUsageStore['readLockedPopulation']> | undefined;
    try {
      await Promise.race([started, writer]);
      reader = runService(async sql => {
        const [row] = await sql`SELECT pg_backend_pid() AS pid`; readerPid = row!.pid;
        await sql.unsafe("SET LOCAL statement_timeout = '5s'");
        return store().readLockedPopulation(sql);
      });
      await vi.waitFor(async () => {
        const waiting = await db.adminSql`SELECT pid FROM pg_locks WHERE pid = ${readerPid}
          AND relation = 'papercusp_auth.hosted_usage_receipts'::regclass AND mode = 'ShareLock' AND NOT granted`;
        expect(waiting).toHaveLength(1);
      }, { timeout: 3000, interval: 10 });
      release(); await writer;
      expect((await reader).records).toEqual(expect.arrayContaining([r]));
    } finally { release(); await Promise.allSettled([writer, ...(reader ? [reader] : [])]); }
  });

  it('rejects an autocommit pool whose read locks ended between statements', async () => {
    await expect(store().readLockedPopulation(db.adminSql)).rejects.toThrow('usage population requires one transaction');
  });

  it('rejects stale-snapshot isolation in both the reader and the fixed lock helper', async () => {
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
      for (const readPopulation of [true, false]) {
        await expect(db.appSql.begin(async tx => {
          await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          await tx.unsafe('SET LOCAL ROLE hosted_service');
          if (readPopulation) await store().readLockedPopulation(tx as unknown as Sql);
          else await tx`SELECT papercusp_auth.lock_hosted_usage_population()`;
        })).rejects.toThrow('usage population requires read committed');
      }
    }
  });

  it('restricts the fixed lock helper to hosted_service without widening receipt write privileges', async () => {
    await expect(db.appSql`SELECT papercusp_auth.lock_hosted_usage_population()`).rejects.toMatchObject({ code: '42501' });
    await expect(db.appSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_app'); await tx`SELECT papercusp_auth.lock_hosted_usage_population()`;
    })).rejects.toMatchObject({ code: '42501' });
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      const [row] = await db.adminSql`SELECT has_table_privilege('hosted_service',
        'papercusp_auth.hosted_usage_receipts', ${privilege}) AS allowed`;
      expect(row!.allowed).toBe(false);
    }
    const [role] = await runService(async sql => {
      await store().readLockedPopulation(sql); return sql`SELECT current_user AS role`;
    });
    expect(role!.role).toBe('hosted_service');
  });

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

  // Exercise the real admission/dispatch writer with fixture-only authority.
  // This context never installs a production funding or entitlement reader.
  const grantContext: HostedBudgetContextReader = async (_sql, request) => {
    const { startMs, endMs } = shadowMonthBounds(request.month);
    return { scope: request.scope, month: request.month, asOfMs: request.asOfMs, evidenceRef: 'fixture:grant-authority',
      policy: { policyId: 'fixture-grant-policy', revision: 1, budgetKey: request.budgetKey,
        effectiveFromMs: startMs, effectiveUntilMs: endMs, warningBps: 8000 },
      limits: [{ customerWorkspaceId: null, entitlements: { budgets: { [request.budgetKey]: 100 } },
        fundedMicros: 1_000_000, externalSpentMicros: 0, retainedReserveMicros: 0, unreconciled: false }] };
  };
  const budgetStore = () => new PostgresHostedBudgetStore({ run: runService, readContext: grantContext, now: () => T });

  const intent = { provider: 'openrouter', modelId: 'vendor/model' };
  const captureRequest = (scope: OpenRouterGenerationBinding['scope']) => ({ scope, reservationId: randomUUID(),
    month: MONTH, budgetKey: 'consumption.usd_cents', maximumCostMicros: 100_000,
    providerLimitRef: 'fixture:enforced-limit-unverified', asOfMs: T });
  const captureContext = () => ({ modelId: intent.modelId, servedAccount: 'local-fixture-account',
    credentialSha256: createHash('sha256').update('execution-key').digest('hex') });
  const captureOptions = (scope: OpenRouterGenerationBinding['scope']) => ({ budget: budgetStore(),
    request: captureRequest(scope), context: captureContext(), credentialRef: 'env:FIXTURE_OPENROUTER_KEY',
    isByok: false, evidenceRef: 'execution:paused-native-capture', now: () => T });

  it.each(['error', 'abort-before-wire'] as const)('composes actual native routing with committed admission and early binding on %s', async ending => {
    const scope = await tenant(); const options = captureOptions(scope);
    const abort = new AbortController(); const generationId = 'gen-' + randomUUID(); let wireCalls = 0;
    const sdkModel: LanguageModelV3 = { specificationVersion: 'v3', provider: 'fixture', modelId: 'vendor/model', supportedUrls: {},
      async doGenerate() { throw new Error('unused'); }, async doStream() {
        wireCalls++;
        // This measurement is inside the actual dispatch callback, after the
        // native paused intent: admission must already be durable.
        expect((await budgetStore().reserve(options.request)).outcome).toBe('duplicate');
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: 'response-metadata', id: generationId, modelId: intent.modelId });
          controller.enqueue({ type: 'error', error: 'provider failed after generation identity' }); controller.close();
        } }) };
      } };
    const port = createRoutedModelPort({ catalog: null,
      openRouterAccounts: { active: () => ({ accountId: 'local-fixture-account', authMode: 'api-key',
        token: async () => 'execution-key' }), onExhausted: () => null },
      createLanguageModel: async () => sdkModel,
      openRouterRequestCapture: context => store().createOpenRouterRequestCapture({ ...options, context }) });
    const events = [];
    for await (const event of runAgentLoop({ port, model: 'openrouter/vendor/model', messages: [], signal: abort.signal,
      onProviderRequest: async observation => { if (ending === 'abort-before-wire' && !observation.request.response) abort.abort(); } })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: ending === 'error' ? 'error' : 'aborted', steps: [] });
    expect(wireCalls).toBe(ending === 'error' ? 1 : 0);
    const saved = await bindings(scope);
    if (ending === 'error') {
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ generationId, credentialSha256: createHash('sha256').update('execution-key').digest('hex'),
        budgetGrant: { reservationId: options.request.reservationId } });
    } else expect(saved).toEqual([]);
    expect((await budgetStore().reserve(options.request)).receipt).toMatchObject({ revision: 0, providerFinal: false, costMicros: null });
    expect(JSON.stringify(events)).not.toMatch(/budgetGrant|credentialSha256|execution-key|reservationId|policyId/);
    expect(events.flatMap(event => event.type === 'done' ? event.providerRequests ?? [] : [])
      .every(observation => Object.getOwnPropertySymbols(observation).length === 0)).toBe(true);
  });

  it('refuses concurrent use of a request capture closure without reopening its committed hold', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const budget = new PostgresHostedBudgetStore({ run: runService, now: () => T,
      readContext: async (sql, request) => { entered(); await gate; return grantContext(sql, request); } });
    const capture = store().createOpenRouterRequestCapture({ ...options, budget });
    const first = capture(intent).catch(error => error);
    await started;
    await expect(capture(intent)).rejects.toThrow('not resumable');
    release();
    expect(await first).toBeInstanceOf(Error);
    expect((await budgetStore().reserve(options.request)).receipt).toMatchObject({ revision: 0, providerFinal: false });
    expect(await read(scope)).toEqual([]);
  });

  it('commits native dispatch intent before a private early binding and preserves an unpriced immutable hold', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    const capture = store().createOpenRouterRequestCapture(options);
    await capture(intent);
    expect((await budgetStore().reserve(options.request)).outcome).toBe('duplicate');
    expect(await read(scope)).toEqual([]);
    const generationId = 'gen-' + randomUUID();
    await capture({ ...intent, response: { id: generationId, modelId: intent.modelId } });
    await capture({ ...intent, response: { id: generationId } });
    const saved = await bindings(scope);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ generationId, credentialSha256: options.context.credentialSha256,
      budgetGrant: { reservationId: options.request.reservationId, maximumCostMicros: 100_000 } });
    expect((await read(scope))[0]).toMatchObject({ costSource: 'unpriced', costMicros: null });
    const replay = await budgetStore().reserve(options.request);
    expect(replay.receipt).toMatchObject({ revision: 0, costMicros: null, providerFinal: false });
    expect(JSON.stringify(await read(scope))).not.toMatch(/budgetGrant|credential|reservationId|local-fixture-account/);
  });

  it('refuses a reused reservation in a new stream and retains a missing-generation hold', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    await store().createOpenRouterRequestCapture(options)(intent);
    await expect(store().createOpenRouterRequestCapture(options)(intent)).rejects.toThrow('not freshly admitted');
    const replay = await budgetStore().reserve(options.request);
    expect(replay).toMatchObject({ outcome: 'duplicate', receipt: { revision: 0, providerFinal: false, costMicros: null } });
    expect(await read(scope)).toEqual([]);
  });

  it.each(['conflict', 'uncertain', 'served-model', 'invalid-id'] as const)('refuses %s identity without rebinding or releasing the admission', async mode => {
    const scope = await tenant(); const options = captureOptions(scope);
    const capture = store().createOpenRouterRequestCapture(options);
    const first = 'gen-' + randomUUID(); await capture(intent);
    await capture({ ...intent, response: { id: first } });
    const next = { ...intent, response: { id: mode === 'conflict' ? 'gen-' + randomUUID() : mode === 'invalid-id' ? 'invalid' : first,
      ...(mode === 'served-model' ? { modelId: 'vendor/other' } : {}) },
      ...(mode === 'uncertain' ? { identityUncertain: true } : {}) };
    await expect(capture(next)).rejects.toThrow();
    await expect(capture({ ...intent, response: { id: first } })).rejects.toThrow('not resumable');
    expect((await bindings(scope)).map(b => b.generationId)).toEqual([first]);
    expect((await budgetStore().reserve(options.request)).receipt).toMatchObject({ revision: 0, providerFinal: false });
  });

  it('snapshots server authorization and credential identity before any asynchronous admission', async () => {
    const scope = await tenant(); const base = captureOptions(scope);
    const options = { ...base, request: { ...base.request, scope: { ...scope } } };
    const original = { ...options.request, scope: { ...scope } };
    const hash = options.context.credentialSha256;
    const capture = store().createOpenRouterRequestCapture(options);
    options.request.scope.customerWorkspaceId = randomUUID(); options.request.maximumCostMicros = 1;
    options.context.credentialSha256 = 'b'.repeat(64); options.credentialRef = 'env:OTHER_KEY';
    await capture(intent);
    await capture({ ...intent, response: { id: 'gen-' + randomUUID() } });
    expect((await bindings(scope))[0]).toMatchObject({ credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: hash,
      budgetGrant: { scope, maximumCostMicros: 100_000 } });
    expect((await budgetStore().reserve(original)).outcome).toBe('duplicate');
  });

  it('keeps the admission after a bounded SQL binding failure and never retries the uncertain write', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    const capture = boundedWriter().createOpenRouterRequestCapture(options);
    await capture(intent);
    const observation = { ...intent, response: { id: 'gen-' + randomUUID() } };
    await withPopulationHeld(async () => {
      await expect(capture(observation)).rejects.toMatchObject({ code: '55P03' });
    });
    await expect(capture(observation)).rejects.toThrow('not resumable');
    expect(await read(scope)).toEqual([]);
    expect((await budgetStore().reserve(options.request)).receipt).toMatchObject({ revision: 0, costMicros: null, providerFinal: false });
  });

  it('refuses identity before dispatch intent, unconfigured authority and invalid server clocks', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    await expect(store().createOpenRouterRequestCapture(options)({ ...intent, response: { id: 'gen-before-admission' } }))
      .rejects.toThrow('dispatch intent');
    const noAuthority = new PostgresHostedBudgetStore({ run: runService, now: () => T });
    await expect(store().createOpenRouterRequestCapture({ ...options, budget: noAuthority })(intent))
      .rejects.toThrow('not freshly admitted');
    const badTime = { ...captureOptions(scope), now: () => T - 1 };
    await expect(store().createOpenRouterRequestCapture(badTime)(intent)).rejects.toThrow('execution time');
    expect((await budgetStore().reserve(badTime.request)).receipt).toMatchObject({ revision: 0, providerFinal: false });
    expect(await read(scope)).toEqual([]);
  });

  async function admittedGrant(scope: OpenRouterGenerationBinding['scope']): Promise<HostedBudgetExecutionGrant> {
    const result = await budgetStore().executeOnce({ scope, reservationId: randomUUID(), month: MONTH,
      budgetKey: 'consumption.usd_cents', maximumCostMicros: 100_000,
      providerLimitRef: 'fixture:opaque-provider-limit', asOfMs: T }, async grant => grant);
    if (result.execution !== 'dispatched') throw new Error('fixture admission was refused');
    return result.value;
  }

  it('joins a real executeOnce admission to one private generation capture, survives restart and excludes the grant from public usage', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope);
    const b = { ...captured(scope), budgetGrant: grant };
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().bindOpenRouterGeneration(b)));
    expect(outcomes.filter(x => x === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(x => x === 'duplicate')).toHaveLength(7);
    expect((await bindings(scope))[0]?.budgetGrant).toEqual(grant);
    await runService(async sql => {
      const population = await store().readLockedPopulation(sql);
      const saved = population.openRouterBindings.find(x => x.generationId === b.generationId)!;
      expect(saved.budgetGrant).toEqual(grant);
      expect(Object.isFrozen(saved.budgetGrant)).toBe(true);
      expect(Object.isFrozen(saved.budgetGrant!.scope)).toBe(true);
      expect(Object.hasOwn(population, 'complete')).toBe(false);
    });
    const correction = openRouterUsageRecord({ ...b, revision: 2, observedAtMs: T + 20 }, {
      data: { id: b.generationId, is_byok: false, total_cost: 0.0000001 },
    });
    expect(await store().append(correction)).toBe('recorded');
    expect((await bindings(scope))[0]?.budgetGrant).toEqual(grant);
    const records = await read(scope);
    expect(records.at(-1)?.costMicrosExact).toBe('0.1');
    expect(JSON.stringify(records)).not.toMatch(/budgetGrant|reservationId|policyId|providerLimitRef|credential/);
    const statement = buildHostedUsageStatement({ scope, month: MONTH, asOfMs: T + 1000,
      source: { complete: false, observedAtMs: T + 20, maximumAgeMs: 1000, evidenceRef: 'fixture:partial-census' }, records });
    expect(statement.settlementEligible).toBe(false);
    expect(JSON.stringify(statement)).not.toMatch(/budgetGrant|reservationId|policyId|providerLimitRef|credential/);
  });

  it('refuses copied or changed admission fields, foreign tenants, non-consumption payers and execution before admission', async () => {
    const scope = await tenant(); const foreign = await tenant(); const grant = await admittedGrant(scope);
    const b = { ...captured(scope), budgetGrant: grant };
    for (const change of [{ reservationId: randomUUID() }, { month: '2026-11' }, { budgetKey: 'other.usd_cents' },
      { maximumCostMicros: 99_999 }, { providerLimitRef: 'fixture:same-amount-different-limit' },
      { policyId: 'fixture:other-policy' }, { policyRevision: 2 }, { evidenceRef: 'fixture:other-authority' },
      { scope: foreign }]) {
      expect(await store().bindOpenRouterGeneration({ ...b, budgetGrant: { ...grant, ...change } })).toBe('replay-mismatch');
    }
    expect(await store().bindOpenRouterGeneration({ ...b, scope: foreign })).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, payer: 'customer-direct' })).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, occurredAtMs: T - 1 })).toBe('replay-mismatch');
    expect(await read(scope)).toEqual([]); expect(await read(foreign)).toEqual([]);
  });

  it('serializes two generation captures for one admission across independent generation locks', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope);
    const a = { ...captured(scope), budgetGrant: grant }; const b = { ...captured(scope), budgetGrant: grant };
    expect((await Promise.all([store().bindOpenRouterGeneration(a), store().bindOpenRouterGeneration(b)])).sort())
      .toEqual(['recorded', 'replay-mismatch']);
    const saved = await bindings(scope); expect(saved).toHaveLength(1); expect(saved[0]?.budgetGrant).toEqual(grant);
    expect(await read(scope)).toHaveLength(1);
  });

  it('preserves legacy unjoined bindings and refuses attaching, removing or replacing a grant on replay', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope); const legacy = captured(scope);
    expect(await store().bindOpenRouterGeneration(legacy)).toBe('recorded');
    expect(await store().bindOpenRouterGeneration({ ...legacy, budgetGrant: grant })).toBe('replay-mismatch');
    const b = { ...captured(scope), budgetGrant: grant };
    expect(await store().bindOpenRouterGeneration(b)).toBe('recorded');
    expect(await store().bindOpenRouterGeneration({ ...b, budgetGrant: undefined })).toBe('replay-mismatch');
    const replacement = await admittedGrant(scope);
    expect(await store().bindOpenRouterGeneration({ ...b, budgetGrant: replacement })).toBe('replay-mismatch');
    const saved = await bindings(scope);
    expect(saved.find(x => x.generationId === legacy.generationId)).not.toHaveProperty('budgetGrant');
    expect(saved.find(x => x.generationId === b.generationId)?.budgetGrant).toEqual(grant);
  });

  it('snapshots private admission fields before the first await and rejects malformed grants before opening a runner', async () => {
    const scope = await tenant(); const original = await admittedGrant(scope);
    const mutable = { ...original, scope: { ...original.scope } };
    const b = { ...captured(scope), budgetGrant: mutable };
    const changing = new PostgresHostedUsageStore(fn => {
      mutable.maximumCostMicros = 1; mutable.scope.customerWorkspaceId = randomUUID(); return runService(fn);
    });
    expect(await changing.bindOpenRouterGeneration(b)).toBe('recorded');
    expect((await bindings(scope))[0]?.budgetGrant).toEqual(original);
    const run = vi.fn(); const malformed = new PostgresHostedUsageStore(fn => { run(); return runService(fn); });
    for (const value of [null, [], { ...original, privateContent: 'secret' }, { ...original, maximumCostMicros: -1 },
      { ...original, policyRevision: 0 }, { ...original, scope: { ...scope, extra: 'secret' } },
      { ...original, month: '2026-13' }]) {
      await expect(malformed.bindOpenRouterGeneration({ ...b, budgetGrant: value } as OpenRouterGenerationBinding))
        .rejects.toThrow();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('enforces the exact admission and one-generation join against direct SQL without widening financial DML grants', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope);
    const a = { ...captured(scope), budgetGrant: grant }; expect(await store().bindOpenRouterGeneration(a)).toBe('recorded');
    const insert = (value: unknown, payer = 'consumption', credential = a.credentialRef) => runService(sql => sql`
      INSERT INTO papercusp_auth.hosted_usage_receipts
        (control_workspace_id, organization_id, customer_workspace_id, provider, record_id, usage_id,
         revision, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source, cost_micros,
         source_ref, openrouter_credential_ref, openrouter_key_sha256, openrouter_is_byok, openrouter_budget_grant)
      VALUES (${scope.controlWorkspaceId}, ${scope.organizationId}, ${scope.customerWorkspaceId}, 'openrouter',
        ${randomUUID()}, ${'gen-' + randomUUID()}, 1, 'inference-fees', ${payer}, ${T}, ${T + 10}, 1, 'generations',
        'unpriced', NULL, 'fixture:direct-capture', ${credential}, ${a.credentialSha256}, false, ${JSON.stringify(value)}::jsonb)`);
    for (const value of [[], { ...grant, maximumCostMicros: 99_999 }, { ...grant, reservationId: randomUUID() },
      { ...grant, scope: { ...scope, customerWorkspaceId: randomUUID() } }, { ...grant, extra: 'content' }]) {
      await expect(insert(value)).rejects.toMatchObject({ code: '23514' });
    }
    await expect(insert(grant, 'customer-direct')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(grant)).rejects.toMatchObject({ code: '23505' });
    await expect(runService(sql => sql`UPDATE papercusp_auth.hosted_usage_receipts SET openrouter_budget_grant = NULL
      WHERE usage_id = ${a.generationId}`)).rejects.toMatchObject({ code: '42501' });
    await expect(runService(sql => sql`DELETE FROM papercusp_auth.hosted_budget_receipts
      WHERE reservation_id = ${grant.reservationId}`)).rejects.toMatchObject({ code: '42501' });
    expect(await read(scope)).toHaveLength(1);
  });

  it('does not bind an uncommitted or rolled-back admission and succeeds only after its durable commit', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope);
    let ready!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const b = { ...captured(scope), budgetGrant: { ...grant, reservationId: randomUUID() } };
    const sentinel = new Error('fixture admission rollback');
    const pending = runService(async sql => {
      await sql`INSERT INTO papercusp_auth.hosted_budget_receipts
        SELECT control_workspace_id, organization_id, customer_workspace_id, ${b.budgetGrant.reservationId},
          ${'admission:' + b.budgetGrant.reservationId}, revision, month, budget_key, maximum_cost_micros,
          provider_limit_ref, request_hash, policy_id, policy_revision, observed_at_ms, cost_source,
          cost_micros, provider_final, evidence_ref, received_at
        FROM papercusp_auth.hosted_budget_receipts WHERE reservation_id = ${grant.reservationId} AND revision = 0`;
      ready(); await released; throw sentinel;
    }).catch(error => { if (error !== sentinel) throw error; });
    try {
      await Promise.race([started, pending]);
      expect(await store().bindOpenRouterGeneration(b)).toBe('replay-mismatch');
    } finally { release(); await pending; }
    expect(await store().bindOpenRouterGeneration(b)).toBe('replay-mismatch');
    const actual = { ...captured(scope), budgetGrant: grant };
    expect(await store().bindOpenRouterGeneration(actual)).toBe('recorded');
  });

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
    const a = await tenant(randomUUID(), randomUUID(), 'deleted'); const otherOrg = await tenant(a.controlWorkspaceId);
    // Preserve the real one-live-workspace guard. A historical deleted row is
    // enough to exercise same-org foreign-workspace binding reads.
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
  it('bounds provider-read batches and rotates oldest observations without asserting full census', async () => {
    const scope = await tenant();
    const population = Array.from({ length: 27 }, () => captured(scope));
    for (const b of population) expect(await store().bindOpenRouterGeneration(b)).toBe('recorded');
    const first = await bindings(scope); expect(first).toHaveLength(25);
    const seen = new Set(first.map(b => b.generationId));
    const missing = population.filter(b => !seen.has(b.generationId)).map(b => b.generationId).sort();
    expect(missing).toHaveLength(2);
    for (const b of first) expect(await store().append(openRouterUsageRecord(b, {
      data: { id: b.generationId, is_byok: b.isByok, total_cost: 0.001 },
    }))).toBe('recorded');
    const next = await bindings(scope, T + 2000); expect(next).toHaveLength(25);
    expect(next.slice(0, 2).map(b => b.generationId).sort()).toEqual(missing);
    expect(next.slice(0, 2).every(b => b.revision === 2)).toBe(true);
    expect(next.slice(2).every(b => b.revision === 3)).toBe(true);
  });
});
