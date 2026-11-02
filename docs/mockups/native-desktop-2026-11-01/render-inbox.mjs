import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const directory = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 1 });
const errors = [], network = [], captures = [], interactions = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (!request.url().startsWith('file:') && !request.url().startsWith('data:')) network.push(request.url());
});
const url = pathToFileURL(join(directory, 'inbox.html'));
url.searchParams.set('capture', '1');
try {
  await page.goto(url.href);
  await page.waitForFunction(() => Boolean(window.__inbox));
  await page.evaluate(() => document.fonts.ready);
  for (const layout of ['a', 'b', 'c']) {
    await page.evaluate(layout => window.__inbox.reset(layout), layout);
    await page.getByRole('radio', { name: /Badge only/ }).click();
    const replyActionVisible = await page.locator('[data-send]').evaluate(el => {
      const action = el.getBoundingClientRect();
      const viewport = el.closest('.queue,.focus-body').getBoundingClientRect();
      return action.top >= viewport.top && action.bottom <= viewport.bottom;
    });
    assert.ok(replyActionVisible, `${layout}: primary reply action must be visible without scrolling`);
    const file = `inbox-${layout}.png`;
    try {
      await page.locator('.panel').screenshot({ path: join(directory, file), animations: 'disabled' });
    } catch (error) {
      throw new Error(`Inbox screenshot failed for layout ${layout}; browserErrors=${JSON.stringify(errors)}`, { cause: error });
    }
    const geometry = await page.locator('.panel').evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    assert.ok(geometry.x >= 0 && geometry.y >= 32 && geometry.right <= 1440 && geometry.bottom <= 880, `${layout}: panel outside desktop`);
    assert.equal(geometry.scrollWidth, geometry.clientWidth, `${layout}: horizontal overflow`);
    captures.push({ layout, file, geometry });

    await page.getByRole('button', { name: /Send & next/ }).click();
    assert.equal(await page.evaluate(() => window.__inbox.get().done), 1);
    assert.equal(await page.evaluate(() => window.__inbox.get().pending), 3);
    await page.getByRole('status').filter({ hasText: 'nothing was sent' }).waitFor();
    interactions.push(`${layout}: quick answer advances queue and confirms sample-only save`);

    await page.getByRole('textbox', { name: 'Or write a reply' }).fill('Please show the preview after lunch.');
    await page.keyboard.press('Control+Enter');
    assert.equal(await page.evaluate(() => window.__inbox.get().done), 2);
    interactions.push(`${layout}: written reply with Ctrl+Enter advances queue`);

    await page.getByRole('button', { name: 'Snooze' }).click();
    assert.equal(await page.evaluate(() => window.__inbox.get().snoozed), 1);
    assert.equal(await page.evaluate(() => window.__inbox.get().pending), 1);
    interactions.push(`${layout}: snooze removes one sample question`);

    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__inbox.get().hidden), true);
    await page.keyboard.press('Control+Alt+i');
    assert.equal(await page.evaluate(() => window.__inbox.get().hidden), false);
    interactions.push(`${layout}: Escape dismisses; browser shortcut summons`);
  }
  await page.evaluate(() => window.__inbox.reset('b'));
  await page.getByRole('button', { name: 'Blocking only' }).click();
  assert.equal(await page.locator('.list-row').count(), 1);
  interactions.push('b: blocking filter retains only the blocking question');
  await page.evaluate(() => window.__inbox.reset('b'));
  await page.getByRole('button', { name: /Rowan.*Ready for/ }).click();
  assert.match(await page.locator('.detail h2').innerText(), /Ubuntu sidebar/);
  interactions.push('b: selecting a question changes the reading pane');

  const comparison = await browser.newPage({ viewport: { width: 1810, height: 1015 }, deviceScaleFactor: 1 });
  const tiles = [];
  for (const [layout, title, subtitle] of [
    ['a', 'A · Question stack', 'Small footprint · answer directly in each card'],
    ['b', 'B · Inbox + context', 'More context · scan the queue while replying'],
    ['c', 'C · Focus queue', 'One decision at a time · keep moving']
  ]) {
    const base64 = (await readFile(join(directory, `inbox-${layout}.png`))).toString('base64');
    tiles.push(`<section><h2>${title}</h2><p>${subtitle}</p><img alt="${title}" src="data:image/png;base64,${base64}"></section>`);
  }
  await comparison.setContent(`<html><head><style>*{box-sizing:border-box}body{margin:0;padding:28px;background:#f4f3ed;color:#29372e;font-family:Inter,Arial,sans-serif}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px}h1{font-size:25px;font-weight:550;letter-spacing:-.6px;margin:0}header span{font-size:12px;color:#73816b}main{display:grid;grid-template-columns:438px 824px 490px;gap:22px;transform:scale(.974);transform-origin:top left}h2{font-size:16px;font-weight:550;margin:0 0 7px}p{font-size:11px;color:#6a7b63;margin:0 0 17px}img{display:block;width:100%;border-radius:8px;box-shadow:0 6px 22px #25331f19}footer{font-size:11px;color:#72826b;margin-top:6px}</style></head><body><header><h1>Workbench / Inbox</h1><span>Same question. Three ways to answer. · Native sidebar design study</span></header><main>${tiles.join('')}</main><footer>Illustrative questions · local interactions only · no live replies or OS shortcut registration</footer></body></html>`);
  await comparison.screenshot({ path: join(directory, 'compare-inbox.png'), animations: 'disabled' });
  captures.push({ file: 'compare-inbox.png', comparison: true });
  await comparison.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  const verification = { capturedAt: new Date().toISOString(), purpose: 'Visual mockup and sample interaction verification; not native product acceptance.', captures, interactions, browserErrors: errors, externalRequests: network };
  await writeFile(join(directory, 'inbox-verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify({ captures: captures.length, interactions: interactions.length, browserErrors: errors, externalRequests: network.length }));
} finally {
  await browser.close();
}
