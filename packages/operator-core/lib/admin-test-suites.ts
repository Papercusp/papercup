import { existsSync } from 'node:fs';
import { wsLocalKey } from './browser-workspace';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ADMIN_TEST_SUITES,
  type AdminTestCheckResult,
  type AdminTestStatus,
  type AdminTestSuiteDone,
  type AdminTestSuiteId,
  type AdminTestSuiteSpec,
} from './admin-test-suites-shared';

export interface AdminTestEventSink {
  suite: (payload: { suiteId: AdminTestSuiteId; label: string; startedAt: number; description: string }) => void;
  progress: (payload: { suiteId: AdminTestSuiteId; checkId: string; label: string; index: number; total: number }) => void;
  result: (payload: AdminTestCheckResult) => void;
  done: (payload: AdminTestSuiteDone) => void;
  log: (payload: { suiteId: AdminTestSuiteId; level: 'info' | 'warn' | 'error'; line: string }) => void;
}

interface SuiteContext {
  signal: AbortSignal;
  sink: AdminTestEventSink;
  spec: AdminTestSuiteSpec;
  repoRoot: string;
  desktopRoot: string;
  /** Tauri instance every tauri-agent-tools call is pinned to (null = no live bridge found). */
  bridgePid: number | null;
}

interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error: string | null;
}

interface DesktopState {
  origin: string;
  href: string;
  title: string;
  hasTauri: boolean;
  activeSlug: string;
}

interface RoutePage {
  href: string;
  /** Exact trimmed text of every h1 AND h2 on the page (predicates use Array.includes — exact element match). */
  h1: string[];
  domNodes: number;
  hasHarnessRoot: boolean;
  details: string[];
  summary: string;
}

interface MemoryRow {
  pid: number;
  name: string | null;
  rssKb: number;
  hwmKb: number;
  threads: number;
}

interface MemoryTree {
  totalRssKb: number;
  rows: MemoryRow[];
}

interface ChaosRecorderSummary {
  clicks: number;
  durationMs: number;
  maxInp: number;
  p95Inp: number;
  longTasks: number;
  errors: number;
  reloads: number;
  frameDrops: number;
  maxFrameMs: number;
  routes: string[];
}

interface AiExploreRunSummary {
  goal: string;
  steps: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  exitCode: number | null;
  errors: string[];
  logs: string[];
}

const SUITE_MAP = new Map(ADMIN_TEST_SUITES.map((suite) => [suite.id, suite] as const));
const SAFE_DEFAULT_IDS = ADMIN_TEST_SUITES.filter((suite) => suite.safeDefault).map((suite) => suite.id);

export function listAdminTestSuites(): AdminTestSuiteSpec[] {
  return ADMIN_TEST_SUITES;
}

export function expandAdminTestSuiteSelection(selection: AdminTestSuiteId | 'all-safe'): AdminTestSuiteId[] {
  return selection === 'all-safe' ? SAFE_DEFAULT_IDS : [selection];
}

export function isAdminTestSuiteId(value: string): value is AdminTestSuiteId {
  return SUITE_MAP.has(value as AdminTestSuiteId);
}

const BRIDGE_TOKEN_RE = /^tauri-dev-bridge-(\d+)\.token$/;

/** Live Tauri bridge pids advertised via tmpdir token files (the tauri-agent-tools discovery contract). */
async function listLiveBridgePids(): Promise<number[]> {
  const entries = await readdir(tmpdir()).catch(() => [] as string[]);
  const pids: number[] = [];
  for (const entry of entries) {
    const match = BRIDGE_TOKEN_RE.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    try {
      process.kill(pid, 0);
      pids.push(pid);
    } catch {
      /* dead instance — the CLI reaps its token lazily */
    }
  }
  return pids;
}

/** Pids on this operator's own ancestry chain — the dev-shell sidecar's ancestor IS its desktop. */
async function operatorAncestorPids(): Promise<Set<number>> {
  const out = new Set<number>();
  let pid = process.pid;
  for (let hops = 0; hops < 32 && pid > 1; hops += 1) {
    const fields = await readProcStatusFields(pid, ['PPid']);
    const ppid = Number(fields?.PPid ?? 0);
    if (!Number.isInteger(ppid) || ppid <= 1) break;
    out.add(ppid);
    pid = ppid;
  }
  return out;
}

/**
 * Pure pin decision — exported for tests. Throws on an ambiguous multi-instance
 * box rather than letting the CLI's discoverBridge() drive an arbitrary window.
 */
export function pickBridgePid(input: {
  explicit: number | null;
  envPid: number | null;
  live: number[];
  ancestors: Set<number>;
}): number | null {
  if (input.explicit !== null) return input.explicit;
  if (input.envPid !== null) return input.envPid;
  if (input.live.length === 0) return null; // checks fail with the normal bridge-unreachable error
  if (input.live.length === 1) return input.live[0];
  const own = input.live.find((pid) => input.ancestors.has(pid));
  if (own !== undefined) return own;
  throw new Error(
    `${input.live.length} Tauri instances are running (pids ${input.live.join(', ')}) — refusing to drive an arbitrary one. ` +
      'Pass tauriPid in the run request (or set PAPERCUSP_SUITE_TAURI_PID on the operator).',
  );
}

/**
 * Resolve the Tauri instance this run drives. Without a pin, tauri-agent-tools'
 * discoverBridge() picks whichever live token file lists first — on a box
 * running several desktops (the owner's seat + agents' Xvfb instances) a suite
 * run could navigate or chaos-click someone ELSE's window.
 */
async function resolveBridgePid(explicit: number | null): Promise<number | null> {
  const rawEnv = Number(process.env.PAPERCUSP_SUITE_TAURI_PID ?? '');
  return pickBridgePid({
    explicit,
    envPid: Number.isInteger(rawEnv) && rawEnv > 0 ? rawEnv : null,
    live: await listLiveBridgePids(),
    ancestors: await operatorAncestorPids(),
  });
}

