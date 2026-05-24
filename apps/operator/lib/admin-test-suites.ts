import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
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

export async function runAdminTestSuites(
  selection: AdminTestSuiteId | 'all-safe',
  sink: AdminTestEventSink,
  signal: AbortSignal,
  opts: { returnHref?: string | null } = {},
): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const desktopRoot = resolveDesktopRoot(repoRoot);
  const suiteIds = expandAdminTestSuiteSelection(selection);
  const firstSpec = SUITE_MAP.get(suiteIds[0] ?? 'desktop-health') ?? ADMIN_TEST_SUITES[0];
  const ctxBase = { signal, sink, repoRoot, desktopRoot };
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
  }
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

function adminTestingCoreChecks(ctx: SuiteContext) {
  return [
    routeCheck(ctx, 'live-route', 'Live metrics route', '/admin/testing?tab=live', 'Live metrics'),
    routeCheck(ctx, 'chaos-route', 'Chaos route', '/admin/testing?tab=chaos', 'Chaos'),
    routeCheck(ctx, 'routes-route', 'Routes route', '/admin/testing?tab=routes', 'Routes'),
    routeCheck(ctx, 'packaged-route', 'Packaged build route', '/admin/testing?tab=packaged', 'Packaged build'),
  ];
}

function adminTestingExtendedChecks(ctx: SuiteContext) {
  return [
    routeCheck(ctx, 'ai-route', 'AI Explore route', '/admin/testing?tab=ai', 'AI Explore'),
    routeCheck(ctx, 'llm-route', 'LLM testing route', '/admin/testing?tab=llm', 'LLM testing'),
  ];
}

function desktopPerformanceChecks(ctx: SuiteContext) {
  return [
    {
      id: 'harness-warm-route',
      label: 'Harness warm route',
      run: async () => {
        await runTauriEvalJson<boolean>(ctx, `(() => { const s = window.__papercuspPerfRecorder; if (s && Array.isArray(s.events)) s.events.length = 0; return true; })()`);
        const state = await getDesktopState(ctx);
        const route = `/harness?slug=${encodeURIComponent(state.activeSlug)}&ws=default`;
        const result = await measureRoute(ctx, route, (page) => page.href.includes('/harness') && page.hasHarnessRoot);
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
        const result = await measureRoute(ctx, '/admin/testing?tab=live', (page) => page.href.includes('/admin/testing') && page.h1.includes('Live metrics'));
        return statusResult(
          result.ok && result.elapsedMs <= 1500,
          'Warm /admin/testing?tab=live settles within 1500ms in the Tauri desktop shell.',
          `${result.elapsedMs}ms · href=${result.page.href} · domNodes=${result.page.domNodes}.`,
          result.ok ? undefined : result.page.details,
        );
      },
    },
    {
      id: 'plans-warm-route',
      label: 'Plans warm route',
      run: async () => {
        const result = await measureRoute(ctx, '/admin/plans', (page) => page.href.includes('/admin/plans') && page.h1.includes('Plans'));
        return statusResult(
          result.ok && result.elapsedMs <= 1500,
          'Warm /admin/plans settles within 1500ms in the Tauri desktop shell.',
          `${result.elapsedMs}ms · href=${result.page.href} · domNodes=${result.page.domNodes}.`,
          result.ok ? undefined : result.page.details,
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
            const events = (window.__papercuspPerfRecorder?.events || []).filter((event) => event.kind === 'interaction');
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
        const pid = await getTauriPid(ctx);
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
  const sibling = path.resolve(repoRoot, '..', 'papercusp-desktop');
  return sibling;
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
  ctx.sink.log({ suiteId: ctx.spec.id, level: 'info', line: `tauri-agent-tools ${args.join(' ')}` });
  return await runCommand('tauri-agent-tools', args, { cwd: ctx.repoRoot, signal: ctx.signal, timeoutMs });
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
        activeSlug: url.searchParams.get('slug') || localStorage.getItem('harness.activeProject') || 'sheets',
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

async function measureRoute(
  ctx: SuiteContext,
  route: string,
  predicate: (page: { href: string; h1: string[]; bodyText: string; domNodes: number; hasHarnessRoot: boolean; details: string[]; summary: string }) => boolean,
): Promise<{ ok: boolean; elapsedMs: number; page: { href: string; h1: string[]; bodyText: string; domNodes: number; hasHarnessRoot: boolean; details: string[]; summary: string } }> {
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
      return {
        ok: false,
        elapsedMs: nav.exec.durationMs,
        page: {
          href: target,
          h1: [],
          bodyText: '',
          domNodes: 0,
          details: [describeCommandFailure(nav)],
          summary: `navigate failed for ${target}`,
        },
      };
    }
  } else {
    const nav = await runTauri(ctx, ['navigate', target]);
    if (nav.error || nav.code !== 0) {
      return {
        ok: false,
        elapsedMs: nav.durationMs,
        page: {
          href: target,
          h1: [],
          bodyText: '',
          domNodes: 0,
          details: [describeExecFailure(nav)],
          summary: `navigate failed for ${target}`,
        },
      };
    }
  }
  const startedAt = Date.now();
  for (let i = 0; i < 24; i += 1) {
    await sleep(125, ctx.signal);
    const page = await runTauriEvalJson<{
      href: string;
      h1: string[];
      bodyText: string;
      domNodes: number;
      hasHarnessRoot: boolean;
    }>(
      ctx,
      `(() => ({
        href: location.href,
        h1: Array.from(document.querySelectorAll('h1')).map((node) => (node.textContent || '').trim()),
        bodyText: document.body.innerText.slice(0, 400),
        domNodes: document.querySelectorAll('*').length,
        hasHarnessRoot: Boolean(document.querySelector('.h-root')),
      }))()`,
      10_000,
    );
    if (!page.ok || !page.value) continue;
    const current = {
      href: page.value.href,
      h1: page.value.h1,
      bodyText: page.value.bodyText,
      domNodes: page.value.domNodes,
      hasHarnessRoot: page.value.hasHarnessRoot,
      details: [page.value.bodyText.slice(0, 240)],
      summary: `${page.value.href} · h1=${page.value.h1.join(' | ') || '(none)'} · domNodes=${page.value.domNodes}${page.value.hasHarnessRoot ? ' · h-root' : ''}`,
    };
    if (predicate(current)) {
      return { ok: true, elapsedMs: Date.now() - startedAt, page: current };
    }
  }
  const fallback = await runTauriEvalJson<{
    href: string;
    h1: string[];
    bodyText: string;
    domNodes: number;
    hasHarnessRoot: boolean;
  }>(
    ctx,
    `(() => ({
      href: location.href,
      h1: Array.from(document.querySelectorAll('h1')).map((node) => (node.textContent || '').trim()),
      bodyText: document.body.innerText.slice(0, 400),
      domNodes: document.querySelectorAll('*').length,
      hasHarnessRoot: Boolean(document.querySelector('.h-root')),
    }))()`,
    10_000,
  );
  const value = fallback.value ?? { href: target, h1: [], bodyText: '', domNodes: 0, hasHarnessRoot: false };
  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    page: {
      href: value.href,
      h1: value.h1,
      bodyText: value.bodyText,
      domNodes: value.domNodes,
      hasHarnessRoot: value.hasHarnessRoot,
      details: [value.bodyText.slice(0, 240)],
      summary: `${value.href} · h1=${value.h1.join(' | ') || '(none)'} · domNodes=${value.domNodes}${value.hasHarnessRoot ? ' · h-root' : ''}`,
    },
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
