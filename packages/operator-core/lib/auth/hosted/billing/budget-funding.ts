/** Prepaid allocation rules for the existing hosted budget context reader.
 *
 * This is a pure validator, NOT a payment verifier or a funding authority.
 * The server reader must authenticate the account/customer, collect a complete
 * current payment/reversal census and lock its durable allocation rows in the
 * reservation transaction before using this result. Payment receipts alone do
 * not certify live mode or availability. No production reader is installed here.
 */
import { MICROS_PER_CENT, addMicrosDecimals, formatMicrosDecimal, journalLinesForMovement,
  parseMicrosDecimal, splitMicrosDecimal, validateJournalEntry, type JournalEntry,
  type JournalLine, type MoneyMovement } from '../../../cupboard/money-journal';
import { receiptCommitment, receiptTransactionProblem } from '../../../cupboard/payment-receipt';
import type { StoredPaymentReceipt } from '../../../cupboard/payment-receipt-store';

export interface HostedPrepaidAllocation {
  readonly allocationId: string;
  readonly paymentTransactionId: string;
  readonly organizationId: string;
  /** Null is unassigned organization funding; workspace allocations partition it. */
  readonly customerWorkspaceId: string | null;
  readonly budgetKey: string;
  readonly micros: number;
  readonly microsExact?: string;
}
interface Payment {
  readonly entry: JournalEntry;
  readonly receipt: StoredPaymentReceipt;
  readonly available: boolean;
}
interface Reversal extends Omit<Payment, 'available'> {
  /** Established by the authenticated provider source, not by matching amounts. */
  readonly paymentTransactionId: string;
}
export interface HostedPrepaidFundingInput {
  readonly scope: { readonly controlWorkspaceId: string; readonly organizationId: string; readonly customerWorkspaceId: string };
  readonly budgetKey: string;
  readonly windowStartMs: number;
  readonly asOfMs: number;
  readonly snapshot: {
    readonly controlWorkspaceId: string;
    readonly organizationId: string;
    readonly stripeAccountId: string;
    readonly stripeCustomerId: string;
    readonly livemode: boolean;
    readonly complete: boolean;
    readonly asOfMs: number;
    readonly evidenceRef: string;
  };
  readonly payments: readonly Payment[];
  readonly reversals: readonly Reversal[];
  /** ALL allocations of these payments, across keys/workspaces/organizations. */
  readonly allocations: readonly HostedPrepaidAllocation[];
  /** Latest final charges from earlier policy windows only, excluding current
   * window charges/holds that PostgresHostedBudgetStore counts independently. */
  readonly priorCharges: readonly {
    readonly chargeId: string;
    readonly organizationId: string;
    readonly customerWorkspaceId: string;
    readonly budgetKey: string;
    readonly periodEndMs: number;
    readonly costSource: 'provider-billed';
    readonly providerFinal: boolean;
    readonly micros: number;
    readonly microsExact?: string;
  }[];
}
type FundingAmount = { readonly fundedMicros: number; readonly fundedMicrosExact?: string };
type Refusal = 'unverified-funding' | 'funding-scope-mismatch' | 'unavailable-payment'
  | 'unmatched-reversal' | 'funding-overallocated' | 'funding-overspent';
export type HostedPrepaidFundingResult = { readonly ok: false; readonly reason: Refusal }
  | { readonly ok: true; readonly organization: FundingAmount;
    /** Null means no separate workspace allocation; the organization cap still applies. */
    readonly workspace: FundingAmount | null; readonly evidenceRef: string };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(v);
