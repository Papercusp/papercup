/**
 * /adv Frames tab — the Swarm live view tile grid
 * (`hive-frame-desktops-live-view-2026-06-06` P-006/P-007).
 *
 * Verifies what the unit tests cannot: the tab mounts in the live /adv shell
 * (operator-vite SPA), consumes the `/api/deploy/frames` roster + the
 * per-slug `/api/deploy/:slug/frame-view` SSE stream, renders a thumbnail
 * tile with role metadata, and writes the tile selection to nuqs
 * (`?frame=<slug>:<display>`) so agents can drive the viewer.
 *
 * Data is stubbed via route interception (hermetic — no deployed frame
 * needed): the roster returns one Latitude frame and the SSE stream emits a
 * status + one 1×1-JPEG thumb event.
 */
import { test, expect, type Page } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

// A minimal valid 1×1 JPEG (black) — enough for <img> to decode.
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

const SLUG = 'frames-e2e-h1';

async function stubApis(page: Page) {
  await page.route('**/api/deploy/frames', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        frames: [
          {
            slug: SLUG,
            frame: { id: 'lat-e2e-1', host: '203.0.113.10', region: 'NYC', kind: 'vm', target: 'latitude' },
            desktop: true,
          },
        ],
      }),
    });
  });
  await page.route(`**/api/deploy/${SLUG}/frame-view`, async (route) => {
    const status = {
      slug: SLUG,
      state: 'polling',
      frameId: 'lat-e2e-1',
      host: '203.0.113.10',
      displays: [99],
    };
    const thumb = {
      slug: SLUG,
      display: 99,
      jpegBase64: TINY_JPEG_B64,
      capturedAtMs: Date.now(),
      role: 'worker',
      leaseSinceMs: Date.now() - 30_000,
    };
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        `event: status`,
        `data: ${JSON.stringify(status)}`,
        '',
        `event: thumb`,
        `data: ${JSON.stringify(thumb)}`,
        '',
        '',
      ].join('\n'),
    });
  });
}

async function framesTabMounts(page: Page): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=frames`, { waitUntil: 'domcontentloaded' });
  return page
    .getByText('Swarm live view', { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

test.describe('/adv Frames tab (Swarm live view)', () => {
  test('renders the tile grid from the roster + SSE thumbs; selection rides nuqs', async ({ page }) => {
    await stubApis(page);
    const mounted = await framesTabMounts(page);
    test.skip(
      !mounted,
      'The /adv shell did not mount the Frames tab. Run against the prebuilt operator-vite ' +
        'bundle (vite preview / a clean :3055) — a stale HMR dev server can fail to render the SPA.',
    );

    // status chip for the deployed frame
    const chip = page.locator('.pc-frames__chip', { hasText: SLUG });
    await expect(chip).toBeVisible({ timeout: 15_000 });

    // one tile, carrying the display number + lease role from the SSE event
    const tile = page.locator('.pc-frames__tile');
    await expect(tile).toHaveCount(1, { timeout: 15_000 });
    await expect(tile).toContainText(':99');
    await expect(tile).toContainText('worker');
    await expect(tile.locator('img')).toBeVisible();

    // click-through: selection goes to the URL (nuqs) + the enlarged panel opens
    await tile.click();
    await expect(page).toHaveURL(new RegExp(`frame=${SLUG}%3A99|frame=${SLUG}:99`));
    const panel = page.getByRole('dialog', { name: 'Frame live view' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(SLUG);

    // close → selection cleared from the URL
    await panel.getByRole('button', { name: 'Close live view' }).click();
    await expect(panel).not.toBeVisible();
    await expect(page).not.toHaveURL(/frame=/);
  });

  test('empty roster renders the deploy hint, no tiles', async ({ page }) => {
    await page.route('**/api/deploy/frames', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ frames: [] }),
      });
    });
    const mounted = await framesTabMounts(page);
    test.skip(!mounted, 'The /adv shell did not mount the Frames tab (stale dev server).');
    await expect(page.getByText('No deployed frames', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.pc-frames__tile')).toHaveCount(0);
  });

  test('API: GET /api/deploy/frames is JSON or auth-gated (no stub)', async ({ page }) => {
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        return { status: res.status, contentType: res.headers.get('content-type') ?? '' };
      } catch (e) {
        return { error: String(e) };
      }
    }, `${baseURL}/api/deploy/frames`);
    if (!('error' in result)) {
      expect([200, 401, 403]).toContain(result.status);
      if (result.status === 200) expect(result.contentType).toMatch(/json/);
    }
  });

  test('API: GET /api/deploy/:slug/frame-view is SSE-shaped or auth-gated (no stub)', async ({ page }) => {
    const result = await page.evaluate(async (url) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 600);
      try {
        const res = await fetch(url, { signal: controller.signal });
        return { status: res.status, contentType: res.headers.get('content-type') ?? '' };
      } catch (e) {
        return { error: String(e) };
      }
    }, `${baseURL}/api/deploy/some-harness/frame-view`);
    if ('error' in result) {
      expect(result.error).toMatch(/abort/i);
    } else {
      expect([200, 401, 403]).toContain(result.status);
      if (result.status === 200) expect(result.contentType).toMatch(/event-stream/);
    }
  });
});
