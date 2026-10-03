/** Real Postgres/roles/transactions for hosted commitments (P-005). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';
import { PostgresHostedBudgetStore, type HostedBudgetContextReader, type HostedBudgetObservation,
  type HostedBudgetRequest, type HostedBudgetScope } from './budget-store';

const { createOrgTestDb } = await import('../../../../test/_org-test-db');
let db: OrgTestDb;
const T = Date.UTC(2026, 9, 2);
const service: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>) => db.appSql.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
  await tx.unsafe('SET LOCAL ROLE hosted_service');
  return fn(tx as unknown as Sql);
}) as Promise<T>;

// The production funding reader is not installed by this fixture. The fixture
// uses real locked rows to exercise the SAME-transaction authority contract;
// these grants are engineering inputs, not paid customer evidence.
const readContext: HostedBudgetContextReader = async (sql, input) => {
  const [row] = await sql<{ cap: number; funding: number; retained: number | null; workspace_cap: number | null }[]>`
    SELECT * FROM papercusp_auth.test_budget_authority
    WHERE control = ${input.scope.controlWorkspaceId} AND org = ${input.scope.organizationId} FOR UPDATE`;
  if (!row) return null;
  const limit = (customerWorkspaceId: string | null, cents: number) => ({ customerWorkspaceId,
    entitlements: { budgets: { [input.budgetKey]: Number(cents) } }, fundedMicros: Number(row.funding),
    externalSpentMicros: 0, retainedReserveMicros: row.retained === null ? null : Number(row.retained), unreconciled: false });
  const { startMs, endMs } = shadowMonthBounds(input.month);
  return { scope: input.scope, month: input.month, evidenceRef: 'fixture:verified-funding',
    policy: { policyId: 'fixture-policy', revision: 1, budgetKey: input.budgetKey,
      effectiveFromMs: startMs, effectiveUntilMs: endMs, warningBps: 8000 },
    limits: [limit(null, row.cap), ...(row.workspace_cap === null ? [] : [limit(input.scope.customerWorkspaceId, row.workspace_cap)])] };
};
const store = (reader: HostedBudgetContextReader = readContext, run = service) => new PostgresHostedBudgetStore({ readContext: reader, run });

async function tenant(controlWorkspaceId: string = randomUUID(), organizationId: string = randomUUID()): Promise<HostedBudgetScope> {
  const customerWorkspaceId = randomUUID();
  await db.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
    VALUES (${organizationId}::uuid, ${'budget-' + organizationId}, 'Budget fixture') ON CONFLICT DO NOTHING`;
  await db.adminSql`INSERT INTO harness_shared.workspace_host_connections (workspace_id, id, target, label, credential_ref, status)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, 'gcp', 'Budget fixture', 'delegation://fixture/gcp', 'connected')`;
  await db.adminSql`INSERT INTO harness_shared.workspace_hosts
    (workspace_id, id, name, connection_id, target, scope_label, region, size, image, disk_gib, network, desired_state, observed_state)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, 'Budget fixture', ${customerWorkspaceId}, 'gcp', 'fixture-project',
      'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')`;
  await db.adminSql`INSERT INTO harness_shared.customer_workspaces
    (workspace_id, id, organization_id, workspace_host_id, display_name, state, created_by_principal_kind, created_by_principal_id)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, ${organizationId}, ${customerWorkspaceId}, 'Budget fixture', 'active', 'user', 'fixture-user')`;
  await db.adminSql`INSERT INTO papercusp_auth.test_budget_authority (control, org, cap, funding, retained)
    VALUES (${controlWorkspaceId}, ${organizationId}, 10, 100000, 0) ON CONFLICT DO NOTHING`;
  return { controlWorkspaceId, organizationId, customerWorkspaceId };
}
const request = (scope: HostedBudgetScope, change: Partial<HostedBudgetRequest> = {}): HostedBudgetRequest => ({
  scope, reservationId: randomUUID(), month: '2026-10', budgetKey: 'consumption.usd_cents', maximumCostMicros: 100_000,
  providerLimitRef: 'fixture:enforced-limit', asOfMs: T, ...change,
});
const observation = (r: HostedBudgetRequest, change: Partial<HostedBudgetObservation> = {}): HostedBudgetObservation => ({
  scope: r.scope, reservationId: r.reservationId, eventId: randomUUID(), revision: 1, observedAtMs: T + 1,
  costSource: 'provider-billed', costMicros: 40_003, providerFinal: true, evidenceRef: 'fixture:final-bill', ...change,
});
const rows = (s: HostedBudgetScope) => db.adminSql`SELECT * FROM papercusp_auth.hosted_budget_receipts
  WHERE control_workspace_id = ${s.controlWorkspaceId} AND organization_id = ${s.organizationId}`;

describe('PostgresHostedBudgetStore (real hosted service transactions)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    const draft = new URL('../../../../../../libs/papercusp/libs/db/sql/1352-hosted-budget-reservations.sql.DRAFT', import.meta.url);
    const armed = new URL('../../../../../../libs/papercusp/libs/db/sql/1352-hosted-budget-reservations.sql', import.meta.url);
    let migration: string;
    try { migration = readFileSync(draft, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; migration = readFileSync(armed, 'utf8'); }
    await db.adminSql.unsafe(migration); await db.adminSql.unsafe(migration);
    const exactDraft = new URL('../../../../../../libs/papercusp/libs/db/sql/1356-hosted-budget-exact-micros.sql.DRAFT', import.meta.url);
    const exactArmed = new URL('../../../../../../libs/papercusp/libs/db/sql/1356-hosted-budget-exact-micros.sql', import.meta.url);
    let exactMigration: string;
    try { exactMigration = readFileSync(exactDraft, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exactMigration = readFileSync(exactArmed, 'utf8'); }
    await db.adminSql.unsafe(exactMigration); await db.adminSql.unsafe(exactMigration);
    await db.adminSql.unsafe(`CREATE TABLE papercusp_auth.test_budget_authority (
      control text NOT NULL, org text NOT NULL, cap bigint NOT NULL, funding bigint NOT NULL,
      retained bigint, workspace_cap bigint, PRIMARY KEY(control, org));
      GRANT SELECT, UPDATE ON papercusp_auth.test_budget_authority TO hosted_service`);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  it('dispatches exactly once across concurrent instances, only after the reservation commits', async () => {
    const s = await tenant(); const r = request(s); const launches: string[] = [];
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => store().executeOnce(r, async grant => {
      // A separate connection sees the admission, proving commit-before-I/O.
      expect(await rows(s)).toHaveLength(1);
      expect(grant).toMatchObject({ reservationId: r.reservationId, maximumCostMicros: 100_000,
        providerLimitRef: r.providerLimitRef, policyId: 'fixture-policy', policyRevision: 1 });
      expect(Object.isFrozen(grant)).toBe(true); expect(Object.isFrozen(grant.scope)).toBe(true);
      launches.push(grant.reservationId); return 'provider-operation';
    })));
    expect(launches).toEqual([r.reservationId]);
    expect(outcomes.filter(o => o.execution === 'dispatched')).toHaveLength(1);
    expect(outcomes.filter(o => o.execution === 'not-started' && o.reservation.outcome === 'duplicate')).toHaveLength(11);
    expect(outcomes.find(o => o.execution === 'dispatched')?.value).toBe('provider-operation');
  });

  it('keeps the launch fence and full hold after a provider starts but its response is lost', async () => {
    const s = await tenant(); const r = request(s); let launches = 0;
    await expect(store().executeOnce(r, async () => { launches++; throw new Error('lost provider response'); }))
      .rejects.toThrow('lost provider response');
    const retry = await store().executeOnce(r, async () => { launches++; });
    expect(retry.execution).toBe('not-started'); expect(retry.reservation.outcome).toBe('duplicate');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    expect(launches).toBe(1); expect(await rows(s)).toHaveLength(1);
  });

  it('never treats an orphaned admission or a final zero bill as permission to dispatch again', async () => {
    const s = await tenant(); const r = request(s); let launches = 0;
    // Crash after commit, before any network I/O; a successor cannot know that.
    await store().reserve(r);
    expect((await store().executeOnce(r, async () => { launches++; })).execution).toBe('not-started');
    await store().observe(observation(r, { costMicros: 0 }));
    expect((await store().executeOnce(r, async () => { launches++; })).execution).toBe('not-started');
    // A separately admitted operation may use the released funding.
    expect((await store().executeOnce(request(s), async () => { launches++; })).execution).toBe('dispatched');
    expect(launches).toBe(1);
  });

  it('does not dispatch refused, conflicting, cross-workspace or unconfigured requests', async () => {
    const s = await tenant(); const r = request(s); let launches = 0;
    const execute = async () => { launches++; };
    expect((await new PostgresHostedBudgetStore({ run: service }).executeOnce(r, execute)).execution).toBe('not-started');
    expect((await store().executeOnce({ ...r, maximumCostMicros: 100_001 }, execute)).reservation.outcome).toBe('refused');
    await store().reserve(r);
    expect((await store().executeOnce({ ...r, providerLimitRef: 'fixture:other-limit' }, execute)).reservation.outcome).toBe('conflict');
    const foreign = { ...r, scope: { ...s, customerWorkspaceId: randomUUID() } };
    expect((await store().executeOnce(foreign, execute)).execution).toBe('not-started');
    expect(launches).toBe(0);
  });

  it('does not call the provider before a failed commit and permits a subsequent successful admission', async () => {
    const s = await tenant(); const r = request(s); let launches = 0;
    const execute = async () => { launches++; };
    const crashing: HostedServiceContextRunner = fn => service(async sql => { await fn(sql); throw new Error('commit failed'); });
    await expect(store(readContext, crashing).executeOnce(r, execute)).rejects.toThrow('commit failed');
    expect(launches).toBe(0); expect(await rows(s)).toHaveLength(0);
    expect((await store().executeOnce(r, execute)).execution).toBe('dispatched');
    expect(launches).toBe(1);
  });

  it('dispatches the frozen admitted binding even if the caller mutates its request during admission', async () => {
    const s = await tenant(); const r = request(s);
    const original = { ...r, scope: { ...s } };
    const mutating: HostedBudgetContextReader = async (sql, input) => {
      Object.assign(r, { maximumCostMicros: 1, providerLimitRef: 'fixture:changed' });
      Object.assign(r.scope, { customerWorkspaceId: randomUUID() });
      return readContext(sql, input);
    };
    const result = await store(mutating).executeOnce(r, async grant => {
      expect(grant).toMatchObject({ scope: original.scope, maximumCostMicros: original.maximumCostMicros,
        providerLimitRef: original.providerLimitRef });
      return grant.reservationId;
    });
    expect(result.execution).toBe('dispatched'); expect(result.value).toBe(original.reservationId);
  });

  it('retains exposure and refuses redispatch after an actual streaming cancellation', async () => {
    const s = await tenant(); const r = request(s); let cancellations = 0; let launches = 0;
    const first = await store().executeOnce(r, async () => {
      launches++;
      return new ReadableStream<string>({ start(controller) { controller.enqueue('partial output'); },
        cancel() { cancellations++; } });
    });
    expect(first.execution).toBe('dispatched');
    const reader = first.value!.getReader(); expect((await reader.read()).value).toBe('partial output');
    await reader.cancel(); expect(cancellations).toBe(1);
    await store().observe(observation(r, { costSource: 'provider-reported', costMicros: 0, providerFinal: false }));
    expect((await store().executeOnce(r, async () => { launches++; })).execution).toBe('not-started');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    expect(launches).toBe(1);
  });

  it('serializes parallel work across separate store instances at the exact organization cap', async () => {
    const s = await tenant();
    const outcomes = await Promise.all(Array.from({ length: 15 }, () => store().reserve(request(s, { maximumCostMicros: 10_000 }))));
    expect(outcomes.filter(r => r.outcome === 'reserved')).toHaveLength(10);
    expect(outcomes.filter(r => r.outcome === 'refused')).toHaveLength(5);
    expect(await rows(s)).toHaveLength(10);
  });

  it('deduplicates a lost-response retry after restart and refuses changed request bindings', async () => {
    const s = await tenant(); const r = request(s);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().reserve(r)));
    expect(outcomes.filter(o => o.outcome === 'reserved')).toHaveLength(1);
    expect(outcomes.filter(o => o.outcome === 'duplicate')).toHaveLength(7);
    expect((await store().reserve({ ...r, asOfMs: T + 100 })).outcome).toBe('duplicate');
    expect((await store().reserve({ ...r, maximumCostMicros: 1 })).outcome).toBe('conflict');
    expect((await store().reserve({ ...r, providerLimitRef: 'fixture:different-limit' })).outcome).toBe('conflict');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    expect(await rows(s)).toHaveLength(1);
  });

  it('retains cancelled/unpriced/incomplete holds, then settles/replays a final bill and replaces a correction', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    expect((await store().observe(observation(r, { costSource: 'unpriced', costMicros: null, providerFinal: false }))).outcome).toBe('recorded');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    await store().observe(observation(r, { revision: 2, costSource: 'provider-reported', costMicros: 0, providerFinal: false }));
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    const final = observation(r, { revision: 3 });
    expect((await store().observe(final)).outcome).toBe('recorded');
    expect((await store().observe(final)).outcome).toBe('duplicate');
    expect((await store().reserve(request(s, { maximumCostMicros: 59_998 }))).outcome).toBe('refused');
    await store().observe(observation(r, { revision: 4, observedAtMs: T + 2, costMicros: 60_001 }));
    expect((await store().reserve(request(s, { maximumCostMicros: 39_999 }))).outcome).toBe('reserved');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
  });

  it('aggregates fractional final liabilities without flooring each bill or over-rounding each hold', async () => {
    const s = await tenant();
    for (const exact of ['0.4', '0.6', '0.0000000000000000001']) {
      const r = request(s, { maximumCostMicros: 1 });
      expect((await store().reserve(r)).outcome).toBe('reserved');
      await store().observe(observation(r, { costMicros: 0, costMicrosExact: exact }));
    }
    const refused = await store().reserve(request(s, { maximumCostMicros: 99_999 }));
    expect(refused.outcome).toBe('refused');
    expect(refused.decisions[0]).toMatchObject({ availableMicros: 99_998, availableMicrosExact: '99998.9999999999999999999' });
    expect((await store().reserve(request(s, { maximumCostMicros: 99_998 }))).outcome).toBe('reserved');
  });

  it('persists exact amounts across restarts, replaces corrections and rejects changed fractional replays', async () => {
    const s = await tenant(); const r = request(s, { maximumCostMicros: 1 }); await store().reserve(r);
    const first = observation(r, { costMicros: 0, costMicrosExact: '0.1234567890123456789' });
    expect((await store().observe(first)).receipt?.costMicrosExact).toBe(first.costMicrosExact);
    expect((await store().observe(first)).outcome).toBe('duplicate');
    expect((await store().observe({ ...first, costMicrosExact: '0.1234567890123456788' })).outcome).toBe('conflict');
    const [saved] = await db.adminSql`SELECT cost_micros::text AS exact FROM papercusp_auth.hosted_budget_receipts
      WHERE organization_id = ${s.organizationId} AND revision = 1`;
    expect(saved?.exact).toBe(first.costMicrosExact);
    await store().observe(observation(r, { revision: 2, observedAtMs: T + 2, costMicros: 0, costMicrosExact: '0.2' }));
    const next = await store().reserve(request(s, { maximumCostMicros: 99_999 }));
    expect(next.outcome).toBe('reserved'); expect(next.decisions[0]?.availableMicrosExact).toBe('99999.8');
  });

  it('retains pending fractional reports and suspends even submicro old-month overruns', async () => {
    const s = await tenant(); const r = request(s, { maximumCostMicros: 1, month: '2026-09', asOfMs: Date.UTC(2026, 8, 2) });
    await store().reserve(r);
    const report = observation(r, { costSource: 'provider-reported', costMicros: 0, costMicrosExact: '0.1', providerFinal: false });
    expect((await store().observe(report)).settlement).toMatchObject({ state: 'pending', heldMicros: 1, releasedMicros: 0 });
    expect((await store().reserve(request(s, { maximumCostMicros: 100_000 }))).outcome).toBe('refused');
    const overrun = await store().observe(observation(r, { revision: 2, observedAtMs: T + 2,
      costMicros: 1, costMicrosExact: '1.0000000000000000001' }));
    expect(overrun.settlement).toMatchObject({ overrunMicros: 0, overrunMicrosExact: '0.0000000000000000001', suspend: true });
    expect((await store().reserve(request(s, { maximumCostMicros: 0 }))).decisions[0]?.reason).toBe('unreconciled-charge');
  });

  it('accounts for exact external liabilities and net window funding from the locked authority reader', async () => {
    const s = await tenant();
    const fractional: HostedBudgetContextReader = async (sql, input) => {
      const ctx = (await readContext(sql, input))!;
      return { ...ctx, limits: ctx.limits.map(limit => ({ ...limit, fundedMicros: 99_999,
        fundedMicrosExact: '99999.9', externalSpentMicros: 0, externalSpentMicrosExact: '0.1' })) };
    };
    const refused = await store(fractional).reserve(request(s, { maximumCostMicros: 100_000 }));
    expect(refused.decisions[0]).toMatchObject({ capMicros: 99_999, capMicrosExact: '99999.9', availableMicros: 99_999, availableMicrosExact: '99999.8' });
    expect((await store(fractional).reserve(request(s, { maximumCostMicros: 99_999 }))).outcome).toBe('reserved');
  });

  it('rejects invalid exact projections before changing immutable reservation history', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    for (const costMicrosExact of ['0.1', '40003.00', '40003e0', '-1', '9007199254740991.1']) {
      await expect(store().observe(observation(r, { costMicrosExact }))).rejects.toThrow(/budget/);
    }
    await expect(store().observe(observation(r, { costSource: 'unpriced', costMicros: null, costMicrosExact: '0.1', providerFinal: false })))
      .rejects.toThrow(/budget/);
    expect(await rows(s)).toHaveLength(1);
  });

  it('enforces lossless NUMERIC precision at the database boundary without changing integer provider maxima', async () => {
    const s = await tenant(); const r = request(s, { maximumCostMicros: 1 }); await store().reserve(r);
    const [column] = await db.adminSql`SELECT data_type, numeric_scale FROM information_schema.columns
      WHERE table_schema = 'papercusp_auth' AND table_name = 'hosted_budget_receipts' AND column_name = 'cost_micros'`;
    expect(column).toMatchObject({ data_type: 'numeric', numeric_scale: null });
    for (const exact of ['-0.1', '9007199254740991.1', '0.' + '0'.repeat(324) + '1']) {
      const change = { revision: 1, event_id: randomUUID(), cost_source: 'provider-billed', provider_final: true, cost_micros: exact };
      await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_budget_receipts
        SELECT (jsonb_populate_record(NULL::papercusp_auth.hosted_budget_receipts, to_jsonb(row) || ${db.adminSql.json(change)})).*
        FROM papercusp_auth.hosted_budget_receipts row WHERE organization_id = ${s.organizationId}`)
        .rejects.toThrow(/check constraint/);
    }
    expect(await rows(s)).toHaveLength(1);
    const tiniest = '0.' + '0'.repeat(323) + '1';
    expect((await store().observe(observation(r, { costMicros: 0, costMicrosExact: tiniest }))).receipt?.costMicrosExact).toBe(tiniest);
    expect((await store().reserve(request(s, { maximumCostMicros: 100_000 }))).outcome).toBe('refused');
  });

  it('does not hide a final overrun, permit a downgrade, or erase exposure with a new budget key', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    const result = await store().observe(observation(r, { costMicros: 100_001 }));
    expect(result.settlement).toMatchObject({ chargedMicros: 100_001, overrunMicros: 1, suspend: true });
    const next = await store().reserve(request(s, { budgetKey: 'another.usd_cents', maximumCostMicros: 0 }));
    expect(next.outcome).toBe('refused');
    expect(next.decisions[0]?.reason).toBe('unreconciled-charge');
    await expect(store().observe(observation(r, { revision: 2, providerFinal: false }))).rejects.toThrow('downgrade');
    await expect(store().observe(observation(r, { revision: 2, costSource: 'estimate' }))).rejects.toThrow('downgrade');
  });

  it('serializes concurrent final-bill replays and corrections without double spend or lost revisions', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    const first = observation(r, { costMicros: 20_000 });
    const retries = await Promise.all(Array.from({ length: 8 }, () => store().observe(first)));
    expect(retries.filter(o => o.outcome === 'recorded')).toHaveLength(1);
    expect(retries.filter(o => o.outcome === 'duplicate')).toHaveLength(7);
    const corrections = await Promise.all([
      store().observe(observation(r, { revision: 2, observedAtMs: T + 2, costMicros: 40_000 })),
      store().observe(observation(r, { revision: 3, observedAtMs: T + 3, costMicros: 60_000 })),
    ]);
    expect(corrections.every(o => o.outcome === 'recorded' || o.outcome === 'stale')).toBe(true);
    const next = await store().reserve(request(s, { maximumCostMicros: 40_000 }));
    expect(next.outcome).toBe('reserved');
    expect(next.decisions[0]?.availableMicros).toBe(40_000);
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
  });

  it('keeps old-month unfinished work reserved in the next window', async () => {
    const s = await tenant(); await store().reserve(request(s, { month: '2026-09', asOfMs: Date.UTC(2026, 8, 2) }));
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
  });

  it('applies workspace limits while sharing the organization cap across workspaces', async () => {
    const a = await tenant();
    // Preserve the directory's one-live-workspace invariant. Financial holds
    // survive retirement while its successor uses the same organization cap.
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
      WHERE workspace_id = ${a.controlWorkspaceId} AND id = ${a.customerWorkspaceId}`;
    const b = await tenant(a.controlWorkspaceId, a.organizationId);
    await db.adminSql`UPDATE papercusp_auth.test_budget_authority SET workspace_cap = 2 WHERE org = ${a.organizationId}`;
    expect((await store().reserve(request(a, { maximumCostMicros: 20_001 }))).outcome).toBe('refused');
    expect((await store().reserve(request(a, { maximumCostMicros: 20_000 }))).outcome).toBe('reserved');
    expect((await store().reserve(request(a, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    expect((await store().reserve(request(b, { maximumCostMicros: 20_000 }))).outcome).toBe('reserved');
    await db.adminSql`UPDATE papercusp_auth.test_budget_authority SET workspace_cap = NULL WHERE org = ${a.organizationId}`;
    expect((await store().reserve(request(b, { maximumCostMicros: 60_000 }))).outcome).toBe('reserved');
  });

  it('separates overlapping reservation/event IDs in distinct organization/control scopes', async () => {
    const a = await tenant(); const b = await tenant(a.controlWorkspaceId); const c = await tenant(undefined, a.organizationId);
    const id = randomUUID();
    for (const s of [a, b, c]) expect((await store().reserve(request(s, { reservationId: id }))).outcome).toBe('reserved');
    const eventId = randomUUID();
    for (const s of [a, b, c]) expect((await store().observe(observation(request(s, { reservationId: id }), { eventId }))).outcome).toBe('recorded');
    const foreign = { ...a, customerWorkspaceId: b.customerWorkspaceId };
    expect((await store().observe(observation(request(foreign, { reservationId: id })))).outcome).toBe('unknown');
    expect((await store().reserve(request(foreign, { reservationId: id }))).receipt).toBeNull();
  });

  it('rolls back the admission receipt on transaction failure and permits a fresh retry', async () => {
    const s = await tenant(); const r = request(s);
    const crashing: HostedServiceContextRunner = fn => service(async sql => { await fn(sql); throw new Error('fixture crash before commit'); });
    await expect(store(readContext, crashing).reserve(r)).rejects.toThrow('before commit');
    expect(await rows(s)).toHaveLength(0);
    expect((await store().reserve(r)).outcome).toBe('reserved');
  });

  it('uses the same transaction lock as the DB guard before reading funding, and refuses reduced funding', async () => {
    const s = await tenant();
    const checking: HostedBudgetContextReader = async (sql, r) => {
      const held = await db.adminSql.begin(async other => {
        const [row] = await other`SELECT pg_try_advisory_xact_lock(hashtextextended(
          json_build_array('hosted-budget', ${s.controlWorkspaceId}::text, ${s.organizationId}::text)::text, 0)) AS granted`;
        return row?.granted;
      });
      expect(held).toBe(false);
      return readContext(sql, r);
    };
    await store(checking).reserve(request(s, { maximumCostMicros: 60_000 }));
    await db.adminSql`UPDATE papercusp_auth.test_budget_authority SET funding = 50000 WHERE org = ${s.organizationId}`;
    expect((await store().reserve(request(s, { maximumCostMicros: 0 }))).outcome).toBe('refused');
  });

  it('fails closed without authority, on scope/period mismatch, or on unbounded retained costs', async () => {
    const s = await tenant();
    expect((await new PostgresHostedBudgetStore({ run: service }).reserve(request(s))).outcome).toBe('refused');
    const bad: HostedBudgetContextReader = async (sql, r) => ({ ...(await readContext(sql, r))!, scope: { ...s, organizationId: randomUUID() } });
    await expect(store(bad).reserve(request(s))).rejects.toThrow('context mismatch');
    const period: HostedBudgetContextReader = async (sql, r) => { const ctx = (await readContext(sql, r))!;
      return { ...ctx, policy: { ...ctx.policy, effectiveUntilMs: ctx.policy.effectiveUntilMs + 1 } }; };
    await expect(store(period).reserve(request(s))).rejects.toThrow('context mismatch');
    await db.adminSql`UPDATE papercusp_auth.test_budget_authority SET retained = NULL WHERE org = ${s.organizationId}`;
    expect((await store().reserve(request(s))).outcome).toBe('refused');
    expect(await rows(s)).toHaveLength(0);
  });

  it('rejects replay conflicts, out-of-order/downgraded observations and event collisions', async () => {
    const s = await tenant(); const r = request(s, { maximumCostMicros: 50_000 }); await store().reserve(r);
    const o = observation(r, { revision: 3, costMicros: 20_000 }); await store().observe(o);
    expect((await store().observe({ ...o, costMicros: 20_001 })).outcome).toBe('conflict');
    expect((await store().observe(observation(r, { revision: 2 }))).outcome).toBe('stale');
    expect((await store().observe(observation(r, { revision: 3 }))).outcome).toBe('conflict');
    const other = request(s, { maximumCostMicros: 50_000 }); await store().reserve(other);
    expect((await store().observe(observation(other, { eventId: o.eventId }))).outcome).toBe('conflict');
    expect(await rows(s)).toHaveLength(3);
  });

  it('protects metadata-only, immutable history and exact composite directory bindings at the database boundary', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_budget_receipts SET maximum_cost_micros = 1
      WHERE organization_id = ${s.organizationId}`).rejects.toThrow('append-only');
    await expect(db.adminSql`DELETE FROM papercusp_auth.hosted_budget_receipts WHERE organization_id = ${s.organizationId}`).rejects.toThrow('append-only');
    await expect(db.appSql`SELECT * FROM papercusp_auth.hosted_budget_receipts`).rejects.toThrow(/permission denied/);
    const changed = { revision: 1, event_id: randomUUID(), maximum_cost_micros: 1 };
    await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_budget_receipts
      SELECT (jsonb_populate_record(NULL::papercusp_auth.hosted_budget_receipts, to_jsonb(r) || ${db.adminSql.json(changed)})).*
      FROM papercusp_auth.hosted_budget_receipts r WHERE organization_id = ${s.organizationId}`).rejects.toThrow('history conflict');
    const unadmitted = { revision: 1, event_id: randomUUID(), reservation_id: randomUUID() };
    await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_budget_receipts
      SELECT (jsonb_populate_record(NULL::papercusp_auth.hosted_budget_receipts, to_jsonb(r) || ${db.adminSql.json(unadmitted)})).*
      FROM papercusp_auth.hosted_budget_receipts r WHERE organization_id = ${s.organizationId}`).rejects.toThrow('needs an admission');
    await expect(store().reserve({ ...request(s), customerContent: 'private' } as HostedBudgetRequest)).rejects.toThrow('invalid budget request');
    const foreign = { ...s, customerWorkspaceId: randomUUID() };
    await expect(store().reserve(request(foreign, { maximumCostMicros: 0 }))).rejects.toThrow(/foreign key/);
    expect(await rows(s)).toHaveLength(1);
  });
});
