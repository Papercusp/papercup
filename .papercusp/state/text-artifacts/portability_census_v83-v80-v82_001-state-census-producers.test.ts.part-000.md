---
rel_path: "portability/census/v83-v80-v82/001-state-census-producers.test.ts.part-000"
updated_at: 1794268279628
_body: "content"
---

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closureDigestManifestPath } from '../../../../scripts/lib/passing-task-verdict-cache.mjs';
import { partialTaskCheckpointPath } from '../../../../scripts/lib/partial-task-resume.mjs';
import { retainNativeProofPacket, type NativeCustodyGroup } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
vi.mock('../db-encryption', () => ({ dbEncryptionKeyFilePath: () => '/mounted/secrets/db-key' }));
vi.mock('../superuser-token', () => ({ superuserTokenPath: () => '/scoped/home/superuser-token' }));
vi.mock('../workspace-registry', () => ({
  workspacesRoot: () => '/relocated/workspaces',
  readRegistry: () => ({ workspaces: [{ id: 'registered-project' }] }),
}));
vi.mock('../scratch-uri', () => ({ scratchRoot: () => '/relocated/cache/spills' }));
vi.mock('../oauth/providers', () => ({ googleOAuthClientPath: () => '/fixture/config/papercusp/google-oauth-client.json' }));
vi.mock('../identity/keychain', () => ({ identityDir: () => '/fixture/sensitive/identity' }));
vi.mock('../cupboard/ledger-anchor-eas', () => ({ anchorKeyFilePath: () => '/fixture/sensitive/anchor-key' }));
vi.mock('../papercusp-root', () => ({ papercuspRoot: () => '/relocated/workspaces/registered-project/.papercusp' }));
// Loading the census must succeed when the interactive login runtime is absent.
// Its optional lookup can fail closed without losing independent state writers.
vi.mock('../deployment/account-link-cli', () => { throw new Error('interactive login runtime unavailable'); });
import { databaseCensusEntries, physicalDatabaseCensusEntries, integrationBaselineCensusDeclarations, secretCensusProducers, unitCensusEntries, unitCensusDeclarations, installedUnitCensusDeclarations, verifyHostStateCensus, workspaceRegistryCensusProducer, scratchCensusProducer, installedRootCensusProducers, mergeNestedCensusRoots, postgresStorageDeclaration, gitStorageDeclaration } from './state-census-producers';
import { mkdtemp, writeFile, rm, symlink, readFile, mkdir, chmod, utimes, rename, lstat, readlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { CensusDeclaration } from '@papercusp/backup';
import { collectStateCensus } from '@papercusp/backup';
import type { Sql } from 'postgres';
import { templateDatabaseCensusDeclarations, maintenanceDatabaseCensusDeclarations } from './state-census-producers';
import { hostedConfigurationCensusProducers, configuredOperatorDatabaseCensusDeclarations, unitDatabaseCensusDeclarations, unitEnvironmentFileCensusDeclarations } from './state-census-producers';
import { migrationProducerTables, migrationDatabaseCensusDeclarations, registeredProjectMigrationSources, sqlMigrationCensusSource, canonicalSqlMigrationCensusSources } from './state-census-producers';
import { identityKeychainCensusProducer, anchorSecretCensusProducer, runtimeRetainedCensusProducer, accountCredentialCensusProducer, runtimeSidefileCensusProducer, cliSetupHomeCensusProducer, templateStoreCensusProducer } from './state-census-producers';
import { peerStorageDeclaration, portalReleaseStorageDeclaration, restoredCloneCensusDeclarations, stripRangeCacheCensusProducer, virtualenvCacheDeclaration, affectedTestCacheCensusProducer } from './state-census-producers';
import { planTemplateStoreCensusProducer, historicalGitBlobIdentityResolver, workspaceTemplateStoreCensusProducer } from './state-census-producers';
import { execFileSync } from 'node:child_process';
import { reapArchiveCensusProducer } from './state-census-producers';
import { archiveReapTail, REAP_TAIL_MAX_BYTES } from '../task-manager/reap-archive';
import { historicalHostedProfileConstruction, historicalHostedProfileCensusProducer } from './state-census-producers';
import { historicalPlaywrightStateConstruction, historicalPlaywrightStateCensusProducer, historicalVerifierArtifactCensusProducer, recoverHistoricalCensusWriterEvidence } from './state-census-producers';
import { historicalStripeConfigConstruction, historicalStripeConfigCensusProducer } from './state-census-producers';
import { createCipheriv, scryptSync, randomBytes, createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { defaultTestRunArtifactBase, TestRunArtifactPacket, testRunDeadline } from '../agent-tools/testing/run-artifacts';
import { writeVerifierTaskReceipt } from '../verifier-source';

describe('historical Stripe configuration construction proof', () => {
  // Exact measured dialect from canonical archive SHA06f909e2, call25vdj.
  // It is parsed as data; these historical API requests are never executed.
  const program = "from pathlib import Path\nimport json,urllib.request,urllib.parse,re,os\nkey=Path('HOME/.papercusp/secrets/stripe-test-secret-key').read_text().strip()\nassert re.match(r'^(sk|rk)_test_',key),'refusing non-test key'\nACCOUNT='acct_1UChLcF3Zj0ZNLH5'\ndef api(path,data=None,idem=None):\n headers={'Authorization':'Bearer '+key}\n if idem: headers['Idempotency-Key']='papercusp-cloud-dashboard-test-20261003:'+idem\n payload=None if data is None else urllib.parse.urlencode(data).encode()\n if payload is not None: headers['Content-Type']='application/x-www-form-urlencoded'\n req=urllib.request.Request('https://api.stripe.com/v1/'+path,data=payload,headers=headers)\n try:\n  with urllib.request.urlopen(req,timeout=20) as r: return json.load(r)\n except Exception:\n  raise RuntimeError('Stripe request failed at '+path.split('?')[0]) from None\nacct=api('account');assert acct['id']==ACCOUNT and acct.get('settings',{}).get('dashboard',{}).get('display_name')=='Papercusp LLC','wrong account'\nplans=[]\nfor plan,label,description in [('papercusp-cloud','Papercusp cloud','TEST subscription for Papercusp-backed cloud. Sandbox only; no real charges or resource provisioning.'),('byoc-cloud','Bring your own cloud','TEST platform subscription for your own cloud account. Sandbox only; cloud-provider costs are separate.')]:\n prod=api('products',{'name':label+' (test)','description':description,'metadata[planKey]':plan,'metadata[workItem]':'WI-10005826','metadata[mode]':'test'},'product:'+plan)\n price=api('prices',{'product':prod['id'],'unit_amount':'100','currency':'usd','recurring[interval]':'month','metadata[planKey]':plan},'price:'+plan)\n assert not prod['livemode'] and not price['livemode']\n plans.append({'planKey':plan,'priceId':price['id'],'productId':prod['id'],'label':label,'description':description})\nportal=api('billing_portal/configurations',{'business_profile[headline]':'Papercusp LLC test subscriptions','features[customer_update][enabled]':'true','features[customer_update][allowed_updates][0]':'email','features[payment_method_update][enabled]':'true','features[invoice_history][enabled]':'true','features[subscription_cancel][enabled]':'true','features[subscription_cancel][mode]':'immediately','metadata[workItem]':'WI-10005826'},'portal')\nassert not portal['livemode']\nurl='https://app.papercusp.com/api/hosted/billing/webhook'\ndata={'url':url,'description':'Papercusp cloud dashboard TEST subscriptions (WI-10005826)'}\nfor i,event in enumerate(['checkout.session.completed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed']):data[f'enabled_events[{i}]']=event\nhook=api('webhook_endpoints',data,'webhook')\nassert not hook['livemode'];assert re.match(r'^whsec_[A-Za-z0-9]+$',hook['secret'])\ndef securewrite(path,data):\n p=Path(path);p.parent.mkdir(parents=True,exist_ok=True)\n fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)\n os.fchmod(fd,0o600)\n with os.fdopen(fd,'w') as f:f.write(data)\nsecurewrite('HOME/.papercusp/secrets/stripe-test-cloud-dashboard-webhook-secret',hook['secret']+'\\n')\nresult={'accountId':ACCOUNT,'accountName':'Papercusp LLC','mode':'test','plans':plans,'portalConfigurationId':portal['id'],'webhookEndpointId':hook['id'],'webhookUrl':url,'workItem':'WI-10005826'}\nsecurewrite('HOME/.config/papercusp/stripe-test-cloud-dashboard.json',json.dumps(result,indent=2)+'\\n')\nprint(json.dumps(result))";
  const input = (home: string, source = program, destination = 'different-config.json') => {
    const python = source.replaceAll('HOME', home).replace('stripe-test-cloud-dashboard.json', destination);
    return `text(await tools.exec_command({cmd:${JSON.stringify("python3 - <<'PY'\n" + python + '\nPY')},yield_time_ms:30000,max_output_tokens:1100}));`;
  };
  const receipt = { accountId: 'acct_1UChLcF3Zj0ZNLH5', accountName: 'Papercusp LLC', mode: 'test',
    plans: [{ planKey: 'fixture', priceId: 'price_fixture', productId: 'prod_fixture', label: 'Plan',
      description: 'Retained café 🧪' }], portalConfigurationId: 'bpc_fixture', webhookEndpointId: 'we_fixture',
    webhookUrl: 'https://app.papercusp.com/api/hosted/billing/webhook', workItem: 'WI-10005826' };
  // Python ensure_ascii's expected bytes are literal, independent of the
  // production formatter's UTF-16 escape loop.
  const encoded = () => JSON.stringify(receipt, null, 2)
    .replace('café 🧪', 'caf\\u00e9 \\ud83e\\uddea') + '\n';

  it('attests the complete writer with relocated paths, refusing altered code and additional commands', () => {
    expect(historicalStripeConfigConstruction(input('/fixture'), '/fixture')).toEqual({
      output: '/fixture/.config/papercusp/different-config.json', accountId: receipt.accountId,
    });
    for (const source of [program.replace('os.fchmod(fd,0o600)', 'os.fchmod(fd,0o644)'),
      program.replace('os.O_TRUNC', 'os.O_APPEND'), program.replace("assert not portal['livemode']", 'pass'),
      program.replace('json.dumps(result,indent=2)', 'json.dumps({})'), program + "\nresult['mode']='live'",
      program.replace('print(json.dumps(result))', "print('{}')")]) {
      expect(historicalStripeConfigConstruction(input('/fixture', source), '/fixture')).toBeNull();
    }
    expect(historicalStripeConfigConstruction(input('/fixture').replace("<<'PY'", '<<PY'), '/fixture')).toBeNull();
    expect(historicalStripeConfigConstruction(input('/fixture') + '\ntext(await tools.exec_command({cmd:"touch other"}));', '/fixture')).toBeNull();
    expect(historicalStripeConfigConstruction(input('/fixture') + '\nother();', '/fixture')).toBeNull();
    expect(historicalStripeConfigConstruction(input('/fixture', program, '../../outside.json'), '/fixture')).toBeNull();
    expect(historicalStripeConfigConstruction(input('/other'), '/fixture')).toBeNull();
  });

  it('admits only exact private installed content bound to a successful complete receipt and write window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stripe-config-proof-'));
    const directory = join(home, '.config', 'papercusp'); const output = join(directory, 'different-config.json');
    const timestamp = Date.parse('2026-10-03T05:10:34Z');
    const record = { ref: 'archive:fixture:call25vdj', toolInput: input(home), receipt: JSON.stringify(receipt),
      startedAt: new Date(timestamp - 1000).toISOString(), finishedAt: new Date(timestamp + 1000).toISOString() };
    const write = async (content = encoded()) => {
      await writeFile(output, content, { mode: 0o600 }); await chmod(output, 0o600);
      await utimes(output, timestamp / 1000, timestamp / 1000);
    };
    try {
      await mkdir(directory, { recursive: true }); await write();
      const admitted = await historicalStripeConfigCensusProducer([record], home);
      expect(admitted.declarations).toEqual([{ kind: 'path', root: 'stripe-config-0', name: 'different-config.json',
        classification: 'secret', producer: 'historical-stripe-test-config:archive:fixture:call25vdj' }]);
      expect(JSON.stringify(admitted)).not.toContain(receipt.plans[0].description);
      expect((await historicalStripeConfigCensusProducer([{ ...record,
        receipt: JSON.stringify({ exit_code: 0, output: record.receipt }) }], home)).declarations).toEqual(admitted.declarations);
      for (const changed of [{ ...receipt, mode: 'live' }, { ...receipt, accountId: 'acct_other' },
        { ...receipt, plans: [{}] }, { ...receipt, extra: 'unproven' },
        { exit_code: 1, output: record.receipt }, { exit_code: 0, session_id: 1, output: record.receipt }]) {
        expect((await historicalStripeConfigCensusProducer([{ ...record, receipt: JSON.stringify(changed) }], home)).declarations).toEqual([]);
      }
      await write(encoded().replace('price_fixture', 'price_altered'));
      expect((await historicalStripeConfigCensusProducer([record], home)).declarations).toEqual([]);
      await write(JSON.stringify(receipt)); // Same semantic object is not the actual Python writer's bytes.
      expect((await historicalStripeConfigCensusProducer([record], home)).declarations).toEqual([]);
      await write();
      await chmod(output, 0o644);
      expect((await historicalStripeConfigCensusProducer([record], home)).declarations).toEqual([]);
      await chmod(output, 0o600); await utimes(output, 1, 1);
      expect((await historicalStripeConfigCensusProducer([record], home)).declarations).toEqual([]);
      await write();
      expect((await historicalStripeConfigCensusProducer([{ ...record, finishedAt: 'invalid' }], home)).declarations).toEqual([]);
      expect((await historicalStripeConfigCensusProducer([{ ...record, finishedAt: new Date(timestamp + 300_000).toISOString() }], home)).declarations).toEqual([]);
      await rename(output, output + '.real'); await symlink(output + '.real', output);
      expect((await historicalStripeConfigCensusProducer([record], home)).declarations).toEqual([]);
      await rm(output); await rename(output + '.real', output);
      await rename(directory, directory + '-real'); await symlink(directory + '-real', directory);
      expect((await historicalStripeConfigCensusProducer([record], home)).declarations).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

describe('historical hosted profile construction proof', () => {
  // The measured archived writer, with relocated names to prove that attribution
  // depends on command semantics and current content, not a filename roster.
  const program = `import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
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
while('session_id'in r&&!Object.prototype.hasOwnProperty.call(r,'exit_code'))r=await tools.write_stdin({session_id:r.session_id,chars:'',yield_time_ms:30000,max_output_t
