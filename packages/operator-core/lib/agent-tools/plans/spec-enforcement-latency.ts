/**
 * P-013 instrumentation, measure 6 — CLAIM-TO-COMPLETION LATENCY on the work-item axis.
 *
 * The plan-side reconciliation ledger (`spec-reconciliation.ts`) answers "for how many plans
 * can a clause gate refuse, and why not for the rest". It cannot answer the question this
 * module exists for: once enforcement DOES reach an item, how long does that item take. The
 * two axes are deliberately separate surfaces — folding a per-item duration into a per-plan
 * ledger row is what makes a plan census quietly start reporting an item statistic.
 *
 * ## The partition IS the measure
 *
 * A bare median claim-to-completion says nothing about enforcement: every item in the corpus
 * has one, enforced or not. The number only becomes evidence when it is split by whether the
 * item's plan was ENFORCEMENT-ELIGIBLE at all, which is why `byEnforcement` is the primary
 * shape here and the ungrouped total is not reported at the top level. The split is computed
 * through `enforcementEligibility` — the same function the gates and the reconciliation ledger
 * use — so "enforced" cannot come to mean one thing here and another at the gate.
 *
 * ## Four measured hazards this shape refuses to hide
 *
 * 1. **`taken_at` is overwritten on every reclaim** (`work-items.ts`: the claim path sets
 *    `taken_at = now(), last_progress_at = NULL`). A duration measured from it is therefore
 *    time-since-LAST-claim, not time-since-first-claim, and on a re-claimed item those differ
 *    by however long the first agent held it. So the append-only `claim_audit` ledger is the
 *    PREFERRED source and the column is only a fallback — with `claimInstantSource` stamped on
 *    every row and counted in the rollup, so a column-derived duration can never be read as a
 *    ledger-backed one. This is the same tiered-evidence discipline `planItemLanded` already
 *    applies to plan-item links.
 * 2. **The claim ledger does not reach back forever.** Items claimed before the ledger began
 *    have no row and fall to the fallback. That is a coverage fact about the instrument, so it
 *    is reported (`byClaimInstantSource`) rather than absorbed into the numbers.
 * 3. **`work_items` holds agents' end-of-turn notes under `lane = 'observation'`.** Counting
 *    those as claimed work inflated a measured 518 real filings into 1001. They are excluded
 *    here and the excluded count is reported, so the exclusion is visible rather than assumed.
 * 4. **`closed_ts` is epoch MILLISECONDS while `taken_at` / `last_progress_at` are
 *    `timestamptz`.** Mixing them silently yields a number ~1000x wrong that still looks like a
 *    duration. Every field this module produces is named `…Ms` and the reader type demands
 *    milliseconds for all four instants, so the conversion happens once, at the edge.
 *
 * ## What is deliberately NOT reported
 *
 * P-013 names "claim-to-checkpoint" latency. It is NOT derivable from current storage and is
 * therefore declared in `notDerivable` rather than approximated: a work-item checkpoint is
 * written in place with no append-only history, and `last_progress_at` is reset to `now()` on
 * EVERY progress mark, so the only available instant is the LAST one. Reporting that under a
 * "first checkpoint" label would be a different measurement wearing the requested name — the
 * exact substitution this plan's instrumentation exists to catch. `claimToLastProgress` is
 * reported under its true name instead, and the gap is stated in-band.
 */
import {
  enforcementEligibility,
  type AdoptionState,
  type PlanAdoptionRow,
  type ReconciliationLane,
} from './spec-enforcement-eligibility';
// The SAME plan population the reconciliation ledger censuses. Reused rather than re-queried so
// the two surfaces cannot disagree about which plans are enforcing.
import { defaultListPlanAdoption } from './spec-reconciliation';

/** Which record established an item's first-claim instant. Never merged into one number. */
export type ClaimInstantSource =
  /** The append-only `claim_audit` ledger — correct across reclaims. */
  | 'claim-ledger'
  /** `work_items.taken_at`, which the claim path overwrites: time-since-LAST-claim. */
  | 'taken-at-column';

