/**
 * watchdog.ts — the HARD feed-in of the self-improvement loop
 * (close-the-self-improvement-loop-2026-06-05, D-003).
 *
 * Before this, the capture feed was agent-discretion only (the SU-prompt nudge +
 * the scheduled scan agent) — the backlog filled only when an agent remembered to
 * file. The watchdog fills it from SIGNALS: on a cadence it sweeps the operator's
 * own telemetry for things that are observably broken and auto-captures each as a
 * `kind=bug` improvement through the SAME `captureImprovement` core the tool uses
 * (so search-first dedup + the topic tagging + the kind column all hold).
 *
 * v1 signal sources (each one is a real "something is RED" surface that already
 * exists — no new instrumentation):
 *   - **red-test**            — `harness_shared.test_runs`: a test file that
 *                               failed repeatedly in the window AND is still
 *                               failing on its latest run (not a one-off dev red).
 *                               Carries the file path → feeds the protected-path gate.
 *   - **smoke-fail**          — `harness_shared.harness_smoke_test` rows with
 *                               status='fail' (the same signal plans:attention surfaces).
 *   - **repeated-tool-error** — `harness_shared.tool_invocations`: one tool
 *                               erroring/timing out ≥ threshold times in the window.
 *   - **service-down**        — the service-health monitor's last probe results
 *                               (a watched dev endpoint currently DOWN).
 *
 * Anti-flood (the plan's over-capture risk): `planWatchdogCaptures` is pure and
 * caps captures per tick (severity-ranked); cross-tick/cross-history dedup rides
 * the capture core's search-first with `dedupScope:'open'` (an OPEN duplicate
 * declines the re-file; a RESOLVED one means the problem regressed → re-file).
 */

import { getOrgPg } from '@papercusp/db-org';
import { lastServiceHealth, lastServiceHealthAt, type ProbeResult } from '../../service-health';
import { captureImprovement, type CaptureImprovementResult } from './capture-core';
import type { ImprovementSeverity } from './policy';

export type WatchdogSource = 'red-test' | 'smoke-fail' | 'repeated-tool-error' | 'service-down';

export interface WatchdogSignal {
  source: WatchdogSource;
  /** Stable per-signal identity within a tick (dedup key). */
  key: string;
  /** STABLE capture title — no counts/timestamps, so search-first dedup matches across ticks. */
  title: string;
  /** Detail: counts, samples, timestamps live here, not in the title. */
  body: string;
  severity: ImprovementSeverity;
  /** Repo-relative paths involved, when the signal knows them (feeds the path gate). */
  paths?: string[];
}

/**
 * Per-collector outcome for one tick (watchdog-robustness P-001). Persisted in the
 * tick record so the watchdog can detect its OWN broken collector (P-002): an
 * element with `ok:false` is a collector that threw this tick.
 */
export interface CollectorStatus {
  name: string;
  ok: boolean;
  /** Signals the collector produced (0 when it failed). */
  signalCount: number;
  /** Error message when `ok:false`. */
  error?: string;
  /** Non-error note (e.g. a deliberate skip — `service-down` on a stale snapshot, P-004). */
  note?: string;
}

/**
 * A collector may return a bare signal array OR this richer shape to carry a
 * non-error `note` (watchdog-robustness P-004 — e.g. the service-down collector
 * skipping a stale service-health snapshot). `collectWatchdogSignalsDetailed`
 * normalizes both.
 */
export interface CollectorResult {
  signals: WatchdogSignal[];
  note?: string;
}

/** One durable watchdog-tick record (watchdog-robustness P-001 / D-002). */
export interface WatchdogTickRecord {
  workspaceId: string;
  installSlug?: string | null;
  /** 'ran' = swept + captured; 'skipped' = another host held the cross-host lock (P-003). */
  status: 'ran' | 'skipped';
  signals: number;
  captured: string[];
  declinedDuplicates: number;
  deferred: number;
  collectors: CollectorStatus[];
  /** Improvement ids the watchdog filed ABOUT ITSELF this tick (P-002). */
  selfEscalations: string[];
}

const SEVERITY_RANK: Record<ImprovementSeverity, number> = { critical: 3, major: 2, minor: 1, nit: 0 };

export interface WatchdogPlanOptions {
  /** Max captures per tick (anti-flood). Default 3. */
  maxPerTick?: number;
}