const safe = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const refuse = (reason: Refusal): HostedPrepaidFundingResult => ({ ok: false, reason });
function exact(micros: number, microsExact?: string): string {
  if (!safe(micros)) throw new Error('invalid prepaid micro amount');
  const parsed = splitMicrosDecimal(microsExact ?? String(micros));
  if (parsed.micros !== micros || (microsExact !== undefined && parsed.exact !== microsExact)) {
    throw new Error('invalid exact prepaid micro amount');
  }
  return parsed.exact;
}
function subtract(a: string, b: string): string | null {
  const aa = parseMicrosDecimal(a); const bb = parseMicrosDecimal(b);
  const scale = Math.max(aa.scale, bb.scale);
  const difference = aa.coefficient * 10n ** BigInt(scale - aa.scale) - bb.coefficient * 10n ** BigInt(scale - bb.scale);
  return difference < 0n ? null : formatMicrosDecimal(difference, scale);
}
function amount(value: string): FundingAmount {
  const a = splitMicrosDecimal(value);
  return { fundedMicros: a.micros, ...(a.exact.includes('.') ? { fundedMicrosExact: a.exact } : {}) };
}
const sortedLines = (lines: readonly JournalLine[]) => JSON.stringify([...lines]
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
function samePosting(entry: JournalEntry, movement: MoneyMovement): void {
  const built = journalLinesForMovement(movement);
  if (!built.ok || sortedLines(entry.lines) !== sortedLines(built.lines)) throw new Error('prepaid journal posting mismatch');
}
function posting(payment: Omit<Payment, 'available'>, customerId: string): JournalEntry {
  const { receipt } = payment;
  const valid = validateJournalEntry(payment.entry);
  if (!valid.ok || receiptTransactionProblem(receipt.transaction)
      || receipt.commitment !== receiptCommitment(receipt.transaction, receipt.salt)) throw new Error('invalid prepaid receipt or journal');
  const entry = valid.entry; const t = receipt.transaction;
  if (entry.externalRef.kind !== 'stripe-balance-transaction' || entry.externalRef.id !== t.id
      || entry.currency !== 'USD' || t.currency.toLowerCase() !== 'usd'
      || entry.occurredAtMs !== t.created * 1000 || receipt.sourceCustomer !== customerId) {
    throw new Error('prepaid receipt binding mismatch');
  }
  return entry;
}
const cents = (entry: JournalEntry, account: JournalLine['account'], side: JournalLine['side']) =>
  entry.lines.filter(l => l.account === account && l.side === side).reduce((n, l) => n + BigInt(l.cents), 0n);

/** Allocations partition the cash of each individual prepaid payment; they are
 * never additional money alongside the organization total. Fees, tax and
 * linked refunds/chargebacks reduce backing before any allocation is accepted.
 * A reversal below an existing grant suspends funding rather than silently
 * inventing debt or choosing which customer/workspace loses its allocation.
 */
export function evaluateHostedPrepaidFunding(input: HostedPrepaidFundingInput): HostedPrepaidFundingResult {
  const s = input.scope; const v = input.snapshot;
  if (!s || !v || !id(s.controlWorkspaceId) || !id(s.organizationId) || !id(s.customerWorkspaceId)
      || !id(input.budgetKey) || !safe(input.asOfMs) || !safe(input.windowStartMs) || input.windowStartMs > input.asOfMs
      || !Array.isArray(input.payments) || !Array.isArray(input.reversals) || !Array.isArray(input.allocations)
      || !Array.isArray(input.priorCharges)) throw new Error('invalid prepaid funding input');
  if (v.controlWorkspaceId !== s.controlWorkspaceId || v.organizationId !== s.organizationId) return refuse('funding-scope-mismatch');
  if (v.livemode !== true || v.complete !== true || v.asOfMs !== input.asOfMs
      || !/^acct_[A-Za-z0-9]+$/.test(v.stripeAccountId) || !/^cus_[A-Za-z0-9]+$/.test(v.stripeCustomerId)
      || !id(v.evidenceRef)) return refuse('unverified-funding');
  const payments = new Map<string, { credits: bigint; cash: bigint; tax: bigint; available: boolean }>();
  const journalIds = new Set<string>(); const transactionIds = new Set<string>();
  function unique(entry: JournalEntry, transactionId: string): void {
    if (journalIds.has(entry.entryId) || transactionIds.has(transactionId)) throw new Error('duplicate prepaid journal source');
    journalIds.add(entry.entryId); transactionIds.add(transactionId);
    if (entry.occurredAtMs > input.asOfMs) throw new Error('future prepaid journal source');
  }
  for (const p of input.payments) {
    const entry = posting(p, v.stripeCustomerId); const t = p.receipt.transaction;
    unique(entry, t.id);
    if (entry.movement !== 'credit-purchase' || typeof p.available !== 'boolean') throw new Error('not a prepaid funding payment');
    const tax = cents(entry, 'tax-reserve', 'credit');
    if (tax > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('prepaid tax overflow');
    samePosting(entry, { kind: 'credit-purchase', grossCents: t.amount, feeCents: t.fee, taxCents: Number(tax) });
    payments.set(t.id, { credits: BigInt(t.amount) - tax, cash: BigInt(t.amount) - BigInt(t.fee) - tax, tax, available: p.available });
  }
  for (const r of input.reversals) {
    const entry = posting(r, v.stripeCustomerId); const t = r.receipt.transaction;
    unique(entry, t.id);
    const p = payments.get(r.paymentTransactionId);
    if (!p) return refuse('unmatched-reversal');
    if (entry.movement === 'refund') {
      const tax = cents(entry, 'tax-reserve', 'debit');
      if (t.fee !== 0 || tax > BigInt(Number.MAX_SAFE_INTEGER) || tax > p.tax) throw new Error('invalid prepaid refund fee or tax');
      samePosting(entry, { kind: 'refund', amountCents: -t.amount, taxCents: Number(tax) });
      p.tax -= tax;
      p.credits -= BigInt(-t.amount) - tax;
      p.cash -= BigInt(-t.amount) - tax;
    } else if (entry.movement === 'chargeback') {
      samePosting(entry, { kind: 'chargeback', amountCents: -t.amount, feeCents: t.fee });
      p.credits -= BigInt(-t.amount); p.cash -= BigInt(-t.amount) + BigInt(t.fee);
    } else throw new Error('not a prepaid funding reversal');
  }
  const allocated = new Map<string, string>(); const allocationIds = new Set<string>();
  const org: string[] = []; const workspace: string[] = [];
  const grantsByKey = new Map<string, string>(); const workspaceGrants = new Map<string, string>();
  const workspaceKey = (workspaceId: string, budgetKey: string) => JSON.stringify([workspaceId, budgetKey]);
  for (const a of input.allocations) {
    if (!id(a.allocationId) || !id(a.paymentTransactionId) || !id(a.organizationId) || !id(a.budgetKey)
        || (a.customerWorkspaceId !== null && !id(a.customerWorkspaceId)) || allocationIds.has(a.allocationId)) {
      throw new Error('invalid or duplicate prepaid allocation');
    }
    allocationIds.add(a.allocationId);
    const value = exact(a.micros, a.microsExact); const p = payments.get(a.paymentTransactionId);
    if (!p || a.organizationId !== s.organizationId) return refuse('funding-scope-mismatch');
    if (!p.available) return refuse('unavailable-payment');
    allocated.set(a.paymentTransactionId, addMicrosDecimals(allocated.get(a.paymentTransactionId) ?? '0', value));
    grantsByKey.set(a.budgetKey, addMicrosDecimals(grantsByKey.get(a.budgetKey) ?? '0', value));
    if (a.customerWorkspaceId !== null) {
      const key = workspaceKey(a.customerWorkspaceId, a.budgetKey);
      workspaceGrants.set(key, addMicrosDecimals(workspaceGrants.get(key) ?? '0', value));
    }
    if (a.budgetKey === input.budgetKey) {
      org.push(value);
      if (a.customerWorkspaceId === s.customerWorkspaceId) workspace.push(value);
    }
  }
  for (const [transactionId, p] of payments) {
    const capacity = (p.credits < p.cash ? p.credits : p.cash) * BigInt(MICROS_PER_CENT);
    if (capacity < 0n || subtract(capacity.toString(), allocated.get(transactionId) ?? '0') === null) {
      return refuse('funding-overallocated');
    }
  }
  const priorOrg: string[] = []; const priorWorkspace: string[] = []; const chargeIds = new Set<string>();
  const priorByKey = new Map<string, string>(); const priorByWorkspace = new Map<string, string>();
  for (const c of input.priorCharges) {
    if (!id(c.chargeId) || chargeIds.has(c.chargeId) || !id(c.budgetKey) || !id(c.customerWorkspaceId)
        || !safe(c.periodEndMs) || c.periodEndMs > input.windowStartMs
        || c.costSource !== 'provider-billed' || c.providerFinal !== true) throw new Error('invalid or duplicate prior prepaid charge');
    chargeIds.add(c.chargeId);
    if (c.organizationId !== s.organizationId) return refuse('funding-scope-mismatch');
    const value = exact(c.micros, c.microsExact);
    priorByKey.set(c.budgetKey, addMicrosDecimals(priorByKey.get(c.budgetKey) ?? '0', value));
    const key = workspaceKey(c.customerWorkspaceId, c.budgetKey);
    priorByWorkspace.set(key, addMicrosDecimals(priorByWorkspace.get(key) ?? '0', value));
    if (c.budgetKey === input.budgetKey) {
      priorOrg.push(value);
      if (c.customerWorkspaceId === s.customerWorkspaceId) priorWorkspace.push(value);
    }
  }
  // Changing the requested key/workspace cannot hide another allocation's
  // overrun and spend backing that has already become somebody else's debt.
  for (const [key, value] of priorByKey) {
    if (subtract(grantsByKey.get(key) ?? '0', value) === null) return refuse('funding-overspent');
  }
  for (const [key, value] of priorByWorkspace) {
    const grant = workspaceGrants.get(key);
    if (grant !== undefined && subtract(grant, value) === null) return refuse('funding-overspent');
  }
  const organization = subtract(addMicrosDecimals(...org), addMicrosDecimals(...priorOrg));
  const workspaceGrant = workspaceGrants.has(workspaceKey(s.customerWorkspaceId, input.budgetKey));
  const scoped = workspaceGrant ? subtract(addMicrosDecimals(...workspace), addMicrosDecimals(...priorWorkspace)) : '0';
  if (organization === null || scoped === null) return refuse('funding-overspent');
  return { ok: true, organization: amount(organization), workspace: workspaceGrant ? amount(scoped) : null, evidenceRef: v.evidenceRef };
}
