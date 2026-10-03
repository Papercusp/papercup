/**
 * agent-economy-flywheel-2026-08-30 P-042 / R-30, integration layer: the money
 * journal on real Postgres (migration 1286) with the P-040 hash chain.
 *
 * Real: Postgres with every migration applied, the store, the database guards,
 * the ledger_chain_links stream. Substituted: nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { pgLedgerChainLinkStore, verifyLedger } from './ledger-chain';
import {
  MICROS_PER_CENT,
  journalEntryForMovement,
  rollupInvariant,
  trialBalance,
  type ExternalRef,
  type MoneyMovement,
} from './money-journal';
import {
  accrueUsageMicros,
  moneyJournalLedgerSource,
  postMoneyJournalEntry,
  readMicrosRollup,
  readMoneyJournalEntries,
  settleUsageRollup,
  type MoneyJournalStoreDeps,
} from './money-journal-store';

const WS = 'ws-p042-money-journal';
let db: OrgTestDb;
let deps: MoneyJournalStoreDeps;

const chainRef = (n: number): ExternalRef => ({ kind: 'chain-tx', chainId: 84532, txHash: `0x${n.toString(16).padStart(64, '0')}` });

function entryFor(entryId: string, movement: MoneyMovement, externalRef: ExternalRef, occurredAtMs = 1_790_000_000_000) {
  const built = journalEntryForMovement({ entryId, occurredAtMs, currency: 'USD', externalRef, movement });
  if (!built.ok) throw new Error(`${built.code}: ${built.detail}`);
  return built.entry;
}

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 6 });
  let migration: string;
  try { migration = readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1354-hosted-usage-exact-micros.sql.DRAFT', import.meta.url), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    migration = readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1354-hosted-usage-exact-micros.sql', import.meta.url), 'utf8');
  }
  await db.adminSql.unsafe(migration); await db.adminSql.unsafe(migration);
  deps = { sql: db.adminSql, ledgerChain: pgLedgerChainLinkStore(db.adminSql) };
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('money journal on Postgres (P-042, R-30)', () => {
  it('keeps exact residue in durable rollups under concurrent replay and settlement', async () => {
    const workspaceId = WS + '-exact';
    const rollupId = 'exact-decimal';
    const input = { workspaceId, rollupId, accrualId: 'decimal-a', micros: 4999, microsExact: '4999.6' };
    const deliveries = await Promise.all(Array.from({ length: 8 }, () => accrueUsageMicros(input, deps)));
    expect(deliveries.filter(r => r.ok && !r.duplicate)).toHaveLength(1);
    expect(deliveries.filter(r => r.ok && r.duplicate)).toHaveLength(7);
    expect(await accrueUsageMicros({ ...input, microsExact: '4999.7' }, deps)).toMatchObject({ ok: false, detail: 'accrual replay mismatch' });
    expect(await accrueUsageMicros({ ...input, accrualId: 'decimal-b', micros: 5000, microsExact: '5000.6' }, deps)).toMatchObject({ ok: true, totalMicrosExact: '10000.2' });
    const settle = { workspaceId, rollupId, entryId: 'exact-cent', occurredAtMs: 1_790_000_000_000, externalRef: chainRef(1234), daoBasisPoints: 0 };
    const results = await Promise.all([settleUsageRollup(settle, deps), settleUsageRollup(settle, deps)]);
    expect(results.filter(r => r.ok && !r.duplicate)).toHaveLength(1);
    const rollup = await readMicrosRollup(workspaceId, rollupId, deps);
    expect(rollup).toMatchObject({ totalMicros: 10000, totalMicrosExact: '10000.2', settledCents: 1, roundingMicros: 0, roundingMicrosExact: '0.2' });
    expect(rollupInvariant(await readMoneyJournalEntries(workspaceId, deps), rollup!).holds).toBe(true);
    expect(await verifyLedger(workspaceId, moneyJournalLedgerSource(workspaceId, deps), deps.ledgerChain!)).toMatchObject({ ok: true, unchainedCount: 0 });
    const other = await readMicrosRollup('other-workspace', rollupId, deps); expect(other).toBeNull();
    await expect(db.adminSql`UPDATE harness_shared.money_journal_rollups SET rounding_micros = 0.3 WHERE workspace_id = ${workspaceId} AND rollup_id = ${rollupId}`)
      .rejects.toMatchObject({ code: '23514' });
  });
  it('posts balanced entries for each movement, reads them back exactly, and is idempotent on entryId', async () => {
    const entries = [
      entryFor('pay-1', { kind: 'customer-payment', grossCents: 10_000, feeCents: 320, taxCents: 800, daoCents: 920, refundReserveCents: 100 }, { kind: 'stripe-balance-transaction', id: 'txn_1Pay' }),
      entryFor('cred-1', { kind: 'credit-purchase', grossCents: 2_000, feeCents: 88, taxCents: 0 }, { kind: 'stripe-balance-transaction', id: 'txn_1Cred' }),
      entryFor('ref-1', { kind: 'refund', amountCents: 500, taxCents: 40 }, { kind: 'stripe-balance-transaction', id: 'txn_1Ref' }),
      entryFor('prov-1', { kind: 'provider-payment', amountCents: 3_000 }, { kind: 'bank-transaction', id: 'BANK-2026-10-01-7' }),
      entryFor('dao-1', { kind: 'dao-transfer', amountCents: 900 }, chainRef(1)),
      entryFor('tax-1', { kind: 'tax-remittance', amountCents: 760 }, { kind: 'bank-transaction', id: 'BANK-2026-10-01-8' }),
    ];
    for (const entry of entries) {
      expect(await postMoneyJournalEntry({ workspaceId: WS, entry }, deps)).toMatchObject({ ok: true, duplicate: false });
    }
    const stored = await readMoneyJournalEntries(WS, deps);
    expect(stored).toEqual(entries);
    expect(trialBalance(stored).balanced).toBe(true);

    expect(await postMoneyJournalEntry({ workspaceId: WS, entry: entries[0] }, deps)).toMatchObject({ ok: true, duplicate: true });
    const altered = { ...entries[0]!, memo: 'different' };
    expect(await postMoneyJournalEntry({ workspaceId: WS, entry: altered }, deps)).toMatchObject({ ok: false, code: 'entry-id-conflict' });
    expect(await readMoneyJournalEntries(WS, deps)).toHaveLength(entries.length);
  });

  it('refuses an entry without its reference before touching the database', async () => {
    const { externalRef: _ref, ...noRef } = entryFor('noref', { kind: 'provider-payment', amountCents: 1 }, { kind: 'bank-transaction', id: 'B' });
    expect(await postMoneyJournalEntry({ workspaceId: WS, entry: noRef }, deps)).toMatchObject({ ok: false, code: 'missing-external-reference' });
    const [{ n }] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.money_journal_entries WHERE entry_id = 'noref'`;
    expect(n).toBe(0);
  });

  it('the database refuses an unbalanced or one-sided entry from a writer that bypasses the module, and refuses edits', async () => {
    await expect(
      db.adminSql.begin(async (tx) => {
        await tx`INSERT INTO harness_shared.money_journal_entries (workspace_id, entry_id, occurred_at, currency, movement, external_ref_kind, external_ref)
                 VALUES (${WS}, 'raw-unbalanced', now(), 'USD', 'provider-payment', 'bank-transaction', 'RAW-1')`;
        await tx`INSERT INTO harness_shared.money_journal_lines (workspace_id, entry_id, line_no, account, side, cents)
                 VALUES (${WS}, 'raw-unbalanced', 0, 'provider-cost', 'debit', 500), (${WS}, 'raw-unbalanced', 1, 'operating', 'credit', 499)`;
      }),
    ).rejects.toThrow(/unbalanced/);
    await expect(
      db.adminSql`INSERT INTO harness_shared.money_journal_entries (workspace_id, entry_id, occurred_at, currency, movement, external_ref_kind, external_ref)
                  VALUES (${WS}, 'raw-empty', now(), 'USD', 'provider-payment', 'bank-transaction', 'RAW-2')`,
    ).rejects.toThrow(/has no debit line/);
    await expect(
      db.adminSql`UPDATE harness_shared.money_journal_lines SET cents = cents + 1 WHERE workspace_id = ${WS} AND entry_id = 'pay-1'`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db.adminSql`INSERT INTO harness_shared.money_journal_lines (workspace_id, entry_id, line_no, account, side, cents)
                  VALUES (${WS}, 'pay-1', 9, 'revenue', 'credit', 1)`,
    ).rejects.toThrow(/unbalanced/);
  });

  it('micros roll up outside the journal; settlement moves whole cents in and keeps the residue, exactly', async () => {
    const rollupId = 'per-use:identity-A';
    for (const [i, micros] of [3_333, 3_333, 3_333, 1, 25_001, 4_999].entries()) {
      expect(await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: `nonce-${i}`, micros }, deps)).toMatchObject({ ok: true, duplicate: false });
    }
    // A replayed meter nonce is not double-counted.
    expect(await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: 'nonce-4', micros: 25_001 }, deps)).toMatchObject({ ok: true, duplicate: true, totalMicros: 40_000 });
    expect(await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: 'bad', micros: 1.5 }, deps)).toMatchObject({ ok: false, code: 'invalid-micros' });

    const settled = await settleUsageRollup(
      { workspaceId: WS, rollupId, entryId: 'settle-A-1', occurredAtMs: 1_790_000_100_000, externalRef: chainRef(2), daoBasisPoints: 1_000 },
      deps,
    );
    expect(settled).toMatchObject({ ok: true, settledCents: 4, roundingMicros: 0, duplicate: false });
    expect(await settleUsageRollup({ workspaceId: WS, rollupId, entryId: 'settle-A-1', occurredAtMs: 1_790_000_100_000, externalRef: chainRef(2), daoBasisPoints: 1_000 }, deps)).toMatchObject({ ok: true, duplicate: true, settledCents: 0 });

    await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: 'nonce-9', micros: 9_999 }, deps);
    expect(await settleUsageRollup({ workspaceId: WS, rollupId, entryId: 'settle-A-2', occurredAtMs: 1, externalRef: chainRef(3), daoBasisPoints: 1_000 }, deps)).toMatchObject({ ok: true, settledCents: 0, entry: null });

    const rollup = await readMicrosRollup(WS, rollupId, deps);
    const entries = await readMoneyJournalEntries(WS, deps);
    expect(rollup).toMatchObject({ totalMicros: 49_999, settledCents: 4, roundingMicros: 9_999 });
    const inv = rollupInvariant(entries, rollup!);
    expect(inv).toMatchObject({ holds: true, journalCents: 4 });
    expect(inv.journalCents * MICROS_PER_CENT + inv.roundingMicros).toBe(49_999);
    expect(trialBalance(entries).balanced).toBe(true);
  });

  it('two concurrent settlers never settle the same micros twice', async () => {
    const rollupId = 'per-use:identity-B';
    await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: 'n1', micros: 123_456 }, deps);
    const [a, b] = await Promise.all([
      settleUsageRollup({ workspaceId: WS, rollupId, entryId: 'settle-B-a', occurredAtMs: 1, externalRef: chainRef(10), daoBasisPoints: 1_000 }, deps),
      settleUsageRollup({ workspaceId: WS, rollupId, entryId: 'settle-B-b', occurredAtMs: 1, externalRef: chainRef(11), daoBasisPoints: 1_000 }, deps),
    ]);
    const cents = [a, b].map((r) => (r.ok ? r.settledCents : -1)).sort((x, y) => x - y);
    expect(cents).toEqual([0, 12]);
    const rollup = await readMicrosRollup(WS, rollupId, deps);
    expect(rollup).toMatchObject({ totalMicros: 123_456, settledCents: 12, roundingMicros: 3_456 });
    expect(rollupInvariant(await readMoneyJournalEntries(WS, deps), rollup!).holds).toBe(true);
  });

  it('every posted entry is chained in the money-journal stream, and an edited entry breaks verification', async () => {
    const source = moneyJournalLedgerSource(WS, deps);
    const report = await verifyLedger(WS, source, deps.ledgerChain!);
    expect(report).toMatchObject({ ok: true, unchainedCount: 0 });
    const entries = await readMoneyJournalEntries(WS, deps);
    const [{ n }] = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.ledger_chain_links WHERE workspace_id = ${WS} AND stream_id = 'money-journal'`;
    expect(n).toBe(entries.length);

    // Tamper with history behind the append-only guard: verify must name the break.
    await db.adminSql.unsafe(`
      ALTER TABLE harness_shared.money_journal_entries DISABLE TRIGGER money_journal_entries_append_only_trg;
      UPDATE harness_shared.money_journal_entries SET memo = 'edited' WHERE workspace_id = '${WS}' AND entry_id = 'prov-1';
      ALTER TABLE harness_shared.money_journal_entries ENABLE TRIGGER money_journal_entries_append_only_trg;`);
    const tampered = await verifyLedger(WS, source, deps.ledgerChain!);
    expect(tampered.ok).toBe(false);
    expect(tampered.verdict.ok).toBe(false);
  });
});
