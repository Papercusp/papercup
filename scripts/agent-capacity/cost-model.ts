/**
 * P-012 cost model (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10004388): Google cost per month
 * for ONE workspace with N assigned agents, for each lever combination, graded against the D-003
 * target (50 agents at a Google cost of about 60-80 USD/month; the owner's starting figure was
 * 1000 USD/month, #1064).
 *
 *   npx tsx scripts/agent-capacity/cost-model.ts [--agents 50] [--p532-saved-gib <GiB>]
 *     [--report-month <JSON file with CostReportMonth inputs>] [--json]
 *
 * Every measured input below names the plan Decision it comes from. Machine prices are NOT typed in
 * here: they come from gcp-rails (Cloud Billing Catalog list prices, on-demand and spot), so a price
 * update there re-prices every row. Re-run this after a new measurement instead of hand-editing a table.
 *
 * Model (per month, 730 h):
 *   pooled compute    = N x duty.mean x hostMonth / activeCapacity
 *                       (agents of many workspaces share a pool of hosts, so the pool is sized for
 *                        the MEAN number of busy agents; D-038 measured p99 at 1.3x the mean)
 *   dedicated compute = ceil(N x duty.mean x duty.p99OverMean / (activeCapacity - 1)) x hostMonth
 *                       (one workspace owns its VM, so it must hold its own p99; one agent slot is
 *                        given to the workspace's Server, which costs about one mixed agent's CPU)
 *   server            = dedicated: inside the dedicated VM (0 extra)
 *                       packed:    hostMonth(e2-standard-16 spot) / tenants per host (D-045 as measured)
 *                       floor:     Server cores and RAM at e2 spot list rates (D-022 method); reachable
 *                                  only with near-perfect packing, so it is a lower bound
 */
import { readFileSync } from 'node:fs';
import { hourlyPriceUsd, parseMachineType, SPOT_PRICES_2026_10_01 } from './gcp-rails';

export const HOURS_PER_MONTH = 730;
/** The measurement VMs were priced with a 120 GB boot disk (capacity-table --disk-gb 120), so the rows here match D-019/D-020. */
export const HOST_DISK_GB = 120;

export const TARGET = { agents: 50, googleUsdMonthMax: 80, googleUsdMonthGoal: 60, source: 'D-003' } as const;
export const OWNER_BASELINE = { agents: 50, usdMonth: 1000, source: 'owner directive #1064' } as const;

/** Share of agents mid-turn at once in the real fleet, and its p99 over the mean. */
export const DUTY = { mean: 0.35, p99OverMean: 1.3, source: 'D-038' } as const;

export type Workload = 'mixed' | 'heavy';

export interface Capacity {
  id: string;
  workload: Workload;
  machineType: string;
  /** Mean agents in flight at the capacity step (achieved concurrency, not slot count; D-020). */
  active: number;
  /** True when the run never saturated, so the real capacity is at least `active`. */
  atLeast?: boolean;
  source: string;
}

/**
 * mixed = 50/50 Claude/Codex planning workload, replayed (D-009 accepted replay for it).
 * heavy = real typecheck/test-heavy Papercusp engineering (P-019 recordings replayed in P-529/WI-5384).
 * Use achieved concurrency, not the requested ramp slots. The original output is retained in
 * fixtures/capacity-ramps.json and checked through the existing capacity-table reducer by the tests.
 * A ramp that stopped without saturation supplies a lower bound, including the lean/Arm rows.
 */