export interface WatchdogPlan {
  toCapture: WatchdogSignal[];
  /** Signals dropped by the per-tick cap (still visible next tick if they persist). */
  deferred: WatchdogSignal[];
}

/** Pure: dedupe by key, rank by severity, cap per tick. */
export function planWatchdogCaptures(signals: WatchdogSignal[], opts: WatchdogPlanOptions = {}): WatchdogPlan {
  const maxPerTick = Math.max(0, opts.maxPerTick ?? 3);
  const seen = new Set<string>();
  const unique: WatchdogSignal[] = [];
  for (const s of signals) {
    const k = `${s.source}:${s.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(s);
  }
  unique.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return { toCapture: unique.slice(0, maxPerTick), deferred: unique.slice(maxPerTick) };
}

// ── signal collectors (IO) ───────────────────────────────────────────────────

export interface CollectOptions {
  /** Lookback for the red-test sweep. Default 6h. */
  redTestWindowHours?: number;
  /** Minimum fail count in the window (and the latest run must be a fail). Default 3. */
  redTestMinFails?: number;
  /** Lookback for the repeated-tool-error sweep. Default 1h. */
  toolErrorWindowMinutes?: number;
  /** Minimum error/timeout count per tool in the window. Default 5. */
  toolErrorMinCount?: number;
  /** Max age of the service-health snapshot to trust for service-down (P-004). Default 2× the 60s probe interval. */
  serviceHealthMaxStaleMs?: number;
}

type Sql = ReturnType<typeof getOrgPg>['sql'];

/**
 * red-test: a test file that failed ≥ N times in the window AND whose LATEST run
 * in the window is still a fail — i.e. repeatedly red and currently red, not a
 * one-off dev iteration. Carries the file path (→ the protected-path gate).
 */
export async function collectRedTestSignals(sql: Sql, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const windowHours = opts.redTestWindowHours ?? 6;
  const minFails = opts.redTestMinFails ?? 3;
  const rows = await sql<{ file_path: string; framework: string; fails: number; sample: string | null }[]>`
    WITH recent AS (
      SELECT file_path, framework, status, output_tail,
             row_number() OVER (PARTITION BY file_path ORDER BY started_at DESC) AS rn
        FROM harness_shared.test_runs
       WHERE started_at > now() - make_interval(hours => ${windowHours})
         AND status IN ('pass', 'fail', 'error')
         -- Only plausible repo paths: the test-runner's own test suites record
         -- synthetic fixture rows ('b', 'fail', 'no-such-bin') into test_runs;
         -- a real run always carries a repo-relative path with a separator.
         AND file_path LIKE '%/%'
    )
    SELECT file_path,
           max(framework) AS framework,
           count(*) FILTER (WHERE status IN ('fail', 'error'))::int AS fails,
           max(output_tail) FILTER (WHERE status IN ('fail', 'error')) AS sample
      FROM recent
     GROUP BY file_path
    HAVING count(*) FILTER (WHERE status IN ('fail', 'error')) >= ${minFails}
       AND max(CASE WHEN rn = 1 THEN status END) IN ('fail', 'error')
     LIMIT 20`;
  return rows.map((r) => ({
    source: 'red-test' as const,
    key: r.file_path,
    title: `Test failing repeatedly: ${r.file_path}`,
    body:
      `Watchdog signal (red-test): ${r.file_path} (${r.framework}) failed ${r.fails}× in the last ` +
      `${windowHours}h and its latest run is still red.\n\nLast failure tail:\n${(r.sample ?? '').slice(-1500) || '(no output captured)'}`,
    severity: 'major' as const,
    paths: [r.file_path],
  }));
}

/** smoke-fail: a harness smoke test currently failing (the plans:attention signal). */
export async function collectSmokeFailSignals(sql: Sql, workspaceId: string): Promise<WatchdogSignal[]> {
  const rows = await sql<{ harness_slug: string; failure_content: string | null }[]>`
    SELECT harness_slug, failure_content
      FROM harness_shared.harness_smoke_test
     WHERE workspace_id = ${workspaceId}
       AND status = 'fail'
     LIMIT 20`;
  return rows.map((r) => ({
    source: 'smoke-fail' as const,
    key: r.harness_slug,
    title: `Smoke test failing in harness ${r.harness_slug}`,
    body: `Watchdog signal (smoke-fail): the ${r.harness_slug} smoke test is RED.\n\n${(r.failure_content ?? '').slice(0, 2000) || '(no failure content recorded)'}`,
    severity: 'major' as const,
  }));
}

interface ToolErrorRow {
  tool_name: string;
  n: number;
  sample: string | null;
}

/**
 * Pure (watchdog-robustness P-006 / D-006): a tool name belonging to the
 * self-improvement loop ITSELF — the watchdog must never file a tool-error
 * capture about its own capture path (a self-amplifying loop: it would file a
 * bug about the very tool it files bugs through). The loop's own health is the
 * self-escalation's job (P-002), not a self-captured tool-error.
 */
export function isImprovementLoopTool(toolName: string): boolean {
  return /^improvements:/.test(toolName) || /^system:improvement-/.test(toolName);
}

/** Pure: tool-error rows → signals, excluding the loop's own tools (D-006). */
export function toolErrorSignalsFromRows(rows: ToolErrorRow[], windowMinutes: number): WatchdogSignal[] {
  return rows
    .filter((r) => !isImprovementLoopTool(r.tool_name))
    .map((r) => ({
      source: 'repeated-tool-error' as const,
      key: r.tool_name,
      title: `Tool ${r.tool_name} erroring repeatedly`,
      body:
        `Watchdog signal (repeated-tool-error): ${r.tool_name} returned error/timeout ${r.n}× in the last ` +
        `${windowMinutes} minute(s).\n\nSample error: ${(r.sample ?? '').slice(0, 800) || '(no message)'}`,
      severity: r.n >= 20 ? ('major' as const) : ('minor' as const),
    }));
}

/** repeated-tool-error: one tool erroring/timing out ≥ threshold in the window. */
export async function collectToolErrorSignals(sql: Sql, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const windowMinutes = opts.toolErrorWindowMinutes ?? 60;
  const minCount = opts.toolErrorMinCount ?? 5;
  // Exclude the loop's own tools in SQL (correct + efficient) — `toolErrorSignalsFromRows`
  // re-applies the same predicate as a defense-in-depth guard (and the unit-test seam).
  const rows = await sql<ToolErrorRow[]>`
    SELECT tool_name, count(*)::int AS n, max(error_message) AS sample
      FROM harness_shared.tool_invocations
     WHERE status IN ('error', 'timeout')
       AND invoked_at > now() - make_interval(mins => ${windowMinutes})
       AND tool_name NOT LIKE 'improvements:%'
       AND tool_name NOT LIKE 'system:improvement-%'
     GROUP BY tool_name
    HAVING count(*) >= ${minCount}
     ORDER BY count(*) DESC
     LIMIT 10`;
  return toolErrorSignalsFromRows(rows, windowMinutes);
}

/** service-down: a watched dev endpoint currently DOWN per the service-health monitor. */
export function collectServiceDownSignals(
  results = lastServiceHealth(),
): WatchdogSignal[] {
  return results
    .filter((r) => !r.up && r.present !== false)
    .map((r) => ({
      source: 'service-down' as const,
      key: r.name,
      title: `Service ${r.name} is down`,
      body:
        `Watchdog signal (service-down): the service-health monitor reports "${r.name}" DOWN` +
        (r.status ? ` (HTTP ${r.status})` : ' (no response)') +
        (r.note ? ` — ${r.note}` : '') +
        '.',
      severity: 'major' as const,
    }));
}

/**
 * The service-health probe runs every 60s (a DBOS scheduled workflow). The
 * `lastServiceHealth()` snapshot is a module singleton — if the probe workflow
 * has STOPPED (or the host just restarted), it goes stale and would feed the
 * watchdog phantom up/down data. Default freshness window = 2× the probe
 * interval (watchdog-robustness P-004 / D-004).
 */
export const DEFAULT_SERVICE_HEALTH_MAX_STALE_MS = 2 * 60_000;

/** Pure: is the service-health snapshot too old (or never populated) to trust? (P-004) */
export function isServiceHealthStale(at: number | null, now: number, maxStaleMs: number): boolean {
  if (at == null) return true; // never probed this process
  return now - at > maxStaleMs;
}

/**
 * The default `service-down` collector with the P-004 freshness gate: emit
 * service-down signals only when the service-health snapshot is FRESH; on a stale
 * (or never-populated) snapshot, emit nothing and carry a `stale-service-health`
 * note so the skip is visible in the tick record rather than silently dropping
 * real downs or filing phantom ones.
 */
export function serviceDownCollectorResult(opts: {
  results?: ProbeResult[];
  at?: number | null;
  now?: number;
  maxStaleMs?: number;
} = {}): CollectorResult {
  const at = opts.at ?? lastServiceHealthAt();
  const now = opts.now ?? Date.now();
  const maxStaleMs = opts.maxStaleMs ?? DEFAULT_SERVICE_HEALTH_MAX_STALE_MS;
  if (isServiceHealthStale(at, now, maxStaleMs)) {
    const ageMs = at == null ? null : now - at;
    return {
      signals: [],
      note:
        `stale-service-health: snapshot ${ageMs == null ? 'never populated' : `is ${Math.round(ageMs / 1000)}s old`} ` +
        `(> ${Math.round(maxStaleMs / 1000)}s) — skipping service-down collection (the probe workflow may have stopped)`,
    };
  }
  return { signals: collectServiceDownSignals(opts.results ?? lastServiceHealth()) };
}

/** (P-011) Collector definition: a pluggable source of watchdog signals for a target. */
export interface WatchdogCollector {
  /** Collector name (e.g., 'papercusp-red-test', 'my-project-integration-test'). */
  name: string;
  /** Collect signals. Errors are caught + logged by runWatchdogTick. */
  collect: () => Promise<WatchdogSignal[]>;
}

/** Injectable collector seam (the routine handler uses the default; tests inject). */
export interface WatchdogDeps {
  collect: () => Promise<WatchdogSignal[]>;
  capture: typeof captureImprovement;
  /** Tick-record sink (P-001). Defaults to the PG writer; tests inject. */
  recordTick: (rec: WatchdogTickRecord) => Promise<void>;
}

/** (P-011) Default papercusp collectors: red-test, smoke-fail, repeated-tool-error, service-down. */
export async function defaultPapercuspCollectors(workspaceId: string, opts: CollectOptions = {}): Promise<WatchdogCollector[]> {
  return [
    {
      name: 'papercusp-red-test',
      collect: () => collectRedTestSignals(getOrgPg().sql, opts),
    },
    {
      name: 'papercusp-smoke-fail',
      collect: () => collectSmokeFailSignals(getOrgPg().sql, workspaceId),
    },
    {
      name: 'papercusp-repeated-tool-error',
      collect: () => collectToolErrorSignals(getOrgPg().sql, opts),
    },
    {
      name: 'papercusp-service-down',
      collect: () => Promise.resolve(collectServiceDownSignals()),
    },
  ];
}

/**
 * Collect signals AND the per-collector status (watchdog-robustness P-001). The
 * status array is what makes a forever-failing collector visible — before this
 * the only trace of a rejected collector was a `console.warn` nobody tails.
 */
export async function collectWatchdogSignalsDetailed(
  workspaceId: string,
  opts: CollectOptions = {},
  collectors?: WatchdogCollector[],
): Promise<{ signals: WatchdogSignal[]; collectors: CollectorStatus[] }> {
  // (P-011) Use provided collectors or default to papercusp
  const activeCollectors = collectors ?? (await defaultPapercuspCollectors(workspaceId, opts));

  const settled = await Promise.allSettled(activeCollectors.map((c) => c.collect()));
  const signals: WatchdogSignal[] = [];
  const statuses: CollectorStatus[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const name = activeCollectors[i]?.name ?? `collector[${i}]`;
    if (s.status === 'fulfilled') {
      signals.push(...s.value);
      statuses.push({ name, ok: true, signalCount: s.value.length });
    } else {
      const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
      console.warn(`[improvement-watchdog] collector "${name}" failed: ${error}`);
      statuses.push({ name, ok: false, signalCount: 0, error });
    }
  }
  return { signals, collectors: statuses };
}

/** Back-compat: signals only (delegates to the detailed collector). */
export async function collectWatchdogSignals(workspaceId: string, opts: CollectOptions = {}, collectors?: WatchdogCollector[]): Promise<WatchdogSignal[]> {
  return (await collectWatchdogSignalsDetailed(workspaceId, opts, collectors)).signals;
}

/**
 * Default tick-record sink (watchdog-robustness P-001): one row per tick into
 * `harness_shared.watchdog_ticks`. Injectable via `WatchdogDeps.recordTick` so
 * unit tests observe the record without PG. The caller swallows its errors — a
 * bookkeeping failure must never abort the tick.
 */
export async function recordWatchdogTick(rec: WatchdogTickRecord): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.watchdog_ticks
      (workspace_id, install_slug, status, signals, captured, declined_duplicates, deferred, collectors, self_escalations)
    VALUES (${rec.workspaceId}, ${rec.installSlug ?? null}, ${rec.status}, ${rec.signals},
            ${rec.captured}::text[], ${rec.declinedDuplicates}, ${rec.deferred},
            ${JSON.stringify(rec.collectors)}::text::jsonb, ${rec.selfEscalations}::text[])
  `;
}

export interface WatchdogTickResult {
  /** 'ran' = swept + captured; 'skipped' = another host held the cross-host lock (P-003). */
  status: 'ran' | 'skipped';
  signals: number;
  captured: string[];
  declinedDuplicates: number;
  deferred: number;
  /** Per-collector outcomes this tick (P-001) — the read path for self-escalation (P-002). */
  collectors: CollectorStatus[];
  /** Improvement ids the watchdog filed about its OWN broken collectors (P-002). */
  selfEscalations: string[];
}

/** Options the tick accepts beyond planning/collection (P-001 install slug). */
export interface WatchdogTickOptions extends WatchdogPlanOptions, CollectOptions {
  /** The routine's install slug, recorded on the tick (observability only). */
  installSlug?: string | null;
}

/**
 * One watchdog tick: collect → plan (cap) → capture each through the shared core
 * (`dedupScope:'open'` — an open duplicate declines; a resolved one re-files the
 * regression) → record the tick (P-001, best-effort). Returns a compact result
 * for the routine log.
 * (P-011) Accepts optional collectors for per-target-project sources.
 */
export async function runWatchdogTick(
  workspaceId: string,
  opts: WatchdogTickOptions = {},
  deps?: Partial<WatchdogDeps> & { collectors?: WatchdogCollector[] },
): Promise<WatchdogTickResult> {
  const capture = deps?.capture ?? captureImprovement;
  const recordTick = deps?.recordTick ?? recordWatchdogTick;

  // Collect signals + per-collector status. When a test injects `collect` we lose
  // per-collector granularity (the seam returns signals only), so synthesize one
  // 'injected' status so the tick record is still coherent.
  let signals: WatchdogSignal[];
  let collectors: CollectorStatus[];
  if (deps?.collect) {
    signals = await deps.collect();
    collectors = [{ name: 'injected', ok: true, signalCount: signals.length }];
  } else {
    const detailed = await collectWatchdogSignalsDetailed(workspaceId, opts, deps?.collectors);
    signals = detailed.signals;
    collectors = detailed.collectors;
  }

  const plan = planWatchdogCaptures(signals, opts);
  const captured: string[] = [];
  let declinedDuplicates = 0;
  for (const s of plan.toCapture) {
    let res: CaptureImprovementResult;
    try {
      res = await capture({
        title: s.title,
        kind: 'bug',
        body: s.body,
        severity: s.severity,
        paths: s.paths,
        foundDuring: 'improvement-watchdog',
        createdBy: 'system:improvement-watchdog',
        sourceRole: 'system',
        source: 'su',
        dedupScope: 'open',
      });
    } catch (e) {
      console.warn(`[improvement-watchdog] capture failed for ${s.source}:${s.key}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (res.created && res.issue) captured.push(res.issue.id);
    else if (res.reason === 'likely-duplicate') declinedDuplicates += 1;
  }

  const result: WatchdogTickResult = {
    status: 'ran',
    signals: signals.length,
    captured,
    declinedDuplicates,
    deferred: plan.deferred.length,
    collectors,
    selfEscalations: [],
  };

  // P-001: record the tick (best-effort — a bookkeeping failure never aborts it).
  try {
    await recordTick({
      workspaceId,
      installSlug: opts.installSlug ?? null,
      status: result.status,
      signals: result.signals,
      captured: result.captured,
      declinedDuplicates: result.declinedDuplicates,
      deferred: result.deferred,
      collectors: result.collectors,
      selfEscalations: result.selfEscalations,
    });
  } catch (e) {
    console.warn(`[improvement-watchdog] tick record failed: ${e instanceof Error ? e.message : e}`);
  }

  return result;
}
