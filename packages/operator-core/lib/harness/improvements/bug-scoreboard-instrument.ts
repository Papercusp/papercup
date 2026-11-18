/** P012's scheduled producer/consumer, through the existing rubric instrument
 * registry and results ledger. Immutable artifacts retain every attempt's source;
 * no mutable "latest healthy" value participates in this invocation's verdict.
 * Upstream P007/P009/P010 must qualify complete event history before activation.
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { resolveBuildInfo } from '../../build-info';
import type { PlatformInstrument } from '../../rubric-instrument-registry';
import {
  R11_METRIC_REGISTRY, R11_METRIC_REGISTRY_HASH, freezeBugScoreboardSource,
  readBugScoreboardSource, storeR11Evidence, loadR11Evidence,
  type R11Metrics, type R11MetricKey,
} from './bug-inflow';

export const BUG_SCOREBOARD_INSTRUMENT = 'bugs:daily-scoreboard';
const DAY = 86_400_000;
type Sql = ReturnType<typeof getOrgPg>['sql'];
type Window = { workspaceId: string; harnessSlug?: string; windowStart: string; windowEnd: string };
type Reading = Awaited<ReturnType<NonNullable<PlatformInstrument['rescore']>['resolve']>>;

/** Normalized EVENT records, never reconstructed from a current-state row. The
 * qualified production adapter must retain its original complete source too.
 */
export interface BugScoreboardHistory {
  filings: Array<{ itemId: string; filedAt: string; source: string }>;
  closes: Array<{ itemId: string; at: string; kind: 'ordinary' | 'cleanup' | 'fold' }>;
  reopens: Array<{ itemId: string; at: string; ordinary: boolean }>;
  reviews: Array<{ itemId: string; at: string }>;
  bypasses: Array<{ itemId: string; at: string; route: string; reason: string }>;
  flags: Array<{ itemId: string; at: string }>;
  merges: Array<{ at: string; outcome: 'committed' | 'duplicate' | 'alreadyFolded' | 'protected' | 'failed' }>;
}
export interface BugScoreboardClaimability {
  count: number; population: number; protected: number; held: number; blocked: number; unknown: number;
}
const time = (s: string) => {
  const n = Date.parse(s);
  if (!Number.isFinite(n)) throw new Error('invalid scoreboard event time');
  return n;
};
const increment = (counts: Record<string, number>, key: string) => {
  if (!key.trim()) throw new Error('empty scoreboard source/route/reason');
  Object.defineProperty(counts, key, { value: (Object.hasOwn(counts, key) ? counts[key] : 0) + 1,
    writable: true, enumerable: true, configurable: true });
};

/** All seven raw metrics from full normalized events. This function does not
 * authenticate an input or qualify capture; typed fixtures are only arithmetic.
 * The reader may inspect the previous UTC cohort after its final 24h matures.
 */