export const CAPACITY: readonly Capacity[] = [
  { id: 'mixed-e2s4', workload: 'mixed', machineType: 'e2-standard-4', active: 7.9, source: 'D-019 (achieved concurrency per D-020)' },
  { id: 'mixed-e2s8', workload: 'mixed', machineType: 'e2-standard-8', active: 31.6, source: 'D-019 (achieved concurrency per D-020)' },
  { id: 'mixed-e2s16', workload: 'mixed', machineType: 'e2-standard-16', active: 60.1, source: 'D-019 (corrected by D-020)' },
  { id: 'mixed-e2c16', workload: 'mixed', machineType: 'e2-custom-16-32768', active: 73.2, atLeast: true, source: 'D-020' },
  { id: 'mixed-c4a16', workload: 'mixed', machineType: 'c4a-standard-16', active: 87.6, source: 'D-024' },
  { id: 'mixed-c4ahc16', workload: 'mixed', machineType: 'c4a-highcpu-16', active: 83.3, atLeast: true, source: 'D-027' },
  { id: 'heavy-e2s16', workload: 'heavy', machineType: 'e2-standard-16', active: 23.9, source: 'D-023 (no admission)' },
  { id: 'heavy-e2s16-adm', workload: 'heavy', machineType: 'e2-standard-16', active: 31.8, source: 'D-023 (heavy-job admission)' },
  {
    id: 'heavy-e2s16-adm-tsc',
    workload: 'heavy',
    machineType: 'e2-standard-16',
    active: 47.9,
    atLeast: true,
    source: 'D-040 (admission + shared tsc-service; n48 held 47.9; slowdown unmeasured)',
  },
];

/**
 * One idle Papercusp Server tenant (D-045, P-011: 16 tenants on a 64 GiB e2-standard-16, embed
 * unload off). ramGiB is the HOST cost per tenant: host MemAvailable fell 61.7 -> 3.9 GiB for 16
 * tenants, 3.61 GiB each (cgroup mean 3.24 plus kernel and page cache). cores is the idle floor
 * (0.16-0.20 measured, upper end taken).
 */
export const SERVER = {
  ramGiB: 3.6,
  cores: 0.2,
  packHost: 'e2-standard-16',
  /** D-045 kept a 10 GiB reserve on the 64 GiB host. */
  reserveGiB: 10,
  /** MemAvailable at start over nominal RAM on that host (61.7 of 64 GiB). */
  usableRamFraction: 61.7 / 64,
  source: 'D-045',
} as const;

export function hostMonthUsd(machineType: string, spot: boolean): number {
  return hourlyPriceUsd(machineType, HOST_DISK_GB, { spot }) * HOURS_PER_MONTH;
}

/** P-544: a stopped workspace keeps its storage, but does not rent running compute. */
export interface OnDemandMonthInput {
  activeHours: number;
  /** Compute only: exclude retained disks and other monthly charges from this rate. */
  computeHourlyUsd: number;
  retainedDiskGiB: number;
  diskGiBMonthUsd: number;
  backupMonthUsd: number;
  controlMonthUsd: number;
  networkMonthUsd: number;
  /** Monthly inference exposure, including customer-direct usage; never assume an omitted cost is zero. */
  inferenceMonthUsd: number;
  /** An ephemeral address released on stop; reserved addresses belong in controlMonthUsd. */
  activeIpv4HourlyUsd: number;
}

/** Provider-neutral arithmetic. Every category needs an explicit input; zero needs supporting
 * evidence from the caller. Arithmetic alone proves neither measured cost nor capacity acceptance. */