export async function runAdminTestSuites(
  selection: AdminTestSuiteId | 'all-safe',
  sink: AdminTestEventSink,
  signal: AbortSignal,
  opts: { returnHref?: string | null; tauriPid?: number | null } = {},
): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const desktopRoot = resolveDesktopRoot(repoRoot);
  const suiteIds = expandAdminTestSuiteSelection(selection);
  const firstSpec = SUITE_MAP.get(suiteIds[0] ?? 'desktop-health') ?? ADMIN_TEST_SUITES[0];
  const bridgePid = await resolveBridgePid(opts.tauriPid ?? null);
  const ctxBase = { signal, sink, repoRoot, desktopRoot, bridgePid };
  const restoreCtx: SuiteContext = { ...ctxBase, spec: firstSpec };
  const returnHref = opts.returnHref ?? (await getDesktopState(restoreCtx).catch(() => null))?.href ?? null;
  try {
    for (const suiteId of suiteIds) {
      signal.throwIfAborted();
      const spec = SUITE_MAP.get(suiteId);
      if (!spec) continue;
      const ctx: SuiteContext = { ...ctxBase, spec };
      await runSuite(ctx);
    }
  } finally {
    if (returnHref) {
      await runTauri(restoreCtx, ['navigate', returnHref], 12_000).catch(() => undefined);
    }
  }
}

async function runSuite(ctx: SuiteContext): Promise<void> {
  const { spec, sink, signal } = ctx;
  signal.throwIfAborted();
  sink.suite({ suiteId: spec.id, label: spec.label, startedAt: Date.now(), description: spec.description });
  const startedAt = Date.now();
  const checks = getSuiteChecks(ctx);
  const results: AdminTestCheckResult[] = [];
  for (let index = 0; index < checks.length; index += 1) {
    signal.throwIfAborted();
    const check = checks[index];
    sink.progress({ suiteId: spec.id, checkId: check.id, label: check.label, index: index + 1, total: checks.length });
    const result = await executeCheck(ctx, check.id, check.label, check.run);
    results.push(result);
    sink.result(result);
  }
  const done = summarizeSuite(spec, results, Date.now() - startedAt);
  sink.done(done);
}

function getSuiteChecks(ctx: SuiteContext): Array<{
  id: string;
  label: string;
  run: () => Promise<Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'>>;
}> {
  switch (ctx.spec.id) {
    case 'desktop-health':
      return desktopHealthChecks(ctx);
    case 'admin-testing-core':
      return adminTestingCoreChecks(ctx);
    case 'admin-testing-extended':
      return adminTestingExtendedChecks(ctx);
    case 'desktop-performance':
      return desktopPerformanceChecks(ctx);
    case 'packaged-readiness':
      return packagedReadinessChecks(ctx);
    case 'memory-core':
      return memoryCoreChecks(ctx);
    case 'ai-explore-prompts':
      return aiExplorePromptChecks(ctx);
  }
}

function memoryCoreChecks(_ctx: SuiteContext) {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return [
    {
      id: 'memory-suite',
      label: 'Memory system end-to-end',
      run: async () => {
        const { buildMemoryCoreChecks } = await import('./memory/suite/checks');
        const checks = buildMemoryCoreChecks(runId);
        let failed = 0, warned = 0, passed = 0, skipped = 0;
        const failures: string[] = [];
        for (const c of checks) {
          const r = await c.run();
          if (r.status === 'fail') { failed += 1; failures.push(`${c.id}: ${r.actual}`); }
          else if (r.status === 'warn') warned += 1;
          else if (r.status === 'pass') passed += 1;
          else skipped += 1;
        }
        const status: 'pass' | 'warn' | 'fail' = failed > 0 ? 'fail' : warned > 0 ? 'warn' : 'pass';
        return {
          status,
          expected: 'All memory-system sub-checks pass.',
          actual: `${passed} pass · ${warned} warn · ${failed} fail · ${skipped} skip · ${checks.length} total`,
          details: failures.length > 0 ? failures.slice(0, 8) : undefined,
        };
      },
    },
  ];
}

