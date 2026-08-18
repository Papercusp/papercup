/**
 * The compute behind the `learning.improvements` sync resolver — extracted so the
 * PRECOMPUTED default variant (a `system:precompute-derived-reads` producer) and
 * the resolver's live inline path for NON-default variants run the EXACT same code
 * and can never drift (precompute-sync-reads-phase2-compute-latency-2026-07-19
 * P-003 / WI-5460 follow-up; the same "the tab and the tool can never drift"
 * discipline the resolver was written under).
 *
 * ── What is and is NOT in here ───────────────────────────────────────────────
 * This builds the structured ImprovementDigest (+ the `flow` block + the WI-5412
 * humanQueue slimming) — the expensive part (buildDigest + human-queue ranking +
 * flow-metrics over the whole improvement corpus, measured 0.4-0.5s on read).
 *
 * The `recordQueueExposure` side-effect (FB-15 / P-043) is DELIBERATELY NOT here:
 * it records that the queue was rendered TO THE OWNER, so it must fire on the
 * actual user-facing read (the resolver), never on the routine thread that fills
 * the snapshot — otherwise the owner-preference model's "shown but ignored"
 * denominator would count exposures that never happened. The resolver fires it
 * from whatever humanQueue the read returns (snapshot or inline).
 */
import type { ImprovementDigest, ScoredItem } from './digest';

/**
 * The humanQueue fields this read actually puts ON THE WIRE (WI-7279).
 *
 * This is the read-set of the two sync consumers, verified against their
 * mappers — not everything `ScoredItem` declares. Keep it in sync with
 * {@link SlimHumanQueueItem}; the projection loop below iterates exactly this
 * list, so a field absent here never reaches a client.
 *
 * Do NOT add a field here "in case someone needs it": the whole point is that
 * the wire cost of a new `ScoredItem` field is opt-in. Adding one means a
 * consumer reads it — say which, in the comment above the projection.
 */
export const HUMAN_QUEUE_WIRE_FIELDS = [
  'id',
  'kind',
  'title',
  'scope',
  'severity',
  'state',
  'assignee',
  'score',
  'ageDays',
  'ideaType',
  'source',
] as const satisfies ReadonlyArray<keyof ScoredItem>;

/**
 * `tierReason` is NOT in the list above — it ships INTERNED, as `trc` (a code
 * into the payload's own `tierReasonLegend`). It is NOT dropped: dropping it
 * would silently narrow the owner's quick search (see the projection below),
 * which is the failure this encoding exists to avoid.
 *
 * The contract — the key, the legend type, and the `tierReasonOf` reader — lives
 * in `./learning-digest-wire`, a leaf with no imports, because the BROWSER needs
 * `tierReasonOf` and must not pull this module's server-side dynamic-import graph
 * to get it. Re-exported here so server-side callers have one obvious home.
 */
export {
  TIER_REASON_CODE_KEY,
  tierReasonOf,
  type TierReasonLegend,
} from './learning-digest-wire';
import { TIER_REASON_CODE_KEY } from './learning-digest-wire';

/**
 * One `learning.improvements` humanQueue row AS SERVED — deliberately narrower
 * than {@link ScoredItem}, which is the SERVER-side shape (the dispatcher and
 * the `improvements:digest` tool still see all of it).
 *
 * Typing the wire separately is what keeps the projection honest: a consumer
 * that starts reading a dropped field fails to compile here instead of reading
 * `undefined` at runtime, which is how a field declared-but-never-sent rots
 * into a silent bug.
 */
export type SlimHumanQueueItem = Pick<ScoredItem, (typeof HUMAN_QUEUE_WIRE_FIELDS)[number]> & {
  /**
   * The INTERNED `tierReason`: an index into
   * {@link LearningImprovementsRow.tierReasonLegend}. Omitted when the item has
   * no tier reason (the ranker leaves it '' for some rows), exactly as the
   * null-omit below drops an absent `assignee`.
   *
   * Read it through `tierReasonOf(row, item)` — never index the legend by hand,
   * or a row from a stale snapshot (one legend) paired with a fresh legend
   * silently resolves to the WRONG sentence instead of failing.
   */
  trc?: number;
};

/** The `learning.improvements` payload row as served to the Learning tab. */
export type LearningImprovementsRow = Omit<ImprovementDigest, 'humanQueue'> & {
  humanQueue: SlimHumanQueueItem[];
  flow: import('./flow-metrics').ImprovementFlow;
  /**
   * The legend for {@link SlimHumanQueueItem.trc} — every distinct `tierReason`
   * in THIS payload, in code order. Self-contained per payload on purpose: it
   * travels with the rows it describes, so a client never has to hold a shared
   * enum in sync with the server (the tier-reason strings are generated prose
   * and DO change when the risk-tier policy changes).
   */
  tierReasonLegend: string[];
};

