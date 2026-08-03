/**
 * /adv dependency-graph pane — the SELECTION INTERLOCK end-to-end (real browser).
 *
 * Plan: dependency-health-pane-2026-08-02 (P-009). The pane itself is
 * DepGraphPanel.tsx; its pure core (dep-graph-model.ts) already has 38 unit
 * tests and the seed layout is pinned in dock-layouts.test.ts. What NEITHER can
 * reach is the thing this spec exists for:
 *
 *   click a node in the SVG graph  →  `?sel` is written  →  the Detail pane,
 *   a SEPARATE dock panel with no wiring to the graph, follows to that item.
 *
 * ── WHY AN E2E AND NOT A JSDOM RENDER TEST ──────────────────────────────────
 * The interlock crosses three seams a jsdom test stubs away:
 *
 *   1. elkjs. The SVG nodes do not exist until the LAZY `import('elkjs/…')`
 *      (D-005: a ~1MB GWT bundle, deliberately kept out of the initial chunk)
 *      resolves AND its async layout returns positions. `positioned` is null
 *      until then, so in jsdom there is simply nothing to click.
 *   2. The dockview master-detail layout — the graph and Detail are different
 *      panels in the seeded layout (work-items | dep-graph on top, Detail
 *      full-width beneath: dock-layouts.ts defaultAdvHarnessesLayout).
 *   3. The nuqs `?sel` contract that is the ONLY coupling between them. There
 *      is no prop, no context, no event bus — the URL is the bus (DepGraphPanel
 *      header, "SELECTION IS URL STATE, AND THAT IS NOT A STYLE CHOICE"). A
 *      test that renders one panel in isolation cannot observe that contract at
 *      all; it would pass just as happily if the two panels were reading
 *      different params.
 *
 * Break the coupling — have the node's onClick set local state instead of
 * `setSelectedId`, or point either side at a different param name — and this
 * spec goes red while every unit test stays green. That is the guard.
 *
 * ── HERMETIC VIA ROUTE-STUBBING ─────────────────────────────────────────────
 * Mirrors adv-work-items-filter.spec.ts / adv-work-item-detail-chat.spec.ts:
 * projects/lite is stubbed so the fictional slug always mounts the dock, and
 * the sync batch answers per query NAME — `workItems.byHarness` (the rows, ONE
 * subscription shared by grid + graph + detail), `workItems.depEdges` (the
 * edges, the graph's only extra query) and `workItems.detail` (the selected
 * row). No populated substrate is touched.
 *
 * ── ONE TEST, ONE MOUNT ─────────────────────────────────────────────────────
 * Deliberate, and copied from the sibling filter spec's hard-won note: the /adv
 * dock mount is the expensive and occasionally-flaky step against a reused dev
 * server, and a batch of separate mounts was flaky when run together while each
 * passed in isolation. So every leg of the interlock is exercised in sequence
 * against a single mount.
 *
 * A Vite dep-optimize reload (elkjs is not pre-bundled) is survivable here by
 * construction: the selection lives in the URL, so a reload restores it rather
 * than losing it. We still wait for the laid-out nodes before the first click,
 * which means the import + any reload it triggered has already settled.
 *
 * NB: like the sibling adv specs this drives the operator-vite SPA in the e2e
 * Chromium project. A stale HMR-disabled :3055 serves a blank #root — the shell
 * never mounts and the spec SKIPS (it does not falsely fail). Run against an
 * HMR-enabled Vite (the config's own webServer boots one) to actually exercise it.
 */
import { test, expect, type Page } from './_egress';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

// Fictional slug — valid because projects/lite is stubbed; hermetic because no
// real workspace harness is touched. Unique so no persisted dock layout for a
// real slug hydrates over the seeded work-items | dep-graph / Detail split.
const SLUG = process.env.ADV_DEPGRAPH_E2E_SLUG ?? 'e2e-depgraph-pot';

/**
 * Three rows, shaped to make the graph's own scoping observable:
 *   WI-2  blocks  WI-1   → both PARTICIPATE in an edge, so both are nodes
 *   WI-3  isolated        → no edge, so it is deliberately NOT in the graph
 *                           (buildDepSubgraph: an item with no dependency story
 *                           is excluded — that is the default that keeps the
 *                           pane readable at corpus scale)
 * All WI-* so resolveSelectionKind routes them to the unified WorkItemDetail.
 */