async function executeCheck(
  ctx: SuiteContext,
  id: string,
  label: string,
  run: () => Promise<Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'>>,
): Promise<AdminTestCheckResult> {
  const startedAt = Date.now();
  try {
    ctx.signal.throwIfAborted();
    const result = await run();
    return {
      suiteId: ctx.spec.id,
      id,
      label,
      durationMs: Date.now() - startedAt,
      ...result,
    };
  } catch (error) {
    return {
      suiteId: ctx.spec.id,
      id,
      label,
      status: 'fail',
      expected: 'Check completes without throwing.',
      actual: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

function summarizeSuite(spec: AdminTestSuiteSpec, results: AdminTestCheckResult[], durationMs: number): AdminTestSuiteDone {
  const counts: Record<AdminTestStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) counts[result.status] += 1;
  const status: AdminTestStatus = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : counts.pass > 0 ? 'pass' : 'skip';
  return { suiteId: spec.id, label: spec.label, status, durationMs, counts };
}

function desktopHealthChecks(ctx: SuiteContext) {
  return [
    {
      id: 'bridge-health',
      label: 'Tauri bridge health',
      run: async () => {
        const health = await runTauriJson<{ uptime_ms: number; webview_ready: boolean; sidecars_alive: boolean }>(ctx, ['health', '--json']);
        if (!health.ok || !health.value) return fail('webview_ready=true and sidecars_alive=true.', describeCommandFailure(health));
        const { uptime_ms, webview_ready, sidecars_alive } = health.value;
        return statusResult(
          webview_ready && sidecars_alive,
          'webview_ready=true and sidecars_alive=true.',
          `webview_ready=${webview_ready}, sidecars_alive=${sidecars_alive}, uptime=${uptime_ms}ms.`,
        );
      },
    },
    {
      id: 'desktop-page-state',
      label: 'Desktop shell identity',
      run: async () => {
        const state = await getDesktopState(ctx);
        return statusResult(
          state.hasTauri && state.title.includes('Papercusp'),
          'hasTauri=true and a Papercusp page is loaded in the desktop shell.',
          `hasTauri=${state.hasTauri}, title=${state.title}, href=${state.href}.`,
        );
      },
    },
    {
      id: 'console-clean',
      label: 'Console error window',
      run: async () => {
        const result = await runTauriEvalResultJson<{ count: number; errs: Array<{ kind: string; detail?: string; target: string }> }>(
          ctx,
          `(async () => {
            const s = window.__papercuspPerfRecorder;
            if (s && Array.isArray(s.events)) s.events.length = 0;
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const errs = (window.__papercuspPerfRecorder?.events || [])
              .filter((event) => event.kind === 'console-error' || event.kind === 'unhandled-error')
              .map((event) => ({ kind: event.kind, detail: event.detail, target: event.target }));
            return { count: errs.length, errs };
          })()`,
        );
        if (!result.ok || !result.value) return fail('0 console errors during a 3s observation window.', describeCommandFailure(result));
        return statusResult(
          result.value.count === 0,
          '0 console errors during a 3s observation window.',
          result.value.count === 0 ? 'No console errors observed.' : `${result.value.count} console error event(s) observed.`,
          result.value.count > 0 ? result.value.errs.map((entry) => `${entry.kind}: ${entry.detail ?? entry.target}`).slice(0, 6) : undefined,
        );
      },
    },
    {
      id: 'voice-assets',
      label: 'Voice runtime assets',
      run: async () => {
        const assets = await runTauriEvalResultJson<Array<{ u: string; status?: number; contentType?: string | null; len?: string | null; error?: string }>>(
          ctx,
          `(async () => {
            const urls = [
              '/silero_vad_v5.onnx',
              '/vad.worklet.bundle.min.js',
              '/vad-runtime/ort-wasm-simd-threaded.wasm',
              '/vad-runtime/ort-wasm-simd-threaded.mjs',
              '/ort-wasm-simd-threaded.wasm',
              '/ort-wasm-simd-threaded.mjs',
            ];
            const out = [];
            for (const u of urls) {
              try {
                const r = await fetch(u, { method: 'HEAD' });
                out.push({ u, status: r.status, contentType: r.headers.get('content-type'), len: r.headers.get('content-length') });
              } catch (e) {
                out.push({ u, error: String(e) });
              }
            }
            return out;
          })()`,
        );
        if (!assets.ok || !assets.value) return fail('All required VAD/ONNX assets resolve successfully inside the Tauri webview.', describeCommandFailure(assets));
        const rows = assets.value;
        const required = rows;
        const requiredOk = required.every((row) => row.status === 200);
        const scriptTypesOk = rows
          .filter((row) => row.u.endsWith('.mjs') || row.u.endsWith('.js'))
          .every((row) => (row.contentType ?? '').includes('javascript'));
        const wasmTypesOk = rows
          .filter((row) => row.u.endsWith('.wasm'))
          .every((row) => (row.contentType ?? '').includes('wasm'));
        const pass = requiredOk && scriptTypesOk && wasmTypesOk;
        return statusResult(
          pass,
          'Silero model/worklet and ONNX runtime script+wasm assets resolve as real runtime assets (200 with correct MIME).',
          rows.map((row) => `${row.u} → ${row.status ?? 'ERR'}${row.contentType ? ` (${row.contentType})` : ''}${row.error ? ` ${row.error}` : ''}`).join(' · '),
        );
      },
    },
    {
      id: 'packaged-smoke-selector',
      label: 'Packaged smoke mount selector',
      run: async () => {
        const marker = await runTauriEvalJson<boolean>(ctx, `Boolean(document.querySelector('#root')?.firstElementChild)`);
        if (!marker.ok || typeof marker.value !== 'boolean') return fail('The packaged WDIO smoke selector (#root with mounted children) still exists.', describeCommandFailure(marker));
        return statusResult(
          marker.value,
          'The packaged WDIO smoke selector (#root with mounted children) still exists.',
          marker.value ? '#root contains mounted app content.' : '#root has no mounted app content in the current desktop DOM.',
        );
      },
    },
  ];
}

function aiExplorePromptChecks(ctx: SuiteContext) {
  const prompts = [
    {
      id: 'testing-tab-overview',
      label: 'Testing tab overview prompt',
      goal: 'Open the Testing page and summarize which testing tools are available. Do not change settings or run destructive actions.',
      startUrl: 'http://127.0.0.1:3055/admin/testing?tab=test-runs',
    },
    {
      id: 'plans-page-overview',
      label: 'Plans page overview prompt',
      goal: 'Open the Plans page and identify whether the page renders a plans list or an empty state. Do not edit plans.',
      startUrl: 'http://127.0.0.1:3055/admin/plans',
    },
  ];
  return prompts.map((prompt) => ({
    id: prompt.id,
    label: prompt.label,
    run: async () => {
      const summary = await runAiExplorePrompt(ctx, prompt.goal, prompt.startUrl);
      const ok = summary.errors.length === 0 && (summary.exitCode === null || summary.exitCode === 0) && summary.costUsd <= 0.15;
      return statusResult(
        ok,
        'AI Explore backend completes the prompt without errors and stays within the $0.15 per-prompt cap.',
        `${summary.steps} steps · ${summary.totalTokens} tokens · $${summary.costUsd.toFixed(4)} · exit=${summary.exitCode ?? 'unknown'}.`,
        [
          `goal: ${summary.goal}`,
          ...summary.errors.map((error) => `error: ${error}`),
          ...summary.logs.slice(-5).map((line) => `log: ${line}`),
        ],
      );
    },
  }));
}

// The testing console lives on the harness Tests tab (/adv) — the
// /admin/testing route was removed once the Tests tab covered it. Headings
// are exact h1/h2 text (readRoutePage collects both; AiExplorePanel only
// renders an h2).
const TESTS_TAB = '/adv?slug=papercup&tab=testing';

function adminTestingCoreChecks(ctx: SuiteContext) {
  return [
    routeCheck(ctx, 'live-route', 'Live metrics route', `${TESTS_TAB}&testsTab=vitals`, 'Live metrics'),
    routeCheck(ctx, 'chaos-route', 'Chaos route', `${TESTS_TAB}&testsTab=chaos-desktop`, 'Chaos (desktop)'),
    routeCheck(ctx, 'routes-route', 'Routes route', `${TESTS_TAB}&testsTab=routes`, 'Routes'),
    routeCheck(ctx, 'packaged-route', 'Packaged build route', `${TESTS_TAB}&testsTab=packaged`, 'Packaged build'),
  ];
}

function adminTestingExtendedChecks(ctx: SuiteContext) {
  return [
    routeCheck(ctx, 'ai-route', 'AI Explore route', `${TESTS_TAB}&testsTab=ai-explore`, 'AI Explore'),
    routeCheck(ctx, 'llm-route', 'LLM testing route', `${TESTS_TAB}&testsTab=llm`, 'LLM testing'),
  ];
}

function desktopPerformanceChecks(ctx: SuiteContext) {
  const startedAt = Date.now();

  return [
    {
      id: 'harness-warm-route',
      label: 'Harness warm route',
      run: async () => {
        await clearPerfRecorder(ctx);
        const state = await getDesktopState(ctx);
        const route = `/harness?slug=${encodeURIComponent(state.activeSlug)}&ws=default`;
        const result = await measureWarmRoute(ctx, route, (page) => page.href.includes('/harness') && page.hasHarnessRoot);
        return statusResult(
          result.ok && result.elapsedMs <= 1500,
          'Warm harness route settles within 1500ms in the Tauri desktop shell.',
          `${result.elapsedMs}ms · href=${result.page.href} · domNodes=${result.page.domNodes}.`,
          result.ok ? undefined : result.page.details,
        );
      },
    },
    {
      id: 'testing-live-warm-route',
      label: 'Testing live warm route',
      run: async () => {
        // The testing console lives on the harness Tests tab (/adv) — the
        // /admin/testing route was removed once the Tests tab covered it.
        const result = await measureWarmRoute(ctx, '/adv?slug=papercup&tab=testing&testsTab=vitals', (page) => page.href.includes('testsTab=vitals') && page.h1.includes('Live metrics'));
        return statusResult(
          result.ok && result.elapsedMs <= 1500,
          'Warm Tests tab (Live metrics) settles within 1500ms in the Tauri desktop shell.',
          `${result.elapsedMs}ms · href=${result.page.href} · domNodes=${result.page.domNodes}.`,
          result.ok ? undefined : result.page.details,
        );
      },
    },
    {
      id: 'plans-warm-route',
      label: 'Plans warm route',
      run: async () => {
        const result = await measureWarmRoute(ctx, '/admin/plans', (page) => page.href.includes('/admin/plans') && page.h1.includes('Plans'));
        return statusResult(
          result.ok && result.elapsedMs <= 1500,
          'Warm /admin/plans settles within 1500ms in the Tauri desktop shell.',
          `${result.elapsedMs}ms · href=${result.page.href} · domNodes=${result.page.domNodes}.`,
          result.ok ? undefined : result.page.details,
        );
      },
    },
    {
      id: 'chaos-recorder-usability',
      label: 'Chaos recorder usability',
      run: async () => {
        const summary = await runChaosRecorder(ctx, '/adv?slug=papercup&tab=testing&testsTab=test-runs', 5_000);
        const pass = summary.clicks > 0 && summary.maxInp <= 500 && summary.p95Inp <= 250 && summary.errors === 0 && summary.reloads === 0 && summary.frameDrops <= 8 && summary.maxFrameMs <= 200;
        return statusResult(
          pass,
          'Existing Chaos recorder can click around for 5s with p95 INP <=250ms, max INP <=500ms, no errors, no reloads, <=8 severe frame drops, and max frame <=200ms.',
          `${summary.clicks} clicks · p95=${summary.p95Inp}ms · max=${summary.maxInp}ms · errors=${summary.errors} · reloads=${summary.reloads} · frameDrops=${summary.frameDrops} · maxFrame=${summary.maxFrameMs}ms.`,
          [
            `routes: ${summary.routes.join(', ') || '(none)'}`,
            `duration=${summary.durationMs}ms`,
            `longTasks=${summary.longTasks}`,
          ],
        );
      },
    },
    {
      id: 'interaction-budget',
      label: 'Current slow-interaction budget',
      run: async () => {
        const summary = await runTauriEvalJson<{
          maxDuration: number;
          top: Array<{ duration: number; route: string; target: string }>;
        }>(
          ctx,
          `(() => {
            const events = (window.__papercuspPerfRecorder?.events || [])
              .filter((event) => event.kind === 'interaction' && Number(event.ts || 0) >= ${startedAt});
            const sorted = events
              .map((event) => ({ duration: Number(event.duration || 0), route: event.route || '', target: event.target || '' }))
              .sort((a, b) => b.duration - a.duration);
            return { maxDuration: sorted[0]?.duration || 0, top: sorted.slice(0, 5) };
          })()`,
        );
        if (!summary.ok || !summary.value) return fail('The desktop interaction recorder reports max interaction <= 200ms.', describeCommandFailure(summary));
        const top = summary.value.top.map((row) => `${row.duration}ms ${row.route} ${row.target}`).slice(0, 5);
        return statusResult(
          summary.value.maxDuration <= 200,
          'The desktop interaction recorder reports max interaction <= 200ms.',
          `max interaction=${summary.value.maxDuration}ms.`,
          top.length > 0 ? top : ['No recorded interactions present in the current buffer.'],
        );
      },
    },
    {
      id: 'desktop-memory-budget',
      label: 'Desktop RSS budget',
      run: async () => {
        await runTauri(ctx, ['navigate', 'http://localhost:3055/admin/testing?tab=test-runs&suite=desktop-performance'], 12_000).catch(() => undefined);
        await sleep(750, ctx.signal);
        // Close any stray recorder windows left by a previous chaos run (or a prior
        // failed run from this session) before reading RSS. A lingering
        // WebKitWebProcess from a leaked window can inflate RSS by several GB.
        await runTauriEvalResultJson<boolean>(
          ctx,
          `(async () => {
            const api = window.__TAURI__?.webviewWindow;
            if (!api?.getAllWebviewWindows) return true;
            const wins = await api.getAllWebviewWindows();
            await Promise.allSettled(
              wins
                .filter((w) => w.label !== 'main' && w.label.startsWith('papercusp-'))
                .map((w) => w.close()),
            );
            return true;
          })()`,
          10_000,
        ).catch(() => undefined);
        const pid = await getTauriPid(ctx);
        await sleep(1500, ctx.signal);
        if (!pid) return fail('The largest Tauri/WebKit process RSS stays below 3584MB.', 'Could not determine the running Tauri PID.');
        const tree = await readMemoryTree(pid);
        const top = [...tree.rows].sort((a, b) => b.rssKb - a.rssKb).slice(0, 5);
        const largest = top[0]?.rssKb ?? 0;
        return statusResult(
          largest <= 3_584 * 1024,
          'The largest Tauri/WebKit process RSS stays below 3584MB (512MB below the 4096MB kill threshold).',
          `${Math.round(largest / 1024)}MB max RSS across ${tree.rows.length} processes (${Math.round(tree.totalRssKb / 1024)}MB total).`,
          top.map((row) => `${row.pid} ${row.name ?? 'unknown'} → ${Math.round(row.rssKb / 1024)}MB RSS (HWM ${Math.round(row.hwmKb / 1024)}MB)`),
        );
      },
    },
  ];
}

function packagedReadinessChecks(ctx: SuiteContext) {
  return [
    {
      id: 'tauri-driver',
      label: 'tauri-driver installed',
      run: async () => {
        const exec = await runCommand('bash', ['-lc', 'command -v tauri-driver || true'], { cwd: ctx.repoRoot, signal: ctx.signal, timeoutMs: 5000 });
        const pathText = exec.stdout.trim();
        return statusResult(
          pathText.length > 0,
          'tauri-driver is present on PATH.',
          pathText.length > 0 ? pathText : 'tauri-driver not found on PATH.',
        );
      },
    },
    {
      id: 'webkit-webdriver',
      label: 'WebKit WebDriver installed',
      run: async () => {
        const exec = await runCommand('bash', ['-lc', 'command -v WebKitWebDriver || true'], { cwd: ctx.repoRoot, signal: ctx.signal, timeoutMs: 5000 });
        const pathText = exec.stdout.trim();
        return statusResult(
          pathText.length > 0,
          'WebKitWebDriver is present on PATH for Linux packaged runs.',
          pathText.length > 0 ? pathText : 'WebKitWebDriver not found on PATH.',
        );
      },
    },
    {
      id: 'wdio-deps',
      label: 'wdio deps installed',
      run: async () => {
        const wdioBin = path.join(ctx.repoRoot, 'tools', 'perf-test', 'wdio', 'node_modules', '.bin', 'wdio');
        return statusResult(
          existsSync(wdioBin),
          'tools/perf-test/wdio has its local npm install completed.',
          existsSync(wdioBin) ? `${wdioBin} exists.` : `${wdioBin} is missing.`,
        );
      },
    },
    {
      id: 'packaged-binary',
      label: 'packaged desktop binary present',
      run: async () => {
        const candidates = [
          path.join(ctx.desktopRoot, 'src-tauri', 'target', 'release', 'papercusp-desktop'),
          path.join(ctx.desktopRoot, 'src-tauri', 'target', 'debug', 'papercusp-desktop'),
        ];
        const found = candidates.find((candidate) => existsSync(candidate)) ?? null;
        return statusResult(
          Boolean(found),
          'A Tauri desktop binary exists at the packaged-runner paths.',
          found ? found : `No binary found at ${candidates.join(' or ')}.`,
        );
      },
    },
    {
      id: 'smoke-selector',
      label: 'packaged smoke selector stays valid',
      run: async () => {
        const marker = await runTauriEvalJson<boolean>(ctx, `Boolean(document.querySelector('#root')?.firstElementChild)`);
        if (!marker.ok || typeof marker.value !== 'boolean') return fail('The WDIO smoke spec selector (#root with mounted children) still exists.', describeCommandFailure(marker));
        return statusResult(
          marker.value,
          'The WDIO smoke spec selector (#root with mounted children) still exists.',
          marker.value ? '#root contains mounted app content.' : '#root has no mounted app content in the current desktop shell DOM.',
        );
      },
    },
  ];
}

function routeCheck(
  ctx: SuiteContext,
  id: string,
  label: string,
  route: string,
  heading: string,
) {
  return {
    id,
    label,
    run: async () => {
      const result = await measureRoute(ctx, route, (page) => page.h1.includes(heading));
      return statusResult(
        result.ok,
        `${route} resolves inside the Tauri desktop shell and renders “${heading}”.`,
        `${result.elapsedMs}ms · href=${result.page.href}.`,
        result.ok ? [result.page.summary] : result.page.details,
      );
    },
  };
}

function statusResult(
  pass: boolean,
  expected: string,
  actual: string,
  details?: string[],
): Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'> {
  return { status: pass ? 'pass' : 'fail', expected, actual, details };
}

function fail(
  expected: string,
  actual: string,
  details?: string[],
): Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'> {
  return { status: 'fail', expected, actual, details };
}

function resolveRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(path.join(dir, 'apps', 'operator', 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd());
}

function resolveDesktopRoot(repoRoot: string): string {
  const fromEnv = process.env.PAPERCUSP_DESKTOP_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // papercusp-desktop is an in-repo submodule now (desktop-submodule-of-papercup-2026-06-09).
  return path.resolve(repoRoot, 'papercusp-desktop');
}

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal: AbortSignal },
): Promise<ExecResult> {
  const startedAt = Date.now();
  return await new Promise<ExecResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    const finish = (result: ExecResult) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      opts.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      finish({ code: null, signal: null, stdout, stderr, durationMs: Date.now() - startedAt, timedOut, error: error.message });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout: stdout.trim(), stderr: stderr.trim(), durationMs: Date.now() - startedAt, timedOut, error: null });
    });
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* noop */ }
        }, opts.timeoutMs)
      : null;
  });
}

async function runTauri(ctx: SuiteContext, args: string[], timeoutMs = 12_000): Promise<ExecResult> {
  ctx.signal.throwIfAborted();
  const pinned = ctx.bridgePid !== null ? [...args, '--pid', String(ctx.bridgePid)] : args;
  ctx.sink.log({ suiteId: ctx.spec.id, level: 'info', line: `tauri-agent-tools ${pinned.join(' ')}` });
  return await runCommand('tauri-agent-tools', pinned, { cwd: ctx.repoRoot, signal: ctx.signal, timeoutMs });
}