/**
 * How an item maps onto the enforcement partition.
 *
 * `unattributed` is its own member and is NEVER folded into `not-enforced`: an item with no
 * resolvable plan has an UNKNOWN enforcement state, and merging unknown into a negative would
 * let "we could not tell" be reported as "enforcement did not apply".
 */
export type EnforcementBucket = 'enforced' | 'not-enforced' | 'unattributed';

/**
 * The lifecycle fields this module reads, in the units it reads them in.
 *
 * Declared in full ON PURPOSE. A reader type that under-declares what the real reader returns
 * is how a partition goes vacuous: the extra fields still arrive at runtime, but a key read off
 * the narrow type accumulates under `undefined`, producing a populated-looking census that
 * reconciles against nothing — and tsc cannot see it, because the value really is there. The
 * cost of declaring every field is that every fixture must supply it, which is the point.
 */
export interface WorkItemLifecycleRow {
  workItemId: string;
  /** The plan this item came from, or null when it was filed ad-hoc. */
  sourcePlanSlug: string | null;
  /** `work_items.lane` — 'observation' rows are agents' turn-end notes, not claimed work. */
  lane: string | null;
  status: string | null;
  /** `work_items.taken_at`, converted to epoch ms at the edge. Overwritten on reclaim. */
  takenAtMs: number | null;
  /** `work_items.last_progress_at`, epoch ms. LAST progress mark, not the first. */
  lastProgressAtMs: number | null;
  /** `work_items.closed_ts` — already epoch ms in storage, unlike its timestamptz siblings. */
  closedAtMs: number | null;
}

/** One item's first WON claim, from the append-only ledger. */
export interface FirstClaimRow {
  workItemId: string;
  firstWonAtMs: number;
}

export interface LatencyDistribution {
  /** How many items contributed a duration. Zero means UNMEASURED, never "instant". */
  n: number;
  p50Ms: number | null;
  p90Ms: number | null;
  maxMs: number | null;
}

export interface LatencyLane {
  /** Items in this bucket, including ones that contributed no duration. */
  items: number;
  /** First claim → `closed_ts`. Only closed items contribute. */
  claimToCompletion: LatencyDistribution;
  /**
   * First claim → LAST progress mark. Deliberately not called "claim to checkpoint": see
   * `notDerivable`. Only items carrying a progress mark contribute.
   */
  claimToLastProgress: LatencyDistribution;
}

/** A measure the plan asked for that current storage cannot support, stated in-band. */
export interface NotDerivableMeasure {
  measure: string;
  reason: string;
}

export interface SpecEnforcementLatencyRow {
  workItemId: string;
  planSlug: string | null;
  bucket: EnforcementBucket;
  /** Null when the item is `unattributed` — there is no plan to classify. */
  lane: ReconciliationLane | null;
  adoption: AdoptionState | null;
  claimedAtMs: number;
  claimInstantSource: ClaimInstantSource;
  claimToCompletionMs: number | null;
  claimToLastProgressMs: number | null;
}

export interface SpecEnforcementLatencyRollup {
  /** Items that survived every exclusion below and carried a usable claim instant. */
  itemsMeasured: number;
  byEnforcement: Record<EnforcementBucket, LatencyLane>;
  /**
   * How each measured item's claim instant was established. A large `taken-at-column` term
   * means most durations are time-since-LAST-claim, which caps how strongly the medians above
   * may be read — so it is reported beside them, not in a footnote.
   */
  byClaimInstantSource: Record<ClaimInstantSource, number>;
  /** Every row dropped before measurement, by why. Never silently absorbed. */
  excluded: {
    /** `lane = 'observation'` — turn-end notes, not claimed work. */
    observations: number;
    /** Never claimed by anyone: no ledger row and no `taken_at`. */
    neverClaimed: number;
    /** Claimed, but the closing instant precedes the claim — unusable, never clamped to 0. */
    negativeDuration: number;
  };
  notDerivable: readonly NotDerivableMeasure[];
  bounded: {
    itemLimit: number;
    itemsRead: number;
    /** EITHER limit ⇒ every count above is a FLOOR, not a total. */
    truncatedByItemLimit: boolean;
    countsAreFloor: boolean;
  };
}

