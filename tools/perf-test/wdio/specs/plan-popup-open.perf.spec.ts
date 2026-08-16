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
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
      const row = document.querySelector<HTMLElement>(
        '[data-testid^="plans-pane-row-"]',
      );
      if (row) row.click();
    }, INTERACTION_NAME);

    // 6. Wait for the measure to be emitted (endInteraction fires when the plan
    //    body renders in Vditor), then read it.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (name) =>
            performance.getEntriesByName(name, "measure").length > 0,
          INTERACTION_NAME,
        ),
      {
        timeout: 8_000,
        timeoutMsg: `no "${INTERACTION_NAME}" measure emitted within 8s of the click`,
      },
    );

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
