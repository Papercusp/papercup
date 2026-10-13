/**
 * green-main-slo — P-016 (green-main-cycle-time-2026-10-08, owner-approved D-021 fix 3).
 *
 * One PURE function turns the gate's own ledgers into the green-main SLO: six metrics, each
 * computed from a NAMED population, plus the breaches that must alert or page. IO lives with
 * the callers: the watchdog pass reads the inputs and delivers pages, and the /admin/git
 * snapshot renders the same object, so the page and the panel can never disagree.
 *
 * Populations (a metric computed from any other population is a defect, per AUTO-BAR-R-13):
 *  - timeSinceGreen   now − `gate_health.lastGreenAt` (the gate's last GREEN verdict).
 *  - timeSinceVerdict now − newest verdict-bearing green_checkpoint ledger row (green OR red).
 *  - roundCycleTime   gaps between consecutive `convergenceRounds[].atMs` of the live frozen
 *                     queue: how long one repair round takes, admission to next verdict.
 *  - queueIdle        the live queue's waits with NOTHING in flight, from `frozenRepairLatency`:
 *                     a red waiting for a fixer, or an admitted head waiting for its run to start.
 *                     Time spent inside a running suite is not idle and is not counted.
 *  - roundsToConverge the live queue's recorded rounds. While a queue is open it has NOT
 *                     converged, so the figure is "rounds so far" and says so (`converged:false`).
 *  - redAddingAdmissions  admissions whose next round recorded MORE failures than the round
 *                     before them. Attribution is per admission WINDOW (every admission between
 *                     two rounds shares that window's outcome); `attribution:'window'` says so.
 *  - perSyncRedRate   per fleet: git-sync batches the sync-batch delta check judged red, over
 *                     the batches it judged. Unjudged batches are not in either count.
 *
 * Pages (AUTO-BAR-R-14): main red ≥ 12h, or no verdict of any kind ≥ 6h. Each breach carries an
 * EPISODE key derived from the clock that started it (`lastGreenAt` / `lastVerdictAt`), so a
 * caller delivering through `notifyAttentionOnce({ dedupeKey })` pages exactly once per episode:
 * never zero times, never every tick (the 2026-10-06..08 flood was ~100 owner pages a day).
 */
import {
  frozenRepairLatency,
  type FrozenCandidateRepairQueue,
  type FrozenRepairLatencySource,
} from './frozen-candidate-repair-queue';

const HOUR_MS = 60 * 60 * 1000;

/** SLO thresholds. Pages are the owner-approved D-021 values; the alert targets are D-030. */
export const GREEN_MAIN_SLO_DEFAULTS = {
  /** Owner page: main has had no green verdict for this long. */
  redPageMs: 12 * HOUR_MS,
  /** Owner page: the gate has rendered no verdict of any kind for this long. */
  noVerdictPageMs: 6 * HOUR_MS,
  /** Alert: the newest repair round took longer than this. */
  roundCycleAlertMs: 2 * HOUR_MS,
  /** Alert: the live queue has sat idle (nothing in flight) longer than this. */
  queueIdleAlertMs: 1 * HOUR_MS,
  /** Alert: a fleet's per-sync red rate exceeds this fraction... */
  perSyncRedRateAlert: 0.2,
  /** ...over at least this many judged batches (one red in two batches is not a rate). */
  perSyncRedMinBatches: 5,
} as const;

export type GreenMainSloThresholds = { -readonly [K in keyof typeof GREEN_MAIN_SLO_DEFAULTS]?: number };

/** The live frozen queue fields the SLO reads. A full `FrozenCandidateRepairQueue` satisfies it. */
export type GreenMainSloQueue = FrozenRepairLatencySource &
  Pick<FrozenCandidateRepairQueue, 'candidate'> &
  Partial<Pick<FrozenCandidateRepairQueue, 'admissions'>>;

/** One fleet's sync-batch tally from the sync-batch delta check. `fleet: null` = no fleet. */
export interface SyncBatchFleetTally {
  fleet: string | null;
  /** Batches the check judged (evaluated green or red). */
  judgedBatches: number;
  /** Of those, batches it judged red. */
  redBatches: number;
}

export interface GreenMainSloInput {
  installSlug: string;
  nowMs: number;
  /** `gate_health.lastGreenAt`; null when the gate has never recorded a green. */
  lastGreenAtMs: number | null;
  /** Newest verdict-bearing green_checkpoint ledger row (green or red); null when none. */
  lastVerdictAtMs: number | null;
  /** The live frozen repair queue, or null when none is open. */
  queue: GreenMainSloQueue | null;
  /** Per-fleet sync tallies over the delta check's retained window; omit when unreadable. */
  syncTallies?: readonly SyncBatchFleetTally[] | null;
}

