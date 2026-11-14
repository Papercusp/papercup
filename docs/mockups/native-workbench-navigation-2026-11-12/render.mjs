import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import temp from '../../../scripts/lib/playwright-temp-directory.cjs';

temp.preparePlaywrightTempDirectory();
const directory=dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1110}});
const errors=[], network=[], captures=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(!/^(file|data):/.test(r.url()))network.push(r.url());});
try {
  await page.goto(pathToFileURL(join(directory,'index.html')).href);
  for(const [view,name] of [['a','quick-switch'],['b','conversation-rail'],['c','task-spaces']]) {
    await page.evaluate(v=>window.__navigationStudy.set(v),view);
    await page.screenshot({path:join(directory,`${name}.png`),fullPage:true});
    captures.push(`${name}.png`);
  }
  await page.evaluate(()=>window.__navigationStudy.set('a','keyboard focus'));
  await page.screenshot({path:join(directory,'transcript-search.png'),fullPage:true});
  captures.push('transcript-search.png');
  await page.evaluate(()=>window.__navigationStudy.set('b'));
  await page.locator('.terminal [data-report]').click();
  await page.screenshot({path:join(directory,'report-handoff.png'),fullPage:true});
  captures.push('report-handoff.png');
  await page.setViewportSize({width:390,height:1060});
  await page.evaluate(()=>window.__navigationStudy.set('a'));
  await page.screenshot({path:join(directory,'narrow.png'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  const result={captures,browserErrors:errors,externalRequests:network,narrowOverflow:overflow,purpose:'Sample-data interaction studies; not native acceptance.'};
  await writeFile(join(directory,'verification.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  if(errors.length||network.length||overflow)process.exitCode=1;
} finally { await browser.close(); }
