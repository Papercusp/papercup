import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const out = path.dirname(new URL(import.meta.url).pathname);
const releaseFile = '/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/.portal-runtime/portal/current/.papercusp-release.json';
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const result = { schemaVersion: 1, startedAt: new Date().toISOString(), release, retakes: [], states: [] };
const priorPath = path.join(out, 'retakes.json');
if (fs.existsSync(priorPath)) {
  const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'));
  if (prior.release.release !== release.release) throw new Error('Cannot merge retakes across different releases');
  result.retakes = prior.retakes;
  result.states = prior.states;
  result.previousAttempts = [...(prior.previousAttempts ?? []), { startedAt: prior.startedAt, completedAt: prior.completedAt, error: prior.error ?? null }];
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let page, initial;
const save = () => fs.writeFileSync(path.join(out, 'retakes.json'), JSON.stringify(result, null, 2) + '\n');
const screenshot = async name => {
  const file = path.join(out, name + '.png');
  await page.screenshot({ path: file });
  return { capturePath: name + '.png', captureSha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), capturedAt: new Date().toISOString() };
};
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3081/?app=home&accountsPane=false&chatPane=false', { waitUntil: 'domcontentloaded' });
  await page.locator('.portal-theme-switcher').waitFor();
  initial = await page.evaluate(() => fetch('/api/preferences').then(r => r.json()));
  result.initial = { url: page.url(), preferences: initial.preferences };
  for (const theme of ['light', 'dark']) {
    await page.locator('.portal-theme-switcher').getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
    await page.waitForFunction(async t => (await fetch('/api/preferences').then(r => r.json())).preferences.theme === t, theme);
    for (const [app, marker] of [['learning', 'What the learning loop produced'], ['workflows', 'Build with the workflow agent'], ['settings', 'Theme for the portal']]) {
      if (result.retakes.some(row => row.slot === `${app}/${theme}/1440x900` && row.result === 'pass')) continue;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('http://127.0.0.1:3081/?app=' + app, { waitUntil: 'domcontentloaded' });
      await page.locator('.surface').waitFor({ state: 'attached' });
      const first = await page.evaluate(() => ({ text: document.querySelector('.surface-body')?.innerText.slice(0,300), unsupported: document.body.innerText.includes('Not in the web portal yet') }));
      await page.waitForFunction(({ marker, theme }) => document.documentElement.dataset.theme === theme && document.querySelector('.surface-body')?.textContent.includes(marker) && !document.querySelector('.surface-body .placeholder-surface[aria-busy="true"]'), { marker, theme }, { timeout: 20000 });
      const observed = await page.evaluate(() => { const e=document.querySelector('.surface-body');return { url:location.href,theme:document.documentElement.dataset.theme,viewport:{width:innerWidth,height:innerHeight},surfaceWidth:e.clientWidth,surfaceScrollWidth:e.scrollWidth,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,unsupported:e.innerText.includes('Not in the web portal yet'),text:e.innerText.slice(0,1800) }; });
      result.retakes.push({ slot:`${app}/${theme}/1440x900`, releaseId:release.release, first, observed, ...(await screenshot(`${app}-${theme}-1440x900`)), result:!first.unsupported&&!observed.unsupported&&!observed.documentOverflow?'pass':'fail' });
      save();
    }
    await page.setViewportSize({width:1280,height:768});
    await page.goto('http://127.0.0.1:3081/?app=home',{waitUntil:'domcontentloaded'});
    await page.locator('.portal-more-trigger').click();
    await page.getByRole('combobox',{name:'Find a section'}).fill('Evaluation');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>new URL(location.href).searchParams.get('app')==='evals');
    result.states.push({id:'hidden-navigation-'+theme,plane:'live',url:page.url(),result:'pass',...(await screenshot('hidden-navigation-'+theme))});
  }
  await page.goto('http://127.0.0.1:3081/?app=home',{waitUntil:'domcontentloaded'});
  await page.locator('.metric-card').first().waitFor();
  await page.waitForTimeout(700);
  result.states.push({id:'live-empty-and-unknown',plane:'live',observed:await page.evaluate(()=>({emptyCalendar:document.body.innerText.includes('No upcoming meeting'),unknownCards:[...document.querySelectorAll('.metric[data-unknown]')].map(e=>({text:e.textContent,title:e.title})),loading:document.body.innerText.includes('Loading')})),...(await screenshot('home-empty-unknown'))});
  await page.goto('http://127.0.0.1:3081/?app=workspaces',{waitUntil:'domcontentloaded'});
  await page.getByRole('region',{name:'Your workspaces'}).waitFor();
  await page.waitForTimeout(700);
  result.states.push({id:'workspace-disabled-status',plane:'live',observed:await page.evaluate(()=>[...document.querySelectorAll('button')].filter(b=>b.innerText==='Open desktop').map(b=>({disabled:b.disabled,title:b.title,cardText:b.closest('article')?.innerText.slice(0,450)}))),...(await screenshot('workspace-disabled-status'))});
} catch(error) { result.error=error.message; throw error; }
finally {
  if(page&&initial){await page.evaluate(theme=>fetch('/api/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme})}),initial.preferences.theme);await page.setViewportSize({width:1440,height:900});await page.goto('http://127.0.0.1:3081/?app=home&accountsPane=false&chatPane=false',{waitUntil:'domcontentloaded'});const final=await page.evaluate(()=>fetch('/api/preferences').then(r=>r.json()));result.final={url:page.url(),preferences:final.preferences};result.preferencesRestored=JSON.stringify(initial.preferences)===JSON.stringify(final.preferences);}
  result.completedAt=new Date().toISOString();result.releaseStable=JSON.parse(fs.readFileSync(releaseFile,'utf8')).release===release.release;save();await browser.close();
}
