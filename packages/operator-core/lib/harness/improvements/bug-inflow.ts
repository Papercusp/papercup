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
import { acceptanceLineageClosure, resolvePlanImplementerIdentities } from '../../acceptance-author-identity';
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

// Reuse the existing text-artifact store, as the roster audit does. Content
// addresses retain previous snapshots, receipts and failed epochs across restart;
// they are integrity witnesses, never authenticated authorship or history proof.
const R11_EVIDENCE_PREFIX = 'evidence/bug-backlog-inflow-and-duplicate-review-2026-11-13/p012/stored/';
const r11Digest = (content: string) => createHash('sha256').update(content).digest('hex');

export async function storeR11Evidence(kind: string, value: unknown, sql: Sql): Promise<string> {
  const content = canonicalJson({
    schemaVersion: 'bug-scoreboard-evidence-v1', kind,
    workspaceId: R11_METRIC_REGISTRY.population.workspaceId,
    harnessSlug: R11_METRIC_REGISTRY.population.harnessSlug,
    registryHash: R11_METRIC_REGISTRY_HASH, value,
  });
  const ref = `${R11_EVIDENCE_PREFIX}${kind}/${r11Digest(content)}.json`;
  await sql.unsafe(`INSERT INTO harness_shared.harness_text_artifacts
    (workspace_id, harness_slug, rel_path, content, updated_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (harness_slug, rel_path) DO NOTHING`, [
    R11_METRIC_REGISTRY.population.workspaceId, R11_METRIC_REGISTRY.population.harnessSlug,
    ref, content, Date.now(),
  ]);
  // Also detects a cross-workspace primary-key collision without overwriting it.
  await loadR11Evidence(ref, kind, sql);
  return ref;
}

export async function loadR11Evidence(ref: string, kind: string, sql: Sql): Promise<unknown> {
  const prefix = `${R11_EVIDENCE_PREFIX}${kind}/`;
  if (!ref.startsWith(prefix) || !ref.endsWith('.json') ||
      !r11Hash(ref.slice(prefix.length, -5))) throw new Error('invalid R11 evidence identity');
  const rows = await sql.unsafe(`SELECT content FROM harness_shared.harness_text_artifacts
    WHERE workspace_id = $1 AND harness_slug = $2 AND rel_path = $3`, [
    R11_METRIC_REGISTRY.population.workspaceId, R11_METRIC_REGISTRY.population.harnessSlug, ref,
  ]) as unknown as Array<{ content: string }>;
  if (rows.length !== 1 || r11Digest(rows[0].content) !== ref.slice(prefix.length, -5))
    throw new Error(`R11 evidence missing or changed: ${ref}`);
  const record: unknown = JSON.parse(rows[0].content);
  if (!r11Record(record) || record.schemaVersion !== 'bug-scoreboard-evidence-v1' ||
      record.kind !== kind || record.registryHash !== R11_METRIC_REGISTRY_HASH ||
      record.workspaceId !== R11_METRIC_REGISTRY.population.workspaceId ||
      record.harnessSlug !== R11_METRIC_REGISTRY.population.harnessSlug)
    throw new Error(`R11 evidence scope or registry mismatch: ${ref}`);
  return record.value;
}

export interface R11SourceRow {
  itemId: string;
  /** The complete database row, including retained payload evidence. No preview. */
  record: Record<string, unknown>;
}
interface R11SourceSnapshot {
  capturedAt: string;
  qualification: 'row-snapshot-only';
  rows: R11SourceRow[];
}

/** One MVCC statement freezes the COMPLETE exact population. No SQL LIMIT or
 * mutable keyset can strand a row inserted behind the consumer's cursor.
 * A row snapshot does not establish complete close/reopen/reviewer history. */
export async function freezeBugScoreboardSource(opts: { now?: Date; sql?: Sql } = {}): Promise<{
  ref: string; sha256: string; totalRows: number; capturedAt: string;
}> {
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql.unsafe(`SELECT w.feature_id AS item_id, to_jsonb(w) AS record
    FROM harness_shared.work_items w
    WHERE w.workspace_id = $1 AND w.harness_slug = $2 AND w.item_kind = 'bug'
      AND w.lane IS DISTINCT FROM 'observation'
    ORDER BY w.feature_id COLLATE "C"`, [
    R11_METRIC_REGISTRY.population.workspaceId, R11_METRIC_REGISTRY.population.harnessSlug,
  ]) as unknown as Array<{ item_id: string; record: Record<string, unknown> }>;
  const capturedAt = (opts.now ?? new Date()).toISOString();
  const snapshot: R11SourceSnapshot = {
    capturedAt, qualification: 'row-snapshot-only',
    rows: rows.map(row => ({ itemId: row.item_id, record: row.record })),
  };
  const ref = await storeR11Evidence('source', snapshot, sql);
  return { ref, sha256: ref.slice(-69, -5), totalRows: rows.length, capturedAt };
}

