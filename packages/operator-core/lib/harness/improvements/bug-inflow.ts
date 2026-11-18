/**
 * bug-inflow.ts — the stored daily inflow-vs-closes rollup behind the
 * `work.bugInflow` state cell and the fleet leader brief
 * (bug-inflow-one-problem-one-row-2026-10-18 P-007 / R-6, owner directive #1990).
 *
 * R-6: "The inflow state cell returns filed-per-day by source and closed-per-day
 * from stored values without a live aggregate query." So the work is split:
 *
 *   WRITE  refreshBugInflowDaily — the improvement-watchdog tick recomputes the
 *          current and previous UTC day for one workspace (two bounded index
 *          range scans over work_items) and upserts harness_shared.bug_inflow_daily
 *          (migration 1535). A finished day is final after the next day's first tick.
 *   READ   readBugInflowDaily — a plain SELECT of the stored rows. It never
 *          aggregates work_items, so a read is cheap and cannot time out on the
 *          fleet's hot table.
 *
 * Reuse note: work_items:burn_down already measures created/closed, but it is a
 * live, fleet-attributed census with no reporter dimension; this is the stored,
 * per-source daily series the brief needs. Nothing existing stored it.
 *
 * Population: issue family minus cleanup (bug | change | task), lane distinct from
 * 'observation'. Source = payload.source, else 'watchdog' when reporterKinds
 * names it, else 'role:<filedByRole>', else reporterKinds[0], else 'unattributed'.
 */
import { getOrgPg } from '@papercusp/db-org';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';

import { CLEANUP_ITEM_KIND } from '../../code-cleanup/cleanup-item-kind';
import { ISSUE_FAMILY_ROUTE_KINDS } from '../../work-nature/agent-work-predicate';
type Sql = ReturnType<typeof getOrgPg>['sql'];

const DAY_MS = 86_400_000;
/**
 * The issue family MINUS 'cleanup' (code-cleanup-campaigns-2026-10-26 P-003, R-3): cleanup
 * work is issue-family for routing but is excluded from bug/change backlog rollups; it
 * has its own backlog read (issues:list { kinds:['cleanup'] }).
 */
export const BUG_INFLOW_KINDS = ISSUE_FAMILY_ROUTE_KINDS.filter((k) => k !== CLEANUP_ITEM_KIND);
/** The writer recomputes this many UTC days per tick (today + yesterday). */
export const BUG_INFLOW_REFRESH_DAYS = 2;
export const BUG_INFLOW_DEFAULT_DAYS = 7;
export const BUG_INFLOW_MAX_DAYS = 30;
/** The watchdog ticks every few minutes; a newest row older than this means the writer stopped. */
export const BUG_INFLOW_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const BUG_INFLOW_TABLE = 'harness_shared.bug_inflow_daily';

/** Frozen before P012 implementation. The complete source edition is retained in
 * the existing artifacts store; changing its meaning requires a reviewed amendment. */
