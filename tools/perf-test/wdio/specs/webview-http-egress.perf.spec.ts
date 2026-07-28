/**
 * Packaged-binary spec asserting the plan's headline invariant: **the webview
 * makes no HTTP requests at all**.
 *
 * [owner 2026-07-28] "I DONT WANT TO USE HTTP ANYWHERE." Inside the desktop
 * shell every `/api` call must travel over the IPC bridge; the webview has no
 * usable network stack, and D-005 of `no-http-anywhere-2026-07-28` rules that any
 * HTTP egress from it is a loud failure rather than a fallback. This spec is the
 * executable form of that ruling (P-003a) — before it existed, the invariant was
 * asserted only in prose and broke three separate times without anyone noticing.
 *
 * WHY RESOURCE TIMING IS THE SENSOR. An IPC-routed request produces NO
 * PerformanceResourceTiming entry at all, so an `/api` entry IS the bug — the
 * signal is exact in both directions. It also needs no instrumentation of the
 * transport that is itself under suspicion, and it sees XHR / img / third-party
 * requests that a patched-`fetch` counter cannot see by construction (P-010).
 *
 * WHY THIS RUNS AGAINST A FRESH PACKAGED BINARY. The escapes this catches happen
 * during first paint and on background poll ticks, so a long-lived dev shell that
 * has already navigated is the wrong instrument (`performance.now()` never resets
 * across navigations, and the polyfill's install point moves).
 *
 * WHY IT WAITS PAST A POLL TICK — read this before shortening the timeout.
 * The bug this spec exists to prevent (D-008) was misdiagnosed for exactly this
 * reason. Nine escapes were observed clustered at t=480-783 ms and read as a
 * startup race: "the polyfill installs too late". They were nothing of the kind.
 * A second sample later in the same session found them recurring at t≈31 s, on
 * the 30 s poll tick, with `window.fetch` confirmed already patched — proving a
 * permanent path-based carve-out, not a timing window. ONE EARLY SAMPLE CANNOT
 * TELL THOSE APART. A spec that only checked first paint would have passed
 * happily against the very defect it is named after, so it samples across a full
 * background poll interval on purpose.
 *
 * Prereqs (see ../README.md): a built desktop binary, tauri-driver, and
 * WebKitWebDriver. Run: `npm test` from tools/perf-test/wdio.
 */
import { browser } from "@wdio/globals";
import { recordInvariant } from "../perf-report";

/**
 * Longest background poll interval in the shell (`EnvSwitcherBar`'s
 * `REFRESH_MS = 30_000`), plus margin for a slow request to start. Sampling must
 * span at least one full tick — see the header note.
 */
const POLL_TICK_MS = 30_000;
const SAMPLE_WINDOW_MS = POLL_TICK_MS + 6_000;

interface EgressEntry {
  path: string;
  startMs: number;
  durationMs: number;
}
interface EgressReport {
  total: number;
  byPath: Record<string, number>;
  firstAtMs: number | null;
  entries: EgressEntry[];
}
interface EgressProbe {
  report: EgressReport | null;
  monitorPresent: boolean;
  /** Positive control — see the assertion order below. */
  resourceEntries: number;
  appMounted: boolean;
}

describe("Packaged Papercusp desktop — webview HTTP egress", () => {
  it("makes ZERO HTTP requests to /api across first paint and a full background poll tick", async () => {
    // 1. Wait for real app content. This is also the first half of the positive
    //    control: an unloaded page trivially reports zero egress, and a green
    //    "no HTTP" result from a blank webview is the most dangerous possible
    //    false pass — it looks exactly like success.
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Boolean(document.querySelector("#root")?.firstElementChild),
        ),
      { timeout: 30_000, timeoutMsg: "operator UI did not mount in 30s" },
    );

    // 2. Sample across a full poll tick, so a recurring escape cannot hide in the
    //    gap between first paint and the first background refresh.
    await browser.pause(SAMPLE_WINDOW_MS);

    const probe: EgressProbe = await browser.execute(() => {
      const monitor = (
        window as unknown as {
          __papercusp_egress__?: { report: () => EgressReport };
        }
      ).__papercusp_egress__;
      return {
        report: monitor ? monitor.report() : null,
        monitorPresent: Boolean(monitor),
        resourceEntries: performance.getEntriesByType("resource").length,
        appMounted: Boolean(document.querySelector("#root")?.firstElementChild),
      };
    });

    // 3. Record BEFORE asserting (P-003c). Every `expect` below throws, and a
    //    measure recorded after a throw is a measure the release gate never sees —
    //    which would leave the gate blind to exactly the breach it exists to block.
    //    A missing detector is recorded as a breach rather than skipped: "we could
    //    not tell" must never reach the gate wearing the same face as "it was zero".
    //    The -1 sentinel is deliberate and must stay FINITE. The ingest route
    //    rejects a non-finite value, and it rejects the WHOLE POST when any one
    //    measure fails to parse — so a `NaN` here would discard the entire run's
    //    measures, leaving the gate with no data at all and fail-softing to a pass.
    //    A missing detector would then read as a clean deploy. -1 is impossible for
    //    a real request count, so it reads unambiguously as "detector absent".
    recordInvariant(
      "webview-http-egress",
      probe.report ? probe.report.total : -1,
    );

    // 4. A MISSING detector must fail, never pass. `getEgressReport()` returns
    //    null when no monitor is installed, and null means UNKNOWN — a detector
    //    that is absent, crashed, or was tree-shaken away reports the same zero
    //    as a genuinely clean shell. Treating that as success would rebuild the
    //    exact silence D-005 exists to remove.
    expect(probe.monitorPresent).toBe(true);
    expect(probe.report).not.toBe(null);

    // 5. Positive control. The shell loads hundreds of resources (measured: 249
    //    on a live boot), so a near-empty timeline means the sample is worthless
    //    rather than clean, and the zero below would be meaningless.
    expect(probe.appMounted).toBe(true);
    expect(probe.resourceEntries).toBeGreaterThan(20);

    // 6. The invariant itself.
    const report = probe.report as EgressReport;
    if (report.total !== 0) {
      const detail = report.entries
        .map(
          (e) =>
            `  ${e.path} @${Math.round(e.startMs)}ms (${Math.round(e.durationMs)}ms)`,
        )
        .join("\n");
      throw new Error(
        `webview HTTP egress must be 0, saw ${report.total}. Inside the desktop ` +
          `shell every /api call must ride the IPC bridge — each entry below ` +
          `reached the real network stack instead:\n${detail}\n\n` +
          `A path that recurs at ~${POLL_TICK_MS}ms boundaries is a background ` +
          `poll escaping on a routing rule, NOT a startup race (D-008); one that ` +
          `appears only before the polyfill installs is genuinely an ordering bug.`,
      );
    }
    expect(report.total).toBe(0);
  });
});
