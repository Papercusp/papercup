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
import { lastServiceHealth } from '../../service-health';
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

/** repeated-tool-error: one tool erroring/timing out ≥ threshold in the window. */
export async function collectToolErrorSignals(sql: Sql, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const windowMinutes = opts.toolErrorWindowMinutes ?? 60;
  const minCount = opts.toolErrorMinCount ?? 5;
  const rows = await sql<{ tool_name: string; n: number; sample: string | null }[]>`
    SELECT tool_name, count(*)::int AS n, max(error_message) AS sample
      FROM harness_shared.tool_invocations
     WHERE status IN ('error', 'timeout')
       AND invoked_at > now() - make_interval(mins => ${windowMinutes})
     GROUP BY tool_name
    HAVING count(*) >= ${minCount}
     ORDER BY count(*) DESC
     LIMIT 10`;
  return rows.map((r) => ({
    source: 'repeated-tool-error' as const,
    key: r.tool_name,
    title: `Tool ${r.tool_name} erroring repeatedly`,
    body:
      `Watchdog signal (repeated-tool-error): ${r.tool_name} returned error/timeout ${r.n}× in the last ` +
      `${windowMinutes} minute(s).\n\nSample error: ${(r.sample ?? '').slice(0, 800) || '(no message)'}`,
    severity: r.n >= 20 ? ('major' as const) : ('minor' as const),
  }));
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

/** Injectable collector seam (the routine handler uses the default; tests inject). */
export interface WatchdogDeps {
  collect: () => Promise<WatchdogSignal[]>;
  capture: typeof captureImprovement;
}

export async function collectWatchdogSignals(workspaceId: string, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const { sql } = getOrgPg();
  const settled = await Promise.allSettled([
    collectRedTestSignals(sql, opts),
    collectSmokeFailSignals(sql, workspaceId),
    collectToolErrorSignals(sql, opts),
  ]);
  const collected = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  for (const s of settled) {
    if (s.status === 'rejected') {
      console.warn(`[improvement-watchdog] a collector failed: ${s.reason instanceof Error ? s.reason.message : s.reason}`);
    }
  }
  return [...collected, ...collectServiceDownSignals()];
}

export interface WatchdogTickResult {
  signals: number;
  captured: string[];
  declinedDuplicates: number;
  deferred: number;
}

/**
 * One watchdog tick: collect → plan (cap) → capture each through the shared core
 * (`dedupScope:'open'` — an open duplicate declines; a resolved one re-files the
 * regression). Returns a compact result for the routine log.
 */
export async function runWatchdogTick(
  workspaceId: string,
  opts: WatchdogPlanOptions & CollectOptions = {},
  deps?: Partial<WatchdogDeps>,
): Promise<WatchdogTickResult> {
  const collect = deps?.collect ?? (() => collectWatchdogSignals(workspaceId, opts));
  const capture = deps?.capture ?? captureImprovement;
  const signals = await collect();
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
  return { signals: signals.length, captured, declinedDuplicates, deferred: plan.deferred.length };
}