async function runTauriJson<T>(ctx: SuiteContext, args: string[], timeoutMs = 12_000): Promise<{ ok: boolean; value: T | null; command: string; exec: ExecResult }> {
  const exec = await runTauri(ctx, args, timeoutMs);
  if (exec.error) return { ok: false, value: null, command: `tauri-agent-tools ${args.join(' ')}`, exec };
  try {
    return { ok: true, value: JSON.parse(exec.stdout) as T, command: `tauri-agent-tools ${args.join(' ')}`, exec };
  } catch {
    return { ok: false, value: null, command: `tauri-agent-tools ${args.join(' ')}`, exec };
  }
}

async function runTauriEvalJson<T>(ctx: SuiteContext, expression: string, timeoutMs = 12_000): Promise<{ ok: boolean; value: T | null; command: string; exec: ExecResult }> {
  return runTauriJson<T>(ctx, ['eval', `JSON.stringify(${expression})`], timeoutMs);
}

async function runTauriEvalResultJson<T>(ctx: SuiteContext, expression: string, timeoutMs = 12_000): Promise<{ ok: boolean; value: T | null; command: string; exec: ExecResult }> {
  const exec = await runTauri(ctx, ['eval', expression], timeoutMs);
  if (exec.error) return { ok: false, value: null, command: `tauri-agent-tools eval ${expression}`, exec };
  try {
    return { ok: true, value: JSON.parse(exec.stdout) as T, command: `tauri-agent-tools eval ${expression}`, exec };
  } catch {
    return { ok: false, value: null, command: `tauri-agent-tools eval ${expression}`, exec };
  }
}

