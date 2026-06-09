/**
 * outcome-feedback.ts — Scout loop P-013 (hive-creative-ideation-2026-06-08, D-009).
 *
 * The self-correction rail: track which *generated* ideas actually panned out
 * and weight the creative {@link CreativeLens lenses} that win for this Hive —
 * so the ideator (P-004) meta-learns which creative moves work, not just how to
 * execute them. "The ideator improves at *having* ideas."
 *
 * The attribution chain (closed entirely over data that already exists — no new
 * event log, consistent with self-learning-central D-005):
 *
 *   Idea (lens) ──P-007 route──▶ a rail artifact (plan / gym proposal /
 *   improvement) whose change-feed `ref` is recorded as the idea's
 *   {@link RoutedIdeaProvenance routedRef} ──▶ the Change Feed
 *   ({@link ChangeFeedEntry}, a projection over completions) tells us whether
 *   that artifact reached a winning terminal state.
 *
 * So an outcome is just: does this idea's `routedRef` appear in the change feed,
 * and with a winning status? Aggregating that per lens gives the lens weights
 * P-004 reads back to bias generation toward the moves that land — while a
 * diversity floor ({@link LensWeightOptions.minShare}) keeps every lens alive so
 * the weighting never strangles the leaps (the plan's anti-over-prune ethos +
 * the novelty-search lesson behind D-008).
 *
 * Pure + side-effect-free over injected readers (the change-feed / watchdog
 * pattern): the production reader bag ({@link ScoutOutcomeReaders}) is wired to
 * the routed-idea ledger + `buildChangeFeedReaders()`, but every function here is
 * unit-tested with fakes (no PG, no network).
 */

import type { ChangeFeedEntry } from '../curation/change-feed';
import { CREATIVE_LENSES, type CreativeLens } from './types';

/**
 * The rails a Scout proposal routes into (P-007 / D-007; reconciliation P-005 adds
 * `instance`). The two eval rails are the eval-battery's two SUBJECTS: `gym` = the
 * HarnessSubject (component eval), `instance` = the InstanceSubject (whole-instance
 * eval, a genome delta). Both feed lens meta-learning (reconciliation P-006).
 */
export type RoutedRail = 'plan' | 'gym' | 'improvement' | 'instance';

/** Outcome of one routed idea, derived from the change feed. */
export type IdeaOutcome =
  /** The routed artifact reached a winning terminal state (plan done / gym accepted / improvement landed). */
  | 'won'
  /** The routed artifact reached a losing terminal state (gym rejected / superseded). */
  | 'lost'
  /** Not yet terminal in the change feed — outcome still unknown. */
  | 'pending';

/**
 * Provenance of one Scout idea that P-007 routed into a rail — the record that
 * links a generated idea (and its lens) to the artifact whose fate determines
 * whether the idea panned out. This is genuine new state (the change feed cannot
 * say which lens produced a plan), persisted in the routed-idea ledger; it is
 * NOT a duplicate of the change feed (D-005 holds — the feed stays a projection).
 */
export interface RoutedIdeaProvenance {
  /** The generated idea's id (Idea.id from P-004). */
  ideaId: string;
  /** Which creative lens produced the idea — the attribution key (D-009). */
  lens: CreativeLens;
  /** The Scout cycle this idea came from (optional grouping). */
  cycleId?: string;
  /** Which rail P-007 routed it into. */
  rail: RoutedRail;
  /**
   * The change-feed `ref` of the artifact the routing created — "plan:<slug>",
   * "gym:<id>", or "wi:<id>". The join key into {@link ChangeFeedEntry.ref}.
   */
  routedRef: string;
  /** One-line idea title (for the report's drill-down). */
  title?: string;
  /** ISO timestamp the idea was routed. */
  routedAt?: string;
}

