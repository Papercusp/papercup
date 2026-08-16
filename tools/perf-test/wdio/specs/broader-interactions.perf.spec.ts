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
import { isNonShellOperatorRoute, waitForAppMount } from "../app-mount";

/**
 * The route that renders `AdvShell` — the shell every test in this file measures
 * against, and the route the packaged app boots into. Bare `/adv` on purpose:
 * each test appends the query it needs (`?palette=true`, `?tab=harnesses&...`),
 * so restoring a bare path is deterministic where restoring a captured boot URL
 * would carry one test's parameters into the next.
 */
const OPERATOR_SHELL_ROUTE = "/adv";

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

/**
 * SPA-navigate to a new path WITHOUT tearing down the WebDriver session.
 *
 * WHY NOT `history.pushState({}, "", path)` + a synthetic `popstate`
 * (WI-6543, verified live 2026-08-02 via tauri-agent-tools eval against the
 * running dev shell — not guessed from reading the test failure alone):
 *
 *   1. `history.pushState` is ALREADY MONKEY-PATCHED by TanStack Router
 *      (@tanstack/history's `createBrowserHistory`) to synchronously notify
 *      the router on every call (`onPushPop("PUSH")` → `history.notify(...)`).
 *      A plain `history.pushState(...)` call is therefore already a complete,
 *      correctly-classified PUSH navigation — no extra event needed.
 *   2. Dispatching a SYNTHETIC `PopStateEvent` on top of that is not a no-op:
 *      it fires the router's *separate* `popstate` listener
 *      (`onPushPopEvent`), which computes `delta = nextIndex - currentIndex`
 *      from `history.state[stateIndexKey]` to decide FORWARD/BACK/GO. Passing
 *      `{}` as the pushState `state` (as the old code did) means that index
 *      is `undefined` on both sides → `delta` is `NaN` → neither `isForward`
 *      nor `isBack` matches → the router misclassifies the navigation as a
 *      "GO" to an inconsistent history index and enters a slow recovery path.
 *   3. Measured impact: for a CROSS-ROUTE transition (/adv → /workbench) this
 *      added an unpredictable **10–40+ SECOND** stall before the new route's
 *      React tree actually rendered — comfortably eating the 20s budget this
 *      suite gives `harness-dock-open` to even RECORD a measure, independent
 *      of how fast the interaction under test actually is. (A SAME-route
 *      query-only change, as `command-palette-open` used, happened not to
 *      trip this — nuqs's own param read is unaffected by which router state
 *      the misclassified GO settles on — which is why that check kept
 *      passing while this one kept failing "no measure recorded".)
 *
 * The fix: call the (already-patched) `pushState` directly, preserve the
 * router's OWN state shape (`__TSR_index`/`__TSR_key`, not `{}`) so the
 * bookkeeping stays consistent even if something else later reads it, and
 * never dispatch a synthetic `popstate` for a navigation that was never a
 * real back/forward. Verified live: this took the /adv → /workbench
 * transition from 10–40s down to <1s.
 */
async function spaNavigate(path: string): Promise<void> {
  await browser.execute((p) => {
    const prevState = (window.history.state ?? {}) as Record<string, unknown>;
    const prevIndex =
      typeof prevState.__TSR_index === "number" ? prevState.__TSR_index : 0;
    history.pushState({ ...prevState, __TSR_index: prevIndex + 1 }, "", p);
  }, path);
}

