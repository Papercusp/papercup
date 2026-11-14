import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import temp from './lib/playwright-temp-directory.cjs';
import M from '../docs/mockups/native-workbench-navigation-2026-11-12/navigation-model.cjs';

test('transcript search defaults to open conversations; history is explicit',()=>{
  const s=M.createState(); M.search(s,'keyboard focus');
  assert.deepEqual(M.results(s).map(r=>r.session.id),['nav','shell']);
  M.search(s,'GlazeWM'); assert.equal(M.results(s).length,0);
  s.scope='history'; M.reconcile(s); assert.equal(M.results(s)[0].session.id,'history');
  assert.equal(M.results(s)[0].matches.length,1);
});
test('preview, keyboard selection and cancellation preserve active identity and MRU',()=>{
  const s=M.createState(), mru=[...s.mru];M.summon(s);M.preview(s,'remote');M.step(s,1);M.cancel(s);
  assert.equal(s.active,'nav');assert.deepEqual(s.mru,mru);assert.equal(s.visible,false);
  assert.deepEqual(M.activate(s),{ok:true,id:'nav',action:'focus'});
});
test('activation distinguishes exact existing remote, stale and ended targets',()=>{
  const s=M.createState();s.selected='stale';assert.equal(M.activate(s).ok,false);assert.equal(s.active,'nav');
  s.selected='remote';assert.equal(M.activate(s).action,'reattach');assert.equal(s.mru[0],'remote');
  s.scope='history';s.selected='history';assert.equal(M.activate(s).ok,false);assert.equal(s.active,'remote');
  assert.equal(M.activate(s,true).action,'resume');assert.deepEqual(s.resumed,['history']);
  s.selected='missing';assert.equal(M.activate(s).ok,false);
});
test('drafts and context visibility belong to each conversation',()=>{
  const s=M.createState();s.drafts.nav='Keep my draft';s.sidebars.nav=false;s.selected='shell';M.activate(s);s.selected='nav';M.activate(s);
  assert.equal(s.drafts.nav,'Keep my draft');assert.equal(s.sidebars.nav,false);assert.equal(s.sidebars.shell,true);
});
test('offline browser journeys exercise all directions, keyboard, retained draft and report handoff',async()=>{
  temp.preparePlaywrightTempDirectory();
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!/^(file|data):/.test(r.url()))requests.push(r.url());});
  try {
    await page.goto(pathToFileURL(resolve('docs/mockups/native-workbench-navigation-2026-11-12/index.html')).href);
    await page.locator('#conversation-search').fill('keyboard focus');
    assert.equal(await page.locator('.switcher .result').count(),2);
    await page.keyboard.press('ArrowDown');assert.match(await page.locator('.preview-pane h2').innerText(),/GNOME/);
    await page.keyboard.press('Escape');assert.equal(await page.locator('.switcher').count(),0);
    assert.equal(await page.evaluate(()=>window.__navigationStudy.state.active),'nav');
    await page.keyboard.press('Control+k');await page.locator('#conversation-search').fill('GlazeWM');
    await page.locator('[data-scope="history"]').click();
    await page.locator('#conversation-search').press('Enter');assert.equal(await page.evaluate(()=>window.__navigationStudy.state.active),'nav');
    await page.locator('[data-resume]').click();assert.equal(await page.evaluate(()=>window.__navigationStudy.state.active),'history');
    await page.locator('[data-view="b"]').click();
    await page.locator('[data-session="nav"]').click();await page.locator('[data-activate]').click();
    await page.locator('#terminal-draft').fill('Draft survives switching');
    await page.locator('[data-sidebar]').click();
    await page.locator('[data-session="shell"]').click();await page.locator('[data-activate]').click();
    await page.locator('[data-session="nav"]').click();await page.locator('[data-activate]').click();
    assert.equal(await page.locator('#terminal-draft').inputValue(),'Draft survives switching');assert.equal(await page.locator('.context').count(),0);
    await page.locator('.terminal [data-report]').click();assert.match(await page.locator('.report-content code').innerText(),/sel=sample-navigation-report/);
    await page.keyboard.press('Escape');assert.equal(await page.locator('.report-reader').count(),0);
    await page.locator('[data-view="c"]').click();assert.equal(await page.locator('.space-card').count(),3);
    await page.locator('[data-task="Atlas launch"]').click();assert.equal(await page.locator('.rail .result').count(),1);
    await page.locator('[data-view="a"]').click();await page.locator('#conversation-search').fill('no such conversation');
    assert.match(await page.locator('.empty').first().innerText(),/No matching/);
    await page.setViewportSize({width:390,height:1060});
    for(const view of ['a','b','c']){await page.locator(`button[data-view="${view}"]`).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  } finally {await browser.close();}
});
