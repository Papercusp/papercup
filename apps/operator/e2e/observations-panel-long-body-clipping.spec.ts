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
 * Why an e2e, not jsdom: jsdom performs no real layout (scrollHeight /
 * getBoundingClientRect always read 0), so it cannot detect a CSS overflow
 * clip or a virtualizer slot that undershoots real content height — only a
 * real browser engine can. Mirrors adv-work-items-filter.spec.ts's hermetic
 * route-stubbing pattern.
 */
import { test, expect, assertMounted, type Page } from './_egress';

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

  // The sync batch contract: POST /api/zero-harness/rest-query-batch with
  // body { queries: [{ name, args }] } -> { results: [{ rows, version }] }.
  // Only the two queries ObservationsPanel issues get real rows; everything
  // else (other tabs' background queries) gets an empty, benign result.
  await page.route('**/api/zero-harness/rest-query-batch**', async (route) => {
    const post = route.request().postDataJSON() as
      | { queries?: Array<{ name?: string; args?: unknown }> }
      | null;
    const queries = post?.queries ?? [];
    const results = queries.map((q) => {
      if (q.name === 'learning.observations') {
        const rows = [OBSERVATION_ROW] as Array<Record<string, unknown>>;
        (rows[0] as Record<string, unknown> & { _meta?: unknown })._meta = { total: 1 };
        return { rows, version: String(Date.now()) };
      }
      if (q.name === 'learning.observations.counts') {
        return { rows: [{ kind: 'reinforce', count: 1 }], version: String(Date.now()) };
      }
      return { rows: [], version: String(Date.now()) };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results }),
    });
  });
}

test.describe('/adv Learning tab — Observations pane, real long-body row', () => {
  test('an expanded row with a real long-token body shows the FULL text — no vertical or horizontal clip', async ({
    page,
  }) => {
    await stubApis(page);

    const res = await page.goto(
      `${baseURL}/adv?tab=learning&lview=observations&slug=${SLUG}&scope=self`,
      { waitUntil: 'domcontentloaded' },
    );
    expect([200, 304]).toContain(res?.status() ?? 0);

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

    const bodyEl = collapseBtn.locator('.pc-observations__body');
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
      const row = el.closest('[role="row"]') as HTMLElement | null;
      const target = row ?? (el as HTMLElement);
      return target.scrollWidth - target.clientWidth;
    });
    expect(horizontalOverflow).toBeLessThanOrEqual(1); // 1px rounding slack

    // 3. NO VERTICAL CLIP — the virtualizer's absolutely-positioned row slot
    //    (data-index ancestor) must be at least as tall as the actual
    //    rendered content (BodyRow's real scrollHeight). If the slot is
    //    shorter, `measureVariableHeight`/measureElement under-measured this
    //    real content shape and the next row will paint over the tail of
    //    this one — the exact "text cut off" symptom.
    const clipping = await bodyEl.evaluate((el) => {
      const slot = el.closest('[data-index]') as HTMLElement | null;
      const bodyRow = el.closest('[role="row"]') as HTMLElement | null;
      if (!slot || !bodyRow) return { slotHeight: -1, contentHeight: -1 };
      return {
        slotHeight: slot.getBoundingClientRect().height,
        contentHeight: bodyRow.scrollHeight,
      };
    });
    expect(clipping.slotHeight).toBeGreaterThan(0);
    expect(clipping.slotHeight).toBeGreaterThanOrEqual(clipping.contentHeight - 1);

    await page.screenshot({
      path: 'test-results/wi-5419-observations-long-body-expanded.png',
      fullPage: false,
    });
  });
});