export const R11_METRIC_REGISTRY = Object.freeze({
  "schemaVersion": "bug-scoreboard-metrics-v1",
  "version": 1,
  "authority": {
    "plan": "bug-backlog-inflow-and-duplicate-review-2026-11-13",
    "rubric": "acceptance-bug-backlog-inflow-and-duplicate-review-2026-11-13",
    "revision": 17,
    "bar": "R-11",
    "barHash": "852cc0c320872f019f3965d41656287414cdfe572943c1f6bbf0338169c67ff7"
  },
  "population": {
    "workspaceId": "papercusp-workspace",
    "harnessSlug": "papercusp",
    "itemKind": "bug",
    "lane": "IS DISTINCT FROM observation",
    "excludeChildren": false
  },
  "time": {
    "timezone": "UTC",
    "window": "[startInclusive,endExclusive)",
    "filingClock": "original canonical filing event",
    "flagClock": "original flaggedAt; dueAt=flaggedAt+48h, never reset",
    "maturity": "24h after the last filing in the daily cohort; retain final day-eight tail"
  },
  "sourceTaxonomy": [
    "nonempty payload.source",
    "watchdog when reporterKinds includes watchdog",
    "role:<filedByRole>",
    "first nonempty reporterKinds entry",
    "unattributed"
  ],
  "metrics": [
    {
      "key": "filedPerDayBySource",
      "unit": "count-by-source",
      "definition": "Actual canonical filing events in the UTC window grouped by the recorded filing source; counted repeat occurrences are not new filed rows.",
      "components": [
        "countsBySource"
      ],
      "writerRefs": [
        "harness/improvements/bug-inflow.ts:BUG_INFLOW_SOURCE_SQL",
        "harness/improvements/capture-core.ts"
      ]
    },
    {
      "key": "closedPerDay",
      "unit": "count",
      "definition": "Actual transitions into a terminal state in the UTC window, retaining ordinary, administrative cleanup, committed fold and reopen events separately; adjusted ordinary closes equal ordinary close events minus reopens of ordinary closes in that window. A current closed_ts row snapshot is not an event ledger.",
      "components": [
        "ordinary",
        "cleanup",
        "fold",
        "reopenedOrdinary",
        "adjustedOrdinary"
      ],
      "writerRefs": [
        "work-items.ts:setWorkItemState",
        "issues-engineer.ts",
        "work-items-admission-bulk-dedup.ts"
      ]
    },
    {
      "key": "shareReviewed",
      "unit": "ratio",
      "definition": "Distinct eligible filed cohort members with an actual reviewer verdict divided by the complete eligible filed cohort; retain the separate 24h on-time numerator and denominator. Preserve original filing clocks, all pending and missing members; never infer a first review from the current round alone.",
      "components": [
        "numerator",
        "denominator",
        "onTimeNumerator",
        "onTimeDenominator"
      ],
      "writerRefs": [
        "harness/improvements/agent-review.ts",
        "harness/improvements/agent-review-policy.ts"
      ]
    },
    {
      "key": "shareBypassed",
      "unit": "ratio",
      "definition": "Distinct eligible filed cohort members with a recorded bypass route divided by that same complete eligible filed cohort; retain each route and reason. Missing route evidence is unknown.",
      "components": [
        "numerator",
        "denominator",
        "routes",
        "reasons"
      ],
      "writerRefs": [
        "harness/improvements/capture-core.ts",
        "work-items-admission-promoter.ts"
      ]
    },
    {
      "key": "reviewerWait",
      "unit": "milliseconds-per-row",
      "definition": "For every eligible cohort member retain original filing-to-actual-verdict duration; preserve original flaggedAt and 48h dueAt, pending/right-censored members and missing evidence. Do not replace per-row durations with a sample or reset clocks at epoch recovery.",
      "components": [
        "rows",
        "pending",
        "rightCensored",
        "missing"
      ],
      "writerRefs": [
        "harness/improvements/agent-review.ts",
        "harness/improvements/agent-review-policy.ts"
      ]
    },
    {
      "key": "mergesPerDay",
      "unit": "count",
      "definition": "Committed fold/merge events in the UTC window; retain duplicate, already-folded, protected and failed outcomes separately. A requested merge, retry or current duplicate_of link is not by itself a committed event.",
      "components": [
        "committed",
        "duplicate",
        "alreadyFolded",
        "protected",
        "failed"
      ],
      "writerRefs": [
        "work-items-admission-bulk-dedup.ts",
        "work-items-admission-promoter.ts"
      ]
    },
    {
      "key": "claimableCount",
      "unit": "count-as-of",
      "definition": "The canonical readIssueClaimability oracle at the exact as-of instant for an explicit workspace/harness/bug scope, without inherited personal/fleet filtering. Retain complete protected, held, blocked and unknown records; do not sum overlapping exclusion buckets or substitute writer-ready counts.",
      "components": [
        "count",
        "population",
        "protected",
        "held",
        "blocked",
        "unknown"
      ],
      "writerRefs": [
        "agent-tools/work_items/claimable.ts",
        "scheduler/get-next.ts:readIssueClaimability"
      ]
    }
  ],
  "evidence": {
    "raw": "retain integer components or complete per-row durations before any rounding",
    "source": "immutable snapshot/event-ledger identity and hash with explicit omissions and working continuation; incomplete or unqualified historical capture is UNKNOWN",
    "reconciliation": "separately authored query fingerprint distinct from writer; no writer aggregate import/call; compare every metric on every run",
    "provenance": "expected/actual fire, current serving runtime and exact candidate closure, source/query/config fingerprints, independently authenticated artifact and lineage receipt",
    "missing": "empty, unactivated, missing, stale, partial, self-authored, mismatched or unrehydratable evidence cannot be healthy"
  },
  "phase": {
    "P012": "build and arm; pre-activation receipts are baseline",
    "P013": "seven actual daily runs, final 24h maturation, retained adverse epochs and original deadlines; final shipment verifies exact artifact and consumer restart"
  },
  "qualification": "Existing row snapshots and newest-five reopen history are not complete event evidence. Current audit capture migration1643 is DRAFT; its presence is not deployment or continuity proof. Missing producer history remains explicitly UNKNOWN until actual P007/P009/P010 source qualification."
} as const);
export const R11_METRIC_REGISTRY_HASH = createHash('sha256')
  .update(JSON.stringify(R11_METRIC_REGISTRY)).digest('hex');
export type R11MetricKey = typeof R11_METRIC_REGISTRY.metrics[number]['key'];
export type R11Metrics = Partial<Record<R11MetricKey, Record<string, unknown>>>;
type R11Closure = Record<string, string>;

