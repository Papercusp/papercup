/**
 * Resolution Inbox — the split page's ASIDE STATES and the detail pane,
 * measured in a real browser at the four viewports the plan names
 * (inbox-three-column-resolver-states-2026-09-06 P-011; D-002 the aside's
 * states, D-004 the compact split row, P-008 the detail head + rail).
 *
 * jsdom pins the CSS contract and the DOM (InboxPane.test.tsx); this spec
 * measures what the CSS actually does — how many whole rows the list shows,
 * whether the aside's four states fit the viewport, whether the detail body
 * holds its 58ch measure beside the 190px rail — and that the sidebar's stack
 * mode is untouched (D-001).
 *
 * The four states: (1) quiet briefing — nothing selected; (2) the selected
 * item's detail; (3) a live run — "Papercup is resolving…"; (4) a persisted
 * review-phase run — "Review the run" with Continue N retryable.
 */
import { join } from "node:path";
import { test, expect, assertMounted, type Page } from "./_egress";
import { stubSyncQueries, type SyncQueryStub } from "./_sync-stub";
import {
  INBOX_TOTAL,
  mkBulkRow,
  mkBulkRun,
  mkInboxFirstPage,
  mkInboxItems,
  stubInboxFlags,
} from "./_inbox-fixture";

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  "http://127.0.0.1:" +
    String(Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055);

/**
 * `rows` is the plan's floor: "≥ 8 rows at 1280×720" (P-011 / D-004). The
 * taller viewports show more; the contract only says they never show fewer.
 */
const VIEWPORTS = [
  { width: 1280, height: 720, rows: 8 },
  { width: 1366, height: 768, rows: 8 },
  { width: 1440, height: 810, rows: 8 },
  { width: 1600, height: 1020, rows: 8 },
  { width: 1920, height: 1080, rows: 8 },
] as const;

const PAGE = 60;
const ITEMS = mkInboxItems(PAGE, "aside-");
const FIRST_PAGE = mkInboxFirstPage(ITEMS, INBOX_TOTAL);
const RUN = "run-e2e";

const RESIZE_OBSERVER_LOOP_ERROR =
  /ResizeObserver loop completed with undelivered notifications/i;
const resizeObserverErrorsByPage = new WeakMap<Page, string[]>();

// Keep this guard at the file level so it attaches before every navigation,
// including the stack-mode route. The prior green run hid this browser error
// because its assertions only inspected DOM geometry and locator state.
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      RESIZE_OBSERVER_LOOP_ERROR.test(message.text())
    ) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    if (RESIZE_OBSERVER_LOOP_ERROR.test(error.message)) {
      errors.push(`pageerror: ${error.message}`);
    }
  });
  resizeObserverErrorsByPage.set(page, errors);
});

test.afterEach(({ page }, testInfo) => {
  expect(
    resizeObserverErrorsByPage.get(page) ?? [],
    `${testInfo.title} emitted a ResizeObserver loop error`,
  ).toEqual([]);
});

type Mode = "quiet" | "running" | "review";

/** One resolver per page; `mode` is read at REQUEST time, so a re-navigation after flipping it lands the next state. */
function resolver(state: { mode: Mode }) {
  return (name: string, args: Record<string, unknown>) => {
    if (name === "plans.attention") {
      return Number(args.offset ?? 0) === 0 ? FIRST_PAGE : [];
    }
    if (name === "plans.attentionBulkRun") {
      if (state.mode === "quiet") return [];
      const rows = [
        mkBulkRow(RUN, "aside-00", "auto_resolved", 0),
        mkBulkRow(RUN, "aside-01", "recommended", 1),
        // Running: the resolver has not reached aside-02. Review: it failed
        // there — the one continuable row.
        mkBulkRow(RUN, "aside-02", state.mode === "review" ? "failed" : "pending", 2),
      ];
      return [mkBulkRun(RUN, state.mode, rows)];
    }
    return undefined;
  };
}

