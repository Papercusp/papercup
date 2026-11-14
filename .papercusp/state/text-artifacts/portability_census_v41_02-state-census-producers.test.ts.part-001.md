---
rel_path: "portability/census/v41/02-state-census-producers.test.ts.part-001"
updated_at: 1794241756285
_body: "content"
---

 from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createCipheriv,scryptSync,randomBytes} from 'node:crypto';
import {hostname,userInfo} from 'node:os';
import {runInNewContext} from 'node:vm';
const fixture=resolve(userInfo().homedir,'.config/papercusp/arbitrary-input.json');
const destination=resolve(userInfo().homedir,'.config/papercusp/arbitrary-profile.enc');
if(existsSync(destination)) throw new Error('Destination exists: inspect before overwrite');
if((statSync(fixture).mode&0o777)!==0o600) throw new Error('Fixture must remain private');
const source=readFileSync('node_modules/verdict-cli/src/server.mjs','utf8');
const start=source.indexOf('const MACHINE_KEY =');
const end=source.indexOf('function decryptData',start);
const encrypt=runInNewContext(source.slice(start,end)+'\\nencryptData;', {hostname,userInfo,scryptSync,randomBytes,createCipheriv,Buffer});
const state=JSON.parse(readFileSync(fixture,'utf8'));
writeFileSync(destination,encrypt({cookies:state.cookies,storage:{localStorage:{},sessionStorage:{}},url:'https://example.test/',savedAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({profile:destination,mode:'0600',cookieCount:state.cookies.length,expirationPreserved:true,valuesPrinted:false}));`;
  const input = (source = program) => `text(await tools.exec_command({cmd:${JSON.stringify("node --input-type=module <<'JS'\n" + source + '\nJS')},yield_time_ms:30000,max_output_tokens:1000}));`;
  it('rejects altered programs, extra writes, unquoted heredocs and paths outside the configuration root', () => {
    expect(historicalHostedProfileConstruction(input(), '/fixture')).toMatchObject({
      input: '/fixture/.config/papercusp/arbitrary-input.json', output: '/fixture/.config/papercusp/arbitrary-profile.enc', url: 'https://example.test/',
    });
    for (const changed of [program + "\nwriteFileSync(destination,'other');", program.replace('cookies:state.cookies', 'cookies:[]'),
      program.replace('arbitrary-profile.enc', '../../outside.enc'), program.replace("flag:'wx'", "flag:'w'")]) {
      expect(historicalHostedProfileConstruction(input(changed), '/fixture')).toBeNull();
    }
    expect(historicalHostedProfileConstruction(input().replace("<<'JS'", '<<JS'), '/fixture')).toBeNull();
    expect(historicalHostedProfileConstruction(input() + '\ntext(await tools.exec_command({cmd:"verdict --session pilot snapshot -i"}));', '/fixture')).not.toBeNull();
    expect(historicalHostedProfileConstruction(input() + '\ntext(await tools.exec_command({cmd:"rm .config/papercusp/arbitrary-profile.enc"}));', '/fixture')).toBeNull();
  });
  it('qualifies only current private content matching the full historical transform and time window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hosted-profile-proof-'));
    const config = join(home, '.config', 'papercusp');
    const cookies = [{ name: 'session', value: 'private-value', expires: 1234 }];
    const value = { cookies, storage: { localStorage: {}, sessionStorage: {} }, url: 'https://example.test/', savedAt: '2026-09-05T19:50:00Z' };
    const evidence = [{ ref: 'fixture:writer:38', toolInput: input(), startedAt: '2026-09-05T19:49:59Z', finishedAt: '2026-09-05T19:50:01Z' }];
    const output = join(config, 'arbitrary-profile.enc');
    const writeProfile = async (profile: object) => {
      const iv = randomBytes(16); const key = scryptSync(`${hostname()}-${userInfo().username}-verdict-cli`, 'verdict-cli-salt-v1', 32);
      const cipher = createCipheriv('aes-256-cbc', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(profile), 'utf8'), cipher.final()]);
      await writeFile(output, JSON.stringify({ iv: iv.toString('hex'), data: data.toString('hex') }), { mode: 0o600 });
    };
    try {
      await mkdir(config, { recursive: true });
      await writeFile(join(config, 'arbitrary-input.json'), JSON.stringify({ cookies, origins: [{ origin: 'https://example.test/' }] }), { mode: 0o600 });
      await writeFile(join(config, 'neighbor.enc'), 'unproven', { mode: 0o600 });
      await writeProfile(value);
      const result = await historicalHostedProfileCensusProducer(evidence, home);
      expect(result.declarations).toEqual([{ kind: 'path', root: 'hosted-profile-0', name: 'arbitrary-profile.enc', classification: 'secret', producer: 'historical-hosted-profile:fixture:writer:38' }]);
      expect(JSON.stringify(result)).not.toContain('private-value');
      const manifest = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(manifest.residue.map(entry => entry.name)).toContain('neighbor.enc');
      expect(manifest.residue.map(entry => entry.name)).toContain('arbitrary-input.json');
      for (const changed of [{ ...value, cookies: [] }, { ...value, savedAt: '2026-09-06T00:00:00Z' },
        { ...value, url: 'https://elsewhere.test/' }, { ...value, storage: { localStorage: { unexpected: 'value' }, sessionStorage: {} } },
        { ...value, unexpected: true }]) {
        await writeProfile(changed);
        expect((await historicalHostedProfileCensusProducer(evidence, home)).declarations).toEqual([]);
      }
      await writeProfile(value); await chmod(output, 0o644);
      expect((await historicalHostedProfileCensusProducer(evidence, home)).declarations).toEqual([]);
      await rm(output); await symlink(join(config, 'neighbor.enc'), output);
      expect((await historicalHostedProfileCensusProducer(evidence, home)).declarations).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

describe('historical Playwright storage-state proof', () => {
  // SHA-verified archived custom_tool_call, relocated to prove semantic ownership.
  const archivedInput = "const r=await tools.exec_command({\n  cmd:\"node - <<'NODE'\\nconst { chromium }=require('./node_modules/@playwright/test');\\nconst fs=require('fs');\\nconst identity=JSON.parse(fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/identity.json','utf8'));\\nconst password=fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/password','utf8').trim();\\nconst statePath='/fixture/.config/papercusp/arbitrary-browser.json';\\n(async()=>{\\n  const browser=await chromium.launch({headless:true,proxy:{server:'socks5://127.0.0.1:18029'}});\\n  const c=await browser.newContext({serviceWorkers:'block'});const p=await c.newPage();\\n  await p.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces',{waitUntil:'domcontentloaded',timeout:60000});\\n  for(let i=0;i<3;i++){\\n    const pw=p.locator('input[type=password],input[name=password]').first();if(await pw.isVisible().catch(()=>false))break;\\n    const em=p.locator('input[name=email],input[type=email]').first();await em.waitFor({state:'visible',timeout:30000});await em.fill(identity.email);\\n    await p.getByRole('button',{name:/continue with email|continue|sign in/i}).first().click();await p.waitForTimeout(2500);\\n  }\\n  const pw=p.locator('input[type=password],input[name=password]').first();await pw.waitFor({state:'visible',timeout:30000});await pw.fill(password);\\n  await p.getByRole('button',{name:/sign in|continue/i}).first().click();\\n  await p.waitForURL(u=>u.hostname==='app.papercusp.com'&&u.pathname!=='/api/hosted/auth/callback',{timeout:60000,waitUntil:'domcontentloaded'});\\n  const session=await p.evaluate(async()=>{const r=await fetch('/api/hosted/auth/session',{cache:'no-store'});const b=await r.json().catch(()=>null);return{status:r.status,ok:b?.ok===true,session:b?.session?{workspaceId:b.session.workspaceId??null,organizationId:b.session.organizationId??null,expiresAtMs:b.session.expiresAtMs??null,sessionVersion:b.session.sessionVersion??null}:null,error:b?.error??null}});\\n  await c.storageState({path:statePath});fs.chmodSync(statePath,0o600);const st=fs.statSync(statePath);\\n  console.log(JSON.stringify({final:{host:new URL(p.url()).host,path:new URL(p.url()).pathname},session,storageState:{path:statePath,mode:(st.mode&0o777).toString(8),bytes:st.size}},null,2));\\n  await browser.close();\\n})().catch(e=>{console.error(JSON.stringify({error:String(e),name:e?.name||null}));process.exit(1)});\\nNODE\",\n  workdir:\"/fixture/papercupai-workspace/papercusp\",\n  yield_time_ms:30000,max_output_tokens:3000\n}); text(r.output);\n";
  it('recognizes the complete measured writer and rejects changed semantics or additional commands', () => {
    expect(historicalPlaywrightStateConstruction(archivedInput, '/fixture')).toEqual({ output: '/fixture/.config/papercusp/arbitrary-browser.json' });
    for (const changed of [
      archivedInput.replace('0o600', '0o644'),
      archivedInput.replace('storageState({path:statePath})', 'storageState({path:identity})'),
      archivedInput.replace('arbitrary-browser.json', '../../outside.json'),
      archivedInput.replace("<<'NODE'", '<<NODE'),
      archivedInput.slice(0, 1000),
      archivedInput + '\nawait tools.exec_command({cmd:"rm /fixture/.config/papercusp/arbitrary-browser.json"});',
    ]) expect(historicalPlaywrightStateConstruction(changed, '/fixture')).toBeNull();
  });
  it('resolves a const command only within the exact successful-envelope polling wrapper', () => {
    const command = JSON.parse(archivedInput.match(/cmd:("(?:[^"\\]|\\.)*")/)![1]);
    const wrapped = `const cmd = ${JSON.stringify(command)};
let r=await tools.exec_command({cmd,workdir:'/fixture/papercupai-workspace/papercusp',yield_time_ms:30000,max_output_tokens:3000});
while('session_id'in r&&!Object.prototype.hasOwnProperty.call(r,'exit_code'))r=await tools.write_stdin({session_id:r.session_id,chars:'',yield_time_ms:30000,max_output_tokens:3000});
text(r);`;
    expect(historicalPlaywrightStateConstruction(wrapped, '/fixture')).toEqual({ output: '/fixture/.config/papercusp/arbitrary-browser.json' });
    for (const altered of [wrapped.replace('const cmd', 'let cmd'),
      wrapped.replace('text(r);', 'text(r); cmd = "other";'),
      wrapped.replace('chars:\'\'', 'chars:\'overwrite\''),
      wrapped.replace('0o600', '0o644'),
      wrapped.replace('max_output_tokens:3000', 'max_output_tokens:1')]) {
      expect(historicalPlaywrightStateConstruction(altered, '/fixture')).toBeNull();
    }
  });
  it('recognizes the SHA-verified Sept6 whole writer while rejecting changed authentication and writes', async () => {
    const input = "const cmd = \"node - <<'NODE'\\nconst { chromium } = require('./node_modules/@playwright/test');\\nconst fs = require('fs');\\nconst crypto = require('crypto');\\nconst identity = JSON.parse(fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/identity.json', 'utf8'));\\nconst password = fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/password', 'utf8').trim();\\nconst statePath = '/fixture/.config/papercusp/p031-hosted-storage-state.json';\\n(async () => {\\n  const startedAt = Date.now();\\n  const browser = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:18029' } });\\n  try {\\n    const context = await browser.newContext({ serviceWorkers: 'block' });\\n    const page = await context.newPage();\\n    await page.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces', { waitUntil: 'domcontentloaded', timeout: 60000 });\\n    const editableEmail = page.locator('input[name=email]:not([readonly]),input[type=email]:not([readonly])').first();\\n    const passwordInput = page.locator('input[type=password],input[name=password]').first();\\n    await Promise.race([editableEmail.waitFor({ state: 'visible', timeout: 30000 }), passwordInput.waitFor({ state: 'visible', timeout: 30000 })]);\\n    if (await editableEmail.isVisible().catch(() => false)) {\\n      await editableEmail.fill(identity.email);\\n      await page.getByRole('button', { name: /continue with email|continue|sign in/i }).first().click();\\n    }\\n    await passwordInput.waitFor({ state: 'visible', timeout: 30000 });\\n    await passwordInput.fill(password);\\n    await page.getByRole('button', { name: /sign in|continue/i }).first().click();\\n    await page.waitForURL((url) => url.hostname === 'app.papercusp.com', { timeout: 60000 });\\n    let session = null;\\n    for (let attempt = 0; attempt < 30; attempt += 1) {\\n      const response = await context.request.get('https://app.papercusp.com/api/hosted/auth/session', { failOnStatusCode: false });\\n      const body = await response.json().catch(() => null);\\n      if (response.status() === 200 && body?.ok === true && body?.session?.sessionId && body?.session?.userId && body?.session?.organizationId) {\\n        session = body.session;\\n        break;\\n      }\\n      await page.waitForTimeout(1000);\\n    }\\n    if (!session) throw new Error('authenticated session metadata did not become available');\\n    await context.storageState({ path: statePath });\\n    fs.chmodSync(statePath, 0o600);\\n    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));\\n    const appCookie = saved.cookies.find((cookie) => cookie.name === '__Host-papercusp_session');\\n    console.log(JSON.stringify({\\n      ok: true,\\n      statePath,\\n      mode: (fs.statSync(statePath).mode & 0o777).toString(8),\\n      sessionHash: crypto.createHash('sha256').update(session.sessionId).digest('hex').slice(0, 12),\\n      userPresent: Boolean(session.userId),\\n      organizationPresent: Boolean(session.organizationId),\\n      workspaceBound: Boolean(session.workspaceId),\\n      cookiePresent: Boolean(appCookie),\\n      cookieExpires: appCookie?.expires ?? null,\\n      durationMs: Date.now() - startedAt,\\n    }));\\n  } finally {\\n    await browser.close();\\n  }\\n})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });\\nNODE\";\nlet r=await tools.exec_command({cmd,workdir:\"/fixture/papercupai-workspace/papercusp\",yield_time_ms:30000,max_output_tokens:3000});\nwhile(\"se
