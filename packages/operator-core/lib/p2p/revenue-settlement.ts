/** Deterministic, non-custodial DAO revenue settlement arithmetic (P-018). */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';

export type RevenueShare = 'creator' | 'host' | 'component' | 'dao' | 'reserve' | 'tax' | 'operating';
export const REVENUE_SHARES: readonly RevenueShare[] = ['creator', 'host', 'component', 'dao', 'reserve', 'tax', 'operating'] as const;
export type RevenueSplitManifest = { readonly version: string; readonly manifestHash: string; readonly sharesBps: Readonly<Record<RevenueShare, number>> };

export type SettlementRefusalCode = 'invalid-amount' | 'invalid-split' | 'split-overflow' | 'missing-treasury' | 'cost-exceeds-gross';

export function validateRevenueSplit(manifest: RevenueSplitManifest): { ok: true } | { ok: false; code: SettlementRefusalCode; detail: string } {
  if (!manifest.version.trim() || !manifest.manifestHash.trim()) return { ok: false, code: 'invalid-split', detail: 'split version and manifestHash are required' };
  let sum = 0;
  for (const share of REVENUE_SHARES) {
    const bps = manifest.sharesBps[share];
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) return { ok: false, code: 'invalid-split', detail: `${share} share must be an integer basis-point value` };
    sum += bps;
  }
  if (sum > 10_000) return { ok: false, code: 'split-overflow', detail: `revenue split sums to ${sum} bps, above 10000` };
  return { ok: true };
}

/**
 * Derive the canonical `sha256:<64 hex>` manifest hash for a split.
 *
 * The hash is what a per-use offer's terms commit to (`splitManifestHash` on
 * the voucher, verified in `metered-invocation.ts`), so a settlement can only
 * apply a split the payer actually signed for if BOTH sides derive the hash the
 * same way. That is why it is computed here rather than configured alongside
 * the shares: a hand-written hash could disagree with its own body.
 */
export function revenueSplitManifest(input: {
  readonly version: string;
  readonly sharesBps: Readonly<Record<RevenueShare, number>>;
}): RevenueSplitManifest {
  const body: Record<string, unknown> = { version: input.version };
  const shares: Record<string, number> = {};
  for (const share of REVENUE_SHARES) shares[share] = input.sharesBps[share];
  body.sharesBps = shares;
  const digest = createHash('sha256').update(canonicalJson(body)).digest('hex');
  return { version: input.version, manifestHash: `sha256:${digest}`, sharesBps: input.sharesBps };
}

export interface SettlementReceipt {
  readonly settlementId: string;
  readonly currency: 'stablecoin-micros';
  readonly grossMicros: bigint;
  readonly providerCostMicros: bigint;
  readonly distributableMicros: bigint;
  readonly allocationsMicros: Readonly<Record<RevenueShare, bigint>>;
  readonly daoTreasury: string;
  readonly splitManifestHash: string;
  readonly receiptHash: string;
}

export type SettlementResult = { readonly ok: true; readonly receipt: SettlementReceipt } | { readonly ok: false; readonly code: SettlementRefusalCode; readonly detail: string };

function serializeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInts);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeBigInts(v)]));
  return value;
}

function receiptDigest(input: Omit<SettlementReceipt, 'receiptHash'>): string {
  return createHash('sha256').update(canonicalJson(serializeBigInts(input))).digest('hex');
}

/** Compute integer allocations. Any rounding remainder is assigned to the DAO. */
export function settleRevenue(input: {
  settlementId: string;
  grossMicros: bigint;
  providerCostMicros: bigint;
  splitManifest: RevenueSplitManifest;
  daoTreasury: string;
}): SettlementResult {
  if (!input.settlementId.trim() || input.grossMicros < 0n || input.providerCostMicros < 0n) return { ok: false, code: 'invalid-amount', detail: 'settlement id and amounts must be valid' };
  if (!input.daoTreasury.trim()) return { ok: false, code: 'missing-treasury', detail: 'DAO treasury wallet is required for settlement' };
  const split = validateRevenueSplit(input.splitManifest);
  if (!split.ok) return split;
  if (input.providerCostMicros > input.grossMicros) return { ok: false, code: 'cost-exceeds-gross', detail: 'provider cost cannot exceed gross amount' };
  const distributableMicros = input.grossMicros - input.providerCostMicros;
  const allocations = {} as Record<RevenueShare, bigint>;
  let allocated = 0n;
  for (const share of REVENUE_SHARES) {
    const amount = (distributableMicros * BigInt(input.splitManifest.sharesBps[share]!)) / 10_000n;
    allocations[share] = amount;
    allocated += amount;
  }
  allocations.dao += distributableMicros - allocated;
  const base: Omit<SettlementReceipt, 'receiptHash'> = {
    settlementId: input.settlementId,
    currency: 'stablecoin-micros',
    grossMicros: input.grossMicros,
    providerCostMicros: input.providerCostMicros,
    distributableMicros,
    allocationsMicros: allocations,
    daoTreasury: input.daoTreasury,
    splitManifestHash: input.splitManifest.manifestHash,
  };
  return { ok: true, receipt: { ...base, receiptHash: receiptDigest(base) } };
}
