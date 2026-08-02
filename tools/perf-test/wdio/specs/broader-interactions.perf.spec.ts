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
 *   - command-palette-open     : ?palette=true → the lazy cmdk chunk mounts.
 *   - harness-dock-open        : /adv dock mount → dockview API bind (hydration);
 *                                emitted once on mount, so we read the latest.
 *   - conversation-thread-load : /adv Harnesses dock (WI-6543 P-022 fixture path,
 *                                2026-08-02) → click a work-item row → the Detail
 *                                pane's "Chat" button (`wi-detail-chat`, EI-290)
 *                                creates a REAL agent_chats row and the dock drain
 *                                mounts <ChatPanel>, which fires
 *                                beginInteraction/endInteraction(conversationThreadLoad)
 *                                (ChatPanel.tsx:168/171) when the transcript first
 *                                renders. No pre-seeded fixture id needed — the
 *                                harness's OWN live work items supply the row, the
 *                                same "click a real row" pattern plan-popup-open
 *                                uses.
 *
 * inbox-list-settle was RETIRED (EI-18854256403211741 / WI-6543, 2026-08-02):
 * it drove the op-chat sidebar Inbox face, which was retired 2026-07-26
 * (hud-consolidation-2026-07-26 D-001, `_retired/inbox-pane/`). The HUD board
 * that replaced it has no comparable virtualized-list-filter interaction (a
 * Kanban board with a plain text-filter input, not a re-scoped virtualized
 * list), so the honest fix was to delete the check + its budget rather than
 * invent an instrumentation target nothing actually exercises. See
 * PERF_INTERACTIONS in perf-marks.ts for the still-live interaction set.
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
import { recordInteractionMs } from "../perf-report";
import { waitForAppMount } from "../app-mount";

const COMMAND_PALETTE_OPEN_BUDGET_MS = 400;
const HARNESS_DOCK_OPEN_BUDGET_MS = 1500;
const CONVERSATION_THREAD_LOAD_BUDGET_MS = 1500;

/**
 * Wait for the main thread to go QUIET before measuring an interaction.
 *
 * WHY THIS EXISTS (perf-testing-sweep-2026-07-27, P-022 — measured, not guessed):
 * `waitForAppMount` above resolves as soon as `#root` has its FIRST child, i.e.
 * on the first render commit — the app is still hydrating (route data, sync
 * queries, every pane mounting). Driving an interaction at that moment measures
 * the interaction PLUS the whole remaining boot, and the boot dominates:
 *
 *   command-palette-open, opened right after waitForAppMount, RELEASE binary  = 3048ms
 *   command-palette-open, opened on a settled app, DEV build (slower chunk
 *     loading, so a strict UPPER bound on release cost), same host load       =  110ms
 *
 * A 27x gap in the wrong direction: the number was ~96% unrelated boot work.
 * That made the check both a guaranteed false alarm against its 400ms budget
 * AND useless as a regression signal, because the value swings with host load
 * rather than with the code under test.
 *
 * Quiet is detected with rAF deltas rather than PerformanceObserver('longtask'),
 * which WebKit does not implement — so a longtask-based gate would silently
 * resolve instantly here and reintroduce the same bug.
 */
async function waitForMainThreadQuiet(): Promise<void> {
  await browser.executeAsync((done: (v: unknown) => void) => {
    const QUIET_FRAME_MS = 20; // a frame slower than this means work is still landing
    const NEEDED_CONSECUTIVE = 10; // ~166ms of calm at 60fps
    const DEADLINE_MS = 15_000; // never hang the suite waiting for calm
    const startedAt = performance.now();
    let calm = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const delta = now - last;
      last = now;
      calm = delta <= QUIET_FRAME_MS ? calm + 1 : 0;
      if (calm >= NEEDED_CONSECUTIVE || now - startedAt > DEADLINE_MS) {
        done(null);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
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
    await waitForAppMount(browser);
    // Measure the INTERACTION, not the app boot — see waitForMainThreadQuiet.
    await waitForMainThreadQuiet();

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
    // Record BEFORE the asserts — `expect` throws on a breach, and a breach is
    // exactly the observation the release gate exists to catch.
    recordInteractionMs(NAME, measuredMs, COMMAND_PALETTE_OPEN_BUDGET_MS);
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(
      COMMAND_PALETTE_OPEN_BUDGET_MS,
    );
  });

  it("hydrates the harness dock within budget", async () => {
    const NAME = "harness-dock-open";
    await waitForAppMount(browser);

    // The dock emits harness-dock-open on mount → API bind. Navigate to a route
    // that ACTUALLY MOUNTS HarnessDock, then read the recorded measure.
    //
    // WHY NOT /adv (perf-testing-sweep-2026-07-27, P-022 — measured): this test
    // used to settle for "any /adv URL", but /adv is a tab shell and only some of
    // its sub-routes mount the dock (AdvCreateDock, AdvGitDock, HarnessesDock).
    // The bare /adv landing lands on the HUD tab, which mounts no dock at all, so
    // beginInteraction/endInteraction in HarnessDock.tsx never ran and the check
    // died on "no measure recorded within 20s" — read as broken instrumentation
    // when the instrumentation was fine and the TARGET was wrong. /workbench
    // mounts <HarnessDock layoutName="workbench" slug={harness}/> unconditionally
    // (apps/operator-vite/src/routes/workbench.tsx), so it is the honest target.
    // NB: SPA-navigate via pushState+popstate, the same way the palette test
    // does — NOT location.assign(). A full document reload inside the Tauri
    // webview tears down the WebDriver session mid-test ("Could not parse script
    // result" then "invalid session id"), so the measure could never be read
    // back even when the dock did mount.
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
      history.pushState({}, "", "/workbench?harness=papercusp");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, NAME);
    await waitForAppMount(browser);

    await browser.waitUntil(async () => (await latestMeasure(NAME)) !== null, {
      timeout: 20_000,
      timeoutMsg: `no "${NAME}" measure recorded within 20s of the dock route`,
    });

    const measuredMs = await latestMeasure(NAME);
    // Record BEFORE the asserts — see the note in the palette test above.
    recordInteractionMs(NAME, measuredMs, HARNESS_DOCK_OPEN_BUDGET_MS);
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(
      HARNESS_DOCK_OPEN_BUDGET_MS,
    );
  });
});