export interface R11ScoreboardEpoch {
  id: string; candidateSha: string; activatedAt: string; closure: R11Closure;
  originalClockHash: string; disposition: 'active' | 'failed' | 'unknown'; artifactRef: string;
  previousEpochId?: string;
  repair?: { decisionRef: string; evidenceRef: string };
}

/** These inputs belong to the server-side retained-evidence resolver. They are
 * not an authorization API: a production consumer must resolve the artifact,
 * authenticate its author and obtain the lineage receipt through canonical
 * readers before passing independent evidence here. Fixtures prove assessment,
 * never live authorship, capture continuity or shipment. */
export interface R11ScoreboardReceipt {
  id: string; epochId: string; routineId: string;
  windowStart: string; windowEnd: string; expectedFireAt: string; actualFireAt: string; measuredAt: string;
  registryHash: string; originalClockHash: string;
  runtime: { buildSha: string; closure: R11Closure };
  source: {
    ref: string; sha256: string; complete: boolean; totalRows: number; rowsRead: number;
    omitted: number; nextCursor: string | null; cohortSize: number;
  };
  writerQueryHash: string; writerAggregateRefs: string[]; metrics: R11Metrics;
  independent?: {
    artifactRef: string; authorId: string;
    lineage: { eligible: boolean; checkedAgainst: string[]; receiptRef: string };
    sourceHash: string; registryHash: string; queryHash: string; aggregateRefs: string[]; closure: R11Closure;
    originalClockHash: string; complete: boolean; omitted: number; metrics: R11Metrics;
  };
}
export interface BugInflowScoreboardInput {
  registryHash: string; implementationAuthors: string[]; activeEpochId: string;
  epochHistory: { complete: boolean; omitted: number; nextCursor: string | null; epochs: R11ScoreboardEpoch[] };
  cadence: { routineId: string; firstWindowStart: string; intervalMs: number; maxDelayMs: number; maxRuntimeMs: number };
  receipts: R11ScoreboardReceipt[];
}
export interface R11ScoreboardAssessment {
  verdict: 'healthy' | 'broken' | 'unknown';
  independentVerdict: 'healthy' | 'broken' | 'unknown';
  registryHash: string; checkedRuns: number; reasons: string[];
  retainedReceiptRefs: string[]; adverseEpochRefs: string[];
}

const r11Record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const r11Text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const r11Hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const r11Count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const r11Time = (v: string): number => Date.parse(v);
function r11Same(a: unknown, b: unknown): boolean {
  try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
}
function r11ClosureComplete(closure: R11Closure): boolean {
  return Object.keys(closure).length > 0 && Object.entries(closure).every(([path, hash]) => r11Text(path) && r11Hash(hash));
}
function r11Counts(v: unknown): v is Record<string, number> {
  return r11Record(v) && Object.entries(v).every(([key, count]) => r11Text(key) && r11Count(count));
}

/** Validate the frozen raw components, before rounded percentages or a verdict
 * comparison. A missing component cannot become zero. No source population is
 * truncated; retained source and receipt refs remain available on every result. */
function r11MetricComplete(key: R11MetricKey, value: unknown): value is Record<string, unknown> {
  if (!r11Record(value)) return false;
  const definition = R11_METRIC_REGISTRY.metrics.find(m => m.key === key)!;
  if (Object.keys(value).length !== definition.components.length ||
      !definition.components.every(component => Object.hasOwn(value, component))) return false;
  if (key === 'filedPerDayBySource') return r11Counts(value.countsBySource);
  if (key === 'shareReviewed' || key === 'shareBypassed') {
    if (!r11Count(value.numerator) || !r11Count(value.denominator) ||
        value.denominator === 0 || value.numerator > value.denominator) return false;
    if (key === 'shareReviewed') return r11Count(value.onTimeNumerator) &&
      r11Count(value.onTimeDenominator) && value.onTimeDenominator > 0 &&
      value.onTimeNumerator <= value.onTimeDenominator;
    return r11Counts(value.routes) && r11Counts(value.reasons) &&
      Object.values(value.routes).reduce((a, b) => a + b, 0) === value.numerator &&
      Object.values(value.reasons).reduce((a, b) => a + b, 0) === value.numerator;
  }
  if (key === 'reviewerWait') {
    if (!Array.isArray(value.rows) || !r11Count(value.pending) ||
        !r11Count(value.rightCensored) || value.missing !== 0) return false;
    const ids = new Set<string>();
    let pending = 0;
    for (const raw of value.rows) {
      if (!r11Record(raw) || !r11Text(raw.itemId) || ids.has(raw.itemId) ||
          typeof raw.filedAt !== 'string' || !Number.isFinite(r11Time(raw.filedAt))) return false;
      ids.add(raw.itemId);
      if (raw.decidedAt === null) {
        pending++;
        if (raw.waitMs !== null || typeof raw.rightCensoredAt !== 'string' ||
            !Number.isFinite(r11Time(raw.rightCensoredAt)) || r11Time(raw.rightCensoredAt) < r11Time(raw.filedAt)) return false;
      } else if (typeof raw.decidedAt !== 'string' || !Number.isFinite(r11Time(raw.decidedAt)) ||
          !r11Count(raw.waitMs) || raw.waitMs !== r11Time(raw.decidedAt) - r11Time(raw.filedAt)) return false;
      if (raw.flaggedAt !== undefined && (typeof raw.flaggedAt !== 'string' ||
          typeof raw.dueAt !== 'string' || !Number.isFinite(r11Time(raw.flaggedAt)) ||
          r11Time(raw.dueAt) !== r11Time(raw.flaggedAt) + 2 * DAY_MS)) return false;
    }
    return pending === value.pending && pending === value.rightCensored;
  }
  if (key === 'closedPerDay') return (
    ['ordinary', 'cleanup', 'fold', 'reopenedOrdinary'].every(k => r11Count(value[k])) &&
    Number.isSafeInteger(value.adjustedOrdinary) &&
    value.adjustedOrdinary === Number(value.ordinary) - Number(value.reopenedOrdinary));
  if (!Object.values(value).every(r11Count)) return false;
  return key !== 'claimableCount' || (value.unknown === 0 &&
    value.population === Number(value.count) + Number(value.protected) + Number(value.held) + Number(value.blocked));
}

