/** Durable hosted commitments, not a second funding/payment ledger (P-005).
 *
 * Funding and entitlement authority stay with their existing readers. This
 * receipt table fills the missing accounting term: work admitted but not yet
 * finally billed. All organization writers serialize under one transaction
 * lock; workspace limits share that lock. Process expiry never releases money.
 */
import { createHash } from 'node:crypto';
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { HostedEntitlementSet } from '../../hosted-entitlement-schema';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';
import { addMicrosDecimals, splitMicrosDecimal } from '../../../cupboard/money-journal';
import { evaluateHostedBudget, settleHostedReservation, type HostedBudgetDecision, type HostedBudgetPolicy } from './budget-policy';
import { HOSTED_COST_SOURCE_RANK, type HostedCostSource } from './usage-statement';

export interface HostedBudgetScope {
  readonly controlWorkspaceId: string;
  readonly organizationId: string;
  readonly customerWorkspaceId: string;
}
export interface HostedBudgetRequest {
  readonly scope: HostedBudgetScope;
  readonly reservationId: string;
  readonly month: string;
  readonly budgetKey: string;
  readonly maximumCostMicros: number;
  /** Opaque receipt for the server/provider's enforced maximum, not a key. */
  readonly providerLimitRef: string;
  readonly asOfMs: number;
}
export interface HostedBudgetLimit {
  /** Null is the required organization cap; the second cap may name this workspace. */
  readonly customerWorkspaceId: string | null;
  readonly entitlements: Pick<HostedEntitlementSet, 'budgets'>;
  /** Verified funding attributable to this window, net of older settled spend. */
  readonly fundedMicros: number;
  readonly fundedMicrosExact?: string;
  /** Costs outside this reservation ledger; exclude its settled receipts. */
  readonly externalSpentMicros: number;
  readonly externalSpentMicrosExact?: string;
  readonly retainedReserveMicros: number | null;
  readonly unreconciled: boolean;
}
export interface HostedBudgetContext {
  readonly scope: HostedBudgetScope;
  readonly month: string;
  readonly policy: HostedBudgetPolicy;
  readonly limits: readonly HostedBudgetLimit[];
  readonly evidenceRef: string;
}
/** Installed only by authenticated server composition. Read/lock authoritative
 * funding and policy rows through THIS sql transaction. Browser values, cached
 * balances and forecasts are not this authority. No installed reader = refusal. */
export type HostedBudgetContextReader = (sql: Sql, request: HostedBudgetRequest) => Promise<HostedBudgetContext | null>;

export interface HostedBudgetObservation {
  readonly scope: HostedBudgetScope;
  readonly reservationId: string;
  readonly eventId: string;
  readonly revision: number;
  readonly observedAtMs: number;
  readonly costSource: HostedCostSource;
  readonly costMicros: number | null;
  readonly costMicrosExact?: string;
  readonly providerFinal: boolean;
  readonly evidenceRef: string;
}
/** A committed admission, bound to the exact provider limit and policy.
 * This is delivered only to the winning server-side dispatch callback. */
