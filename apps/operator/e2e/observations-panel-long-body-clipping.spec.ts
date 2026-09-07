/**
 * Observations pane (Learning tab, `?lview=observations`) — expanded-row
 * TEXT CLIPPING regression (WI-5419).
 *
 * Owner report (2026-07-19, interactive): "The observations tab still has
 * the bug where the text is cut off" — reported AFTER the 2026-07-18
 * measureVariableHeight fix (ObservationsPanel.tsx opts VirtualGrid into
 * `measureVariableHeight`, verified 2026-07-18 against a SYNTHETIC 212px row
 * measuring a 213px slot).
 *
 * WI-5419 investigation established the fix was NOT yet deployed to :3070 at
 * report time (dev:pipeline_position / release:deploy showed the green pin
 * ~69 commits behind staging, so :3070 was almost certainly serving pre-fix
 * code) — the LIKELY primary cause. But the earlier verify used a short
 * synthetic row and never exercised REAL observation-body shapes, so this
 * spec closes that gap as the durable recurrence guard: it seeds a REAL
 * long-body shape (pulled 2026-07-19 from harness_shared.engineer_issues,
 * topic=papercusp-observation — a 750+-char body containing a genuinely
 * long UNBROKEN token, e.g. a pipe-delimited grep -E alternation with no
 * spaces) and asserts the expanded row shows the FULL body with no
 * vertical (virtualizer slot) or horizontal (unwrapped long-token) clipping.
 *
 * ⚠ THE STRUCTURE THIS GUARDED CHANGED ON 2026-09-07. The pane took Retain's
 * index + detail split (owner ask: "side panel like Retain"), so the body is
 * no longer rendered inside a virtualized row — the row is a fixed 30px index
 * entry and the full text lives in the detail aside. The virtualizer-slot
 * under-measurement that caused WI-5419 therefore has no subject any more; it
 * is designed out rather than fixed. This spec is KEPT because the other half
 * of the report — a long unbroken token overflowing its container, and a
 * container clipping its own text — is still possible in the aside, and that
 * is what it now measures.
 *
 * Why an e2e, not jsdom: jsdom performs no real layout (scrollHeight /
 * getBoundingClientRect always read 0), so it cannot detect a CSS overflow
 * clip or a virtualizer slot that undershoots real content height — only a
 * real browser engine can. Mirrors adv-work-items-filter.spec.ts's hermetic
 * route-stubbing pattern.
 *
 * Sync stubbing goes through `_sync-stub.ts` (the live per-query GET). This spec
 * used to stub `POST /api/zero-harness/rest-query-batch`, dead since 2026-07-26 —
 * the stub was never hit and the pane rendered from real traffic (WI-39533).
 */
import { test, expect, assertMounted, type Page } from './_egress';
import { stubSyncQueries, type SyncQueryStub } from './_sync-stub';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

// Fictional slug — valid because projects/lite is stubbed; hermetic because no
// real workspace harness is touched.
const SLUG = process.env.OBS_CLIP_E2E_SLUG ?? 'e2e-observations-clip-pot';

// A genuinely long, unbroken (no-space) token — a real shape pulled from
// harness_shared.engineer_issues (topic=papercusp-observation, 2026-07-19):
// a pipe-delimited grep -E alternation, 178 chars with zero whitespace.
const LONG_TOKEN =
  "'_components/chat|chat-cards|OperatorChat|OperatorConversation|ask_choice|ask-choice|voice|turn-answer|operator-converse|VoiceApp|brain-session|operator-mcp-tools|libs/flags/src'";

const BODY_HEAD =
  'Deploy-diff triage: git -C ~/papercupai-workspace/papercup-release diff --name-only OLD NEW | grep -iE ';
// A distinctive TAIL string after the long token — if this is missing from
// the rendered DOM (or scrolled/clipped out of the expanded row's painted
// box), the row is clipping real content, not just a synthetic short line.
const BODY_TAIL =
  ' — zero hits means carry verdicts and bump the baseline; any hit means re-ground via a fresh self-drive before trusting the prior verdict.';
const OBSERVATION_BODY = BODY_HEAD + LONG_TOKEN + BODY_TAIL;
const OBSERVATION_TITLE = 'Deploy-diff triage recipe (long-token real shape)';

const OBSERVATION_ROW = {
  id: 'obs-e2e-long-token-1',
  title: OBSERVATION_TITLE,
  body: OBSERVATION_BODY,
  kind: 'reinforce',
  scope: 'papercusp',
  confidence: 'high',
  refs: ['wi-5419'],
  sourceRole: 'su',
  createdAt: new Date().toISOString(),
};

const SKIP_MSG =
  'The /adv shell did not mount the Observations panel. Run against an HMR-enabled ' +
  'operator-vite (the config webServer boots one with PAPERCUSP_ENABLE_HMR=1) — a ' +
  "stale HMR-disabled :3055 serves a blank #root ('/@vite/client' noop stub).";

/**
 * The harness registry row for the fictional slug, served over BOTH paths that
 * carry it — the REST bootstrap (`/api/harness/projects/lite`) and the sync query
 * (`harnessProjects.lite`). Stubbing only one leaves the slug unresolvable on the
 * other and the pane never mounts.
 */