/** The retained denominator and original row clocks are an additional witness,
 * so two equal but incorrectly redefined aggregates cannot certify each other. */
function r11CohortAgrees(metrics: R11Metrics, r: R11ScoreboardReceipt): boolean {
  const filed = metrics.filedPerDayBySource!, reviewed = metrics.shareReviewed!;
  const bypassed = metrics.shareBypassed!, wait = metrics.reviewerWait!;
  if (!r11Counts(filed.countsBySource) || !Array.isArray(wait.rows)) return false;
  const totalFiled = Object.values(filed.countsBySource).reduce((a, b) => a + b, 0);
  const cohort = r.source.cohortSize;
  if (!Number.isSafeInteger(totalFiled) || totalFiled !== cohort || reviewed.denominator !== cohort ||
      reviewed.onTimeDenominator !== cohort || bypassed.denominator !== cohort || wait.rows.length !== cohort) return false;
  let decided = 0, onTime = 0;
  for (const raw of wait.rows) {
    if (!r11Record(raw) || typeof raw.filedAt !== 'string') return false;
    const filedAt = r11Time(raw.filedAt);
    if (filedAt < r11Time(r.windowStart) || filedAt >= r11Time(r.windowEnd)) return false;
    if (raw.decidedAt !== null) {
      if (typeof raw.decidedAt !== 'string' || r11Time(raw.decidedAt) > r11Time(r.measuredAt)) return false;
      decided++;
      if (Number(raw.waitMs) <= DAY_MS) onTime++;
    } else if (typeof raw.rightCensoredAt !== 'string' || r11Time(raw.rightCensoredAt) > r11Time(r.measuredAt)) return false;
  }
  return reviewed.numerator === decided && reviewed.onTimeNumerator === onTime;
}

/** Assess host-resolved retained evidence. All seven UTC windows and all seven
 * metrics are checked. Historical epochs and every input receipt keep recovery
 * references even when a current run is missing, corrupt or outside its window. */