export interface SpecEnforcementLatencyLedger {
  rows: SpecEnforcementLatencyRow[];
  rollup: SpecEnforcementLatencyRollup;
}

export interface SpecEnforcementLatencyDeps {
  listWorkItemLifecycle?: (input: {
    harnessSlug?: string;
    limit: number;
  }) => Promise<WorkItemLifecycleRow[]>;
  listFirstClaims?: (input: {
    harnessSlug?: string;
    workItemIds: string[];
  }) => Promise<FirstClaimRow[]>;
  listPlanAdoption?: (input: { harnessSlug?: string; limit: number }) => Promise<PlanAdoptionRow[]>;
}

export const LATENCY_ITEM_LIMIT = 20_000;
export const LATENCY_PLAN_LIMIT = 2_000;

/**
 * Measures P-013 asks for that current storage cannot support. Exported so a caller can assert
 * on the gap rather than rediscovering it, and so removing a limitation is a visible edit here.
 */
export const LATENCY_NOT_DERIVABLE: readonly NotDerivableMeasure[] = [
  {
    measure: 'claim-to-first-checkpoint',
    reason:
      'A work-item checkpoint is written in place with no append-only history, and ' +
      'work_items.last_progress_at is reset to now() on EVERY progress mark, so only the LAST ' +
      'progress instant survives. claimToLastProgress is reported under its true name instead; ' +
      'reading it as a first-checkpoint latency would overstate how quickly work is grounded.',
  },
] as const;

/** Nearest-rank percentile over an ASCENDING array. Returns null for an empty sample. */
function percentile(sortedAsc: readonly number[], fraction: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index] ?? null;
}

function distributionOf(samples: number[]): LatencyDistribution {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    maxMs: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
  };
}

function emptyLane(): { items: number; completion: number[]; lastProgress: number[] } {
  return { items: 0, completion: [], lastProgress: [] };
}

/**
 * Compute claim-to-completion latency partitioned by enforcement eligibility.
 *
 * Deps are injected so this is testable without a database — and so the reader type above,
 * not an incidental SQL projection, is what defines the fields this computation may read.
 */
