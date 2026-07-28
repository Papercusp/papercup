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
import { waitForAppMount } from "../app-mount";

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
  via?: string;
}
interface EgressReport {
  verdict: "clean" | "breach" | "unknown";
  total: number;
  byPath: Record<string, { count: number }>;
  firstAtMs: number | null;
  entries: EgressEntry[];
  sensor?: { controlObserved: boolean; blindTo: string[] };
}
interface EgressProbe {
  report: EgressReport | null;
  monitorPresent: boolean;
  /**
   * THE positive control: did a deliberate, nonce-tagged request land in the
   * sensor's own buffer? This replaces the `resourceEntries > 20` proxy, which
   * was measured WRONG for the shipped app — WebKitGTK records nothing at all
   * for `papercusp://` loads, so a perfectly healthy packaged shell reports zero
   * resource entries and the old proxy read that as a blind sensor (WI-6657).
   */
  controlObserved: boolean;
  controlReason: string | null;
  /** Retained for diagnosis only — NEVER as a control. See above. */
  resourceEntries: number;
  appMounted: boolean;
  shellPresent: boolean;
  /**
   * What the document IS at probe time. Present so a blank sample can say WHY it
   * is blank: `waitForAppMount` proves a real app existed before the pause, so a
   * changed `url` means the webview navigated (an operator-boot fallback, an
   * error page), while an unchanged one points at a reload or a crashed webview.
   * Without these the failure can only report the absence, not its cause.
   */
  url: string;
  readyState: string;
  /**
   * Identity of the document, minted by `waitForAppMount` and dying with the
   * document. Compared against the mount's token this is DEFINITIVE — where
   * `resourceEntries === 0` was only ever an inference, and one that cannot
   * distinguish "the webview was replaced" from "resource timing records nothing
   * here". Those need opposite fixes, so the sample must not conflate them.
   */
  docToken: string | null;
}