const WORK_ITEMS = [
  {
    id: 'WI-1',
    kind: 'bug',
    family: 'issue',
    title: 'Blocked item',
    summary: null,
    state: 'open',
    assignee: 'alice',
    assignedBy: null,
    severity: 'high',
    priority: 1,
    rank: 1,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-08-03T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
  {
    id: 'WI-2',
    kind: 'task',
    family: 'issue',
    title: 'Blocking item',
    summary: null,
    state: 'in_progress',
    assignee: 'bob',
    assignedBy: null,
    severity: null,
    priority: 2,
    rank: 2,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-08-03T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
  {
    id: 'WI-3',
    kind: 'task',
    family: 'issue',
    title: 'Unrelated item',
    summary: null,
    state: 'open',
    assignee: null,
    assignedBy: null,
    severity: null,
    priority: 3,
    rank: 3,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-08-03T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
];

/**
 * One live edge: WI-2 blocks WI-1. `blockerStatus: 'in_progress'` is NOT
 * terminal for the issue family, so the edge genuinely gates (not `satisfied`)
 * and survives in the default `dgh=all` view.
 */
const DEP_EDGES = [
  {
    blockedId: 'WI-1',
    blockerId: 'WI-2',
    blockerRef: 'WI-2',
    blockedKind: 'bug',
    blockerKind: 'task',
    blockerStatus: 'in_progress',
  },
];

const SKIP_MSG =
  'The /adv shell did not mount the harnesses dock. Run against an HMR-enabled ' +
  'operator-vite (the config webServer boots one with PAPERCUSP_ENABLE_HMR=1) — a ' +
  "stale HMR-disabled :3055 serves a blank #root ('/@vite/client' noop stub).";

async function stubApis(page: Page) {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        projects: [
          {
            slug: SLUG,
            path: `/tmp/${SLUG}`,
            name: SLUG,
            hasState: true,
            hasSpec: true,
            parent_slug: null,
            harness_kind: 'project',
            is_shared: false,
          },
        ],
      }),
    });
  });

  // Top-bar status + the Detail pane's useHarnessFeatures REST bootstrap both
  // hit /status — carry BOTH shapes (counts for the bar, features:[] so the
  // features list resolves and the pane leaves "Loading…").
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 }, features: [] }),
    });
  });
  await page.route('**/api/harness/*/issues-list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ issues: [], pending: [] }),
    });
  });
  await page.route('**/api/harness/*/lanes**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ lanes: [], max: 1 }),
    });
  });
  await page.route('**/api/harness/*/agents**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: [], runs: [] }),
    });
  });

  // Sync batch — rows per query NAME. The graph reads byHarness + depEdges; the
  // Detail pane re-reads byHarness (same key, deduped) plus its own 1-row
  // `workItems.detail`. Everything else → [].
  await page.route('**/api/zero-harness/rest-query-batch**', async (route) => {
    const post = route.request().postDataJSON() as
      | { queries?: Array<{ name?: string; args?: Record<string, unknown> }> }
      | null;
    const queries = post?.queries ?? [];
    const results = queries.map((q) => {
      let rows: unknown[] = [];
      if (q.name === 'workItems.byHarness') rows = WORK_ITEMS;
      else if (q.name === 'workItems.depEdges') rows = DEP_EDGES;
      else if (q.name === 'workItems.detail') {
        const id = typeof q.args?.id === 'string' ? q.args.id : '';
        rows = WORK_ITEMS.filter((w) => w.id === id);
      }
      return { rows, version: String(Date.now()) };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results }),
    });
  });
}

/**
 * Drives to the harnesses dock and reports whether it mounted. `welcome=0`
 * suppresses the no-work HarnessWelcome overlay (default-on, gated on
 * useHarnessHasNoWork) — with empty features/issues stubs it otherwise covers
 * the dock and intercepts every click.
 */
