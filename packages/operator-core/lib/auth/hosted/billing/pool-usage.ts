/** Server-owned infrastructure accounting. It never posts a customer charge. */
import { allocatePoolBill, type PoolBillLine } from './pool-allocation';
import type { HostedUsageRead } from './usage-service';
import type { HostedUsageScope, HostedUsageSourceCensus } from './usage-statement';

export const POOL_COST_CATEGORIES = ['compute', 'persistent-storage', 'provisioned-performance',
  'backup', 'object-storage', 'network', 'control-plane', 'warm-capacity', 'inference'] as const;

export interface HostedPoolUsageSnapshot {
  readonly scope: HostedUsageScope;
  readonly month: string;
  readonly source: HostedUsageSourceCensus;
  /** Server-resolved organization membership for every invoice tenant. */
  readonly workspaces: readonly { controlWorkspaceId: string; organizationId: string; customerWorkspaceId: string }[];
  readonly bills: readonly {
    readonly invoiceId: string;
    readonly periodRef: string;
    readonly currency: string;
    readonly totalMicros: number;
    readonly lines: readonly PoolBillLine[];
  }[];
}
/** Installed by the authenticated server composition, never by request data. */
export type HostedPoolUsageSource = (input: HostedUsageRead) => Promise<HostedPoolUsageSnapshot>;

export interface HostedPoolCostSummary {
  readonly currency: 'USD';
  readonly sourceRef: string | null;
  readonly observedAtMs: number | null;
  readonly complete: boolean;
  /** Known net shares remain visible even when missing cost prevents a total. */
  readonly knownTenantMicros: number;
  readonly tenantTotalMicros: number | null;
  readonly creditsExcludedTenantMicros: number | null;
  /** Pool invoice conservation, including the explicitly retained shared buckets. */
  readonly poolTotalMicros: number | null;
  readonly sharedOverheadMicros: number | null;
  readonly unallocatedMicros: number | null;
  readonly gaps: readonly string[];
  readonly tenants: readonly { customerWorkspaceId: string; knownMicros: number; totalMicros: number | null }[];
}

const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
const safe = (value: bigint) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('pool usage amount overflow');
  }
  return Number(value);
};

export async function readHostedPoolCosts(input: HostedUsageRead, source?: HostedPoolUsageSource): Promise<HostedPoolCostSummary> {
  const absent: HostedPoolCostSummary = { currency: 'USD', sourceRef: null, observedAtMs: null,
    complete: false, knownTenantMicros: 0, tenantTotalMicros: null, creditsExcludedTenantMicros: null,
    poolTotalMicros: null, sharedOverheadMicros: null, unallocatedMicros: null,
    gaps: ['pool-source-unconfigured'], tenants: [] };
  if (!source) return absent;
  const snapshot = await source(input);
  // Validate the runtime shape without narrowing the readonly source contract
  // to Array.isArray's mutable any[], which erases invoice element types.
  if (!snapshot || snapshot.scope.controlWorkspaceId !== input.scope.controlWorkspaceId
      || snapshot.scope.organizationId !== input.scope.organizationId
      || snapshot.scope.customerWorkspaceId !== input.scope.customerWorkspaceId
      || snapshot.month !== input.month || !Array.isArray(snapshot.bills as unknown)) throw new Error('pool usage scope mismatch');
  const census = snapshot.source;
  if (!census || typeof census.complete !== 'boolean' || !id(census.evidenceRef)
      || !Number.isSafeInteger(census.observedAtMs) || census.observedAtMs < 0
      || !Number.isSafeInteger(census.maximumAgeMs) || census.maximumAgeMs < 0) throw new Error('invalid pool usage census');
  const gaps = new Set<string>();
  if (!census.complete) gaps.add('incomplete-pool-source');
  if (census.observedAtMs > input.asOfMs || input.asOfMs - census.observedAtMs > census.maximumAgeMs) gaps.add('pool-source-not-current');
  const workspaces = new Set<string>();
  if (!Array.isArray(snapshot.workspaces as unknown)) throw new Error('missing pool workspace bindings');
  for (const workspace of snapshot.workspaces) {
    if (workspace.controlWorkspaceId !== input.scope.controlWorkspaceId || workspace.organizationId !== input.scope.organizationId
        || !id(workspace.customerWorkspaceId) || workspaces.has(workspace.customerWorkspaceId)) throw new Error('pool workspace scope mismatch');
    workspaces.add(workspace.customerWorkspaceId);
  }
  if (input.scope.customerWorkspaceId !== null && !workspaces.has(input.scope.customerWorkspaceId)) throw new Error('pool workspace scope mismatch');
  const invoices = new Set<string>(), categories = new Set<string>(), tenants = new Map<string, bigint>();
  let pool = 0n, overhead = 0n, unallocated = 0n, gross = 0n;
  const selected = (tenantId: string) => input.scope.customerWorkspaceId === null || tenantId === input.scope.customerWorkspaceId;
  for (const bill of snapshot.bills) {
    if (!id(bill.invoiceId) || invoices.has(bill.invoiceId) || bill.periodRef !== input.month || bill.currency !== 'USD') {
      throw new Error('pool invoice binding mismatch');
    }
    invoices.add(bill.invoiceId);
    for (const line of bill.lines) {
      if (line.allocation.kind !== 'unresolved' && line.allocation.tenants.some(tenant => !workspaces.has(tenant.tenantId))) {
        throw new Error('unbound pool tenant');
      }
    }
    const result = allocatePoolBill(bill);
    pool += BigInt(result.totalMicros); overhead += BigInt(result.overheadMicros); unallocated += BigInt(result.unallocatedMicros);
    for (const gap of result.gaps) gaps.add(`${bill.invoiceId}:${gap}`);
    for (const row of result.tenants) {
      if (!id(row.tenantId)) throw new Error('invalid pool tenant');
      if (selected(row.tenantId)) tenants.set(row.tenantId, (tenants.get(row.tenantId) ?? 0n) + BigInt(row.amountMicros));
    }
    const kinds = new Map(bill.lines.map(line => [line.id, line.kind]));
    for (const line of result.lines) {
      categories.add(line.category);
      if (kinds.get(line.id) === 'charge') {
        for (const row of line.tenants) if (selected(row.tenantId)) gross += BigInt(row.amountMicros);
      }
    }
  }
  for (const category of POOL_COST_CATEGORIES) if (!categories.has(category)) gaps.add(`missing-pool-category:${category}`);
  const complete = gaps.size === 0;
  const known = [...tenants.values()].reduce((sum, amount) => sum + amount, 0n);
  return { currency: 'USD', sourceRef: census.evidenceRef, observedAtMs: census.observedAtMs, complete,
    knownTenantMicros: safe(known), tenantTotalMicros: complete ? safe(known) : null,
    creditsExcludedTenantMicros: complete ? safe(gross) : null, poolTotalMicros: safe(pool),
    sharedOverheadMicros: safe(overhead), unallocatedMicros: safe(unallocated), gaps: [...gaps].sort(),
    tenants: [...tenants].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([customerWorkspaceId, micros]) => ({ customerWorkspaceId, knownMicros: safe(micros), totalMicros: complete ? safe(micros) : null })) };
}
