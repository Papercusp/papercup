import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const out = path.dirname(new URL(import.meta.url).pathname);
const base = 'http://127.0.0.1:3081/';
const releaseRoot = '/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/.portal-runtime/portal/current';
const release = fs.realpathSync(releaseRoot);
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const runTag = process.env.PORTAL_ACCEPTANCE_RUN_TAG ?? '';
const caseFilter = process.env.PORTAL_ACCEPTANCE_CASE_FILTER ? new RegExp(process.env.PORTAL_ACCEPTANCE_CASE_FILTER) : null;
const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), release, cases: [] };
const save = () => fs.writeFileSync(path.join(out, runTag + 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let original, page;
async function visit(p, query) {
  await p.goto(base + query, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.locator('.surface').waitFor({ state: 'attached', timeout: 20000 });
}
async function capture(p, name) {
  const file = runTag + name + '.png';
  await p.screenshot({ path: path.join(out, file) });
  return { capturePath: file, captureSha256: digest(fs.readFileSync(path.join(out, file))), capturedAt: new Date().toISOString() };
}
async function run(id, fn, plane = 'live') {
  if (caseFilter && !caseFilter.test(id)) return;
  try { evidence.cases.push({ id, plane, ...(await fn()) }); }
  catch (e) { evidence.cases.push({ id, plane, result: 'unknown', error: e.message }); }
  save();
  console.log(JSON.stringify(evidence.cases.at(-1)));
}
async function popupGeometry(p, selector) {
  return p.locator(selector).evaluate(e => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, clientWidth: e.clientWidth, scrollWidth: e.scrollWidth,
      contained: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}
async function panelStates(p) {
  return p.locator('[data-testid="session-chat-orders-toggle"], [data-testid="session-chat-dossier-toggle"], [data-testid="session-chat-fleet-toggle"]').evaluateAll(es => es.map(e => {
    const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return { id: e.dataset.testid, label: e.getAttribute('aria-label'), expanded: e.getAttribute('aria-expanded'),
      className: e.className, parent: e.parentElement.className, focused: document.activeElement === e,
      reachable: !!hit && (hit === e || e.contains(hit)), x: r.x, y: r.y, width: r.width, height: r.height };
  }));
}
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await visit(page, '?app=home&accountsPane=false&chatPane=false');
  original = await page.evaluate(() => fetch('/api/preferences').then(r => r.json()));
  evidence.initial = { url: page.url(), preferences: original.preferences };
  for (const theme of ['light', 'dark']) {
    await visit(page, '?app=home&accountsPane=false&chatPane=false');
    await page.locator('.portal-theme-switcher').getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
    await page.waitForFunction(async t => (await fetch('/api/preferences').then(r => r.json())).preferences.theme === t, theme);
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      const suffix = `${theme}-${viewport.width}x${viewport.height}`;
      await run('hud-panels-' + suffix, async () => {
        await visit(page, '?app=hud&accountsPane=false&chatPane=false&agentConversation=su-032510f2-f14f-4fbd-8b4f-aaa65622dac0');
        for (const id of ['orders', 'dossier', 'fleet']) await page.getByTestId(`session-chat-${id}-toggle`).waitFor({ timeout: 15000 });
        const before = await panelStates(page), transitions = [];
        for (const s of before) {
          await page.getByTestId(s.id).click();
          await page.waitForTimeout(250);
          transitions.push({ action: s.id, states: await panelStates(page), ...(await capture(page, `hud-${s.id}-${suffix}`)) });
          await page.getByTestId(s.id).click();
          await page.waitForTimeout(250);
        }
        const restored = await panelStates(page);
        await page.getByTestId('session-chat-full-window').click();
        await page.waitForTimeout(250);
        const fullWindow = { geometry: await popupGeometry(page, '[data-testid="session-chat-modal"]'), ...(await capture(page, 'hud-window-' + suffix)) };
        await page.getByTestId('session-chat-full-window').click();
        await page.getByTestId('session-chat-full-screen').click();
        await page.waitForFunction(() => document.fullscreenElement !== null);
        const fullscreen = await page.evaluate(() => ({ active: document.fullscreenElement?.getAttribute('data-testid'), width: document.fullscreenElement?.getBoundingClientRect().width }));
        await page.getByTestId('session-chat-full-screen').click();
        await page.waitForFunction(() => document.fullscreenElement === null && !new URL(location.href).searchParams.get('chatMax'));
        const sameOwner = new URL(page.url()).searchParams.get('agentConversation') === 'su-032510f2-f14f-4fbd-8b4f-aaa65622dac0';
        const statesRestored = before.every(s => restored.find(x => x.id === s.id)?.expanded === s.expanded);
        const togglesWorked = transitions.every(t => { const s = t.states.find(x => x.id === t.action); return s?.focused && s?.expanded !== before.find(x => x.id === t.action)?.expanded; });
        await page.keyboard.press('Escape');
        await page.getByTestId('session-chat-modal').waitFor({ state: 'hidden', timeout: 5000 });
        const escaped = await page.locator('[data-testid="session-chat-modal"]').count() === 0;
        return { viewport, theme, before, transitions, restored, statesRestored, togglesWorked, fullWindow, fullscreen, sameOwner, escaped,
          result: statesRestored && togglesWorked && fullWindow.geometry.contained && sameOwner && escaped ? 'pass' : 'fail' };
      });
      await run('plan-popup-' + suffix, async () => {
        await visit(page, '?app=plans&accountsPane=false&chatPane=false&pplan=portal-design-iteration-2026-09-05');
        await page.getByTestId('plan-popup-fullscreen').waitFor({ timeout: 15000 });
        await page.waitForTimeout(1000);
        const before = { title: await page.locator('.plan-popup__title').innerText(), geometry: await popupGeometry(page, '.plan-popup'), iconPaths: await page.getByTestId('plan-popup-fullscreen').locator('svg path,svg polyline,svg rect').count(), ...(await capture(page, 'plan-window-' + suffix)) };
        await page.getByTestId('plan-popup-fullscreen').click();
        await page.waitForFunction(() => document.fullscreenElement?.getAttribute('data-testid') === 'plan-popup-fullscreen-surface');
        const full = { geometry: await popupGeometry(page, '[data-testid="plan-popup-fullscreen-surface"]'), ...(await capture(page, 'plan-screen-' + suffix)) };
        await page.getByTestId('plan-popup-fullscreen').click();
        await page.waitForFunction(() => document.fullscreenElement === null);
        const restored = { samePlan: new URL(page.url()).searchParams.get('pplan') === 'portal-design-iteration-2026-09-05', geometry: await popupGeometry(page, '.plan-popup') };
        await page.getByTestId('plan-popup-close').click();
        return { viewport, theme, before, full, restored, result: before.iconPaths > 0 && before.geometry.contained && full.geometry.contained && restored.samePlan ? 'pass' : 'fail' };
      });
    }
    for (const viewport of [{ width: 1280, height: 768 }, { width: 390, height: 768 }]) {
      await run(`rail-compact-${theme}-${viewport.width}`, async () => {
        await page.setViewportSize(viewport);
        await visit(page, '?app=home&accountsPane=false&chatPane=false');
        const primary = page.locator('.rail-slot > .rail-item').first();
        await primary.waitFor({ timeout: 15000 });
        await primary.hover();
        const before = await primary.evaluate(e => { const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return { name:e.getAttribute('aria-label'),primaryHit:e===hit||e.contains(hit) }; });
        await primary.click();
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => { const e=document.activeElement,s=getComputedStyle(e),r=e.getBoundingClientRect();return { label:e.getAttribute('aria-label'),className:e.className,outline:s.outline,outlineWidth:s.outlineWidth,width:r.width,height:r.height,padding:s.padding }; });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const motion = await page.locator('.rail-unpin').first().evaluate(e => ({ transition: getComputedStyle(e).transitionDuration }));
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        const shot = await capture(page, `rail-${theme}-${viewport.width}`);
        return { theme, viewport, before, focus, motion, ...shot, result: before.primaryHit && focus.className.includes('rail-unpin') && focus.outlineWidth === '2px' && motion.transition === '0s' ? 'pass' : 'fail' };
      });
    }
    await run('plan-fallback-' + theme, async () => {
      const fixture = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await fixture.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false }));
        await visit(fixture, '?app=plans&accountsPane=false&chatPane=false&pplan=portal-design-iteration-2026-09-05');
        await fixture.getByTestId('plan-popup-fullscreen').waitFor();
        const before = await popupGeometry(fixture, '.plan-popup');
        await fixture.getByTestId('plan-popup-fullscreen').click();
        await fixture.waitForFunction(() => document.querySelector('.plan-popup').getBoundingClientRect().width === innerWidth);
        const full = { geometry: await popupGeometry(fixture, '.plan-popup'), native: await fixture.evaluate(() => document.fullscreenElement !== null), ...(await capture(fixture, 'plan-fallback-' + theme)) };
        await fixture.keyboard.press('Escape');
        await fixture.waitForFunction(() => document.querySelector('.plan-popup')?.getBoundingClientRect().width < innerWidth);
        const restored = { samePlan: new URL(fixture.url()).searchParams.get('pplan') === 'portal-design-iteration-2026-09-05', geometry: await popupGeometry(fixture, '.plan-popup'), ...(await capture(fixture, 'plan-fallback-restored-' + theme)) };
        return { theme, fixture: 'Production :3081 document with fullscreenEnabled=false injected before mount, simulating an embedded host without native fullscreen. This is browser-fixture evidence, not an unmodified live host claim.', before, full, restored,
          result: full.geometry.width === 1280 && full.geometry.contained && !full.native && restored.samePlan && Math.abs(restored.geometry.width - before.width) < 1 ? 'pass' : 'fail' };
      } finally { await fixture.close(); }
    }, 'browser-fixture');
    await run('inbox-reading-' + theme, async () => {
      await page.setViewportSize({ width: 900, height: 800 });
      await visit(page, '?app=inbox&accountsPane=false&chatPane=false');
      const first = page.locator('[data-testid^="inbox-row-"]').first();
      await first.waitFor({ timeout: 20000 });
      const target = await first.getAttribute('data-testid');
      await first.click();
      await page.getByTestId('inbox-detail-body-copy').waitFor({ timeout: 15000 });
      const observed = await page.getByTestId('inbox-detail-body-copy').evaluate(e => {
        const rect = e.getBoundingClientRect(), aside = e.closest('[data-testid="inbox-aside"]'), head = aside?.querySelector('.op-inbox__detail-head');
        const paragraphs = [...e.querySelectorAll('p')].map(p => ({ fontWeight: getComputedStyle(p).fontWeight, fontSize: getComputedStyle(p).fontSize, lineHeight: getComputedStyle(p).lineHeight, width: p.clientWidth, scrollWidth: p.scrollWidth }));
        return { bodyWidth: rect.width, clientWidth: e.clientWidth, scrollWidth: e.scrollWidth, paragraphs, metadataAbove: !!head && head.getBoundingClientRect().bottom <= rect.top + 1,
          documentOverflow: document.documentElement.scrollWidth > innerWidth + 1, excerpt: e.innerText.slice(0,250), headClass: head?.className ?? null };
      });
      return { theme, viewport: { width: 900, height: 800 }, target, observed, ...(await capture(page, 'inbox-reading-' + theme)), result: observed.paragraphs.length > 0 && observed.paragraphs.every(p => p.fontWeight === '400' && p.scrollWidth <= p.width + 1) && observed.scrollWidth <= observed.clientWidth + 1 && observed.metadataAbove && !observed.documentOverflow ? 'pass' : 'fail' };
    });
  }
} finally {
  if (page && original) {
    await page.evaluate(async theme => fetch('/api/preferences', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ theme }) }), original.preferences.theme);
    await page.setViewportSize({width:1280,height:800});
    await visit(page, '?app=home&accountsPane=false&chatPane=false');
    const final = await page.evaluate(() => fetch('/api/preferences').then(r => r.json()));
    evidence.final = { url: page.url(), preferences: final.preferences };
    evidence.preferencesRestored = JSON.stringify(final.preferences) === JSON.stringify(original.preferences);
  }
  evidence.releaseAfter = fs.realpathSync(releaseRoot);
  evidence.releaseStable = evidence.releaseAfter === release;
  evidence.completedAt = new Date().toISOString();
  save();
  await browser.close();
}