function describeExecFailure(exec: ExecResult): string {
  const parts = [exec.error, exec.stderr, exec.stdout].filter(Boolean);
  return parts.join(' · ') || `exit ${exec.code ?? '?'}${exec.signal ? ` (${exec.signal})` : ''}`;
}

function describeCommandFailure(result: { command: string; exec: ExecResult }): string {
  const body = describeExecFailure(result.exec);
  return body ? `${result.command} → ${body}` : `${result.command} failed.`;
}

async function runAiExplorePrompt(ctx: SuiteContext, goal: string, startUrl: string): Promise<AiExploreRunSummary> {
  const state = await getDesktopState(ctx);
  const endpoint = new URL('/api/admin/testing/ai-explore', state.origin).toString();
  const script = `
    (async () => {
      const res = await fetch(${JSON.stringify(endpoint)}, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: ${JSON.stringify(goal)},
          startUrl: ${JSON.stringify(startUrl)},
          model: 'anthropic/claude-haiku-4-5',
          maxSteps: 8,
          maxCostUsd: 0.15,
          headless: true
        })
      });
      if (!res.ok || !res.body) {
        return { ok: false, status: res.status, text: await res.text().catch(() => '') };
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let currentEvent = null;
      const summary = {
        goal: ${JSON.stringify(goal)},
        steps: 0,
        totalMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        exitCode: null,
        errors: [],
        logs: []
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split(/\\r?\\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line === '') { currentEvent = null; continue; }
          if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue; }
          if (!line.startsWith('data: ') || !currentEvent) continue;
          const payload = JSON.parse(line.slice(6));
          if (currentEvent === 'step') summary.steps = Math.max(summary.steps, Number(payload.n || 0));
          else if (currentEvent === 'metrics') {
            summary.inputTokens = Number(payload.inputTokens || 0);
            summary.outputTokens = Number(payload.outputTokens || 0);
            summary.totalTokens = Number(payload.totalTokens || 0);
            summary.costUsd = Number(payload.costUsd || 0);
          } else if (currentEvent === 'done') {
            summary.totalMs = Number(payload.totalMs || 0);
            summary.steps = Math.max(summary.steps, Number(payload.steps || 0));
            summary.costUsd = Number(payload.costUsd || summary.costUsd || 0);
            summary.exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : null;
          } else if (currentEvent === 'error') {
            summary.errors.push(String(payload.message || 'unknown error'));
          } else if (currentEvent === 'log' && payload.level === 'error') {
            summary.logs.push(String(payload.line || '').slice(0, 300));
          }
        }
      }
      return { ok: true, summary };
    })()
  `;
  const result = await runTauriEvalResultJson<
    { ok: true; summary: AiExploreRunSummary } | { ok: false; status: number; text: string }
  >(ctx, script, 120_000);
  if (!result.ok || !result.value) {
    return { goal, steps: 0, totalMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, exitCode: null, errors: [describeCommandFailure(result)], logs: [] };
  }
  if (!result.value.ok) {
    return { goal, steps: 0, totalMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, exitCode: null, errors: [`HTTP ${result.value.status}: ${result.value.text}`], logs: [] };
  }
  return result.value.summary;
}