export function assessBugInflowScoreboard(
  input: BugInflowScoreboardInput | undefined, now: Date,
): R11ScoreboardAssessment {
  const out: R11ScoreboardAssessment = {
    verdict: 'unknown', independentVerdict: 'unknown', registryHash: R11_METRIC_REGISTRY_HASH,
    checkedRuns: 0, reasons: [], retainedReceiptRefs: input?.receipts.map(r => r.id) ?? [],
    adverseEpochRefs: input?.epochHistory.epochs.filter(e => e.disposition !== 'active').map(e => e.artifactRef) ?? [],
  };
  if (!input) { out.reasons.push('no host-resolved scoreboard evidence; baseline only'); return out; }
  const unknown: string[] = [];
  const broken: string[] = [];
  const independentlyUnknown: string[] = [];
  const independentlyBroken: string[] = [];
  const epoch = input.epochHistory.epochs.find(e => e.id === input.activeEpochId);
  const cadence = input.cadence;
  const first = r11Time(cadence.firstWindowStart);
  if (input.registryHash !== R11_METRIC_REGISTRY_HASH) unknown.push('frozen metric registry mismatch');
  if (!input.epochHistory.complete || input.epochHistory.omitted !== 0 || input.epochHistory.nextCursor !== null)
    unknown.push('epoch history incomplete; follow retained continuation');
  if (!epoch || epoch.disposition !== 'active' || !r11Text(epoch.artifactRef) ||
      !/^[a-f0-9]{40}$/.test(epoch.candidateSha) || !r11ClosureComplete(epoch.closure) ||
      !r11Hash(epoch.originalClockHash) || !Number.isFinite(r11Time(epoch.activatedAt))) {
    out.reasons.push(...unknown, 'activation epoch is absent or unqualified'); return out;
  }
  if (new Set(input.epochHistory.epochs.map(e => e.id)).size !== input.epochHistory.epochs.length)
    unknown.push('duplicate epoch identity');
  if (!r11Text(cadence.routineId) || cadence.intervalMs !== DAY_MS || !Number.isFinite(first) ||
      first % DAY_MS !== 0 || first < r11Time(epoch.activatedAt) ||
      !Number.isFinite(new Date(first + 8 * DAY_MS).getTime()) ||
      !r11Count(cadence.maxDelayMs) || !r11Count(cadence.maxRuntimeMs)) {
    out.reasons.push(...unknown, 'daily UTC cadence is not qualified');
    return out;
  }
  if (epoch.previousEpochId) {
    const prior = input.epochHistory.epochs.find(e => e.id === epoch.previousEpochId);
    if (!prior || !r11Text(prior.artifactRef) || !r11Text(epoch.repair?.decisionRef) ||
        !r11Text(epoch.repair?.evidenceRef)) unknown.push('successor epoch lacks retained adverse epoch, Decision or evidenced repair');
    else {
      if (prior.candidateSha === epoch.candidateSha || r11Same(prior.closure, epoch.closure))
        broken.push('later timestamp or code-change-free restart is not a repair');
      if (prior.originalClockHash !== epoch.originalClockHash) broken.push('successor epoch reset original clocks');
    }
  }
  if (!input.implementationAuthors.length || !input.implementationAuthors.every(r11Text))
    independentlyUnknown.push('implementation/proof authors are unqualified');
  const windows = new Map<string, R11ScoreboardReceipt[]>();
  const ids = new Set<string>();
  for (const receipt of input.receipts) {
    if (!r11Text(receipt.id) || ids.has(receipt.id)) unknown.push('missing or duplicate receipt identity');
    ids.add(receipt.id);
    const group = windows.get(receipt.windowStart) ?? [];
    group.push(receipt);
    windows.set(receipt.windowStart, group);
    const offset = (r11Time(receipt.windowStart) - first) / DAY_MS;
    if (!Number.isInteger(offset) || offset < 0 || offset >= 7 || receipt.epochId !== epoch.id)
      unknown.push(`receipt outside the declared cohort: ${receipt.id}`);
  }
  for (let day = 0; day < 7; day++) {
    const start = first + day * DAY_MS;
    const startIso = new Date(start).toISOString();
    const receipts = windows.get(startIso) ?? [];
    if (receipts.length !== 1) { unknown.push(`expected exactly one receipt for ${startIso}`); continue; }
    const r = receipts[0];
    out.checkedRuns++;
    if (r11Time(r.windowEnd) !== start + DAY_MS || r.routineId !== cadence.routineId ||
        r.registryHash !== R11_METRIC_REGISTRY_HASH || r11Time(r.expectedFireAt) !== start + 2 * DAY_MS)
      unknown.push(`window/cadence/registry mismatch: ${r.id}`);
    const actual = r11Time(r.actualFireAt), measured = r11Time(r.measuredAt), expected = r11Time(r.expectedFireAt);
    if (![actual, measured, expected].every(Number.isFinite) || measured > now.getTime())
      unknown.push(`missing or future fire evidence: ${r.id}`);
    else if (actual < expected || actual > expected + cadence.maxDelayMs ||
        measured < actual || measured > actual + cadence.maxRuntimeMs)
      broken.push(`missing maturity or late fire: ${r.id}`);
    if (!r11ClosureComplete(r.runtime.closure) || !/^[a-f0-9]{40}$/.test(r.runtime.buildSha))
      unknown.push(`runtime closure unqualified: ${r.id}`);
    else if (!r11Same(r.runtime.closure, epoch.closure)) broken.push(`relevant candidate closure changed: ${r.id}`);
    if (r.originalClockHash !== epoch.originalClockHash) broken.push(`original clocks changed: ${r.id}`);
    if (!r11Text(r.source.ref) || !r11Hash(r.source.sha256) || !r.source.complete ||
        !r11Count(r.source.totalRows) || r.source.totalRows === 0 ||
        r.source.rowsRead !== r.source.totalRows || r.source.omitted !== 0 || r.source.nextCursor !== null ||
        !r11Count(r.source.cohortSize) || r.source.cohortSize === 0)
      unknown.push(`source incomplete, empty or unrecoverable: ${r.id}`);
    const independent = r.independent;
    const independentReady = independent && r11Text(independent.artifactRef) &&
      r11Text(independent.authorId) && !input.implementationAuthors.includes(independent.authorId) &&
      independent.lineage.eligible && r11Text(independent.lineage.receiptRef) &&
      input.implementationAuthors.every(author => independent.lineage.checkedAgainst.includes(author)) &&
      independent.sourceHash === r.source.sha256 && independent.registryHash === R11_METRIC_REGISTRY_HASH &&
      r11Same(independent.closure, epoch.closure) && independent.originalClockHash === epoch.originalClockHash &&
      independent.complete && independent.omitted === 0 && r11Hash(independent.queryHash) &&
      r11Hash(r.writerQueryHash) && independent.queryHash !== r.writerQueryHash &&
      r.writerAggregateRefs.length > 0 && r.writerAggregateRefs.every(r11Text) &&
      independent.aggregateRefs.length > 0 && independent.aggregateRefs.every(r11Text) &&
      !independent.aggregateRefs.some(ref => r.writerAggregateRefs.includes(ref));
    if (!independentReady) independentlyUnknown.push(`independent artifact/currentness/lineage unqualified: ${r.id}`);
    const keys = R11_METRIC_REGISTRY.metrics.map(m => m.key);
    if (Object.keys(r.metrics).length !== keys.length ||
        (independent && Object.keys(independent.metrics).length !== keys.length))
      unknown.push(`metric population differs from frozen registry: ${r.id}`);
    for (const key of keys) {
      const value = r.metrics[key];
      if (!r11MetricComplete(key, value)) unknown.push(`missing or malformed ${key}: ${r.id}`);
      if (independentReady && independent) {
        if (!r11MetricComplete(key, independent.metrics[key]))
          independentlyUnknown.push(`independent ${key} incomplete: ${r.id}`);
        else if (value && !r11Same(value, independent.metrics[key]))
          independentlyBroken.push(`numeric discrepancy for ${key}: ${r.id}`);
      }
    }
    if (keys.every(key => r11MetricComplete(key, r.metrics[key])) && !r11CohortAgrees(r.metrics, r))
      broken.push(`frozen cohort arithmetic or original row clocks disagree: ${r.id}`);
    if (independentReady && independent && keys.every(key => r11MetricComplete(key, independent.metrics[key])) &&
        !r11CohortAgrees(independent.metrics, r))
      independentlyBroken.push(`independent cohort arithmetic or original row clocks disagree: ${r.id}`);
  }
  const lastMeasured = input.receipts.reduce((last, r) => Math.max(last, r11Time(r.measuredAt)), 0);
  if (!Number.isFinite(lastMeasured) || now.getTime() - lastMeasured > DAY_MS + cadence.maxDelayMs + cadence.maxRuntimeMs)
    unknown.push('latest retained measurement is stale');
  out.independentVerdict = independentlyBroken.length ? 'broken' :
    independentlyUnknown.length || unknown.length || out.checkedRuns !== 7 ? 'unknown' : 'healthy';
  out.verdict = broken.length || independentlyBroken.length ? 'broken' :
    unknown.length || out.independentVerdict !== 'healthy' ? 'unknown' : 'healthy';
  out.reasons.push(...unknown, ...broken, ...independentlyUnknown, ...independentlyBroken);
  return out;
}


