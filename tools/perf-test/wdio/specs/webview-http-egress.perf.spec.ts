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
 * WebKitWebDriver. Run: `npm run test:all` from tools/perf-test/wdio.
 */
import { browser } from "@wdio/globals";
import { operatorBaseUrl, recordInvariant } from "../perf-report";
import { waitForAppMount } from "../app-mount";

/**
 * Longest background poll interval in the shell (`EnvSwitcherBar`'s
 * `REFRESH_MS = 30_000`), plus margin for a slow request to start. Sampling must
 * span at least one full tick — see the header note.
 */
const POLL_TICK_MS = 30_000;
const SAMPLE_WINDOW_MS = POLL_TICK_MS + 6_000;

/**
 * A void sample is a re-measure trigger, not a verdict. Give a transient
 * navigation/reload one fresh attempt before publishing the -1 sentinel. The
 * second attempt still has the normal full poll-tick window, so a real sensor
 * or product failure remains observable and is recorded for the gate.
 */
const MAX_VOID_SAMPLE_ATTEMPTS = 2;
const VOID_RETRY_DELAY_MS = 1_000;

/**
 * Where the sensor's positive control is sent — and it MUST come from the runner,
 * never from the webview's own origin.
 *
 * THE BUG THIS FIXES (2026-08-01). `verifyEgressSensor` falls back to
 * `defaultControlUrl()`, which builds the control from `window.location.origin`
 * and returns null for any non-http(s) scheme. The packaged shell's origin is
 * `papercusp://localhost`, so that fallback was ALWAYS null there: every packaged
 * run reported `controlReason: 'no control URL available'`, `verdict: 'unknown'`,
 * and failed — the spec could not pass against the one artifact it exists to
 * audit. It could only go green where the origin was already http(s), i.e. the
 * dev configuration D-010 rules must never be measured. A self-defeating control:
 * the more completely the app achieved the invariant, the less the sensor could
 * prove about it.
 *
 * An origin-derived control is unfixable in principle here — "the webview speaks
 * no HTTP" is the property under test, so its origin can never supply an HTTP
 * control. The runner's operator origin is reachable by construction, and a 404
 * from it proves the sensor exactly as well as a 200.
 *
 * NOT under `/api/`, and nonce-tagged, so it cannot be mistaken for an escape:
 * the monitor reports only `/api` paths and excludes the nonce besides.
 */