/** Per-lens outcome tally + the weight P-004 reads back. */
export interface LensOutcomeStat {
  lens: CreativeLens;
  /** Ideas from this lens that were routed (won + lost + pending). */
  routed: number;
  won: number;
  lost: number;
  pending: number;
  /** won / (won + lost) over DECIDED ideas only; null when nothing decided yet. */
  winRate: number | null;
  /**
   * Normalized sampling share in [minShare, 1], summing to 1 across all lenses —
   * the probability mass P-004 should give this lens next cycle. Smoothed so a
   * low-volume lens isn't judged on one outcome, floored so no lens starves.
   */
  weight: number;
}

/** The full P-013 report: per-lens stats + the ranked roster, all four lenses always present. */
export interface LensOutcomeReport {
  /** ISO timestamp the report was computed (stamped by the caller; pure core leaves it undefined). */
  generatedAt?: string;
  /** Total routed ideas considered. */
  total: number;
  /** Stats keyed by lens — every {@link CREATIVE_LENSES} member is present. */
  byLens: Record<CreativeLens, LensOutcomeStat>;
  /** The lenses sorted best-first (by weight, then winRate, then volume). */
  ranked: LensOutcomeStat[];
}

/** Injectable reader bag (unit tests inject fakes; production wires PG + the change feed). */
export interface ScoutOutcomeReaders {
  /** The Scout ideas that have been routed into a rail (the ledger). */
  routedIdeas(): Promise<RoutedIdeaProvenance[]>;
  /** The Change Feed completions (gatherCompletions output). */
  completions(): Promise<ChangeFeedEntry[]>;
}

export interface LensWeightOptions {
  /**
   * Beta-prior pseudo-count per lens (Laplace smoothing). A lens with no decided
   * ideas gets a neutral 0.5 smoothed win-rate; one decided win/loss barely moves
   * it. Higher = more conservative (slower to trust a lens). Default 1.
   */
  priorStrength?: number;
  /**
   * Minimum normalized share any lens keeps after weighting — the diversity floor
   * that stops a cold/losing lens from being fully starved (D-004 forced diversity
   * + the plan's "don't over-prune the leaps"). Must leave room for all lenses:
   * minShare * lensCount < 1. Default 0.05.
   */
  minShare?: number;
}

/**
 * Classify one routed idea's outcome from the change feed.
 *
 * - Not present in the feed → `pending` (no terminal record yet).
 * - `plan-run` / work-item `completion` present → `won` (the change-feed
 *   production readers only surface winning terminal states for these — plan
 *   `op_status=done`, work-item done/passed/resolved/closed — so presence == win).
 * - `proposal` (gym) → status decides: accepted → `won`; rejected/superseded → `lost`.
 *
 * The gym status is read from the entry's `detail` ("Status: <status>") with a
 * title fallback ("Accepted …" / "Rejected …"), so it survives either shape.
 */
export function classifyIdeaOutcome(
  prov: RoutedIdeaProvenance,
  completionByRef: ReadonlyMap<string, ChangeFeedEntry>,
): IdeaOutcome {
  const entry = completionByRef.get(prov.routedRef);
  if (!entry) return 'pending';
  // instance (InstanceSubject / apiary) eval — reconciliation P-006: a genome variant
  // that the battery PROMOTED (beat the champion beyond the noise band + held the
  // meta-eval) won; any other decided verdict lost. Both eval subjects feed lens
  // meta-learning, so a whole-system idea's apiary outcome weights its lens too.
  if (prov.rail === 'instance') {
    const status = gymStatusOf(entry);
    return status === 'promoted' || status === 'accepted' || status === 'won' ? 'won' : 'lost';
  }
  if (entry.kind === 'proposal') {
    const status = gymStatusOf(entry);
    if (status === 'accepted') return 'won';
    if (status === 'rejected' || status === 'superseded') return 'lost';
    // Unknown decision label but the proposal IS in the feed (it was decided) —
    // treat an unrecognized non-accept as a loss rather than silently pending.
    return 'lost';
  }
  // completion (work-item) + plan-run: the feed only carries winning terminals.
  return 'won';
}

