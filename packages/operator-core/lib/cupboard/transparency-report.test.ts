/**
 * P-044 (D-028): the transparency report is derived from the money journal and
 * nothing else, so its totals must EQUAL the journal's; the monthly statement
 * must cover exactly the reconciled month and verify against its signer.
 */
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { journalEntryForMovement, trialBalance, type JournalEntry, type MovementEntryInput } from './money-journal';
import { buildMonthlyStatement, buildTransparencyReport, monthPeriod, treasuryFigure, type StatementReconciliation } from './transparency-report';
import { parseSignedStatement, signStatement, statementDigest, verifySignedStatement } from './transparency-statement';

const SEPT = monthPeriod('2026-09');
const at = (day: number, hour = 12) => Date.UTC(2026, 8, day, hour);

function entry(input: Omit<MovementEntryInput, 'currency'> & { currency?: string }): JournalEntry {
  const r = journalEntryForMovement({ currency: 'USD', ...input });
  if (!r.ok) throw new Error(`fixture entry rejected: ${JSON.stringify(r)}`);
  return r.entry;
}
const stripe = (id: string) => ({ kind: 'stripe-balance-transaction' as const, id });
const chain = (n: number) => ({ kind: 'chain-tx' as const, chainId: 84532, txHash: `0x${n.toString(16).padStart(64, '0')}` });

const journal: JournalEntry[] = [
  entry({ entryId: 'pay-1', occurredAtMs: at(2), externalRef: stripe('txn_1'), movement: { kind: 'customer-payment', grossCents: 10_000, feeCents: 320, taxCents: 0, daoCents: 1_000, refundReserveCents: 200 } }),
  entry({ entryId: 'credit-1', occurredAtMs: at(5), externalRef: stripe('txn_2'), movement: { kind: 'credit-purchase', grossCents: 5_000, feeCents: 175, taxCents: 0 } }),
  entry({ entryId: 'settle-1', occurredAtMs: at(10), externalRef: stripe('txn_3'), rollupId: 'rollup-sept', movement: { kind: 'usage-settlement', cents: 2_500, daoCents: 250 } }),
  entry({ entryId: 'refund-1', occurredAtMs: at(12), externalRef: stripe('txn_4'), movement: { kind: 'refund', amountCents: 1_000, taxCents: 0 } }),
  entry({ entryId: 'dao-1', occurredAtMs: at(20), externalRef: chain(1), movement: { kind: 'dao-transfer', amountCents: 1_000 } }),
  // Outside September: must not count.
  entry({ entryId: 'pay-aug', occurredAtMs: Date.UTC(2026, 7, 31, 23, 59), externalRef: stripe('txn_0'), movement: { kind: 'customer-payment', grossCents: 999_999, feeCents: 0, taxCents: 0, daoCents: 0, refundReserveCents: 0 } }),
  entry({ entryId: 'pay-oct', occurredAtMs: Date.UTC(2026, 9, 1, 0, 0), externalRef: stripe('txn_9'), movement: { kind: 'customer-payment', grossCents: 777_777, feeCents: 0, taxCents: 0, daoCents: 0, refundReserveCents: 0 } }),
];
const septEntries = journal.filter((e) => e.occurredAtMs >= SEPT.fromMs && e.occurredAtMs < SEPT.untilMs);

const notMeasured = treasuryFigure(null, 'no on-chain Safe source yet (WI-10004708)');
const anchor = { logId: 'ledger-anchor:ws', logRoot: 'ab'.repeat(32), treeSize: 9, windowEnd: 1_790_000_000, backend: 'eas', chainId: 84532, ref: '0x01', txHash: '0x02' };

function report(entries = journal) {
  return buildTransparencyReport({ workspaceId: 'ws', kind: 'live', entries, period: SEPT, provisional: true, treasury: notMeasured, latestAnchor: anchor });
}

describe('transparency report (P-044)', () => {
  it("report totals equal the journal's trial balance over the same period", () => {
    const r = report();
    const tb = trialBalance(septEntries, 'USD');
    for (const a of tb.accounts) {
      expect(r.accounts.find((x) => x.account === a.account)).toMatchObject({ debitCents: a.debitCents, creditCents: a.creditCents, netCents: a.balanceCents });
    }
    // Revenue = the revenue account's net movement; the streams sum to it.
    expect(r.revenueCents).toBe(tb.accounts.find((a) => a.account === 'revenue')?.balanceCents ?? 0);
    expect(Object.values(r.revenueByStream).reduce((s, n) => s + (n ?? 0), 0)).toBe(r.revenueCents);
    // The DAO's share is what was credited to dao-payable.
    expect(r.daoShareCents).toBe(tb.accounts.find((a) => a.account === 'dao-payable')?.creditCents ?? 0);
    expect(r.daoShareCents).toBeGreaterThan(0);
    expect(r.entryCount).toBe(septEntries.length);
  });

  it('lists every DAO transfer with its tx hash and labels the live layer provisional', () => {
    const r = report();
    expect(r.daoTransfers).toEqual([{ entryId: 'dao-1', occurredAtMs: at(20), cents: 1_000, chainId: 84532, txHash: chain(1).txHash }]);
    expect(r.daoTransferredCents).toBe(1_000);
    expect(r).toMatchObject({ kind: 'live', provisional: true, month: '2026-09', latestAnchor: { logRoot: anchor.logRoot } });
  });

  it('never infers the treasury balance: not-measured unless a Safe snapshot is supplied', () => {
    expect(report().treasury).toEqual({ status: 'not-measured', reason: 'no on-chain Safe source yet (WI-10004708)' });
    expect(treasuryFigure({ balanceMicros: 5, receiptsMicros: 7, approvedSpendsMicros: 2 }, 'x')).toEqual({ status: 'measured', balanceMicros: 5, receiptsMicros: 7, approvedSpendsMicros: 2 });
  });

  it('is order-independent: shuffled input gives the same entriesRoot and figures', () => {
    expect(report([...journal].reverse())).toEqual(report());
  });

  it('keeps other-currency entries out and counts them', () => {
    const eur = entry({ entryId: 'pay-eur', occurredAtMs: at(3), currency: 'EUR', externalRef: stripe('txn_e'), movement: { kind: 'customer-payment', grossCents: 4_000, feeCents: 0, taxCents: 0, daoCents: 0, refundReserveCents: 0 } });
    const r = report([...journal, eur]);
    expect(r.excludedOtherCurrency).toBe(1);
    expect(r.revenueCents).toBe(report().revenueCents);
  });
});

