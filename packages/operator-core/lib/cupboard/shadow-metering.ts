/**
 * agent-economy-flywheel P-003 (E1, WI-10004287): shadow metering, identity-first.
 *
 * Turns identity-attributed inference usage into per-workspace monthly "what this would have
 * cost" statements. NOTHING here bills: a statement is the price-sheet exercise plus the evidence
 * for (or against) the claim that attribution is clean enough to bill on.
 *
 * Billing model (plan decisions D-005, D-007, D-009):
 * - Buyers run identities on their own model accounts (BYOC), so the Cupboard charge is the
 *   identity markup only. Inference cost is shown as the base the markup is computed on.
 * - Each PRICED identity layer bills its own markup line on the session's inference (stacking).
 *   The DAO receives 10% of every markup as its own line; the seller side gets the rest.
 * - Axis-slot layers (modes, fleet posture), the kernel and the compatibility source bill 0.
 * - Non-inference identity activity (tool calls) is priced 0 and reported as counts only.
 *
 * Money is integer micro-USD throughout so every split is exact:
 *   markup = floor(base * markupBps / 10000), dao = floor(markup * daoShareBps / 10000),
 *   seller = markup - dao.
 * Rounding happens once per statement line (on the aggregated base), never per sample.
 *
 * This module is pure. The Postgres reader that produces `ShadowUsageAggregate` rows lives
 * beside it; keep it free of I/O so the pricing rules stay unit-testable.
 */

export const SHADOW_MARKUP_SHEET_VERSION = 'e1-2026-09-30';

/** How a priced line's identity was established. Only `specification-layer` is bill-grade. */
export type ShadowIdentityBasis = 'specification-layer' | 'inferred-profile';

export interface ShadowMarkupSheet {
  version: string;
  /** Markup the listing form suggests (D-007 point 3): 20% of inference cost. */
  suggestedMarkupBps: number;
  /** The DAO's share of every markup payment (D-007 point 3): 1000 bps = 10%. */
  daoShareBps: number;
  /**
   * A specification input ref with this prefix is a named profession layer — the listable,
   * priced identity. Each one bills its own markup line (D-009 point 3).
   */
  pricedSpecificationLayerPrefix: string;
  /**
   * Stand-in classes for sessions whose specification carries no named profession layer yet.
   * Keyed by launch-spec `profile`. A line priced this way is marked `inferred-profile` and keeps
   * the statement from being bill-grade.
   */
  profileClasses: Readonly<Record<string, { identityClass: string; markupBps: number }>>;
  /** Cost sources that are bill-grade. `estimated` is not: D-005 prices on billed cost. */
  billGradeCostSources: readonly string[];
  /** Minimum share (bps of inference cost) that must be attributed / bill-grade. */
  billGradeMinShareBps: number;
}

/**
 * The E1 sheet. Measured 2026-09-30 over the prior 30 days: every identity-attributed session
 * ran launch-spec profile `engineer` (codex 608 sessions, claude 523; 8 had no launch spec) and
 * every sampled cost row was `estimated`, so no statement is bill-grade yet.
 *
 * Specifications name the profession layer by its bare id (`papercusp-engineer`) and mark it by
 * the `domain` slot its document fills, so the reader slot-qualifies refs to `domain:<id>` before
 * they reach this sheet. Of 241 recent launch records, 125 carried `domain:papercusp-engineer`;
 * the rest ran the `launch-adapter-compatibility` source and price as `inferred-profile`.
 */
export const SHADOW_MARKUP_SHEET: ShadowMarkupSheet = Object.freeze({
  version: SHADOW_MARKUP_SHEET_VERSION,
  suggestedMarkupBps: 2000,
  daoShareBps: 1000,
  pricedSpecificationLayerPrefix: 'domain:',
  profileClasses: Object.freeze({
    engineer: Object.freeze({ identityClass: 'papercusp-engineer', markupBps: 2000 }),
  }),
  billGradeCostSources: Object.freeze(['billed']),
  billGradeMinShareBps: 9900,
});

/** One reader row: inference usage aggregated per workspace, month and identity context. */
export interface ShadowUsageAggregate {
  workspaceId: string;
  /** UTC calendar month, `YYYY-MM`. */
  month: string;
  /** True when the usage fell inside an identity activation span. */
  attributed: boolean;
  /** Launch-spec agent/profile of the attributed session (null when unknown). */
  agent: string | null;
  profile: string | null;
  /**
   * Slot-qualified refs (`<slot>:<layer id>`, e.g. `domain:papercusp-engineer`) of the applied
   * specification's blueprint layers that fill an identity slot. Unslotted layers (the base
   * blueprint, the pot, the compatibility source) carry no identity and are omitted.
   */
  specificationLayerRefs: readonly string[];
  /** Applied axis-slot layer refs (identity_stack_refs): modes and fleet posture. */
  axisLayerRefs: readonly string[];
  costSource: string | null;
  costMicros: number;
  samples: number;
}