export interface PerSyncRedRate {
  fleet: string | null;
  judgedBatches: number;
  redBatches: number;
  /** redBatches / judgedBatches; null when nothing was judged. */
  rate: number | null;
}

export interface RedAddingAdmissions {
  /** Admissions whose window ended in a round with more failures than the round before it. */
  count: number;
  /** Admissions that have a following round to judge them (the denominator). */
  judged: number;
  /** `toRepairHead` of each red-adding admission, oldest first. */
  heads: string[];
  attribution: 'window';
}

export interface GreenMainSloMetrics {
  timeSinceGreenMs: number | null;
  timeSinceVerdictMs: number | null;
  roundCycleTime: { lastMs: number | null; medianMs: number | null; intervals: number };
  queueIdleMs: number | null;
  roundsToConverge: { rounds: number; converged: false } | null;
  redAddingAdmissions: RedAddingAdmissions | null;
  /** null when the sync tallies were unreadable — never an empty list standing in for "unknown". */
  perSyncRedRate: PerSyncRedRate[] | null;
}

export type GreenMainSloBreachMetric =
  | 'time-since-green'
  | 'time-since-verdict'
  | 'round-cycle-time'
  | 'queue-idle'
  | 'red-adding-admission'
  | 'per-sync-red-rate';

export interface GreenMainSloBreach {
  metric: GreenMainSloBreachMetric;
  /** `page` = owner page (notifyAttention); `alert` = attention item at normal importance. */
  severity: 'page' | 'alert';
  value: number;
  threshold: number;
  /** Stable for one breach episode: the dedupe key a once-only delivery must use. */
  episodeKey: string;
  title: string;
  detail: string;
}

export interface GreenMainSlo {
  installSlug: string;
  computedAtMs: number;
  metrics: GreenMainSloMetrics;
  breaches: GreenMainSloBreach[];
  thresholds: typeof GREEN_MAIN_SLO_DEFAULTS;
}

const hours = (ms: number): string => `${(ms / HOUR_MS).toFixed(1)}h`;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function redAddingAdmissions(queue: GreenMainSloQueue): RedAddingAdmissions {
  const rounds = [...(queue.convergenceRounds ?? [])].sort((a, b) => a.atMs - b.atMs);
  const admissions = [...(queue.admissions ?? [])].sort((a, b) => a.atMs - b.atMs);
  const heads: string[] = [];
  let judged = 0;
  for (const admission of admissions) {
    const before = rounds.filter((r) => r.atMs <= admission.atMs).at(-1);
    const after = rounds.find((r) => r.atMs > admission.atMs);
    if (!before || !after) continue;
    judged += 1;
    if (after.failingCount > before.failingCount) heads.push(admission.toRepairHead);
  }
  return { count: heads.length, judged, heads, attribution: 'window' };
}