/** Extract a gym proposal's decision label from a change-feed entry. */
function gymStatusOf(entry: ChangeFeedEntry): string {
  const fromDetail = entry.detail?.match(/status:\s*([a-z]+)/i)?.[1];
  if (fromDetail) return fromDetail.toLowerCase();
  const fromTitle = entry.title.match(/^(accepted|rejected|superseded)\b/i)?.[1];
  return fromTitle ? fromTitle.toLowerCase() : 'unknown';
}

/** Empty stat for a lens with no routed ideas (neutral, floor-eligible). */
function emptyStat(lens: CreativeLens): LensOutcomeStat {
  return { lens, routed: 0, won: 0, lost: 0, pending: 0, winRate: null, weight: 0 };
}

/**
 * Compute the per-lens outcome report from routed-idea provenance + the change
 * feed. Pure. Every lens in {@link CREATIVE_LENSES} appears in `byLens` (so the
 * roster P-004 reads is always complete), and `weight` is the smoothed, floored,
 * normalized sampling share.
 */
export function computeLensOutcomes(
  provenance: readonly RoutedIdeaProvenance[],
  completions: readonly ChangeFeedEntry[],
  opts: LensWeightOptions = {},
): LensOutcomeReport {
  const completionByRef = new Map<string, ChangeFeedEntry>();
  for (const e of completions) {
    // First-wins matches gatherCompletions' dedup; refs are unique per artifact.
    if (!completionByRef.has(e.ref)) completionByRef.set(e.ref, e);
  }

  const byLens = Object.fromEntries(
    CREATIVE_LENSES.map((l) => [l, emptyStat(l)]),
  ) as Record<CreativeLens, LensOutcomeStat>;

  for (const prov of provenance) {
    const stat = byLens[prov.lens];
    if (!stat) continue; // ignore an unknown lens rather than throwing
    stat.routed += 1;
    const outcome = classifyIdeaOutcome(prov, completionByRef);
    if (outcome === 'won') stat.won += 1;
    else if (outcome === 'lost') stat.lost += 1;
    else stat.pending += 1;
  }

  for (const lens of CREATIVE_LENSES) {
    const s = byLens[lens];
    const decided = s.won + s.lost;
    s.winRate = decided > 0 ? s.won / decided : null;
  }

  applyLensWeights(byLens, opts);

  const ranked = [...CREATIVE_LENSES.map((l) => byLens[l])].sort(rankStats);
  return { total: provenance.length, byLens, ranked };
}

/** Sort best-first: weight desc, then winRate desc (nulls last), then volume desc, then lens name. */
function rankStats(a: LensOutcomeStat, b: LensOutcomeStat): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  const ar = a.winRate ?? -1;
  const br = b.winRate ?? -1;
  if (br !== ar) return br - ar;
  if (b.routed !== a.routed) return b.routed - a.routed;
  return a.lens < b.lens ? -1 : a.lens > b.lens ? 1 : 0;
}

/**
 * Mutate `byLens` to set each lens's normalized `weight`:
 *   1. smoothed win-rate r_l = (won + p) / (won + lost + 2p)  — Beta(p,p) prior;
 *   2. normalize to a probability mass over lenses;
 *   3. floor every share at minShare and re-normalize (diversity guarantee).
 */
function applyLensWeights(
  byLens: Record<CreativeLens, LensOutcomeStat>,
  opts: LensWeightOptions,
): void {
  const prior = opts.priorStrength ?? 1;
  const lensCount = CREATIVE_LENSES.length;
  const minShare = clampMinShare(opts.minShare ?? 0.05, lensCount);

  const smoothed = CREATIVE_LENSES.map((l) => {
    const s = byLens[l];
    return (s.won + prior) / (s.won + s.lost + 2 * prior);
  });
  const sum = smoothed.reduce((a, b) => a + b, 0);
  const normalized = smoothed.map((v) => (sum > 0 ? v / sum : 1 / lensCount));

  const floored = normalized.map((v) => Math.max(v, minShare));
  const flooredSum = floored.reduce((a, b) => a + b, 0);

  CREATIVE_LENSES.forEach((l, i) => {
    byLens[l].weight = floored[i] / flooredSum;
  });
}

