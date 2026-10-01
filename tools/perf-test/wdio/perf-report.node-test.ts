import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { evaluateRequiredPageLoad, readPageStartupTrace, type WebVitalsReading } from "./web-vitals-probe";
import type { Browser } from "webdriverio";

import { assertPrivateIpcFixture, assertPrivateIpcFixtureUnchanged, BINARY_BUILT_AT_KEY, BUILD_IDENTITY_FILE, CONTEXT_STAMP_PREFIXES, desktopPerfRunPayload, hasRunOutcomeMeasure, readBuildIdentity, readPublisherToken, type PerfMeasure } from "./perf-report";
import {
  installPopupLayoutProbe,
  installPopupReactProbe,
  isTerminalWebDriverSessionError,
  readPlanPopupCandidates,
  waitForPackagedAppUrl,
  waitUntilOrFailOnTerminalSession,
} from "./app-mount";

test("startup trace separates completed-before-paint requests from later completions", async () => {
  const globals = ['window', 'document', 'performance', 'location', 'PerformanceObserver'] as const;
  const originals = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const lcp = { tag: 'DIV', className: 'plans-list', text: 'Plan title', startMs: 200 };
  const values = {
    window: { __wv_lcp: lcp, __sync_metrics__: { snapshot: () => ({ stages: { recent: [
      { stage: 'reactCommit', unit: 'ms', durationMs: 15, measuredAtMs: 185, queryName: 'plans.list', traceId: 'query-plan' },
      { stage: 'updateToScreen', unit: 'ms', durationMs: 25, measuredAtMs: 195, queryName: 'plans.list', traceId: 'query-plan' },
      { stage: 'reactCommit', unit: 'ms', durationMs: 999, measuredAtMs: 999, queryName: 'unrelated', traceId: 'other' },
    ] } }), queries: () => [
      { name: 'finished-before-fcp', startedAtMs: 10, waitMs: 20, requestMs: 30, outcome: 'ok' },
      { name: 'finished-before-lcp', startedAtMs: 40, waitMs: 10, requestMs: 120, outcome: 'ok' },
      { name: 'finished-after-lcp', startedAtMs: 50, waitMs: 200, requestMs: 30, outcome: 'timeout' },
      { name: 'started-after-lcp', startedAtMs: 210, waitMs: 0, requestMs: 10, outcome: 'ok' },
      { name: 'plans.list', startedAtMs: 100, waitMs: 10, requestMs: 60, outcome: 'ok', traceId: 'query-plan',
        stages: { schedulerWaitMs: 10, resolverMs: 12, transferMs: 20, parseCacheMs: 3 } },
    ] } },
    document: { readyState: 'complete' },
    performance: { getEntriesByType: () => [{ name: 'papercusp://localhost/assets/main.js', startTime: 5, duration: 30, initiatorType: 'script' }] },
    location: { href: 'papercusp://localhost/adv' }, PerformanceObserver: { supportedEntryTypes: [] },
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  try {
    const trace = await readPageStartupTrace({ fcpMs: 100, lcpMs: 200 });
    assert.equal(trace.lcp, lcp);
    assert.equal(trace.queryCountCompletedBeforeFcp, 1);
    assert.equal(trace.startedBeforeFcpCompletedLater, 3);
    assert.deepEqual(trace.longestRequestsCompletedBeforeFcp.map((query) => query.name), ['finished-before-fcp']);
    assert.equal(trace.beforeLcp.queryCountCompleted, 3);
    assert.equal(trace.beforeLcp.startedCompletedLater, 1);
    assert.deepEqual(trace.beforeLcp.longestRequests.map((query) => query.name), ['finished-before-lcp', 'plans.list', 'finished-before-fcp']);
    assert.equal(trace.syncTrace.clock, 'performance.now');
    assert.equal(trace.syncTrace.unit, 'ms');
    assert.equal(trace.syncTrace.startupQueries[0].name, 'finished-before-fcp');
    assert.deepEqual(trace.syncTrace.planQueries[0].stages,
      { schedulerWaitMs: 10, resolverMs: 12, transferMs: 20, parseCacheMs: 3 });
    assert.deepEqual(trace.syncTrace.planStages.map(({ stage, measuredAtMs }) => ({ stage, measuredAtMs })),
      [{ stage: 'reactCommit', measuredAtMs: 185 }, { stage: 'updateToScreen', measuredAtMs: 195 }]);
    assert.equal(trace.resources[0].endMs, 35);
    assert.equal(trace.ipc.client.kind, 'unavailable');
    const missing = await readPageStartupTrace({ fcpMs: null, lcpMs: null });
    assert.equal(missing.queryCountCompletedBeforeFcp, 0);
    assert.equal(missing.beforeLcp.queryCountCompleted, 0);
    // A real IPC round trip yielded to a later LCP observer in native r146.
    // The trace must keep the subject captured with the measured 200ms value.
    Object.assign(values.window, { __TAURI_INTERNALS__: { invoke: async () => {
      values.window.__wv_lcp = { ...lcp, startMs: 900 };
      return { client: 'connected', ownerIsContentOrigin: true };
    } } });
    const atomic = await readPageStartupTrace({ fcpMs: 100, lcpMs: 200,
      attribution: { lcp, lcpAttributionError: null } });
    assert.equal(atomic.lcp, lcp);
    assert.equal(values.window.__wv_lcp.startMs, 900);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("combined native load verdict retains both individual budget breaches", () => {
  const reading: WebVitalsReading = { instrument: 'ready', brokenReason: null,
    metrics: { FCP: 3_001, LCP: 4_001 }, missingExpected: [], absentByEnvironment: [], errors: [] };
  const verdict = evaluateRequiredPageLoad(reading);
  assert.deepEqual(verdict.measures.map(({ value, ok }) => ({ value, ok })), [
    { value: 3_001, ok: false }, { value: 4_001, ok: false },
  ]);
  assert.equal(verdict.failures.length, 2);
  assert.deepEqual(evaluateRequiredPageLoad({ ...reading, metrics: { FCP: 3_000, LCP: 4_000 } }).failures, []);
});

test("combined native load verdict cannot pass empty, invalid or broken instruments", () => {
  const reading: WebVitalsReading = { instrument: 'ready', brokenReason: null,
    metrics: {}, missingExpected: [], absentByEnvironment: [], errors: [] };
  for (const metrics of [{}, { FCP: NaN, LCP: 0 }, { FCP: -1, LCP: Infinity }]) {
    const verdict = evaluateRequiredPageLoad({ ...reading, metrics });
    assert.equal(verdict.measures.length, 0);
    assert.equal(verdict.failures.length, 2);
  }
  const realMetrics = { FCP: 100, LCP: 200 };
  assert.match(evaluateRequiredPageLoad({ ...reading, metrics: realMetrics, instrument: 'threw',
    brokenReason: 'observer failed' }).failures[0], /observer failed/);
  assert.deepEqual(evaluateRequiredPageLoad({ ...reading, metrics: realMetrics, errors: ['registration failed'] }).failures,
    ['registration failed']);
});

test("React probe rejects a component chunk before importing or invoking its minified export", async () => {
  const result = await new Promise<{ installed: boolean; error?: string }>((done) =>
    installPopupReactProbe('/assets/dist-82810595.js', done));
  assert.equal(result.installed, false);
  assert.match(result.error ?? '', /requires the packaged react-\*\.js asset/);
});

test("React probe validates hooks, preserves effect semantics and restores instrumentation", async () => {
  const names = ['Function', 'window', 'performance'] as const;
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let now = 0;
  let loadedUrl = '';
  let module: Record<string, unknown>;
  const calls: Array<{ effect: () => unknown; deps: unknown; receiver: unknown }> = [];
  const hook = function (this: unknown, effect: () => unknown, deps: unknown) {
    calls.push({ effect, deps, receiver: this });
    return 'hook-result';
  };
  const react = { useEffect: hook, useLayoutEffect: hook, useInsertionEffect: hook };
  module = { t: () => react };
  const fakeWindow: { __perfReactProbe?: { records: Array<{ hook: string; ms: number }>; restore(): void } } = {};
  Object.defineProperty(globalThis, 'Function', { configurable: true, value: function () {
    return async (url: string) => { loadedUrl = url; return module; };
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  try {
    const install = () => new Promise<{ installed: boolean; hooks?: string[]; error?: string }>((done) =>
      installPopupReactProbe('/assets/react-test.js', done));
    assert.deepEqual(await install(), { installed: true, hooks: ['useEffect', 'useLayoutEffect', 'useInsertionEffect'] });
    assert.equal(loadedUrl, '/assets/react-test.js');
    const deps = ['unchanged'];
    const cleanup = () => 'cleanup';
    assert.equal(react.useEffect(() => { now += 7; return cleanup; }, deps), 'hook-result');
    assert.equal(calls[0].deps, deps);
    assert.equal(calls[0].receiver, react);
    assert.equal(calls[0].effect(), cleanup);
    const error = new Error('effect failure');
    react.useLayoutEffect(() => { now += 9; throw error; }, deps);
    assert.throws(calls[1].effect, (actual) => actual === error);
    assert.deepEqual(fakeWindow.__perfReactProbe!.records.map(({ hook, ms }) => ({ hook, ms })), [
      { hook: 'useEffect', ms: 7 }, { hook: 'useLayoutEffect', ms: 9 },
    ]);
    fakeWindow.__perfReactProbe!.restore();
    fakeWindow.__perfReactProbe!.restore();
    assert.equal(react.useEffect, hook);
    assert.equal(react.useLayoutEffect, hook);
    assert.equal(react.useInsertionEffect, hook);
    module = { t: () => ({ useEffect: hook }) };
    const invalid = await install();
    assert.equal(invalid.installed, false);
    assert.match(invalid.error ?? '', /does not expose all three/);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("layout probe measures a later computed-style getter and preserves target, errors and cleanup", () => {
  const names = ['window', 'Element', 'HTMLElement', 'CSSStyleDeclaration', 'performance'] as const;
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let now = 0;
  let getterMs = 25;
  let getterError: Error | null = null;
  class Styles {
    get animationName() {
      now += getterMs;
      if (getterError) throw getterError;
      return 'none';
    }
  }
  class FakeElement {}
  const styles = new Styles();
  const timers: Array<() => void> = [];
  const fakeWindow = {
    getComputedStyle: () => styles,
    setTimeout(handler: Function, _delay: number, ...args: unknown[]) {
      timers.push(() => handler.apply(fakeWindow, args));
      return timers.length;
    },
  };
  const originalStyleGetter = Object.getOwnPropertyDescriptor(Styles.prototype, 'animationName');
  const originalComputedStyle = fakeWindow.getComputedStyle;
  const originalTimer = fakeWindow.setTimeout;
  const globals = { window: fakeWindow, Element: FakeElement, HTMLElement: FakeElement, CSSStyleDeclaration: Styles, performance: { now: () => now } };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globals[name] });
  try {
    const result = installPopupLayoutProbe();
    assert.ok(result.observed.includes('animationName'));
    const element = { tagName: 'DIV', id: 'plan', classList: ['plan-popup'], getAttribute: (name: string) => name === 'data-testid' ? 'popup' : null } as unknown as Element;
    const computed = window.getComputedStyle(element);
    type Record = { api: string; ms: number; at: number; target?: string; waitMs?: number; firedAt?: number };
    const probe = (window as unknown as { __perfLayoutProbe: { records: Record[]; restore(): void } }).__perfLayoutProbe;
    assert.equal(probe.records.length, 0, 'a fast getComputedStyle is not the delayed read');
    assert.equal(computed.animationName, 'none');
    assert.deepEqual(probe.records.map(({ api, ms, target }) => ({ api, ms, target })), [
      { api: 'animationName', ms: 25, target: 'div#plan[data-testid="popup"].plan-popup' },
    ]);
    getterMs = 2;
    void computed.animationName;
    assert.equal(probe.records.length, 1, 'fast reads stay below the diagnostic threshold');
    getterMs = 30;
    getterError = new Error('native style failure');
    assert.throws(() => computed.animationName, /native style failure/);
    assert.equal(probe.records[1].ms, 30);

    let received: unknown[] | null = null;
    let receiver: unknown;
    const timerId = window.setTimeout(function (this: unknown, ...args: unknown[]) { receiver = this; received = args; }, 300, 'original-argument');
    assert.equal(timerId, 1);
    const timer = probe.records[2];
    assert.equal(timer.waitMs, 300);
    assert.equal(timer.firedAt, undefined);
    now += 320;
    timers[0]();
    assert.deepEqual(received, ['original-argument']);
    assert.equal(receiver, fakeWindow);
    assert.equal(timer.ms, 320);
    assert.equal(timer.firedAt, now);
    probe.restore();
    probe.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(Styles.prototype, 'animationName'), originalStyleGetter);
    assert.equal(fakeWindow.getComputedStyle, originalComputedStyle);
    assert.equal(fakeWindow.setTimeout, originalTimer);
  } finally {
    if (originalStyleGetter) Object.defineProperty(Styles.prototype, 'animationName', originalStyleGetter);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("layout probe observes native-style object properties when a prototype getter cannot be installed", () => {
  const names = ['window', 'Element', 'HTMLElement', 'CSSStyleDeclaration', 'performance'] as const;
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let now = 0;
  class Styles {
    #brand = true;
    getPropertyValue() {
      assert.equal(this.#brand, true, 'native methods need their real receiver');
      return 'none';
    }
  }
  const styles = new Styles();
  Object.defineProperty(styles, 'animationName', { configurable: false, get() { now += 40; return 'none'; } });
  class FakeElement {}
  const fakeWindow = { getComputedStyle: () => styles, setTimeout: () => 1 };
  const globals = { window: fakeWindow, Element: FakeElement, HTMLElement: FakeElement, CSSStyleDeclaration: Styles, performance: { now: () => now } };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globals[name] });
  try {
    const result = installPopupLayoutProbe();
    assert.ok(result.observed.includes('animationName-proxy'));
    const attributes: Record<string, string> = { 'data-anim': 'fade', 'data-state': 'open' };
    const element = { tagName: 'DIV', id: '', classList: ['h-modal__content'], getAttribute: (name: string) => attributes[name] ?? null } as unknown as Element;
    const computed = window.getComputedStyle(element);
    assert.equal(computed.animationName, 'none');
    assert.equal(computed.getPropertyValue('animation-name'), 'none');
    assert.equal(computed.getPropertyValue, computed.getPropertyValue, 'method identity remains stable');
    const probe = (window as unknown as { __perfLayoutProbe: { records: Array<{ api: string; ms: number; target?: string }>; restore(): void } }).__perfLayoutProbe;
    assert.deepEqual(probe.records.map(({ api, ms, target }) => ({ api, ms, target })), [
      { api: 'animationName', ms: 40, target: 'div.h-modal__content[data-anim="fade"][data-state="open"]' },
    ]);
    probe.restore();
    assert.equal(fakeWindow.getComputedStyle(), styles);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("render probe preserves native HTML setters and Lute receivers, results, failures and restoration", () => {
  const names = ['window', 'Element', 'HTMLElement', 'CSSStyleDeclaration', 'performance'] as const;
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let now = 0;
  let fail = false;
  class FakeElement {
    tagName = 'DIV'; id = 'preview'; classList = ['vditor-reset'];
    getAttribute() { return null; }
    #html = '';
    get innerHTML() { return this.#html; }
    set innerHTML(value: string) {
      now += 40;
      if (fail) throw new Error('HTML failure');
      this.#html = value;
    }
  }
  const instance = {
    Md2HTML(this: unknown, value: string) {
      assert.equal(this, instance);
      now += 25;
      if (fail) throw new Error('compile failure');
      return `<p>${value}</p>`;
    },
  };
  const lute = { New(this: unknown, option: string) {
    assert.equal(this, lute); assert.equal(option, 'original'); now += 15; return instance;
  } };
  const originalNew = lute.New;
  const originalCompile = instance.Md2HTML;
  const originalHtml = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'innerHTML');
  const fakeWindow = { Lute: lute, getComputedStyle: () => ({}), setTimeout: () => 1 };
  const globals = { window: fakeWindow, Element: FakeElement, HTMLElement: FakeElement, CSSStyleDeclaration: class {}, performance: { now: () => now } };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globals[name] });
  try {
    const installed = installPopupLayoutProbe();
    assert.ok(installed.observed.includes('innerHTML:set'));
    assert.ok(installed.observed.includes('Lute.Md2HTML'));
    const root = new FakeElement();
    assert.equal(lute.New('original'), instance);
    root.innerHTML = instance.Md2HTML('ready');
    assert.equal(root.innerHTML, '<p>ready</p>');
    fail = true;
    assert.throws(() => instance.Md2HTML('fail'), /compile failure/);
    assert.throws(() => { root.innerHTML = 'fail'; }, /HTML failure/);
    const probe = (window as unknown as { __perfLayoutProbe: { records: Array<{ api: string; ms: number; target?: string }>; restore(): void } }).__perfLayoutProbe;
    assert.deepEqual(probe.records.map(({ api, ms }) => ({ api, ms })), [
      { api: 'Lute.New', ms: 15 }, { api: 'Lute.Md2HTML', ms: 25 },
      { api: 'innerHTML:set', ms: 40 }, { api: 'Lute.Md2HTML', ms: 25 }, { api: 'innerHTML:set', ms: 40 },
    ]);
    assert.equal(probe.records[2].target, 'div#preview.vditor-reset');
    probe.restore(); probe.restore();
    assert.equal(lute.New, originalNew);
    assert.equal(instance.Md2HTML, originalCompile);
    assert.deepEqual(Object.getOwnPropertyDescriptor(FakeElement.prototype, 'innerHTML'), originalHtml);
  } finally {
    if (originalHtml) Object.defineProperty(FakeElement.prototype, 'innerHTML', originalHtml);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("native receipt publishing uses the selected operator credential", () => {
  const home = mkdtempSync(path.join(tmpdir(), "wdio-publisher-token-"));
  const scopedHome = path.join(home, "workspace", ".papercusp");
  try {
    mkdirSync(path.join(home, ".papercusp"), { recursive: true });
    mkdirSync(scopedHome, { recursive: true });
    writeFileSync(path.join(home, ".papercusp", "superuser-token"), "box-credential\n");
    writeFileSync(path.join(scopedHome, "superuser-token"), "workspace-credential\n");
    assert.equal(readPublisherToken({ PAPERCUSP_HOME: scopedHome }, home), "workspace-credential");
    assert.equal(readPublisherToken({}, home), "box-credential");
    assert.equal(readPublisherToken({ PAPERCUSP_HOME: "" }, home), "box-credential");
    rmSync(path.join(scopedHome, "superuser-token"));
    assert.throws(() => readPublisherToken({ PAPERCUSP_HOME: scopedHome }, home), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function retryingBrowser(): Browser {
  return {
    async waitUntil(condition: () => boolean | Promise<boolean>) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          if (await condition()) return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("fake waitUntil timed out");
    },
  } as unknown as Browser;
}

test("pinned plan readiness waits through unrelated cached rows", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let rowReads = 0;
  const row = (slug: string) => ({
    getAttribute: () => `plans-pane-row-${slug}`,
    querySelector: () => ({ textContent: ' papercusp ' }),
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: () => ++rowReads < 3
        ? [row('other-plan')]
        : [row('other-plan'), row('pinned-plan')],
    },
  });
  try {
    let candidates: ReturnType<typeof readPlanPopupCandidates> = [];
    await retryingBrowser().waitUntil(() => {
      candidates = readPlanPopupCandidates({ maxRows: 1, requestedSlug: 'pinned-plan' });
      return candidates.length > 0;
    });
    assert.equal(rowReads, 3);
    assert.deepEqual(candidates, [{ slug: 'pinned-plan', harness: 'papercusp' }]);
    assert.deepEqual(readPlanPopupCandidates({ maxRows: 1, requestedSlug: null }), [
      { slug: 'other-plan', harness: 'papercusp' },
    ]);
    assert.deepEqual(readPlanPopupCandidates({ maxRows: 5, requestedSlug: 'absent' }), []);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test("terminal WebDriver session failures are recognized from protocol messages", () => {
  assert.equal(isTerminalWebDriverSessionError(new Error("WebDriverError: invalid session id")), true);
  assert.equal(isTerminalWebDriverSessionError({ error: "pagecrashorhang" }), true);
  assert.equal(isTerminalWebDriverSessionError({ cause: new Error("session terminated without reply") }), true);
  assert.equal(isTerminalWebDriverSessionError(new Error("temporary connection reset")), false);
});

test("a terminal session error ends a WDIO wait on its first failed probe", async () => {
  let probes = 0;
  const browser = retryingBrowser();

  await assert.rejects(
    waitUntilOrFailOnTerminalSession(browser, () => {
      probes += 1;
      throw new Error("WebDriverError: invalid session id");
    }, { timeout: 180_000, interval: 500 }),
    /invalid session id/i,
  );
  assert.equal(probes, 1);
});

test("ordinary transient wait errors still retry until the condition succeeds", async () => {
  let probes = 0;

  await waitUntilOrFailOnTerminalSession(retryingBrowser(), () => {
    probes += 1;
    if (probes === 1) throw new Error("temporary connection reset");
    return true;
  });
  assert.equal(probes, 2);
});

test("workspace navigation waits past about:blank for the packaged app origin", async () => {
  const urls = ["about:blank", "about:blank?ws=papercusp-workspace", "papercusp://localhost/adv"];
  let reads = 0;
  const browser = Object.assign(retryingBrowser(), {
    async getUrl() { reads += 1; return urls.shift() ?? "papercusp://localhost/adv"; },
  });

  assert.equal(await waitForPackagedAppUrl(browser), "papercusp://localhost/adv");
  assert.equal(reads, 3);
});

test('private IPC fixture rejects a stale default even with a fresh per-port record', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'native-ipc-preflight-'));
  const socketPath = path.join(dir, 'operator.sock');
  const replacementSocketPath = path.join(dir, 'replacement.sock');
  const server = createServer();
  const replacementServer = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await new Promise<void>((resolve, reject) => { replacementServer.once('error', reject); replacementServer.listen(replacementSocketPath, resolve); });
  try {
    const live = { pid: process.pid, port: 3170, socketPath };
    const env = { PAPERCUSP_HOME: dir, PAPERCUSP_DEV_API_TARGET: "3170" };
    writeFileSync(
      path.join(dir, "endpoint-ipc.3170.json"),
      JSON.stringify(live),
    );
    writeFileSync(
      path.join(dir, "endpoint-ipc.json"),
      JSON.stringify({ ...live, socketPath: path.join(dir, "gone.sock") }),
    );
    assert.throws(
      () => assertPrivateIpcFixture(env, "linux"),
      /Invalid private native IPC fixture/,
    );
    writeFileSync(path.join(dir, "endpoint-ipc.json"), JSON.stringify(live));
    assert.doesNotThrow(() => assertPrivateIpcFixture(env, "linux"));
    const preflight = assertPrivateIpcFixture(env, "linux");
    writeFileSync(path.join(dir, "endpoint-ipc.json"), JSON.stringify({ ...live, socketPath: replacementSocketPath }));
    assert.doesNotThrow(() => assertPrivateIpcFixture(env, "linux"));
    assert.throws(() => assertPrivateIpcFixtureUnchanged(preflight, env, "linux"), /changed during the measured run/);
    writeFileSync(path.join(dir, "endpoint-ipc.json"), JSON.stringify(live));
    assert.doesNotThrow(() => assertPrivateIpcFixtureUnchanged(preflight, env, "linux"));
    // A named run must not silently skip this guard when the target was omitted.
    assert.throws(
      () =>
        assertPrivateIpcFixture(
          {
            PAPERCUSP_HOME: dir,
            PAPERCUSP_PERF_RUN_ID: "named-profile",
          },
          "linux",
        ),
      /PAPERCUSP_DEV_API_TARGET/,
    );
    assert.throws(
      () =>
        assertPrivateIpcFixture(
          {
            ...env,
            PAPERCUSP_DEV_API_TARGET: "invalid",
          },
          "linux",
        ),
      /Invalid PAPERCUSP_DEV_API_TARGET/,
    );
    assert.throws(
      () =>
        assertPrivateIpcFixture(
          { ...env, PAPERCUSP_DEV_API_TARGET: "3070" },
          "linux",
        ),
      /mismatched/,
    );
    writeFileSync(
      path.join(dir, "endpoint-ipc.json"),
      JSON.stringify({ ...live, pid: 2147483647 }),
    );
    assert.throws(
      () => assertPrivateIpcFixture(env, "linux"),
      /Invalid private native IPC fixture/,
    );
    assert.doesNotThrow(() => assertPrivateIpcFixture({}, "linux"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

const host = (key: string): PerfMeasure => ({
  key,
  value: 0.1,
  unit: "count",
  budget: null,
  ok: true,
});

test("host-pressure context alone is not a publishable perf run", () => {
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    host("host:loadavg1-not-authoritative:end"),
  ]), false);
});

test("a timing or invariant makes the surrounding host context publishable", () => {
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    { key: "interaction:command-palette-open", value: 250, unit: "ms", budget: 400, ok: true },
  ]), true);
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    { key: "invariant:webview-http-egress", value: 0, unit: "count", budget: 0, ok: true, invariant: true },
  ]), true);
});

test("desktop perf receipts retain the measured workspace across the WDIO publisher boundary", () => {
  const measures = [{ key: "interaction:plan-popup-open", value: 1010, unit: "ms", budget: 1500, ok: true }] as const;
  assert.deepEqual(desktopPerfRunPayload(measures, "checkout-sha", "named-profile", {
    PAPERCUSP_PERF_WORKSPACE_ID: " papercusp-workspace ",
  }), {
    measures,
    gitSha: null,
    buildSha: null,
    runId: "named-profile",
    workspaceId: "papercusp-workspace",
  });
  assert.deepEqual(desktopPerfRunPayload(measures, "checkout-sha", null, {}), {
    measures,
    gitSha: "checkout-sha",
    buildSha: null,
    runId: null,
  });
  assert.equal("workspaceId" in desktopPerfRunPayload(measures, null, null, {}), false);
});

test("the binary's recorded build identity rides on named and unnamed runs alike", () => {
  const measures = [{ key: "interaction:plan-popup-open", value: 1010, unit: "ms", budget: 1500, ok: true }] as const;
  // A named profile drops the checkout sha (it is not the build) but keeps the
  // binary's own identity, which describes the artifact actually measured.
  assert.equal(desktopPerfRunPayload(measures, "checkout-sha", "named-profile", {}, "4223f93417df").buildSha, "4223f93417df");
  assert.equal(desktopPerfRunPayload(measures, "checkout-sha", "named-profile", {}, "4223f93417df").gitSha, null);
  assert.equal(desktopPerfRunPayload(measures, "checkout-sha", null, {}, "4223f93417df").buildSha, "4223f93417df");
});

test("readBuildIdentity finds the profile-dir identity above a deb staging binary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    const bin = path.join(root, "release", "bundle", "deb", "pkg_0.0.1_amd64", "data", "usr", "bin", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "binary");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bin, past, past);
    writeFileSync(path.join(root, "release", BUILD_IDENTITY_FILE), JSON.stringify({ buildSha: "4223F93417DF132EEC90ACE218A6017F5A97B8B3" }));
    assert.equal(readBuildIdentity(bin), "4223f93417df132eec90ace218a6017f5a97b8b3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildIdentity refuses an identity OLDER than the binary (rebuilt after the scripted build)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    const bin = path.join(root, "release", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    const identity = path.join(root, "release", BUILD_IDENTITY_FILE);
    writeFileSync(identity, JSON.stringify({ buildSha: "4223f93417df" }));
    const past = new Date(Date.now() - 60_000);
    utimesSync(identity, past, past);
    writeFileSync(bin, "rebuilt later by a plain tauri build");
    assert.equal(readBuildIdentity(bin), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildIdentity refuses a DIRTY build — its binary is not exactly the recorded sha (P-002)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    const bin = path.join(root, "release", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "binary");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bin, past, past);
    const identity = path.join(root, "release", BUILD_IDENTITY_FILE);
    writeFileSync(identity, JSON.stringify({ buildSha: "4223f93417df", dirty: true }));
    assert.equal(readBuildIdentity(bin), null);
    // CONTROL: the same file recorded clean is trusted.
    writeFileSync(identity, JSON.stringify({ buildSha: "4223f93417df", dirty: false }));
    assert.equal(readBuildIdentity(bin), "4223f93417df");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildIdentity returns null for a missing binary, missing file, or malformed sha", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-build-identity-"));
  try {
    assert.equal(readBuildIdentity(path.join(root, "absent")), null);
    const bin = path.join(root, "release", "papercusp-desktop");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "binary");
    const past = new Date(Date.now() - 60_000);
    utimesSync(bin, past, past);
    assert.equal(readBuildIdentity(bin, 2), null);
    writeFileSync(path.join(root, "release", BUILD_IDENTITY_FILE), JSON.stringify({ buildSha: "not-a-sha" }));
    assert.equal(readBuildIdentity(bin), null);
    writeFileSync(path.join(root, "release", BUILD_IDENTITY_FILE), "{ truncated");
    assert.equal(readBuildIdentity(bin), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner resets stale measures before any preflight can throw", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const onPrepare = config.slice(config.indexOf("async onPrepare()"), config.indexOf("async onComplete()"));
  const reset = onPrepare.indexOf("resetMeasures();");
  assert(reset >= 0);
  assert(reset < onPrepare.indexOf("assertNativeWebDriverAvailable();"));
  assert(reset < onPrepare.indexOf("assertInstallationComplete();"));
});

test("named native publishing checks fixture continuity before sending a receipt", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const publish = config.slice(
    config.indexOf("async function publishMeasures()"),
    config.indexOf("function resolveDriverPort"),
  );
  assert(publish.includes("assertPrivateIpcFixtureUnchanged(initialPrivateIpcFixture);"));
  assert(
    publish.indexOf("assertPrivateIpcFixtureUnchanged(initialPrivateIpcFixture);") <
      publish.indexOf("await fetch(url"),
  );
});

test("a build: stamp is context, not an outcome (WI-10003815)", () => {
  assert.equal(hasRunOutcomeMeasure([
    host("host:psi-cpu-some-avg10-pct:start"),
    { key: BINARY_BUILT_AT_KEY, value: 1_789_600_000_000, unit: "count", budget: null, ok: true },
  ]), false);
});

test("the runner's stamp literals match the gate's canonical constants", () => {
  // The runner cannot import operator-core, so it carries copies; a drifted key would
  // silently disable the release gate's stale-build check.
  const shared = readFileSync(
    path.resolve(__dirname, "../../..", "packages/operator-core/lib/admin-test-suites-shared.ts"),
    "utf8",
  );
  assert(shared.includes(`DESKTOP_PERF_BINARY_BUILT_AT_KEY = '${BINARY_BUILT_AT_KEY}'`));
  const prefixes = CONTEXT_STAMP_PREFIXES.map((p) => `'${p}'`).join(", ");
  assert(shared.includes(`DESKTOP_PERF_CONTEXT_STAMP_PREFIXES = [${prefixes}] as const`));
});

test("the runner stamps the binary under test before any spec can measure", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const onPrepare = config.slice(config.indexOf("async onPrepare()"), config.indexOf("async onComplete()"));
  const stamp = onPrepare.indexOf("recordBinaryIdentity(TAURI_APP_PATH);");
  assert(stamp >= 0, "onPrepare must record the measured binary's build time");
  assert(stamp > onPrepare.indexOf("resetMeasures();"), "a stamp written before the reset is wiped");
});

test("the root perf command preserves WDIO failures through tee", () => {
  const rootPackage = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(rootPackage.scripts["perf:desktop"], /bash -o pipefail/);
});

test("the gate-selected `test` script is headless; the full GUI run is `test:all` (WI-10003821)", () => {
  // The green gate runs this package's `test` on every change here (STANDALONE_PACKAGE_DIRS in
  // scripts/affected-tests.mjs), and a gate box cannot boot the packaged desktop binary. So `test`
  // must never reach WDIO, and every caller that wants measures must name `test:all`.
  const own = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(own.scripts.test, /test:wdio|wdio run/, "`test` must stay headless");
  assert.match(own.scripts.test, /test:unit/, "`test` must still run the runner guards");
  assert.match(own.scripts["test:all"], /npm run test:wdio/, "`test:all` must run the specs");
  const rootPackage = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(rootPackage.scripts["perf:desktop"], /npm run test:all\b/);
});