/** Reporter bucket for a work_items row aliased `w`. */
export const BUG_INFLOW_SOURCE_SQL = `coalesce(
    nullif(w.payload->>'source', ''),
    CASE WHEN jsonb_typeof(w.payload->'reporterKinds') = 'array' AND w.payload->'reporterKinds' ? 'watchdog' THEN 'watchdog' END,
    'role:' || nullif(w.payload->>'filedByRole', ''),
    CASE WHEN jsonb_typeof(w.payload->'reporterKinds') = 'array' THEN nullif(w.payload->'reporterKinds'->>0, '') END,
    'unattributed')`;

const POPULATION_SQL = `w.workspace_id = $1
    AND w.item_kind IN (${BUG_INFLOW_KINDS.map((k) => `'${k}'`).join(', ')})
    AND w.lane IS DISTINCT FROM 'observation'`;

/** Matches work_items_issue_created_at_idx's expression so the range is an index scan. */
const CREATED_AT_SQL = `to_timestamp(((w.created_ts)::numeric / 1000.0)::double precision)`;

export const BUG_INFLOW_REFRESH_SQL = `
WITH days AS (
  SELECT d::date AS day FROM generate_series($2::date, $3::date - 1, interval '1 day') AS d
),
filed AS (
  SELECT (${CREATED_AT_SQL} AT TIME ZONE 'UTC')::date AS day, ${BUG_INFLOW_SOURCE_SQL} AS source, count(*)::int AS n
    FROM harness_shared.work_items w
   WHERE ${POPULATION_SQL}
     AND ${CREATED_AT_SQL} >= ($2::date)::timestamp AT TIME ZONE 'UTC'
     AND ${CREATED_AT_SQL} <  ($3::date)::timestamp AT TIME ZONE 'UTC'
   GROUP BY 1, 2
),
closed AS (
  SELECT (to_timestamp(w.closed_ts / 1000.0) AT TIME ZONE 'UTC')::date AS day, w.status AS status, count(*)::int AS n
    FROM harness_shared.work_items w
   WHERE ${POPULATION_SQL}
     AND w.closed_ts >= $4::bigint AND w.closed_ts < $5::bigint
   GROUP BY 1, 2
)
INSERT INTO ${BUG_INFLOW_TABLE} AS t
  (workspace_id, day, filed_total, filed_by_source, closed_total, closed_by_status, computed_at)
SELECT $1, d.day,
       coalesce((SELECT sum(f.n) FROM filed f WHERE f.day = d.day), 0)::int,
       coalesce((SELECT jsonb_object_agg(f.source, f.n) FROM filed f WHERE f.day = d.day), '{}'::jsonb),
       coalesce((SELECT sum(c.n) FROM closed c WHERE c.day = d.day), 0)::int,
       coalesce((SELECT jsonb_object_agg(c.status, c.n) FROM closed c WHERE c.day = d.day), '{}'::jsonb),
       now()
  FROM days d
ON CONFLICT (workspace_id, day) DO UPDATE
   SET filed_total = EXCLUDED.filed_total, filed_by_source = EXCLUDED.filed_by_source,
       closed_total = EXCLUDED.closed_total, closed_by_status = EXCLUDED.closed_by_status,
       computed_at = EXCLUDED.computed_at
RETURNING day`;