/** Keep the floor feasible: the sum of floors must leave headroom under 1. */
function clampMinShare(minShare: number, lensCount: number): number {
  if (!Number.isFinite(minShare) || minShare <= 0) return 0;
  const max = 1 / lensCount; // floor == uniform is the degenerate max
  return Math.min(minShare, max);
}

/**
 * Allocate `n` ideator slots across lenses for the next Scout cycle, blending
 * D-009 (favor winning lenses) with D-004 (forced diversity): when `n` ≥ the
 * lens count, every lens gets at least one slot (exploration guarantee), then
 * the remaining slots go by weight via largest-remainder (deterministic). When
 * `n` < the lens count, the top-`n` lenses by weight each get one.
 *
 * Returns a deterministic list of length `n` (lens ids, repeats allowed).
 */
export function allocateIdeators(report: LensOutcomeReport, n: number): CreativeLens[] {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  const lensCount = CREATIVE_LENSES.length;
  const weights = CREATIVE_LENSES.map((l) => ({ lens: l, w: report.byLens[l].weight }));

  if (count < lensCount) {
    return [...weights]
      .sort((a, b) => b.w - a.w || (a.lens < b.lens ? -1 : 1))
      .slice(0, count)
      .map((x) => x.lens);
  }

  // Guarantee one per lens, then distribute the remainder by weight.
  const base: Record<CreativeLens, number> = Object.fromEntries(
    CREATIVE_LENSES.map((l) => [l, 1]),
  ) as Record<CreativeLens, number>;
  const remaining = count - lensCount;
  if (remaining > 0) {
    const ideal = weights.map((x) => ({ lens: x.lens, exact: x.w * remaining }));
    const floors = ideal.map((x) => ({ lens: x.lens, n: Math.floor(x.exact), rem: x.exact - Math.floor(x.exact) }));
    let assigned = floors.reduce((a, b) => a + b.n, 0);
    for (const f of floors) base[f.lens] += f.n;
    // Largest-remainder for the leftover slots (deterministic tie-break by lens id).
    const leftover = remaining - assigned;
    floors
      .sort((a, b) => b.rem - a.rem || (a.lens < b.lens ? -1 : 1))
      .slice(0, leftover)
      .forEach((f) => {
        base[f.lens] += 1;
      });
  }

  const out: CreativeLens[] = [];
  for (const l of CREATIVE_LENSES) for (let i = 0; i < base[l]; i++) out.push(l);
  return out;
}

/**
 * Project a report's per-lens weights into the `lensWeights` shape the ideator
 * fan-out (P-004 `runIdeators`, BuildRosterInput.lensWeights) consumes — the
 * D-009 feedback hook: extra ideators are distributed across lenses proportional
 * to these weights (the diversity floor in the weights keeps every lens alive).
 */
export function lensWeightsFromReport(report: LensOutcomeReport): Record<CreativeLens, number> {
  return Object.fromEntries(
    CREATIVE_LENSES.map((l) => [l, report.byLens[l].weight]),
  ) as Record<CreativeLens, number>;
}

/**
 * Top-level P-013 entry: read routed-idea provenance + the change feed and
 * compute the lens-outcome report. The caller stamps `generatedAt`.
 */
export async function gatherLensOutcomes(
  readers: ScoutOutcomeReaders,
  opts: LensWeightOptions = {},
): Promise<LensOutcomeReport> {
  const [provenance, completions] = await Promise.all([
    readers.routedIdeas().catch(() => [] as RoutedIdeaProvenance[]),
    readers.completions().catch(() => [] as ChangeFeedEntry[]),
  ]);
  return computeLensOutcomes(provenance, completions, opts);
}