async function runChaosRecorder(ctx: SuiteContext, route: string, durationMs: number): Promise<ChaosRecorderSummary> {
  const state = await getDesktopState(ctx);
  const suiteRun = `suite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const routeUrl = new URL(route, state.origin);
  routeUrl.searchParams.set('__suiteRun', suiteRun);
  // The chaos recorder lives on the harness Tests tab (/adv) — the
  // /admin/testing route was removed once the Tests tab covered it. The
  // universalized ChaosDesktopPanel still reads chaosRoute/chaosDur/dry via
  // nuqs and installs the __pcChaosIdleReset hatch, so the driver flow below
  // works unchanged once pointed at the right tab.
  const chaosUrl = new URL('/adv', state.origin);
  chaosUrl.searchParams.set('slug', 'papercup');
  chaosUrl.searchParams.set('tab', 'testing');
  chaosUrl.searchParams.set('testsTab', 'chaos-desktop');
  chaosUrl.searchParams.set('chaosRoute', `${routeUrl.pathname}${routeUrl.search}${routeUrl.hash}`);
  chaosUrl.searchParams.set('chaosDur', durationMs <= 10_000 ? '10s' : '30s');
  chaosUrl.searchParams.set('dry', 'false');
  const ready = await measureRoute(ctx, chaosUrl.toString(), (page) => page.href.includes('testsTab=chaos-desktop'));
  if (!ready.ok) {
    return { clicks: 0, durationMs, maxInp: 0, p95Inp: 0, longTasks: 0, errors: 1, reloads: 0, frameDrops: 0, maxFrameMs: 0, routes: ready.page.details.length > 0 ? ready.page.details : ['chaos tab did not load'] };
  }
  let hydrated = false;
  for (let i = 0; i < 40; i += 1) {
    const probe = await runTauriEvalResultJson<{ resetReady: boolean; hasLaunch: boolean; hasStop: boolean }>(
      ctx,
      `(() => ({
        resetReady: typeof (window).__pcChaosIdleReset === 'function',
        hasLaunch: Array.from(document.querySelectorAll('button')).some((el) => (el.textContent || '').includes('Launch recorder window')),
        hasStop: Array.from(document.querySelectorAll('button')).some((el) => (el.textContent || '').includes('Stop')),
      }))()`,
      10_000,
    );
    if (probe.ok && probe.value && probe.value.resetReady && (probe.value.hasLaunch || probe.value.hasStop)) {
      hydrated = true;
      break;
    }
    await sleep(250, ctx.signal);
  }
  if (!hydrated) {
    return { clicks: 0, durationMs, maxInp: 0, p95Inp: 0, longTasks: 0, errors: 1, reloads: 0, frameDrops: 0, maxFrameMs: 0, routes: ['chaos tab controls did not hydrate'] };
  }
  // Reset any stuck run state (e.g. a previous test run left the chaos store in
  // 'launching' or 'recording' state, so the button shows 'Stop' instead of
  // 'Launch recorder window'). The __pcChaosIdleReset escape hatch is installed
  // by the lib's ChaosDesktopPanel while it is mounted.
  await runTauriEvalResultJson<boolean>(
    ctx,
    `(() => {
      const reset = (window).__pcChaosIdleReset;
      if (typeof reset === 'function') reset();
      return true;
    })()`,
    5_000,
  ).catch(() => undefined);
  for (let i = 0; i < 20; i += 1) {
    const idle = await runTauriEvalResultJson<{ hasLaunch: boolean }>(
      ctx,
      `(() => ({
        hasLaunch: Array.from(document.querySelectorAll('button')).some((el) => (el.textContent || '').includes('Launch recorder window')),
      }))()`,
      10_000,
    );
    if (idle.ok && idle.value?.hasLaunch) break;
    await sleep(250, ctx.signal);
  }
  await runTauriEvalJson<boolean>(
    ctx,
    `(() => {
      try { localStorage.removeItem('papercusp.testing.chaos-runs.v1'); } catch {}
      return true;
    })()`,
    10_000,
  ).catch(() => undefined);
  const launched = await runTauriEvalResultJson<{ ok: boolean; reason?: string }>(
    ctx,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find((el) => (el.textContent || '').includes('Launch recorder window'));
      if (!(btn instanceof HTMLButtonElement)) return { ok: false, reason: 'Launch recorder window button not found' };
      btn.click();
      return { ok: true };
    })()`,
    10_000,
  );
  if (!launched.ok || !launched.value?.ok) {
    const reason = launched.value && 'reason' in launched.value ? launched.value.reason : describeCommandFailure(launched);
    return { clicks: 0, durationMs, maxInp: 0, p95Inp: 0, longTasks: 0, errors: 1, reloads: 0, frameDrops: 0, maxFrameMs: 0, routes: [reason || 'chaos recorder launch failed'] };
  }
  const effectiveDurationMs = durationMs <= 10_000 ? 10_000 : 30_000;
  const deadline = Date.now() + effectiveDurationMs + 20_000;
  await sleep(effectiveDurationMs + 6_500, ctx.signal);
  while (Date.now() < deadline) {
    const summary = await runTauriEvalJson<{
      runId: string;
      durationMs: number;
      clicks: number;
      events: Array<{ kind: string; route: string; inp?: number; duration?: number }>;
      routes: Record<string, unknown>;
      reloads?: number;
      frameDrops?: number;
      maxFrameMs?: number;
    } | null>(
      ctx,
      `(() => {
        const getSnapshot = (window).__pcGetChaosSnapshot;
        if (typeof getSnapshot === 'function') {
          try {
            const snap = getSnapshot();
            const currentRunId = snap?.runId ?? null;
            if (currentRunId) {
              const fromSummary = snap?.lastSummary && snap.lastSummary.runId === currentRunId ? snap.lastSummary : null;
              const fromHistory = Array.isArray(snap?.history)
                ? (snap.history.find((run) => run && run.runId === currentRunId) ?? null)
                : null;
              if (fromSummary || fromHistory) return fromSummary ?? fromHistory;
            }
          } catch {
            // fall through to localStorage fallback
          }
        }
        try {
          const raw = localStorage.getItem('papercusp.testing.chaos-runs.v1');
          if (!raw) return null;
          const runs = JSON.parse(raw);
          return Array.isArray(runs) && runs[0] ? runs[0] : null;
        } catch {
          return null;
        }
      })()`,
      10_000,
    );
    if (summary.ok && summary.value) {
      const source = Array.isArray(summary.value.events) ? summary.value.events : [];
      const inps = source
        .filter((ev) => ev.kind === 'click' && typeof ev.inp === 'number')
        .map((ev) => Number(ev.inp))
        .sort((a, b) => a - b);
      const errors = source.filter((ev) => ev.kind === 'console-error' || ev.kind === 'unhandled-error').length;
      const longTasks = source.filter((ev) => ev.kind === 'long-task').length;
      const routes = Object.keys(summary.value.routes || {});
      return {
        clicks: Number(summary.value.clicks || inps.length),
        durationMs: Number(summary.value.durationMs || durationMs),
        maxInp: inps.length ? inps[inps.length - 1] : 0,
        p95Inp: inps.length ? inps[Math.min(inps.length - 1, Math.floor(inps.length * 0.95))] : 0,
        longTasks,
        errors,
        reloads: Number(summary.value.reloads || 0),
        frameDrops: Number(summary.value.frameDrops || 0),
        maxFrameMs: Number(summary.value.maxFrameMs || 0),
        routes,
      };
    }
    await sleep(500, ctx.signal);
  }
  return { clicks: 0, durationMs, maxInp: 0, p95Inp: 0, longTasks: 0, errors: 1, reloads: 0, frameDrops: 0, maxFrameMs: 0, routes: ['chaos recorder summary did not arrive before timeout'] };
}

async function getDesktopState(ctx: SuiteContext): Promise<DesktopState> {
  const state = await runTauriEvalJson<DesktopState>(
    ctx,
    `(() => {
      const url = new URL(location.href);
      return {
        origin: location.origin,
        href: location.href,
        title: document.title,
        hasTauri: Boolean(window.__TAURI_INTERNALS__),
        activeSlug: url.searchParams.get('slug') || localStorage.getItem(wsLocalKey('harness.activeProject')) || 'sheets',
      };
    })()`,
  );
  if (!state.ok || !state.value) {
    throw new Error(describeCommandFailure(state));
  }
  return state.value;
}

