/**
 * Packaged-binary interaction-perf spec — drives the REAL "open a plan"
 * interaction (sidebar Plans face → row click → plan body rendered in Vditor)
 * and asserts the page-relative `plan-popup-open` measure against its budget.
 *
 * This is the FRESH-HARNESS half of desktop-performance-suite-2026-07-20 (P-007)
 * and the fix EI-18128922194224210 asked for: measuring this interaction by
 * driving a long-lived dev shell with ad-hoc eval is unreliable
 * (performance.now() never resets across navigations; bare import() probes lie).
 * A FRESH packaged binary + the in-app `performance.measure` the perf-marks hooks
 * emit (read via performance.getEntriesByName — page-relative, immune to the
 * eval clock) give a trustworthy warm-open time.
 *
 * Prereqs (see ../README.md): a built desktop binary, tauri-driver, and
 * WebKitWebDriver. Run: `npm test` from tools/perf-test/wdio.
 */
import { browser } from "@wdio/globals";
import { recordInteractionMs } from "../perf-report";
import { waitForAppMount } from "../app-mount";
// Imported by PATH for the same reason app-mount.ts imports it that way: this
// runner sits outside the npm workspace set, so `@papercusp/gui-readiness` does
// not resolve here. The module is a pure function with no dependencies.
import {
  classifyInteractionMeasure,
  describeInteractionMeasureFailure,
} from "../../../../libs/generic/gui-readiness/src/interaction-measure";

const INTERACTION_NAME = "plan-popup-open";
/** Mirrors perf-marks.ts STALE_START_MS — a start older than this is discarded. */
const STALE_START_MS = 30_000;
const MEASURE_WAIT_MS = 8_000;
// Budget MIRRORS DESKTOP_PERF_BUDGETS.interactions['plan-popup-open']
// (packages/operator-core/lib/system-health/desktop-perf-budgets.ts). This runner
// is deliberately kept OUT of the npm workspace (README), so it cannot import the
// canonical constant — keep the two in sync when the budget changes.
const PLAN_POPUP_OPEN_BUDGET_MS = 1500;