/** One reader row: tool invocations per workspace and month, split by attribution. */
export interface ShadowToolAggregate {
  workspaceId: string;
  month: string;
  attributed: boolean;
  calls: number;
}

export interface ShadowIdentityClass {
  identityClass: string;
  markupBps: number;
  basis: ShadowIdentityBasis;
}

export interface ShadowStatementLine {
  identityClass: string;
  basis: ShadowIdentityBasis;
  markupBps: number;
  /** Inference cost the markup is computed on. */
  baseMicros: number;
  markupMicros: number;
  daoMicros: number;
  sellerMicros: number;
  samples: number;
}

export type ShadowCleanlinessReason =
  | 'no-usage'
  | 'unattributed-cost'
  | 'estimated-cost'
  | 'inferred-base-identity'
  | 'unclassified-identity';

export interface ShadowCleanliness {
  verdict: 'bill-grade' | 'not-bill-grade';
  reasons: ShadowCleanlinessReason[];
  /** Shares are basis points of total inference cost (floor). */
  attributedShareBps: number;
  billGradeCostShareBps: number;
  /** Share of ATTRIBUTED cost priced from an inferred profile rather than a spec layer. */
  inferredShareBps: number;
  unattributedMicros: number;
  unclassifiedMicros: number;
}

export interface ShadowStatement {
  sheetVersion: string;
  workspaceId: string;
  month: string;
  inference: { costMicros: number; billGradeMicros: number; samples: number };
  lines: ShadowStatementLine[];
  totals: {
    markupMicros: number;
    daoMicros: number;
    sellerMicros: number;
    /** BYOC: the Cupboard would have charged the markup only (D-007 point 1). */
    wouldHaveChargedMicros: number;
  };
  /** Priced at zero by design (D-009 points 3–4); reported so the statement stays itemized. */
  zeroPriced: {
    axisLayers: Array<{ layerRef: string; baseMicros: number }>;
    toolCalls: { attributed: number; unattributed: number };
  };
  cleanliness: ShadowCleanliness;
}

/** Classes a usage row is priced under. Empty when attributed but unclassifiable. */
export function classifyShadowIdentity(
  row: Pick<ShadowUsageAggregate, 'attributed' | 'profile' | 'specificationLayerRefs'>,
  sheet: ShadowMarkupSheet = SHADOW_MARKUP_SHEET,
): ShadowIdentityClass[] {
  if (!row.attributed) return [];
  const specLayers = [...new Set(row.specificationLayerRefs)]
    .filter((ref) => ref.startsWith(sheet.pricedSpecificationLayerPrefix))
    .sort();
  if (specLayers.length > 0) {
    return specLayers.map((ref) => ({
      identityClass: ref,
      markupBps: sheet.suggestedMarkupBps,
      basis: 'specification-layer' as const,
    }));
  }
  const byProfile = row.profile ? sheet.profileClasses[row.profile] : undefined;
  if (byProfile) {
    return [{ identityClass: byProfile.identityClass, markupBps: byProfile.markupBps, basis: 'inferred-profile' }];
  }
  return [];
}

/** Exact integer split of one line's markup. */
export function splitShadowMarkup(
  baseMicros: number,
  markupBps: number,
  daoShareBps: number,
): { markupMicros: number; daoMicros: number; sellerMicros: number } {
  assertNonNegativeInteger(baseMicros, 'baseMicros');
  assertBps(markupBps, 'markupBps');
  assertBps(daoShareBps, 'daoShareBps');
  const markupMicros = Math.floor((baseMicros * markupBps) / 10_000);
  const daoMicros = Math.floor((markupMicros * daoShareBps) / 10_000);
  return { markupMicros, daoMicros, sellerMicros: markupMicros - daoMicros };
}

/** Convert a reader's USD float to integer micro-USD. */
export function usdToMicros(usd: number | null | undefined): number {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 1_000_000);
}