export function onDemandMonthUsd(input: OnDemandMonthInput) {
  const required = ['activeHours', 'computeHourlyUsd', 'retainedDiskGiB', 'diskGiBMonthUsd',
    'backupMonthUsd', 'controlMonthUsd', 'networkMonthUsd', 'inferenceMonthUsd',
    'activeIpv4HourlyUsd'] as const satisfies readonly (keyof OnDemandMonthInput)[];
  for (const key of required) {
    const value = input[key];
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be finite and non-negative`);
  }
  if (input.activeHours > HOURS_PER_MONTH) throw new Error('activeHours exceeds the modeled month');
  const computeUsd = input.activeHours * input.computeHourlyUsd;
  const ipv4Usd = input.activeHours * input.activeIpv4HourlyUsd;
  const storageUsd = input.retainedDiskGiB * input.diskGiBMonthUsd;
  const retainedUsd = storageUsd + input.backupMonthUsd + input.controlMonthUsd;
  const totalUsd = computeUsd + ipv4Usd + retainedUsd + input.networkMonthUsd + input.inferenceMonthUsd;
  if (!Number.isFinite(totalUsd)) throw new Error('totalUsd must be finite');
  return { activeHours: input.activeHours, computeUsd, ipv4Usd, storageUsd,
    backupUsd: input.backupMonthUsd, controlUsd: input.controlMonthUsd,
    networkUsd: input.networkMonthUsd, inferenceUsd: input.inferenceMonthUsd, retainedUsd, totalUsd };
}

/** P544/P538 accounting preparation, not a customer charge or a measured price.
 * Reconcile an observed invoice in integer currency micros. The caller must bind
 * the invoice, achieved-capacity observation and tenant usage to the same period.
 * Requested agent slots are deliberately not an allocation input.
 */
export type PoolBillAllocation =
  | { kind: 'compute'; achievedAgentMilliseconds: number; capacityEvidenceRef: string;
      tenants: readonly { tenantId: string; activeAgentMilliseconds: number }[] }
  | { kind: 'weighted'; overheadWeight: number;
      tenants: readonly { tenantId: string; weight: number }[] }
  | { kind: 'unresolved'; reason: string };

export interface PoolBillLine {
  id: string;
  periodRef: string;
  provider: string;
  currency: string;
  category: 'compute' | 'persistent-storage' | 'provisioned-performance' | 'backup'
    | 'object-storage' | 'network' | 'control-plane' | 'warm-capacity' | 'inference';
  kind: 'charge' | 'credit';
  /** Null retains an unpriced exposure, including when the invoice residual is zero. */
  amountMicros: number | null;
  sourceRef: string;
  allocation: PoolBillAllocation;
}

export function allocatePoolBill(input: {
  periodRef: string; currency: string; totalMicros: number; lines: readonly PoolBillLine[];
}) {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const amount = (value: number, name: string, nonnegative = false): bigint => {
    if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) throw new Error(`invalid ${name}`);
    return BigInt(value);
  };
  const safe = (value: bigint): number => {
    if (value < -max || value > max) throw new Error('pool bill amount overflow');
    return Number(value);
  };
  const ref = (value: string): void => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('missing pool bill reference');
  };
  ref(input.periodRef);
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('invalid pool bill currency');
  const total = amount(input.totalMicros, 'invoice total');
  const tenantTotals = new Map<string, bigint>(), seen = new Set<string>();
  const unpricedLineIds: string[] = [], gaps: string[] = [];
  let known = 0n, overhead = 0n, unallocated = 0n, credits = 0n;
  let unpricedCharge = false, unpricedCredit = false;
  const categories = new Set(['compute', 'persistent-storage', 'provisioned-performance', 'backup',
    'object-storage', 'network', 'control-plane', 'warm-capacity', 'inference']);

  const lines = input.lines.map((line) => {
    ref(line.id); ref(line.provider); ref(line.sourceRef);
    if (seen.has(line.id)) throw new Error('duplicate pool bill line');
    seen.add(line.id);
    if (line.periodRef !== input.periodRef) throw new Error('pool bill period mismatch');
    if (line.currency !== input.currency) throw new Error('pool bill currency mismatch');
    if (!categories.has(line.category) || !['charge', 'credit'].includes(line.kind)) {
      throw new Error('invalid pool bill category or kind');
    }
    const value = line.amountMicros === null ? null : amount(line.amountMicros, 'line amount');
    if (value !== null && (line.kind === 'charge' ? value < 0n : value > 0n)) {
      throw new Error('pool bill charge/credit sign mismatch');
    }

    const weights: { tenantId: string | null; weight: bigint; remainder: bigint; share: bigint }[] = [];
    const allocation = line.allocation;
    if (allocation.kind === 'unresolved') {
      ref(allocation.reason);
      gaps.push(`unresolved-allocation:${line.id}`);
    } else {
      if (!['compute', 'weighted'].includes(allocation.kind)) throw new Error('invalid pool bill allocation');
      const tenants = new Set<string>();
      let used = 0n;
      const weightedTenants = allocation.kind === 'compute'
        ? allocation.tenants.map((tenant) => ({ tenantId: tenant.tenantId, weight: tenant.activeAgentMilliseconds }))
        : allocation.tenants;
      for (const tenant of weightedTenants) {
        ref(tenant.tenantId);
        if (tenants.has(tenant.tenantId)) throw new Error('duplicate pool bill tenant');
        tenants.add(tenant.tenantId);
        const weight = amount(tenant.weight, 'tenant allocation weight', true);
        weights.push({ tenantId: tenant.tenantId, weight, remainder: 0n, share: 0n });
        used += weight;
      }
      let shared: bigint;
      if (allocation.kind === 'compute') {
        ref(allocation.capacityEvidenceRef);
        const achieved = amount(allocation.achievedAgentMilliseconds, 'achieved agent milliseconds', true);
        if (used > achieved) throw new Error('tenant activity exceeds achieved capacity');
        shared = achieved - used;
      } else {
        shared = amount(allocation.overheadWeight, 'overhead weight', true);
      }
      // No activity does not erase a warm host, retained disk or control-plane bill.
      if (used + shared === 0n) shared = 1n;
      weights.push({ tenantId: null, weight: shared, remainder: 0n, share: 0n });
    }
    if (value === null) {
      unpricedLineIds.push(line.id);
      if (line.kind === 'charge') unpricedCharge = true;
      else unpricedCredit = true;
      gaps.push(`unpriced:${line.id}`);
      return { id: line.id, provider: line.provider, category: line.category, sourceRef: line.sourceRef,
        amountMicros: null, tenants: [], overheadMicros: null, unallocatedMicros: null };
    }
    known += value;
    if (line.kind === 'credit') credits += value;
    if (allocation.kind === 'unresolved') {
      unallocated += value;
      return { id: line.id, provider: line.provider, category: line.category, sourceRef: line.sourceRef,
        amountMicros: safe(value), tenants: [], overheadMicros: 0, unallocatedMicros: safe(value) };
    }
    const denominator = weights.reduce((sum, row) => sum + row.weight, 0n);
    const absolute = value < 0n ? -value : value;
    let remainder = absolute;
    for (const row of weights) {
      row.share = absolute * row.weight / denominator;
      row.remainder = absolute * row.weight % denominator;
      remainder -= row.share;
    }
    // Largest remainder, with a stable identifier tie break. Credits use the same
    // split with the opposite sign; neither currency micros nor overhead disappear.
    weights.sort((a, b) => a.remainder !== b.remainder ? (a.remainder > b.remainder ? -1 : 1)
      : a.tenantId === null ? (b.tenantId === null ? 0 : 1)
      : b.tenantId === null ? -1 : a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0);
    for (const row of weights) {
      if (remainder > 0n) { row.share++; remainder--; }
      if (value < 0n) row.share = -row.share;
    }
    const shared = weights.find((row) => row.tenantId === null)!.share;
    overhead += shared;
    const tenants = weights.filter((row) => row.tenantId !== null).map((row) => {
      const tenantId = row.tenantId!;
      tenantTotals.set(tenantId, (tenantTotals.get(tenantId) ?? 0n) + row.share);
      return { tenantId, amountMicros: safe(row.share) };
    }).sort((a, b) => a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0);
    return { id: line.id, provider: line.provider, category: line.category, sourceRef: line.sourceRef,
      amountMicros: safe(value), tenants, overheadMicros: safe(shared), unallocatedMicros: 0 };
  });
  const unknownRateAllocation = total - known;
  if ((!unpricedLineIds.length && unknownRateAllocation !== 0n)
    || (unknownRateAllocation > 0n && !unpricedCharge) || (unknownRateAllocation < 0n && !unpricedCredit)) {
    throw new Error('pool bill total does not reconcile to its lines');
  }
  unallocated += unknownRateAllocation;
  const tenants = [...tenantTotals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([tenantId, micros]) => ({ tenantId, amountMicros: safe(micros) }));
  const tenantTotal = [...tenantTotals.values()].reduce((sum, value) => sum + value, 0n);
  if (tenantTotal + overhead + unallocated !== total) throw new Error('pool bill allocation lost money');
  return { periodRef: input.periodRef, currency: input.currency, totalMicros: safe(total),
    tenants, tenantTotalMicros: safe(tenantTotal), overheadMicros: safe(overhead),
    unallocatedMicros: safe(unallocated), unknownRateAllocationMicros: safe(unknownRateAllocation),
    creditsMicros: safe(credits), creditsExcludedTotalMicros: unpricedLineIds.length ? null : safe(total - credits),
    complete: gaps.length === 0, unpricedLineIds, gaps, lines };
}

export function capacity(id: string): Capacity {
  const c = CAPACITY.find((x) => x.id === id);
  if (!c) throw new Error(`unknown capacity row '${id}'`);
  return c;
}

/** Server RAM after a lever that frees `savedGiB` per tenant (P-532: embed model in an idle-exiting sidecar). */
export function serverRamGiB(savedGiB = 0): number {
  if (savedGiB < 0 || savedGiB >= SERVER.ramGiB) throw new Error(`savedGiB ${savedGiB} out of range`);
  return SERVER.ramGiB - savedGiB;
}

/** Tenants per packing host: bound by usable RAM after the reserve, and by CPU. */
export function tenantsPerHost(savedGiB = 0): number {
  const { vcpus, ramGb } = parseMachineType(SERVER.packHost);
  const byRam = Math.floor((ramGb * SERVER.usableRamFraction - SERVER.reserveGiB) / serverRamGiB(savedGiB));
  const byCpu = Math.floor(vcpus / SERVER.cores);
  return Math.min(byRam, byCpu);
}

/** Server cost per workspace-month: [floor, packed]. */
export function serverMonthUsd(savedGiB = 0): { floor: number; packed: number } {
  const e2 = SPOT_PRICES_2026_10_01.e2;
  if (!e2) throw new Error('no e2 spot price');
  const floor = (SERVER.cores * e2.vcpuHour + serverRamGiB(savedGiB) * e2.gbRamHour) * HOURS_PER_MONTH;
  const packed = hostMonthUsd(SERVER.packHost, true) / tenantsPerHost(savedGiB);
  return { floor, packed };
}

export function pooledComputeUsd(agents: number, cap: Capacity, spot: boolean): number {
  return (agents * DUTY.mean * hostMonthUsd(cap.machineType, spot)) / cap.active;
}

export function dedicatedHosts(agents: number, cap: Capacity): number {
  const busyAtP99 = agents * DUTY.mean * DUTY.p99OverMean;
  return Math.max(1, Math.ceil(busyAtP99 / (cap.active - 1)));
}

export interface Scenario {
  id: string;
  label: string;
  workload: Workload;
  placement: 'dedicated' | 'pooled';
  spot: boolean;
  capacityId: string;
  /** Apply the P-532 per-tenant saving (only meaningful for pooled placement). */
  p532?: boolean;
}

/** The lever ladder: each row adds one lever to the row above it. */
export const SCENARIOS: readonly Scenario[] = [
  { id: 'M0', label: 'own VM per workspace, right-sized e2, on-demand', workload: 'mixed', placement: 'dedicated', spot: false, capacityId: 'mixed-e2s8' },
  { id: 'M1', label: '+ spot', workload: 'mixed', placement: 'dedicated', spot: true, capacityId: 'mixed-e2s8' },
  { id: 'M2', label: '+ shared pool, Servers packed (e2-standard-16 spot)', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-e2s16' },
  { id: 'M3', label: '+ lean shape e2-custom-16-32768', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-e2c16' },
  { id: 'M4', label: '+ Arm c4a-highcpu-16', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-c4ahc16' },
  { id: 'M5', label: '+ P-532 embed sidecar (Server RAM)', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-c4ahc16', p532: true },
  { id: 'H0', label: 'heavy work: shared pool, spot e2-standard-16, no levers', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16' },
  { id: 'H1', label: '+ heavy-job admission', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16-adm' },
  { id: 'H2', label: '+ shared tsc-service', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16-adm-tsc' },
  { id: 'H3', label: '+ P-532 embed sidecar (Server RAM)', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16-adm-tsc', p532: true },
];

export interface Row {
  id: string;
  label: string;
  workload: Workload;
  agents: number;
  machineType: string;
  hosts: number | null;
  computeUsd: number;
  serverUsd: { floor: number; packed: number };
  totalUsd: { floor: number; packed: number };
  perAgentUsd: { floor: number; packed: number };
  /** OWNER_BASELINE cost scaled to `agents`, divided by the packed total. */
  reductionVsBaseline: number;
  /** Graded on the packed (as-measured) total; meaningful at TARGET.agents. */
  meetsTarget: boolean;
  /** True when capacity is a lower bound, so the cost is an upper bound. */
  costIsUpperBound: boolean;
  /** True when the row needs a P-532 saving that has not been measured yet. */
  pending: boolean;
  sources: string[];
}

export function evaluate(s: Scenario, agents: number, p532SavedGiB: number | null): Row {
  const cap = capacity(s.capacityId);
  if (cap.workload !== s.workload) throw new Error(`${s.id}: capacity row ${cap.id} is ${cap.workload}, scenario is ${s.workload}`);
  const pending = !!s.p532 && p532SavedGiB === null;
  const saved = s.p532 && p532SavedGiB !== null ? p532SavedGiB : 0;
  let hosts: number | null = null;
  let computeUsd: number;
  let serverUsd: { floor: number; packed: number };
  if (s.placement === 'dedicated') {
    hosts = dedicatedHosts(agents, cap);
    computeUsd = hosts * hostMonthUsd(cap.machineType, s.spot);
    serverUsd = { floor: 0, packed: 0 };
  } else {
    computeUsd = pooledComputeUsd(agents, cap, s.spot);
    serverUsd = serverMonthUsd(saved);
  }
  const totalUsd = { floor: computeUsd + serverUsd.floor, packed: computeUsd + serverUsd.packed };
  const baseline = (OWNER_BASELINE.usdMonth / OWNER_BASELINE.agents) * agents;
  return {
    id: s.id,
    label: s.label,
    workload: s.workload,
    agents,
    machineType: cap.machineType,
    hosts,
    computeUsd,
    serverUsd,
    totalUsd,
    perAgentUsd: { floor: totalUsd.floor / agents, packed: totalUsd.packed / agents },
    reductionVsBaseline: baseline / totalUsd.packed,
    meetsTarget: totalUsd.packed <= (TARGET.googleUsdMonthMax / TARGET.agents) * agents,
    costIsUpperBound: !!cap.atLeast,
    pending,
    sources: [cap.source, DUTY.source, ...(s.placement === 'pooled' ? [SERVER.source, 'D-022'] : [])],
  };
}

export function buildRows(agents: number, p532SavedGiB: number | null): Row[] {
  return SCENARIOS.map((s) => evaluate(s, agents, p532SavedGiB));
}

const usd = (n: number) => n.toFixed(n < 10 ? 2 : 0);

const MONTH_COST_KEYS = ['retainedStorageUsd', 'provisionedPerformanceUsd', 'backupUsd',
  'objectStorageUsd', 'networkUsd', 'controlUsd', 'warmCapacityUsd', 'inferenceUsd'] as const;

/** Supporting comparison inputs, not an activated tariff or a qualified trial profile.
 * Each value is the additional monthly cost beyond the legacy compute/Server row;
 * do not count a disk or a warm Server already included in that row twice.
 * Omitted/null costs stay unknown. Explicit zero, like any supplied value, needs a source.
 */
export type CostReportMonth = Partial<Record<typeof MONTH_COST_KEYS[number], number | null>> & {
  /** Sum of actual busy time across agents, not VM running hours or assigned slots. */
  busyAgentHours?: number;
  /** Binds the supplied monthly inputs/usage to their evidence; no inference from its presence. */
  sourceRef?: string;
};

export function pricingComparison(rows: Row[], month: CostReportMonth = {}) {
  if (!month || typeof month !== 'object' || Array.isArray(month)) throw new Error('report-month must be an object');
  if (month.busyAgentHours === null) throw new Error('invalid busyAgentHours');
  const supplied = [...MONTH_COST_KEYS, 'busyAgentHours' as const].some((key) => month[key] != null);
  if (supplied && (typeof month.sourceRef !== 'string' || !month.sourceRef.trim())) {
    throw new Error('monthly comparison inputs require sourceRef');
  }
  for (const key of [...MONTH_COST_KEYS, 'busyAgentHours' as const]) {
    const value = month[key];
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error(`invalid ${key}`);
  }
  const missingCosts = MONTH_COST_KEYS.filter((key) => month[key] == null);
  const infrastructureKeys = MONTH_COST_KEYS.filter((key) => key !== 'inferenceUsd');
  const additionalInfrastructureUsd = infrastructureKeys.some((key) => month[key] == null)
    ? null : infrastructureKeys.reduce((sum, key) => sum + month[key]!, 0);
  const inferenceUsd = month.inferenceUsd ?? null;
  const total = (core: number) => additionalInfrastructureUsd === null || inferenceUsd === null
    ? null : core + additionalInfrastructureUsd + inferenceUsd;
  // Dedicated VM costs are lumpy: dividing them into a metered pool rate would imply
  // packing/reclaim behavior those measurements do not establish.
  return rows.filter((row) => row.hosts === null).map((row) => {
    if (!Number.isSafeInteger(row.agents) || row.agents < 1) throw new Error('invalid assigned agents');
    for (const value of [row.serverUsd.packed, row.computeUsd]) {
      if (!Number.isFinite(value) || value < 0) throw new Error('invalid comparison cost');
    }
    const assignedAgentMonthUsd = row.computeUsd / row.agents;
    const busyAgentHourUsd = assignedAgentMonthUsd / (HOURS_PER_MONTH * DUTY.mean);
    const busyAgentHours = month.busyAgentHours ?? row.agents * HOURS_PER_MONTH * DUTY.mean;
    if (busyAgentHours > row.agents * HOURS_PER_MONTH) throw new Error('busy agent hours exceed assigned population month');
    const basePlusAgentCoreUsd = row.serverUsd.packed + row.computeUsd;
    const busyHoursCoreUsd = row.serverUsd.packed + busyAgentHours * busyAgentHourUsd;
    const basePlusAgentTotalUsd = total(basePlusAgentCoreUsd);
    const busyHoursTotalUsd = total(busyHoursCoreUsd);
    for (const value of [additionalInfrastructureUsd, basePlusAgentCoreUsd, busyHoursCoreUsd,
      basePlusAgentTotalUsd, busyHoursTotalUsd]) {
      if (value !== null && !Number.isFinite(value)) throw new Error('comparison total overflow');
    }
    return { id: row.id, assignedAgents: row.agents, baseServerUsd: row.serverUsd.packed,
      assignedAgentMonthUsd, busyAgentHourUsd, busyAgentHours,
      busyHoursModeled: month.busyAgentHours === undefined,
      basePlusAgentCoreUsd, busyHoursCoreUsd, additionalInfrastructureUsd, inferenceUsd,
      basePlusAgentTotalUsd, busyHoursTotalUsd, missingCosts, pending: row.pending,
      costIsUpperBound: row.costIsUpperBound, sources: row.sources, inputSourceRef: month.sourceRef ?? null };
  });
}

export function renderMarkdown(rows: Row[], month: CostReportMonth = {}): string {
  const out = [
    'Historical compute + Server cost basis (USD/month). The target below is D-003, not the all-in trial acceptance gate.',
    '',
    `| id | lever combination | shape | compute | Server (floor-packed) | total (floor-packed) | per agent | x vs ${OWNER_BASELINE.usdMonth}/${OWNER_BASELINE.agents} | target |`,
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const ub = r.costIsUpperBound ? '<=' : '';
    const tgt = r.pending ? 'PENDING P-532' : r.meetsTarget ? 'yes' : 'no';
    const hosts = r.hosts === null ? '' : ` x${r.hosts}`;
    out.push(
      `| ${r.id} | ${r.label} | ${r.machineType}${hosts} | ${ub}${usd(r.computeUsd)} | ${usd(r.serverUsd.floor)}-${usd(r.serverUsd.packed)} | ${ub}${usd(r.totalUsd.floor)}-${usd(r.totalUsd.packed)} | ${ub}${usd(r.perAgentUsd.floor)}-${usd(r.perAgentUsd.packed)} | ${r.reductionVsBaseline.toFixed(1)}x | ${tgt} |`,
    );
  }
  const comparison = pricingComparison(rows, month);
  const money = (value: number | null) => value === null ? 'UNKNOWN' : value.toFixed(2);
  out.push('', '## Pricing alternatives (cost basis; no customer price activated)', '',
    'Base plus agent = packed Server base + assigned agents × agent-month cost. Busy-hours = the same base + summed busy-agent-hours × busy-agent-hour cost.',
    'Rates reuse achieved capacity and D-038 duty. Default busy hours are modeled at 35% duty, not observed usage. Dedicated VM rows are excluded because their host costs are lumpy.',
    'Additional infrastructure and inference are separate monthly inputs. Missing categories keep both all-in totals UNKNOWN; explicit zero requires a source. PENDING and capacity-bound rows retain their qualification limits.', '',
    '| id | base Server | per assigned agent/month | per busy-agent-hour | busy-agent-hours | base + agent core | busy-hours core | extra infrastructure | inference | base + agent all-in | busy-hours all-in | status |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of comparison) {
    out.push(`| ${r.id} | ${money(r.baseServerUsd)} | ${money(r.assignedAgentMonthUsd)} | ${r.busyAgentHourUsd.toFixed(6)} | ${r.busyAgentHours.toFixed(2)} (${r.busyHoursModeled ? 'modeled' : 'supplied'}) | ${money(r.basePlusAgentCoreUsd)} | ${money(r.busyHoursCoreUsd)} | ${money(r.additionalInfrastructureUsd)} | ${money(r.inferenceUsd)} | ${money(r.basePlusAgentTotalUsd)} | ${money(r.busyHoursTotalUsd)} | ${r.pending ? 'PENDING P-532' : 'supporting model'}${r.costIsUpperBound ? '; capacity lower bound' : ''} |`);
  }
  out.push('');
  for (const r of comparison) {
    out.push(`Inputs ${r.id}: ${r.sources.join('; ')}; monthly inputs: ${r.inputSourceRef ?? 'not supplied'}; unknown: ${r.missingCosts.join(', ') || 'none'}.`);
  }
  return out.join('\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && /cost-model\.ts$/.test(process.argv[1])) {
  const agents = Number(arg('agents') ?? TARGET.agents);
  const savedArg = arg('p532-saved-gib');
  const rows = buildRows(agents, savedArg === undefined ? null : Number(savedArg));
  const reportPath = arg('report-month');
  const month: CostReportMonth = reportPath === undefined ? {} : JSON.parse(readFileSync(reportPath, 'utf8'));
  if (!month || typeof month !== 'object' || Array.isArray(month)) throw new Error('report-month must be an object');
  console.log(process.argv.includes('--json')
    ? JSON.stringify(reportPath === undefined ? rows : { rows, pricing: pricingComparison(rows, month) }, null, 2)
    : renderMarkdown(rows, month));
}
