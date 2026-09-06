/**
 * Resolution Inbox — row-list FLOOR, measured in a real browser.
 * (inbox-three-column-resolver-states-2026-09-06 P-001 / D-001;
 *  EI-22478177553828828.)
 *
 * jsdom cannot measure layout, so `InboxPane.test.tsx` pins only the CSS
 * contract. This spec measures the thing itself. Measured live 2026-09-05: at
 * 1280×720 the split `/inbox` page rendered `.op-inbox__list` at 0px — zero of
 * 77 rows on screen — because every chrome sibling in the list column was
 * rigid (`flex: 0 0 auto`) and only the list flexed, so the column's entire
 * vertical shortfall landed on the rows.
 *
 * The fixture is the WORST realistic chrome load for the list column: the bulk
 * strip flag ON, three tier chips, eight kind facets (enough to wrap), and a
 * load-more window strip (a `_meta.hasMore` page). At 1280×720 the list must
 * still hold its floor (≥ 2 whole rows visible) with the foot still inside the
 * column — and it is the CONTROLS block, not the list, that scrolls.
 */
import { test, expect, assertMounted, type Page } from "./_egress";
import { stubSyncQueries } from "./_sync-stub";

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  "http://127.0.0.1:" +
    String(Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055);

const KINDS = [
  "coord-message",
  "coord-escalation",
  "standing-approval",
  "conversation",
  "operator-report",
  "improvement",
  "scout-grade",
  "smoke-fail",
] as const;

const PAGE = 60;
const TOTAL = 180;

const now = Date.now();
const items = Array.from({ length: PAGE }, (_, i) => ({
  id: "floor-" + String(i).padStart(2, "0"),
  kind: KINDS[i % KINDS.length],
  source: "coord",
  harnessSlug: "papercusp",
  planSlug: null,
  itemRef: null,
  title: "Inbox floor row " + i,
  body: "Body of floor row " + i,
  status: "open",
  importance: "normal",
  // Decision tier + needsHuman: the default "Needs you" chip keeps every row,
  // and `scopeInboxItems` never age-drops a decision.
  tier: "decision",
  needsHuman: true,
  ownerAgentId: "su-e2e",
  ownerLabel: "su · su-e2e",
  occurredAt: new Date(now - i * 60_000).toISOString(),
  triageState: "untriaged",
  triageNote: null,
  triagedBy: null,
  triagedAt: null,
  actions: [{ id: "ack", label: "Acknowledge", primary: true }],
  ref: { kind: "coord-message", msgId: "floor-msg-" + i },
}));

const firstPage = [
  {
    key: "g-floor",
    kind: "plan",
    planSlug: "floor-plan",
    harnessSlug: "papercusp",
    title: "floor-plan",
    items,
    maxImportance: "normal",
    // The server's page contract (readAttentionPageMeta): hasMore → the
    // "Showing N of M … Load more" window strip mounts — one more rigid chrome
    // sibling above the list.
    _meta: {
      total: TOTAL,
      offset: 0,
      limit: PAGE,
      returned: PAGE,
      hasMore: true,
      nextOffset: PAGE,
    },
  },
];

async function stubFlags(page: Page): Promise<void> {
  await page.route("**/api/flags/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        flags: { "papercusp-inbox-bulk-resolve": true },
        evaluatedAt: Date.now(),
        source: "override",
      }),
    });
  });
  await page.route("**/api/flags/stream", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": inbox-list-floor e2e flags pinned\n\n",
    });
  });
}

test.use({ viewport: { width: 1280, height: 720 } });

test("split /inbox keeps the row list above its floor at 1280×720", async ({
  page,
}) => {
  await stubFlags(page);
  const sync = await stubSyncQueries(page, (name, args) => {
    if (name === "plans.attention") {
      return Number(args.offset ?? 0) === 0 ? firstPage : [];
    }
    if (name === "plans.attentionCounts") {
      return [
        { decisionItems: TOTAL, decisionPlans: 1, alerts: 0, total: TOTAL },
      ];
    }
    return undefined;
  });

  // `portalEmbed=1` is what the cloud portal's iframe passes: it stamps
  // `html[data-portal-embed=true]`, which is the selector that bounds the
  // `.portal-focused-work-surface` to the frame (globals.css) — WITHOUT it the
  // document scrolls instead and no collapse can happen, so the measurement
  // below would be vacuous. This is the exact location the 0px was measured in.
  const response = await page.goto(
    baseURL + "/inbox?portalEmbed=1&portalTheme=dark",
    { waitUntil: "domcontentloaded" },
  );
  expect([200, 304]).toContain(response?.status() ?? 0);
  await sync.waitForServed(["plans.attention", "plans.attentionCounts"]);

  const list = page.locator(".op-inbox--split .op-inbox__list");
  const mounted = await list
    .waitFor({ state: "attached", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  assertMounted(
    mounted,
    "split /inbox: `.op-inbox--split .op-inbox__list` never attached.",
  );
  // The chrome the floor has to beat must actually be on screen — otherwise a
  // pass here says nothing about the collapse this spec exists to catch.
  await expect(page.getByTestId("inbox-attention-window")).toBeVisible();
  await expect(page.getByTestId("inbox-facet-smoke-fail")).toBeVisible();
  await expect(page.getByTestId("inbox-row-floor-00")).toBeVisible();

  const g = await page.evaluate(() => {
    const q = (sel: string) => {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) throw new Error("missing " + sel);
      return el;
    };
    const rect = (el: Element) => el.getBoundingClientRect();
    const pane = q(".op-inbox--split");
    const column = q(".op-inbox--split .op-inbox__column");
    const controls = q(".op-inbox__controls");
    const listEl = q(".op-inbox__list");
    const foot = q(".op-inbox__foot");
    const listRect = rect(listEl);
    const floor = parseFloat(
      getComputedStyle(pane).getPropertyValue("--op-inbox-list-floor"),
    );
    const rowsInside = Array.from(
      document.querySelectorAll(".op-inbox__rowbtn"),
    )
      .map(rect)
      .filter(
        (r) => r.top >= listRect.top - 0.5 && r.bottom <= listRect.bottom + 0.5,
      ).length;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      paneBottom: rect(pane).bottom,
      floor,
      listHeight: listRect.height,
      rowsInside,
      controlsScrolls: controls.scrollHeight > controls.clientHeight + 1,
      controlsHeight: rect(controls).height,
      footInsideColumn: rect(foot).bottom <= rect(column).bottom + 0.5,
    };
  });

  // Preconditions — the geometry only means something if the page is bounded
  // by the viewport (no document scroll hiding the shortfall) and the token
  // resolved. A pass on an unbounded page would be vacuous.
  expect(g.viewport).toEqual({ w: 1280, h: 720 });
  expect(g.paneBottom).toBeLessThanOrEqual(720 + 0.5);
  expect(g.floor).toBeGreaterThan(0);

  // The contract.
  expect(g.listHeight).toBeGreaterThanOrEqual(g.floor);
  expect(g.rowsInside).toBeGreaterThanOrEqual(2);
  expect(g.footInsideColumn).toBe(true);
  // …and the shortfall landed on the chrome cap, not the rows: the controls
  // block is the one that scrolls.
  expect(g.controlsScrolls).toBe(true);
  expect(g.controlsHeight).toBeGreaterThanOrEqual(62);
});