export interface HostedBudgetExecutionGrant extends Omit<HostedBudgetRequest, 'asOfMs'> {
  readonly policyId: string;
  readonly policyRevision: number;
  readonly evidenceRef: string;
}
interface Receipt extends Omit<HostedBudgetRequest, 'asOfMs'> {
  readonly eventId: string;
  readonly revision: number;
  readonly requestHash: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly observedAtMs: number;
  readonly costSource: HostedCostSource;
  readonly costMicros: number | null;
  readonly costMicrosExact?: string;
  readonly providerFinal: boolean;
  readonly evidenceRef: string;
}
type Row = Record<string, unknown>;
const identifier = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(v);
const safe = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function number(v: unknown): number {
  const n = Number(v); if (!safe(n)) throw new Error('invalid budget receipt counter'); return n;
}
function sum(values: readonly number[]): number {
  const n = values.reduce((total, value) => total + BigInt(value), 0n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('budget receipt total overflow');
  return Number(n);
}
function scope(input: HostedBudgetScope): HostedBudgetScope {
  if (!input || Object.keys(input).some(k => !['controlWorkspaceId', 'organizationId', 'customerWorkspaceId'].includes(k))
      || !identifier(input.controlWorkspaceId) || !identifier(input.organizationId) || !identifier(input.customerWorkspaceId)) {
    throw new Error('invalid hosted budget scope');
  }
  return Object.freeze({ ...input });
}
const sameScope = (a: HostedBudgetScope, b: HostedBudgetScope) => a.controlWorkspaceId === b.controlWorkspaceId
  && a.organizationId === b.organizationId && a.customerWorkspaceId === b.customerWorkspaceId;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const requestHash = (r: HostedBudgetRequest) => digest([r.scope.controlWorkspaceId, r.scope.organizationId,
  r.scope.customerWorkspaceId, r.reservationId, r.month, r.budgetKey, r.maximumCostMicros, r.providerLimitRef]);
const canonical = (r: Receipt) => JSON.stringify([r.requestHash, r.eventId, r.revision, r.observedAtMs,
  r.costSource, r.costMicrosExact ?? (r.costMicros === null ? null : String(r.costMicros)), r.providerFinal, r.evidenceRef]);
const settlement = (r: Receipt) => settleHostedReservation({ reservedMicros: r.maximumCostMicros,
  observedCostMicros: r.costMicros, observedCostMicrosExact: r.costMicrosExact,
  costSource: r.costSource, providerFinal: r.providerFinal, evidenceRef: r.evidenceRef });

function exactCounter(value: number, exact: string | undefined): string {
  if (!safe(value)) throw new Error('invalid external budget spend');
  if (exact === undefined) return String(value);
  const amount = splitMicrosDecimal(exact);
  if (amount.micros !== value || amount.exact !== exact) throw new Error('invalid exact external budget spend');
  return exact;
}

function receipt(r: Row): Receipt {
  const cost = r.cost_micros === null ? null : splitMicrosDecimal(String(r.cost_micros));
  return { scope: scope({ controlWorkspaceId: r.control_workspace_id as string, organizationId: r.organization_id as string,
    customerWorkspaceId: r.customer_workspace_id as string }), reservationId: r.reservation_id as string,
    month: r.month as string, budgetKey: r.budget_key as string, maximumCostMicros: number(r.maximum_cost_micros),
    providerLimitRef: r.provider_limit_ref as string, eventId: r.event_id as string, revision: number(r.revision),
    requestHash: r.request_hash as string, policyId: r.policy_id as string, policyRevision: number(r.policy_revision),
    observedAtMs: number(r.observed_at_ms), costSource: r.cost_source as HostedCostSource,
    costMicros: cost?.micros ?? null, ...(cost?.exact.includes('.') ? { costMicrosExact: cost.exact } : {}),
    providerFinal: r.provider_final as boolean,
    evidenceRef: r.evidence_ref as string };
}
async function lock(sql: Sql, s: HostedBudgetScope): Promise<void> {
  // Use the identical SQL writer as the table guard, including JSON spacing.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
    json_build_array('hosted-budget', ${s.controlWorkspaceId}::text, ${s.organizationId}::text)::text, 0))`;
}
async function history(sql: Sql, s: HostedBudgetScope, reservationId: string): Promise<Receipt[]> {
  const rows = await sql<Row[]>`SELECT * FROM papercusp_auth.hosted_budget_receipts
    WHERE control_workspace_id = ${s.controlWorkspaceId} AND organization_id = ${s.organizationId}
      AND reservation_id = ${reservationId} ORDER BY revision`;
  return rows.map(receipt);
}
async function insert(sql: Sql, r: Receipt): Promise<void> {
  await sql`INSERT INTO papercusp_auth.hosted_budget_receipts
    (control_workspace_id, organization_id, customer_workspace_id, reservation_id, event_id, revision,
     month, budget_key, maximum_cost_micros, provider_limit_ref, request_hash, policy_id, policy_revision,
     observed_at_ms, cost_source, cost_micros, provider_final, evidence_ref)
    VALUES (${r.scope.controlWorkspaceId}, ${r.scope.organizationId}, ${r.scope.customerWorkspaceId}, ${r.reservationId},
      ${r.eventId}, ${r.revision}, ${r.month}, ${r.budgetKey}, ${r.maximumCostMicros}, ${r.providerLimitRef},
      ${r.requestHash}, ${r.policyId}, ${r.policyRevision}, ${r.observedAtMs}, ${r.costSource}, ${r.costMicrosExact ?? r.costMicros},
      ${r.providerFinal}, ${r.evidenceRef})`;
}

export class PostgresHostedBudgetStore {
  private readonly run: HostedServiceContextRunner;
  private readonly readContext: HostedBudgetContextReader;
  constructor(options: { run?: HostedServiceContextRunner; readContext?: HostedBudgetContextReader } = {}) {
    this.run = options.run ?? withHostedServiceContext;
    this.readContext = options.readContext ?? (async () => null);
  }

  /** Commit the full exposure BEFORE invoking a provider, at most once.
   * The reservation itself is the durable launch fence: only a fresh admission
   * dispatches. Retries, completed bills and process/lease expiry never reopen
   * it. A crash between commit and dispatch is deliberately ambiguous: keep
   * the hold and reconcile the provider rather than blindly relaunching.
   *
   * Network I/O runs outside the transaction. A callback failure propagates
   * without releasing money or deleting the fence. The authenticated caller
   * must enforce the bound identified by providerLimitRef; this method cannot
   * turn a forecast or an arbitrary reference into a provider-enforced limit.
   */
  async executeOnce<T>(input: HostedBudgetRequest, execute: (grant: HostedBudgetExecutionGrant) => Promise<T>) {
    if (typeof execute !== 'function') throw new Error('invalid budget executor');
    // Snapshot before the first await so a shared caller object cannot change
    // the reserved scope or limit while authority is being read.
    const snapshot = Object.freeze({ ...input, scope: scope(input.scope) });
    const reservation = await this.reserve(snapshot);
    if (reservation.outcome !== 'reserved') {
      return { execution: 'not-started' as const, reservation, value: null };
    }
    const r = reservation.receipt;
    const grant: HostedBudgetExecutionGrant = Object.freeze({ scope: snapshot.scope,
      reservationId: r.reservationId, month: r.month, budgetKey: r.budgetKey,
      maximumCostMicros: r.maximumCostMicros, providerLimitRef: r.providerLimitRef,
      policyId: r.policyId, policyRevision: r.policyRevision, evidenceRef: r.evidenceRef });
    const value = await execute(grant);
    // A returned operation/stream handle is dispatched, not finally billed.
    return { execution: 'dispatched' as const, reservation, value };
  }

  /** A duplicate is a saved receipt, NOT permission to start the provider again.
   * Use executeOnce for first launch; a direct reserve call only reserves
   * exposure. Resumption requires provider reconciliation, never a duplicate
   * receipt. Lost/crashed responses keep their original hold. */
  async reserve(input: HostedBudgetRequest) {
    if (Object.keys(input).some(k => !['scope', 'reservationId', 'month', 'budgetKey', 'maximumCostMicros', 'providerLimitRef', 'asOfMs'].includes(k))
        || !identifier(input.reservationId) || !identifier(input.budgetKey) || !identifier(input.providerLimitRef)
        || !safe(input.maximumCostMicros) || !safe(input.asOfMs)) throw new Error('invalid budget request');
    input = Object.freeze({ ...input, scope: scope(input.scope) });
    const { startMs, endMs } = shadowMonthBounds(input.month);
    const hash = requestHash(input);
    return this.run(async sql => {
      await lock(sql, input.scope);
      const prior = await history(sql, input.scope, input.reservationId);
      if (prior.length) return { outcome: prior[0]!.requestHash === hash ? 'duplicate' as const : 'conflict' as const,
        receipt: sameScope(prior[0]!.scope, input.scope) ? prior.at(-1)! : null, decisions: [] as HostedBudgetDecision[] };
      const received = await this.readContext(sql, input);
      if (!received) return { outcome: 'refused' as const, reason: 'unconfigured-context', receipt: null, decisions: [] as HostedBudgetDecision[] };
      if (!sameScope(scope(received.scope), input.scope) || received.month !== input.month
          || received.policy.budgetKey !== input.budgetKey || received.policy.effectiveFromMs !== startMs
          || received.policy.effectiveUntilMs !== endMs || !identifier(received.evidenceRef)
          || !Array.isArray(received.limits) || received.limits.length < 1 || received.limits.length > 2
          || received.limits.filter(l => l.customerWorkspaceId === null).length !== 1
          || received.limits.some(l => l.customerWorkspaceId !== null && l.customerWorkspaceId !== input.scope.customerWorkspaceId)) {
        throw new Error('budget authority context mismatch');
      }
      const policy = Object.freeze({ ...received.policy });
      const evidenceRef = received.evidenceRef;
      const limits = received.limits.map(l => Object.freeze({ ...l, entitlements: { budgets: { ...l.entitlements.budgets } } }));
      // All keys share the organization lock and committed exposure. A new
      // policy/key cannot erase an old reservation. Open OLD-month holds also
      // remain liabilities against this month's funding and cap.
      const rows = await sql<Row[]>`SELECT * FROM (
        SELECT DISTINCT ON (reservation_id) * FROM papercusp_auth.hosted_budget_receipts
        WHERE control_workspace_id = ${input.scope.controlWorkspaceId} AND organization_id = ${input.scope.organizationId}
        ORDER BY reservation_id, revision DESC
      ) latest WHERE month = ${input.month} OR NOT provider_final OR cost_source <> 'provider-billed'
        OR cost_micros > maximum_cost_micros`;
      const latest = rows.map(receipt);
      const decisions = limits.map(limit => {
        const relevant = latest.filter(r => limit.customerWorkspaceId === null || r.scope.customerWorkspaceId === limit.customerWorkspaceId);
        const amounts = relevant.map(r => ({ month: r.month, ...settlement(r) }));
        const spent = splitMicrosDecimal(addMicrosDecimals(exactCounter(limit.externalSpentMicros, limit.externalSpentMicrosExact),
          ...amounts.filter(a => a.month === input.month).map(a => a.chargedMicrosExact ?? String(a.chargedMicros))));
        return evaluateHostedBudget({ entitlements: limit.entitlements, policy, maximumCostMicros: input.maximumCostMicros,
          asOfMs: input.asOfMs, position: { fundedMicros: limit.fundedMicros,
            fundedMicrosExact: limit.fundedMicrosExact, spentMicros: spent.micros,
            ...(spent.exact.includes('.') ? { spentMicrosExact: spent.exact } : {}),
            openReservedMicros: sum(amounts.map(a => a.heldMicros)), retainedReserveMicros: limit.retainedReserveMicros,
            unreconciled: limit.unreconciled || amounts.some(a => a.suspend) } });
      });
      if (decisions.some(d => !d.admitted)) return { outcome: 'refused' as const, receipt: null, decisions };
      const r: Receipt = { ...input, requestHash: hash, eventId: digest(['admission', hash]), revision: 0,
        policyId: policy.policyId, policyRevision: policy.revision, observedAtMs: input.asOfMs,
        costSource: 'unpriced', costMicros: null, providerFinal: false, evidenceRef };
      await insert(sql, r);
      return { outcome: 'reserved' as const, receipt: r, decisions };
    });
  }

  /** Called by a verified provider collector, never the browser. New billed
   * corrections REPLACE the charge for this reservation; they do not add it.
   * No timer, cancellation flag or process restart can release this hold. */
  async observe(input: HostedBudgetObservation) {
    if (Object.keys(input).some(k => !['scope', 'reservationId', 'eventId', 'revision', 'observedAtMs', 'costSource', 'costMicros', 'costMicrosExact', 'providerFinal', 'evidenceRef'].includes(k))
        || !identifier(input.reservationId) || !identifier(input.eventId) || !identifier(input.evidenceRef)
        || !safe(input.revision) || input.revision < 1 || !safe(input.observedAtMs)
        || !Object.hasOwn(HOSTED_COST_SOURCE_RANK, input.costSource)
        || (input.costSource === 'unpriced' ? input.costMicros !== null : !safe(input.costMicros))
        || typeof input.providerFinal !== 'boolean') throw new Error('invalid budget observation');
    // Validate the exact/integer pair before any transaction or history write.
    settleHostedReservation({ reservedMicros: 0, observedCostMicros: input.costMicros,
      observedCostMicrosExact: input.costMicrosExact, costSource: input.costSource,
      providerFinal: input.providerFinal, evidenceRef: input.evidenceRef });
    input = Object.freeze({ ...input, scope: scope(input.scope) });
    return this.run(async sql => {
      await lock(sql, input.scope);
      const prior = await history(sql, input.scope, input.reservationId);
      const first = prior[0]; const last = prior.at(-1);
      if (!first || !last || !sameScope(first.scope, input.scope)) return { outcome: 'unknown' as const, receipt: null };
      const reused = await sql<Row[]>`SELECT reservation_id FROM papercusp_auth.hosted_budget_receipts
        WHERE control_workspace_id = ${input.scope.controlWorkspaceId} AND organization_id = ${input.scope.organizationId}
          AND event_id = ${input.eventId}`;
      if (reused[0] && reused[0].reservation_id !== input.reservationId) return { outcome: 'conflict' as const, receipt: null };
      const r: Receipt = { ...first, ...input };
      const replay = prior.find(p => p.eventId === input.eventId);
      if (replay) return { outcome: canonical(replay) === canonical(r) ? 'duplicate' as const : 'conflict' as const, receipt: replay };
      if (prior.some(p => p.revision === input.revision)) return { outcome: 'conflict' as const, receipt: null };
      if (input.revision < last.revision) return { outcome: 'stale' as const, receipt: null };
      if (input.observedAtMs < last.observedAtMs || HOSTED_COST_SOURCE_RANK[input.costSource] < HOSTED_COST_SOURCE_RANK[last.costSource]
          || (settlement(last).state === 'settled' && settlement(r).state !== 'settled')) throw new Error('budget observation downgrade');
      await insert(sql, r);
      return { outcome: 'recorded' as const, receipt: r, settlement: settlement(r) };
    });
  }
}