export interface R11SourcePage {
  ref: string; capturedAt: string; qualification: 'row-snapshot-only';
  totalRows: number; rowsRead: number; omitted: number; nextCursor: string | null;
  rows: R11SourceRow[];
}

async function loadR11SourceSnapshot(ref: string, sql: Sql): Promise<R11SourceSnapshot> {
  const raw = await loadR11Evidence(ref, 'source', sql);
  if (!r11Record(raw) || !Array.isArray(raw.rows) || raw.qualification !== 'row-snapshot-only' ||
      typeof raw.capturedAt !== 'string' || !Number.isFinite(r11Time(raw.capturedAt)))
    throw new Error('invalid R11 source snapshot');
  const ids = new Set<string>();
  for (const row of raw.rows) {
    if (!r11Record(row) || !r11Text(row.itemId) || ids.has(row.itemId) || !r11Record(row.record) ||
        row.record.feature_id !== row.itemId || row.record.workspace_id !== R11_METRIC_REGISTRY.population.workspaceId ||
        row.record.harness_slug !== R11_METRIC_REGISTRY.population.harnessSlug || row.record.item_kind !== 'bug' ||
        row.record.lane === 'observation') throw new Error('invalid R11 source population');
    ids.add(row.itemId);
  }
  return raw as unknown as R11SourceSnapshot;
}

function pageR11Source(ref: string, raw: R11SourceSnapshot, opts: { cursor?: string; pageSize?: number }): R11SourcePage {
  const size = opts.pageSize ?? 200;
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('R11 pageSize must be a positive safe integer');
  const digest = ref.slice(-69, -5);
  let offset = 0;
  if (opts.cursor !== undefined) {
    const parts = opts.cursor.split(':');
    if (parts.length !== 2 || parts[0] !== digest || !/^(0|[1-9][0-9]*)$/.test(parts[1]))
      throw new Error('R11 cursor does not belong to this frozen source');
    offset = Number(parts[1]);
  }
  if (!Number.isSafeInteger(offset) || offset > raw.rows.length) throw new Error('R11 cursor offset outside source');
  const end = size >= raw.rows.length - offset ? raw.rows.length : offset + size;
  return {
    ref, capturedAt: raw.capturedAt, qualification: 'row-snapshot-only',
    totalRows: raw.rows.length, rowsRead: end, omitted: raw.rows.length - end,
    nextCursor: end < raw.rows.length ? `${digest}:${end}` : null,
    rows: raw.rows.slice(offset, end),
  };
}

/** Page size bounds work/display, never truth. The cursor binds the immutable
 * full source and the exact next offset; it remains usable by a new process. */
export async function readBugScoreboardSourcePage(ref: string, opts: {
  cursor?: string; pageSize?: number; sql?: Sql;
} = {}): Promise<R11SourcePage> {
  if (opts.pageSize !== undefined && (!Number.isSafeInteger(opts.pageSize) || opts.pageSize < 1))
    throw new Error('R11 pageSize must be a positive safe integer');
  return pageR11Source(ref, await loadR11SourceSnapshot(ref, opts.sql ?? getOrgPg().sql), opts);
}

/** The production consumer follows EVERY page, including an exact-size last
 * page. A caller that intentionally pauses retains nextCursor and source ref. */
export async function readBugScoreboardSource(ref: string, opts: { pageSize?: number; sql?: Sql } = {}): Promise<R11SourcePage> {
  const snapshot = await loadR11SourceSnapshot(ref, opts.sql ?? getOrgPg().sql);
  const rows: R11SourceRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = pageR11Source(ref, snapshot, { ...opts, cursor });
    for (const row of page.rows) rows.push(row);
    if (page.nextCursor === null) return { ...page, rows };
    cursor = page.nextCursor;
  }
}

interface R11StoredManifest {
  input: Omit<BugInflowScoreboardInput, 'receipts'>;
  receipts: Array<{ writerRef: string; independentRef?: string; authorshipPostRef?: string }>;
}

/** Authenticate an exact retained packet through the existing local append-only
 * post substrate. The post body is JSON { schemaVersion, writerRef,
 * independentRef }; its author and time come only from the canonical row.
 * Re-read the complete current implementer/lineage population on EVERY call:
 * an earlier eligible receipt cannot authorize a later related implementation.
 * This authenticates authorship, never event capture or numerical correctness.
 */
