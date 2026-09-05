/**
 * BYOC execution seam (P-017).
 *
 * The caller executes inference/tools on the customer's or host's local
 * credentials. This pure module only performs the control-plane work around
 * that call: billing-mode validation, claim-time lease revalidation, budget
 * reservation/commit, and privacy-preserving metering.
 */
import { commit, createLedger, reserve, type AxisCap, type LedgerState } from './offer-budget';
import { revalidateAtClaim, type ClaimGate, type InferenceLease } from './inference-lease';
import { recordContribution, recordSpend, type MeteringLedger } from './metering-ledger';
import { resolveBillingAuthority, type BillingContext, type BillingMode, type BillingModeSpec } from './billing-matrix';
import type { BudgetAxis, BudgetUnit } from './offer-budget';

export interface ByocExecutionContext {
  readonly hostRef: string;
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  readonly unit: BudgetUnit;
  readonly billedAmount: number;
  readonly reservationId: string;
  readonly billingMode: BillingMode;
  readonly billingContext?: BillingContext;
  readonly lease?: InferenceLease;
  readonly claimGate?: ClaimGate;
  readonly nowReceiver?: number;
  readonly ownerHighWaterEpoch?: number;
  readonly attestedUserId?: string;
  readonly perUserContributionCap?: number | null;
}

export type ByocPreparationResult =
  | { readonly ok: true; readonly ledger: LedgerState; readonly billing: BillingModeSpec; readonly relay: 'local-only' }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/** Reserve a local BYOC call. No inference bytes or credentials enter this API. */
export function prepareByocExecution(input: { budget: LedgerState; context: ByocExecutionContext }): ByocPreparationResult {
  const billing = resolveBillingAuthority(input.context.billingMode, input.context.billingContext);
  if (!billing.ok) return billing;
  if (input.context.lease) {
    if (!input.context.claimGate || input.context.nowReceiver == null || input.context.ownerHighWaterEpoch == null) {
      return { ok: false, code: 'lease_context_missing', detail: 'lease execution requires claimGate, nowReceiver, and ownerHighWaterEpoch' };
    }
    const lease = revalidateAtClaim({ lease: input.context.lease, gate: input.context.claimGate, nowReceiver: input.context.nowReceiver, ownerHighWaterEpoch: input.context.ownerHighWaterEpoch });
    if (!lease.ok) return lease;
  }
  const result = reserve(input.budget, input.context.billedAmount, input.context.reservationId);
  if (!result.ok) return result;
  return { ok: true, ledger: result.state, billing: billing.spec, relay: 'local-only' };
}

export type ByocSettlementResult =
  | { readonly ok: true; readonly budget: LedgerState; readonly metering: MeteringLedger; readonly committedAmount: number; readonly contributionCredited: number }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/** Commit actual local spend and record the host/user metering facts. */
export function settleByocExecution(input: { budget: LedgerState; metering: MeteringLedger; context: ByocExecutionContext; actualAmount?: number }): ByocSettlementResult {
  const committed = commit(input.budget, input.context.reservationId, input.actualAmount);
  if (!committed.ok) return committed;
  const spent = recordSpend(input.metering, { hostRef: input.context.hostRef, fleetSlug: input.context.fleetSlug, axis: input.context.axis, amount: committed.committedAmount, unit: input.context.unit });
  if (!spent.ok) return spent;
  let metering = spent.ledger;
  let contributionCredited = 0;
  if (input.context.attestedUserId) {
    const contribution = recordContribution(metering, { attestedUserId: input.context.attestedUserId, axis: input.context.axis, amount: committed.committedAmount, unit: input.context.unit, perUserCap: input.context.perUserContributionCap ?? null });
    if (!contribution.ok) return contribution;
    metering = contribution.ledger;
    contributionCredited = contribution.credited;
  }
  return { ok: true, budget: committed.state, metering, committedAmount: committed.committedAmount, contributionCredited };
}

/** Convenience constructor for a two-axis offer budget. */
export function createByocBudget(axis: AxisCap): LedgerState {
  return createLedger(axis);
}