describe("Packaged Papercusp desktop — broader real interactions (P-006)", () => {
  /**
   * Put every test back on the operator shell before it runs.
   *
   * Tests in this file SPA-navigate, and `harness-dock-open` deliberately ENDS on
   * `/workbench` — a route that mounts `HarnessDock` directly and never renders
   * `AdvShell` (apps/operator-vite/src/routes/workbench.tsx). Without this hook
   * the next test inherits that route and does two silently wrong things: it
   * waits for a shell marker that route cannot render, and it derives its target
   * URL from a `location.href` built on the wrong path.
   *
   * This is not defensive housekeeping — it is the fix for WI-38449. That
   * inheritance made `conversation-thread-load` time out on EVERY run from
   * 2026-08-02 to 2026-08-16. wdio then exited non-zero, the suite published no
   * measures, `harness_shared.desktop_perf_runs` went 13 days without a row, and
   * `DESKTOP_PERF_GATE` — whose freshness window is 24h — fail-soft PASSED every
   * deploy in that window while measuring nothing.
   *
   * Restored per-test (not at the end of the offending test) on purpose: a test
   * that fails its assertions never reaches its own cleanup, and the damage
   * would again be charged to the innocent test that runs next.
   *
   * Scoped to `isNonShellOperatorRoute` rather than "any path that is not /adv"
   * on purpose too. A blanket restore would also navigate away from a genuine
   * first-run/auth landing, hiding the exact false green `waitForAppMount` was
   * built to make impossible (EI-18889416741921988).
   */
  beforeEach(async () => {
    const pathname = await browser.execute(() => location.pathname);
    if (isNonShellOperatorRoute(pathname)) await spaNavigate(OPERATOR_SHELL_ROUTE);
  });

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
    }, NAME);
    const paletteUrl = await browser.execute(() => {
      const u = new URL(location.href);
      u.searchParams.set("palette", "true");
      return u.pathname + u.search + u.hash;
    });
    // SPA-navigate — see spaNavigate's doc comment for why NOT pushState+popstate.
    await spaNavigate(paletteUrl);

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
    // NB: SPA-navigate via spaNavigate() (pushState only) — NOT
    // pushState+popstate, and NOT location.assign(). A full document reload
    // inside the Tauri webview tears down the WebDriver session mid-test
    // ("Could not parse script result" then "invalid session id"), so the
    // measure could never be read back even when the dock did mount. The
    // synthetic popstate this used to also dispatch is worse than redundant —
    // see spaNavigate's doc comment: it desyncs TanStack Router's history
    // index and stalls the ACTUAL route transition 10-40+s, well past this
    // test's whole budget, independent of the dock itself (WI-6543).
    //
    // Deliberately NOT `await waitForAppMount(browser)` after this navigate:
    // that helper's mount marker is `.pc-advshell`/`[data-testid="operator-
    // shell"]` (AdvShell, the /adv shell) — /workbench never renders it (see
    // apps/operator-vite/src/routes/workbench.tsx), so that call can only
    // ever time out here. The `latestMeasure` wait below is this route's own,
    // honest readiness check.
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
    }, NAME);
    await spaNavigate("/workbench?harness=papercusp");

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

  it("loads a conversation thread within budget when opened from a work item", async () => {
    const NAME = "conversation-thread-load";
    await waitForAppMount(browser);

    // Navigate to the /adv Harnesses dock — the seeded Work-items-over-Detail
    // split (WorkItemsPanel + DetailPanel). Same route the Playwright e2e
    // (apps/operator/e2e/adv-work-item-detail-chat.spec.ts) drives; here against
    // the REAL papercusp harness rather than a stubbed slug, so we discover a
    // row instead of deep-linking a fixed id. SPA-navigate via spaNavigate() —
    // location.assign() tears down the WebDriver session (see the note above),
    // and pushState+popstate stalls a cross-route transition 10-40+s (see
    // spaNavigate's doc comment, WI-6543).
    const harnessesUrl = await browser.execute(() => {
      const u = new URL(location.href);
      u.searchParams.set("tab", "harnesses");
      u.searchParams.set("slug", "papercusp");
      u.searchParams.set("scope", "self");
      u.searchParams.set("welcome", "0");
      return u.pathname + u.search + u.hash;
    });
    await spaNavigate(harnessesUrl);
    await waitForAppMount(browser);

    // Wait for at least one row in the Work items grid. RichGrid (grid-core)
    // gives BOTH the header and every body row `role="row"` (see RichGrid.tsx —
    // no per-row data-testid exists), so index 0 is always the header and index
    // 1 is the first real data row once one has rendered.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => document.querySelectorAll('[role="row"]').length > 1,
        ),
      {
        timeout: 20_000,
        timeoutMsg:
          "no work-item rows within 20s (is the harness slug valid, and does it have work items?)",
      },
    );

    // Click the first data row — RichGrid's onRowClick → WorkItemsPanel's
    // setSelectedId → the `?sel` nuqs param the Detail pane follows.
    await browser.execute(() => {
      const rows = document.querySelectorAll<HTMLElement>('[role="row"]');
      rows[1]?.click();
    });

    // Wait for the Detail pane to resolve that selection and render its Chat
    // action (WorkItemDetail, DetailPanel.tsx — every WI-* row gets one).
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Boolean(document.querySelector('[data-testid="wi-detail-chat"]')),
        ),
      {
        timeout: 15_000,
        timeoutMsg:
          'no [data-testid="wi-detail-chat"] within 15s of selecting a work-item row',
      },
    );

    // Clear any stale measure, then click Chat: openFeatureChat POSTs a real
    // agent_chats row and fires the open-chat event; HarnessesDock's drain
    // mounts <ChatPanel>, which begins conversation-thread-load when chatId is
    // set and ends it when that chat's transcript first renders
    // (ChatPanel.tsx:168/171).
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
      document
        .querySelector<HTMLElement>('[data-testid="wi-detail-chat"]')
        ?.click();
    }, NAME);

    await browser.waitUntil(
      async () =>
        await browser.execute(
          (name) => performance.getEntriesByName(name, "measure").length > 0,
          NAME,
        ),
      {
        timeout: 20_000,
        timeoutMsg: `no "${NAME}" measure emitted within 20s of opening the chat`,
      },
    );

    const measuredMs = await latestMeasure(NAME);
    // Record BEFORE the asserts — see the note in the palette test above.
    recordInteractionMs(NAME, measuredMs, CONVERSATION_THREAD_LOAD_BUDGET_MS);
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(
      CONVERSATION_THREAD_LOAD_BUDGET_MS,
    );
  });
});