async function openSplit(
  page: Page,
  sync: SyncQueryStub,
  theme: "light" | "dark" = "dark",
): Promise<void> {
  // `portalEmbed=1` bounds the surface to the frame (html[data-portal-embed]);
  // without it the document scrolls and every height reading is vacuous.
  const response = await page.goto(
    baseURL + "/inbox?portalEmbed=1&portalTheme=" + theme,
    { waitUntil: "domcontentloaded", timeout: 120_000 },
  );
  expect([200, 304]).toContain(response?.status() ?? 0);
  const mounted = await page
    .locator(".op-inbox--split .op-inbox__list")
    .waitFor({ state: "attached", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  assertMounted(
    mounted,
    "split /inbox: `.op-inbox--split .op-inbox__list` never attached.",
  );
  // Mount readiness and data readiness are different edges. Under the browser's
  // standing-SSE connection budget the list shell can attach while the sync GET
  // is still queued; asserting a row before the stub serves that request makes
  // an eventual healthy render look like a missing-row regression. Keep the
  // ordinary locator timeout strict, but only start it after the transport's
  // own reachability guard proves the fixture response was delivered.
  await sync.waitForServed(["plans.attention"]);
  await expect(page.getByTestId("inbox-row-aside-00")).toBeVisible();
}

function measureIdle(page: Page) {
  return page.evaluate(() => {
    const q = (sel: string) => {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) throw new Error("missing " + sel);
      return el;
    };
    const rect = (el: Element) => el.getBoundingClientRect();
    const pane = q(".op-inbox--split");
    const list = q(".op-inbox__list");
    const rail = q(".op-inbox--split .op-inbox__rail");
    const aside = q(".op-inbox--split .op-inbox__aside");
    const briefing = q('[data-testid="inbox-briefing"]');
    const lr = rect(list);
    const rows = Array.from(document.querySelectorAll(".op-inbox__rowbtn")).map(rect);
    const windowStrip = document.querySelector('[data-testid="inbox-attention-window"]');
    const foot = document.querySelector(".op-inbox__foot");
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      paneBottom: rect(pane).bottom,
      docScrolls:
        document.documentElement.scrollHeight > window.innerHeight + 1,
      floor: parseFloat(
        getComputedStyle(pane).getPropertyValue("--op-inbox-list-floor"),
      ),
      listHeight: lr.height,
      rowsWhole: rows.filter(
        (r) => r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5,
      ).length,
      rowPitch: rows.length > 1 ? rows[1].top - rows[0].top : 0,
      railWidth: rect(rail).width,
      asideScrolls: aside.scrollHeight > aside.clientHeight + 1,
      briefingState: briefing.getAttribute("data-briefing-state"),
      briefingInAside: aside.contains(briefing),
      briefingLast: briefing.lastElementChild?.getAttribute("data-testid"),
      headline: q('[data-testid="inbox-briefing-headline"]').textContent,
      hasDetailHead: !!document.querySelector('[data-testid="inbox-detail-head"]'),
      windowInAside: windowStrip ? aside.contains(windowStrip) : null,
      footInAside: foot ? aside.contains(foot) : null,
    };
  });
}