describe("Packaged Papercusp desktop — plan popup open interaction", () => {
  it("opens a plan from the sidebar within the warm-render budget", async () => {
    // 1. Wait for the operator UI to mount real app content.
    await waitForAppMount(browser);

    // 2. Select the op-chat sidebar Plans face (?opcv=plans) — where the real
    //    "open a plan" interaction lives (WI-5547: the sidebar Plans view).
    await browser.execute(() => {
      const u = new URL(location.href);
      u.searchParams.set("opcv", "plans");
      history.pushState({}, "", u.pathname + u.search + u.hash);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // 3. Wait for at least one plan row in the sidebar Plans face.
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Boolean(document.querySelector('[data-testid^="plans-pane-row-"]')),
        ),
      {
        timeout: 20_000,
        timeoutMsg:
          "no plan rows in the sidebar Plans face within 20s (is the op-chat sidebar open, and are there plans?)",
      },
    );

    // 4. The app idle-warms the Vditor/Lute stack ~600ms after the Plans face
    //    mounts (WI-5547) so the first open is WARM. Give it a beat so we measure
    //    the warm open, not the cold one-time WASM init.
    await browser.pause(1500);

    // 5. Clear any stale measure, then click the first row to START the
    //    interaction (perf-marks beginInteraction fires on the click).
    //    Report whether the row was actually FOUND: "no measure" on a click that
    //    never had a target is a different defect from one that did, and without
    //    this the two are indistinguishable downstream.
    const triggerFound = await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
      const row = document.querySelector<HTMLElement>(
        '[data-testid^="plans-pane-row-"]',
      );
      if (!row) return false;
      row.click();
      return true;
    }, INTERACTION_NAME);
    const clickedAt = Date.now();

    // 6. Wait for the measure to be emitted (endInteraction fires when the plan
    //    body renders in Vditor), then read it.
    //
    //    ON TIMEOUT, NAME THE CAUSE — do not restate the symptom. "No measure in
    //    8s" is emitted identically whether the click missed, the popup never
    //    opened, the body never loaded, or the settle hook is simply absent from
    //    this mount context; those are four different bugs in four different
    //    components. The classifier decides which, from what the page shows at
    //    the moment the wait expires. (Same fix shape as the web-vitals
    //    instrument's injected-instrument classifier.)
    try {
      await browser.waitUntil(
        async () =>
          await browser.execute(
            (name) => performance.getEntriesByName(name, "measure").length > 0,
            INTERACTION_NAME,
          ),
        {
          timeout: MEASURE_WAIT_MS,
          timeoutMsg: `no "${INTERACTION_NAME}" measure emitted within ${MEASURE_WAIT_MS}ms of the click`,
        },
      );
    } catch (waitError) {
      const snapshot = await browser.execute((name) => {
        const startName = `${name}:start`;
        const marks = performance.getEntriesByName(startName, "mark");
        const start = marks[marks.length - 1];
        // The popup body PlanPopupModal renders; PlanDetail mounts inside it.
        const surface = document.querySelector<HTMLElement>(
          '[data-testid="plan-popup-body"]',
        );
        // PlanDetail shows a `.pc-plans__placeholder` while loading or on error,
        // and Vditor's preview renders into `.vditor-reset` once the body parses.
        const placeholder =
          surface?.querySelector<HTMLElement>(".pc-plans__placeholder") ?? null;
        const rendered = surface?.querySelector(".vditor-reset") ?? null;
        return {
          measureCount: performance.getEntriesByName(name, "measure").length,
          startMarkPresent: Boolean(start),
          startMarkAgeMs: start ? performance.now() - start.startTime : null,
          surfacePresent: Boolean(surface),
          contentPresent: Boolean(rendered) && !placeholder,
          placeholderText: placeholder
            ? (placeholder.textContent ?? "").trim().slice(0, 200)
            : null,
          modalPresent: Boolean(document.querySelector(".plan-popup")),
        };
      }, INTERACTION_NAME);

      const diagnosis = classifyInteractionMeasure({
        measureCount: snapshot.measureCount,
        startMarkPresent: snapshot.startMarkPresent,
        startMarkAgeMs: snapshot.startMarkAgeMs,
        staleStartMs: STALE_START_MS,
        triggerFound,
        settleSurfacePresent: snapshot.surfacePresent,
        settleContentPresent: snapshot.contentPresent,
        elapsedMs: Date.now() - clickedAt,
      });

      const observed = [
        `observed: trigger=${triggerFound}`,
        `startMark=${snapshot.startMarkPresent}`,
        `modal=${snapshot.modalPresent}`,
        `body=${snapshot.surfacePresent}`,
        `content=${snapshot.contentPresent}`,
        snapshot.placeholderText
          ? `placeholder=${JSON.stringify(snapshot.placeholderText)}`
          : null,
      ]
        .filter(Boolean)
        .join(" ");

      throw new Error(
        `${describeInteractionMeasureFailure(
          INTERACTION_NAME,
          MEASURE_WAIT_MS,
          diagnosis,
        )}\n  ${observed}\n  (wait: ${(waitError as Error).message})`,
      );
    }

    const measuredMs = await browser.execute((name) => {
      const entries = performance.getEntriesByName(name, "measure");
      return entries.length
        ? Math.round(entries[entries.length - 1].duration)
        : null;
    }, INTERACTION_NAME);

    // Record BEFORE the asserts — `expect` throws on a breach, and a breach is
    // exactly the observation the release gate exists to catch.
    recordInteractionMs(INTERACTION_NAME, measuredMs, PLAN_POPUP_OPEN_BUDGET_MS);
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(PLAN_POPUP_OPEN_BUDGET_MS);
  });
});
