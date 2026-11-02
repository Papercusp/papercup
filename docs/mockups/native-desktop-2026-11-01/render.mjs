import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';

const directory = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 1 });
const errors = [];
const network = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (!request.url().startsWith('file:') && !request.url().startsWith('data:')) network.push(request.url());
});
const url = pathToFileURL(join(directory, 'index.html'));
url.searchParams.set('capture', '1');
await page.goto(url.href);
await page.waitForFunction(() => Boolean(window.__mockup));
await page.evaluate(() => document.fonts.ready);
const captures = [];
try {
  for (const direction of ['a', 'b', 'c']) {
    for (const surface of ['launcher', 'terminal', 'organizer', 'chat', 'accounts', 'overview']) {
      await page.evaluate(({ direction, surface }) => window.__mockup.set(direction, surface), { direction, surface });
      await page.screenshot({ path: join(directory, `${direction}-${surface}.png`), animations: 'disabled' });
      const bounds = await page.evaluate(() => [...document.querySelectorAll('#stage > .window, #stage > .wing')].map(element => {
        const rect = element.getBoundingClientRect();
        return { title: element.querySelector('.titlebar,.wing-title')?.textContent?.trim() || 'Panel', left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      }));
      captures.push({ direction, surface, file: `${direction}-${surface}.png`, bounds });
    }
  }
  for (const platform of ['ubuntu', 'mac', 'windows']) {
    await page.evaluate(platform => window.__mockup.set('a', 'chat', platform), platform);
    await page.screenshot({ path: join(directory, `platform-${platform}.png`), animations: 'disabled' });
    captures.push({ platform, surface: 'chat', file: `platform-${platform}.png` });
  }
  const overflow = captures.flatMap(capture => (capture.bounds || []).filter(rect => rect.left < 0 || rect.top < 32 || rect.right > 1440 || rect.bottom > 880).map(rect => ({ file: capture.file, ...rect })));
  const verification = { capturedAt: new Date().toISOString(), viewport: { width: 1440, height: 880 }, captures, browserErrors: errors, networkRequests: network, windowOverflow: overflow, purpose: 'Visual mockup rendering; not production native integration acceptance.' };
  await writeFile(join(directory, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify({ captures: captures.length, browserErrors: errors, networkRequests: network.length, windowOverflow: overflow }));
  if (errors.length || network.length || overflow.length) process.exitCode = 1;
} finally {
  await browser.close();
}