export interface LearningImprovementsArgs {
  state?: 'open' | 'resolved' | 'closed';
  limit?: number;
  /** A Hive HOME slug narrows to that Hive's member-harness scopes; omit ⇒ whole workspace. */
  hive?: string;
  /**
   * Provenance scope (learning-tab-surface-public-release-2026-07-27 P-002 / D-002).
   *
   * `'loop'` (THE DEFAULT) = only what the learning loop produced — the union of the
   * three Scout provenance records (`loop-output.ts`). `'all'` = every captured
   * improvement, the pre-P-002 behaviour.
   *
   * Defaulting to `'loop'` rather than taking a flag is deliberate and load-bearing
   * for LATENCY, not just semantics: the resolver serves only its DEFAULT variant
   * from the precomputed snapshot, so if the Learning tab had to pass an explicit
   * arg to get its own scope, every mount would miss the snapshot and pay the
   * 0.4-0.5s inline compute. The default IS the tab's view.
   */
  scope?: 'loop' | 'all';
}

/**
 * Build the `learning.improvements` payload row (the client reads `data[0]`).
 * Pure of the owner-exposure side-effect (see the module note) so it is safe to
 * run on the precompute routine's thread as well as inline on a read.
 */
export async function computeLearningImprovementsSnapshot(
  a: LearningImprovementsArgs,
): Promise<Array<LearningImprovementsRow>> {
  const { readImprovementItems, countImprovementItems } = await import('./read-items');
  const { buildDigest } = await import('./digest');
  const { applyHumanQueueRanking } = await import('../../queue-ranker/human-queue');
  const { computeImprovementFlow, readWatchdogFlowTicks } = await import('./flow-metrics');
  const { activeWorkspaceId } = await import('../../workspace-registry');
  const { readOwnerFullAutonomyGrant } = await import('./full-autonomy-grant');
  const nowMs = Date.now();
  // The OWNER FULL-AUTONOMY grant (Phase 2): this feed IS the owner's Learning-tab
  // view of the queue — keep its auto/human split consistent with the live dispatch so
  // a protected-surface kind=bug isn't shown as "needs your decision" while the loop
  // auto-implements it once the grant is on.
  const ownerFullAutonomy = await readOwnerFullAutonomyGrant(activeWorkspaceId());
  // P-040: resolve the Hive → its member-harness scope set (the Hive is the
  // tenancy unit) so the feed only shows that Hive's improvements. Best-effort:
  // a registry read failure degrades to the unfiltered (workspace) feed rather
  // than 500ing the tab.
  let harnessScopes: string[] | undefined;
  if (a.hive) {
    try {
      const { loadHarnessRegistry, hiveMemberHarnessScopes } = await import('../../harness-registry');
      const reg = await loadHarnessRegistry();
      harnessScopes = hiveMemberHarnessScopes(reg.projects, a.hive);
    } catch (err) {
      console.warn('[learning.improvements] hive scope resolution failed:', err instanceof Error ? err.message : err);
    }
  }
  const readOpts = {
    state: a.state,
    limit: a.limit,
    ...(harnessScopes ? { harnessScopes } : {}),
    // D-002: 'loop' is the default — see LearningImprovementsArgs.scope. Passing the
    // flag explicitly (rather than letting read-items default it) keeps the scope
    // decision visible at the one call site that owns the Learning tab's semantics.
    ...(a.scope === 'all' ? {} : { loopOutputOnly: true }),
  };
  // WI-39675: the TRUE corpus total, read alongside the (windowed) items over the
  // SAME filter — so `digest.total`, which the tab renders as "From the loop N",
  // stops reporting the WINDOW size. This is the same D2 fix EI-18790490225750395
  // made to the `improvements:digest` AGENT TOOL; it was never propagated to this
  // SYNC-RESOLVER path, so the tab's own total silently saturated at the default
  // 500-row window while the agent-facing tool reported the truth.
  //
  // Best-effort, exactly as on that path: a count failure must never sink an
  // otherwise-good digest, so it degrades to `undefined` and buildDigest falls
  // back to candidates.length (the prior behavior) rather than throwing.
  const [items, corpusTotal] = await Promise.all([
    readImprovementItems(readOpts),
    countImprovementItems(readOpts).catch(() => undefined),
  ]);
  // Human lane ordered by the ONE ranker (frontier P-040; feature #1 is
  // consume-edges P-022's blocking impact) — the owner's queue leads with
  // what blocks the most, each item carrying its per-feature breakdown.
  const digest = await applyHumanQueueRanking(
    buildDigest(items, { nowMs, ownerFullAutonomy, corpusTotal }),
    { candidates: items },
  );
  // Watchdog ticks are best-effort: a tick-read failure degrades the flow
  // strip to "watchdog: never" rather than 500ing the whole improvements view.
  let ticks: Awaited<ReturnType<typeof readWatchdogFlowTicks>> = [];
  try {
    ticks = await readWatchdogFlowTicks(activeWorkspaceId());
  } catch (err) {
    console.warn('[learning.improvements] watchdog tick read failed:', err instanceof Error ? err.message : err);
  }
  // Dispatch-ledger rollup (consume-edges P-010 / B-04) — same best-effort
  // rule: a ledger read failure degrades the strip's dispatch chip to "—".
  let dispatchStats: import('./dispatch-ledger').DispatchStats | null = null;
  try {
    const { readRecentDispatches, computeDispatchStats } = await import('./dispatch-ledger');
    dispatchStats = computeDispatchStats(await readRecentDispatches(activeWorkspaceId()), { nowMs });
  } catch (err) {
    console.warn('[learning.improvements] dispatch ledger read failed:', err instanceof Error ? err.message : err);
  }
  const flow = computeImprovementFlow(items, ticks, {
    nowMs,
    // Reuse the digest's recurrence computation (P-041) — do not re-derive.
    recurringSignatureCount: digest.recurringSignatures.length,
    dispatchStats,
  });
  // Wire slimming (WI-5412, widened to a strict projection): the ranked
  // humanQueue items each carry a ~1KB `rank` breakdown + `impact` struct that
  // NO Learning-tab consumer renders — across ~380 items that was ~65% of a
  // 479KB payload. The ORDER the ranker produced is preserved; the per-feature
  // "why" stays on the improvements:digest tool for consumers that want it.
  //
  // It is now an ALLOWLIST rather than the original `omit impact/rank`
  // denylist. A denylist re-inflates the wire silently every time a field is
  // added upstream, which is exactly what happened: by 2026-08-03 the payload
  // was back to 318,082B / 453 rows (695 B/row) against the 250,000 default
  // ceiling, carrying TEN fields no consumer reads. Projecting to the verified
  // read-set instead makes the next upstream addition wire-invisible until
  // someone deliberately adds it here.
  //
  // The read-set below is every field reachable from a real consumer — both
  // sync consumers were enumerated and their mappers read (WI-7279):
  //   LearningTab.tsx  — renders `title`; filter-engine accessors read `kind`,
  //     `severity`, `scope`, `ideaType`, `score`, `ageDays`; `source` drives the
  //     provenance chips; pipelineState() reads `state` + `assignee`; and the
  //     `impq` quick-search haystack (LearningTab.tsx ~L1636) reads `id`,
  //     `title`, `tierReason`, `scope`.
  //   LearningLoopFace.tsx — reads `humanQueue.length` only.
  //
  // ⚠ `tierReason` is never RENDERED, but it IS a quick-search input, so
  // dropping it would silently narrow what the owner can find — no error, just
  // fewer hits. It is therefore INTERNED rather than dropped (WI-39773 / D-008):
  // 30.6% of the humanQueue across only SIX distinct sentences, measured live.
  // See TIER_REASON_CODE_KEY above for the numbers and the stale ones it corrects.
  const tierReasonLegend: string[] = [];
  const tierReasonCodes = new Map<string, number>();
  const humanQueue: SlimHumanQueueItem[] = digest.humanQueue.map((item) => {
    const slim = {} as Record<string, unknown>;
    for (const key of HUMAN_QUEUE_WIRE_FIELDS) {
      const v = (item as unknown as Record<string, unknown>)[key];
      // Null-omit (D-025): `assignee` is null on 452 of 453 rows, and every
      // consumer reads it as falsy-or-set (pipelineState), so an omitted key is
      // indistinguishable from an explicit null at the read site.
      if (v === undefined || v === null) continue;
      slim[key] = v;
    }
    // Intern the tier reason. An EMPTY reason is left off entirely rather than
    // interned as a code for '': it carries nothing, and a legend entry for it
    // would put an empty string in every consumer's search haystack.
    const reason = item.tierReason;
    if (reason) {
      let code = tierReasonCodes.get(reason);
      if (code === undefined) {
        code = tierReasonLegend.length;
        tierReasonLegend.push(reason);
        tierReasonCodes.set(reason, code);
      }
      slim[TIER_REASON_CODE_KEY] = code;
    }
    return slim as unknown as SlimHumanQueueItem;
  });
  return [{ ...digest, humanQueue, flow, tierReasonLegend }];
}