const CONTROL_URL = `${operatorBaseUrl()}/__egress_control__`;

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
  /**
   * Whether the control request was actually EMITTED. Distinguishes "the sensor
   * missed a request that was sent" (blind sensor) from "no request was ever
   * sent" (unproven sensor, runner misconfigured) — see the 4d diagnosis.
   *
   * TRI-STATE, and it must stay that way: `null` means the monitor in the BUNDLE
   * UNDER TEST predates the `issued` field and simply cannot say. Collapsing that
   * to `false` would make the diagnosis assert "no control was ever issued"
   * against any older packaged bundle — reintroducing, one level down, the exact
   * conflation this field exists to remove. Observed live 2026-08-01: a run with
   * `controlObserved: true` reported `issued` absent, because the packaged app's
   * bundled monitor predates this change.
   */
  controlIssued: boolean | null;
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
    let mount!: Awaited<ReturnType<typeof waitForAppMount>>;
    let probe!: EgressProbe;
    let sampleVoidReason: string | null = null;

    for (let attempt = 1; attempt <= MAX_VOID_SAMPLE_ATTEMPTS; attempt += 1) {
      // 1. Wait for real app content. This is also the first half of the positive
      //    control: an unloaded page trivially reports zero egress, and a green
      //    "no HTTP" result from a blank webview is the most dangerous possible
      //    false pass — it looks exactly like success. A void sample gets a
      //    fresh mount and a fresh document on the retry.
      mount = await waitForAppMount(browser);

      // 2. Sample across a full poll tick, so a recurring escape cannot hide in the
      //    gap between first paint and the first background refresh.
      await browser.pause(SAMPLE_WINDOW_MS);

      probe = await browser.executeAsync(
      (controlUrl: string, done: (r: EgressProbe) => void) => {
      const monitor = (
        window as unknown as {
          __papercusp_egress__?: {
            report: () => EgressReport;
            verify?: (o?: { timeoutMs?: number; controlUrl?: string }) => Promise<{
              observed: boolean;
              issued?: boolean;
              reason?: string;
            }>;
          };
        }
      ).__papercusp_egress__;

      // Prove the sensor is alive BEFORE reading a zero off it. The control
      // deliberately emits one HTTP request — allowed here, in a test rig
      // auditing the invariant, and nowhere near the shipped app.
      const proof = monitor?.verify
        ? monitor.verify({ timeoutMs: 4000, controlUrl })
        : Promise.resolve({
            observed: false,
            // Nothing was sent: an absent verify() cannot have issued anything.
            issued: false,
            reason: "verify() is absent — this build predates the sensor control",
          });

      void proof.then((p: { observed: boolean; issued?: boolean; reason?: string }) => {
        done({
          report: monitor ? monitor.report() : null,
          monitorPresent: Boolean(monitor),
          controlObserved: Boolean(p.observed),
          // NOT Boolean(): an absent `issued` means "this bundle cannot say",
          // which is a third answer, not a false. See EgressProbe.controlIssued.
          controlIssued: typeof p.issued === "boolean" ? p.issued : null,
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
      },
      CONTROL_URL,
    );

    // 3. Record BEFORE asserting (P-003c). Every `expect` below throws, and a
    //    measure recorded after a throw is a measure the release gate never sees —
    //    which would leave the gate blind to exactly the breach it exists to block.
    //    A missing detector is recorded as unknown rather than skipped: "we could
    //    not tell" must never reach the gate wearing the same face as "it was zero".
    //    The -1 sentinel is deliberate and must stay FINITE. The ingest route
    //    rejects a non-finite value, and it rejects the WHOLE POST when any one
    //    measure fails to parse — so a `NaN` here would discard the entire run's
    //    measures, leaving the gate with no data at all and fail-softing to a pass.
    //    A missing detector would then read as a clean deploy. -1 is impossible for
    //    a real request count, so it reads unambiguously as "detector absent".
    //    ── WHY VALIDITY IS DECIDED HERE AND NOT BY THE ASSERTS BELOW (WI-38449) ──
    //    The rule above was implemented for ONE void case (an absent detector) and
    //    missed the others, which is how a run that threw "the sample is void, NOT
    //    clean" still published `invariant:webview-http-egress = 0, ok: true`.
    //    Nothing malfunctioned: the document had been REPLACED, and the fresh
    //    document's fresh monitor truthfully reported 0 requests seen — over the
    //    handful of milliseconds it had existed. The 36s window the invariant
    //    asserts over was never sampled at all.
    //
    //    That is worse than an ordinary wrong number, because this is the ONE
    //    measure class that blocks unconditionally: `breachedInvariants()` matches
    //    `invariant === true && !ok`, so an unmeasurable invariant reporting `ok`
    //    is indistinguishable from a verified-clean one, and the gate's strongest
    //    signal silently degrades to a fail-open. The asserts below cannot save it
    //    — they throw AFTER the record, which is exactly why the record is first.
    //
    //    So the sample is judged before it is published, in the same narrowing
    //    order the asserts use. `-1` for every void case, not just the absent
    //    detector: "we could not tell" must never reach the gate wearing the same
    //    face as "it was zero".
      sampleVoidReason =
      probe.docToken !== mount.docToken
        ? "document replaced during the sample"
        : !probe.appMounted || !probe.shellPresent
          ? "operator shell gone at probe time"
            : !probe.report
              ? "egress detector absent"
              : null;

      if (sampleVoidReason === null || attempt === MAX_VOID_SAMPLE_ATTEMPTS) break;

      // A document replacement or transient unmount is not evidence about the
      // invariant. Retry the complete sample before publishing the unmeasured
      // sentinel, so one load-induced void cannot become a release verdict.
      // eslint-disable-next-line no-console
      console.warn(
        `[perf] invariant webview-http-egress sample void on attempt ${attempt}/${MAX_VOID_SAMPLE_ATTEMPTS} ` +
          `(${sampleVoidReason}); retrying after ${VOID_RETRY_DELAY_MS}ms`,
      );
      await browser.pause(VOID_RETRY_DELAY_MS);
    }

    // 3. Record only after the retry budget is exhausted. Every `expect` below
    //    throws, and a measure recorded after a throw is a measure the release
    //    gate never sees; recording the final sample first keeps a persistent
    //    producer failure audible without publishing a transient void.
    recordInvariant(
      "webview-http-egress",
      sampleVoidReason === null && probe.report ? probe.report.total : -1,
    );
    if (sampleVoidReason !== null) {
      // eslint-disable-next-line no-console
      console.warn(
        `[perf] invariant webview-http-egress recorded as -1 (UNMEASURABLE: ${sampleVoidReason}) — ` +
          `not as a clean 0. The run below fails with the full diagnosis.`,
      );
    }

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

    // 4c. Same document, app alive — is the detector even THERE? This must come
    //     before the control below, or an absent monitor fails with the control's
    //     diagnosis ("the sensor could not prove itself") instead of its own
    //     ("the sensor is missing"), which points at the wrong fix.
    //
    //     A MISSING detector must fail, never pass: absent, crashed or
    //     tree-shaken away, it reports the same zero as a genuinely clean shell,
    //     and treating that as success rebuilds the exact silence D-005 exists to
    //     remove. Reaching this line means the page IS real, so a missing
    //     detector really is a wiring bug.
    if (!probe.monitorPresent) {
      throw new Error(
        `the app IS mounted (url=${probe.url}) but window.__papercusp_egress__ is absent. ` +
          `installDesktopIpcPolyfills() installs the monitor ahead of its isTauri/forceHttp ` +
          `guards, so — unlike a blank-page run — this is a genuine wiring or bundling fault ` +
          `and the detector really is missing.`,
      );
    }
    expect(probe.report).not.toBe(null);

    // 4d. The detector exists — but is it SEEING anything? This used to be
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
      // Two failures wear this same face and need OPPOSITE fixes, so name which
      // one happened rather than asserting the more alarming of the two. Saying
      // "the request was issued and never appeared" when nothing was ever sent
      // accuses a healthy sensor and sends the reader at the monitor instead of
      // at the runner's configuration — the exact conflation this spec's own
      // header forbids, committed by its own diagnosis (2026-08-01).
      const diagnosis =
        probe.controlIssued === true
          ? `A deliberate control request WAS issued to a URL the sensor must record, and it never ` +
            `appeared. The sensor is blind: fix the monitor, not this runner.`
          : probe.controlIssued === false
            ? `NO control request was ever issued — the proof never left the ground, so this says ` +
              `NOTHING about whether the sensor works. Fix the runner's control URL ` +
              `(${CONTROL_URL}) or the operator it points at; do not go looking for a bug in the ` +
              `monitor.`
            : `The bundle under test predates the sensor's \`issued\` flag, so it CANNOT say ` +
              `whether the control was ever emitted — do not assume either cause from this run. ` +
              `Rebuild the app bundle to get a decisive answer; meanwhile check by hand that ` +
              `${CONTROL_URL} is reachable from the runner.`;
      throw new Error(
        `the egress sensor could not prove itself live — this run did NOT observe a clean shell, ` +
          `it observed nothing.\n${sampleContext}` +
          `  control url:     ${CONTROL_URL}\n` +
          `  control issued:  ${probe.controlIssued ?? "(bundle cannot say)"}\n` +
          `  control:         ${probe.controlReason ?? "(no reason given)"}\n\n` +
          `${diagnosis}\n\n` +
          `Until the control lands, a zero here carries no information: "no egress observed" and ` +
          `"unable to observe egress" look identical and need opposite fixes.`,
      );
    }

    // 5. The invariant itself.
    const report = probe.report as EgressReport;
    if (report.total !== 0) {
      const detail = report.entries
        .map(
          (e) =>
            `  ${e.path} @${Math.round(e.startMs)}ms (${Math.round(e.durationMs)}ms)` +
            `${e.via && e.via !== "resource-timing" ? ` [via ${e.via}]` : ""}`,
        )
        .join("\n");
      throw new Error(
        `webview HTTP egress must be 0, saw ${report.total}. Inside the desktop ` +
          `shell every /api call must ride the IPC bridge — each entry below ` +
          `reached the real network stack instead:\n${detail}\n\n` +
          `A path that recurs at ~${POLL_TICK_MS}ms boundaries is a background ` +
          `poll escaping on a routing rule, NOT a startup race (D-008); one that ` +
          `appears only before the polyfill installs is genuinely an ordering bug. ` +
          `An entry marked [via websocket] or [via eventsource] came from a stream, ` +
          `which resource timing cannot see at all — those are caught by the ` +
          `constructor wrappers, and desktop sync is SSE-primary, so they matter most.`,
      );
    }
    // The verdict, not the count. A zero with an unproven sensor is `unknown`,
    // and the whole point of this spec is that `unknown` must never read green.
    expect(report.verdict).toBe("clean");
  });
});
