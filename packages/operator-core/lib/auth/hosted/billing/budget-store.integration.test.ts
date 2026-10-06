/** Real Postgres/roles/transactions for hosted commitments (P-005). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';
import { journalEntryForMovement } from '../../../cupboard/money-journal';
import { receiptCommitment } from '../../../cupboard/payment-receipt';
import type { HostedPrepaidFundingInput } from './budget-funding';
import { PostgresHostedBudgetStore, type HostedBudgetContextReader, type HostedBudgetObservation,
  type HostedBudgetRequest, type HostedBudgetScope, type HostedPrepaidAllocationRequest, type HostedPrepaidFundingReader,
  evaluateLockedHostedPrepaidFunding, readLockedHostedPrepaidAllocations } from './budget-store';

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

const prepaidRequest = (s: HostedBudgetScope, stripeAccountId = 'acct_' + randomUUID().replaceAll('-', '')): HostedPrepaidAllocationRequest => ({
  scope: s, stripeAccountId, month: '2026-10', asOfMs: T,
  allocation: { allocationId: randomUUID(), paymentTransactionId: 'txn_source', organizationId: s.organizationId,
    customerWorkspaceId: s.customerWorkspaceId, budgetKey: 'consumption.usd_cents', micros: 100_000 },
});
// Authenticated-source-shaped fixture, not a production verifier. The real
// callback must read Stripe/bank/provider/journal/entitlement evidence itself.
function prepaidEvidence(r: HostedPrepaidAllocationRequest, grossCents = 100): Omit<HostedPrepaidFundingInput, 'allocations'> {
  const transaction = { id: r.allocation.paymentTransactionId, amount: grossCents, fee: 0, currency: 'usd', created: T / 1000 };
  const built = journalEntryForMovement({ entryId: 'stripe-bt:' + transaction.id, occurredAtMs: T, currency: 'USD',
    externalRef: { kind: 'stripe-balance-transaction', id: transaction.id },
    movement: { kind: 'credit-purchase', grossCents, feeCents: 0, taxCents: 0 } });
  if (!built.ok) throw new Error(built.detail);
  const salt = 'a'.repeat(64);
  return { scope: r.scope, budgetKey: r.allocation.budgetKey, windowStartMs: shadowMonthBounds(r.month).startMs, asOfMs: r.asOfMs,
    snapshot: { controlWorkspaceId: r.scope.controlWorkspaceId, organizationId: r.scope.organizationId,
      stripeAccountId: r.stripeAccountId, stripeCustomerId: 'cus_A', livemode: true, complete: true,
      asOfMs: r.asOfMs, evidenceRef: 'fixture:source-census' },
    payments: [{ entry: built.entry, available: true, receipt: { transaction, receiptSeq: 1, salt,
      commitment: receiptCommitment(transaction, salt), sourceId: 'ch_fixture', sourceCustomer: 'cus_A' } }],
    reversals: [], priorCharges: [], cashBacking: { controlWorkspaceId: r.scope.controlWorkspaceId, stripeAccountId: r.stripeAccountId,
      asOfMs: r.asOfMs, livemode: true, complete: true, evidenceRef: 'fixture:cash-census', journalEntries: [built.entry],
      availableMicros: grossCents * 10_000, unpaidProviderMicros: 0, retainedReserveMicros: 0 } };
}
const prepaidStore = (reader: HostedPrepaidFundingReader = async (_sql, r) => prepaidEvidence(r), run = service) =>
  new PostgresHostedBudgetStore({ readPrepaidFunding: reader, run });
const allocationRows = (account: string) => db.adminSql`SELECT * FROM papercusp_auth.hosted_prepaid_allocations
  WHERE stripe_account_id = ${account}`;

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
    const allocationDraft = new URL('../../../../../../libs/papercusp/libs/db/sql/1372-hosted-prepaid-allocations.sql.DRAFT', import.meta.url);
    const allocationArmed = new URL('../../../../../../libs/papercusp/libs/db/sql/1372-hosted-prepaid-allocations.sql', import.meta.url);
    let allocationMigration: string;
    try { allocationMigration = readFileSync(allocationDraft, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; allocationMigration = readFileSync(allocationArmed, 'utf8'); }
    await db.adminSql.unsafe(allocationMigration); await db.adminSql.unsafe(allocationMigration);
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

  it('refuses allocation without an installed verifier or with foreign/stale/insolvent evidence', async () => {
    const r = prepaidRequest(await tenant());
    expect(await new PostgresHostedBudgetStore({ run: service }).allocatePrepaid(r))
      .toMatchObject({ outcome: 'refused', reason: 'unconfigured-funding' });
    for (const change of [
      (e: ReturnType<typeof prepaidEvidence>) => ({ ...e, snapshot: { ...e.snapshot, complete: false } }),
      (e: ReturnType<typeof prepaidEvidence>) => ({ ...e, snapshot: { ...e.snapshot, asOfMs: T - 1 } }),
      (e: ReturnType<typeof prepaidEvidence>) => ({ ...e, cashBacking: null }),
    ]) expect((await prepaidStore(async (_sql, q) => change(prepaidEvidence(q))).allocatePrepaid(r)).outcome).toBe('refused');
    await expect(prepaidStore(async (_sql, q) => ({ ...prepaidEvidence(q), scope: { ...q.scope, organizationId: randomUUID() } }))
      .allocatePrepaid(r)).rejects.toThrow('authority mismatch');
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(0);
  });

  it('serializes concurrent exact partitions across instances and every budget key', async () => {
    const r = prepaidRequest(await tenant());
    const outcomes = await Promise.all(Array.from({ length: 16 }, (_, i) => prepaidStore().allocatePrepaid({ ...r,
      allocation: { ...r.allocation, allocationId: randomUUID(), budgetKey: i % 2 ? 'storage.usd_cents' : r.allocation.budgetKey } })));
    expect(outcomes.filter(o => o.outcome === 'allocated')).toHaveLength(10);
    expect(outcomes.filter(o => o.outcome === 'refused' && o.reason === 'funding-overallocated')).toHaveLength(6);
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(10);
  });

  it('keeps fractional partitions lossless through replay/restart and refuses the smallest excess', async () => {
    const r = prepaidRequest(await tenant());
    const precise = { ...r, allocation: { ...r.allocation, micros: 9_999, microsExact: '9999.9999999999999999999' } };
    const oneCent: HostedPrepaidFundingReader = async (_sql, q) => prepaidEvidence(q, 1);
    expect((await prepaidStore(oneCent).allocatePrepaid(precise)).outcome).toBe('allocated');
    expect(await prepaidStore(oneCent).allocatePrepaid(precise)).toMatchObject({ outcome: 'duplicate', allocation: precise.allocation });
    expect(await prepaidStore(oneCent).allocatePrepaid({ ...precise, allocation: { ...precise.allocation,
      microsExact: '9999.9999999999999999998' } })).toMatchObject({ outcome: 'conflict', allocation: null });
    const extra = { ...r, allocation: { ...r.allocation, allocationId: randomUUID(), micros: 0, microsExact: '0.0000000000000000002' } };
    expect(await prepaidStore(oneCent).allocatePrepaid(extra)).toMatchObject({ outcome: 'refused', reason: 'funding-overallocated' });
    const [saved] = await allocationRows(r.stripeAccountId);
    expect(String(saved!.micros)).toBe(precise.allocation.microsExact);
  });

  it('retains other organizations in the global population and refuses reuse of their payment', async () => {
    const a = await tenant(); const b = await tenant(a.controlWorkspaceId);
    const r = prepaidRequest(a);
    expect((await prepaidStore().allocatePrepaid(r)).outcome).toBe('allocated');
    const foreign = { ...prepaidRequest(b, r.stripeAccountId), allocation: { ...r.allocation, allocationId: randomUUID(),
      organizationId: b.organizationId, customerWorkspaceId: b.customerWorkspaceId } };
    expect(await prepaidStore().allocatePrepaid(foreign)).toMatchObject({ outcome: 'refused', reason: 'funding-scope-mismatch' });
    expect(await prepaidStore().allocatePrepaid({ ...foreign, allocation: { ...foreign.allocation, allocationId: r.allocation.allocationId } }))
      .toMatchObject({ outcome: 'conflict', allocation: null });
    const ownPayment = { ...foreign, allocation: { ...foreign.allocation, paymentTransactionId: 'txn_other' } };
    const fullPool: HostedPrepaidFundingReader = async (_sql, q) => {
      const e = prepaidEvidence(q); const other = prepaidEvidence(r);
      return { ...e, cashBacking: { ...e.cashBacking!, availableMicros: 2_000_000,
        journalEntries: [...e.cashBacking!.journalEntries, ...other.cashBacking!.journalEntries] } };
    };
    expect((await prepaidStore(fullPool).allocatePrepaid(ownPayment)).outcome).toBe('allocated');
    await service(async sql => { const all = await readLockedHostedPrepaidAllocations(sql,
      { controlWorkspaceId: a.controlWorkspaceId, stripeAccountId: r.stripeAccountId });
      expect(all).toHaveLength(2); expect(Object.isFrozen(all)).toBe(true); expect(all.every(Object.isFrozen)).toBe(true); });
  });

  it('locks even an empty pool before collecting source evidence, with the identical database writer key', async () => {
    const r = prepaidRequest(await tenant());
    const reader: HostedPrepaidFundingReader = async (_sql, q) => {
      const held = await db.adminSql.begin(async other => {
        const [row] = await other`SELECT pg_try_advisory_xact_lock(hashtextextended(
          json_build_array('hosted-prepaid', ${q.stripeAccountId}::text)::text, 0)) AS granted`;
        return row?.granted;
      });
      expect(held).toBe(false);
      expect(await allocationRows(q.stripeAccountId)).toHaveLength(0);
      return prepaidEvidence(q);
    };
    expect((await prepaidStore(reader).allocatePrepaid(r)).outcome).toBe('allocated');
  });

  it('reads funding and writes a reservation under the same pool lock and transaction', async () => {
    const s = await tenant(); const r = prepaidRequest(s);
    expect((await prepaidStore().allocatePrepaid(r)).outcome).toBe('allocated');
    const context: HostedBudgetContextReader = async (sql, q) => {
      const funding = await evaluateLockedHostedPrepaidFunding(sql, prepaidEvidence(r));
      if (!funding.ok) return null;
      const [lock] = await db.adminSql.begin(other => other`SELECT pg_try_advisory_xact_lock(hashtextextended(
        json_build_array('hosted-prepaid', ${r.stripeAccountId}::text)::text, 0)) AS granted`);
      expect(lock?.granted).toBe(false);
      expect(await rows(s)).toHaveLength(0);
      const c = (await readContext(sql, q))!;
      return { ...c, limits: c.limits.map(l => ({ ...l, ...funding.organization })) };
    };
    const crashing: HostedServiceContextRunner = fn => service(async sql => { await fn(sql); throw new Error('atomic reservation rollback'); });
    await expect(store(context, crashing).reserve(request(s))).rejects.toThrow('atomic reservation rollback');
    expect(await rows(s)).toHaveLength(0);
    expect((await store(context).reserve(request(s))).outcome).toBe('reserved');
    expect(await rows(s)).toHaveLength(1);
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(1);
  });

  it('never accepts a caller replacement population or hides a formerly allocated payment after a reversal', async () => {
    const r = prepaidRequest(await tenant());
    const all = { ...r, allocation: { ...r.allocation, micros: 1_000_000, customerWorkspaceId: null } };
    expect((await prepaidStore().allocatePrepaid(all)).outcome).toBe('allocated');
    await service(async sql => {
      const e = prepaidEvidence(r);
      const transaction = { id: 'txn_refund', amount: -50, fee: 0, currency: 'usd', created: T / 1000 };
      const built = journalEntryForMovement({ entryId: 'stripe-bt:txn_refund', occurredAtMs: T, currency: 'USD',
        externalRef: { kind: 'stripe-balance-transaction', id: transaction.id },
        movement: { kind: 'refund', amountCents: 50, taxCents: 0 } });
      if (!built.ok) throw new Error(built.detail);
      const salt = 'b'.repeat(64);
      const refunded = { ...e, reversals: [{ entry: built.entry, paymentTransactionId: r.allocation.paymentTransactionId,
        receipt: { transaction, receiptSeq: 2, salt, commitment: receiptCommitment(transaction, salt), sourceId: 're_fixture', sourceCustomer: 'cus_A' } }],
        cashBacking: { ...e.cashBacking!, availableMicros: 500_000, journalEntries: [...e.cashBacking!.journalEntries, built.entry] } };
      expect(await evaluateLockedHostedPrepaidFunding(sql, { ...refunded, allocations: [] } as typeof refunded))
        .toMatchObject({ ok: false, reason: 'funding-overallocated' });
    });
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(1);
  });

  it('rolls back allocations atomically and snapshots mutable requests before waiting for authority', async () => {
    const r = prepaidRequest(await tenant()); const original = structuredClone(r);
    const crashing: HostedServiceContextRunner = fn => service(async sql => { await fn(sql); throw new Error('allocation rollback'); });
    await expect(prepaidStore(undefined, crashing).allocatePrepaid(r)).rejects.toThrow('allocation rollback');
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(0);
    const mutating: HostedPrepaidFundingReader = async (_sql, q) => {
      Object.assign(r.allocation, { micros: 1, paymentTransactionId: 'txn_changed' });
      Object.assign(r.scope, { customerWorkspaceId: randomUUID() });
      return prepaidEvidence(q);
    };
    expect(await prepaidStore(mutating).allocatePrepaid(r)).toMatchObject({ outcome: 'allocated', allocation: original.allocation });
    expect(await allocationRows(original.stripeAccountId)).toHaveLength(1);
  });

  it('enforces service-only immutable exact partitions and global account/organization scope at the SQL boundary', async () => {
    const s = await tenant(); const r = prepaidRequest(s); await prepaidStore().allocatePrepaid(r);
    await expect(db.appSql`SELECT * FROM papercusp_auth.hosted_prepaid_allocations`).rejects.toThrow(/permission denied/);
    await expect(service(sql => sql`UPDATE papercusp_auth.hosted_prepaid_allocations SET micros = 1`)).rejects.toThrow(/permission denied/);
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_prepaid_allocations SET micros = 1 WHERE stripe_account_id = ${r.stripeAccountId}`)
      .rejects.toThrow('append-only');
    await expect(db.adminSql`DELETE FROM papercusp_auth.hosted_prepaid_allocations WHERE stripe_account_id = ${r.stripeAccountId}`)
      .rejects.toThrow('append-only');
    const other = await tenant(s.controlWorkspaceId);
    for (const change of [
      { allocation_id: randomUUID(), organization_id: other.organizationId, customer_workspace_id: other.customerWorkspaceId },
      { allocation_id: randomUUID(), control_workspace_id: randomUUID() },
      { allocation_id: randomUUID(), micros: '0.' + '0'.repeat(324) + '1', payment_transaction_id: 'txn_precision' },
      { allocation_id: randomUUID(), customer_workspace_id: null, binding_customer_workspace_id: randomUUID(), payment_transaction_id: 'txn_unbound' },
    ]) await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_prepaid_allocations
      SELECT (jsonb_populate_record(NULL::papercusp_auth.hosted_prepaid_allocations, to_jsonb(a) || ${db.adminSql.json(change)})).*
      FROM papercusp_auth.hosted_prepaid_allocations a WHERE stripe_account_id = ${r.stripeAccountId}`).rejects.toThrow();
    const unbound = { ...r, stripeAccountId: 'acct_' + randomUUID().replaceAll('-', ''), scope: { ...s, customerWorkspaceId: randomUUID() },
      allocation: { ...r.allocation, customerWorkspaceId: null } };
    await expect(prepaidStore().allocatePrepaid(unbound)).rejects.toThrow(/foreign key/);
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(1);
  });
});