export function computeGreenMainSlo(input: GreenMainSloInput, thresholds: GreenMainSloThresholds = {}): GreenMainSlo {
  const t = { ...GREEN_MAIN_SLO_DEFAULTS, ...thresholds } as typeof GREEN_MAIN_SLO_DEFAULTS;
  const { nowMs, queue, installSlug } = input;

  const timeSinceGreenMs = input.lastGreenAtMs === null ? null : Math.max(0, nowMs - input.lastGreenAtMs);
  const timeSinceVerdictMs = input.lastVerdictAtMs === null ? null : Math.max(0, nowMs - input.lastVerdictAtMs);

  const roundTimes = [...(queue?.convergenceRounds ?? [])].map((r) => r.atMs).sort((a, b) => a - b);
  const intervals = roundTimes.slice(1).map((at, i) => at - roundTimes[i]);
  const roundCycleTime = { lastMs: intervals.at(-1) ?? null, medianMs: median(intervals), intervals: intervals.length };

  let queueIdleMs: number | null = null;
  if (queue) {
    const latency = frozenRepairLatency(queue, nowMs);
    queueIdleMs = latency.redAwaitingFixerMs ?? latency.admitAwaitingResumeRunStartMs ?? 0;
  }

  const roundsToConverge = queue
    ? { rounds: (queue.convergenceRounds ?? []).reduce((max, r) => Math.max(max, r.round), 0), converged: false as const }
    : null;
  const admissions = queue ? redAddingAdmissions(queue) : null;

  const perSyncRedRate =
    input.syncTallies == null
      ? null
      : input.syncTallies.map((tally) => ({
          fleet: tally.fleet,
          judgedBatches: tally.judgedBatches,
          redBatches: tally.redBatches,
          rate: tally.judgedBatches > 0 ? tally.redBatches / tally.judgedBatches : null,
        }));

  const breaches: GreenMainSloBreach[] = [];
  const key = (metric: GreenMainSloBreachMetric, episode: string | number): string =>
    `green-main-slo:${installSlug}:${metric}:${episode}`;

  if (timeSinceGreenMs !== null && input.lastGreenAtMs !== null && timeSinceGreenMs >= t.redPageMs) {
    breaches.push({
      metric: 'time-since-green',
      severity: 'page',
      value: timeSinceGreenMs,
      threshold: t.redPageMs,
      episodeKey: key('time-since-green', input.lastGreenAtMs),
      title: `Main has been red ${hours(timeSinceGreenMs)} on ${installSlug}`,
      detail: `No green verdict since ${new Date(input.lastGreenAtMs).toISOString()} (SLO page at ${hours(t.redPageMs)}).`,
    });
  }
  // A gate that has never rendered a verdict is a fresh install, not a silent gate (the same
  // rule the stall watchdog follows); only a verdict that existed and then stopped pages.
  if (timeSinceVerdictMs !== null && input.lastVerdictAtMs !== null && timeSinceVerdictMs >= t.noVerdictPageMs) {
    breaches.push({
      metric: 'time-since-verdict',
      severity: 'page',
      value: timeSinceVerdictMs,
      threshold: t.noVerdictPageMs,
      episodeKey: key('time-since-verdict', input.lastVerdictAtMs),
      title: `No gate verdict for ${hours(timeSinceVerdictMs)} on ${installSlug}`,
      detail: `The gate has rendered no verdict (green or red) since ${new Date(input.lastVerdictAtMs).toISOString()} (SLO page at ${hours(t.noVerdictPageMs)}).`,
    });
  }
  if (queue && roundCycleTime.lastMs !== null && roundCycleTime.lastMs > t.roundCycleAlertMs) {
    const lastRound = (queue.convergenceRounds ?? []).reduce((max, r) => Math.max(max, r.round), 0);
    breaches.push({
      metric: 'round-cycle-time',
      severity: 'alert',
      value: roundCycleTime.lastMs,
      threshold: t.roundCycleAlertMs,
      episodeKey: key('round-cycle-time', `${queue.candidate}:${lastRound}`),
      title: `Repair round ${lastRound} took ${hours(roundCycleTime.lastMs)} on ${installSlug}`,
      detail: `Frozen candidate ${queue.candidate.slice(0, 12)}: the newest round interval exceeds the ${hours(t.roundCycleAlertMs)} target.`,
    });
  }
  if (queue && queueIdleMs !== null && queueIdleMs > t.queueIdleAlertMs) {
    const latency = frozenRepairLatency(queue, nowMs);
    const idleSince = latency.redAwaitingFixerMs !== null ? latency.stamps.lastRedAtMs : latency.stamps.lastAdmittedAtMs;
    breaches.push({
      metric: 'queue-idle',
      severity: 'alert',
      value: queueIdleMs,
      threshold: t.queueIdleAlertMs,
      episodeKey: key('queue-idle', `${queue.candidate}:${idleSince ?? 'unknown'}`),
      title: `Frozen repair queue idle ${hours(queueIdleMs)} on ${installSlug}`,
      detail:
        latency.redAwaitingFixerMs !== null
          ? `The newest red has waited ${hours(queueIdleMs)} for a fixer.`
          : `The newest admission has waited ${hours(queueIdleMs)} for its verification run to start.`,
    });
  }
  for (const head of admissions?.heads ?? []) {
    breaches.push({
      metric: 'red-adding-admission',
      severity: 'alert',
      value: 1,
      threshold: 0,
      episodeKey: key('red-adding-admission', head),
      title: `An admission added red on ${installSlug}`,
      detail: `The round after admitting ${head.slice(0, 12)} recorded more failures than the round before it.`,
    });
  }
  for (const rate of perSyncRedRate ?? []) {
    if (rate.rate === null || rate.judgedBatches < t.perSyncRedMinBatches || rate.rate <= t.perSyncRedRateAlert) continue;
    breaches.push({
      metric: 'per-sync-red-rate',
      severity: 'alert',
      value: rate.rate,
      threshold: t.perSyncRedRateAlert,
      episodeKey: key('per-sync-red-rate', `${rate.fleet ?? 'unfleeted'}:${Math.floor(nowMs / (24 * HOUR_MS))}`),
      title: `${rate.fleet ?? 'Unfleeted agents'}: ${Math.round(rate.rate * 100)}% of syncs red on ${installSlug}`,
      detail: `${rate.redBatches} of ${rate.judgedBatches} judged git-sync batches went red (target ≤ ${Math.round(t.perSyncRedRateAlert * 100)}%).`,
    });
  }

  return {
    installSlug,
    computedAtMs: nowMs,
    metrics: {
      timeSinceGreenMs,
      timeSinceVerdictMs,
      roundCycleTime,
      queueIdleMs,
      roundsToConverge,
      redAddingAdmissions: admissions,
      perSyncRedRate,
    },
    breaches,
    thresholds: t,
  };
}