export const BUG_INFLOW_READ_SQL = `
SELECT to_char(day, 'YYYY-MM-DD') AS day, filed_total, filed_by_source, closed_total, closed_by_status, computed_at
  FROM ${BUG_INFLOW_TABLE}
 WHERE workspace_id = $1 AND day >= $2::date AND day <= $3::date
 ORDER BY day DESC`;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function clampDays(days: number | undefined, fallback: number): number {
  const n = Math.trunc(Number.isFinite(days) ? (days as number) : fallback);
  return Math.min(Math.max(1, n), BUG_INFLOW_MAX_DAYS);
}

/** Recompute + upsert the last `days` UTC days (default today + yesterday). Returns the days written. */
export async function refreshBugInflowDaily(
  workspaceId: string,
  opts: { now?: Date; days?: number; sql?: Sql } = {},
): Promise<{ days: string[] }> {
  const sql = opts.sql ?? getOrgPg().sql;
  const days = clampDays(opts.days, BUG_INFLOW_REFRESH_DAYS);
  const endMs = Date.parse(`${utcDay((opts.now ?? new Date()).getTime())}T00:00:00Z`) + DAY_MS;
  const startMs = endMs - days * DAY_MS;
  const rows = await sql.unsafe(BUG_INFLOW_REFRESH_SQL, [
    workspaceId, utcDay(startMs), utcDay(endMs), startMs, endMs,
  ]) as unknown as Array<{ day: Date | string }>;
  return { days: rows.map((r) => (r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day))) };
}

export interface BugInflowRow {
  day: string;
  filed_total: number;
  filed_by_source: Record<string, number> | null;
  closed_total: number;
  closed_by_status: Record<string, number> | null;
  computed_at: Date | string;
}

export interface BugInflowDay {
  day: string;
  filedTotal: number;
  filedBySource: Record<string, number>;
  closedTotal: number;
  closedByStatus: Record<string, number>;
  /** filed − closed: positive means the backlog grew that day. */
  net: number;
}

export type BugInflowAssessment = 'measured' | 'stale' | 'unmeasured';

export interface BugInflowReading {
  conformance: { r11: R11ScoreboardAssessment };
  assessment: BugInflowAssessment;
  /** Why the assessment is not 'measured' (empty when it is). */
  reasons: string[];
  windowDays: number;
  /** Newest first; a day with no stored row is listed in missingDays, never as a zero. */
  days: BugInflowDay[];
  missingDays: string[];
  totals: {
    filed: number;
    closed: number;
    net: number;
    filedBySource: Record<string, number>;
    closedByStatus: Record<string, number>;
  };
  /** computed_at of the newest stored day; its age is what staleness is judged on. */
  computedAt: string | null;
  ageMs: number | null;
  storage: typeof BUG_INFLOW_TABLE;
}