export async function computeSpecEnforcementLatency(
  deps: SpecEnforcementLatencyDeps,
  opts: { harnessSlug?: string; itemLimit?: number } = {},
): Promise<SpecEnforcementLatencyLedger> {
  const itemLimit = opts.itemLimit ?? LATENCY_ITEM_LIMIT;
  const listWorkItemLifecycle = deps.listWorkItemLifecycle ?? defaultListWorkItemLifecycle;
  const listFirstClaims = deps.listFirstClaims ?? defaultListFirstClaims;
  const listPlanAdoption = deps.listPlanAdoption ?? defaultListPlanAdoption;

  const items = await listWorkItemLifecycle({ harnessSlug: opts.harnessSlug, limit: itemLimit });
  const truncatedByItemLimit = items.length >= itemLimit;

  // Exclusion 1: turn-end notes are not claimed work. Counted, never silently dropped.
  const observations = items.filter((r) => r.lane === 'observation');
  const claimable = items.filter((r) => r.lane !== 'observation');

  const [firstClaims, planRows] = await Promise.all([
    listFirstClaims({
      harnessSlug: opts.harnessSlug,
      workItemIds: claimable.map((r) => r.workItemId),
    }),
    listPlanAdoption({ harnessSlug: opts.harnessSlug, limit: LATENCY_PLAN_LIMIT }),
  ]);

  const firstClaimByItem = new Map(firstClaims.map((c) => [c.workItemId, c.firstWonAtMs]));

  // The plan partition. `enforcementEligibility` is the SHARED classifier — the gates, the
  // reconciliation ledger and this census must agree on what "enforced" means or the split is
  // measuring one thing and being read as another.
  const eligibilityByPlan = new Map(
    planRows.map((p) => [
      p.planSlug,
      enforcementEligibility({
        status: p.status,
        clauseCount: p.clauseCount,
        legacyValSignal: p.legacyValSignal,
      }),
    ]),
  );

  const lanes: Record<EnforcementBucket, ReturnType<typeof emptyLane>> = {
    enforced: emptyLane(),
    'not-enforced': emptyLane(),
    unattributed: emptyLane(),
  };
  const sourceCounts: Record<ClaimInstantSource, number> = {
    'claim-ledger': 0,
    'taken-at-column': 0,
  };

  const rows: SpecEnforcementLatencyRow[] = [];
  let neverClaimed = 0;
  let negativeDuration = 0;

  for (const item of claimable) {
    const ledgerAt = firstClaimByItem.get(item.workItemId) ?? null;
    const claimedAtMs = ledgerAt ?? item.takenAtMs;
    if (claimedAtMs == null) {
      // No ledger row AND no column: the item was never claimed by anyone. Not a zero-length
      // claim — an absence of one, so it must not enter a duration sample.
      neverClaimed += 1;
      continue;
    }
    const claimInstantSource: ClaimInstantSource =
      ledgerAt == null ? 'taken-at-column' : 'claim-ledger';

    // An eligibility we could not resolve stays `unattributed`. Defaulting it to not-enforced
    // would silently grow the negative arm of the very partition being measured.
    const eligibility = item.sourcePlanSlug
      ? (eligibilityByPlan.get(item.sourcePlanSlug) ?? null)
      : null;
    const bucket: EnforcementBucket =
      eligibility == null ? 'unattributed' : eligibility.enforcing ? 'enforced' : 'not-enforced';

    const rawCompletion = item.closedAtMs == null ? null : item.closedAtMs - claimedAtMs;
    const rawLastProgress =
      item.lastProgressAtMs == null ? null : item.lastProgressAtMs - claimedAtMs;

    // A negative duration means the two instants disagree (a reclaim that moved `taken_at`
    // forward past an earlier close is the measured way this happens). Clamping it to 0 would
    // inject a fake fastest-possible observation into the median, so it is dropped and counted.
    const hasNegative =
      (rawCompletion != null && rawCompletion < 0) ||
      (rawLastProgress != null && rawLastProgress < 0);
    if (hasNegative) negativeDuration += 1;

    const claimToCompletionMs =
      rawCompletion != null && rawCompletion >= 0 ? rawCompletion : null;
    const claimToLastProgressMs =
      rawLastProgress != null && rawLastProgress >= 0 ? rawLastProgress : null;

    sourceCounts[claimInstantSource] += 1;
    const lane = lanes[bucket];
    lane.items += 1;
    if (claimToCompletionMs != null) lane.completion.push(claimToCompletionMs);
    if (claimToLastProgressMs != null) lane.lastProgress.push(claimToLastProgressMs);

    rows.push({
      workItemId: item.workItemId,
      planSlug: item.sourcePlanSlug,
      bucket,
      lane: eligibility?.lane ?? null,
      adoption: eligibility?.adoption ?? null,
      claimedAtMs,
      claimInstantSource,
      claimToCompletionMs,
      claimToLastProgressMs,
    });
  }

  const laneOut = (l: ReturnType<typeof emptyLane>): LatencyLane => ({
    items: l.items,
    claimToCompletion: distributionOf(l.completion),
    claimToLastProgress: distributionOf(l.lastProgress),
  });

  return {
    rows,
    rollup: {
      itemsMeasured: rows.length,
      byEnforcement: {
        enforced: laneOut(lanes.enforced),
        'not-enforced': laneOut(lanes['not-enforced']),
        unattributed: laneOut(lanes.unattributed),
      },
      byClaimInstantSource: sourceCounts,
      excluded: {
        observations: observations.length,
        neverClaimed,
        negativeDuration,
      },
      notDerivable: LATENCY_NOT_DERIVABLE,
      bounded: {
        itemLimit,
        itemsRead: items.length,
        truncatedByItemLimit,
        countsAreFloor: truncatedByItemLimit,
      },
    },
  };
}