const finalRun = (verdicts: StatementReconciliation['verdicts'], mode: 'final' | 'provisional' = 'final'): StatementReconciliation => ({
  runId: 'run-1',
  mode,
  month: '2026-09',
  finishedAt: '2026-10-01T00:30:00.000Z',
  verdicts,
});
const clean: StatementReconciliation['verdicts'] = [
  { invariant: 'credit-reserve-covers-outstanding-credits', status: 'ok' },
  { invariant: 'dao-payable-equals-accrued-minus-transferred', status: 'ok' },
  { invariant: 'safe-balance-equals-receipts-minus-approved-spends', status: 'not-configured' },
  { invariant: 'journal-matches-stripe', status: 'ok' },
];

describe('monthly statement (P-044, D-028 §4–5)', () => {
  it('matches the reconciled journal: exactly the closed month, not provisional', () => {
    const b = buildMonthlyStatement({ workspaceId: 'ws', entries: journal, run: finalRun(clean), treasury: notMeasured, latestAnchor: anchor });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const r = b.statement.report;
    expect(r).toMatchObject({ kind: 'monthly-statement', provisional: false, month: '2026-09', fromMs: SEPT.fromMs, untilMs: SEPT.untilMs });
    // Same figures as the report over the same month: the statement IS the journal for September.
    const live = report();
    expect({ ...r, kind: 'live', provisional: true }).toEqual(live);
    expect(b.statement.reconciliation).toEqual({ runId: 'run-1', finishedAt: '2026-10-01T00:30:00.000Z', verdicts: clean });
    expect(b.digest).toBe(statementDigest(b.statement));
  });

  it('is withheld for a provisional run, a broken invariant, or a mandated invariant that could not be read', () => {
    expect(buildMonthlyStatement({ workspaceId: 'ws', entries: journal, run: finalRun(clean, 'provisional'), treasury: notMeasured, latestAnchor: null })).toMatchObject({ ok: false, reason: 'not-final' });
    const broken = clean.map((v) => (v.invariant === 'journal-matches-stripe' ? { ...v, status: 'broken' as const } : v));
    expect(buildMonthlyStatement({ workspaceId: 'ws', entries: journal, run: finalRun(broken), treasury: notMeasured, latestAnchor: null })).toMatchObject({
      ok: false,
      reason: 'reconciliation-not-clean',
      withheldBy: ['journal-matches-stripe:broken'],
    });
    const unread = clean.map((v) => (v.invariant === 'dao-payable-equals-accrued-minus-transferred' ? { ...v, status: 'unknown' as const } : v));
    expect(buildMonthlyStatement({ workspaceId: 'ws', entries: journal, run: finalRun(unread), treasury: notMeasured, latestAnchor: null })).toMatchObject({
      ok: false,
      withheldBy: ['dao-payable-equals-accrued-minus-transferred:unknown'],
    });
  });

  it('signs with EIP-191 so anyone can recover the signer; any tampering fails verification', async () => {
    const key = generatePrivateKey();
    const b = buildMonthlyStatement({ workspaceId: 'ws', entries: journal, run: finalRun(clean), treasury: notMeasured, latestAnchor: anchor });
    if (!b.ok) throw new Error('expected a statement');
    const signed = await signStatement(b.statement, key);
    expect(signed.signer).toBe(privateKeyToAccount(key).address);
    expect(signed.digest).toBe(b.digest);
    expect(await verifySignedStatement(signed)).toEqual({ ok: true });
    // Survives the JSON round trip the Worker sees; a malformed push is not a statement.
    const roundTripped = parseSignedStatement(JSON.parse(JSON.stringify(signed)));
    expect(roundTripped).not.toBeNull();
    expect(await verifySignedStatement(roundTripped!)).toEqual({ ok: true });
    expect(parseSignedStatement({ ...signed, scheme: 'x' })).toBeNull();
    expect(parseSignedStatement({ ...signed, statement: { ...signed.statement, report: { ...signed.statement.report, provisional: true } } })).toBeNull();

    const tampered = { ...signed, statement: { ...signed.statement, report: { ...signed.statement.report, revenueCents: signed.statement.report.revenueCents + 1 } } };
    expect(await verifySignedStatement(tampered)).toEqual({ ok: false, reason: 'digest does not match the statement' });
    const otherSigner = { ...signed, signer: privateKeyToAccount(generatePrivateKey()).address };
    expect(await verifySignedStatement(otherSigner)).toEqual({ ok: false, reason: 'signature does not recover to the signer' });
  });
});
