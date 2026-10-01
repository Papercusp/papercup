/**
 * agent-economy-flywheel-2026-08-30 P-042 / R-30 / D-023, integration layer:
 * a Stripe account's balance transactions and a treasury transfer reach the
 * money journal on real Postgres (migration 1286) through the real store and
 * its database guards.
 *
 * Real: Postgres with every migration applied, postMoneyJournalEntry, the
 * ledger_chain_links stream. Substituted: the Stripe HTTP page source (a fixed
 * account history), because a live Stripe key is not a test dependency.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { pgLedgerChainLinkStore, verifyLedger } from './ledger-chain';
import { trialBalance } from './money-journal';
import {
  PREPAID_CREDITS_PURPOSE,
  importStripeBalanceTransactions,
  journalVerdictForTreasuryTransfer,
  type JournalPoster,
  type StripeBalanceTransaction,
} from './money-journal-producers';
import { moneyJournalLedgerSource, postMoneyJournalEntry, readMoneyJournalEntries, type MoneyJournalStoreDeps } from './money-journal-store';

const WS = 'ws-p042-money-journal-producers';
const POLICY = { daoBasisPoints: 1_000, refundReserveBasisPoints: 500 };
let db: OrgTestDb;
let deps: MoneyJournalStoreDeps;

const ACCOUNT: StripeBalanceTransaction[] = [
  {
    id: 'txn_1Sub',
    type: 'charge',
    amount: 11_000,
    fee: 349,
    currency: 'usd',
    created: 1_790_000_100,
    source: { id: 'ch_sub', object: 'charge', invoice: { id: 'in_sub', total_taxes: [{ amount: 1_000 }] } },
  },
  {
    id: 'txn_1Credits',
    type: 'payment',
    amount: 2_000,
    fee: 88,
    currency: 'usd',
    created: 1_790_000_200,
    source: { id: 'py_cred', object: 'charge', metadata: { purpose: PREPAID_CREDITS_PURPOSE } },
  },
  { id: 'txn_1Refund', type: 'refund', amount: -500, fee: 0, currency: 'usd', created: 1_790_000_300, source: { id: 're_1', object: 'refund' } },
  { id: 'txn_1Dispute', type: 'adjustment', amount: -1_000, fee: 1_500, currency: 'usd', created: 1_790_000_400, source: { id: 'dp_1', object: 'dispute' } },
  { id: 'txn_1Fee', type: 'stripe_fee', amount: -199, fee: 0, currency: 'usd', created: 1_790_000_500, source: null },
  { id: 'txn_1Payout', type: 'payout', amount: -8_000, fee: 0, currency: 'usd', created: 1_790_000_600, source: null },
];

const list = async (p: { limit: number; startingAfter?: string }) => {
  const start = p.startingAfter ? ACCOUNT.findIndex((t) => t.id === p.startingAfter) + 1 : 0;
  const data = ACCOUNT.slice(start, start + p.limit);
  return { data, has_more: start + data.length < ACCOUNT.length };
};

const post: JournalPoster = async (entry) => {
  const r = await postMoneyJournalEntry({ workspaceId: WS, entry }, deps);
  return r.ok ? { ok: true, duplicate: r.duplicate } : { ok: false, code: r.code, detail: r.detail };
};

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 6 });
  deps = { sql: db.adminSql, ledgerChain: pgLedgerChainLinkStore(db.adminSql) };
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('money-journal producers on Postgres (P-042, R-30, D-023)', () => {
  it('imports every money movement of a Stripe account as a balanced, referenced entry, skips the payout, and is idempotent', async () => {
    const report = await importStripeBalanceTransactions({ list, post, policy: POLICY, pageSize: 4 });
    expect(report).toMatchObject({ scanned: 6, posted: 5, duplicates: 0, unmapped: [], refused: [], truncated: false });
    expect(report.skipped.map((s) => s.sourceId)).toEqual(['txn_1Payout']);

    const stored = await readMoneyJournalEntries(WS, deps);
    expect(stored.map((e) => e.externalRef)).toEqual(
      ['txn_1Sub', 'txn_1Credits', 'txn_1Refund', 'txn_1Dispute', 'txn_1Fee'].map((id) => ({ kind: 'stripe-balance-transaction', id })),
    );
    expect(stored.map((e) => e.movement)).toEqual(['customer-payment', 'credit-purchase', 'refund', 'chargeback', 'provider-payment']);
    expect(trialBalance(stored).balanced).toBe(true);

    const again = await importStripeBalanceTransactions({ list, post, policy: POLICY, pageSize: 4 });
    expect(again).toMatchObject({ posted: 0, duplicates: 5 });
    expect(await readMoneyJournalEntries(WS, deps)).toHaveLength(5);
  });

  it('posts a treasury transfer as a dao-transfer keyed by its tx hash, and the journal chain still verifies', async () => {
    const verdict = journalVerdictForTreasuryTransfer({
      chainId: 84532,
      txHash: `0x${'7'.repeat(64)}`,
      amountCents: 1_000,
      occurredAtMs: 1_790_000_700_000,
    });
    expect(verdict.disposition).toBe('entry');
    if (verdict.disposition !== 'entry') return;
    expect(await post(verdict.entry)).toEqual({ ok: true, duplicate: false });

    const stored = await readMoneyJournalEntries(WS, deps);
    expect(stored.at(-1)).toMatchObject({ movement: 'dao-transfer', externalRef: { kind: 'chain-tx', chainId: 84532 } });
    expect(trialBalance(stored).balanced).toBe(true);
    const verified = await verifyLedger(WS, moneyJournalLedgerSource(WS, deps), deps.ledgerChain!);
    expect(verified).toMatchObject({ ok: true, unchainedCount: 0 });
  });
});
