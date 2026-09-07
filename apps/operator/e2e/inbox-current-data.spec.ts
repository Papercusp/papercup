/**
 * Resolution Inbox — current-build data acceptance probe.
 *
 * The layout/state suite in inbox-aside-states.spec.ts is intentionally
 * hermetic. This separate opt-in probe covers the contract that suite cannot:
 * plans.attention must come from the standing current-build server, and a real
 * row must paint its four list-carried actions no later than one second after
 * the click at both owner-required viewports.
 *
 * Run against staging/current-build:
 *
 *   INBOX_P005_REAL_DATA=1 \
 *   INBOX_P005_CAPTURE_DIR=<empty-dir> \
 *   OPERATOR_E2E_PORT=3955 \
 *   PAPERCUSP_API_TARGET=http://127.0.0.1:3170 \
 *   npx playwright test e2e/inbox-current-data.spec.ts
 *
 * Only feature flags are pinned. This file never installs a rest-query route;
 * the plans.attention response asserted below is therefore the server's own
 * current workspace data rather than _inbox-fixture rows.
 */
import { join } from "node:path";
import { test, expect, type Page } from "./_egress";
import { stubInboxFlags } from "./_inbox-fixture";

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  "http://127.0.0.1:" +
    String(Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055);

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1600, height: 1020 },
] as const;

async function installPaneTimingProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.documentElement;
    delete root.dataset.inboxRealClickAt;
    delete root.dataset.inboxRealPaneAt;
    delete root.dataset.inboxRealActionsAt;
    delete root.dataset.inboxRealLoadingAfterPane;

    const sample = () => {
      const now = performance.now();
      const pane = document.querySelector('[data-testid="inbox-detail-title"]');
      if (pane && root.dataset.inboxRealPaneAt == null) {
        root.dataset.inboxRealPaneAt = String(now);
      }
      const loading = document.querySelector(
        '[data-testid="detail-actions-loading"]',
      );
      if (pane && loading) {
        root.dataset.inboxRealLoadingAfterPane = "true";
      }
      const actions = document.querySelectorAll(
        ".op-inbox--split .pc-items__detail-actions .pc-items__action",
      );
      if (actions.length === 4 && root.dataset.inboxRealActionsAt == null) {
        root.dataset.inboxRealActionsAt = String(now);
      }
    };

    new MutationObserver(sample).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    sample();
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}×${viewport.height} current data`, () => {
    test.use({ viewport });

    test("opens a real attention row with four immediate actions in under one second", async ({
      page,
    }) => {
      test.skip(
        process.env.INBOX_P005_REAL_DATA !== "1",
        "opt in explicitly: this probe requires the standing current-build workspace data",
      );
      test.setTimeout(120_000);
      await stubInboxFlags(page);

      const attentionResponse = page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "GET" &&
            url.pathname === "/api/zero-harness/rest-query" &&
            url.searchParams.get("name") === "plans.attention"
          );
        },
        { timeout: 60_000 },
      );
      const response = await page.goto(
        baseURL + "/inbox?portalEmbed=1&portalTheme=dark&opci=all",
        { waitUntil: "domcontentloaded", timeout: 60_000 },
      );
      expect([200, 304]).toContain(response?.status() ?? 0);

      const attention = await attentionResponse;
      expect(attention.status()).toBe(200);
      const payload = (await attention.json()) as {
        rows?: Array<{
          items?: Array<{ id?: string; actions?: unknown[] }>;
        }>;
      };
      expect(Array.isArray(payload.rows)).toBe(true);
      expect(payload.rows?.length ?? 0).toBeGreaterThan(0);

      const row = page.locator('[data-testid^="inbox-row-"]').first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      const selectedTestId = await row.getAttribute("data-testid");
      expect(selectedTestId).toMatch(/^inbox-row-.+/);
      const selectedId = selectedTestId!.slice("inbox-row-".length);
      const selectedFeedItem = payload.rows
        ?.flatMap((group) => group.items ?? [])
        .find((item) => item.id === selectedId);
      expect(selectedFeedItem).toBeTruthy();
      expect(selectedFeedItem?.actions).toHaveLength(4);

      await installPaneTimingProbe(page);
      await row.evaluate((element) => {
        element.addEventListener(
          "click",
          () => {
            document.documentElement.dataset.inboxRealClickAt = String(
              performance.now(),
            );
          },
          { capture: true, once: true },
        );
      });

      await row.click();
      await expect(page.getByTestId("inbox-detail-title")).toBeVisible();
      const actions = page.locator(
        ".op-inbox--split .pc-items__detail-actions .pc-items__action",
      );
      await expect(actions).toHaveCount(4);

      const timing = await page.evaluate(() => {
        const data = document.documentElement.dataset;
        const clickAt = Number(data.inboxRealClickAt);
        const paneAt = Number(data.inboxRealPaneAt);
        const actionsAt = Number(data.inboxRealActionsAt);
        return {
          clickAt,
          paneAt,
          actionsAt,
          clickToActionsMs: actionsAt - clickAt,
          actionsAfterPaneMs: actionsAt - paneAt,
          loadingAfterPane: data.inboxRealLoadingAfterPane === "true",
        };
      });
      expect(Number.isFinite(timing.clickAt)).toBe(true);
      expect(Number.isFinite(timing.paneAt)).toBe(true);
      expect(Number.isFinite(timing.actionsAt)).toBe(true);
      expect(timing.clickToActionsMs).toBeGreaterThanOrEqual(0);
      expect(timing.clickToActionsMs).toBeLessThanOrEqual(1_000);
      expect(timing.actionsAfterPaneMs).toBeLessThanOrEqual(0);
      expect(timing.loadingAfterPane).toBe(false);
      await expect(page.getByTestId("detail-actions-loading")).toHaveCount(0);

      const reading = await page.evaluate(() => {
        const body = document.querySelector(".op-inbox__detail-copy");
        if (!(body instanceof HTMLElement)) {
          throw new Error("missing item-open body copy");
        }
        const factValue = body.querySelector(".op-inbox__detail-fact dd");
        const readable =
          factValue instanceof HTMLElement
            ? factValue
            : body.querySelector("p") instanceof HTMLElement
              ? body.querySelector("p")
              : body;
        return {
          bodyWidth: body.getBoundingClientRect().width,
          readableWidth: readable!.getBoundingClientRect().width,
        };
      });
      expect(reading.bodyWidth).toBeGreaterThanOrEqual(300);
      expect(reading.readableWidth / reading.bodyWidth).toBeGreaterThanOrEqual(
        0.5,
      );

      const captureDir = process.env.INBOX_P005_CAPTURE_DIR;
      if (captureDir) {
        await page.screenshot({
          path: join(
            captureDir,
            `inbox-p005-real-${viewport.width}x${viewport.height}-selected.png`,
          ),
        });
      }
    });
  });
}
