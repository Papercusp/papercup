import { describe, expect, it } from 'vitest';
import { journalEntryForMovement, type MoneyMovement } from '../../../cupboard/money-journal';
import { receiptCommitment } from '../../../cupboard/payment-receipt';
import { evaluateHostedBudget } from './budget-policy';
import { evaluateHostedPrepaidFunding, type HostedPrepaidFundingInput } from './budget-funding';

const T = Date.UTC(2026, 9, 2);
const START = Date.UTC(2026, 9, 1);
const END = Date.UTC(2026, 10, 1);
const KEY = 'consumption.usd_cents';
const scope = { controlWorkspaceId: 'control', organizationId: 'org-a', customerWorkspaceId: 'ws-a' };
function payment(id = 'txn_one', gross = 100, fee = 3, tax = 10, movement?: MoneyMovement) {
  const transaction = { id, amount: movement ? -gross : gross, fee, currency: 'usd', created: T / 1000 };
  const built = journalEntryForMovement({ entryId: `stripe-bt:${id}`, occurredAtMs: T, currency: 'USD',
    externalRef: { kind: 'stripe-balance-transaction', id },
    movement: movement ?? { kind: 'credit-purchase', grossCents: gross, feeCents: fee, taxCents: tax } });
  if (!built.ok) throw new Error(built.detail);
  const salt = 'a'.repeat(64);
  return { entry: built.entry, receipt: { transaction, receiptSeq: 1, salt,
    commitment: receiptCommitment(transaction, salt), sourceId: `ch_${id}`, sourceCustomer: 'cus_A' }, available: true };
}
const allocation = (changes: Partial<HostedPrepaidFundingInput['allocations'][number]> = {}) => ({
  allocationId: 'grant-a', paymentTransactionId: 'txn_one', organizationId: 'org-a',
  customerWorkspaceId: 'ws-a', budgetKey: KEY, micros: 500_000, ...changes,
});
const charge = (changes: Partial<HostedPrepaidFundingInput['priorCharges'][number]> = {}) => ({
  chargeId: 'charge-a', organizationId: 'org-a', customerWorkspaceId: 'ws-a', budgetKey: KEY,
  periodEndMs: START, costSource: 'provider-billed' as const, providerFinal: true, micros: 100_000, ...changes,
});
const input = (changes: Partial<HostedPrepaidFundingInput> = {}): HostedPrepaidFundingInput => ({
  scope, budgetKey: KEY, windowStartMs: START, asOfMs: T,
  snapshot: { controlWorkspaceId: 'control', organizationId: 'org-a', stripeAccountId: 'acct_A',
    stripeCustomerId: 'cus_A', livemode: true, complete: true, asOfMs: T, evidenceRef: 'stripe:census-a' },
  payments: [payment()], reversals: [], allocations: [allocation()], priorCharges: [], ...changes,
});
const run = (changes: Partial<HostedPrepaidFundingInput> = {}) => evaluateHostedPrepaidFunding(input(changes));
function refund(id = 'txn_refund', gross = 30, fee = 0, tax = 0, chargeback = false) {
  return { ...payment(id, gross, fee, tax, chargeback
    ? { kind: 'chargeback', amountCents: gross, feeCents: fee }
    : { kind: 'refund', amountCents: gross, taxCents: tax }), paymentTransactionId: 'txn_one' };
}