export function computeBugScoreboardMetrics(history: BugScoreboardHistory,
  claimable: BugScoreboardClaimability, start: string, end: string, measuredAt: string): R11Metrics {
  const lo = time(start), hi = time(end), measured = time(measuredAt);
  if (hi - lo !== DAY || lo % DAY !== 0 || measured < hi) throw new Error('invalid scoreboard UTC window');
  const inside = (at: string) => time(at) >= lo && time(at) < hi;
  const filings = new Map<string, BugScoreboardHistory['filings'][number]>();
  for (const filing of history.filings) {
    if (!filing.itemId.trim() || !filing.source.trim() || filings.has(filing.itemId))
      throw new Error('missing or duplicate canonical filing identity');
    time(filing.filedAt); filings.set(filing.itemId, filing);
  }
  for (const event of [...history.closes, ...history.reopens, ...history.reviews, ...history.bypasses, ...history.flags]) {
    const filing = filings.get(event.itemId);
    if (!filing || time(event.at) < time(filing.filedAt)) throw new Error('scoreboard event has no original filing');
  }
  const cohort = [...filings.values()].filter(f => inside(f.filedAt));
  const countsBySource: Record<string, number> = {}, routes: Record<string, number> = {}, reasons: Record<string, number> = {};
  let reviewed = 0, onTime = 0, bypassed = 0, pending = 0;
  const rows = cohort.map(filing => {
    increment(countsBySource, filing.source);
    const first = (events: Array<{ itemId: string; at: string }>) => events
      .filter(e => e.itemId === filing.itemId && time(e.at) <= measured)
      .reduce<{ at: string } | undefined>((best, e) => !best || time(e.at) < time(best.at) ? e : best, undefined);
    const review = first(history.reviews), flag = first(history.flags);
    const bypass = history.bypasses.filter(e => e.itemId === filing.itemId && time(e.at) <= measured)
      .sort((a, b) => time(a.at) - time(b.at) || a.route.localeCompare(b.route) || a.reason.localeCompare(b.reason))[0];
    if (bypass) { bypassed++; increment(routes, bypass.route); increment(reasons, bypass.reason); }
    const waitMs = review ? time(review.at) - time(filing.filedAt) : null;
    if (review) { reviewed++; if (waitMs! <= DAY) onTime++; } else pending++;
    return { itemId: filing.itemId, filedAt: filing.filedAt, decidedAt: review?.at ?? null, waitMs,
      ...(review ? {} : { rightCensoredAt: measuredAt }),
      ...(flag ? { flaggedAt: flag.at, dueAt: new Date(time(flag.at) + 2 * DAY).toISOString() } : {}) };
  }).sort((a, b) => a.itemId.localeCompare(b.itemId));
  const closes = { ordinary: 0, cleanup: 0, fold: 0, reopenedOrdinary: 0, adjustedOrdinary: 0 };
  for (const event of history.closes) if (inside(event.at)) closes[event.kind]++;
  for (const event of history.reopens) if (inside(event.at) && event.ordinary) closes.reopenedOrdinary++;
  closes.adjustedOrdinary = closes.ordinary - closes.reopenedOrdinary;
  const merges = { committed: 0, duplicate: 0, alreadyFolded: 0, protected: 0, failed: 0 };
  for (const event of history.merges) if (inside(event.at)) merges[event.outcome]++;
  for (const n of Object.values(claimable)) if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid claimability count');
  if (Object.keys(claimable).length !== 6 || claimable.population !== claimable.count + claimable.protected +
      claimable.held + claimable.blocked + claimable.unknown) throw new Error('claimability requires an exact disjoint partition');
  return {
    filedPerDayBySource: { countsBySource }, closedPerDay: closes,
    shareReviewed: { numerator: reviewed, denominator: cohort.length, onTimeNumerator: onTime, onTimeDenominator: cohort.length },
    shareBypassed: { numerator: bypassed, denominator: cohort.length, routes, reasons },
    reviewerWait: { rows, pending, rightCensored: pending, missing: 0 },
    mergesPerDay: merges, claimableCount: { ...claimable },
  };
}

interface CyclePacket {
  cycleId: string; registryHash: string; window: Window; expectedFireAt: null; actualFireAt: string;
  cohortWindow: { start: string; end: string; matureAt: string };
  measuredAt: string; source: { ref: string; sha256: string; totalRows: number; capturedAt: string };
  runtime: ReturnType<typeof resolveBuildInfo>;
  metrics: Record<R11MetricKey, { status: 'unknown'; reason: string }>;
  qualification: 'baseline';
}
const missingHistory = 'Complete canonical filing/close/reopen/review/bypass/fold event history and independent reconciliation are not yet qualified (P007/P009/P010).';

function validateWindow(window: Window) {
  if (window.workspaceId !== R11_METRIC_REGISTRY.population.workspaceId ||
      window.harnessSlug !== R11_METRIC_REGISTRY.population.harnessSlug) throw new Error('scoreboard scope mismatch');
  if (time(window.windowEnd) - time(window.windowStart) !== DAY) throw new Error('scoreboard requires one daily instrument window');
}

/** Capture and publish source + receipt without claiming events from row state.
 * Both identities are retained atomically in this single immutable packet. The
 * ledger receives this exact packet ref, including when qualification is unknown.
 */
