/** Exact monetary policy for hosted reservations (monetization P-005).
 *
 * Uses resolved hosted entitlement budgets (minor USD) and the accounting
 * rail's micro-USD unit. This is a decision helper, not an atomic store: the
 * durable caller must read funding, charges and open holds and insert the
 * granted reservation in the SAME transaction under the scope's row lock.
 * It never creates funding, charges Stripe or releases a crashed reservation.
 */
import type { HostedEntitlementSet } from '../../hosted-entitlement-schema';
import { MICROS_PER_CENT } from '../../../cupboard/money-journal';
import type { HostedUsageRecord } from './usage-statement';

export interface HostedBudgetPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly budgetKey: string;
  readonly effectiveFromMs: number;
  readonly effectiveUntilMs: number;
  readonly warningBps: number;
}

export interface HostedBudgetPosition {
  /** Total verified prepaid/finite allowance funding for this policy window,
   * including money already spent. A balance-after-spend is NOT this field. */
  readonly fundedMicros: number;
  readonly spentMicros: number;
  /** Includes crashed, cancelled-but-unbilled and expired process holds. */
  readonly openReservedMicros: number;
  /** Bounded continuing storage/IP/etc. exposure. Null is unknown, not zero. */
  readonly retainedReserveMicros: number | null;
  /** A known charge outside accounted spend/holds prevents further admission. */
  readonly unreconciled: boolean;
}

export type HostedBudgetRefusal = 'inactive-policy' | 'unconfigured-budget'
  | 'unreconciled-charge' | 'unbounded-retained-cost' | 'budget-exhausted';
export interface HostedBudgetDecision {
  readonly admitted: boolean;
  readonly reason: HostedBudgetRefusal | null;
  readonly capMicros: number | null;
  readonly availableMicros: number | null;
  readonly reserveMicros: number;
  readonly warning: boolean;
}

function amount(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid hosted budget ${field}`);
}
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
const refusal = (reason: HostedBudgetRefusal, capMicros: number | null = null,
  availableMicros: number | null = null, warning = false): HostedBudgetDecision =>
  ({ admitted: false, reason, capMicros, availableMicros, reserveMicros: 0, warning });

/** Maximum cost must be a server-enforced bound, never a forecast. No partial
 * grant: the caller must lower its provider/resource limit before retrying. */
export function evaluateHostedBudget(input: {
  readonly entitlements: Pick<HostedEntitlementSet, 'budgets'>;
  readonly policy: HostedBudgetPolicy;
  readonly position: HostedBudgetPosition;
  readonly maximumCostMicros: number;
  readonly asOfMs: number;
}): HostedBudgetDecision {
  const { policy, position } = input;
  if (!identifier(policy.policyId) || !identifier(policy.budgetKey)
      || !Number.isSafeInteger(policy.revision) || policy.revision < 1
      || !Number.isInteger(policy.warningBps) || policy.warningBps < 0 || policy.warningBps > 10_000) {
    throw new Error('invalid hosted budget policy');
  }
  amount(input.asOfMs, 'time'); amount(policy.effectiveFromMs, 'policy start'); amount(policy.effectiveUntilMs, 'policy end');
  if (policy.effectiveUntilMs <= policy.effectiveFromMs) throw new Error('invalid hosted budget interval');
  amount(input.maximumCostMicros, 'maximum cost');
  amount(position.fundedMicros, 'funding'); amount(position.spentMicros, 'spent'); amount(position.openReservedMicros, 'holds');
  if (typeof position.unreconciled !== 'boolean') throw new Error('invalid hosted budget reconciliation');
  if (position.retainedReserveMicros !== null) amount(position.retainedReserveMicros, 'retained reserve');
  if (input.asOfMs < policy.effectiveFromMs || input.asOfMs >= policy.effectiveUntilMs) return refusal('inactive-policy');
  if (!Object.hasOwn(input.entitlements.budgets, policy.budgetKey)) return refusal('unconfigured-budget');
  const cents = input.entitlements.budgets[policy.budgetKey];
  amount(cents, 'entitlement cap');
  const entitlementMicros = cents * MICROS_PER_CENT;
  amount(entitlementMicros, 'entitlement conversion');
  const capMicros = Math.min(entitlementMicros, position.fundedMicros);
  if (position.unreconciled) return refusal('unreconciled-charge', capMicros);
  if (position.retainedReserveMicros === null) return refusal('unbounded-retained-cost', capMicros);
  // BigInt comparisons retain exactness even if individually valid counters
  // sum past Number.MAX_SAFE_INTEGER. An overspent position always refuses.
  const committed = BigInt(position.spentMicros) + BigInt(position.openReservedMicros) + BigInt(position.retainedReserveMicros);
  const cap = BigInt(capMicros);
  const availableMicros = committed >= cap ? 0 : Number(cap - committed);
  const requested = BigInt(input.maximumCostMicros);
  const warning = (committed + requested) * 10_000n >= cap * BigInt(policy.warningBps);
  if (committed > cap || requested > BigInt(availableMicros)) return refusal('budget-exhausted', capMicros, availableMicros, warning);
  return { admitted: true, reason: null, capMicros, availableMicros, reserveMicros: input.maximumCostMicros, warning };
}

export interface HostedReservationSettlement {
  readonly state: 'pending' | 'settled';
  readonly chargedMicros: number;
  readonly heldMicros: number;
  readonly releasedMicros: number;
  readonly overrunMicros: number;
  readonly suspend: boolean;
  readonly evidenceRef: string;
}

/** Cancellation, process death, estimates and incomplete provider reports do
 * not certify zero spend. Keep the FULL hold until a final provider bill (or
 * an explicit final zero bill) reconciles it. A measured overrun is visible in
 * full and suspends admission; never clamp it to hide provider liability. */
export function settleHostedReservation(input: {
  readonly reservedMicros: number;
  readonly observedCostMicros: number | null;
  readonly costSource: HostedUsageRecord['costSource'];
  readonly providerFinal: boolean;
  readonly evidenceRef: string;
}): HostedReservationSettlement {
  amount(input.reservedMicros, 'settlement reserve');
  if (input.observedCostMicros !== null) amount(input.observedCostMicros, 'settlement cost');
  if (!['estimate', 'provider-reported', 'provider-billed', 'unpriced'].includes(input.costSource)
      || typeof input.providerFinal !== 'boolean' || !identifier(input.evidenceRef)
      || (input.costSource === 'unpriced' && input.observedCostMicros !== null)) {
    throw new Error('invalid hosted budget settlement evidence');
  }
  const overrunMicros = input.observedCostMicros === null ? 0 : Math.max(0, input.observedCostMicros - input.reservedMicros);
  if (!input.providerFinal || input.costSource !== 'provider-billed' || input.observedCostMicros === null) {
    return { state: 'pending', chargedMicros: 0, heldMicros: input.reservedMicros,
      releasedMicros: 0, overrunMicros, suspend: overrunMicros > 0, evidenceRef: input.evidenceRef };
  }
  return { state: 'settled', chargedMicros: input.observedCostMicros, heldMicros: 0,
    releasedMicros: Math.max(0, input.reservedMicros - input.observedCostMicros),
    overrunMicros, suspend: overrunMicros > 0, evidenceRef: input.evidenceRef };
}
