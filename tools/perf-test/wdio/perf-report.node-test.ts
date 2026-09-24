import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import type { Browser } from "webdriverio";

import { assertPrivateIpcFixture, hasRunOutcomeMeasure, type PerfMeasure } from "./perf-report";
import {
  isTerminalWebDriverSessionError,
  waitUntilOrFailOnTerminalSession,
} from "./app-mount";

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

test('private IPC fixture rejects a stale default even with a fresh per-port record', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'native-ipc-preflight-'));
  const socketPath = path.join(dir, 'operator.sock');
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    const live = { pid: process.pid, port: 3170, socketPath };
    const env = { PAPERCUSP_HOME: dir, PAPERCUSP_DEV_API_TARGET: '3170' };
    writeFileSync(path.join(dir, 'endpoint-ipc.3170.json'), JSON.stringify(live));
    writeFileSync(path.join(dir, 'endpoint-ipc.json'), JSON.stringify({ ...live, socketPath: path.join(dir, 'gone.sock') }));
    assert.throws(() => assertPrivateIpcFixture(env, 'linux'), /Invalid private native IPC fixture/);
    writeFileSync(path.join(dir, 'endpoint-ipc.json'), JSON.stringify(live));
    assert.doesNotThrow(() => assertPrivateIpcFixture(env, 'linux'));
    assert.throws(() => assertPrivateIpcFixture({ ...env, PAPERCUSP_DEV_API_TARGET: '3070' }, 'linux'), /mismatched/);
    writeFileSync(path.join(dir, 'endpoint-ipc.json'), JSON.stringify({ ...live, pid: 2147483647 }));
    assert.throws(() => assertPrivateIpcFixture(env, 'linux'), /Invalid private native IPC fixture/);
    assert.doesNotThrow(() => assertPrivateIpcFixture({}, 'linux'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

test("the runner resets stale measures before any preflight can throw", () => {
  const config = readFileSync(path.join(__dirname, "wdio.conf.ts"), "utf8");
  const onPrepare = config.slice(config.indexOf("async onPrepare()"), config.indexOf("async onComplete()"));
  const reset = onPrepare.indexOf("resetMeasures();");
  assert(reset >= 0);
  assert(reset < onPrepare.indexOf("assertNativeWebDriverAvailable();"));
  assert(reset < onPrepare.indexOf("assertInstallationComplete();"));
});

test("the root perf command preserves WDIO failures through tee", () => {
  const rootPackage = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(rootPackage.scripts["perf:desktop"], /bash -o pipefail/);
});