export async function produceBugScoreboardCycle(window: Window, opts: {
  sql?: Sql; now?: Date; cycleId?: string;
} = {}): Promise<{ ref: string; cycleId: string }> {
  validateWindow(window);
  const now = opts.now ?? new Date(), actualFireAt = now.toISOString();
  if (time(window.windowEnd) > now.getTime()) throw new Error('scoreboard window is in the future');
  const sql = opts.sql ?? getOrgPg().sql;
  const cycleId = opts.cycleId ?? randomUUID();
  if (!cycleId.trim()) throw new Error('empty scoreboard cycle identity');
  const source = await freezeBugScoreboardSource({ sql, now });
  const packet: CyclePacket = {
    cycleId, registryHash: R11_METRIC_REGISTRY_HASH, window,
    // The rescore interface supplies an observation interval, not the scheduler's
    // intended fire. Preserve that absence; "now" cannot prove an on-time fire.
    expectedFireAt: null, actualFireAt, measuredAt: actualFireAt, source,
    cohortWindow: {
      start: new Date(Math.floor(now.getTime() / DAY) * DAY - 2 * DAY).toISOString(),
      end: new Date(Math.floor(now.getTime() / DAY) * DAY - DAY).toISOString(),
      matureAt: new Date(Math.floor(now.getTime() / DAY) * DAY).toISOString(),
    },
    runtime: resolveBuildInfo(), qualification: 'baseline',
    metrics: Object.fromEntries(R11_METRIC_REGISTRY.metrics.map(m =>
      [m.key, { status: 'unknown', reason: missingHistory }])) as CyclePacket['metrics'],
  };
  return { ref: await storeR11Evidence('cycle', packet, sql), cycleId };
}

/** Consume exactly the receipt this invocation produced. Matching a day or a
 * recent timestamp alone is insufficient: an earlier success is another cycle.
 * A missing source, changed registry or forged healthy field cannot certify it.
 */
export async function consumeBugScoreboardCycle(ref: string, cycleId: string, window: Window,
  opts: { sql?: Sql; now?: Date } = {}): Promise<Reading> {
  validateWindow(window);
  const sql = opts.sql ?? getOrgPg().sql, now = opts.now ?? new Date();
  const raw = await loadR11Evidence(ref, 'cycle', sql) as CyclePacket;
  if (!raw || raw.cycleId !== cycleId || raw.registryHash !== R11_METRIC_REGISTRY_HASH ||
      raw.window?.workspaceId !== window.workspaceId || raw.window?.harnessSlug !== window.harnessSlug ||
      raw.window?.windowStart !== window.windowStart || raw.window?.windowEnd !== window.windowEnd ||
      !Number.isFinite(Date.parse(raw.measuredAt)) || time(raw.measuredAt) > now.getTime() ||
      time(raw.measuredAt) < time(window.windowEnd) || now.getTime() - time(raw.measuredAt) > 300_000)
    throw new Error('scoreboard cycle identity/window/freshness mismatch');
  const source = await readBugScoreboardSource(raw.source.ref, { sql });
  if (raw.source.sha256 !== raw.source.ref.slice(-69, -5) || source.totalRows !== raw.source.totalRows ||
      source.rowsRead !== source.totalRows || source.omitted !== 0 || source.nextCursor !== null ||
      source.capturedAt !== raw.source.capturedAt || source.capturedAt !== raw.measuredAt ||
      Object.keys(raw.metrics ?? {}).length !== R11_METRIC_REGISTRY.metrics.length ||
      R11_METRIC_REGISTRY.metrics.some(m => raw.metrics[m.key]?.status !== 'unknown'))
    throw new Error('scoreboard source/metric receipt mismatch');
  // Historical qualification has no current producer. Never trust a stored
  // caller field, a hash, or integrity alone as author/history authentication.
  return { verdict: 'unknown', detail: `Recorded baseline cycle ${cycleId}; ${missingHistory}`,
    evidenceRefs: [ref, raw.source.ref], reportRef: ref };
}

/** Exported seam lets the native suite exercise failure-after-success without
 * replacing the global registry or introducing a second orchestration path. */
export function bugScoreboardRescore(deps: {
  produce?: typeof produceBugScoreboardCycle; consume?: typeof consumeBugScoreboardCycle;
} = {}): NonNullable<PlatformInstrument['rescore']> {
  return { windowMs: DAY, unit: 'count', scope: 'harness', resolve: async window => {
    const cycle = await (deps.produce ?? produceBugScoreboardCycle)(window);
    return (deps.consume ?? consumeBugScoreboardCycle)(cycle.ref, cycle.cycleId, window);
  } };
}