function measureSelected(page: Page) {
  return page.evaluate(() => {
    const q = (sel: string) => {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) throw new Error("missing " + sel);
      return el;
    };
    const rect = (el: Element) => el.getBoundingClientRect();
    const aside = q(".op-inbox--split .op-inbox__aside");
    const list = q(".op-inbox__list");
    const head = q('[data-testid="inbox-detail-head"]');
    const h2 = q('[data-testid="inbox-detail-title"]');
    const rail = q('[data-testid="inbox-detail-rail"]');
    const detail = q(".op-inbox--split .op-inbox__aside .op-inbox__detail");
    // The body card is the grid child that is neither the head nor the rail.
    const card = Array.from(detail.children).find(
      (c) => c !== head && c !== rail,
    );
    if (!(card instanceof HTMLElement)) throw new Error("missing detail card");
    const actionGroup = card.querySelector(".pc-items__detail-actions");
    if (!(actionGroup instanceof HTMLElement)) {
      throw new Error("missing immediate detail actions");
    }
    const actionButtons = Array.from(
      actionGroup.querySelectorAll(".pc-items__action"),
    );
    const actionTops = actionButtons.map((button) => rect(button).top);
    const actionRect = rect(actionGroup);
    const cardRect = rect(card);
    // 58ch in the card's own font: a 58-zero span measured in place.
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(58);
    probe.style.cssText =
      "position:absolute;visibility:hidden;white-space:nowrap;font:inherit;";
    card.appendChild(probe);
    const ch58 = rect(probe).width;
    probe.remove();
    const lr = rect(list);
    const rows = Array.from(document.querySelectorAll(".op-inbox__rowbtn")).map(rect);
    const selected = q(".op-inbox__row.is-selected");
    const selectedTitle = selected.querySelector(".op-inbox__title");
    const bodyStyle = getComputedStyle(q(".op-inbox__detail-copy p"));
    return {
      bodyFontSize: parseFloat(bodyStyle.fontSize),
      bodyFontWeight: bodyStyle.fontWeight,
      bodyLineHeight: parseFloat(bodyStyle.lineHeight),
      h2Tag: h2.tagName,
      h2Text: h2.textContent,
      h2Top: rect(h2).top,
      headingsInDetail: detail.querySelectorAll("h1,h2,h3,h4,h5").length,
      headInAside: aside.contains(head),
      railInAside: aside.contains(rail),
      railTag: rail.tagName,
      railDts: Array.from(rail.querySelectorAll("dt")).map((d) => d.textContent),
      railWidth: rect(rail).width,
      cardWidth: rect(card).width,
      ch58,
      actionCount: actionButtons.length,
      actionLabels: actionButtons.map((button) => button.textContent),
      actionTopSpread:
        actionTops.length > 0
          ? Math.max(...actionTops) - Math.min(...actionTops)
          : null,
      actionsInsideMeasure:
        actionRect.left >= cardRect.left - 0.5 &&
        actionRect.right <= cardRect.right + 0.5,
      actionsLoading: !!card.querySelector(
        '[data-testid="detail-actions-loading"]',
      ),
      rowsWhole: rows.filter(
        (r) => r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5,
      ).length,
      selectedRowInList:
        rect(selected).top >= lr.top - 0.5 &&
        rect(selected).bottom <= lr.bottom + 0.5,
      // D-004: in split the row title is ONE line — its box is one line-height.
      selectedTitleLines: selectedTitle
        ? Math.round(
            rect(selectedTitle).height /
              parseFloat(getComputedStyle(selectedTitle).lineHeight),
          )
        : null,
      briefingMounted: !!document.querySelector('[data-testid="inbox-briefing"]'),
      opcis: new URL(location.href).searchParams.get("opcis"),
    };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}×${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("quiet briefing, then the selected item's detail — the list keeps its rows", async ({
      page,
    }) => {
      // A freshly spawned dev server pays Vite's optimizer on its first
      // navigation (> 30s measured); the assertions themselves are instant.
      test.setTimeout(180_000);
      await stubInboxFlags(page);
      const state = { mode: "quiet" as Mode };
      const sync = await stubSyncQueries(page, resolver(state));
      await openSplit(page, sync);

      const idle = await measureIdle(page);
      expect(idle.viewport).toEqual({ w: vp.width, h: vp.height });
      expect(idle.paneBottom).toBeLessThanOrEqual(vp.height + 0.5);
      expect(idle.docScrolls).toBe(false);
      expect(idle.floor).toBeGreaterThan(0);
      expect(idle.listHeight).toBeGreaterThanOrEqual(idle.floor);
      // D-004: the compact split row — eight whole rows at 1280×720, never
      // fewer on a taller viewport.
      expect(idle.rowsWhole).toBeGreaterThanOrEqual(vp.rows);
      expect(idle.rowPitch).toBeGreaterThan(0);
      expect(idle.rowPitch).toBeLessThanOrEqual(74);
      expect(idle.railWidth).toBeCloseTo(210, 0);
      // State 1 — the quiet briefing, in the aside, the feed block last.
      expect(idle.briefingState).toBe("quiet");
      expect(idle.briefingInAside).toBe(true);
      expect(idle.briefingLast).toBe("inbox-aside-feed");
      expect(idle.headline).toBe(`${PAGE} items are waiting on you`);
      expect(idle.hasDetailHead).toBe(false);
      expect(idle.windowInAside).toBe(true);
      expect(idle.footInAside).toBe(true);
      expect(idle.asideScrolls).toBe(false);

      // State 2 — open an item: the aside becomes its detail.
      await page.getByTestId("inbox-row-aside-01").click();
      await expect(page.getByTestId("inbox-detail-title")).toBeVisible();
      const sel = await measureSelected(page);
      expect(sel.opcis).toBe("aside-01");
      expect(sel.h2Tag).toBe("H2");
      expect(sel.h2Text).toBe("Inbox aside-row 1");
      // Body copy must remain readable inside the host's bold question card.
      expect(sel.bodyFontWeight).toBe("400");
      expect(sel.bodyFontSize).toBeGreaterThanOrEqual(14);
      expect(sel.bodyLineHeight / sel.bodyFontSize).toBeGreaterThanOrEqual(1.6);
      expect(sel.headingsInDetail).toBe(1);
      expect(sel.h2Top).toBeGreaterThanOrEqual(0);
      expect(sel.h2Top).toBeLessThan(vp.height / 2);
      expect(sel.headInAside).toBe(true);
      expect(sel.railInAside).toBe(true);
      expect(sel.railTag).toBe("DL");
      expect(sel.railDts).toEqual([
        "State",
        "Importance",
        "Kind",
        "Harness",
        "Topic",
        "Waiting",
      ]);
      expect(sel.railWidth).toBeCloseTo(190, 0);
      expect(sel.cardWidth).toBeLessThanOrEqual(sel.ch58 + 1);
      expect(sel.actionCount).toBe(4);
      expect(sel.actionLabels).toEqual([
        "Acknowledge",
        "Message owner",
        "Open source",
        "Dismiss",
      ]);
      expect(sel.actionTopSpread).toBeLessThanOrEqual(1);
      expect(sel.actionsInsideMeasure).toBe(true);
      expect(sel.actionsLoading).toBe(false);
      expect(sel.briefingMounted).toBe(false);
      // The list is not disturbed by the selection: same rows, the selected
      // one on screen, its title on one line.
      expect(sel.rowsWhole).toBeGreaterThanOrEqual(vp.rows);
      expect(sel.selectedRowInList).toBe(true);
      expect(sel.selectedTitleLines).toBe(1);

      // P-005 acceptance capture is deliberately opt-in: ordinary E2E runs do
      // not leave artifacts, while a reviewer can reproduce the exact asserted
      // current-build frames from the same hermetic fixture and viewport.
      const captureDir = process.env.INBOX_P005_CAPTURE_DIR;
      if (captureDir && (vp.width === 1280 || vp.width === 1600)) {
        await page.screenshot({
          path: join(
            captureDir,
            `inbox-p005-${vp.width}x${vp.height}-selected.png`,
          ),
        });
      }
    });

    test("a live run lands the aside on the running state — same run in the rail card, badges on the rows", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await stubInboxFlags(page);
      const state = { mode: "running" as Mode };
      const sync = await stubSyncQueries(page, resolver(state));

      // State 3 — running.
      await openSplit(page, sync);
      await sync.waitForServed(["plans.attentionBulkRun"]);
      await expect(page.getByTestId("inbox-briefing-running")).toBeVisible();
      const running = await measureIdle(page);
      expect(running.briefingState).toBe("running");
      expect(running.briefingInAside).toBe(true);
      expect(running.headline).toBe("Papercup is resolving…");
      expect(running.briefingLast).toBe("inbox-aside-feed");
      expect(running.paneBottom).toBeLessThanOrEqual(vp.height + 0.5);
      expect(running.docScrolls).toBe(false);
      expect(running.rowsWhole).toBeGreaterThanOrEqual(vp.rows);
      await expect(
        page.getByTestId("inbox-briefing-running-decided"),
      ).toHaveText("2 / 3");
      // Same run, two surfaces (D-002): the rail card's compact state.
      await expect(
        page.getByTestId("inbox-rail-bulk").getByTestId("inbox-bulk-running"),
      ).toBeVisible();
      // Per-row badges during the run; the unreached row carries none.
      await expect(page.getByTestId("inbox-bulk-state-aside-00")).toHaveText(
        "resolved",
      );
      await expect(page.getByTestId("inbox-bulk-state-aside-01")).toHaveText(
        "for review",
      );
      await expect(page.getByTestId("inbox-bulk-state-aside-02")).toHaveCount(
        0,
      );
    });

    // State 4 — its own page (a fresh context): the persisted run is what the
    // page opens onto, with no deep link — a re-navigation in the running test
    // kept showing the running data (the sync layer's cache survives a reload).
    test("a persisted review-phase run lands the aside on the review state — Review, Continue N retryable, the rail card in review", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await stubInboxFlags(page);
      const state = { mode: "review" as Mode };
      const sync = await stubSyncQueries(page, resolver(state));
      await openSplit(page, sync);
      await sync.waitForServed(["plans.attentionBulkRun"]);
      await expect(page.getByTestId("inbox-briefing-review")).toBeVisible();
      const review = await measureIdle(page);
      expect(review.briefingState).toBe("last-run");
      expect(review.briefingInAside).toBe(true);
      expect(review.headline).toBe("Review the run");
      expect(review.briefingLast).toBe("inbox-aside-feed");
      expect(review.paneBottom).toBeLessThanOrEqual(vp.height + 0.5);
      expect(review.docScrolls).toBe(false);
      // The recommended row carries its inline "Papercup recommends" card in
      // the list (D-002 — bulk behaviour untouched), which is worth about two
      // row pitches; the floor allows for exactly that and nothing else.
      await expect(page.getByTestId("inbox-bulk-rec-aside-01")).toBeVisible();
      expect(review.rowsWhole).toBeGreaterThanOrEqual(vp.rows - 2);
      await expect(page.getByTestId("inbox-briefing-running")).toHaveCount(0);
      await expect(page.getByTestId("inbox-briefing-continue")).toContainText(
        "Continue 1 retryable",
      );
      await expect(
        page.getByTestId("inbox-briefing-resume-scope"),
      ).toContainText("1 row was never reached");
      await expect(
        page.getByTestId("inbox-rail-bulk").getByTestId("inbox-bulk-review"),
      ).toBeVisible();
    });
  });
}

