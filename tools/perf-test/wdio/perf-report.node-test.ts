import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { hasRunOutcomeMeasure, type PerfMeasure } from "./perf-report";

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
