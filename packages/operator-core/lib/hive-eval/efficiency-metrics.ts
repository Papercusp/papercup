/**
 * Hive-evaluation EFFICIENCY metrics (HE-05, P-031) — "did the Hive do it EFFICIENTLY?".
 *
 * The crux (D-003): EVERY efficiency metric is PAIRED with its failure-mode counterpart, because
 * a metric in isolation games — low-communication is achieved by bees that don't coordinate and
 * collide; high-parallelism by spawning useless bees; cheap by doing less. So each "win" is only
 * meaningful alongside its pair staying low: low-communication ↔ low collisions/rework;
 * high-parallelism ↔ low useless-bee rate. The {@link EfficiencyMetrics.pairings} field makes the
 * couplings explicit so HE-06 credits an efficiency win ONLY when its paired failure stays low.
 *
 * Pure — over an injected {@link RunBehavior} the live run's collectRunData extracts from the EKG
 * (`coordShare`/`locksShare` per session), `computeHiveThroughput` (utilization/completed),
 * `coord_event_log` (comms volume), `claim_audit` (collisions), and the gym cost instrumentation
 * (owner-gated, P-051). HE-06 composes these UNDER the outcome gate (D-002).
 */

/** The raw behavioral substrate of one run (extracted by collectRunData). */
export interface RunBehavior {
  /** Sampled bees-busy counts across the run (parallelism-utilization numerator). */
  beesBusySamples: number[];
  /** The run's bee cap (the utilization denominator). */
  beeCap: number;
  /** ms during which work was READY (deps satisfied) but bees sat idle — idle-while-ready. */
  idleWhileReadyMs: number;
  /** Coordination messages emitted during the run (communication volume). */
  coordMessages: number;
  /** Items the Hive actually completed — the per-item denominator. */
  completedItems: number;
  /** Bees spawned over the run. */
  beesSpawned: number;
  /** Bees that produced NO completed work — the useless-bee pair for parallelism. */
  uselessBees: number;
  /** Claim conflicts / collisions — the failure pair for low communication. */
  collisions: number;
  /** Validator bounces + re-placements + abandoned claims — rework/thrash. */
  rework: number;
  /** Lock-wait time (the EKG `locks` contention category), ms. */
  lockContentionMs: number;
  /** Total tokens spent on the run. */
  totalTokens: number;
  /** Real USD spent on the run. */
  costUsd: number;
}

/** One D-003 pairing: an efficiency metric and the failure-mode that must stay low to credit it. */
export interface MetricPairing {
  metric: number;
  pairedFailure: number;
  pairName: string;
}

export interface EfficiencyMetrics {
  /** Mean bees-busy ÷ cap over the run (high = good parallelism). */
  parallelismUtilization: number;
  idleWhileReadyMs: number;
  /** coordMessages ÷ completedItems (low = good — but ONLY if collisions stay low, D-003). */
  communicationOverhead: number;
  /** collisions ÷ completedItems — the failure pair for low communication. */
  collisionRate: number;
  /** uselessBees ÷ beesSpawned — the failure pair for high parallelism. */
  uselessBeeRate: number;
  /** rework ÷ completedItems (validator bounces, re-placements, abandoned claims). */
  reworkRate: number;
  /** Lock-wait time (ms). */
  lockContentionMs: number;
  /** USD per completed item. */
  costPerItemUsd: number;
  /** Tokens per completed item. */
  tokensPerItem: number;
  /** The D-003 couplings made explicit — HE-06 credits each win only if its pair stays low. */
  pairings: {
    lowCommunication: MetricPairing;
    highParallelism: MetricPairing;
  };
}

/** Compute the efficiency metrics for one run. Pure + deterministic. */
export function computeEfficiencyMetrics(b: RunBehavior): EfficiencyMetrics {
  const parallelismUtilization =
    b.beeCap > 0 && b.beesBusySamples.length > 0
      ? b.beesBusySamples.reduce((a, c) => a + c, 0) / b.beesBusySamples.length / b.beeCap
      : 0;
  // A run that completed NOTHING still gets finite per-item ratios (its outcome gate fails anyway,
  // so HE-06 zeroes its efficiency credit) — guard the divide so the metric is never NaN/Infinity.
  const denom = b.completedItems > 0 ? b.completedItems : 1;
  const communicationOverhead = b.coordMessages / denom;
  const collisionRate = b.collisions / denom;
  const uselessBeeRate = b.beesSpawned > 0 ? b.uselessBees / b.beesSpawned : 0;
  const reworkRate = b.rework / denom;
  return {
    parallelismUtilization,
    idleWhileReadyMs: b.idleWhileReadyMs,
    communicationOverhead,
    collisionRate,
    uselessBeeRate,
    reworkRate,
    lockContentionMs: b.lockContentionMs,
    costPerItemUsd: b.costUsd / denom,
    tokensPerItem: b.totalTokens / denom,
    pairings: {
      lowCommunication: { metric: communicationOverhead, pairedFailure: collisionRate, pairName: 'collisionRate' },
      highParallelism: { metric: parallelismUtilization, pairedFailure: uselessBeeRate, pairName: 'uselessBeeRate' },
    },
  };
}
