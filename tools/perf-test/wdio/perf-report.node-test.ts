import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";

import { assertPrivateIpcFixture, hasRunOutcomeMeasure, type PerfMeasure } from "./perf-report";

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