export async function resolveR11IndependentEvidence(args: {
  writerRef: string; independentRef: string; authorshipPostRef: string;
  declaredAuthors: string[]; now?: Date; sql?: Sql;
}): Promise<NonNullable<R11ScoreboardReceipt['independent']>> {
  const sql = args.sql ?? getOrgPg().sql;
  const workspaceId = R11_METRIC_REGISTRY.population.workspaceId;
  const match = /^thread-post:([1-9][0-9]*)$/.exec(args.authorshipPostRef);
  if (!match || !Array.isArray(args.declaredAuthors) || args.declaredAuthors.some(a => !r11Text(a)))
    throw new Error('R11 independent authorship reference or declared authors invalid');
  const writer = await loadR11Evidence(args.writerRef, 'receipt', sql);
  const independent = await loadR11Evidence(args.independentRef, 'independent', sql);
  if (!r11Record(writer) || !r11Record(independent) || typeof writer.measuredAt !== 'string')
    throw new Error('R11 independent packet or writer invalid');
  const rows = await sql.unsafe(`SELECT author_id, body, created_at FROM harness_shared.coord_thread_posts
    WHERE workspace_id = $1 AND id = $2::bigint AND origin = 'local'`, [workspaceId, match[1]]) as unknown as
    Array<{ author_id: string | null; body: string; created_at: Date | string }>;
  const post = rows[0];
  if (rows.length !== 1 || !r11Text(post?.author_id)) throw new Error('R11 independent authorship is unverified');
  const signature: unknown = JSON.parse(post.body);
  if (!r11Record(signature) || signature.schemaVersion !== 'bug-scoreboard-independent-authorship-v1' ||
      signature.writerRef !== args.writerRef || signature.independentRef !== args.independentRef)
    throw new Error('R11 independent authorship does not bind these exact packets');
  const postedAt = new Date(post.created_at).getTime(), measuredAt = r11Time(writer.measuredAt);
  if (!Number.isFinite(postedAt) || !Number.isFinite(measuredAt) || postedAt < measuredAt ||
      postedAt > (args.now ?? new Date()).getTime()) throw new Error('R11 independent authorship time invalid');
  const canonicalAuthors = await resolvePlanImplementerIdentities(R11_METRIC_REGISTRY.authority.plan, { sql, workspaceId });
  if (!canonicalAuthors.length) throw new Error('R11 canonical implementation authors are unqualified');
  const authors = [...new Set([...canonicalAuthors, ...args.declaredAuthors])].sort();
  const lineage = await acceptanceLineageClosure(post.author_id, { sql, workspaceId, requireComplete: true });
  if (!lineage.has(post.author_id) || authors.some(author => lineage.has(author)))
    throw new Error('R11 independent author is related to an implementation/proof author');
  const receiptRef = await storeR11Evidence('authorship', {
    authorshipPostRef: args.authorshipPostRef, authorId: post.author_id,
    postedAt: new Date(postedAt).toISOString(), writerRef: args.writerRef, independentRef: args.independentRef,
    checkedAgainst: authors, lineage: [...lineage].sort(), checkedAt: (args.now ?? new Date()).toISOString(),
  }, sql);
  return { ...independent, artifactRef: args.independentRef, authorId: post.author_id,
    lineage: { eligible: true, checkedAgainst: authors, receiptRef } } as NonNullable<R11ScoreboardReceipt['independent']>;
}

/** Persist producer records and independent packets separately. Neither the
 * caller's authorId nor its claimed lineage becomes an authentication receipt. */
export async function persistBugScoreboardEvidence(input: BugInflowScoreboardInput,
  opts: { sql?: Sql; authorshipPosts?: Record<string, string> } = {}): Promise<{ manifestRef: string; receiptRefs: string[] }> {
  const sql = opts.sql ?? getOrgPg().sql;
  if (input.registryHash !== R11_METRIC_REGISTRY_HASH) throw new Error('R11 metric registry mismatch');
  const { receipts, ...header } = input;
  const stored: R11StoredManifest = { input: header, receipts: [] };
  for (const receipt of receipts) {
    const { independent, ...writer } = receipt;
    const writerRef = await storeR11Evidence('receipt', writer, sql);
    const independentRef = independent ? await storeR11Evidence('independent', independent, sql) : undefined;
    const authorshipPostRef = opts.authorshipPosts?.[receipt.id];
    if (authorshipPostRef !== undefined && (!independentRef || !/^thread-post:([1-9][0-9]*)$/.test(authorshipPostRef)))
      throw new Error('R11 authorship post requires an independent packet and canonical post reference');
    stored.receipts.push({ writerRef, ...(independentRef ? { independentRef } : {}),
      ...(authorshipPostRef ? { authorshipPostRef } : {}) });
  }
  return { manifestRef: await storeR11Evidence('manifest', stored, sql), receiptRefs: stored.receipts.map(r => r.writerRef) };
}