function addInto(acc: Record<string, number>, part: Record<string, number> | null | undefined): void {
  for (const [k, v] of Object.entries(part ?? {})) acc[k] = (acc[k] ?? 0) + (Number(v) || 0);
}

/** Pure: stored rows → the reading the cell and the brief serve. */
export function shapeBugInflow(
  rows: readonly BugInflowRow[],
  opts: { now: Date; windowDays: number; scoreboard?: BugInflowScoreboardInput },
): BugInflowReading {
  const nowMs = opts.now.getTime();
  const today = utcDay(nowMs);
  const window = Array.from({ length: opts.windowDays }, (_, i) => utcDay(nowMs - i * DAY_MS));
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const days: BugInflowDay[] = [];
  const totals = { filed: 0, closed: 0, net: 0, filedBySource: {} as Record<string, number>, closedByStatus: {} as Record<string, number> };
  for (const day of window) {
    const r = byDay.get(day);
    if (!r) continue;
    const d: BugInflowDay = {
      day,
      filedTotal: Number(r.filed_total) || 0,
      filedBySource: { ...(r.filed_by_source ?? {}) },
      closedTotal: Number(r.closed_total) || 0,
      closedByStatus: { ...(r.closed_by_status ?? {}) },
      net: (Number(r.filed_total) || 0) - (Number(r.closed_total) || 0),
    };
    days.push(d);
    totals.filed += d.filedTotal;
    totals.closed += d.closedTotal;
    addInto(totals.filedBySource, d.filedBySource);
    addInto(totals.closedByStatus, d.closedByStatus);
  }
  totals.net = totals.filed - totals.closed;
  const missingDays = window.filter((d) => !byDay.has(d));
  const newest = rows.find((r) => r.day === days[0]?.day);
  const computedAt = newest ? new Date(newest.computed_at).toISOString() : null;
  const ageMs = computedAt ? Math.max(0, nowMs - Date.parse(computedAt)) : null;
  const reasons: string[] = [];
  if (days.length === 0) reasons.push(`no stored row in ${BUG_INFLOW_TABLE} for the last ${opts.windowDays} day(s); the improvement-watchdog writer has not run`);
  else {
    if (!byDay.has(today)) reasons.push(`no stored row for today (${today}); the writer has not run since UTC midnight`);
    if (ageMs !== null && ageMs > BUG_INFLOW_STALE_AFTER_MS) reasons.push(`newest row computed ${Math.round(ageMs / 60_000)}m ago (> ${BUG_INFLOW_STALE_AFTER_MS / 60_000}m)`);
  }
  const assessment: BugInflowAssessment = days.length === 0 ? 'unmeasured' : reasons.length ? 'stale' : 'measured';
  return { assessment, reasons, windowDays: opts.windowDays, days, missingDays, totals, computedAt, ageMs,
    storage: BUG_INFLOW_TABLE, conformance: { r11: assessBugInflowScoreboard(opts.scoreboard, opts.now) } };
}

/** Read the stored series. A SELECT on bug_inflow_daily only — never an aggregate over work_items. */
export async function readBugInflowDaily(
  workspaceId: string,
  opts: { days?: number; now?: Date; sql?: Sql } = {},
): Promise<BugInflowReading> {
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? new Date();
  const windowDays = clampDays(opts.days, BUG_INFLOW_DEFAULT_DAYS);
  const rows = await sql.unsafe(BUG_INFLOW_READ_SQL, [
    workspaceId, utcDay(now.getTime() - (windowDays - 1) * DAY_MS), utcDay(now.getTime()),
  ]) as unknown as BugInflowRow[];
  return shapeBugInflow(rows, { now, windowDays });
}

/** One line for the fleet brief: "inflow 7d: filed 812 (watchdog 530, role:su 190, …) vs closed 640 (done 410, dropped 230) · net +172". */
export function formatBugInflowLine(r: BugInflowReading, topSources = 4): string {
  if (r.assessment === 'unmeasured') return `bug inflow: unmeasured — ${r.reasons[0] ?? 'no stored rows'}`;
  const top = (o: Record<string, number>, n: number) => Object.entries(o)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
    .map(([k, v]) => `${k} ${v}`).join(', ');
  const today = r.days[0];
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const stale = r.assessment === 'stale' ? ` ⚠ stale: ${r.reasons.join('; ')}` : '';
  return `bug inflow ${r.days.length}d: filed ${r.totals.filed} (${top(r.totals.filedBySource, topSources)}) vs closed ${r.totals.closed} (${top(r.totals.closedByStatus, 3)}) · net ${sign(r.totals.net)}`
    + (today ? ` · ${today.day}: filed ${today.filedTotal} / closed ${today.closedTotal}` : '') + stale;
}