describe("Packaged Papercusp desktop — webview HTTP egress", () => {
  it("makes ZERO HTTP requests to /api across first paint and a full background poll tick", async () => {
    // 1. Wait for real app content. This is also the first half of the positive
    //    control: an unloaded page trivially reports zero egress, and a green
    //    "no HTTP" result from a blank webview is the most dangerous possible
    //    false pass — it looks exactly like success.
    const mount = await waitForAppMount(browser);

    // 2. Sample across a full poll tick, so a recurring escape cannot hide in the
    //    gap between first paint and the first background refresh.
    await browser.pause(SAMPLE_WINDOW_MS);

    const probe: EgressProbe = await browser.executeAsync((done: (r: EgressProbe) => void) => {
      const monitor = (
        window as unknown as {
          __papercusp_egress__?: {
            report: () => EgressReport;
            verify?: (o?: { timeoutMs?: number }) => Promise<{
              observed: boolean;
              reason?: string;
            }>;
          };
        }
      ).__papercusp_egress__;

      // Prove the sensor is alive BEFORE reading a zero off it. The control
      // deliberately emits one HTTP request — allowed here, in a test rig
      // auditing the invariant, and nowhere near the shipped app.
      const proof = monitor?.verify
        ? monitor.verify({ timeoutMs: 4000 })
        : Promise.resolve({
            observed: false,
            reason: "verify() is absent — this build predates the sensor control",
          });

      void proof.then((p: { observed: boolean; reason?: string }) => {
        done({
          report: monitor ? monitor.report() : null,
          monitorPresent: Boolean(monitor),
          controlObserved: Boolean(p.observed),
          controlReason: p.reason ?? null,
          resourceEntries: performance.getEntriesByType("resource").length,
          appMounted: Boolean(document.querySelector("#root")?.firstElementChild),
          shellPresent: Boolean(
            document.querySelector('[data-testid="operator-shell"], .pc-advshell'),
          ),
          url: String(window.location?.href ?? "(no location)"),
          readyState: String(document.readyState),
          docToken:
            (window as unknown as { __papercusp_perf_doc__?: string }).__papercusp_perf_doc__ ??
            null,
        });
      });
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

    // 4. POSITIVE CONTROL FIRST — assert the SAMPLE before anything about the
    //    detector, and assert it in the order that NARROWS: same document? → app
    //    still there? → sensor recording anything? Order matters for diagnosis,
    //    not for correctness: every ordering fails the same run, but only this
    //    one names the right cause, and each step rules out the readings that
    //    would otherwise be misattributed to the step after it.
    //
    //    Learned the hard way (2026-07-28). The first two packaged runs both
    //    reported `monitorPresent: false` and failed on the detector assertion —
    //    which sent me hoisting the monitor's install site, twice, believing it
    //    was a wiring bug. The rest of the probe said otherwise and was never
    //    read, because the detector assertion threw before anything printed it:
    //
    //        appMounted: false, resourceEntries: 0, report: null
    //
    //    That was read as "the document was replaced" — a reasonable inference
    //    from `resourceEntries: 0`, and still only an inference. It could equally
    //    have meant resource timing records nothing under this webview's custom
    //    protocol, which needs the opposite fix. The `docToken` below settles it
    //    outright instead, and 4c gives the blind-sensor case its own name.
    //
    //    A blank page cannot report on a detector, so ask whether we have a page
    //    before asking what the page contains.
    // `expect-webdriverio` takes no assertion-message argument, so the diagnosis
    // is thrown explicitly — the message IS the deliverable here, since a bare
    // "expected false to be true" is what sent the investigation the wrong way.
    const sampleContext =
      `  mounted at:      ${mount.url}\n` +
      `  probing:         ${probe.url}\n` +
      `  docToken:        ${mount.docToken} → ${probe.docToken ?? "(absent)"}\n` +
      `  appMounted:      ${probe.appMounted}\n` +
      `  shellPresent:    ${probe.shellPresent}\n` +
      `  resourceEntries: ${mount.resourceEntries} → ${probe.resourceEntries}\n` +
      `  readyState:      ${probe.readyState}\n`;

    // 4a. Is this even the same document we mounted? DEFINITIVE, both ways: the
    //     token is minted into `window` at mount and dies with the document, so
    //     a changed one proves replacement outright. This used to be inferred
    //     from `resourceEntries === 0`, which is not the same claim and sent two
    //     investigations at the detector instead of at the navigation.
    if (probe.docToken !== mount.docToken) {
      throw new Error(
        `the webview was REPLACED during the ${Math.round(SAMPLE_WINDOW_MS / 1000)}s sample — the ` +
          `sample is void, NOT clean.\n${sampleContext}\n` +
          `A reload, a navigation, or a crashed webview took the timeline AND the detector ` +
          `installed on the old window with it. Do NOT read a missing detector or a zero egress ` +
          `count from this run: both are downstream of measuring a different document than the ` +
          `one that mounted.`,
      );
    }

    // 4b. Same document, but did the app survive in it?
    if (!probe.appMounted || !probe.shellPresent) {
      throw new Error(
        `the operator shell is gone at probe time (same document) — the sample is void, NOT ` +
          `clean.\n${sampleContext}\n` +
          `The document was NOT replaced, so this is a client-side unmount or route change out of ` +
          `the operator shell (a crashed render, a redirect into first-run) rather than a reload.`,
      );
    }

    // 4c. Same document, app alive — so is the SENSOR alive? This used to be
    //     inferred from `resourceEntries === 0`, and that inference was wrong in
    //     the direction that matters. Measured on WebKitGTK 2.52.3 with the
    //     scheme registered as wry does (WI-6657): a `papercusp://` document
    //     gets NO resource-timing entry for its own html/js/css, so a perfectly
    //     healthy packaged shell reports ZERO entries — the old guard failed
    //     every packaged run and called a working sensor blind. What the same
    //     probe also showed: http fetch/XHR/img/sendBeacon from that document
    //     ARE recorded. The sensor works; only the proxy control was broken.
    //
    //     So ask directly instead of inferring: emit one nonce-tagged request
    //     the sensor MUST see, and require that it saw it. That is the only
    //     reading that distinguishes "nothing escaped" from "I cannot tell".
    if (!probe.controlObserved) {
      throw new Error(
        `the egress sensor could not prove itself live — this run did NOT observe a clean shell, ` +
          `it observed nothing.\n${sampleContext}` +
          `  control:         ${probe.controlReason ?? "(no reason given)"}\n\n` +
          `A deliberate control request was issued to a URL the sensor must record, and it never ` +
          `appeared. Until that lands, a zero here carries no information: "no egress observed" and ` +
          `"unable to observe egress" look identical and need opposite fixes.`,
      );
    }

    // 5. Only now: a MISSING detector must fail, never pass. `getEgressReport()`
    //    returns null when no monitor is installed, and null means UNKNOWN — a
    //    detector that is absent, crashed, or was tree-shaken away reports the
    //    same zero as a genuinely clean shell. Treating that as success would
    //    rebuild the exact silence D-005 exists to remove. Reaching this line
    //    means the page IS real, so a missing detector really is a wiring bug.
    if (!probe.monitorPresent) {
      throw new Error(
        `the app IS mounted (${probe.resourceEntries} resource timings, url=${probe.url}) but ` +
          `window.__papercusp_egress__ is absent. installDesktopIpcPolyfills() installs the ` +
          `monitor ahead of its isTauri/forceHttp guards, so — unlike a blank-page run — this ` +
          `is a genuine wiring or bundling fault and the detector really is missing.`,
      );
    }
    expect(probe.report).not.toBe(null);

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