async function getTauriPid(ctx: SuiteContext): Promise<number | null> {
  const tree = await runTauriJson<{ tauri?: { pid?: number } }>(ctx, ['process-tree', '--json']);
  return tree.ok && tree.value?.tauri?.pid ? Number(tree.value.tauri.pid) : null;
}

async function readMemoryTree(rootPid: number): Promise<MemoryTree> {
  const rows: MemoryRow[] = [];
  const root = await readProcStatus(rootPid);
  if (root) rows.push(root);
  const procEntries = await readdir('/proc').catch(() => [] as string[]);
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const child = await readProcStatus(Number(entry));
    if (!child) continue;
    const status = await readProcStatusFields(Number(entry), ['PPid']);
    if (status?.PPid === String(rootPid)) rows.push(child);
  }
  return { totalRssKb: rows.reduce((sum, row) => sum + row.rssKb, 0), rows };
}


async function readProcStatus(pid: number): Promise<MemoryRow | null> {
  const fields = await readProcStatusFields(pid, ['Name', 'VmRSS', 'VmHWM', 'Threads']);
  if (!fields) return null;
  return {
    pid,
    name: fields.Name ?? null,
    rssKb: parseKb(fields.VmRSS),
    hwmKb: parseKb(fields.VmHWM),
    threads: Number(fields.Threads ?? '0'),
  };
}

async function readProcStatusFields(pid: number, names: string[]): Promise<Record<string, string> | null> {
  try {
    const text = await readFile(`/proc/${pid}/status`, 'utf8');
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx);
      if (!names.includes(key)) continue;
      out[key] = line.slice(idx + 1).trim();
    }
    return out;
  } catch {
    return null;
  }
}

function parseKb(value: string | undefined): number {
  if (!value) return 0;
  const num = Number(value.split(/\s+/)[0] ?? '0');
  return Number.isFinite(num) ? num : 0;
}

async function clearPerfRecorder(ctx: SuiteContext): Promise<void> {
  await runTauriEvalJson<boolean>(
    ctx,
    `(() => {
      const s = window.__papercuspPerfRecorder;
      if (s && Array.isArray(s.events)) s.events.length = 0;
      try { localStorage.removeItem('papercusp.testing.perf-events.v1'); } catch {}
      return true;
    })()`,
  ).catch(() => undefined);
}

async function measureWarmRoute(
  ctx: SuiteContext,
  route: string,
  predicate: (page: RoutePage) => boolean,
): Promise<{ ok: boolean; elapsedMs: number; page: RoutePage }> {
  await measureRoute(ctx, route, predicate);
  await sleep(250, ctx.signal);
  return measureRoute(ctx, route, predicate);
}

async function measureRoute(
  ctx: SuiteContext,
  route: string,
  predicate: (page: RoutePage) => boolean,
): Promise<{ ok: boolean; elapsedMs: number; page: RoutePage }> {
  const state = await getDesktopState(ctx);
  const target = route.startsWith('http') ? route : new URL(route, state.origin).toString();
  const currentUrl = new URL(state.href);
  const targetUrl = new URL(target);
  const currentRoot = currentUrl.pathname.split('/')[1] ?? '';
  const targetRoot = targetUrl.pathname.split('/')[1] ?? '';
  if (currentRoot === targetRoot) {
    const nav = await runTauriEvalJson<{ ok: boolean; href: string }>(
      ctx,
      `(() => {
        const target = new URL(${JSON.stringify(target)});
        const next = target.pathname + target.search + target.hash;
        history.pushState({}, '', next);
        window.dispatchEvent(new PopStateEvent('popstate'));
        return { ok: true, href: location.href };
      })()`,
    );
    if (!nav.ok || !nav.value) {
      return routeFailure(target, nav.exec.durationMs, describeCommandFailure(nav));
    }
  } else {
    const nav = await runTauri(ctx, ['navigate', target]);
    if (nav.error || nav.code !== 0) {
      return routeFailure(target, nav.durationMs, describeExecFailure(nav));
    }
  }
  const startedAt = Date.now();
  for (let i = 0; i < 24; i += 1) {
    await sleep(125, ctx.signal);
    const page = await readRoutePage(ctx);
    if (!page) continue;
    if (predicate(page)) {
      return { ok: true, elapsedMs: Date.now() - startedAt, page };
    }
  }
  const fallback = await readRoutePage(ctx);
  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    page: fallback ?? makeRoutePage(target, [], 0, false, [`route did not settle for ${target}`]),
  };
}

async function readRoutePage(ctx: SuiteContext): Promise<RoutePage | null> {
  const page = await runTauriEvalJson<{
    href: string;
    h1: string[];
    domNodes: number;
    hasHarnessRoot: boolean;
  }>(
    ctx,
    `(() => ({
      href: location.href,
      h1: Array.from(document.querySelectorAll('h1, h2')).map((node) => (node.textContent || '').trim()),
      domNodes: document.querySelectorAll('*').length,
      hasHarnessRoot: Boolean(document.querySelector('.h-root')),
    }))()`,
    10_000,
  );
  if (!page.ok || !page.value) return null;
  return makeRoutePage(page.value.href, page.value.h1, page.value.domNodes, page.value.hasHarnessRoot);
}

function routeFailure(target: string, elapsedMs: number, detail: string): { ok: false; elapsedMs: number; page: RoutePage } {
  return {
    ok: false,
    elapsedMs,
    page: makeRoutePage(target, [], 0, false, [detail]),
  };
}

function makeRoutePage(
  href: string,
  h1: string[],
  domNodes: number,
  hasHarnessRoot: boolean,
  details: string[] = [],
): RoutePage {
  return {
    href,
    h1,
    domNodes,
    hasHarnessRoot,
    details,
    summary: `${href} · h1=${h1.join(' | ') || '(none)'} · domNodes=${domNodes}${hasHarnessRoot ? ' · h-root' : ''}`,
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('Aborted');
  await new Promise<void>((resolve, reject) => {
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