async function dockMounts(page: Page): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=harnesses&slug=${SLUG}&scope=self&welcome=0`, {
    waitUntil: 'domcontentloaded',
  });
  return page
    .getByRole('button', { name: 'Add panel' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

function selParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('sel');
}

test.describe('/adv dependency graph — selection interlock with the Detail pane', () => {
  test('a graph node click writes ?sel and the Detail pane follows it', async ({ page }) => {
    await stubApis(page);
    const mounted = await dockMounts(page);
    test.skip(!mounted, SKIP_MSG);

    const graph = page.locator('.pc-depgraph').first();
    const detail = page.locator('.pc-adv-detail').first();

    // ── 0. The graph laid out. Waiting on a NODE (not the pane) is what proves
    //       the lazy elkjs import resolved and its async layout returned — the
    //       SVG does not render at all until `positioned` is set. This is also
    //       the settle point for any Vite dep-optimize reload elkjs triggers.
    const nodes = graph.locator('g.pc-depgraph__node');
    await expect(nodes).toHaveCount(2, { timeout: 45_000 });

    // Only the two edge PARTICIPANTS are nodes — WI-3 has no dependency story,
    // so the default scoping excludes it. Pins that the graph is showing the
    // subgraph, not the raw corpus.
    await expect(graph.locator('g.pc-depgraph__node', { hasText: 'WI-3' })).toHaveCount(0);
    await expect(graph.getByText('2 nodes · 1 edge')).toBeVisible();

    // Detail starts on its pick-an-item empty state — nothing is selected yet.
    await expect(detail.getByText('Pick a work item from the list to inspect.')).toBeVisible({
      timeout: 20_000,
    });
    expect(selParam(page)).toBeNull();

    // ── 1. THE INTERLOCK. Clicking the SVG node must write `?sel` (nuqs) and
    //       the Detail pane — a different dock panel, coupled only through that
    //       URL param — must follow to the same item.
    const blockerNode = graph.locator('g.pc-depgraph__node', { hasText: 'WI-2' });
    await blockerNode.click();

    await expect.poll(() => selParam(page), { timeout: 10_000 }).toBe('WI-2');
    await expect(detail.locator('.pc-adv-detail__id')).toHaveText('WI-2', { timeout: 15_000 });
    await expect(detail.locator('.pc-adv-detail__title')).toHaveText('Blocking item');

    // The node reflects the selection it just drove (round-trips back through
    // the same param it wrote).
    await expect(blockerNode).toHaveClass(/pc-depgraph__node--selected/);

    // ── 2. A SECOND node re-drives it — the first result was not a one-shot or
    //       a coincidence of initial state.
    const blockedNode = graph.locator('g.pc-depgraph__node', { hasText: 'WI-1' });
    await blockedNode.click();
    await expect.poll(() => selParam(page), { timeout: 10_000 }).toBe('WI-1');
    await expect(detail.locator('.pc-adv-detail__id')).toHaveText('WI-1', { timeout: 15_000 });
    await expect(detail.locator('.pc-adv-detail__title')).toHaveText('Blocked item');

    // ── 3. THE A11Y LIST IS AN EQUIVALENT CONTROL SURFACE, not a consolation
    //       prize (P-006 / D-001: a node-edge SVG is structurally the least
    //       accessible treatment, so the depth-ordered list drives the SAME
    //       selection). If it ever degrades to a read-only mirror, this fails.
    const a11yList = graph.locator('ul.pc-depgraph__a11y');
    await a11yList.getByRole('button', { name: /^WI-2 —/ }).click();
    await expect.poll(() => selParam(page), { timeout: 10_000 }).toBe('WI-2');
    await expect(detail.locator('.pc-adv-detail__id')).toHaveText('WI-2', { timeout: 15_000 });
    await expect(a11yList.getByRole('button', { name: /^WI-2 —/ })).toHaveAttribute(
      'aria-current',
      'true',
    );

    // ── 4. CLEAR SELECTION drops the param, and the Detail pane returns to its
    //       empty state — the interlock releases as well as it engages.
    await graph.getByRole('button', { name: 'Clear selection' }).click();
    await expect.poll(() => selParam(page), { timeout: 10_000 }).toBeNull();
    await expect(detail.getByText('Pick a work item from the list to inspect.')).toBeVisible({
      timeout: 15_000,
    });
  });
});
