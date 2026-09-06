#!/usr/bin/env node

/**
 * Real-data measurement for inbox-item-open-spec-parity P-003.
 *
 * Run against the staging sidecar:
 *   node scratchpad/inbox-item-open-actions-latency.mjs http://127.0.0.1:3955
 *
 * Run the same script against a desktop-exposed operator URL by passing that
 * URL as argv[2] (or OPERATOR_URL). The script searches visible inbox rows for
 * one carrying four actions, records the click-to-action time and any observed
 * plans.attentionItem request round-trip, then proves the strip stays one row
 * inside the body measure at 1280×720 and 1600×1020.
 */
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";

const baseURL = (
  process.env.OPERATOR_URL ??
  process.argv[2] ??
  "http://127.0.0.1:3955"
).replace(/\/$/, "");
const viewports = [
  { width: 1280, height: 720 },
  { width: 1600, height: 1020 },
];

const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const measurements = [];

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    const detailStarts = new Map();
    const detailRoundTrips = [];

    page.on("request", (request) => {
      const payload = request.postData() ?? "";
      if (
        request.url().includes("attentionItem") ||
        payload.includes("plans.attentionItem")
      ) {
        detailStarts.set(request, performance.now());
      }
    });
    page.on("requestfinished", (request) => {
      const started = detailStarts.get(request);
      if (started !== undefined) {
        detailRoundTrips.push(performance.now() - started);
      }
    });

    const response = await page.goto(
      `${baseURL}/inbox?portalEmbed=1&portalTheme=dark`,
      { waitUntil: "domcontentloaded", timeout: 120_000 },
    );
    if (![200, 304].includes(response?.status() ?? 0)) {
      throw new Error(`inbox navigation failed at ${baseURL}: ${response?.status()}`);
    }

    const rows = page.locator(".op-inbox__rowbtn");
    await rows.first().waitFor({ state: "visible", timeout: 30_000 });
    const rowCount = Math.min(await rows.count(), 40);
    let selected = null;

    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      const rowTestId = await row.getAttribute("data-testid");
      const started = performance.now();
      await row.click();
      const loadingAtPaint = await page
        .getByTestId("detail-actions-loading")
        .isVisible()
        .catch(() => false);

      let actionCount = 0;
      while (performance.now() - started <= 1_000) {
        actionCount = await page.locator(".op-inbox__aside .pc-items__action").count();
        if (actionCount === 4) break;
        await page.waitForTimeout(20);
      }
      if (actionCount !== 4) continue;

      const actionsReadyMs = performance.now() - started;
      if (actionsReadyMs < 1_050) {
        await page.waitForTimeout(1_050 - actionsReadyMs);
      }
      const geometry = await page.evaluate(() => {
        const q = (selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) {
            throw new Error(`missing ${selector}`);
          }
          return element;
        };
        const rect = (element) => element.getBoundingClientRect();
        const card = q(".op-inbox__aside .pc-items__detail");
        const group = q(".op-inbox__aside .pc-items__detail-actions");
        const buttons = Array.from(group.querySelectorAll(".pc-items__action"));
        const tops = buttons.map((button) => rect(button).top);
        const cardRect = rect(card);
        const groupRect = rect(group);
        return {
          actionCount: buttons.length,
          labels: buttons.map((button) => button.textContent?.trim() ?? ""),
          topSpreadPx: Math.max(...tops) - Math.min(...tops),
          insideMeasure:
            groupRect.left >= cardRect.left - 0.5 &&
            groupRect.right <= cardRect.right + 0.5,
          loadingAfterOneSecond: Boolean(
            document.querySelector('[data-testid="detail-actions-loading"]'),
          ),
        };
      });
      selected = {
        viewport,
        rowTestId,
        actionsReadyMs: Math.round(actionsReadyMs * 10) / 10,
        loadingAtPaint,
        detailRoundTripMs:
          detailRoundTrips.length > 0
            ? Math.round(detailRoundTrips.at(-1) * 10) / 10
            : null,
        ...geometry,
      };
      break;
    }

    await page.close();
    if (!selected) {
      throw new Error(
        `no four-action inbox row found within one second at ${viewport.width}x${viewport.height}`,
      );
    }
    if (
      selected.actionsReadyMs > 1_000 ||
      selected.loadingAtPaint ||
      selected.topSpreadPx > 1 ||
      !selected.insideMeasure ||
      selected.loadingAfterOneSecond
    ) {
      throw new Error(`P-003 measurement failed: ${JSON.stringify(selected)}`);
    }
    measurements.push(selected);
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ baseURL, measurements }, null, 2));