/** Build one statement per (workspace, month) present in either input. */
export function buildShadowStatements(
  usage: readonly ShadowUsageAggregate[],
  tools: readonly ShadowToolAggregate[] = [],
  sheet: ShadowMarkupSheet = SHADOW_MARKUP_SHEET,
): ShadowStatement[] {
  interface Acc {
    workspaceId: string;
    month: string;
    costMicros: number;
    billGradeMicros: number;
    samples: number;
    attributedMicros: number;
    inferredMicros: number;
    unclassifiedMicros: number;
    lines: Map<string, { cls: ShadowIdentityClass; baseMicros: number; samples: number }>;
    axis: Map<string, number>;
    toolsAttributed: number;
    toolsUnattributed: number;
  }
  const groups = new Map<string, Acc>();
  const accFor = (workspaceId: string, month: string): Acc => {
    const key = `${workspaceId}\u0000${month}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        workspaceId,
        month,
        costMicros: 0,
        billGradeMicros: 0,
        samples: 0,
        attributedMicros: 0,
        inferredMicros: 0,
        unclassifiedMicros: 0,
        lines: new Map(),
        axis: new Map(),
        toolsAttributed: 0,
        toolsUnattributed: 0,
      };
      groups.set(key, acc);
    }
    return acc;
  };

  for (const row of usage) {
    assertNonNegativeInteger(row.costMicros, 'costMicros');
    const acc = accFor(row.workspaceId, row.month);
    acc.costMicros += row.costMicros;
    acc.samples += row.samples;
    if (row.costSource && sheet.billGradeCostSources.includes(row.costSource)) acc.billGradeMicros += row.costMicros;
    if (!row.attributed) continue;
    acc.attributedMicros += row.costMicros;
    for (const ref of new Set(row.axisLayerRefs)) acc.axis.set(ref, (acc.axis.get(ref) ?? 0) + row.costMicros);
    const classes = classifyShadowIdentity(row, sheet);
    if (classes.length === 0) {
      acc.unclassifiedMicros += row.costMicros;
      continue;
    }
    if (classes.some((c) => c.basis === 'inferred-profile')) acc.inferredMicros += row.costMicros;
    for (const cls of classes) {
      const key = `${cls.identityClass}\u0000${cls.basis}\u0000${cls.markupBps}`;
      const line = acc.lines.get(key) ?? { cls, baseMicros: 0, samples: 0 };
      line.baseMicros += row.costMicros;
      line.samples += row.samples;
      acc.lines.set(key, line);
    }
  }
  for (const row of tools) {
    const acc = accFor(row.workspaceId, row.month);
    if (row.attributed) acc.toolsAttributed += row.calls;
    else acc.toolsUnattributed += row.calls;
  }

  const statements: ShadowStatement[] = [];
  for (const acc of groups.values()) {
    const lines: ShadowStatementLine[] = [...acc.lines.values()]
      .map(({ cls, baseMicros, samples }) => ({
        identityClass: cls.identityClass,
        basis: cls.basis,
        markupBps: cls.markupBps,
        baseMicros,
        samples,
        ...splitShadowMarkup(baseMicros, cls.markupBps, sheet.daoShareBps),
      }))
      .sort((a, b) => a.identityClass.localeCompare(b.identityClass) || a.basis.localeCompare(b.basis));
    const markupMicros = sum(lines.map((l) => l.markupMicros));
    const daoMicros = sum(lines.map((l) => l.daoMicros));
    statements.push({
      sheetVersion: sheet.version,
      workspaceId: acc.workspaceId,
      month: acc.month,
      inference: { costMicros: acc.costMicros, billGradeMicros: acc.billGradeMicros, samples: acc.samples },
      lines,
      totals: {
        markupMicros,
        daoMicros,
        sellerMicros: markupMicros - daoMicros,
        wouldHaveChargedMicros: markupMicros,
      },
      zeroPriced: {
        axisLayers: [...acc.axis.entries()]
          .map(([layerRef, baseMicros]) => ({ layerRef, baseMicros }))
          .sort((a, b) => a.layerRef.localeCompare(b.layerRef)),
        toolCalls: { attributed: acc.toolsAttributed, unattributed: acc.toolsUnattributed },
      },
      cleanliness: assessCleanliness(acc, sheet),
    });
  }
  return statements.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.month.localeCompare(b.month));
}

function assessCleanliness(
  acc: { costMicros: number; billGradeMicros: number; attributedMicros: number; inferredMicros: number; unclassifiedMicros: number },
  sheet: ShadowMarkupSheet,
): ShadowCleanliness {
  const reasons: ShadowCleanlinessReason[] = [];
  const attributedShareBps = shareBps(acc.attributedMicros, acc.costMicros);
  const billGradeCostShareBps = shareBps(acc.billGradeMicros, acc.costMicros);
  const inferredShareBps = shareBps(acc.inferredMicros, acc.attributedMicros);
  if (acc.costMicros === 0) reasons.push('no-usage');
  else {
    if (attributedShareBps < sheet.billGradeMinShareBps) reasons.push('unattributed-cost');
    if (billGradeCostShareBps < sheet.billGradeMinShareBps) reasons.push('estimated-cost');
    if (acc.inferredMicros > 0) reasons.push('inferred-base-identity');
    if (acc.unclassifiedMicros > 0) reasons.push('unclassified-identity');
  }
  return {
    verdict: reasons.length === 0 ? 'bill-grade' : 'not-bill-grade',
    reasons,
    attributedShareBps,
    billGradeCostShareBps,
    inferredShareBps,
    unattributedMicros: acc.costMicros - acc.attributedMicros,
    unclassifiedMicros: acc.unclassifiedMicros,
  };
}

function shareBps(part: number, whole: number): number {
  return whole > 0 ? Math.floor((part * 10_000) / whole) : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`shadow-metering: ${name} must be a non-negative safe integer (got ${value})`);
  }
}

function assertBps(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(`shadow-metering: ${name} must be an integer in 0..10000 (got ${value})`);
  }
}