/* ── The sidebar (stack) is untouched — D-001 ─────────────────────────── */
test.describe("stack — the op-chat sidebar's inbox face", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("renders no rail, no aside, no briefing and no detail head; the row keeps its two-line title", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await stubInboxFlags(page);
    const state = { mode: "quiet" as Mode };
    const sync = await stubSyncQueries(page, resolver(state));
    // `/` redirects to `/adv` and DROPS the search — land on /adv directly so
    // `?opcv=inbox` (the sidebar's inbox face; chat is open by default) holds.
    const response = await page.goto(baseURL + "/adv?opcv=inbox", {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    expect([200, 304]).toContain(response?.status() ?? 0);
    const mounted = await page
      .locator('.op-inbox[data-layout="stack"]')
      .waitFor({ state: "attached", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    assertMounted(
      mounted,
      "sidebar /adv?opcv=inbox: `.op-inbox[data-layout=stack]` never attached.",
    );
    await sync.waitForServed(["plans.attention"]);
    await expect(page.getByTestId("inbox-row-aside-00")).toBeVisible();
    const stack = await page.evaluate(() => {
      const pane = document.querySelector('.op-inbox[data-layout="stack"]');
      if (!(pane instanceof HTMLElement)) throw new Error("missing stack pane");
      const title = pane.querySelector(".op-inbox__rowbtn .op-inbox__title");
      const cs = title ? getComputedStyle(title) : null;
      return {
        split: !!document.querySelector(".op-inbox--split"),
        rail: !!pane.querySelector(".op-inbox__rail"),
        aside: !!pane.querySelector('[data-testid="inbox-aside"]'),
        briefing: !!pane.querySelector('[data-testid="inbox-briefing"]'),
        detailHead: !!pane.querySelector('[data-testid="inbox-detail-head"]'),
        mastheadInPane: !!pane.querySelector(".op-inbox__masthead"),
        titleClamp: cs?.getPropertyValue("-webkit-line-clamp") ?? null,
        titleWhiteSpace: cs?.whiteSpace ?? null,
        rowMinHeight: title
          ? getComputedStyle(title.closest(".op-inbox__rowbtn")!).minHeight
          : null,
      };
    });
    expect(stack.split).toBe(false);
    expect(stack.rail).toBe(false);
    expect(stack.aside).toBe(false);
    expect(stack.briefing).toBe(false);
    expect(stack.detailHead).toBe(false);
    expect(stack.mastheadInPane).toBe(true);
    expect(stack.titleClamp).toBe("2");
    expect(stack.titleWhiteSpace).not.toBe("nowrap");
    expect(stack.rowMinHeight).toBe("82px");
    // Opening an item stays inline under its row — still no detail head.
    await page.getByTestId("inbox-row-aside-01").click();
    await expect(page.getByTestId("inbox-expanded-aside-01")).toBeVisible();
    await expect(page.getByTestId("inbox-detail-head")).toHaveCount(0);
    await expect(page.getByTestId("inbox-aside")).toHaveCount(0);
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`narrow Portal reading pane keeps normal text beside metadata in ${theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    // A 1280px Portal leaves 1104px for the mounted Inbox after its docks/rail.
    await page.setViewportSize({ width: 1104, height: 800 });
    await stubInboxFlags(page);
    const sync = await stubSyncQueries(page, resolver({ mode: "quiet" }));
    await openSplit(page, sync, theme);
    await page.getByTestId("inbox-row-aside-01").click();
    await expect(page.getByTestId("inbox-detail-body-copy")).toBeVisible();
    const reading = await page.evaluate(() => {
      const body = document.querySelector(".op-inbox__detail-copy")!;
      const rail = document.querySelector(".op-inbox__detail-rail")!;
      const bodyRect = body.getBoundingClientRect();
      const style = getComputedStyle(body);
      return {
        width: bodyRect.width,
        top: bodyRect.top,
        metadataBottom: rail.getBoundingClientRect().bottom,
        fontWeight: style.fontWeight,
        fontSize: parseFloat(style.fontSize),
      };
    });
    expect(reading.width).toBeGreaterThan(300);
    expect(reading.top).toBeGreaterThanOrEqual(reading.metadataBottom);
    expect(reading.fontWeight).toBe("400");
    expect(reading.fontSize).toBeGreaterThanOrEqual(14);
  });
}
