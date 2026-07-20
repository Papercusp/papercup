/**
 * Packaged-binary interaction-perf spec — the BROADER real interactions
 * (desktop-performance-suite-2026-07-20 P-006), the fresh-harness half of the
 * in-app `desktopPerformanceChecks` interaction budgets. Each drives a REAL
 * interaction in a FRESH packaged binary and asserts the page-relative
 * `performance.measure` the perf-marks hooks emit (read via
 * performance.getEntriesByName — page-relative, immune to the eval-clock
 * confound EI-18128922194224210), against the interaction's budget.
 *
 * Covered here (the cleanly driver-triggerable ones):
 *   - command-palette-open : ?palette=true → the lazy cmdk chunk mounts.
 *   - inbox-list-settle     : op-chat Inbox face → a filter chip re-scopes the
 *                             virtualized list.
 *   - harness-dock-open     : /adv dock mount → dockview API bind (hydration);
 *                             emitted once on mount, so we read the latest.
 *
 * (conversation-thread-load needs a specific chat fixture to open; it is
 * exercised by the in-app suite's read-latest check + its component-wiring test.)
 *
 * Budgets MIRROR DESKTOP_PERF_BUDGETS.interactions
 * (packages/operator-core/lib/system-health/desktop-perf-budgets.ts). This runner
 * is deliberately OUT of the npm workspace (see ../README.md) so it cannot import
 * the canonical constants — keep the two in sync when a budget changes.
 *
 * Prereqs (../README.md): a built desktop binary, tauri-driver, WebKitWebDriver.
 * Run: `npm test` from tools/perf-test/wdio (or `npm run perf:desktop` at root).
 */
import { browser } from "@wdio/globals";

const COMMAND_PALETTE_OPEN_BUDGET_MS = 400;
const INBOX_LIST_SETTLE_BUDGET_MS = 300;
const HARNESS_DOCK_OPEN_BUDGET_MS = 1500;

/** Wait for the operator UI to mount real app content. */
async function waitForAppMount(): Promise<void> {
  await browser.waitUntil(
    async () =>
      await browser.execute(() =>
        Boolean(document.querySelector("#root")?.firstElementChild),
      ),
    { timeout: 30_000, timeoutMsg: "operator UI did not mount in 30s" },
  );
}

/** Read the latest page-relative measure for a named interaction, or null. */
async function latestMeasure(name: string): Promise<number | null> {
  return browser.execute((n) => {
    const entries = performance.getEntriesByName(n, "measure");
    return entries.length
      ? Math.round(entries[entries.length - 1].duration)
      : null;
  }, name);
}

describe("Packaged Papercusp desktop — broader real interactions (P-006)", () => {
  it("opens the global command palette within budget", async () => {
    const NAME = "command-palette-open";
    await waitForAppMount();

    // Clear any stale measure, then open the palette via its deep-link. The
    // open transition begins the interaction; the lazy cmdk chunk mount ends it.
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
      const u = new URL(location.href);
      u.searchParams.set("palette", "true");
      history.pushState({}, "", u.pathname + u.search + u.hash);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, NAME);

    await browser.waitUntil(
      async () =>
        await browser.execute(
          (name) => performance.getEntriesByName(name, "measure").length > 0,
          NAME,
        ),
      { timeout: 8_000, timeoutMsg: `no "${NAME}" measure within 8s of open` },
    );

    const measuredMs = await latestMeasure(NAME);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${NAME} = ${measuredMs}ms (budget ${COMMAND_PALETTE_OPEN_BUDGET_MS}ms)`,
    );
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(
      COMMAND_PALETTE_OPEN_BUDGET_MS,
    );
  });

  it("re-scopes the Inbox virtualized list within budget", async () => {
    const NAME = "inbox-list-settle";
    await waitForAppMount();

    // Open the op-chat sidebar Inbox face and force the 'needs' filter, so
    // clicking 'all' is a real re-scope.
    await browser.execute(() => {
      const u = new URL(location.href);
      u.searchParams.set("opcv", "inbox");
      u.searchParams.set("opci", "needs");
      history.pushState({}, "", u.pathname + u.search + u.hash);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Boolean(document.querySelector('[data-testid="inbox-filter-all"]')),
        ),
      {
        timeout: 20_000,
        timeoutMsg:
          "no inbox filter chips in the sidebar Inbox face within 20s (is the op-chat sidebar open?)",
      },
    );

    // Clear stale measure, then click the 'all' chip to START the interaction
    // (beginInteraction fires on the click; endInteraction after the list
    // re-renders).
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
      const chip = document.querySelector<HTMLElement>(
        '[data-testid="inbox-filter-all"]',
      );
      if (chip) chip.click();
    }, NAME);

    await browser.waitUntil(
      async () =>
        await browser.execute(
          (name) => performance.getEntriesByName(name, "measure").length > 0,
          NAME,
        ),
      { timeout: 6_000, timeoutMsg: `no "${NAME}" measure within 6s of click` },
    );

    const measuredMs = await latestMeasure(NAME);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${NAME} = ${measuredMs}ms (budget ${INBOX_LIST_SETTLE_BUDGET_MS}ms)`,
    );
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(
      INBOX_LIST_SETTLE_BUDGET_MS,
    );
  });

  it("hydrates the harness dock within budget", async () => {
    const NAME = "harness-dock-open";
    await waitForAppMount();

    // The dock emits harness-dock-open on mount → API bind. Navigate to the dock
    // route so it mounts (if it hasn't), then read the recorded measure.
    await browser.execute(() => {
      const u = new URL(location.href);
      if (!u.pathname.startsWith("/adv")) {
        location.assign("/adv?slug=papercup&ws=default");
      }
    });
    await waitForAppMount();

    await browser.waitUntil(async () => (await latestMeasure(NAME)) !== null, {
      timeout: 20_000,
      timeoutMsg: `no "${NAME}" measure recorded within 20s of the dock route`,
    });

    const measuredMs = await latestMeasure(NAME);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${NAME} = ${measuredMs}ms (budget ${HARNESS_DOCK_OPEN_BUDGET_MS}ms)`,
    );
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(
      HARNESS_DOCK_OPEN_BUDGET_MS,
    );
  });
});
