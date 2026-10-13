import { test, expect, type BrowserContext } from './_egress';
import type { HydratedRelease } from '../lib/release/release-history-page';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test.use({ channel: 'chrome' });
const origin = 'https://downloads.papercusp.test';
const sha = 'a'.repeat(64);
const products = [
  { product: 'server' as const, platform: 'linux-x86_64', name: 'server.deb' },
  { product: 'gui' as const, platform: 'linux-x86_64', name: 'desktop.deb' },
  { product: 'mobile' as const, platform: 'android-universal', name: 'android.apk' },
  { product: 'mobile' as const, platform: 'ios-arm64', name: 'iphone.ipa' },
];
const release: HydratedRelease = {
  row: { version: '0.0.25', channel: 'alpha', cutAt: new Date('2026-10-12T00:00:00Z'),
    publishedAt: null, gitSha: 'b'.repeat(40), cutBy: 'test', notes: null,
    changelogMd: '', workItemIds: [], planSlugs: [],
    artifacts: products.map(a => ({ ...a, url: `release/${a.name}`, size: 1000, sha256: sha })) },
  items: [], plans: [], internalCount: 0,
};
// The app's renderer is CommonJS TS, while this Playwright worker is ESM.
// Use the existing TSX entry loader to generate the exact producer's bytes;
// changing the production module format just for this fixture would hide drift.
const root = resolve(import.meta.dirname, '../../..');
const html = execFileSync(resolve(root, 'node_modules/.bin/tsx'), ['-e', `
  const { renderIndexHtml } = require(${JSON.stringify(resolve(root, 'apps/operator/lib/release/release-history-page.ts'))});
  const release = ${JSON.stringify(release)};
  release.row.cutAt = new Date(release.row.cutAt);
  process.stdout.write(renderIndexHtml([release], { generatedAt: new Date('2026-10-12T00:00:00Z'), analytics: null, redact: [] }));
`], { cwd: root, encoding: 'utf8', timeout: 20_000 });

async function serve(context: BrowserContext, malicious = false, mac = false) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/pui/latest.json') return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ artifacts: { ...(mac ? Object.fromEntries(['macos-aarch64', 'macos-x86_64'].map(target => [target,
        { target, version: '0.1.0', archiveSha256: sha, archiveUrl: `${origin}/pui/0.1.0/pui-0.1.0-${target}.tar.gz` }])) : {}),
        'linux-x86_64': { target: 'linux-x86_64', version: '0.1.0',
        archiveSha256: sha, archiveUrl: malicious ? 'https://other.test/wrong.tar.gz'
          : `${origin}/pui/0.1.0/pui-0.1.0-linux-x86_64.tar.gz` } } }) });
    if (url.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: html });
    return route.fulfill({ status: 404, body: '' });
  });
}

for (const width of [1440, 390]) test(`five download products work by menu and keyboard at ${width}px`, async ({ context, page }, info) => {
  await serve(context);
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/index.html`);
  for (const [id, name] of [['server', 'Desktop Server'], ['gui', 'Desktop GUI'],
    ['psu', 'PSU + PUI'], ['android', 'Android'], ['iphone', 'iPhone']]) {
    await page.locator(`label[for="choose-${id}"]`).click();
    await expect(page.getByRole('radio', { name, exact: true })).toBeChecked();
    await expect(page.locator(`#download-${id}`)).toBeVisible();
    await expect(page.locator('.download-panel:visible')).toHaveCount(1);
    if (id !== 'server') {
      await expect(page.getByRole('link', { name: 'server.deb', exact: true })).toHaveCount(0);
      await expect(page.locator('#instructions-body')).toBeHidden();
    }
  }
  await page.locator('#choose-gui').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'PSU + PUI', exact: true })).toBeChecked();
  await expect(page.getByRole('link', { name: /Download Linux x86_64.*PSU \+ PUI/ })).toHaveAttribute('href',
    `${origin}/pui/0.1.0/pui-0.1.0-linux-x86_64.tar.gz`);
  await expect(page.getByRole('link', { name: /Download Windows \(WSL2\).*PSU \+ PUI/ })).toHaveAttribute('href',
    `${origin}/pui/0.1.0/pui-0.1.0-linux-x86_64.tar.gz`);
  await expect(page.getByText('Uses the same download as Linux.', { exact: true })).toBeVisible();
  await expect(page.getByText('Apple Silicon: no verified standalone download is published yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('PSU and PUI are included.', { exact: false })).toBeVisible();
  const geometry = await page.evaluate(() => ({ viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('.product-downloads *')].filter(el =>
      el.getBoundingClientRect().right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1)
      .map(el => ({ element: el.id || el.className || el.tagName, width: el.clientWidth,
        scrollWidth: el.scrollWidth, text: el.textContent?.slice(0, 140) })) }));
  await info.attach('download-layout', { contentType: 'application/json', body: Buffer.from(JSON.stringify(geometry)) });
  console.log('DOWNLOAD_LAYOUT', JSON.stringify(geometry));
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath(`downloads-${width}.png`), fullPage: true });
});

test('verified macOS packages replace only their unavailable platform messages', async ({ context, page }) => {
  await serve(context, false, true);
  await page.goto(`${origin}/index.html#download-psu`);
  for (const [name, target] of [['macOS Apple Silicon', 'macos-aarch64'], ['macOS Intel', 'macos-x86_64']]) {
    await expect(page.getByRole('link', { name: `Download ${name} — PSU + PUI 0.1.0`, exact: true })).toHaveAttribute('href',
      `${origin}/pui/0.1.0/pui-0.1.0-${target}.tar.gz`);
  }
  await expect(page.locator('#psu-mac-arm')).not.toContainText('not published');
  await expect(page.locator('#psu-mac-intel')).not.toContainText('not published');
});

test('an unexpected PUI archive origin retains the ordinary download link', async ({ context, page }) => {
  await serve(context, true);
  await page.goto(`${origin}/index.html#download-psu`);
  await expect(page.getByRole('radio', { name: 'PSU + PUI', exact: true })).toBeChecked();
  await expect(page.getByRole('link', { name: 'Download PSU bundled with PUI' })).toHaveAttribute('href', 'pui/index.html');
  await expect(page.locator('a[href="https://other.test/wrong.tar.gz"]')).toHaveCount(0);
});

test('native product tabs and published links work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await serve(context);
    const page = await context.newPage();
    await page.goto(`${origin}/index.html`);
    await page.locator('label[for="choose-server"]').click();
    await expect(page.locator('#download-server')).toBeVisible();
    await expect(page.getByRole('link', { name: 'server.deb', exact: true }).first()).toBeVisible();
    await page.locator('label[for="choose-psu"]').click();
    await expect(page.getByRole('link', { name: 'Download PSU bundled with PUI' })).toBeVisible();
  } finally { await context.close(); }
});