describe('prepaid allocation rules (verified server census and durable transaction still required)', () => {
  it('partitions one payment across workspaces without counting organization funding twice', () => {
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', customerWorkspaceId: 'ws-b', micros: 370_000 })] }))
      .toEqual({ ok: true, organization: { fundedMicros: 870_000 }, workspace: { fundedMicros: 500_000 }, evidenceRef: 'stripe:census-a' });
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', customerWorkspaceId: 'ws-b', micros: 370_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('deducts payment fees and collected tax before allocating cash', () => {
    expect(run({ allocations: [allocation({ micros: 870_000 })] })).toMatchObject({ ok: true, organization: { fundedMicros: 870_000 } });
    expect(run({ allocations: [allocation({ micros: 870_001 })] })).toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(run({ payments: [payment('txn_one', 100, 100, 10)], allocations: [] })).toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('allows organization funding without inventing a separate workspace allowance', () => {
    expect(run({ allocations: [allocation({ customerWorkspaceId: null })], priorCharges: [charge()] }))
      .toEqual({ ok: true, organization: { fundedMicros: 400_000 }, workspace: null, evidenceRef: 'stripe:census-a' });
    expect(run({ allocations: [] })).toMatchObject({ ok: true, organization: { fundedMicros: 0 }, workspace: null });
  });

  it('checks each source independently, so a second payment cannot cover duplicate use of the first', () => {
    expect(run({ payments: [payment(), payment('txn_two')], allocations: [allocation({ micros: 870_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(run({ payments: [payment(), payment('txn_two')], allocations: [allocation(),
      allocation({ allocationId: 'grant-b', paymentTransactionId: 'txn_two', micros: 600_000 })] }))
      .toMatchObject({ ok: true, organization: { fundedMicros: 1_100_000 } });
  });

  it('counts allocations of other keys against the same source capacity', () => {
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', budgetKey: 'storage.usd_cents', micros: 370_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', budgetKey: 'storage.usd_cents', micros: 370_000 })] }))
      .toMatchObject({ ok: true, organization: { fundedMicros: 500_000 } });
  });

  it('does not assign the customer payment to a second organization or an absent source', () => {
    for (const a of [allocation({ organizationId: 'org-b' }), allocation({ paymentTransactionId: 'txn_missing' })]) {
      expect(run({ allocations: [a] })).toEqual({ ok: false, reason: 'funding-scope-mismatch' });
    }
  });

  it.each(['livemode', 'complete'] as const)('refuses an unverified %s snapshot', field => {
    expect(run({ snapshot: { ...input().snapshot, [field]: false } })).toEqual({ ok: false, reason: 'unverified-funding' });
  });

  it.each([-1, 1])('refuses a snapshot with a different cutoff (%s)', delta => {
    expect(run({ snapshot: { ...input().snapshot, asOfMs: T + delta } })).toEqual({ ok: false, reason: 'unverified-funding' });
  });

  it.each(['stripeAccountId', 'stripeCustomerId', 'evidenceRef'] as const)('requires a pinned %s', field => {
    expect(run({ snapshot: { ...input().snapshot, [field]: '' } })).toEqual({ ok: false, reason: 'unverified-funding' });
  });

  it.each(['controlWorkspaceId', 'organizationId'] as const)('refuses a foreign snapshot %s', field => {
    expect(run({ snapshot: { ...input().snapshot, [field]: 'foreign' } })).toEqual({ ok: false, reason: 'funding-scope-mismatch' });
  });

  it('refuses an allocation of pending cash, while leaving unrelated pending receipts unfunded', () => {
    expect(run({ payments: [{ ...payment(), available: false }] })).toEqual({ ok: false, reason: 'unavailable-payment' });
    expect(run({ payments: [payment(), { ...payment('txn_two'), available: false }] })).toMatchObject({ ok: true });
  });

  it('does not treat subscription revenue or an arbitrary balanced posting as prepaid funding', () => {
    const p = payment('txn_one', 100, 3, 10,
      { kind: 'customer-payment', grossCents: 100, feeCents: 3, taxCents: 10, daoCents: 0, refundReserveCents: 0 });
    // Replace the fixture's signed amount; the receipt itself must remain valid.
    const transaction = { ...p.receipt.transaction, amount: 100 };
    expect(() => run({ payments: [{ ...p, receipt: { ...p.receipt, transaction,
      commitment: receiptCommitment(transaction, p.receipt.salt) } }] })).toThrow(/not a prepaid/);
    const balanced = payment();
    expect(() => run({ payments: [{ ...balanced, entry: { ...balanced.entry,
      lines: [{ account: 'operating', side: 'debit', cents: 100 }, { account: 'customer-credit-reserve', side: 'credit', cents: 100 }] } }] }))
      .toThrow(/posting mismatch/);
  });

  it('requires the receipt commitment, transaction, customer, currency and timestamp to match the journal', () => {
    const p = payment();
    expect(() => run({ payments: [{ ...p, receipt: { ...p.receipt, commitment: '0'.repeat(64) } }] })).toThrow(/receipt/);
    expect(() => run({ payments: [{ ...p, receipt: { ...p.receipt, sourceCustomer: 'cus_B' } }] })).toThrow(/binding/);
    expect(() => run({ payments: [{ ...p, entry: { ...p.entry, externalRef: { kind: 'stripe-balance-transaction', id: 'txn_other' } } }] })).toThrow(/binding/);
    expect(() => run({ payments: [{ ...p, entry: { ...p.entry, currency: 'EUR' } }] })).toThrow(/binding/);
    expect(() => run({ payments: [{ ...p, entry: { ...p.entry, occurredAtMs: T - 1 } }] })).toThrow(/binding/);
  });

  it('refuses future or duplicate source postings even under a new journal id', () => {
    const p = payment();
    expect(() => run({ payments: [p, p] })).toThrow(/duplicate/);
    expect(() => run({ payments: [p, { ...p, entry: { ...p.entry, entryId: 'alias' } }] })).toThrow(/duplicate/);
    expect(() => run({ asOfMs: T - 1, snapshot: { ...input().snapshot, asOfMs: T - 1 } })).toThrow(/future/);
  });

  it('deducts linked refunds from backing and suspends existing allocations above the reduced cash', () => {
    expect(run({ reversals: [refund()], allocations: [allocation({ micros: 570_000 })] })).toMatchObject({ ok: true });
    expect(run({ reversals: [refund()], allocations: [allocation({ micros: 570_001 })] })).toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(run({ reversals: [refund('txn_refund', 100)], allocations: [] })).toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('deducts chargeback fees as well as the disputed principal', () => {
    expect(run({ reversals: [refund('txn_dispute', 30, 2, 0, true)], allocations: [allocation({ micros: 550_000 })] })).toMatchObject({ ok: true });
    expect(run({ reversals: [refund('txn_dispute', 30, 2, 0, true)], allocations: [allocation({ micros: 550_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('releases only documented returned tax from the withheld tax portion', () => {
    expect(run({ reversals: [refund('txn_refund', 30, 0, 10)], allocations: [allocation({ micros: 670_000 })] })).toMatchObject({ ok: true });
    expect(run({ reversals: [refund('txn_refund', 30, 0, 10)], allocations: [allocation({ micros: 670_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(() => run({ reversals: [refund('txn_refund', 30, 0, 11)] })).toThrow(/refund fee or tax/);
    expect(() => run({ reversals: [refund('txn_refund', 20, 0, 6), refund('txn_refund2', 20, 0, 5)] })).toThrow(/refund fee or tax/);
  });

  it('requires an authenticated original-source link and rejects replayed reversal postings', () => {
    expect(run({ reversals: [{ ...refund(), paymentTransactionId: 'txn_missing' }] })).toEqual({ ok: false, reason: 'unmatched-reversal' });
    expect(() => run({ reversals: [refund(), refund()] })).toThrow(/duplicate/);
  });

  it('does not round fractional allocations before checking source capacity', () => {
    expect(run({ allocations: [allocation({ micros: 869_999, microsExact: '869999.9999999999999999999' }),
      allocation({ allocationId: 'tiny', micros: 0, microsExact: '0.0000000000000000001' })] }))
      .toMatchObject({ ok: true, organization: { fundedMicros: 870_000 } });
    expect(run({ allocations: [allocation({ micros: 870_000 }),
      allocation({ allocationId: 'tiny', micros: 0, microsExact: '0.0000000000000000001' })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('aggregates exact old liabilities before netting each organization/workspace allowance', () => {
    expect(run({ priorCharges: [charge({ micros: 0, microsExact: '0.6' }), charge({ chargeId: 'charge-b', micros: 0, microsExact: '0.6' })] }))
      .toEqual({ ok: true, organization: { fundedMicros: 499_998, fundedMicrosExact: '499998.8' },
        workspace: { fundedMicros: 499_998, fundedMicrosExact: '499998.8' }, evidenceRef: 'stripe:census-a' });
  });

  it('retains sibling workspace spend in the organization total while netting only the requested workspace', () => {
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', customerWorkspaceId: 'ws-b', micros: 300_000 })],
      priorCharges: [charge(), charge({ chargeId: 'charge-b', customerWorkspaceId: 'ws-b', micros: 200_000 })] }))
      .toMatchObject({ ok: true, organization: { fundedMicros: 500_000 }, workspace: { fundedMicros: 400_000 } });
  });

  it('cannot conceal another key or workspace overspend by changing the requested scope', () => {
    expect(run({ priorCharges: [charge({ budgetKey: 'storage.usd_cents', micros: 1 })] })).toEqual({ ok: false, reason: 'funding-overspent' });
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', customerWorkspaceId: 'ws-b', micros: 300_000 })],
      priorCharges: [charge({ customerWorkspaceId: 'ws-b', micros: 300_001 })] })).toEqual({ ok: false, reason: 'funding-overspent' });
  });

  it.each([{ providerFinal: false }, { periodEndMs: START + 1 }, { costSource: 'provider-reported' as 'provider-billed' }])
    ('refuses a prior charge that is not an earlier final bill (%j)', change => {
      expect(() => run({ priorCharges: [charge(change)] })).toThrow(/prior prepaid charge/);
    });

  it('rejects duplicate/conflicting allocation or bill ids instead of treating them as new funding/spend', () => {
    expect(() => run({ allocations: [allocation(), allocation({ micros: 1 })] })).toThrow(/duplicate/);
    expect(() => run({ priorCharges: [charge(), charge({ micros: 1 })] })).toThrow(/duplicate/);
    expect(run({ priorCharges: [charge({ organizationId: 'org-b' })] })).toEqual({ ok: false, reason: 'funding-scope-mismatch' });
  });

  it.each(['500000.00', '500001.1', '-1', '1e-3', '9007199254740991.1'])('rejects unsafe or noncanonical exact allocation %s', microsExact => {
    expect(() => run({ allocations: [allocation({ microsExact })] })).toThrow();
  });

  it('feeds exact net funding into the existing admission policy without turning a large cap into money', () => {
    const funding = run({ allocations: [allocation({ micros: 1 })], priorCharges: [charge({ micros: 0, microsExact: '0.1' })] });
    if (!funding.ok) throw new Error(funding.reason);
    const decision = evaluateHostedBudget({ entitlements: { budgets: { [KEY]: 10_000 } },
      policy: { policyId: 'policy-a', revision: 1, budgetKey: KEY, effectiveFromMs: START, effectiveUntilMs: END, warningBps: 8000 },
      position: { ...funding.organization, spentMicros: 0, openReservedMicros: 0, retainedReserveMicros: 0, unreconciled: false },
      maximumCostMicros: 1, asOfMs: T });
    expect(decision).toMatchObject({ admitted: false, reason: 'budget-exhausted', capMicros: 0, capMicrosExact: '0.9' });
  });
});
