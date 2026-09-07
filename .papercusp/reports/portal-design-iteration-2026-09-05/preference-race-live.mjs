import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const out = path.dirname(new URL(import.meta.url).pathname);
const releaseFile = '/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/.portal-runtime/portal/current/.papercusp-release.json';
const result = { startedAt: new Date().toISOString(), release: JSON.parse(fs.readFileSync(releaseFile, 'utf8')), plane: 'browser fixture: only a real apps response is delayed; all response bodies unchanged', cases: [] };
const priorPath = path.join(out, 'preference-race-live.json');
if (fs.existsSync(priorPath)) {
  const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'));
  result.previousAttempts = [...(prior.previousAttempts ?? []), { startedAt: prior.startedAt, completedAt: prior.completedAt, cases: prior.cases, preferencesRestored: prior.preferencesRestored, note: 'Initial saved probe waited for retired .rail-app; it recorded no verdict.' }];
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let original;
try {
  await page.goto('http://127.0.0.1:3081/?app=home', { waitUntil: 'domcontentloaded' });
  original = await page.evaluate(() => fetch('/api/preferences').then(r => r.json()));
  for (const target of ['light', 'dark']) {
    const startingTheme = target === 'light' ? 'dark' : 'light';
    await page.evaluate(theme => fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) }), startingTheme);
    let releaseRead;
    const gate = new Promise(resolve => { releaseRead = resolve; });
    let held = false;
    await page.route('**/api/apps', async route => {
      const response = await route.fetch();
      if (!held) { held = true; await gate; }
      await route.fulfill({ response });
    });
    try {
      const preferencesRead = page.waitForResponse(r => new URL(r.url()).pathname === '/api/preferences' && r.request().method() === 'GET');
      await page.goto('http://127.0.0.1:3081/?app=home', { waitUntil: 'domcontentloaded' });
      const read = await (await preferencesRead).json();
      await page.locator('.portal-theme-switcher').waitFor();
      await page.evaluate(() => {
        window.themeEvents = [];
        new MutationObserver(() => window.themeEvents.push({ at: Date.now(), theme: document.documentElement.dataset.theme })).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      });
      await page.locator('.portal-theme-switcher').getByRole('button', { name: target === 'light' ? 'Light' : 'Dark', exact: true }).click();
      await page.waitForFunction(async theme => document.documentElement.dataset.theme === theme && (await fetch('/api/preferences').then(r => r.json())).preferences.theme === theme, target);
      const before = await page.evaluate(() => document.documentElement.dataset.theme);
      releaseRead();
      await page.waitForFunction(() => document.querySelectorAll('.rail-apps .rail-item').length > 3);
      await page.waitForTimeout(1200);
      const after = await page.evaluate(async () => ({ theme: document.documentElement.dataset.theme, stored: (await fetch('/api/preferences').then(r => r.json())).preferences.theme, events: window.themeEvents }));
      const pass = read.preferences.theme === startingTheme && before === target && after.theme === target && after.stored === target && after.events.every(event => event.theme === target);
      result.cases.push({ target, startingTheme, snapshotTheme: read.preferences.theme, before, after, result: pass ? 'pass' : 'fail' });
    } finally { releaseRead(); await page.unroute('**/api/apps'); }
  }
} finally {
  if (original) {
    await page.evaluate(theme => fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) }), original.preferences.theme);
    await page.goto('http://127.0.0.1:3081/?app=home&accountsPane=false&chatPane=false', { waitUntil: 'domcontentloaded' });
    const final = await page.evaluate(() => fetch('/api/preferences').then(r => r.json()));
    result.initial = original.preferences; result.final = final.preferences;
    result.preferencesRestored = JSON.stringify(original.preferences) === JSON.stringify(final.preferences);
  }
  result.releaseStable = JSON.parse(fs.readFileSync(releaseFile, 'utf8')).release === result.release.release;
  result.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'preference-race-live.json'), JSON.stringify(result, null, 2) + '\n');
  await browser.close();
  console.log(JSON.stringify(result));
  if (result.cases.length !== 2 || result.cases.some(row => row.result !== 'pass') || !result.preferencesRestored || !result.releaseStable) process.exitCode = 1;
}
