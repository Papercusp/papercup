import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const out = path.dirname(new URL(import.meta.url).pathname);
const releaseFile = '/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/.portal-runtime/portal/current/.papercusp-release.json';
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const result = { schemaVersion: 1, startedAt: new Date().toISOString(), release, process: [], reads: [], phone: {
  result: 'unexercised',
  reason: 'The live idle and scheduled views have no disabled control. Source disables mute while a call connects, hangup while ending, incoming/screening actions while writes are pending, and Create invite while saving. Acceptance forbids calling, sending, launching and other decision actions. No such action or injected phone state was used.',
  source: 'phone-app/packages/ui/src/index.tsx',
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync('/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app/packages/ui/src/index.tsx')).digest('hex'),
} };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pendingReads = new Set();
let original;
const save = () => fs.writeFileSync(path.join(out, 'state-proofs.json'), JSON.stringify(result, null, 2) + '\n');
const extract = (body, depth = 0) => {
  if (!body || typeof body !== 'object' || depth > 6) return null;
  if (body.summary && Array.isArray(body.rows)) return {
    ledgerTotal: body.summary.total, rows: body.rows.length,
    scanned: body.live?.scan?.processes ?? null,
    degraded: body.live?.degraded ?? null,
    degradedReason: body.live?.degradedReason ?? null,
    scan: body.live?.scan ?? null,
    timestamp: body.generatedAt ?? body.sampledAt ?? body.updatedAt ?? null,
  };
  for (const value of Object.values(body)) {
    const found = extract(value, depth + 1);
    if (found) return found;
  }
  return null;
};
page.on('response', response => {
  const url = new URL(response.url());
  if (!url.pathname.includes('sync')) return;
  const request = response.request();
  const task = (async () => {
    let inventory = null;
    try { inventory = extract(await response.json()); } catch { /* Streaming responses have no JSON body. */ }
    result.reads.push({ at: new Date().toISOString(), path: url.pathname, status: response.status(), method: request.method(), inventory, inventoryRequest: (request.postData() ?? '').includes('taskManager.inventory') });
  })();
  pendingReads.add(task);
  void task.finally(() => pendingReads.delete(task));
});
try {
  await page.goto('http://127.0.0.1:3081/?app=home&accountsPane=false&chatPane=false', { waitUntil: 'domcontentloaded' });
  await page.locator('.portal-theme-switcher').waitFor();
  original = await page.evaluate(() => fetch('/api/preferences').then(r => r.json()));
  result.initial = { url: page.url(), preferences: original.preferences };
  for (const theme of ['light', 'dark']) {
    await page.locator('.portal-theme-switcher').getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await page.waitForFunction(async expected => document.documentElement.dataset.theme === expected && (await fetch('/api/preferences').then(r => r.json())).preferences.theme === expected, theme);
    const row = { theme, plane: 'live', openedAt: new Date().toISOString() };
    try {
      await page.locator('.topbar-processes-trigger').click();
      await page.getByRole('dialog', { name: 'Process manager', exact: true }).waitFor();
      row.initialText = await page.getByRole('dialog', { name: 'Process manager', exact: true }).innerText();
      await page.getByTestId('tasks-roster').waitFor({ state: 'visible', timeout: 45000 });
      row.settledAt = new Date().toISOString();
      row.observed = await page.getByTestId('tasks-roster').evaluate(e => {
        const r = e.getBoundingClientRect();
        return { headings: [...e.querySelectorAll('dl')].map(dl => dl.innerText), status: e.querySelector('.pc-tasks-roster__foot')?.innerText,
          degraded: e.querySelector('[data-testid="tasks-degraded"]')?.textContent ?? null,
          units: e.querySelector('[data-testid="tasks-units-note"]')?.textContent,
          loading: !!e.querySelector('[data-testid="tasks-roster-loading"]'),
          width: r.width, contained: r.left >= -1 && r.right <= innerWidth + 1,
          viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme };
      });
      const file = `process-settled-${theme}.png`;
      await page.screenshot({ path: path.join(out, file) });
      row.capturePath = file;
      row.captureSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex');
      row.result = row.observed.contained && !row.observed.loading ? 'settled' : 'fail';
    } catch (error) {
      row.result = 'unknown'; row.error = error.message;
      row.finalText = await page.getByRole('dialog', { name: 'Process manager', exact: true }).innerText().catch(() => 'dialog absent');
    }
    result.process.push(row); save();
    await page.goto('http://127.0.0.1:3081/?app=home&accountsPane=false&chatPane=false', { waitUntil: 'domcontentloaded' });
    await page.locator('.portal-theme-switcher').waitFor();
  }
} finally {
  if (original) {
    await page.evaluate(theme => fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) }), original.preferences.theme);
    await page.goto('http://127.0.0.1:3081/?app=home&accountsPane=false&chatPane=false', { waitUntil: 'domcontentloaded' });
    const final = await page.evaluate(() => fetch('/api/preferences').then(r => r.json()));
    result.final = { url: page.url(), preferences: final.preferences };
    result.preferencesRestored = JSON.stringify(final.preferences) === JSON.stringify(original.preferences);
  }
  await browser.close();
  await Promise.allSettled([...pendingReads]);
  result.releaseStable = JSON.parse(fs.readFileSync(releaseFile, 'utf8')).release === release.release;
  result.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ process: result.process.map(row => ({ theme: row.theme, result: row.result, observed: row.observed, error: row.error })), reads: result.reads.filter(r => r.inventoryRequest || r.inventory), preferencesRestored: result.preferencesRestored, releaseStable: result.releaseStable }));
}