const PROJECTS = [
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
];

// The pane reads the row count off `_meta.total` on the first row.
const OBSERVATION_ROWS = [{ ...OBSERVATION_ROW, _meta: { total: 1 } }];

async function stubApis(page: Page): Promise<SyncQueryStub> {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: PROJECTS }),
    });
  });
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }),
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
      body: JSON.stringify({ agents: [] }),
    });
  });

  // Sync — the LIVE contract, one GET /api/zero-harness/rest-query per query
  // (see `_sync-stub.ts`). Only the queries this pane issues are modelled;
  // everything else returns `undefined` and FALLS THROUGH untouched. Answering
  // `[]` for unmodelled queries is the trap that starves the dock layout.
  return stubSyncQueries(page, (name) => {
    if (name === 'harnessProjects.lite') return PROJECTS;
    if (name === 'learning.observations') return OBSERVATION_ROWS;
    if (name === 'learning.observations.counts') return [{ kind: 'reinforce', count: 1 }];
    return undefined;
  });
}

test.describe('/adv Learning tab — Observations pane, real long-body row', () => {
  test('an expanded row with a real long-token body shows the FULL text — no vertical or horizontal clip', async ({
    page,
  }) => {
    const sync = await stubApis(page);

    const res = await page.goto(
      `${baseURL}/adv?tab=learning&lview=observations&slug=${SLUG}&scope=self`,
      { waitUntil: 'domcontentloaded' },
    );
    expect([200, 304]).toContain(res?.status() ?? 0);

    // Prove the stub is feeding the pane BEFORE the 30s mount wait below, so a
    // bypassed stub fails in seconds with a diagnostic instead of masquerading
    // as "the shell did not mount".
    await sync.waitForServed(['learning.observations']);

    const expandBtn = page.getByRole('button', {
      name: `Expand observation ${OBSERVATION_TITLE}`,
    });
    const mounted = await expandBtn
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    assertMounted(mounted, SKIP_MSG);

    await expandBtn.click();

    // The row is now "expanded" — its aria-label flips to Collapse.
    const collapseBtn = page.getByRole('button', {
      name: `Collapse observation ${OBSERVATION_TITLE}`,
    });
    await expect(collapseBtn).toBeVisible({ timeout: 10_000 });

    // The body lives in the DETAIL ASIDE now, not inside the row (owner ask
    // 2026-09-07: "side panel like Retain"). The row is a fixed 30px index
    // entry, so the virtualizer-slot half of this defect is STRUCTURALLY gone
    // rather than merely fixed — see the vertical-clip assertion below.
    const aside = page.getByRole('complementary', {
      name: 'Observation detail',
    });
    await expect(aside).toBeVisible({ timeout: 10_000 });
    const bodyEl = aside.locator('.pc-observations__body');
    await expect(bodyEl).toBeVisible();

    // 1. FULL TEXT PRESENT — the tail string after the long token must be in
    //    the DOM. If this is missing, the body is being truncated in JS/CSS
    //    (text-overflow:ellipsis path), not merely a virtualizer slot issue.
    await expect(bodyEl).toContainText(BODY_TAIL.trim());

    // 2. NO HORIZONTAL CLIP — the long unbroken token must WRAP
    //    (overflow-wrap:anywhere), not overflow the row / force a scrollbar.
    //    scrollWidth > clientWidth on the body element (or its row ancestor)
    //    means the token pushed content past the visible box instead of
    //    wrapping.
    const horizontalOverflow = await bodyEl.evaluate((el) => {
      const panel = el.closest('.pc-observations__detail') as HTMLElement | null;
      const target = panel ?? (el as HTMLElement);
      return target.scrollWidth - target.clientWidth;
    });
    expect(horizontalOverflow).toBeLessThanOrEqual(1); // 1px rounding slack

    // 3. NO VERTICAL CLIP — the aside must be at least as tall as the body it
    //    renders. This used to compare the virtualizer's absolutely-positioned
    //    row slot against the row's scrollHeight, because the body was drawn
    //    INSIDE a measured row: an under-measured slot let the next row paint
    //    over this one's tail, which was the reported "text cut off". The body
    //    is no longer in a virtualized slot at all, so that comparison has no
    //    subject — the guard now asserts the property that still has teeth,
    //    which is that the panel itself does not clip its own content.
    const clipping = await bodyEl.evaluate((el) => {
      const panel = el.closest('.pc-observations__detail') as HTMLElement | null;
      if (!panel) return { panelHeight: -1, contentHeight: -1 };
      return {
        panelHeight: panel.clientHeight,
        contentHeight: panel.scrollHeight,
      };
    });
    expect(clipping.panelHeight).toBeGreaterThan(0);
    expect(clipping.panelHeight).toBeGreaterThanOrEqual(clipping.contentHeight - 1);

    await page.screenshot({
      path: 'test-results/wi-5419-observations-long-body-expanded.png',
      fullPage: false,
    });

    // The falsifier for this spec's own hermeticity: a stub that was never
    // reached means every measurement above was taken on real, unstubbed rows.
    sync.assertServed('learning.observations');
  });
});