/** Retained-artifact transport to the existing assessor. A production resolver
 * must authenticate independent authorship AND qualify capture continuity before
 * supplying host-resolved independent inputs; stored self-claims are stripped
 * unless the exact packet has a canonical outside-lineage authorship post.
 * This reader therefore cannot certify a row snapshot as historical evidence. */
export async function readStoredBugScoreboard(manifestRef: string, opts: {
  now?: Date; sql?: Sql; pageSize?: number;
} = {}): Promise<R11ScoreboardAssessment> {
  const now = opts.now ?? new Date(), sql = opts.sql ?? getOrgPg().sql;
  const unknown = () => assessBugInflowScoreboard(undefined, now);
  try {
    const raw = await loadR11Evidence(manifestRef, 'manifest', sql);
    if (!r11Record(raw) || !r11Record(raw.input) || !Array.isArray(raw.receipts)) throw new Error('invalid R11 manifest');
    const input = { ...raw.input, receipts: [] } as unknown as BugInflowScoreboardInput;
    const refs: string[] = [];
    const authenticationErrors: string[] = [];
    for (const entry of raw.receipts) {
      if (!r11Record(entry) || !r11Text(entry.writerRef)) throw new Error('invalid R11 receipt reference');
      refs.push(entry.writerRef);
      const writer = await loadR11Evidence(entry.writerRef, 'receipt', sql);
      if (!r11Record(writer) || !r11Record(writer.source) || !r11Text(writer.source.ref)) throw new Error('invalid R11 writer receipt');
      const source = await readBugScoreboardSource(writer.source.ref, { sql, pageSize: opts.pageSize });
      if (source.totalRows !== writer.source.totalRows || writer.source.sha256 !== writer.source.ref.slice(-69, -5))
        throw new Error('R11 source count or hash mismatch');
      if (entry.independentRef !== undefined) {
        if (!r11Text(entry.independentRef)) throw new Error('invalid R11 independent reference');
        // Verify the actual packet bytes, while refusing its self-asserted author/lineage.
        await loadR11Evidence(entry.independentRef, 'independent', sql);
        refs.push(entry.independentRef);
      }
      const { independent: _untrusted, ...retained } = writer;
      const receipt = retained as unknown as R11ScoreboardReceipt;
      if (entry.authorshipPostRef !== undefined) {
        try {
          if (!r11Text(entry.authorshipPostRef) || !r11Text(entry.independentRef))
            throw new Error('R11 independent authorship binding invalid');
          receipt.independent = await resolveR11IndependentEvidence({ writerRef: entry.writerRef,
            independentRef: entry.independentRef, authorshipPostRef: entry.authorshipPostRef,
            declaredAuthors: input.implementationAuthors, now, sql });
          refs.push(receipt.independent.lineage.receiptRef, entry.authorshipPostRef);
          input.implementationAuthors = [...new Set([...input.implementationAuthors,
            ...receipt.independent.lineage.checkedAgainst])].sort();
        } catch (error) {
          // Preserve the writer's broken verdict even if authentication fails.
          if (r11Text(entry.authorshipPostRef)) refs.push(entry.authorshipPostRef);
          authenticationErrors.push(error instanceof Error ? error.message : 'R11 independent authentication failed');
        }
      }
      input.receipts.push(receipt);
    }
    const assessment = assessBugInflowScoreboard(input, now);
    assessment.retainedReceiptRefs.push(...refs);
    // Even authenticated authorship cannot promote a snapshot into history.
    if (assessment.verdict === 'healthy') assessment.verdict = 'unknown';
    if (assessment.independentVerdict === 'healthy') assessment.independentVerdict = 'unknown';
    assessment.reasons.push(...authenticationErrors, 'row snapshots do not qualify event-history continuity');
    if (input.receipts.some(r => !r.independent))
      assessment.reasons.push('independent artifact authorship is unverified for one or more receipts');
    return assessment;
  } catch (error) {
    const assessment = unknown();
    assessment.reasons.push(error instanceof Error ? error.message : 'R11 retained evidence unreadable');
    assessment.retainedReceiptRefs.push(manifestRef);
    return assessment;
  }
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
