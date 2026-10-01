/**
 * Smoke spec: confirms the packaged Tauri binary boots, the operator UI loads, and
 * the web-vitals instrument is ACTUALLY WORKING.
 *
 * READ THIS BEFORE RELAXING ANY ASSERT BELOW (EI-18895065570073000).
 * The previous version of this spec did:
 *
 *     const metrics = await browser.execute(... import from "https://esm.sh/..." ...);
 *     console.log("web-vitals:", metrics);
 *     expect(metrics).toBeDefined();
 *
 * The import could not resolve inside the packaged app, module-script import
 * failures are silent, so `metrics` was `{}` — and `expect({}).toBeDefined()`
 * passes. The suite reported `✓ loads the operator UI and reports web-vitals` for
 * months while measuring nothing. `toBeDefined()` on a value that is ALWAYS defined
 * is not an assertion; it is decoration.
 *
 * Three things keep that from recurring, and all three matter:
 *
 *  1. The instrument is BUNDLED LOCALLY (../web-vitals-probe). An offline desktop
 *     app must not reach a CDN to measure itself.
 *  2. A BROKEN INSTRUMENT IS A DIFFERENT VALUE from an idle page — `instrument:
 *     'broken'` vs `'ready'` with no metrics — and this spec fails on the former.
 *     Asserting harder on the metrics object alone could never have caught it.
 *  3. The numbers are RECORDED (perf-report), not console.logged and thrown away.
 *     That module exists precisely because specs were discarding their measures,
 *     which left the desktop-perf release gate with nothing to judge.
 *
 * Which metrics are legitimately absent here is MEASURED and documented in
 * ../web-vitals-probe (CLS and TTFB are impossible under WebKitGTK + papercusp://;
 * INP needs a trusted interaction). Do not "fix" a missing CLS by asserting on it.
 */
import { browser } from "@wdio/globals";
import { waitForAppMount } from "../app-mount";
import { recordMeasure } from "../perf-report";
import {
  METRIC_ENVIRONMENT,
  collectPageStartupTrace,
  collectWebVitals,
  describeReading,
  type WebVitalName,
} from "../web-vitals-probe";

/**
 * Budgets are the web.dev "poor" thresholds — deliberately generous. These are
 * tunable budgets (warn-only in the gate), NOT invariants: paint timings move with
 * machine load, and blocking the fleet's deploys on a load-sensitive number is
 * exactly what the gate's warn-only default exists to prevent.
 */
const BUDGET_MS: Partial<Record<WebVitalName, number>> = {
  FCP: 3_000,
  LCP: 4_000,
};

describe("Packaged Papercusp desktop binary", () => {
  it("loads the operator UI and reports web-vitals", async () => {
    await waitForAppMount(browser);

    const reading = await collectWebVitals(browser, { settleMs: 3_000 });

    // eslint-disable-next-line no-console
    console.log(describeReading(reading));
    if (reading.errors.length > 0) {
      // eslint-disable-next-line no-console
      console.warn("[web-vitals] registration errors:", reading.errors);
    }
    // Compare passing and failing paint samples through the same bounded
    // page-local probe. Host load average alone cannot explain either result.
    const startup = await collectPageStartupTrace(browser, reading);
    console.log('[web-vitals] page trace:', JSON.stringify(startup));

    // Record BEFORE asserting: an assert throws, and instrument health is
    // precisely the observation worth keeping from a failing run (same rule as
    // recordInteractionMs / recordInvariant — see perf-report.ts).
    //
    // DELIBERATELY *NOT* `recordInvariant`, though the temptation is obvious.
    // An invariant breach BLOCKS the deploy unconditionally, bypassing the gate's
    // warn-until-trusted posture. That is right for `invariant:webview-http-egress`,
    // which asserts a PRODUCT property the owner ruled on ("no HTTP anywhere").
    // Instrument health is not a product property — it is harness health, and the
    // gate already fail-soft PASSES on every other flavour of missing data (no run,
    // no measures, stale run). Hard-blocking every deploy because a test-harness
    // dependency failed would contradict those three branches and make an esbuild
    // hiccup freeze the fleet. Budgeted-at-0 instead: these surface as definitive
    // regressions (failingMeasures picks up any budgeted measure that missed), so
    // they warn today and block when the gate is armed, like every other budget.
    // The loud signal is the spec's own asserts below, which fail the run outright.
    // ANY non-`ready` state is unusable, so the gate-facing rollup stays a single
    // 0/1 budgeted measure. The four causes are deliberately NOT flattened away
    // upstream — `describeReading` puts the specific one in the log, and the
    // assert below reports it — but the gate's question is only "can these
    // numbers be trusted", and for that all four answer no.
    recordMeasure({
      key: "web-vitals-instrument-broken",
      value: reading.instrument === "ready" ? 0 : 1,
      unit: "count",
      budget: 0,
      ok: reading.instrument === "ready",
    });
    recordMeasure({
      key: "web-vitals-expected-metrics-missing",
      value: reading.missingExpected.length,
      unit: "count",
      budget: 0,
      ok: reading.missingExpected.length === 0,
    });

    for (const name of Object.keys(reading.metrics) as WebVitalName[]) {
      const value = reading.metrics[name];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const budget = BUDGET_MS[name] ?? null;
      recordMeasure({
        key: `web-vital:${name}`,
        value,
        unit: "ms",
        budget,
        ok: budget === null ? true : value <= budget,
      });
    }

    // 1. The apparatus came up. `{}` with a live sentinel is honest idleness; `{}`
    //    without one is a dead instrument, and that is what used to pass.
    //
    //    Asserted THROUGH the reason so the failure names WHICH of the four
    //    non-ready causes occurred. A bare `toBe("ready")` prints only the state
    //    word, and the remedies differ completely — `replaced` means fix whatever
    //    reloads the webview, `threw` means fix the payload, and confusing the two
    //    is what this whole change exists to stop.
    if (reading.instrument !== "ready") {
      throw new Error(
        `web-vitals instrument is "${reading.instrument}", not "ready": ${reading.brokenReason ?? "no reason recorded"}`,
      );
    }

    // 2. The apparatus is SEEING something. FCP and LCP are measured-available in
    //    this environment, so their absence means observers registered against an
    //    engine that reports nothing — green here would be the original bug again.
    expect(reading.missingExpected).toEqual([]);

    // 3. Only now are the values meaningful. Assert they are real numbers rather
    //    than asserting a specific speed: this is a smoke spec, and the budgets
    //    above are recorded for the trend to judge.
    for (const name of Object.keys(METRIC_ENVIRONMENT) as WebVitalName[]) {
      if (METRIC_ENVIRONMENT[name].availability !== "expected") continue;
      expect(typeof reading.metrics[name]).toBe("number");
      expect(reading.metrics[name]).toBeGreaterThan(0);
    }
  });
});
