import { afterEach, describe, expect, it, vi } from 'vitest';
import { closureDigestManifestPath } from '../../../../scripts/lib/passing-task-verdict-cache.mjs';
import { partialTaskCheckpointPath } from '../../../../scripts/lib/partial-task-resume.mjs';
import { retainNativeProofPacket, type NativeCustodyGroup } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
import * as nativeProof from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
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
import { mkdtemp, writeFile, rm, symlink, readFile, mkdir, chmod, utimes, rename, lstat, readlink, link as createHardlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import type { CensusDeclaration } from '@papercusp/backup';
import { collectStateCensus } from '@papercusp/backup';
import type { Sql } from 'postgres';
import { templateDatabaseCensusDeclarations, maintenanceDatabaseCensusDeclarations } from './state-census-producers';
import { hostedConfigurationCensusProducers, configuredOperatorDatabaseCensusDeclarations, unitDatabaseCensusDeclarations, unitEnvironmentFileCensusDeclarations } from './state-census-producers';
import { migrationProducerTables, migrationDatabaseCensusDeclarations, registeredProjectMigrationSources, sqlMigrationCensusSource, canonicalSqlMigrationCensusSources } from './state-census-producers';
import { identityKeychainCensusProducer, anchorSecretCensusProducer, runtimeRetainedCensusProducer, accountCredentialCensusProducer, runtimeSidefileCensusProducer, oauthRegistrationCensusDeclarations, runtimeTestArtifactCensusDeclarations, cliSetupHomeCensusProducer, templateStoreCensusProducer } from './state-census-producers';
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
import { verifierSourceFiles } from '@papercusp/test-config/verifier-source';
import { attestHistoricalSourceOperations, readHistoricalCensusSourceReceipt } from './state-census-producers';

describe('historical source operation byte binding', () => {
  const record = (command: string, exitCode = 0) => ({ ref: 'archive:codex:fixture:sha256:original:line:1:call:source',
    toolInput: `text(await tools.exec_command({cmd:${JSON.stringify(command)}}));`, receipt: '',
    startedAt: '2026-11-10T10:00:00.000Z', finishedAt: '2026-11-10T10:00:01.000Z',
    terminal: { exitCode, output: 'complete', ref: 'archive:codex:fixture:line:2' } });
  const retained = (receipt: unknown) => {
    const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), ref: 'retained:original-receipt' };
  };

  it('binds an archive to its original commit/receipt, refusing current-tree substitution and repinned local metadata', async () => {
    const base = await mkdtemp(join(tmpdir(), 'source-binding-'));
    const repo = join(base, 'repo'); const dest = join(base, 'archive');
    try {
      await mkdir(repo); await mkdir(dest);
      execFileSync('git', ['init', '--quiet', repo]);
      const git = (args: string[], input?: string) => execFileSync('git', ['-C', repo,
        '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { input, encoding: 'utf8' }).trim();
      const blob = git(['hash-object', '-w', '--stdin'], 'original source');
      const tree = git(['mktree'], `100644 blob ${blob}\tinput.txt\n`);
      const commit = git(['commit-tree', tree, '-m', 'fixture source']);
      await writeFile(join(dest, 'input.txt'), 'original source');
      const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: commit, submodules: [],
        testedInputs: [{ path: 'input.txt', sha256: createHash('sha256').update('original source').digest('hex') }],
        files: verifierSourceFiles(dest) };
      const original = retained(receipt);
      await writeFile(join(dest, '.verifier-source.json'), original.bytes);
      const input = record(`git -C ${repo} archive --format=tar ${commit} | tar -x -C ${dest}`);
      const bind = (pin = original) => attestHistoricalSourceOperations(input, async () => pin);
      expect(await bind()).toEqual([{ operationIndex: 0, receiptRef: original.ref, receiptSha256: original.sha256,
        sourceCommit: commit, files: receipt.files }]);
      expect(await attestHistoricalSourceOperations({ ...input, terminal: { ...input.terminal, exitCode: 1 } }, async () => original)).toEqual([]);
      expect(await attestHistoricalSourceOperations(input, async () => null)).toEqual([]);
      expect(await bind({ ...original, bytes: Buffer.from('{}') })).toEqual([]);
      await writeFile(join(dest, 'input.txt'), 'substituted current source');
      expect(await bind()).toEqual([]);
      await writeFile(join(dest, '.verifier-source.json'), JSON.stringify({ ...receipt,
        testedInputs: [{ path: 'input.txt', sha256: createHash('sha256').update('substituted current source').digest('hex') }],
        files: verifierSourceFiles(dest) }));
      expect(await bind()).toEqual([]);
      await writeFile(join(dest, 'input.txt'), 'original source');
      await writeFile(join(dest, '.verifier-source.json'), original.bytes);
      expect(await bind()).toHaveLength(1);
      const otherCommit = git(['commit-tree', tree, '-m', 'different commit']);
      expect(await attestHistoricalSourceOperations(record(
        `git -C ${repo} archive --format=tar ${otherCommit} | tar -x -C ${dest}`), async () => original)).toEqual([]);
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it('checks both hardlinked trees against the retained dependency bytes, even when both mutate together', async () => {
    const base = await mkdtemp(join(tmpdir(), 'hardlink-binding-'));
    const root = join(base, 'original'); const source = join(root, 'node_modules'); const dest = join(base, 'copy');
    try {
      await mkdir(source, { recursive: true }); await mkdir(dest);
      await writeFile(join(source, 'module.js'), 'original dependency');
      await createHardlink(join(source, 'module.js'), join(dest, 'module.js'));
      const receipt = { schemaVersion: 'verifier-dependencies-v1', scope: 'materialized-dependency-files',
        root, sourceCommit: 'a'.repeat(40), sourceReceiptSha256: 'b'.repeat(64),
        trees: [{ path: 'node_modules', files: verifierSourceFiles(source) }] };
      const original = retained(receipt); const input = record(`cp -al ${source} ${dest}`);
      const bind = () => attestHistoricalSourceOperations(input, async () => original);
      expect(await bind()).toHaveLength(1);
      const archive = Buffer.from([
        { type: 'response_item', timestamp: input.startedAt, payload: { type: 'custom_tool_call', name: 'exec',
          call_id: 'copy-call', input: input.toolInput } },
        { type: 'response_item', timestamp: input.finishedAt, payload: { type: 'custom_tool_call_output',
          call_id: 'copy-call', output: JSON.stringify({ exit_code: 0, output: 'complete' }) } },
      ].map(row => JSON.stringify(row)).join('\n'));
      const candidate = { ref: 'indexed:copy', sessionId: 'copy-session', toolInput: 'truncated',
        startedAt: input.startedAt, finishedAt: input.finishedAt };
      const recovered = await recoverHistoricalCensusWriterEvidence([candidate], async () => ({ bytes: archive,
        sha256: createHash('sha256').update(archive).digest('hex') }), undefined, async () => original);
      expect(recovered[0].sourceBindings).toEqual(await bind());
      expect(recovered[0].receipt).toBe('');
      expect(recovered[0]).not.toHaveProperty('declarations');
      await writeFile(join(source, 'module.js'), 'mutated dependency');
      expect(await readFile(join(dest, 'module.js'), 'utf8')).toBe('mutated dependency');
      expect(verifierSourceFiles(source)).toEqual(verifierSourceFiles(dest));
      expect(await bind()).toEqual([]);
      await writeFile(join(source, 'module.js'), 'original dependency');
      await writeFile(join(dest, 'extra.js'), 'unrecorded');
      expect(await bind()).toEqual([]);
      await rm(join(dest, 'extra.js')); await rename(dest, dest + '-real'); await symlink(dest + '-real', dest);
      expect(await bind()).toEqual([]);
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

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
    const input = "const cmd = \"node - <<'NODE'\\nconst { chromium } = require('./node_modules/@playwright/test');\\nconst fs = require('fs');\\nconst crypto = require('crypto');\\nconst identity = JSON.parse(fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/identity.json', 'utf8'));\\nconst password = fs.readFileSync('/run/user/1000/papercusp-p029-acceptance.9aTT9e/password', 'utf8').trim();\\nconst statePath = '/fixture/.config/papercusp/p031-hosted-storage-state.json';\\n(async () => {\\n  const startedAt = Date.now();\\n  const browser = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:18029' } });\\n  try {\\n    const context = await browser.newContext({ serviceWorkers: 'block' });\\n    const page = await context.newPage();\\n    await page.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces', { waitUntil: 'domcontentloaded', timeout: 60000 });\\n    const editableEmail = page.locator('input[name=email]:not([readonly]),input[type=email]:not([readonly])').first();\\n    const passwordInput = page.locator('input[type=password],input[name=password]').first();\\n    await Promise.race([editableEmail.waitFor({ state: 'visible', timeout: 30000 }), passwordInput.waitFor({ state: 'visible', timeout: 30000 })]);\\n    if (await editableEmail.isVisible().catch(() => false)) {\\n      await editableEmail.fill(identity.email);\\n      await page.getByRole('button', { name: /continue with email|continue|sign in/i }).first().click();\\n    }\\n    await passwordInput.waitFor({ state: 'visible', timeout: 30000 });\\n    await passwordInput.fill(password);\\n    await page.getByRole('button', { name: /sign in|continue/i }).first().click();\\n    await page.waitForURL((url) => url.hostname === 'app.papercusp.com', { timeout: 60000 });\\n    let session = null;\\n    for (let attempt = 0; attempt < 30; attempt += 1) {\\n      const response = await context.request.get('https://app.papercusp.com/api/hosted/auth/session', { failOnStatusCode: false });\\n      const body = await response.json().catch(() => null);\\n      if (response.status() === 200 && body?.ok === true && body?.session?.sessionId && body?.session?.userId && body?.session?.organizationId) {\\n        session = body.session;\\n        break;\\n      }\\n      await page.waitForTimeout(1000);\\n    }\\n    if (!session) throw new Error('authenticated session metadata did not become available');\\n    await context.storageState({ path: statePath });\\n    fs.chmodSync(statePath, 0o600);\\n    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));\\n    const appCookie = saved.cookies.find((cookie) => cookie.name === '__Host-papercusp_session');\\n    console.log(JSON.stringify({\\n      ok: true,\\n      statePath,\\n      mode: (fs.statSync(statePath).mode & 0o777).toString(8),\\n      sessionHash: crypto.createHash('sha256').update(session.sessionId).digest('hex').slice(0, 12),\\n      userPresent: Boolean(session.userId),\\n      organizationPresent: Boolean(session.organizationId),\\n      workspaceBound: Boolean(session.workspaceId),\\n      cookiePresent: Boolean(appCookie),\\n      cookieExpires: appCookie?.expires ?? null,\\n      durationMs: Date.now() - startedAt,\\n    }));\\n  } finally {\\n    await browser.close();\\n  }\\n})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });\\nNODE\";\nlet r=await tools.exec_command({cmd,workdir:\"/fixture/papercupai-workspace/papercusp\",yield_time_ms:30000,max_output_tokens:3000});\nwhile(\"session_id\"in r&&!Object.prototype.hasOwnProperty.call(r,\"exit_code\"))r=await tools.write_stdin({session_id:r.session_id,chars:\"\",yield_time_ms:30000,max_output_tokens:3000});\ntext(r);\n";
    expect(historicalPlaywrightStateConstruction(input, '/fixture')).toEqual({ output: '/fixture/.config/papercusp/p031-hosted-storage-state.json' });
    for (const changed of [
      input.replace('body?.session?.organizationId', 'body?.session?.workspaceId'),
      input.replace('await context.storageState', 'await context.clearCookies(); await context.storageState'),
      input.replace('0o600', '0o644'),
      input.replace('app.papercusp.com/api/hosted/auth/session', 'elsewhere.test/api/hosted/auth/session'),
      input.replace("update(session.sessionId)", "update(session.userId)"),
      input.replace('process.exitCode = 1', 'process.exitCode = 0'),
    ]) expect(historicalPlaywrightStateConstruction(changed, '/fixture')).toBeNull();
    // This writer proves construction, but its receipt cannot bind every cookie
    // and local-storage value to the installed file. Session identity is insufficient.
    const home = await mkdtemp(join(tmpdir(), 'sept6-state-proof-'));
    const output = join(home, '.config', 'papercusp', 'p031-hosted-storage-state.json');
    const startedAt = '2026-09-06T12:00:00Z';
    const finishedAt = '2026-09-06T12:00:30Z';
    const cookie = { name: '__Host-papercusp_session', value: 'fixture-session', domain: 'app.papercusp.com',
      path: '/', expires: 1789000000, httpOnly: true, secure: true, sameSite: 'Lax' };
    const receipt = { ok: true, statePath: output, mode: '600',
      sessionHash: createHash('sha256').update(cookie.value).digest('hex').slice(0, 12),
      userPresent: true, organizationPresent: true, workspaceBound: true,
      cookiePresent: true, cookieExpires: cookie.expires, durationMs: 1000 };
    const record = { ref: 'archive:sept6:full-writer',
      toolInput: input.replaceAll('/fixture', home), startedAt, finishedAt, receipt: JSON.stringify(receipt) };
    try {
      await mkdir(join(home, '.config', 'papercusp'), { recursive: true });
      expect(historicalPlaywrightStateConstruction(record.toolInput, home)).toEqual({ output });
      for (const state of [
        { cookies: [cookie], origins: [] },
        { cookies: [cookie, { ...cookie, name: 'unbound', value: 'different-cookie' }], origins: [] },
        { cookies: [cookie], origins: [{ origin: 'https://app.papercusp.com',
          localStorage: [{ name: 'unbound', value: 'different-storage' }] }] },
      ]) {
        await writeFile(output, JSON.stringify(state), { mode: 0o600 });
        await utimes(output, new Date(startedAt), new Date(startedAt));
        expect(await historicalPlaywrightStateCensusProducer([record], home)).toEqual({ roots: [], declarations: [] });
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('transports bounded source operations through canonical recovery without inventing receipts or ownership', async () => {
    const startedAt = '2026-11-10T10:00:00.000Z'; const finishedAt = '2026-11-10T10:00:01.000Z';
    const candidate = { ref: 'indexed:source-operation', sessionId: 'source-operation-session',
      toolInput: 'truncated', startedAt, finishedAt };
    const recover = async (command: string, exitCode = 0) => {
      const rows = [
        { type: 'response_item', timestamp: startedAt, payload: { type: 'custom_tool_call', name: 'exec', call_id: 'source-call',
          input: `text(await tools.exec_command({cmd:${JSON.stringify(command)}}));` } },
        { type: 'response_item', timestamp: finishedAt, payload: { type: 'custom_tool_call_output', call_id: 'source-call',
          output: JSON.stringify({ exit_code: exitCode, output: 'copy finished' }) } },
      ];
      const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n'));
      return (await recoverHistoricalCensusWriterEvidence([candidate], async () => ({ bytes,
        sha256: createHash('sha256').update(bytes).digest('hex') }),
      { workspaceId: 'source-workspace', sourceBoundary: 'source-archive', epoch: 'original-epoch', key: new Uint8Array(32).fill(17) }))[0];
    };
    const record = await recover('repo=/canonical; cp -al "$repo/modules" /scratch/modules');
    expect(record.sourceOperations).toMatchObject({ status: 'supported', operations: [
      { kind: 'hardlink-copy', source: '/canonical/modules', destination: '/scratch/modules' },
    ] });
    expect(record.receipt).toBe('');
    expect(record.operationEvidence).toHaveLength(1);
    expect(record.operationEvidence![0].source.ref).toBe(record.ref);
    expect(record.operationEvidence![0].outcome).toEqual({ status: 'success', final: true });
    expect(record).not.toHaveProperty('declarations');
    expect((await recover('cp -al /canonical/modules /scratch/modules', 1)).operationEvidence![0].outcome)
      .toEqual({ status: 'error', final: true });
    const dynamic = await recover('cp -al "$MISSING" /scratch/modules');
    expect(dynamic.sourceOperations?.status).toBe('unknown');
    expect(dynamic.operationEvidence).toEqual([]);
  });

  it('recovers full custom/native calls by timestamp and call id from verified source, rejecting corrupt and ambiguous archives', async () => {
    const candidate = { ref: 'indexed:part121', sessionId: 'native-session', toolInput: archivedInput.slice(0, 1000),
      startedAt: '2026-09-05T19:49:31.511Z', finishedAt: '2026-09-05T19:49:41.364Z' };
    const receipt = JSON.stringify({ storageState: { mode: '600', bytes: 6625 } });
    const writer = { type: 'response_item', timestamp: candidate.startedAt,
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'writer-call', input: archivedInput } };
    const output = { type: 'response_item', timestamp: candidate.finishedAt,
      payload: { type: 'custom_tool_call_output', call_id: 'writer-call', output: [{ type: 'input_text', text: receipt }] } };
    const source = (...rows: object[]) => {
      const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const unrelated = { ...output, payload: { ...output.payload, call_id: 'another-call', output: [{ type: 'input_text', text: 'unrelated' }] } };
    const read = vi.fn(async () => source(writer, unrelated, output));
    const recovered = await recoverHistoricalCensusWriterEvidence([candidate], read);
    expect(read).toHaveBeenCalledExactlyOnceWith('native-session');
    expect(recovered).toMatchObject([{ indexedRef: candidate.ref, toolInput: archivedInput, receipt, startedAt: candidate.startedAt, finishedAt: candidate.finishedAt }]);
    expect(recovered[0].ref).toContain(':line:1:call:writer-call');
    expect(historicalPlaywrightStateConstruction(recovered[0].toolInput, '/fixture')).not.toBeNull();
    expect(await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, unrelated))).toEqual([]);
    expect(await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, output, output))).toEqual([]);
    expect(await recoverHistoricalCensusWriterEvidence([{ ...candidate, startedAt: '2026-09-06T00:00:00Z' }], read)).toEqual([]);
    await expect(recoverHistoricalCensusWriterEvidence([candidate], async () => ({ ...source(writer, output), sha256: '0'.repeat(64) }))).rejects.toThrow('SHA/size mismatch');
    await expect(recoverHistoricalCensusWriterEvidence([candidate], async () => { throw new Error('canonical native archive sha mismatch'); })).rejects.toThrow('sha mismatch');
    expect(await recoverHistoricalCensusWriterEvidence([candidate], async () => { throw new Error('canonical codex archive not found'); })).toEqual([]);
    const native = { ...writer, payload: { type: 'function_call', name: 'exec', call_id: 'writer-call', arguments: JSON.stringify({ code: archivedInput }) } };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(native, output)))[0].toolInput).toBe(archivedInput);
    const nestedOutput = (envelope: object) => ({ ...output, payload: { ...output.payload,
      output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' },
        { type: 'input_text', text: JSON.stringify(envelope) }] } });
    const envelope = { exit_code: 0, output: receipt + '\n', chunk_id: 'completed-command' };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, nestedOutput(envelope))))[0].receipt).toBe(receipt);
    const sessionReceipt = { ok: true, statePath: '/fixture/.config/papercusp/arbitrary-browser.json',
      mode: '600', sessionHash: '33cd423ed43d' };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer,
      nestedOutput({ ...envelope, output: JSON.stringify(sessionReceipt) }))))[0].receipt).toBe(JSON.stringify(sessionReceipt));
    const stripeReceipt = { accountId: 'acct_fixture', accountName: 'Fixture', mode: 'test',
      plans: [{ planKey: 'cloud', priceId: 'price_fixture', productId: 'prod_fixture', label: 'Cloud', description: 'Fixture' }],
      portalConfigurationId: 'bpc_fixture', webhookEndpointId: 'we_fixture', webhookUrl: 'https://example.test/hook', workItem: 'WI-fixture' };
    const stripeEnvelope = { ...envelope, output: JSON.stringify(stripeReceipt) };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer,
      nestedOutput(stripeEnvelope))))[0].receipt).toBe(JSON.stringify(stripeReceipt));
    for (const invalid of [{ ...stripeEnvelope, exit_code: 1 }, { ...stripeEnvelope, session_id: 123 },
      { ...stripeEnvelope, output: JSON.stringify({ ...stripeReceipt, mode: 'live' }) },
      { ...stripeEnvelope, output: JSON.stringify({ ...stripeReceipt, plans: [{}] }) }]) {
      expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, nestedOutput(invalid))))[0].receipt).toBe('');
    }
    for (const invalid of [{ ...envelope, exit_code: 1 }, { output: receipt, session_id: 123 },
      { ...envelope, session_id: 123 }, { ...envelope, output: 'not JSON' }, { ...envelope, output: 'null' },
      { value: envelope }]) {
      expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, nestedOutput(invalid))))[0].receipt).toBe('');
    }
    const ambiguousOutput = { ...output, payload: { ...output.payload, output: [
      { type: 'input_text', text: receipt }, { type: 'input_text', text: JSON.stringify(envelope) }] } };
    expect((await recoverHistoricalCensusWriterEvidence([candidate], async () => source(writer, ambiguousOutput)))[0].receipt).toBe('');
  });
  it('recovers deferred writer completion through exact cell and call identities without trusting notifications or unrelated waits', async () => {
    const startedAt = '2026-09-05T19:49:31.511Z';
    const candidate = { ref: 'indexed:deferred', sessionId: 'deferred-session', toolInput: '', startedAt, finishedAt: '' };
    const receipt = JSON.stringify({ storageState: { mode: '600', bytes: 6625 } });
    const record = (second: number, payload: object) => ({ type: 'response_item',
      timestamp: new Date(Date.parse(startedAt) + second * 1000).toISOString(), payload });
    const call = record(0, { type: 'custom_tool_call', name: 'exec', call_id: 'writer', input: archivedInput });
    const yielded = (cell = '14') => `Script running with cell ID ${cell}\nWall time 11.0 seconds\nOutput:\n`;
    const output = (second: number, id: string, value: unknown) => record(second,
      { type: 'custom_tool_call_output', call_id: id, output: value });
    const wait = (second: number, id: string, cell = '14', terminate = false) => record(second,
      { type: 'function_call', name: 'wait', call_id: id, arguments: JSON.stringify({ cell_id: cell, terminate }) });
    const terminal = (exit_code = 0) => [{ type: 'input_text', text: 'Script completed\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({ exit_code, output: receipt }) }];
    const source = (...rows: object[]) => {
      const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const first = [call, output(1, 'writer', yielded()), output(1, 'writer', 'Progress notification'),
      wait(2, 'unrelated', 'other'), output(3, 'unrelated', terminal()),
      wait(4, 'poll'), output(5, 'poll', yielded()), wait(6, 'finish')];
    const recover = (...rows: object[]) => recoverHistoricalCensusWriterEvidence([candidate], async () => source(...rows));
    const [recovered] = await recover(...first, output(7, 'finish', terminal()));
    expect(recovered).toMatchObject({ toolInput: archivedInput, receipt, startedAt,
      finishedAt: new Date(Date.parse(startedAt) + 7000).toISOString(), terminal: { exitCode: 0, output: receipt } });
    expect(recovered.terminal?.ref).toContain(':call:finish');
    expect(await recover(...first)).toEqual([]);
    expect(await recover(...first, output(7, 'different-call', terminal()))).toEqual([]);
    expect(await recover(...first, output(7, 'finish', terminal()), output(8, 'finish', terminal()))).toEqual([]);
    expect(await recover(call, output(1, 'writer', yielded()), wait(2, 'finish', 'other'), output(3, 'finish', terminal()))).toEqual([]);
    expect(await recover(call, output(1, 'writer', yielded()), wait(2, 'finish', '14', true), output(3, 'finish', terminal()))).toEqual([]);
    expect(await recover(call, output(1, 'writer', yielded()), wait(2, 'poll'), output(3, 'poll', yielded('other')))).toEqual([]);
    expect(await recover(call, output(1, 'writer', yielded()), wait(3, 'finish'), output(2, 'finish', terminal()))).toEqual([]);
    const [failed] = await recover(...first, output(7, 'finish', terminal(1)));
    expect(failed.receipt).toBe('');
    expect(failed.terminal?.exitCode).toBe(1);
    const [generic] = await recover(...first, output(7, 'finish', [{ type: 'input_text',
      text: JSON.stringify({ exit_code: 0, output: 'generic writer stdout' }) }]));
    expect(generic.receipt).toBe('');
    expect(generic.terminal?.output).toBe('generic writer stdout');
    expect((await recover(...first, output(7, 'finish', [{ type: 'input_text',
      text: JSON.stringify({ exit_code: 0, session_id: 99, output: receipt }) }])))[0].terminal).toBeUndefined();
  });
  it('inspects complete static command inputs without evaluating dynamic, shadowed or ambiguous historical code', async () => {
    const startedAt = '2026-10-28T13:25:38.821Z';
    const candidate = { ref: 'indexed:operation', sessionId: 'operation-session', toolInput: '', startedAt, finishedAt: '' };
    const inspect = async (input: string) => {
      const bytes = Buffer.from([
        { type: 'response_item', timestamp: startedAt,
          payload: { type: 'custom_tool_call', name: 'exec', call_id: 'operation', input } },
        { type: 'response_item', timestamp: '2026-10-28T13:27:01.445Z',
          payload: { type: 'custom_tool_call_output', call_id: 'operation',
            output: JSON.stringify({ exit_code: 0, output: 'operation complete' }) } },
      ].map(row => JSON.stringify(row)).join('\n'));
      const [record] = await recoverHistoricalCensusWriterEvidence([candidate], async () =>
        ({ bytes, sha256: createHash('sha256').update(bytes).digest('hex') }));
      expect(record.terminal?.exitCode).toBe(0);
      expect(record.receipt).toBe('');
      return record.command;
    };
    const constants = 'const root="/arbitrary/source"; const sha="abcd"; const destination=root+"/"+sha;';
    const command = 'let r=await tools.exec_command({cmd:"cp -al "+root+" "+destination,workdir:root}); text(JSON.stringify(r));';
    expect(await inspect(constants + command)).toEqual({ cmd: 'cp -al /arbitrary/source /arbitrary/source/abcd', workdir: '/arbitrary/source' });
    expect(await inspect('text(await tools.exec_command({"cmd":"literal command"}));')).toEqual({ cmd: 'literal command' });
    for (const unknown of [
      constants.replace('const root=', 'let root=') + command,
      constants + 'root="different";' + command,
      constants + command.replace('root+" "+destination', 'root+" "+process.env.DESTINATION'),
      constants + command.replace('cmd:', '...extra,cmd:'),
      constants + command.replace('cmd:', 'cmd:"overridden",cmd:'),
      constants + command.replace('workdir:root', 'workdir:resolve(root)'),
      constants + command + 'await tools.exec_command({cmd:"second command"});',
      constants + 'async function nested(root){' + command + '}',
      'const tools=other;' + constants + command,
      'const {tools}=other;' + constants + command,
      'const {native:tools}=other;' + constants + command,
      constants + 'tools.exec_command=replacement;' + command,
      'const root=readSecret();' + command,
      'const root="unterminated;' + command,
      'const root="/earlier"; const root=dynamic;' + command,
      'const root="/root";' + 'const sha="x".repeat(70_000); const destination=root+sha;' + command,
    ]) expect(await inspect(unknown)).toBeUndefined();
  });
  it('requires a matching successful receipt, private no-follow file and original write window without exposing values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'playwright-state-proof-'));
    const config = join(home, '.config', 'papercusp'); const output = join(config, 'arbitrary-browser.json');
    const state = { cookies: [{ name: 'session', value: 'sensitive-test-cookie', domain: 'app.papercusp.com', path: '/',
      expires: 1788638077, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
    const body = JSON.stringify(state);
    const receipt = { final: { host: 'app.papercusp.com', path: '/cloud-workspaces' },
      session: { status: 200, ok: true, error: null }, storageState: { path: output, mode: '600', bytes: Buffer.byteLength(body) } };
    const record = { ref: 'archive:sha:line463:call-id', toolInput: archivedInput.replaceAll('/fixture/.config/papercusp/arbitrary-browser.json', output),
      startedAt: '2026-09-05T19:49:31.511Z', finishedAt: '2026-09-05T19:49:41.364Z', receipt: JSON.stringify(receipt) };
    try {
      await mkdir(config, { recursive: true }); await writeFile(output, body, { mode: 0o600 });
      await utimes(output, new Date('2026-09-05T19:49:40Z'), new Date('2026-09-05T19:49:40Z'));
      const result = await historicalPlaywrightStateCensusProducer([record], home);
      expect(result.declarations).toEqual([{ kind: 'path', root: 'playwright-state-0', name: 'arbitrary-browser.json',
        classification: 'secret', producer: 'historical-playwright-storage-state:archive:sha:line463:call-id' }]);
      expect(JSON.stringify(result)).not.toContain('sensitive-test-cookie');
      expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: 'null' }], home)).declarations).toEqual([]);
      for (const altered of [
        { ...receipt, session: { status: 401, ok: false, error: 'unauthorized' } },
        { ...receipt, storageState: { ...receipt.storageState, bytes: body.length + 1 } },
        { ...receipt, storageState: { ...receipt.storageState, path: join(config, 'neighbor.json') } },
      ]) expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: JSON.stringify(altered) }], home)).declarations).toEqual([]);
      await chmod(output, 0o644);
      expect((await historicalPlaywrightStateCensusProducer([record], home)).declarations).toEqual([]);
      await chmod(output, 0o600); await utimes(output, new Date(), new Date());
      expect((await historicalPlaywrightStateCensusProducer([record], home)).declarations).toEqual([]);
      await rm(output); await writeFile(join(config, 'neighbor.json'), body, { mode: 0o600 }); await symlink(join(config, 'neighbor.json'), output);
      expect((await historicalPlaywrightStateCensusProducer([record], home)).declarations).toEqual([]);
      await rm(output); await writeFile(output, 'invalid json', { mode: 0o600 }); await utimes(output, new Date(record.startedAt), new Date(record.startedAt));
      expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: JSON.stringify({ ...receipt, storageState: { ...receipt.storageState, bytes: 12 } }) }], home)).declarations).toEqual([]);
      for (const invalid of [null, { cookies: [null], origins: [] }, { ...state, origins: [null] }, { ...state, cookies: [{ ...state.cookies[0], domain: 'elsewhere.test' }] }]) {
        const content = JSON.stringify(invalid); await writeFile(output, content);
        await utimes(output, new Date(record.startedAt), new Date(record.startedAt));
        expect((await historicalPlaywrightStateCensusProducer([{ ...record, receipt: JSON.stringify({ ...receipt, storageState: { ...receipt.storageState, bytes: Buffer.byteLength(content) } }) }], home)).declarations).toEqual([]);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

describe('reaper archive writer census', () => {
  it('looks up old archive identities in bounded exact batches and rejects unrelated returned ids', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-lookup-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive', '2026-10-11');
      await mkdir(archive, { recursive: true });
      await Promise.all(Array.from({ length: 1001 }, (_, n) => writeFile(join(archive, `old-${n}.tail.log`), 'tail')));
      const lookup = vi.fn(async (ids: string[]) => ids.includes('old-0') ? ['old-0', 'unrequested'] : []);
      const result = await reapArchiveCensusProducer(home, [], lookup);
      expect(lookup.mock.calls.map(([ids]) => ids.length)).toEqual([1000, 1]);
      expect(new Set(lookup.mock.calls.flatMap(([ids]) => ids)).size).toBe(1001);
      const tails = result.declarations.filter(row => row.name.endsWith('.tail.log')).map(row => row.name);
      expect(tails).toEqual(['reap-archive/2026-10-11/old-0.tail.log']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('verifies writer receipts after ledger GC and exposes corrupt, mismatched and linked receipts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-receipt-'));
    try {
      const source = join(home, 'source.log');
      await writeFile(source, Buffer.alloc(REAP_TAIL_MAX_BYTES + 20, 'x'));
      const tail = await archiveReapTail('expired-task', source, home, new Date('2026-10-11T12:00:00Z'));
      expect((await readFile(tail)).length).toBe(REAP_TAIL_MAX_BYTES);
      const receiptPath = `${tail}.receipt.json`;
      const original = await readFile(receiptPath, 'utf8');
      const names = async () => (await reapArchiveCensusProducer(home, [])).declarations.map(row => row.name);
      expect(await names()).toContain('reap-archive/2026-10-11/expired-task.tail.log');
      expect(await names()).toContain('reap-archive/2026-10-11/expired-task.tail.log.receipt.json');
      await writeFile(tail, Buffer.alloc(REAP_TAIL_MAX_BYTES, 'y'));
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(tail, Buffer.alloc(REAP_TAIL_MAX_BYTES, 'x'));
      await writeFile(receiptPath, original.replace('expired-task', 'another-task'));
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(receiptPath, 'null');
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(source, original);
      await rm(receiptPath);
      await symlink(source, receiptPath);
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await expect(archiveReapTail('../escape', source, home)).rejects.toThrow('Invalid reaper task id');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('requires retained task identity, regular files and the writer size bound for tails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-census-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive', '2026-10-11');
      await mkdir(archive, { recursive: true });
      await writeFile(join(archive, 'known.tail.log'), 'tail');
      await writeFile(join(archive, 'unknown.tail.log'), 'tail');
      await writeFile(join(archive, 'large.tail.log'), Buffer.alloc(128 * 1024 + 1));
      await symlink(join(archive, 'known.tail.log'), join(archive, 'linked.tail.log'));
      await mkdir(join(archive, 'directory.tail.log'));
      const result = await reapArchiveCensusProducer(home, ['known', 'large', 'linked', 'directory', '../unknown']);
      expect(result.declarations.map(row => row.name)).toEqual([
        'reap-archive', 'reap-archive/2026-10-11', 'reap-archive/2026-10-11/known.tail.log',
      ]);
      expect(result.declarations.every(row => !row.descendants)).toBe(true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('uses OS home and leaves links, invalid dates and unproven tails as residue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-census-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive');
      await mkdir(join(archive, '2026-10-11'), { recursive: true });
      await mkdir(join(archive, '2026-02-30'));
      await mkdir(join(archive, 'unexpected'));
      await writeFile(join(archive, '2026-10-11', 'unknown.tail.log'), 'fixture');
      await symlink(join(archive, '2026-10-11'), join(archive, '2026-10-12'));
      const producer = await reapArchiveCensusProducer(home);
      expect(producer.roots[0].path).toBe(join(home, '.papercusp'));
      expect(producer.declarations.map(row => row.name)).toEqual(['reap-archive', 'reap-archive/2026-10-11']);
      expect(producer.declarations.every(row => !row.descendants)).toBe(true);
      const otherHome = join(home, 'other');
      await mkdir(join(otherHome, '.papercusp'), { recursive: true });
      await symlink(archive, join(otherHome, '.papercusp', 'reap-archive'));
      expect((await reapArchiveCensusProducer(otherHome)).declarations).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

afterEach(() => vi.clearAllMocks());
describe('secret census producer adapters', () => {
  it('discovers historical workspace stores without following linked workspace homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-template-census-'));
    try {
      const home = join(root, 'retired', '.papercusp');
      await mkdir(join(home, 'templates', 'app'), { recursive: true });
      await writeFile(join(home, 'templates', 'app', 'template.yaml'), 'manifest');
      await writeFile(join(home, 'templates', 'app', 'old.ts'), 'historical bytes');
      const source = join(root, 'source.ts');
      await writeFile(source, 'current bytes');
      await symlink(join(root, 'retired'), join(root, 'linked-workspace'));
      await mkdir(join(root, 'linked-home'));
      await symlink(home, join(root, 'linked-home', '.papercusp'));
      const resolver = vi.fn(async (path: string, bytes: Buffer) => path === source && bytes.equals(Buffer.from('historical bytes')));
      const result = await workspaceTemplateStoreCensusProducer(root, new Map([['app/old.ts', source]]), resolver);
      expect(result.roots).toEqual([{ id: 'workspace-template-store:retired', path: home }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/app', 'templates/app/template.yaml', 'templates/app/old.ts'].sort());
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(result.declarations.every(entry => entry.root === result.roots[0].id && !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('proves historical bytes only at the same regular Git source path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'historical-template-identity-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
      git('init', '-q');
      await writeFile(join(root, 'source.ts'), 'old source');
      await writeFile(join(root, 'other.ts'), 'other path only');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'old');
      await writeFile(join(root, 'source.ts'), 'new source');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'new');
      // Deletion and a same-content link at another path do not confer ownership.
      git('rm', '-q', 'source.ts');
      await symlink('other.ts', join(root, 'source.ts'));
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'link');
      const matches = historicalGitBlobIdentityResolver(root);
      expect(await matches(join(root, 'source.ts'), Buffer.from('old source'))).toBe(true);
      expect(await matches(join(root, 'source.ts'), Buffer.from('new source'))).toBe(true);
      expect(await matches(join(root, 'source.ts'), Buffer.from('other path only'))).toBe(false);
      expect(await matches(join(root, 'source.ts'), Buffer.from('other.ts'))).toBe(false);
      expect(await matches(join(root, 'source.ts'), Buffer.from('drift'))).toBe(false);
      expect(await matches(join(root, 'missing.ts'), Buffer.from('old source'))).toBe(false);
      expect(await matches(join(root, '..', 'outside.ts'), Buffer.from('old source'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes exact mirror source while exposing drift, unknown siblings and linked parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'template-identity-census-'));
    try {
      await mkdir(join(root, 'templates', 'app', 'src'), { recursive: true });
      await writeFile(join(root, 'templates', 'app', 'template.yaml'), 'manifest');
      const source = join(root, 'canonical.ts');
      await writeFile(source, 'canonical source');
      await writeFile(join(root, 'templates', 'app', 'src', 'same.ts'), 'canonical source');
      await writeFile(join(root, 'templates', 'app', 'src', 'drift.ts'), 'changed source');
      await writeFile(join(root, 'templates', 'app', 'src', 'unknown.ts'), 'canonical source');
      await symlink(source, join(root, 'templates', 'app', 'src', 'link.ts'));
      await symlink(join(root, 'templates', 'app', 'src'), join(root, 'templates', 'app', 'linked'));
      const expected = new Map(['src/same.ts', 'src/drift.ts', 'src/link.ts', 'linked/same.ts', 'src/missing.ts'].map(name => [`app/${name}`, source]));
      const result = await templateStoreCensusProducer(root, expected);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/app', 'templates/app/template.yaml', 'templates/app/src', 'templates/app/src/same.ts'].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains parsed plan templates while exposing incomplete bundles, links and extra files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-template-census-'));
    try {
      for (const name of ['valid', 'legacy', 'incomplete', 'linked']) await mkdir(join(root, 'plan-templates', name), { recursive: true });
      const valid = join(root, 'plan-templates', 'valid');
      await writeFile(join(valid, 'plan.md'), '---\nslug: fixture\ntitle: Fixture\nstatus: draft\n---\n\n# Fixture\n\n- **P-001** `todo` Build fixture\n');
      await writeFile(join(valid, 'listing.json'), '{}');
      await writeFile(join(valid, 'unknown.ts'), 'source');
      await writeFile(join(root, 'plan-templates', 'legacy', 'plan.md'), '# Legacy');
      await writeFile(join(root, 'plan-templates', 'incomplete', 'listing.json'), '{}');
      await symlink(join(valid, 'plan.md'), join(root, 'plan-templates', 'linked', 'plan.md'));
      await symlink(valid, join(root, 'plan-templates', 'linked-dir'));
      const result = await planTemplateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['plan-templates', 'plan-templates/valid', 'plan-templates/valid/plan.md', 'plan-templates/valid/listing.json'].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes installed template metadata without claiming source, bytecode or incomplete bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'template-store-census-'));
    try {
      for (const name of ['valid', 'incomplete', 'linked-manifest']) await mkdir(join(root, 'templates', name), { recursive: true });
      for (const name of ['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md', 'source.ts', 'module.pyc']) await writeFile(join(root, 'templates', 'valid', name), 'opaque');
      await writeFile(join(root, 'templates', 'incomplete', 'listing.json'), '{}');
      await symlink(join(root, 'templates', 'valid', 'template.yaml'), join(root, 'templates', 'linked-manifest', 'template.yaml'));
      await symlink(join(root, 'templates', 'valid'), join(root, 'templates', 'linked-bundle'));
      const result = await templateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/valid', ...['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md'].map(name => `templates/valid/${name}`)].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      const writer = await readFile(new URL('../cupboard/install-template-core.ts', import.meta.url), 'utf8');
      expect(writer).toContain("existsSync(join(srcDir, 'template.yaml'))");
      const store = await readFile(new URL('../cupboard/template-store.ts', import.meta.url), 'utf8');
      expect(store).toContain("papercuspPath('templates')");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes historical versioned metadata only with matching identity and regular paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-template-census-'));
    try {
      const valid = join(root, 'templates', 'legacy', '0.1.0');
      await mkdir(join(valid, '.harness'), { recursive: true });
      await writeFile(join(valid, 'papercusp.json'), JSON.stringify({ name: 'legacy', version: '0.1.0', kind: 'template' }));
      for (const file of ['SPEC.md', 'README.md', '.published.json', 'unexpected.ts', '.harness/config.json', '.harness/unexpected.ts']) await writeFile(join(valid, file), 'fixture');
      await symlink(join(valid, 'SPEC.md'), join(valid, 'AGENTS.md'));
      await symlink(join(valid, 'SPEC.md'), join(valid, '.harness/validation-contract.md'));
      for (const version of ['0.2.0', 'invalid']) {
        await mkdir(join(root, 'templates', 'legacy', version), { recursive: true });
        await writeFile(join(root, 'templates', 'legacy', version, 'papercusp.json'), JSON.stringify({ name: 'wrong', version, kind: 'template' }));
      }
      await symlink(valid, join(root, 'templates', 'legacy', '0.3.0'));
      const result = await templateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/legacy', 'templates/legacy/0.1.0', ...['papercusp.json', 'SPEC.md', 'README.md', '.published.json', '.harness', '.harness/config.json'].map(file => `templates/legacy/0.1.0/${file}`)].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves completed setup credentials without claiming copied source or unknown homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-census-'));
    try {
      const parent = join(root, 'deploy-credentials');
      const names = ['.codex-setup-acme-1234abcd', '.setup-acme-1234abcd', '.codex-setup-acme-invalid'];
      for (const name of names) await mkdir(join(parent, name), { recursive: true });
      await writeFile(join(parent, names[0], 'auth.json'), 'opaque credential');
      await writeFile(join(parent, names[0], 'source.ts'), 'source');
      await mkdir(join(parent, names[0], 'log'));
      await writeFile(join(parent, names[0], 'log', 'codex-login.log'), 'login diagnostic');
      await writeFile(join(parent, names[0], 'log', 'foreign.log'), 'foreign');
      await symlink(join(parent, names[0]), join(parent, '.codex-setup-link-1234abcd'));
      const result = await cliSetupHomeCensusProducer(root);
      expect(result.declarations.map(entry => [entry.name, entry.classification])).toEqual([
        [`deploy-credentials/${names[0]}`, 'state'],
        [`deploy-credentials/${names[0]}/auth.json`, 'secret'],
        [`deploy-credentials/${names[0]}/log`, 'state'],
        [`deploy-credentials/${names[0]}/log/codex-login.log`, 'state'],
        [`deploy-credentials/${names[1]}`, 'state'],
      ]);
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      await rm(join(parent, names[0], 'log', 'codex-login.log'));
      await symlink(join(parent, names[0], 'auth.json'), join(parent, names[0], 'log', 'codex-login.log'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name))
        .not.toContain(`deploy-credentials/${names[0]}/log/codex-login.log`);
      await rm(join(parent, names[0], 'log'), { recursive: true });
      await symlink(join(parent, names[1]), join(parent, names[0], 'log'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name))
        .not.toContain(`deploy-credentials/${names[0]}/log`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains Claude setup config and backup secrets while exposing foreign files and links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-setup-census-'));
    const name = 'deploy-credentials/.setup-acme-1234abcd';
    const backup = '.claude.json.backup.1794230000000';
    const corrupted = '.claude.json.corrupted.1794230000001';
    try {
      const home = join(root, name);
      await mkdir(join(home, 'backups'), { recursive: true });
      for (const file of ['.claude.json', '.claude.json.backup', backup, `backups/${backup}`, `backups/${corrupted}`,
        'foreign.ts', 'backups/foreign.json', 'backups/.claude.json.backup.invalid']) await writeFile(join(home, file), 'opaque fixture');
      await mkdir(join(home, 'backups', '.claude.json.backup.1794230000002'));
      await symlink(join(home, '.claude.json'), join(home, 'backups', '.claude.json.backup.1794230000003'));
      const result = await cliSetupHomeCensusProducer(root, null);
      expect(result.declarations.filter(entry => entry.classification === 'secret').map(entry => entry.name).sort())
        .toEqual(['.claude.json', '.claude.json.backup', backup, `backups/${backup}`, `backups/${corrupted}`].map(file => `${name}/${file}`).sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        `${name}/foreign.ts`, `${name}/backups/foreign.json`, `${name}/backups/.claude.json.backup.invalid`,
        `${name}/backups/.claude.json.backup.1794230000002`, `${name}/backups/.claude.json.backup.1794230000003`,
      ]));
      await rename(join(home, 'backups'), join(root, 'backup-target'));
      await symlink(join(root, 'backup-target'), join(home, 'backups'));
      await rm(join(home, '.claude.json'));
      await symlink(join(home, '.claude.json.backup'), join(home, '.claude.json'));
      const linked = await cliSetupHomeCensusProducer(root, null);
      expect(linked.declarations.map(entry => entry.name)).not.toContain(`${name}/backups`);
      expect(linked.declarations.map(entry => entry.name)).not.toContain(`${name}/.claude.json`);
      await rename(join(root, 'deploy-credentials'), join(root, 'credential-target'));
      await symlink(join(root, 'credential-target'), join(root, 'deploy-credentials'));
      expect((await cliSetupHomeCensusProducer(root, null)).declarations).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('classifies exact Codex arg0 directories and locks without claiming helpers or foreign descendants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-census-'));
    try {
      const home = 'deploy-credentials/.codex-setup-acme-1234abcd';
      const arg0 = `${home}/tmp/arg0`;
      const session = `${arg0}/codex-arg0PSchFu`;
      await mkdir(join(root, session), { recursive: true });
      await mkdir(join(root, arg0, 'foreign'));
      await writeFile(join(root, session, '.lock'), '');
      await writeFile(join(root, session, 'foreign.txt'), 'foreign');
      await symlink('/unverified/codex', join(root, session, 'apply_patch'));
      await symlink(join(root, session), join(root, arg0, 'codex-arg0ABC123'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).toEqual([
        home, `${home}/tmp`, arg0, session, `${session}/.lock`,
      ]);
      expect((await cliSetupHomeCensusProducer(root)).declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      await rm(join(root, session, '.lock'));
      await symlink(join(root, session, 'foreign.txt'), join(root, session, '.lock'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).not.toContain(`${session}/.lock`);
      await rm(join(root, home, 'tmp'), { recursive: true });
      await symlink(root, join(root, home, 'tmp'));
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).toEqual([home]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('requires helper symlinks to resolve to the selected native Codex executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-identity-'));
    try {
      const session = 'deploy-credentials/.codex-setup-acme-1234abcd/tmp/arg0/codex-arg0ABC123';
      await mkdir(join(root, session), { recursive: true });
      const native = join(root, 'native-codex');
      await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await writeFile(join(root, 'foreign-codex'), 'foreign');
      await symlink(native, join(root, session, 'apply_patch'));
      await symlink(native, join(root, session, 'applypatch'));
      await symlink(join(root, 'foreign-codex'), join(root, session, 'codex-linux-sandbox'));
      await symlink(join(root, 'missing'), join(root, session, 'codex-execve-wrapper'));
      await symlink(native, join(root, session, 'foreign-helper'));
      const names = (await cliSetupHomeCensusProducer(root, native)).declarations.map(entry => entry.name);
      expect(names).toContain(`${session}/apply_patch`);
      expect(names).toContain(`${session}/applypatch`);
      for (const name of ['codex-linux-sandbox', 'codex-execve-wrapper', 'foreign-helper']) expect(names).not.toContain(`${session}/${name}`);
      // The interactive account-link module is mocked to throw in this suite.
      // Default writer selection must still prove the native helpers.
      vi.stubEnv('CODEX_BIN', native);
      expect((await cliSetupHomeCensusProducer(root)).declarations.map(entry => entry.name)).toContain(`${session}/apply_patch`);
      expect((await cliSetupHomeCensusProducer(root, null)).declarations.map(entry => entry.name)).not.toContain(`${session}/apply_patch`);
      const packageRoot = join(root, 'npm-codex');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
      const launcher = join(packageRoot, 'bin/codex.js');
      await writeFile(launcher, '#!/usr/bin/env node\nthrow new Error("must never execute");');
      const cpu = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc';
      const vendor = join(packageRoot, 'vendor', `${cpu}-${os}`, 'bin');
      await mkdir(vendor, { recursive: true });
      await symlink(native, join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).toContain(`${session}/apply_patch`);
      await rm(join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).not.toContain(`${session}/apply_patch`);
      const optionalRoot = join(packageRoot, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`);
      await mkdir(join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin'), { recursive: true });
      await writeFile(join(optionalRoot, 'package.json'), JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }));
      const optionalNative = join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
      await symlink(native, optionalNative);
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).toContain(`${session}/apply_patch`);
      // An installed optional package owns resolution; a stale bundled binary
      // must not classify helpers if the selected optional binary is missing.
      await symlink(native, join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      await rm(optionalNative);
      expect((await cliSetupHomeCensusProducer(root, launcher)).declarations.map(entry => entry.name)).not.toContain(`${session}/apply_patch`);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it('proves helpers from another installed npm Codex without depending on PATH selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-multiple-installs-'));
    try {
      const session = 'deploy-credentials/.codex-setup-acme-1234abcd/tmp/arg0/codex-arg0ABC123';
      await mkdir(join(root, session), { recursive: true });
      const selected = join(root, 'selected-codex');
      await writeFile(selected, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      vi.stubEnv('CODEX_BIN', selected);
      const packageRoot = join(root, 'older-install', 'node_modules', '@openai', 'codex');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      const manifest = { name: '@openai/codex', bin: { codex: 'bin/codex.js' } };
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\nthrow new Error("must never execute");');
      const cpu = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc';
      const vendor = join(packageRoot, 'vendor', `${cpu}-${os}`, 'bin');
      await mkdir(vendor, { recursive: true });
      const native = join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex');
      await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await symlink(native, join(root, session, 'apply_patch'));
      const foreign = join(packageRoot, 'foreign-codex');
      await writeFile(foreign, 'foreign');
      await symlink(foreign, join(root, session, 'applypatch'));
      const names = async (cli?: string | null) => (await cliSetupHomeCensusProducer(root, cli)).declarations.map(entry => entry.name);
      expect(await names()).toContain(`${session}/apply_patch`);
      expect(await names()).not.toContain(`${session}/applypatch`);
      expect(await names(selected)).not.toContain(`${session}/apply_patch`);
      expect(await names(null)).not.toContain(`${session}/apply_patch`);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...manifest, name: 'foreign' }));
      expect(await names()).not.toContain(`${session}/apply_patch`);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await rm(native);
      expect(await names()).not.toContain(`${session}/apply_patch`);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it('proves hoisted optional Codex helpers through their owning CLI package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-hoisted-install-'));
    try {
      const session = 'deploy-credentials/.codex-setup-acme-1234abcd/tmp/arg0/codex-arg0ABC123';
      await mkdir(join(root, session), { recursive: true });
      const selected = join(root, 'selected-codex');
      await writeFile(selected, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      vi.stubEnv('CODEX_BIN', selected);
      const scope = join(root, 'older-install', 'node_modules', '@openai');
      const packageRoot = join(scope, 'codex');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      const manifest = { name: '@openai/codex', bin: { codex: 'bin/codex.js' } };
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\nthrow new Error("must never execute");');
      const cpu = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc';
      const optionalRoot = join(scope, `codex-${process.platform}-${process.arch}`);
      const vendor = join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin');
      await mkdir(vendor, { recursive: true });
      await writeFile(join(optionalRoot, 'package.json'), JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }));
      const native = join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex');
      await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await symlink(native, join(root, session, 'apply_patch'));
      const names = async (cli?: string | null) => (await cliSetupHomeCensusProducer(root, cli)).declarations.map(entry => entry.name);
      expect(await names()).toContain(`${session}/apply_patch`);
      expect(await names(selected)).not.toContain(`${session}/apply_patch`);
      expect(await names(null)).not.toContain(`${session}/apply_patch`);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...manifest, name: 'foreign' }));
      expect(await names()).not.toContain(`${session}/apply_patch`);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await rm(join(optionalRoot, 'package.json'));
      expect(await names()).not.toContain(`${session}/apply_patch`);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(['nested', 'hoisted'])('proves npm-aliased optional Codex helpers (%s)', async layout => {
    const root = await mkdtemp(join(tmpdir(), 'arg0-aliased-install-'));
    try {
      const session = 'deploy-credentials/.codex-setup-acme-1234abcd/tmp/arg0/codex-arg0ABC123';
      await mkdir(join(root, session), { recursive: true });
      const selected = join(root, 'selected-codex');
      await writeFile(selected, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      vi.stubEnv('CODEX_BIN', selected);
      const scope = join(root, 'older-install', 'node_modules', '@openai');
      const packageRoot = join(scope, 'codex');
      await mkdir(join(packageRoot, 'bin'), { recursive: true });
      const packageName = `@openai/codex-${process.platform}-${process.arch}`;
      const nativeVersion = `0.163.0-${process.platform}-${process.arch}`;
      // Published platform packages retain the main package name and are
      // installed under an npm alias named by the owning CLI's manifest.
      const manifest = { name: '@openai/codex', version: '0.163.0', bin: { codex: 'bin/codex.js' },
        optionalDependencies: { [packageName]: `npm:@openai/codex@${nativeVersion}` } };
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\nthrow new Error("must never execute");');
      const optionalRoot = layout === 'nested'
        ? join(packageRoot, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`)
        : join(scope, `codex-${process.platform}-${process.arch}`);
      const cpu = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc';
      const vendor = join(optionalRoot, 'vendor', `${cpu}-${os}`, 'bin');
      await mkdir(vendor, { recursive: true });
      const optionalManifest = { name: '@openai/codex', version: nativeVersion, os: [process.platform], cpu: [process.arch] };
      const optionalJson = join(optionalRoot, 'package.json');
      await writeFile(optionalJson, JSON.stringify(optionalManifest));
      const native = join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex');
      await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await symlink(native, join(root, session, 'apply_patch'));
      const names = async (cli?: string | null) => (await cliSetupHomeCensusProducer(root, cli)).declarations.map(entry => entry.name);
      expect(await names()).toContain(`${session}/apply_patch`);
      expect(await names(selected)).not.toContain(`${session}/apply_patch`);
      expect(await names(null)).not.toContain(`${session}/apply_patch`);
      for (const changed of [
        { name: 'foreign' }, { version: '0.162.0-linux-x64' }, { os: ['foreign'] }, { cpu: ['foreign'] },
      ]) {
        await writeFile(optionalJson, JSON.stringify({ ...optionalManifest, ...changed }));
        expect(await names()).not.toContain(`${session}/apply_patch`);
      }
      await writeFile(optionalJson, JSON.stringify(optionalManifest));
      for (const optionalDependencies of [{}, { [packageName]: 'npm:foreign@0.163.0' }, { [packageName]: 'npm:@openai/codex@0.162.0-linux-x64' }]) {
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...manifest, optionalDependencies }));
        expect(await names()).not.toContain(`${session}/apply_patch`);
      }
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await rm(optionalJson);
      expect(await names()).not.toContain(`${session}/apply_patch`);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it('retains a whole-install artifact inventory beyond the function argument limit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'large-artifact-census-'));
    const base = join(home, '.papercusp', 'test-artifacts');
    const packet = join(base, 'native-router-ABC123');
    const count = 150_000;
    const expected: NativeCustodyGroup[] = [{ id: 'group-0', attempt: 'primary',
      selected: ['/fixture/test.ts'], runner: 'vitest', armed: false, out: null, auxiliary: [] }];
    const contract = { identity: { workspace: 'fixture', harness: 'fixture', runId: 'large-census' }, expected };
    try {
    const retained = retainNativeProofPacket(packet, {
      ...contract, observations: [{ id: 'group-0', out: null, captureComplete: true }],
    });
    await writeFile(join(packet, 'expected.json'), JSON.stringify(contract), { mode: 0o600 });
    await writeFile(join(packet, 'locator.json'), JSON.stringify(retained.locator), { mode: 0o600 });
    const manifestRef = retained.locator.manifest.ref;
    // Keep custody validation independent of this aggregation regression. A
    // validated large manifest must reach the public producer without losing
    // entries or turning its declarations into function arguments.
    const verify = vi.spyOn(nativeProof, 'verifyNativeProofPacket').mockReturnValue({
      ...retained,
      manifest: { ...retained.manifest, segments: Array.from({ length: count }, (_, index) => ({
        index, artifact: { ref: index.toString(16).padStart(64, '0'), sha256: '0'.repeat(64), byteLength: 0 },
        bytesRead: 0, objectsRead: 0,
        bytesReadByFamily: { A: 0, B: 0, C: 0, D: 0, auxiliary: 0 },
        objectsReadByFamily: { A: 0, B: 0, C: 0, D: 0, auxiliary: 0 },
      })) },
    });
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      const result = await runtimeSidefileCensusProducer(home, {});
      const names = result.declarations.filter(entry => entry.producer === 'test-file-native-router-custody')
        .map(entry => entry.name);
      const prefix = 'test-artifacts/native-router-ABC123';
      expect(names).toHaveLength(count + 6);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain(`${prefix}/objects/${manifestRef}`);
      expect(names).toContain(`${prefix}/objects/${'0'.repeat(64)}`);
      expect(names).toContain(`${prefix}/objects/${(count - 1).toString(16).padStart(64, '0')}`);
      expect(verify).toHaveBeenCalledOnce();
    } finally { verify.mockRestore(); }
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('retains exact pacing and gym sidefiles while leaving unknown siblings and links visible', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sidefile-census-'));
    try {
      const pacing = 'google-vertex-gemini-3.1-pro-preview.json';
      const temporary = `${pacing}.tmp-123-12345678-1234-1234-1234-123456789abc`;
      for (const directory of ['provider-pacing', 'template-gym']) await mkdir(join(home, '.papercusp', directory), { recursive: true });
      for (const file of [pacing, `${pacing}.lock`, temporary, `${pacing}.tmp-unknown`, 'unknown']) await writeFile(join(home, '.papercusp', 'provider-pacing', file), 'opaque');
      await writeFile(join(home, '.papercusp', 'template-gym', 'last-run.json'), '{}');
      await symlink(join(home, '.papercusp', 'template-gym', 'last-run.json'), join(home, '.papercusp', 'template-gym', 'runs.jsonl'));
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, '.papercusp', 'fs-mutex-locks'));
      const result = await runtimeSidefileCensusProducer(home, {});
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['provider-pacing', ...[pacing, `${pacing}.lock`, temporary].map(file => `provider-pacing/${file}`), 'template-gym', 'template-gym/last-run.json'].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      const hook = await readFile(new URL('../../../../apps/operator/scripts/hooks/omp/coord-hook.ts', import.meta.url), 'utf8');
      expect(hook).toContain(`'${pacing}'`);
      expect(hook).toContain('`${statePath}.tmp-${process.pid}-${randomUUID()}`');
      const gym = await readFile(new URL('../harness/routines/template-gym-runner.ts', import.meta.url), 'utf8');
      for (const name of ['template-gym', 'last-run.json', 'runs.jsonl']) expect(gym).toContain(`'${name}'`);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('preserves PostHog credentials and identifies release digest caches only in known runtime homes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'release-config-census-'));
    const active = join(home, 'active');
    const inactive = join(home, 'inactive');
    const foreign = join(home, 'foreign');
    const ordinary = join(home, '.papercusp');
    const names = ['posthog.json', 'release-sha256-cache.json', 'release-sha256-cache.json.tmp-123'];
    const rejected = ['posthog.json.bak', 'release-sha256-cache.json.bak',
      'release-sha256-cache.json.tmp-0', 'release-sha256-cache.json.tmp-2147483648',
      'release-sha256-cache.json.tmp-123-copy', 'release-sha256-cache.json.tmp-0123'];
    const bytes = JSON.stringify({ personalApiKey: 'fixture-only', testingFeatures: true });
    try {
      const before = [];
      for (const directory of [ordinary, active, inactive, foreign]) {
        await mkdir(join(directory, 'nested'), { recursive: true });
        for (const name of [...names, ...rejected]) {
          const path = join(directory, name);
          await writeFile(path, bytes, { mode: 0o600 });
          before.push({ path, stat: await lstat(path) });
        }
        await writeFile(join(directory, 'nested', names[2]), bytes);
      }
      await symlink(join(foreign, names[0]), join(inactive, 'release-sha256-cache.json.tmp-456'));
      const linked = join(home, 'linked');
      await symlink(foreign, linked);
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      const sidefiles = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: active }, [foreign], [inactive, linked]);
      const retained = [ordinary, active, inactive].map((directory, index) => {
        const result = runtimeRetainedCensusProducer(directory);
        const id = `retained-${index}`;
        return { roots: result.roots.map(root => ({ ...root, id })),
          declarations: result.declarations.map(row => ({ ...row, root: id })) };
      });
      const combined = mergeNestedCensusRoots({
        roots: [...sidefiles.roots, ...retained.flatMap(result => result.roots)],
        declarations: [...sidefiles.declarations, ...retained.flatMap(result => result.declarations)],
      });
      const census = await collectStateCensus({ ...combined, readCatalogs: async () => [] });
      for (const directory of [ordinary, active, inactive]) {
        const root = combined.roots.find(root => root.path === directory)!;
        for (const name of names) {
          expect(census.inventory.find(row => row.root === root.id && row.name === name))
            .toMatchObject({ classification: name === 'posthog.json' ? 'secret' : 'cache', problem: null });
          const declaration = combined.declarations.find(row => row.root === root.id && row.name === name)!;
          expect(declaration.descendants).toBeUndefined();
          expect(declaration.prune).toBeUndefined();
        }
        const residue = census.residue.filter(row => row.root === root.id).map(row => row.name);
        expect(residue).toEqual(expect.arrayContaining([...rejected, 'nested', `nested/${names[2]}`]));
      }
      expect(sidefiles.roots.some(root => [foreign, linked].includes(root.path))).toBe(false);
      const inactiveRoot = combined.roots.find(root => root.path === inactive)!;
      expect(census.residue).toContainEqual(expect.objectContaining({ root: inactiveRoot.id,
        name: 'release-sha256-cache.json.tmp-456', problem: 'unclassified' }));
      for (const { path, stat } of before) {
        expect(await readFile(path, 'utf8')).toBe(bytes);
        const after = await lstat(path);
        for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(stat[field]);
      }
      expect(await readlink(join(inactive, 'release-sha256-cache.json.tmp-456'))).toBe(join(foreign, names[0]));
      const configWriter = await readFile(new URL('../endpoint-route/routes/flags/testing-features.ts', import.meta.url), 'utf8');
      expect(configWriter).toContain("papercuspPath('posthog.json')");
      expect(configWriter).toContain('await fs.promises.writeFile(');
      const cacheWriter = await readFile(new URL('../../../../apps/operator/lib/release/record-release-cli.ts', import.meta.url), 'utf8');
      expect(cacheWriter).toContain("papercuspPath('release-sha256-cache.json')");
      expect(cacheWriter).toContain('`${SHA_CACHE_PATH}.tmp-${process.pid}`');
      expect(cacheWriter).toContain('fs.renameSync(tmp, SHA_CACHE_PATH)');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('retains exact selected identity and migration sidefiles without claiming external siblings or linked paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'selected-sidefiles-census-'));
    const external = join(home, 'external');
    const identity = join(external, 'chosen-identity.json');
    const cooldown = join(external, 'chosen-cooldown.json');
    try {
      await mkdir(external);
      await mkdir(join(home, '.papercusp'));
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      const { resolveLocalAnnounceIdentity } = await import('../sync/hyperbee/local-announce-identity');
      await resolveLocalAnnounceIdentity({ logCoreKeyHex: 'ab'.repeat(32), identityMode: 'authoring', cachePath: identity,
        resolveGithubUser: async () => ({ id: 123, login: 'census-fixture' }),
        buildKeychainId: () => '123:fixture-device',
        loadKeypair: async keychainId => ({ keychainId, pubkeyBase64: Buffer.alloc(32, 7).toString('base64') }),
        resolveAttestationGistId: async () => 'fixture-gist' });
      await writeFile(cooldown, JSON.stringify({ '001.sql': { lastFailedAt: 1234, attempts: 1, error: 'fixture' } }));
      await writeFile(`${identity}.bak`, await readFile(identity));
      await writeFile(join(external, 'foreign'), 'unrelated');
      const paths = [identity, cooldown];
      const before = await Promise.all(paths.map(async path => ({ path, bytes: await readFile(path), stat: await lstat(path) })));
      for (const relativePaths of [false, true]) {
        const environment = { PAPERCUSP_ANNOUNCE_IDENTITY_CACHE: relativePaths ? relative(process.cwd(), identity) : identity,
          PAPERCUSP_MIGRATION_COOLDOWN_FILE: relativePaths ? relative(process.cwd(), cooldown) : cooldown };
        const result = await runtimeSidefileCensusProducer(home, environment);
        const selected = result.roots.find(root => root.path === external);
        expect(selected?.fileNames?.sort()).toEqual(paths.map(path => basename(path)).sort());
        const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
        expect(census.inventory.filter(entry => entry.root === selected?.id).map(entry => entry.name).sort())
          .toEqual(paths.map(path => basename(path)).sort());
        for (const [path, producer] of [[identity, 'local-announce-identity'], [cooldown, 'boot-migration-cooldown']]) {
          expect(census.inventory.find(entry => entry.root === selected?.id && entry.name === basename(path)))
            .toMatchObject({ classification: 'state', producers: [producer] });
          const declaration = result.declarations.find(entry => entry.root === selected?.id && entry.name === basename(path));
          expect(declaration?.descendants).toBeUndefined();
          expect(declaration?.prune).toBeUndefined();
        }
      }
      for (const { path, bytes, stat } of before) {
        expect(await readFile(path)).toEqual(bytes);
        const after = await lstat(path);
        for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(stat[field]);
      }
      const linked = join(home, 'linked-parent');
      await symlink(external, linked);
      await symlink(identity, join(external, 'linked-identity'));
      for (const selectedPath of [join(linked, basename(identity)), join(external, 'linked-identity'), external, join(home, 'absent')]) {
        const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_ANNOUNCE_IDENTITY_CACHE: selectedPath });
        expect(result.declarations.some(entry => entry.producer === 'local-announce-identity')).toBe(false);
      }
      expect((await runtimeSidefileCensusProducer(home, { PAPERCUSP_ANNOUNCE_IDENTITY_CACHE: '',
        PAPERCUSP_MIGRATION_COOLDOWN_FILE: '' })).roots.some(root => root.path === external)).toBe(false);
      const source = await readFile(new URL('../db-boot-migrate.ts', import.meta.url), 'utf8');
      expect(source).toContain("env.PAPERCUSP_MIGRATION_COOLDOWN_FILE || papercuspPath('migration-failure-cooldown.json')");
      expect(source).toContain('await writeFile(path, JSON.stringify(state)');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('excludes relocated host mutex ownership from transport while preserving unknown siblings and live bytes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mutex-census-'));
    const mutex = join(home, 'runtime', 'relocated-locks');
    try {
      await mkdir(join(home, '.papercusp'), { recursive: true });
      await mkdir(join(mutex, 'live.lock'), { recursive: true });
      await writeFile(join(mutex, 'live.lock', 'owner.json'), 'live owner fixture');
      await writeFile(join(home, 'runtime', 'foreign'), 'unproven fixture');
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', mutex);
      const result = await runtimeSidefileCensusProducer(home, {});
      const report = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(report.inventory.find(entry => entry.name === 'relocated-locks')).toMatchObject({ classification: 'cache',
        producers: ['filesystem-mutex-runtime'] });
      expect(report.inventory.some(entry => entry.name.startsWith('relocated-locks/'))).toBe(false);
      expect(report.residue.map(entry => entry.name)).toContain('foreign');
      expect(await readFile(join(mutex, 'live.lock', 'owner.json'), 'utf8')).toBe('live owner fixture');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('censuses exact bundle and TUI cache writers while preserving unknown contents and symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'runtime-cache-census-'));
    const cache = join(home, '.papercusp', 'cache');
    const bundle = join(cache, 'bundle-free-refs');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      await mkdir(bundle, { recursive: true });
      const digest = 'a'.repeat(64);
      const known = [`${digest}.json`, `${digest}.json.123.tmp`];
      for (const name of [...known, 'unknown.json', `${digest.toUpperCase()}.json`, `${digest}.json.bad.tmp`]) {
        await writeFile(join(bundle, name), '{}');
      }
      await symlink(join(bundle, known[0]), join(bundle, `${'b'.repeat(64)}.json`));
      await mkdir(join(bundle, `${'c'.repeat(64)}.json`));
      await writeFile(join(cache, 'plans-list-standard-v1.json'), '{}');
      await writeFile(join(cache, '.plans-list-standard-v1.123.tmp'), '{}');
      await writeFile(join(cache, 'unknown.json'), '{}');
      await symlink(join(cache, 'unknown.json'), join(cache, '.plans-list-standard-v1.456.tmp'));
      const result = await runtimeSidefileCensusProducer(home, {});
      expect(result.declarations.map(entry => entry.name).sort()).toEqual([
        'cache', 'cache/plans-list-standard-v1.json', 'cache/.plans-list-standard-v1.123.tmp',
        'cache/bundle-free-refs', ...known.map(name => `cache/bundle-free-refs/${name}`),
      ].sort());
      expect(result.declarations.every(entry => entry.classification === 'cache' && !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'cache/unknown.json', 'cache/.plans-list-standard-v1.456.tmp',
        'cache/bundle-free-refs/unknown.json', `cache/bundle-free-refs/${'b'.repeat(64)}.json`,
        `cache/bundle-free-refs/${'c'.repeat(64)}.json`,
      ]));
      // A recognized directory name never licenses following a directory link.
      await rename(bundle, join(home, 'bundle-target'));
      await symlink(join(home, 'bundle-target'), bundle);
      expect((await runtimeSidefileCensusProducer(home, {})).declarations.some(entry => entry.name.startsWith('cache/bundle-free-refs'))).toBe(false);
      await rename(cache, join(home, 'cache-target'));
      await symlink(join(home, 'cache-target'), cache);
      expect((await runtimeSidefileCensusProducer(home, {})).declarations).toEqual([]);
      const writer = await readFile(new URL('../../../../scripts/check-bundle-free-refs.mjs', import.meta.url), 'utf8');
      expect(writer).toContain("join(homedir(), '.papercusp', 'cache', 'bundle-free-refs')");
      expect(writer).toContain('`${file}.${process.pid}.tmp`');
      const queryWriter = await readFile(new URL('../../../../apps/tui/src/shared_cache.rs', import.meta.url), 'utf8');
      expect(queryWriter).toContain('h.join(".papercusp").join("cache")');
      expect(queryWriter).toContain('format!(".{key}.{}.tmp", std::process::id())');
      expect(await readFile(new URL('../../../../apps/tui/src/client.rs', import.meta.url), 'utf8')).toContain('"plans-list-standard-v1"');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  describe('OAuth registration census evidence', () => {
    it.each(['configured', 'registered'])('inventories the full %s runtime home when it also contains a referenced secret', async variant => {
      const home = await mkdtemp(join(tmpdir(), 'oauth-runtime-root-census-'));
      const ordinary = join(home, '.papercusp');
      const runtime = join(home, 'runtime');
      try {
        await mkdir(ordinary);
        await mkdir(join(runtime, 'unknown-directory'), { recursive: true });
        await mkdir(join(runtime, 'test-artifacts', 'testing-run', 'retained'), { recursive: true });
        const target = join(runtime, 'credential');
        await writeFile(target, 'fixture credential', { mode: 0o600 });
        await writeFile(join(ordinary, 'oauth-apps.json'), JSON.stringify({ custom: {
          clientId: 'fixture', clientSecretFile: target,
        } }));
        await writeFile(join(runtime, 'operator-port.json'), JSON.stringify({ port: 3170, updatedAt: 1 }));
        await writeFile(join(runtime, 'endpoint-ipc.3170.json'), '{}');
        await writeFile(join(runtime, 'test-artifacts', 'testing-run', 'retained', 'proof'), 'fixture proof');
        await writeFile(join(runtime, 'unknown'), 'unclassified');
        await writeFile(join(runtime, 'unknown-directory', 'nested'), 'unclassified');
        const result = await runtimeSidefileCensusProducer(home,
          variant === 'configured' ? { PAPERCUSP_HOME: runtime } : {}, [],
          variant === 'registered' ? [runtime] : []);
        expect(result.roots.find(root => root.path === runtime)?.fileNames).toBeUndefined();
        const census = await collectStateCensus({ ...mergeNestedCensusRoots(result), readCatalogs: async () => [] });
        const atRuntime = census.inventory.filter(entry => result.roots.find(root => root.id === entry.root)?.path === runtime);
        expect(atRuntime).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'credential', classification: 'secret' }),
          expect.objectContaining({ name: 'operator-port.json', classification: 'config' }),
          expect.objectContaining({ name: 'endpoint-ipc.3170.json', classification: 'cache' }),
          expect.objectContaining({ name: 'test-artifacts/testing-run', classification: 'state' }),
          expect.objectContaining({ name: 'unknown', classification: null }),
          expect.objectContaining({ name: 'unknown-directory/nested', classification: null }),
        ]));
        expect(census.representedSubtrees).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'test-artifacts/testing-run', disposition: 'preserve-state-subtree' }),
        ]));
        expect(census.residue.map(entry => entry.name).sort()).toEqual(['unknown', 'unknown-directory', 'unknown-directory/nested']);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('retains registrations and exact referenced secrets across known runtime homes without changing bytes', async () => {
      const home = await mkdtemp(join(tmpdir(), 'oauth-registration-census-'));
      const ordinary = join(home, '.papercusp');
      const relocated = join(home, 'relocated');
      const registered = join(home, 'workspace', '.papercusp');
      const foreign = join(home, 'foreign');
      const secrets = join(home, 'external-secrets');
      try {
        await mkdir(secrets);
        const target = join(secrets, 'arbitrary-client-credential');
        await writeFile(target, 'fixture credential\n', { mode: 0o600 });
        await writeFile(join(secrets, 'unreferenced'), 'unknown');
        const body = JSON.stringify({ custom: { clientId: 'fixture', clientSecretFile: target } });
        const files = [target];
        for (const directory of [ordinary, relocated, registered, foreign]) {
          await mkdir(directory, { recursive: true });
          const path = join(directory, 'oauth-apps.json');
          await writeFile(path, body, { mode: 0o600 });
          await writeFile(join(directory, 'unknown.json'), body);
          files.push(path);
        }
        const before = await Promise.all(files.map(async path => ({ bytes: await readFile(path), stat: await lstat(path) })));
        const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated }, [foreign], [registered]);
        const entries = result.declarations.filter(entry => entry.producer === 'oauth-client-registration');
        const paths = entries.map(entry => join(result.roots.find(root => root.id === entry.root)!.path, entry.name));
        expect(new Set(paths)).toEqual(new Set([target, ...[ordinary, relocated, registered].map(path => join(path, 'oauth-apps.json'))]));
        // The focused probe shares the integrated validator and existing roots.
        // It must neither add a second root for a known home nor expose secrets.
        const focusedRoots = [{ id: 'existing-runtime', path: registered }];
        const focused = await oauthRegistrationCensusDeclarations(new Set([ordinary, relocated, registered]), focusedRoots);
        expect(new Set(focused.map(entry => join(focusedRoots.find(root => root.id === entry.root)!.path, entry.name))))
          .toEqual(new Set(paths));
        expect(focusedRoots.filter(root => root.path === registered)).toEqual([{ id: 'existing-runtime', path: registered }]);
        expect(JSON.stringify({ focused, focusedRoots })).not.toContain('fixture credential');
        expect(entries.every(entry => entry.classification === 'secret' && !entry.descendants && !entry.prune)).toBe(true);
        expect(result.roots.find(root => root.path === secrets)?.fileNames).toEqual(['arbitrary-client-credential']);
        const census = await collectStateCensus({ ...mergeNestedCensusRoots(result), readCatalogs: async () => [] });
        expect(census.residue.map(entry => entry.name)).toEqual(['unknown.json', 'unknown.json', 'unknown.json']);
        for (const [index, path] of files.entries()) {
          expect(await readFile(path)).toEqual(before[index].bytes);
          const after = await lstat(path);
          expect([after.ino, after.size, after.mode, after.mtimeMs, after.ctimeMs]).toEqual(
            [before[index].stat.ino, before[index].stat.size, before[index].stat.mode, before[index].stat.mtimeMs, before[index].stat.ctimeMs]);
        }
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('honors inline-secret precedence and the writer atomic-file contract', async () => {
      const home = await mkdtemp(join(tmpdir(), 'oauth-precedence-census-'));
      const ordinary = join(home, '.papercusp');
      try {
        await mkdir(ordinary);
        const unused = join(home, 'unused');
        await writeFile(unused, 'fixture');
        const body = JSON.stringify({ custom: { clientId: 'fixture', clientSecret: 'inline fixture', clientSecretFile: unused } });
        await writeFile(join(ordinary, 'oauth-apps.json'), body);
        await writeFile(join(ordinary, 'oauth-apps.json.123.aabbccddeeff.tmp'), '{}');
        await writeFile(join(ordinary, 'oauth-apps.json.123.not-hex.tmp'), body);
        const result = await runtimeSidefileCensusProducer(home, {});
        expect(result.declarations.filter(entry => entry.producer === 'oauth-client-registration').map(entry => entry.name).sort())
          .toEqual(['oauth-apps.json', 'oauth-apps.json.123.aabbccddeeff.tmp'].sort());
        expect(result.roots.some(root => root.fileNames?.includes('unused'))).toBe(false);
        const writer = await readFile(new URL('../integrations/oauth-client-registration.ts', import.meta.url), 'utf8');
        expect(writer).toContain('`${target}.${process.pid}.${randomBytes(6).toString(\'hex\')}.tmp`');
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['malformed', 'array', 'foreign', 'oversized', 'linked-registry', 'linked-home', 'linked-parent',
      'linked-secret', 'linked-secret-parent', 'missing-secret', 'relative-secret', 'directory-secret'])
    ('preserves unresolved OAuth ownership boundaries: %s', async variant => {
      const home = await mkdtemp(join(tmpdir(), 'oauth-boundary-census-'));
      const ordinary = join(home, '.papercusp');
      try {
        await mkdir(ordinary);
        const secrets = join(home, 'secrets');
        await mkdir(secrets);
        const target = join(secrets, 'credential');
        await writeFile(target, 'fixture');
        let ref = target;
        let directory = ordinary;
        if (variant === 'linked-secret') { ref = join(secrets, 'link'); await symlink(target, ref); }
        if (variant === 'linked-secret-parent') { await symlink(secrets, join(home, 'linked-secrets')); ref = join(home, 'linked-secrets', 'credential'); }
        if (variant === 'missing-secret') ref = join(secrets, 'missing');
        if (variant === 'relative-secret') ref = 'secrets/credential';
        if (variant === 'directory-secret') ref = secrets;
        let body = JSON.stringify({ custom: { clientId: 'fixture', clientSecretFile: ref } });
        if (variant === 'malformed') body = '{';
        if (variant === 'array') body = JSON.stringify([{ clientId: 'fixture', clientSecretFile: ref }]);
        if (variant === 'foreign') body = JSON.stringify({ custom: { clientSecretFile: ref } });
        if (variant === 'oversized') body += ' '.repeat(1024 * 1024);
        await writeFile(join(ordinary, 'oauth-apps.json'), body);
        if (variant === 'linked-registry') {
          await rename(join(ordinary, 'oauth-apps.json'), join(home, 'registry'));
          await symlink(join(home, 'registry'), join(ordinary, 'oauth-apps.json'));
        }
        if (variant === 'linked-home' || variant === 'linked-parent') {
          await rename(ordinary, join(home, 'real-home'));
          if (variant === 'linked-home') await symlink(join(home, 'real-home'), ordinary);
          else {
            await mkdir(join(home, 'real-parent'));
            await rename(join(home, 'real-home'), join(home, 'real-parent', 'runtime'));
            await symlink(join(home, 'real-parent'), join(home, 'linked-parent'));
            directory = join(home, 'linked-parent', 'runtime');
          }
        }
        const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: directory });
        const entries = result.declarations.filter(entry => entry.producer === 'oauth-client-registration');
        expect(entries.filter(entry => entry.name !== 'oauth-apps.json')).toEqual([]);
        if (['malformed', 'array', 'foreign', 'oversized', 'linked-registry', 'linked-home', 'linked-parent'].includes(variant))
          expect(entries).toEqual([]);
        else expect(entries).toHaveLength(1);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  });
  it('retains exact project MCP writer files as secrets at explicit homes and workspace roots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'project-mcp-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const workspace = join(home, 'workspace', '.papercusp');
    const unknown = join(home, 'unknown');
    const linked = join(home, 'linked');
    const superuser = JSON.stringify({ mcpServers: { papercusp: {
      url: 'http://localhost:3070/api/mcp?superuser=1&workspace=fixture', headers: { Authorization: 'Bearer fixture' },
    } } });
    const role = JSON.stringify({ mcpServers: { papercusp: { type: 'http',
      url: 'https://operator.example/api/mcp?workspace=fixture&role=test&run=r&spawn=s&client=c&exp=1&sig=fixture',
    } } });
    const names = ['.mcp.json', '.mcp.json.papercusp.bak', '.mcp.json.su-parked',
      '.mcp.json.tmp-123-1234567890-aabbccddeeff', '.mcp.json.su-stub.123.12345678-1234-4234-8234-123456789abc.tmp'];
    try {
      for (const directory of [ordinary, relocated, workspace, unknown]) {
        await mkdir(directory, { recursive: true });
        for (const name of names) await writeFile(join(directory, name), name.includes('su-stub')
          ? JSON.stringify({ mcpServers: {} }) : name.endsWith('su-parked') ? role : superuser);
      }
      await symlink(workspace, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated }, [workspace, workspace, linked]);
      const entries = result.declarations.filter(entry => entry.producer === 'console-project-mcp-writer');
      expect(entries).toHaveLength(names.length * 3);
      expect(entries.every(entry => entry.classification === 'secret' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.map(root => root.path).sort()).toEqual([ordinary, relocated, workspace].sort());
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue).toEqual([]);
      expect((await runtimeSidefileCensusProducer(home, {})).roots.map(root => root.path)).toEqual([ordinary]);
      const consoleWriter = await readFile(new URL('../console-spawn.ts', import.meta.url), 'utf8');
      const launcher = await readFile(new URL('../../../../apps/operator/scripts/psu-launcher.mjs', import.meta.url), 'utf8');
      expect(consoleWriter).toContain("'.mcp.json.papercusp.bak'");
      expect(consoleWriter).toContain('`.mcp.json.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString(\'hex\')}`');
      expect(launcher).toContain('".mcp.json.su-parked"');
      expect(launcher).toContain('`.mcp.json.su-stub.${process.pid}.${randomUUID()}.tmp`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('leaves malformed, foreign, oversized and linked project MCP files in census residue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'foreign-project-mcp-census-'));
    const workspace = join(home, 'workspace');
    const valid = JSON.stringify({ mcpServers: { papercusp: { url: 'http://localhost/api/mcp?superuser=1&workspace=fixture' } } });
    try {
      await mkdir(workspace);
      const unknownNames = ['.mcp.json.stale-role-bak-20260629-153755', '.mcp.json.pre-papercusp',
        '.mcp.json.tmp-123-1234567890-not-hex', '.mcp.json.su-stub.123.not-a-uuid.tmp'];
      for (const name of unknownNames) await writeFile(join(workspace, name), valid);
      await writeFile(join(workspace, '.mcp.json'), '{');
      await symlink(join(workspace, '.mcp.json'), join(workspace, '.mcp.json.papercusp.bak'));
      await mkdir(join(workspace, '.mcp.json.su-parked'));
      const directories: string[] = [];
      const bodies = [JSON.stringify({ mcpServers: { foreign: {} } }),
        valid.replace('/api/mcp?', '/other?'), valid.replace('superuser=1&', ''),
        valid.replace('http:', 'file:'), JSON.stringify({ mcpServers: { papercusp: { command: 'foreign' } } }),
        JSON.stringify({ mcpServers: [] }), JSON.stringify({ mcpServers: {}, unrelated: true }),
        valid + ' '.repeat(65_536)];
      for (const [index, body] of bodies.entries()) {
        const directory = join(home, `negative-${index}`); directories.push(directory);
        await mkdir(directory); await writeFile(join(directory, '.mcp.json'), body);
      }
      const parent = join(home, 'parent-link');
      await mkdir(join(home, 'real', 'child'), { recursive: true });
      await writeFile(join(home, 'real', 'child', '.mcp.json'), valid);
      await symlink(join(home, 'real'), parent);
      directories.push(join(parent, 'child'));
      const result = await runtimeSidefileCensusProducer(home, {}, [workspace, ...directories]);
      expect(result.declarations.filter(entry => entry.producer === 'console-project-mcp-writer')).toEqual([]);
      const census = await collectStateCensus({ roots: [{ id: 'workspace', path: workspace }],
        declarations: result.declarations, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name).sort()).toEqual([
        ...unknownNames, '.mcp.json', '.mcp.json.papercusp.bak', '.mcp.json.su-parked',
      ].sort());
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('classifies empty legacy console leases only at explicit writer roots and preserves foreign residue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'console-sentinel-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const workspace = join(home, 'workspace', '.papercusp');
    const linked = join(home, 'linked');
    const marker = '.papercup-console-active.123';
    try {
      for (const directory of [ordinary, relocated, workspace]) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, marker), '');
      }
      const foreign = ['.papercup-console-active.0', '.papercup-console-active.01',
        '.papercup-console-active.2147483648', '.papercup-console-active.$',
        '.papercup-console-active.124', '.papercup-console-active.125', 'owner-data'];
      for (const name of foreign) await writeFile(join(workspace, name), name.endsWith('.124') ? 'retained data' : '');
      await rm(join(workspace, '.papercup-console-active.125'));
      await symlink(join(ordinary, marker), join(workspace, '.papercup-console-active.125'));
      await mkdir(join(workspace, 'nested'));
      await writeFile(join(workspace, 'nested', marker), '');
      await mkdir(join(workspace, '.papercup-console-active.126'));
      await symlink(workspace, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated }, [workspace, workspace, linked]);
      const sentinels = result.declarations.filter(entry => entry.producer === 'console-spawn-legacy-sentinel');
      expect(sentinels).toHaveLength(3);
      expect(sentinels.every(entry => entry.name === marker && entry.classification === 'cache'
        && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.map(root => root.path).sort()).toEqual([ordinary, relocated, workspace].sort());
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      const workspaceRoot = result.roots.find(root => root.path === workspace)!.id;
      expect(census.inventory.find(entry => entry.root === workspaceRoot && entry.name === marker)?.classification).toBe('cache');
      expect(census.residue.filter(entry => entry.root === workspaceRoot).map(entry => entry.name).sort())
        .toEqual([...foreign, 'nested', `nested/${marker}`, '.papercup-console-active.126'].sort());
      expect((await runtimeSidefileCensusProducer(home, {})).roots.map(root => root.path)).toEqual([ordinary]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('censuses hook session records at default and relocated paths without owning foreign files or links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'session-record-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'configured-home');
    const override = join(home, 'ledger-override');
    const advisory = join(ordinary, 'advisory-seen');
    const ledgers = [join(ordinary, 'artifact-url-ledger'), join(relocated, 'artifact-url-ledger'), override];
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      await mkdir(advisory, { recursive: true });
      await writeFile(join(advisory, 'nested-session_1'), 'adv-fixture');
      await writeFile(join(advisory, 'bad key'), 'foreign');
      await writeFile(join(advisory, 'x'.repeat(121)), 'foreign');
      await mkdir(join(advisory, 'copied-source'));
      await writeFile(join(advisory, 'copied-source', 'index.ts'), 'foreign');
      await symlink(join(advisory, 'nested-session_1'), join(advisory, 'linked-session'));
      const { ledgerPathFor, appendLedger } = await import('../../../../apps/operator/scripts/hooks/cc/artifact-url-delivery-guard.mjs');
      for (const directory of ledgers) {
        const path = ledgerPathFor('session /1', { PAPERCUSP_ARTIFACT_LEDGER_DIR: directory });
        appendLedger(path, ['fixture-artifact-id']);
        await writeFile(join(directory, 'unknown.json'), 'foreign');
        await writeFile(join(directory, `${'x'.repeat(121)}.ids`), 'foreign');
        await mkdir(join(directory, 'copied.ids'));
        await writeFile(join(directory, 'copied.ids', 'source.ts'), 'foreign');
        await symlink(path, join(directory, 'linked.ids'));
      }
      const environment = { PAPERCUSP_HOME: relocated, PAPERCUSP_ARTIFACT_LEDGER_DIR: override };
      const result = await runtimeSidefileCensusProducer(home, environment);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      const state = census.inventory.filter(entry => entry.classification === 'state');
      expect(state.map(entry => entry.name).sort()).toEqual([
        'advisory-seen', 'advisory-seen/nested-session_1', 'artifact-url-ledger',
        'artifact-url-ledger/session__1.ids', 'session__1.ids', 'session__1.ids',
      ].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'advisory-seen/bad key', 'advisory-seen/linked-session', 'advisory-seen/copied-source/index.ts',
        'artifact-url-ledger/unknown.json', 'linked.ids', 'copied.ids/source.ts',
      ]));
      expect(await readFile(join(ledgers[0], 'session__1.ids'), 'utf8')).toBe('fixture-artifact-id\n');
      await rename(ledgers[0], join(home, 'ledger-target'));
      await symlink(join(home, 'ledger-target'), ledgers[0]);
      await rename(advisory, join(home, 'advisory-target'));
      await symlink(join(home, 'advisory-target'), advisory);
      await rename(override, join(home, 'override-target'));
      await symlink(join(home, 'override-target'), override);
      const linked = await runtimeSidefileCensusProducer(home, environment);
      expect(linked.declarations.some(entry => entry.name.startsWith('advisory-seen') || entry.name.startsWith('artifact-url-ledger'))).toBe(false);
      expect(linked.roots.some(entry => entry.path === override)).toBe(false);
      const writer = await readFile(new URL('../../../../apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh', import.meta.url), 'utf8');
      expect(writer).toContain("return os.path.join(os.path.expanduser('~'), '.papercusp', 'advisory-seen')");
      expect(writer).toContain("return re.sub(r'[^A-Za-z0-9_.-]', '_', str(sid))[:120]");
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('excludes exact endpoint advertisements across host relocation while exposing hostile neighbors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'endpoint-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'isolated-host');
    const uuid = '12345678-1234-4123-8123-123456789abc';
    const names = ['endpoint-ipc.json', 'endpoint-ipc.3170.json', `endpoint-ipc.3170.json.${uuid}.tmp`];
    const unknown = ['endpoint-ipc.65536.json', 'endpoint-ipc.0.json', 'endpoint-ipc.foo.json',
      'endpoint-ipc.json.backup', 'endpoint-ipc.json.invalid.tmp', 'unproven.json'];
    try {
      for (const directory of [ordinary, relocated]) {
        await mkdir(directory);
        for (const name of [...names, ...unknown]) await writeFile(join(directory, name), 'process advertisement fixture');
        await symlink(join(directory, names[0]), join(directory, 'endpoint-ipc.3070.json'));
        await mkdir(join(directory, 'endpoint-ipc.4000.json'));
      }
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated });
      const owned = result.declarations.filter(entry => entry.producer === 'endpoint-ipc-discovery');
      expect(owned).toHaveLength(6);
      expect(owned.every(entry => names.includes(entry.name) && entry.classification === 'cache' && !entry.descendants)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.classification === 'cache')).toHaveLength(6);
      for (const name of [...unknown, 'endpoint-ipc.3070.json', 'endpoint-ipc.4000.json']) {
        expect(census.residue.filter(entry => entry.name === name)).toHaveLength(2);
      }
      await rename(relocated, `${relocated}-target`);
      await symlink(`${relocated}-target`, relocated);
      expect((await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated })).declarations
        .filter(entry => entry.producer === 'endpoint-ipc-discovery')).toHaveLength(3);
      const writer = await readFile(new URL('../endpoint-ipc-discovery.ts', import.meta.url), 'utf8');
      for (const source of ['return papercuspHome()', "const REL_FILE = 'endpoint-ipc.json'",
        '`endpoint-ipc.${port}.json`', '`${path}.${randomUUID()}.tmp`']) expect(writer).toContain(source);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('classifies desktop process markers and durable target using their actual homes and display payloads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'desktop-census-'));
    const real = join(home, 'real-user');
    const channel = join(real, '.papercusp-nightly');
    const override = join(home, 'host-override');
    const ordinary = join(real, '.papercusp');
    const channelState = join(channel, '.papercusp');
    const report = (display: string) => JSON.stringify({ version: '0.0.1', pid: 42, startedAtMs: 123,
      display, role: 'gui', isDev: false });
    try {
      for (const directory of [ordinary, channelState, override]) await mkdir(directory, { recursive: true });
      for (const directory of [ordinary, channelState]) {
        await writeFile(join(directory, 'desktop-app-version.json'), report(''));
        await writeFile(join(directory, 'desktop-app-version-110_0.json'), report(':110.0'));
        await writeFile(join(directory, 'desktop-app-version-foreign.json'), report(':other'));
        await writeFile(join(directory, 'desktop-app-version-invalid.json'), '{}');
        await writeFile(join(directory, 'desktop-build-target.json'), '{"name":"staging","port":3170}');
        await writeFile(join(directory, 'desktop-build-target.json.bak'), 'unknown');
        await symlink(join(directory, 'desktop-app-version.json'), join(directory, 'desktop-app-version-link.json'));
      }
      // PAPERCUSP_HOME does not relocate either Rust desktop writer.
      await writeFile(join(override, 'desktop-build-target.json'), 'unknown');
      await writeFile(join(override, 'desktop-app-version.json'), report(''));
      const result = await runtimeSidefileCensusProducer(channel, { HOME: real, PAPERCUSP_HOME: override });
      const reports = result.declarations.filter(entry => entry.producer === 'desktop-app-version-report');
      expect(reports).toHaveLength(4);
      expect(reports.every(entry => entry.classification === 'cache' && !entry.descendants)).toBe(true);
      const targets = result.declarations.filter(entry => entry.producer === 'desktop-env-switch-target');
      expect(targets).toHaveLength(1);
      expect(result.roots.find(root => root.id === targets[0].root)?.path).toBe(ordinary);
      expect(targets[0].classification).toBe('config');
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const name of ['desktop-app-version-foreign.json', 'desktop-app-version-invalid.json',
        'desktop-app-version-link.json', 'desktop-build-target.json.bak']) expect(census.residue.some(entry => entry.name === name)).toBe(true);
      const fallback = await runtimeSidefileCensusProducer(channel, { USERPROFILE: real, PAPERCUSP_HOME: override });
      expect(fallback.declarations.filter(entry => entry.producer === 'desktop-app-version-report')).toHaveLength(4);
      expect(fallback.declarations.filter(entry => entry.producer === 'desktop-env-switch-target')).toHaveLength(0);
      const desktop = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/main.rs', import.meta.url), 'utf8');
      expect(desktop).toContain('let ver_path = workspaces::shared_sidecar_home()');
      expect(desktop).toContain('disp.replace(\':\', "").replace(\'.\', "_")');
      const workspaces = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/workspaces.rs', import.meta.url), 'utf8');
      expect(workspaces).toContain('home_for(real_home(), data_home_dir_name())');
      expect(workspaces).toContain('real.join(data_home_dir_name)');
      expect(workspaces).toContain('std::env::var("HOME")');
      expect(workspaces).toContain('std::env::var("USERPROFILE")');
      const target = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/env_switch.rs', import.meta.url), 'utf8');
      expect(target).toContain('let home = std::env::var_os("HOME")?');
      expect(target).toContain('.join(".papercusp/desktop-build-target.json")');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains discovery in explicit workspace runtime homes without following links or claiming copied working directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'workspace-discovery-census-'));
    const active = join(home, 'active');
    const inactive = join(home, 'inactive');
    const copied = join(home, 'project');
    const linked = join(home, 'linked');
    const records = {
      'operator.json': { httpUrl: 'http://127.0.0.1:3170', port: 3170, token: 'fixture-bearer', pid: 123,
        startedAt: 1730000000000, version: '0.1.0' },
      'operator-port.json': { port: 3170, updatedAt: 1730000000000 },
      'endpoint-ipc.3170.json': {},
      'endpoint-ipc.json.2f8f5ba0-d4ba-4c88-8884-2f2a7969683a.tmp': {},
    };
    try {
      for (const directory of [join(home, '.papercusp'), active, inactive, copied]) {
        await mkdir(directory);
        for (const [name, record] of Object.entries(records)) await writeFile(join(directory, name), JSON.stringify(record));
        await writeFile(join(directory, 'operator.json.bak'), '{}');
        await writeFile(join(directory, 'endpoint-ipc.65536.json'), '{}');
      }
      await symlink(copied, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: active }, [copied],
        [active, inactive, inactive, linked]);
      for (const directory of [active, inactive]) {
        const root = result.roots.find(entry => entry.path === directory)!;
        const entries = result.declarations.filter(entry => entry.root === root.id);
        expect(entries.map(entry => entry.name).sort()).toEqual(Object.keys(records).sort());
        expect(entries.find(entry => entry.name === 'operator.json')).toMatchObject({ classification: 'secret' });
        expect(entries.find(entry => entry.name === 'operator-port.json')).toMatchObject({ classification: 'config' });
        expect(entries.filter(entry => entry.name.startsWith('endpoint-ipc')).every(entry => entry.classification === 'cache')).toBe(true);
      }
      expect(result.roots.some(entry => entry.path === linked || entry.path === copied)).toBe(false);
      expect(await readFile(join(inactive, 'operator.json'), 'utf8')).toBe(JSON.stringify(records['operator.json']));
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains validated operator discovery credentials and port memory across host-home relocation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'operator-discovery-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const cwd = join(home, 'project');
    const operator = { httpUrl: 'http://127.0.0.1:3170', port: 3170, token: 'test-bearer', pid: 123,
      processIdentity: 'test-boot:123', startedAt: 1730000000000, version: '0.1.0', sha: null };
    const pg = { url: 'postgresql://harness_admin:test@127.0.0.1:5432/harness',
      appUrl: 'postgresql://harness_app:test@127.0.0.1:5432/harness', port: 5432, pid: 123, startedAt: 1730000000000 };
    const credentials = { schemaVersion: 1, owner: 'a'.repeat(43), admin: 'b'.repeat(43), app: 'c'.repeat(43), zero: 'd'.repeat(43) };
    const records = { 'operator.json': operator, 'operator-port.json': { port: 3170, updatedAt: 1730000000000 },
      'embedded-pg.json': pg, 'embedded-pg.5432.json': pg, 'embedded-pg-credentials.json': credentials };
    try {
      for (const directory of [ordinary, relocated, cwd]) {
        await mkdir(directory);
        for (const [name, record] of Object.entries(records)) {
          await writeFile(join(directory, name), JSON.stringify(record));
          await writeFile(join(directory, `${name}.tmp.123`), JSON.stringify(record));
        }
      }
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated }, [cwd]);
      const owned = result.declarations.filter(entry => ['operator-server-discovery', 'embedded-postgres-role-credentials'].includes(entry.producer));
      expect(owned).toHaveLength(20);
      expect(owned.filter(entry => entry.classification === 'secret')).toHaveLength(16);
      expect(owned.filter(entry => entry.classification === 'config')).toHaveLength(4);
      expect(owned.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      expect(owned.every(entry => result.roots.find(root => root.id === entry.root)?.path !== cwd)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.filter(entry => entry.name.startsWith('operator') || entry.name.startsWith('embedded-pg'))).toEqual([]);
      expect(await readFile(join(relocated, 'embedded-pg-credentials.json'), 'utf8')).toBe(JSON.stringify(credentials));
      const writer = await readFile(new URL('../../../../apps/operator/bin/serve.ts', import.meta.url), 'utf8');
      expect(writer).toContain('const PAPERCUSP_DIR = papercuspHome()');
      expect(writer).toContain('`embedded-pg.${pg.port}.json`');
      expect(writer).toContain('const tmp = `${path}.tmp.${process.pid}`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('leaves foreign, malformed, mismatched, oversized and linked operator records unresolved', async () => {
    const home = await mkdtemp(join(tmpdir(), 'operator-discovery-invalid-'));
    const ordinary = join(home, '.papercusp');
    const linked = join(home, 'linked');
    const pg = { url: 'postgresql://harness_admin:test@127.0.0.1:5432/harness', port: 5432, pid: 123, startedAt: 1730000000000 };
    const invalid = {
      'operator.json': { httpUrl: 'https://foreign.example:3170', port: 3070, token: 'bearer', pid: 123, startedAt: 1, version: '1' },
      'operator-port.json': { port: 3170, updatedAt: 1, foreign: true },
      'embedded-pg.json': { ...pg, url: 'file:///foreign' },
      'embedded-pg.5433.json': pg,
      'embedded-pg.65536.json': pg,
      'embedded-pg-credentials.json': { owner: 'short', admin: 'short', app: 'short', zero: 'short' },
      'embedded-pg-credentials.json.tmp.123': { schemaVersion: 2, owner: 'a'.repeat(43), admin: 'b'.repeat(43), app: 'c'.repeat(43), zero: 'd'.repeat(43) },
      'operator-port.json.tmp.0': { port: 3170, updatedAt: 1 },
      'operator-port.json.tmp.2147483648': { port: 3170, updatedAt: 1 },
      'operator-port.json.bak': { port: 3170, updatedAt: 1 },
      'embedded-pg.5440.json': { ...pg, port: 5440 },
    };
    try {
      await mkdir(ordinary);
      for (const [name, record] of Object.entries(invalid)) await writeFile(join(ordinary, name), JSON.stringify(record));
      await writeFile(join(ordinary, 'operator.json.tmp.123'), '{');
      await writeFile(join(ordinary, 'operator-port.json.tmp.124'), ' '.repeat(65_537));
      await symlink(join(ordinary, 'operator-port.json'), join(ordinary, 'operator-port.json.tmp.125'));
      await mkdir(join(ordinary, 'embedded-pg.5432.json'));
      await symlink(ordinary, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: linked });
      expect(result.declarations.some(entry => ['operator-server-discovery', 'embedded-postgres-role-credentials'].includes(entry.producer))).toBe(false);
      expect(result.roots.some(root => root.path === linked)).toBe(false);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining(Object.keys(invalid)));
      expect(await readFile(join(ordinary, 'operator.json.tmp.123'), 'utf8')).toBe('{');
      await rename(ordinary, join(home, 'target'));
      await symlink(join(home, 'target'), ordinary);
      expect((await runtimeSidefileCensusProducer(home, {})).declarations
        .some(entry => ['operator-server-discovery', 'embedded-postgres-role-credentials'].includes(entry.producer))).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains host gateway logs and one rotation across relocation without trusting workspace names or links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gateway-log-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const override = join(home, 'override', 'lifecycle.txt');
    const logs = [join(ordinary, 'gateway.log'), join(relocated, 'gateway.log'), override];
    const environment = { PAPERCUSP_HOME: relocated, PAPERCUSP_GATEWAY_LOG: override };
    try {
      for (const directory of [ordinary, relocated, join(home, 'override')]) await mkdir(directory);
      for (const log of logs) {
        await writeFile(log, 'retained gateway lifecycle');
        await writeFile(`${log}.1`, 'retained gateway rotation');
        await writeFile(`${log}.2`, 'unproven sibling');
      }
      const result = await runtimeSidefileCensusProducer(home, environment);
      const declarations = result.declarations.filter(entry => entry.producer === 'inference-gateway-lifecycle-log');
      expect(declarations).toHaveLength(6);
      expect(declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.find(root => root.path === join(home, 'override'))?.fileNames?.sort())
        .toEqual(['lifecycle.txt', 'lifecycle.txt.1']);
      const merged = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'relocated', path: relocated }],
        declarations: result.declarations });
      const census = await collectStateCensus({ ...merged, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.classification === 'state')).toHaveLength(6);
      expect(census.residue.map(entry => entry.name)).toEqual(['gateway.log.2', 'gateway.log.2']);
      expect(await readFile(override, 'utf8')).toBe('retained gateway lifecycle');
      await rm(override);
      await symlink(`${override}.1`, override);
      await rename(relocated, join(home, 'relocated-target'));
      await symlink(join(home, 'relocated-target'), relocated);
      const linked = await runtimeSidefileCensusProducer(home, environment);
      const owned = linked.declarations.filter(entry => entry.producer === 'inference-gateway-lifecycle-log');
      expect(owned).toHaveLength(3);
      expect(owned.filter(entry => entry.name.startsWith('lifecycle'))).toEqual([
        expect.objectContaining({ name: 'lifecycle.txt.1' }),
      ]);
      const writer = await readFile(new URL('../inference-gateway/sidecar-main.ts', import.meta.url), 'utf8');
      expect(writer).toContain("import { papercuspPath } from '@papercusp/host-platform/home'");
      expect(writer).toContain("process.env.PAPERCUSP_GATEWAY_LOG || papercuspPath('gateway.log')");
      expect(writer).toContain('const rotatedPath = `${path}.1`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains backup-health writer histories and exact configured markers while exposing unknown files and links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'backup-health-census-'));
    const ordinary = join(home, '.papercusp', 'backup-health');
    const override = join(home, 'health-override');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      const owned = ['db-disk-history', 'db-disk-history.tmp', 'backup-volume-history', 'backup-volume-history.tmp',
        'db-disk-red-ei-filed', 'db-relation-bloat-ei-filed', 'backup-volume-red-ei-filed',
        'workspace-dead-dump-tmp', 'consecutive-fails', 'stale-tmp', 'stale-pg-papercusp-state',
        'missing-pg-restart', 'tmpdir-entries-red-tmp', 'tmpdir-entries-red-tmp-pcv'];
      for (const directory of [ordinary, override]) {
        await mkdir(directory, { recursive: true });
        for (const name of [...owned, 'missing-pg-custom', 'stale--scratch-dump.sql', 'tmpdir-entries-red-scratch---',
          'unknown.json', 'stale-pg-foreign', 'tmpdir-entries-red-foreign']) await writeFile(join(directory, name), 'baseline');
        await mkdir(join(directory, 'copied-source'));
        await writeFile(join(directory, 'copied-source', 'index.ts'), 'foreign');
        await symlink(join(directory, 'db-disk-history'), join(directory, 'missing-pg-papercusp-state'));
      }
      const defaults = await runtimeSidefileCensusProducer(home, {});
      expect(defaults.roots.some(root => root.path === override)).toBe(false);
      expect(defaults.declarations.filter(entry => entry.producer === 'backup-health-probe').map(entry => entry.name).sort())
        .toEqual(['backup-health', ...owned.map(name => `backup-health/${name}`)].sort());
      const environment = { BACKUP_STATE_DIR: override, BACKUP_ARTIFACTS: 'pg/custom',
        BACKUP_OPTIONAL_ARTIFACTS: '/scratch/dump.sql /unexpanded/*/dump.sql', BACKUP_TMPDIR_WATCH: '/scratch/é' };
      const result = await runtimeSidefileCensusProducer(home, environment);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      const classified = census.inventory.filter(entry => entry.producers.includes('backup-health-probe'));
      expect(classified.every(entry => entry.classification === 'state')).toBe(true);
      expect(classified.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'backup-health/missing-pg-custom', 'backup-health/stale--scratch-dump.sql', 'backup-health/tmpdir-entries-red-scratch---',
        'missing-pg-custom', 'stale--scratch-dump.sql', 'tmpdir-entries-red-scratch---',
      ]));
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'backup-health/unknown.json', 'backup-health/stale-pg-foreign', 'backup-health/tmpdir-entries-red-foreign',
        'backup-health/missing-pg-papercusp-state', 'backup-health/copied-source/index.ts',
        'unknown.json', 'stale-pg-foreign', 'tmpdir-entries-red-foreign', 'copied-source/index.ts',
      ]));
      expect(result.declarations.filter(entry => entry.producer === 'backup-health-probe')
        .every(entry => !entry.descendants && !entry.prune)).toBe(true);
      expect(await readFile(join(ordinary, 'db-disk-history'), 'utf8')).toBe('baseline');
      for (const [directory, target] of [[ordinary, join(home, 'ordinary-target')], [override, join(home, 'override-target')]]) {
        await rename(directory, target);
        await symlink(target, directory);
      }
      const linked = await runtimeSidefileCensusProducer(home, environment);
      expect(linked.declarations.some(entry => entry.producer === 'backup-health-probe')).toBe(false);
      expect(linked.roots.some(root => root.path === override)).toBe(false);
      const writer = await readFile(new URL('../../../../apps/operator/scripts/papercup-backup-health-check.sh', import.meta.url), 'utf8');
      expect(writer).toContain('STATE_DIR="${BACKUP_STATE_DIR:-$HOME/.papercusp/backup-health}"');
      for (const name of owned.slice(0, 10).filter(name => !name.endsWith('.tmp'))) expect(writer).toContain(name);
      expect(writer).toContain('"$hist.tmp"');
      expect(writer).toContain("tr -c 'A-Za-z0-9' '-'");
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('keeps Kopia alert state independent of backup probe relocation and rejects unowned neighbors and links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kopia-health-census-'));
    const ordinary = join(home, '.papercusp', 'backup-health');
    const probe = join(home, 'probe');
    const kopia = join(home, 'kopia');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      for (const directory of [ordinary, probe, kopia]) {
        await mkdir(join(directory, 'copied-source'), { recursive: true });
        await writeFile(join(directory, 'last-alert'), '1730000000\n');
        await writeFile(join(directory, 'db-disk-history'), 'baseline');
        await writeFile(join(directory, 'last-alert.tmp'), 'foreign');
        await writeFile(join(directory, 'copied-source', 'index.ts'), 'foreign');
      }
      const environment = { BACKUP_STATE_DIR: probe, HEALTHCHECK_STATE_DIR: kopia,
        PAPERCUSP_HOME: join(home, 'unrelated-home') };
      const result = await runtimeSidefileCensusProducer(home, environment);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.producers.includes('kopia-healthcheck'))
        .every(entry => entry.classification === 'state')).toBe(true);
      expect(result.declarations.filter(entry => entry.producer === 'kopia-healthcheck').map(entry => entry.name).sort())
        .toEqual(['backup-health', 'backup-health/last-alert', 'last-alert']);
      const rootFor = (path: string) => result.roots.find(root => root.path === path)!.id;
      expect(census.residue).toEqual(expect.arrayContaining([
        expect.objectContaining({ root: rootFor(probe), name: 'last-alert' }),
        expect.objectContaining({ root: rootFor(kopia), name: 'db-disk-history' }),
        expect.objectContaining({ root: rootFor(kopia), name: 'last-alert.tmp' }),
        expect.objectContaining({ root: rootFor(kopia), name: 'copied-source/index.ts' }),
      ]));
      expect(result.declarations.filter(entry => entry.producer === 'kopia-healthcheck')
        .every(entry => !entry.descendants && !entry.prune)).toBe(true);
      const shared = await runtimeSidefileCensusProducer(home, { BACKUP_STATE_DIR: kopia, HEALTHCHECK_STATE_DIR: kopia });
      expect(shared.roots.filter(root => root.path === kopia)).toHaveLength(1);
      const sharedCensus = await collectStateCensus({ ...shared, readCatalogs: async () => [] });
      expect(sharedCensus.residue.some(entry => entry.root === shared.roots.find(root => root.path === kopia)!.id
        && ['last-alert', 'db-disk-history'].includes(entry.name))).toBe(false);
      expect(await readFile(join(kopia, 'last-alert'), 'utf8')).toBe('1730000000\n');
      await rm(join(kopia, 'last-alert'));
      await symlink(join(probe, 'last-alert'), join(kopia, 'last-alert'));
      const linkedFile = await runtimeSidefileCensusProducer(home, environment);
      expect(linkedFile.declarations.some(entry => entry.producer === 'kopia-healthcheck'
        && entry.name === 'last-alert')).toBe(false);
      for (const directory of [ordinary, kopia]) {
        await rename(directory, `${directory}-target`);
        await symlink(`${directory}-target`, directory);
      }
      const linkedDirectories = await runtimeSidefileCensusProducer(home, environment);
      expect(linkedDirectories.declarations.some(entry => entry.producer === 'kopia-healthcheck')).toBe(false);
      expect(linkedDirectories.roots.some(root => root.path === kopia)).toBe(false);
      const writer = await readFile(new URL('../../../../apps/operator/scripts/systemd/kopia-healthcheck.sh', import.meta.url), 'utf8');
      expect(writer).toContain('HEALTHCHECK_STATE_DIR="${HEALTHCHECK_STATE_DIR:-$HOME/.papercusp/backup-health}"');
      expect(writer).toContain('local marker="$HEALTHCHECK_STATE_DIR/last-alert"');
      expect(writer).toContain('echo "$now" > "$marker"');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('uses actual default and relocated co-change/model cache writers without following links or owning neighbors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'host-cache-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'configured-home');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      for (const base of [ordinary, relocated]) {
        const snapshots = join(base, 'cache', 'cochange-index');
        await mkdir(snapshots, { recursive: true });
        for (const name of ['0123456789abcdef.json', '0123456789abcdef.json.123.tmp',
          '0123456789abcdef.json.bad.tmp', 'ABCDEF0123456789.json', 'unknown.json']) await writeFile(join(snapshots, name), '{}');
        await symlink(join(snapshots, 'unknown.json'), join(snapshots, '1111111111111111.json'));
        await mkdir(join(snapshots, '2222222222222222.json'));
        await mkdir(join(base, 'cache', 'transformers', 'Xenova', 'model'), { recursive: true });
        await writeFile(join(base, 'cache', 'transformers', 'Xenova', 'model', 'config.json'), '{}');
        await writeFile(join(base, 'cache', 'foreign'), 'unowned');
      }
      const defaults = await runtimeSidefileCensusProducer(home, {});
      expect(defaults.roots.every(root => root.path !== relocated)).toBe(true);
      expect(defaults.roots[0].path).toBe(ordinary);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated });
      expect(result.roots.map(root => root.path)).toContain(relocated);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const base of [ordinary, relocated]) {
        const root = result.roots.find(root => root.path === base)!;
        const names = result.declarations.filter(entry => entry.root === root.id).map(entry => entry.name);
        expect(names).toEqual(expect.arrayContaining(['cache/cochange-index/0123456789abcdef.json',
          'cache/cochange-index/0123456789abcdef.json.123.tmp', 'cache/transformers']));
        const residue = census.residue.filter(entry => entry.root === root.id).map(entry => entry.name);
        expect(residue).toEqual(expect.arrayContaining(['cache/foreign', 'cache/cochange-index/unknown.json',
          'cache/cochange-index/0123456789abcdef.json.bad.tmp', 'cache/cochange-index/ABCDEF0123456789.json',
          'cache/cochange-index/1111111111111111.json', 'cache/cochange-index/2222222222222222.json']));
        expect(census.inventory.find(entry => entry.root === root.id && entry.name === 'cache/transformers'))
          .toMatchObject({ classification: 'cache', producers: ['local-embedder-worker-cache'] });
        expect(census.inventory.some(entry => entry.name.endsWith('/config.json'))).toBe(false);
      }
      await rename(join(relocated, 'cache', 'transformers'), join(home, 'model-target'));
      await symlink(join(home, 'model-target'), join(relocated, 'cache', 'transformers'));
      await rename(join(relocated, 'cache', 'cochange-index'), join(home, 'snapshot-target'));
      await symlink(join(home, 'snapshot-target'), join(relocated, 'cache', 'cochange-index'));
      const linked = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated });
      expect(linked.declarations.filter(entry => linked.roots.find(root => root.id === entry.root)?.path === relocated)).toEqual([]);
      await rename(join(relocated, 'cache'), join(home, 'cache-target'));
      await symlink(join(home, 'cache-target'), join(relocated, 'cache'));
      expect((await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated })).roots.some(root => root.path === relocated)).toBe(false);
      const hostWriter = await readFile(new URL('../code-intelligence/warm-cochange-index.ts', import.meta.url), 'utf8');
      expect(hostWriter).toContain("from '@papercusp/host-platform/home'");
      expect(hostWriter).toContain("papercuspPath('cache', 'cochange-index')");
      expect(hostWriter).toContain(".digest('hex').slice(0, 16)");
      expect(await readFile(new URL('../code-intelligence/warm-cochange-index.worker.ts', import.meta.url), 'utf8'))
        .toContain('`${snapshotPath}.${process.pid}.tmp`');
      const modelWriter = await readFile(new URL('../../../../libs/generic/memory/src/local-embedder-worker.script.mjs', import.meta.url), 'utf8');
      expect(modelWriter).toContain("process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp')");
      expect(modelWriter).toContain("join(papercuspHome, 'cache', 'transformers')");
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it.each([
    ['API key file', (home: string) => `apikey:file:${join(home, 'selected')}`],
    ['API key home file', () => 'apikey:file:~/selected'],
    ['absolute file', (home: string) => join(home, 'selected')],
    ['home file', () => '~/selected'],
    ['legacy file', (home: string) => `file:${join(home, 'selected')}`],
    ['legacy home file', () => 'file:~/selected'],
    ['legacy token', (home: string) => `token:${join(home, 'selected')}`],
    ['legacy home token', () => 'token:~/selected'],
  ])('inventories an exact %s reference once and leaves unrelated siblings as residue', async (_label, reference) => {
    const home = await mkdtemp(join(tmpdir(), 'file-account-census-'));
    try {
      vi.stubEnv('HOME', home);
      await writeFile(join(home, 'selected'), 'opaque credential; not a JSON bundle');
      await writeFile(join(home, 'unrelated'), 'owner data');
      const credentialRef = reference(home);
      const result = await accountCredentialCensusProducer([{ credentialRef }, { credentialRef }]);
      expect(result.roots).toHaveLength(1);
      expect(result.roots[0]).toMatchObject({ path: home, fileNames: ['selected'] });
      expect(result.declarations).toEqual([{
        kind: 'path', root: result.roots[0].id, name: 'selected', classification: 'secret',
        producer: 'account-pool-credential-reference',
      }]);
      const selected = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(selected.ok).toBe(true);
      expect(selected.inventory.map(entry => entry.name)).toEqual(['selected']);
      const full = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'installed', path: home }], declarations: result.declarations });
      const census = await collectStateCensus({ ...full, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === 'selected')?.classification).toBe('secret');
      expect(census.residue.map(entry => entry.name)).toEqual(['unrelated']);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it.each([
    'env:ACCOUNT_TOKEN', 'keychain:external', 'apikey:env:ACCOUNT_KEY', 'apikey:credentials',
    'relative', 'file:relative', 'token:relative', 'apikey:file:relative', 'unknown:/credential',
    'apikey:unknown:/credential', 'apikey:file:', 'apikey:env:invalid-name', 'codex-cli:',
  ])('declares no filesystem ownership for unsupported or non-file reference %s', async credentialRef => {
    expect(await accountCredentialCensusProducer([{ credentialRef }])).toEqual({ roots: [], declarations: [] });
  });
  it('surfaces credential directory IO failures after parsing a valid reference', async () => {
    const home = await mkdtemp(join(tmpdir(), 'credential-io-census-'));
    try {
      await writeFile(join(home, 'not-directory'), 'owner data');
      await expect(accountCredentialCensusProducer([
        { credentialRef: `apikey:file:${join(home, 'not-directory', 'nested', 'secret')}` },
      ])).rejects.toMatchObject({ code: 'ENOTDIR' });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('inventories referenced auth and atomic refresh files without importing unrelated CLI state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'account-census-'));
    try {
      await mkdir(join(home, 'build'));
      await mkdir(join(home, '__pycache__'));
      for (const name of ['auth.json', 'auth.json.123.tmp', 'auth.json.unknown.tmp', 'unknown']) await writeFile(join(home, name), 'must not read');
      await writeFile(join(home, 'build', 'template.ts'), 'source');
      await writeFile(join(home, '__pycache__', 'module.pyc'), 'bytecode');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }, { credentialRef: `codex-cli:${home}` }, { credentialRef: 'keychain:external' }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['auth.json', 'auth.json.123.tmp']);
      expect(result.declarations.every(entry => entry.classification === 'secret' && !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.ok).toBe(true);
      expect(census.inventory.map(entry => entry.name).sort()).toEqual(['auth.json', 'auth.json.123.tmp']);
      const full = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'installed', path: home }], declarations: result.declarations });
      expect(full.roots).toEqual([{ id: 'installed', path: home }]);
      expect((await collectStateCensus({ ...full, readCatalogs: async () => [] })).residue.map(entry => entry.name)).toContain('unknown');
      const writer = await readFile(new URL('../inference-gateway/codex-oauth-proxy.ts', import.meta.url), 'utf8');
      expect(writer).toContain('`${target}.${process.pid}.tmp`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('retains exact databases and their live companions in registered durable Codex homes without changing bytes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-account-census-'));
    const name = 'account.name.codex-cli';
    const home = join(parent, 'deploy-credentials', name);
    const databases = ['state_5.sqlite', 'logs_2.sqlite', 'goals_1.sqlite', 'memories_1.sqlite',
      'memories_v2_1.sqlite', 'queue_1.sqlite', 'thread_history_1.sqlite'];
    const relativeNames = ['auth.json', 'auth.json.123.tmp', 'installation_id', ...databases.flatMap(file => [file, `${file}-wal`, `${file}-shm`])];
    try {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'auth.json'), 'credential bytes must not be parsed');
      await writeFile(join(home, 'auth.json.123.tmp'), 'refresh credential');
      await writeFile(join(home, 'installation_id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      for (const file of databases) {
        await writeFile(join(home, file), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]));
        for (const suffix of ['-wal', '-shm']) await writeFile(join(home, `${file}${suffix}`), `live ${suffix} bytes`);
      }
      const before = await Promise.all(relativeNames.map(file => readFile(join(home, file))));
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }, { credentialRef: `codex-cli:${home}` }]);
      expect(result.roots).toEqual([{ id: 'account-credential-0', path: dirname(home) }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual([name, ...relativeNames.map(file => `${name}/${file}`)].sort());
      expect(result.declarations.filter(entry => entry.producer === 'codex-sqlite-runtime')).toHaveLength(21);
      expect(result.declarations.find(entry => entry.name === `${name}/installation_id`)?.classification).toBe('config');
      expect(result.declarations.filter(entry => entry.classification === 'secret')).toHaveLength(2);
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue).toEqual([]);
      expect(await Promise.all(relativeNames.map(file => readFile(join(home, file))))).toEqual(before);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('classifies exact vendor runtime containers without claiming unknown children or changing metadata', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-runtime-containers-'));
    const home = join(parent, 'deploy-credentials', 'known.codex-cli');
    const containers = ['tmp', 'shell_snapshots', 'plugins', 'skills', 'log'];
    try {
      await mkdir(home, { recursive: true });
      for (const name of [...containers, 'tmp.backup', 'plugins.backup', 'skills.backup', 'log.backup']) await mkdir(join(home, name));
      for (const name of containers) await writeFile(join(home, name, 'unknown'), 'must remain unresolved');
      const unknown = join(dirname(home), 'unknown.codex-cli');
      for (const name of containers) await mkdir(join(unknown, name), { recursive: true });
      const before = await Promise.all(containers.map(name => lstat(join(home, name))));
      const result = await accountCredentialCensusProducer([
        { credentialRef: `codex-cli:${home}` }, { credentialRef: `codex-cli:${home}` },
      ]);
      expect(result.declarations.filter(entry => ['codex-arg0-dispatch', 'codex-shell-snapshot', 'codex-plugin-store', 'codex-system-skills', 'codex-tui-log'].includes(entry.producer)))
        .toEqual([
          { kind: 'path', root: 'account-credential-0', name: 'known.codex-cli/tmp', classification: 'cache', producer: 'codex-arg0-dispatch' },
          { kind: 'path', root: 'account-credential-0', name: 'known.codex-cli/shell_snapshots', classification: 'secret', producer: 'codex-shell-snapshot' },
          { kind: 'path', root: 'account-credential-0', name: 'known.codex-cli/plugins', classification: 'state', producer: 'codex-plugin-store' },
          { kind: 'path', root: 'account-credential-0', name: 'known.codex-cli/skills', classification: 'config', producer: 'codex-system-skills' },
          { kind: 'path', root: 'account-credential-0', name: 'known.codex-cli/log', classification: 'secret', producer: 'codex-tui-log' },
        ]);
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      expect((await collectStateCensus({ ...result, readCatalogs: async () => [] })).residue.map(entry => entry.name))
        .toEqual(expect.arrayContaining([
          ...containers.map(name => `known.codex-cli/${name}/unknown`),
          ...['tmp.backup', 'plugins.backup', 'skills.backup', 'log.backup'].map(name => `known.codex-cli/${name}`),
          ...containers.map(name => `unknown.codex-cli/${name}`),
        ]));
      const stamp = (info: Awaited<ReturnType<typeof lstat>>) => [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs];
      expect((await Promise.all(containers.map(name => lstat(join(home, name))))).map(stamp)).toEqual(before.map(stamp));
      for (const name of containers) expect(await readFile(join(home, name, 'unknown'), 'utf8')).toBe('must remain unresolved');
      expect(result.declarations.some(entry => entry.name.startsWith('unknown.codex-cli/'))).toBe(false);
      // An explicit pool reference registers this second durable home. Its
      // exact containers become known while their children remain unowned.
      const registered = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${unknown}` }]);
      expect(registered.declarations.filter(entry => entry.producer === 'codex-shell-snapshot'))
        .toEqual([{ kind: 'path', root: 'account-credential-0', name: 'unknown.codex-cli/shell_snapshots',
          classification: 'secret', producer: 'codex-shell-snapshot' }]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('rejects vendor runtime containers that are files, links, or under redirected homes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-runtime-containers-negative-'));
    const home = join(parent, 'deploy-credentials', 'known.codex-cli');
    const containers = ['tmp', 'shell_snapshots', 'plugins', 'skills', 'log'];
    const runtimeDeclarations = async (target = home) => (await accountCredentialCensusProducer([
      { credentialRef: `codex-cli:${target}` },
    ])).declarations.filter(entry => ['codex-arg0-dispatch', 'codex-shell-snapshot', 'codex-plugin-store', 'codex-system-skills', 'codex-tui-log'].includes(entry.producer));
    try {
      await mkdir(home, { recursive: true });
      const external = join(parent, 'external');
      await mkdir(external);
      for (const name of containers) await writeFile(join(home, name), 'foreign file');
      expect(await runtimeDeclarations()).toEqual([]);
      for (const name of containers) {
        await rm(join(home, name));
        await symlink(external, join(home, name));
      }
      expect(await runtimeDeclarations()).toEqual([]);
      for (const name of containers) {
        await rm(join(home, name));
        await mkdir(join(home, name));
        await mkdir(join(external, name));
      }
      expect(await runtimeDeclarations()).toHaveLength(containers.length);
      expect(await runtimeDeclarations(external)).toEqual([]);
      await rename(home, `${home}.retained`);
      await symlink(`${home}.retained`, home);
      expect(await runtimeDeclarations()).toEqual([]);
      await rm(home);
      await rm(`${home}.retained`, { recursive: true });
      await rename(dirname(home), `${dirname(home)}.retained`);
      await symlink(`${dirname(home)}.retained`, dirname(home));
      await mkdir(home);
      for (const name of containers) await mkdir(join(home, name));
      expect(await runtimeDeclarations()).toEqual([]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('recognizes vendor model caches only in registered durable homes without changing their metadata', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-model-cache-'));
    const home = join(parent, 'deploy-credentials', 'known.codex-cli');
    const cachePath = join(home, 'models_cache.json');
    const catalog = { fetched_at: '2020-01-01T00:00:00Z', client_version: 'old-client', etag: 'etag',
      identity: 'opaque-provider-identity', models: [{ slug: 'model', display_name: 'Model' }] };
    const names = ['models_cache.json', 'models_cache.json.backup', 'models_cache.json.123.tmp'];
    try {
      await mkdir(home, { recursive: true });
      for (const name of names) await writeFile(join(home, name), JSON.stringify(catalog));
      const before = await lstat(cachePath);
      const bytes = await readFile(cachePath);
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }]);
      expect(result.declarations.filter(entry => entry.producer === 'codex-model-catalog-cache')).toEqual([
        { kind: 'path', root: 'account-credential-0', name: 'known.codex-cli/models_cache.json',
          classification: 'cache', producer: 'codex-model-catalog-cache' },
      ]);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'known.codex-cli/models_cache.json.backup', 'known.codex-cli/models_cache.json.123.tmp',
      ]));
      expect(await readFile(cachePath)).toEqual(bytes);
      const after = await lstat(cachePath);
      expect([after.ino, after.mode, after.size, after.mtimeMs, after.ctimeMs])
        .toEqual([before.ino, before.mode, before.size, before.mtimeMs, before.ctimeMs]);
      // The vendor permits empty catalogs and absent optional identity/version fields.
      await writeFile(cachePath, JSON.stringify({ fetched_at: '-262143-01-01T00:00:00Z', models: [] }));
      expect((await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }])).declarations
        .some(entry => entry.producer === 'codex-model-catalog-cache')).toBe(true);
      // A valid catalog in an unregistered sibling or an arbitrary referenced
      // CLI home cannot establish managed-account ownership.
      const unknown = join(parent, 'deploy-credentials', 'unknown.codex-cli');
      await mkdir(unknown);
      await writeFile(join(unknown, 'models_cache.json'), JSON.stringify(catalog));
      expect((await collectStateCensus({ ...result, readCatalogs: async () => [] })).residue.map(entry => entry.name))
        .toContain('unknown.codex-cli/models_cache.json');
      const external = join(parent, 'external');
      await mkdir(external);
      await writeFile(join(external, 'models_cache.json'), JSON.stringify(catalog));
      expect((await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${external}` }])).declarations
        .some(entry => entry.producer === 'codex-model-catalog-cache')).toBe(false);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('rejects malformed, oversized, copied and redirected model cache candidates', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-model-cache-negative-'));
    const home = join(parent, 'deploy-credentials', 'known.codex-cli');
    const cachePath = join(home, 'models_cache.json');
    const recognized = async () => (await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }]))
      .declarations.some(entry => entry.producer === 'codex-model-catalog-cache');
    try {
      await mkdir(home, { recursive: true });
      for (const candidate of ['{', 'null', '[]', '{}', JSON.stringify({ fetched_at: 'yesterday', models: [] }),
        JSON.stringify({ fetched_at: '2026-01-01T00:00:00Z', models: [null] }),
        JSON.stringify({ fetched_at: '2026-01-01T00:00:00Z', models: [{ slug: 'm' }] }),
        JSON.stringify({ fetched_at: '2026-01-01T00:00:00Z', models: [], identity: {} })]) {
        await writeFile(cachePath, candidate);
        expect(await recognized()).toBe(false);
      }
      const catalog = JSON.stringify({ fetched_at: '2026-01-01T00:00:00Z', models: [], padding: ' '.repeat(8 * 1024 * 1024) });
      await writeFile(cachePath, catalog);
      expect(await recognized()).toBe(false);
      const external = join(parent, 'external.json');
      await writeFile(external, JSON.stringify({ fetched_at: '2026-01-01T00:00:00Z', models: [] }));
      await rm(cachePath);
      await symlink(external, cachePath);
      expect(await recognized()).toBe(false);
      await rm(cachePath);
      await mkdir(cachePath);
      expect(await recognized()).toBe(false);
      await rm(cachePath, { recursive: true });
      await writeFile(cachePath, await readFile(external));
      await rename(home, `${home}.retained`);
      await symlink(`${home}.retained`, home);
      expect(await recognized()).toBe(false);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('retains exact vendor policy migration markers without changing bytes or claiming adjacent paths', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-policy-marker-'));
    const home = join(parent, 'deploy-credentials', 'known.codex-cli');
    const marker = join(home, '.sandbox_migration');
    try {
      await mkdir(home, { recursive: true });
      await writeFile(marker, 'v1\n');
      await writeFile(`${marker}.backup`, 'v1\n');
      await writeFile(join(home, '.tmp-marker'), 'v1\n');
      const unknown = join(dirname(home), 'unknown.codex-cli');
      await mkdir(unknown);
      await writeFile(join(unknown, '.sandbox_migration'), 'v1\n');
      const before = await lstat(marker);
      const result = await accountCredentialCensusProducer([
        { credentialRef: `codex-cli:${home}` }, { credentialRef: `codex-cli:${home}` },
      ]);
      expect(result.declarations.filter(entry => entry.producer === 'codex-sandbox-policy-migration')).toEqual([
        { kind: 'path', root: 'account-credential-0', name: 'known.codex-cli/.sandbox_migration',
          classification: 'config', producer: 'codex-sandbox-policy-migration' },
      ]);
      expect((await collectStateCensus({ ...result, readCatalogs: async () => [] })).residue.map(entry => entry.name))
        .toEqual(expect.arrayContaining(['known.codex-cli/.sandbox_migration.backup',
          'known.codex-cli/.tmp-marker', 'unknown.codex-cli/.sandbox_migration']));
      expect(await readFile(marker, 'utf8')).toBe('v1\n');
      const after = await lstat(marker);
      expect([after.dev, after.ino, after.mode, after.size, after.mtimeMs, after.ctimeMs])
        .toEqual([before.dev, before.ino, before.mode, before.size, before.mtimeMs, before.ctimeMs]);
      const external = join(parent, 'external');
      await mkdir(external);
      await writeFile(join(external, '.sandbox_migration'), 'v1\n');
      expect((await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${external}` }])).declarations
        .some(entry => entry.producer === 'codex-sandbox-policy-migration')).toBe(false);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('rejects malformed, oversized and redirected policy migration markers', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-policy-marker-negative-'));
    const home = join(parent, 'deploy-credentials', 'known.codex-cli');
    const marker = join(home, '.sandbox_migration');
    const recognized = async () => (await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }]))
      .declarations.some(entry => entry.producer === 'codex-sandbox-policy-migration');
    try {
      await mkdir(home, { recursive: true });
      for (const value of ['', 'v1', 'v2\n', 'v1\r\n', 'v1\nforeign', ' '.repeat(1024)]) {
        await writeFile(marker, value);
        expect(await recognized()).toBe(false);
      }
      const external = join(parent, 'external');
      await writeFile(external, 'v1\n');
      await rm(marker);
      await symlink(external, marker);
      expect(await recognized()).toBe(false);
      await rm(marker);
      await mkdir(marker);
      expect(await recognized()).toBe(false);
      await rm(marker, { recursive: true });
      await writeFile(marker, 'v1\n');
      await rename(home, `${home}.retained`);
      await symlink(`${home}.retained`, home);
      expect(await recognized()).toBe(false);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('leaves unknown accounts, malformed databases, orphan companions, backups and links unresolved', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-account-negative-'));
    const home = join(parent, 'deploy-credentials', 'known.codex-cli');
    try {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'auth.json'), 'opaque');
      for (const file of ['state_5.sqlite', 'state_5.sqlite-wal', 'goals_1.sqlite-shm', 'state_6.sqlite',
        'state_5.sqlite.backup', 'installation_id', 'foreign.ts']) await writeFile(join(home, file), 'foreign bytes');
      await writeFile(join(parent, 'external.sqlite'), 'SQLite format 3\0');
      await symlink(join(parent, 'external.sqlite'), join(home, 'logs_2.sqlite'));
      await writeFile(join(home, 'logs_2.sqlite-wal'), 'orphan');
      await mkdir(join(home, 'memories_1.sqlite'));
      await mkdir(join(parent, 'deploy-credentials', 'unknown.codex-cli'));
      await writeFile(join(parent, 'deploy-credentials', 'unknown.codex-cli', 'state_5.sqlite'), 'SQLite format 3\0');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }]);
      expect(result.declarations.map(entry => entry.name)).toEqual(['known.codex-cli', 'known.codex-cli/auth.json']);
      const direct = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(direct.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'known.codex-cli/foreign.ts', 'unknown.codex-cli', 'unknown.codex-cli/state_5.sqlite',
      ]));
      const merged = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'all', path: parent }], declarations: result.declarations });
      const census = await collectStateCensus({ ...merged, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'deploy-credentials/known.codex-cli/state_5.sqlite', 'deploy-credentials/known.codex-cli/state_5.sqlite-wal',
        'deploy-credentials/known.codex-cli/goals_1.sqlite-shm', 'deploy-credentials/known.codex-cli/logs_2.sqlite',
        'deploy-credentials/unknown.codex-cli/state_5.sqlite',
      ]));
      await rm(join(home, 'installation_id'));
      await symlink(join(parent, 'external.sqlite'), join(home, 'installation_id'));
      expect((await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }])).declarations)
        .toEqual(result.declarations);
      await rename(home, `${home}.retained`);
      await symlink(`${home}.retained`, home);
      expect((await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }])).declarations
        .some(entry => entry.producer === 'codex-sqlite-runtime' || entry.producer === 'account-link-cli-completed-home')).toBe(false);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('does not treat an arbitrary referenced CLI home as a managed account container', async () => {
    const home = await mkdtemp(join(tmpdir(), 'external-codex-account-'));
    try {
      await writeFile(join(home, 'auth.json'), 'opaque');
      await writeFile(join(home, 'state_5.sqlite'), 'SQLite format 3\0');
      await writeFile(join(home, 'installation_id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }]);
      expect(result.roots[0].fileNames).toEqual(['auth.json']);
      expect(result.declarations.map(entry => entry.name)).toEqual(['auth.json']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('unions external references without allowing a selected parent to hide an installed child', () => {
    const result = mergeNestedCensusRoots({ roots: [
      { id: 'a', path: '/external', fileNames: ['auth.json'] },
      { id: 'b', path: '/external', fileNames: ['token'] },
      { id: 'child', path: '/external/installed' },
    ], declarations: [] });
    expect(result.roots).toEqual([
      { id: 'a', path: '/external', fileNames: ['auth.json', 'token'] },
      { id: 'child', path: '/external/installed' },
    ]);
  });
  it('recognizes exact affected-test cache writers without claiming unrelated files or symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'affected-cache-census-'));
    try {
      const directory = join(home, '.papercusp', 'cache');
      await mkdir(directory, { recursive: true });
      const ordinary = 'papercusp-affected-passing-verdicts-v2-0123456789abcdef.json';
      const committed = 'papercusp-affected-passing-verdicts-v2-committed-fedcba9876543210.json';
      await writeFile(join(directory, ordinary), '{}');
      await writeFile(join(directory, committed), '{}');
      for (const name of [ordinary, committed]) await writeFile(closureDigestManifestPath(join(directory, name)), '{}');
      const orphanSidecar = closureDigestManifestPath('papercusp-affected-passing-verdicts-v2-1111111111111111.json');
      await writeFile(join(directory, orphanSidecar), '{}');
      await writeFile(join(directory, 'unknown.json'), '{}');
      await writeFile(closureDigestManifestPath(join(directory, 'unknown.json')), '{}');
      await symlink(join(directory, 'unknown.json'), join(directory, 'papercusp-affected-passing-verdicts-v2-aaaaaaaaaaaaaaaa.json'));
      await symlink(join(directory, 'unknown.json'), closureDigestManifestPath(join(directory, 'papercusp-affected-passing-verdicts-v2-bbbbbbbbbbbbbbbb.json')));
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', join(home, 'history', 'custom.json'));
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', join(home, 'verdict', 'custom.json'));
      vi.stubEnv('AFFECTED_PARTIAL_RESUME_CACHE_DIR', '');
      await mkdir(join(home, 'history'));
      await writeFile(join(home, 'history', 'custom.json'), '{}');
      await mkdir(join(home, 'verdict'));
      await writeFile(join(home, 'verdict', 'custom.json'), '{}');
      await writeFile(closureDigestManifestPath(join(home, 'verdict', 'custom.json')), '{}');
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['custom.json', 'custom.json',
        closureDigestManifestPath('custom.json'), ordinary, committed,
        closureDigestManifestPath(ordinary), closureDigestManifestPath(committed), orphanSidecar].sort());
      expect(result.declarations.every(entry => entry.classification === 'cache' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.declarations.filter(entry => entry.producer === 'affected-tests-closure-manifest')).toHaveLength(4);
      expect(result.roots.map(root => root.path)).toContain(join(home, 'history'));
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === 'custom.json.closure-manifest.json')?.classification).toBe('cache');
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining(['unknown.json', 'unknown.json.closure-manifest.json']));
      const writer = await readFile(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
      expect(writer).toContain('papercusp-affected-task-durations-v1.json');
      expect(writer).toContain('papercusp-affected-passing-verdicts-v2-${TASK_VERDICT_CACHE_ROOT_SCOPE}.json');
      const committedWriter = await readFile(new URL('../../../../scripts/lint-as-committed.mjs', import.meta.url), 'utf8');
      expect(committedWriter).toContain('papercusp-affected-passing-verdicts-v2-committed-${scope}.json');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it.each([false, true])('censuses exact partial checkpoints with relocated=%s and preserves unrelated files', async (relocated) => {
    const home = await mkdtemp(join(tmpdir(), 'affected-partial-census-'));
    try {
      const directory = join(home, '.papercusp', 'cache');
      const partialDirectory = relocated ? join(home, 'partial') : directory;
      vi.stubEnv('AFFECTED_PARTIAL_RESUME_CACHE_DIR', relocated ? partialDirectory : '');
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', join(directory, 'papercusp-affected-task-durations-v1.json'));
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', '');
      await mkdir(directory, { recursive: true });
      await mkdir(partialDirectory, { recursive: true });
      const checkpoint = partialTaskCheckpointPath(partialDirectory, '/repo', 'operator-core :: test');
      const unrelated = ['unknown.json', 'papercusp-affected-partial-v999-0123456789abcdef01234567.json',
        'papercusp-affected-partial-v1-not-a-scope.json'];
      await writeFile(checkpoint, '{}');
      for (const name of unrelated) await writeFile(join(partialDirectory, name), '{}');
      const linked = partialTaskCheckpointPath(partialDirectory, '/repo', 'linked');
      await symlink(checkpoint, linked);
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.filter(entry => entry.producer === 'affected-tests-partial-checkpoint'))
        .toEqual([{ kind: 'path', root: expect.any(String), name: checkpoint.split('/').at(-1),
          classification: 'cache', producer: 'affected-tests-partial-checkpoint' }]);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === checkpoint.split('/').at(-1))?.classification).toBe('cache');
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([...unrelated, linked.split('/').at(-1)]));
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('leaves explicit cache symlinks and symlinked partial directories unclassified', async () => {
    const home = await mkdtemp(join(tmpdir(), 'affected-linked-cache-census-'));
    try {
      const target = join(home, 'target.json');
      const verdict = join(home, 'verdict.json');
      await writeFile(target, '{}');
      await symlink(target, verdict);
      await symlink(target, closureDigestManifestPath(verdict));
      const partialDirectory = join(home, 'partial-target');
      await mkdir(partialDirectory);
      await writeFile(partialTaskCheckpointPath(partialDirectory, '/repo', 'test'), '{}');
      const linkedDirectory = join(home, 'linked-partial');
      await symlink(partialDirectory, linkedDirectory);
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', target);
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', verdict);
      vi.stubEnv('AFFECTED_PARTIAL_RESUME_CACHE_DIR', linkedDirectory);
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.map(entry => entry.producer)).toEqual(['affected-tests-duration-history']);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('preserves real test-run packets in known homes and the pinned evidence root without claiming siblings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'testing-evidence-census-'));
    const ordinary = join(home, '.papercusp');
    const registered = join(home, 'registered');
    const unregistered = join(home, 'unregistered');
    const environment = { PAPERCUSP_HOME: ordinary, VH_EVIDENCE_ROOT_BASE: join(home, 'offload') };
    try {
      const bases = [ordinary, registered, unregistered].map(directory =>
        defaultTestRunArtifactBase({ PAPERCUSP_HOME: directory }, home));
      bases.push(defaultTestRunArtifactBase(environment, home));
      const packets = bases.map((base, index) => new TestRunArtifactPacket(`fixture-${index}`, home, testRunDeadline(1000), base));
      for (const packet of packets) packet.write('proof.json', { opaque: 'retained fixture' });
      const before = await Promise.all(packets.map(packet => readFile(join(packet.paths.directory, 'proof.json'), 'utf8')));
      await writeFile(join(ordinary, 'test-artifacts', 'foreign.txt'), 'unproven sibling');
      await mkdir(join(ordinary, 'test-artifacts-copy'));
      await writeFile(join(ordinary, 'test-artifacts-copy', 'manifest.json'), '{}');
      const result = await runtimeSidefileCensusProducer(home, environment, [], [registered, registered]);
      const evidence = result.declarations.filter(entry => entry.producer === 'testing-run-retained-evidence');
      expect(evidence.filter(entry => entry.retainedSubtree)).toHaveLength(3);
      expect(evidence.every(entry => entry.classification === 'state' && !entry.prune)).toBe(true);
      expect(result.roots.some(root => root.path.startsWith(unregistered))).toBe(false);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.representedSubtrees).toHaveLength(3);
      expect(census.residue.map(entry => entry.name).sort()).toEqual([
        'test-artifacts-copy', 'test-artifacts-copy/manifest.json', 'test-artifacts/foreign.txt',
      ]);
      expect(await Promise.all(packets.map(packet => readFile(join(packet.paths.directory, 'proof.json'), 'utf8')))).toEqual(before);
      expect(census.ok).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('does not infer test evidence ownership through linked roots or absent directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'linked-testing-evidence-census-'));
    const ordinary = join(home, '.papercusp');
    const target = join(home, 'target');
    const owned = async () => (await runtimeSidefileCensusProducer(home, {})).declarations
      .filter(entry => entry.producer === 'testing-run-retained-evidence');
    try {
      await mkdir(ordinary);
      expect(await owned()).toEqual([]);
      await mkdir(join(target, 'testing-run'), { recursive: true });
      await symlink(target, join(ordinary, 'test-artifacts'));
      expect(await owned()).toEqual([]);
      await rm(join(ordinary, 'test-artifacts'));
      await mkdir(join(ordinary, 'test-artifacts'));
      await symlink(join(target, 'testing-run'), join(ordinary, 'test-artifacts', 'testing-run'));
      expect(await owned()).toEqual([]);
      await rm(join(ordinary, 'test-artifacts'), { recursive: true });
      await mkdir(join(ordinary, 'test-artifacts', 'testing-run'), { recursive: true });
      await rename(ordinary, `${ordinary}-retained`);
      await symlink(`${ordinary}-retained`, ordinary);
      expect(await owned()).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  describe('source preview original census evidence', () => {
    const sourceReceipt = () => ({ schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
      submodules: [], testedInputs: [], files: [] });
    const fixture = async (runtimeHome: string, contents: Record<string, string> = {}, sourceCommit = 'a'.repeat(40)) => {
      const { archiveVerifierTaskEvidence } = await import('../../../../scripts/source-preview.mjs');
      const container = join(runtimeHome, 'test-artifacts');
      await mkdir(container, { recursive: true });
      const owned = await mkdtemp(join(dirname(runtimeHome), 'verifier-command-'));
      const receiptPath = join(container, 'arbitrary-name.json');
      const taskReceiptPath = `${receiptPath}.task.json`;
      const taskId = 'fixture-verifier-task';
      const receipt = writeVerifierTaskReceipt(owned, dirname(runtimeHome),
        { PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: taskId }, taskReceiptPath);
      const runId = createHash('sha256').update(receiptPath).digest('hex');
      const evidenceRoot = join(runtimeHome, 'checkpoint-logs', `verifier-task-${taskId}`, runId);
      await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
      const manifestPath = join(evidenceRoot, 'manifest.json');
      await writeFile(taskReceiptPath, JSON.stringify({ ...receipt, cleanup: 'completed', evidenceManifestPath: manifestPath }) + '\n');
      const suffixes = ['', '.snapshot.txt', '.dependencies.json', '.dependencies.after.json', '.child.json', '.stdout.log', '.stderr.log', '.resources.jsonl', '.phases.jsonl'];
      for (const suffix of suffixes) await writeFile(`${receiptPath}${suffix}`, contents[suffix]
        ?? (suffix === '' ? JSON.stringify(sourceReceipt()) + '\n' : `writer output ${suffix}\n`), { mode: 0o600 });
      archiveVerifierTaskEvidence({ evidenceRoot, taskId, sourceCommit, receiptPath,
        taskReceiptPath, phaseArchivePath: `${receiptPath}.phases.jsonl`, cleanup: 'completed', childExitCode: 0 });
      return { container, receiptPath, taskReceiptPath, evidenceRoot, manifestPath, suffixes };
    };
    it('reads only independently archived manifest pins and refuses coherent local repinning', async () => {
      const home = await mkdtemp(join(tmpdir(), 'historical-original-pin-'));
      try {
        const runtimeHome = join(home, '.papercusp'); const f = await fixture(runtimeHome);
        const prefix = `archive:codex:fixture:sha256:${'a'.repeat(64)}:`;
        const pin = { taskId: 'fixture-verifier-task', manifestPath: f.manifestPath,
          manifestSha256: createHash('sha256').update(await readFile(f.manifestPath)).digest('hex') };
        const record = { ref: `${prefix}line:1:call:writer`, toolInput: '', receipt: '', startedAt: '', finishedAt: '',
          terminal: { exitCode: 0, ref: `${prefix}line:2:call:writer`, output: `VERIFIER_TASK_EVIDENCE ${JSON.stringify(pin)}\n` } };
        const operation = { kind: 'git-archive' as const, repository: '/repository', commit: 'a'.repeat(40), destination: '/destination' };
        const read = () => readHistoricalCensusSourceReceipt(record, operation, [runtimeHome]);
        expect((await read())?.bytes.toString()).toBe(JSON.stringify(sourceReceipt()) + '\n');
        expect(await readHistoricalCensusSourceReceipt(record, operation, [])).toBeNull();
        record.terminal.output = `VERIFIER_TASK_EVIDENCE ${JSON.stringify({ ...pin, manifestSha256: undefined })}\n`;
        expect(await read()).toBeNull();
        record.terminal.output = `VERIFIER_TASK_EVIDENCE ${JSON.stringify(pin)}\n`.repeat(2);
        expect(await read()).toBeNull();
        record.terminal.output = `VERIFIER_TASK_EVIDENCE ${JSON.stringify(pin)}\n`;
        record.terminal.ref = record.terminal.ref.replace('a'.repeat(64), 'b'.repeat(64));
        expect(await read()).toBeNull();
        record.terminal.ref = `${prefix}line:2:call:writer`;
        await writeFile(join(f.evidenceRoot, 'source.json'), 'substituted');
        const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
        manifest.artifacts['source.json'].sizeBytes = Buffer.byteLength('substituted');
        manifest.artifacts['source.json'].sha256 = createHash('sha256').update('substituted').digest('hex');
        await writeFile(f.manifestPath, JSON.stringify(manifest));
        expect(await read()).toBeNull();
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['valid', 'forged-bindings', 'copied-record', 'changed-command', 'changed-ref', 'changed-terminal',
      'changed-source', 'added-file', 'linked-file', 'linked-destination', 'changed-receipt', 'foreign-home'])(
      'consumes only canonical recovered dependency custody with current original bytes: %s', async condition => {
      const home = await mkdtemp(join(tmpdir(), 'historical-original-recovery-'));
      try {
        const runtimeHome = join(home, '.papercusp'); const root = join(home, 'dependencies');
        const source = join(root, 'node_modules'), destination = join(runtimeHome, 'test-artifacts', 'copy');
        await mkdir(source, { recursive: true }); await mkdir(destination, { recursive: true });
        await writeFile(join(source, 'module.js'), 'original');
        await createHardlink(join(source, 'module.js'), join(destination, 'module.js'));
        const dependency = { schemaVersion: 'verifier-dependencies-v1', scope: 'materialized-dependency-files', root,
          sourceCommit: 'a'.repeat(40), sourceReceiptSha256: createHash('sha256').update(JSON.stringify(sourceReceipt())).digest('hex'),
          trees: [{ path: 'node_modules', files: verifierSourceFiles(source) }] };
        const f = await fixture(runtimeHome, { '.dependencies.json': JSON.stringify(dependency) + '\n' });
        const marker = { taskId: 'fixture-verifier-task', manifestPath: f.manifestPath,
          manifestSha256: createHash('sha256').update(await readFile(f.manifestPath)).digest('hex') };
        const startedAt = '2026-11-10T10:00:00.000Z', finishedAt = '2026-11-10T10:00:01.000Z';
        const bytes = Buffer.from([
          { type: 'response_item', timestamp: startedAt, payload: { type: 'custom_tool_call', name: 'exec', call_id: 'writer',
            input: `text(await tools.exec_command({cmd:${JSON.stringify(`cp -al ${source} ${destination}`)}}));` } },
          { type: 'response_item', timestamp: finishedAt, payload: { type: 'custom_tool_call_output', call_id: 'writer',
            output: JSON.stringify({ exit_code: 0, output: `VERIFIER_TASK_EVIDENCE ${JSON.stringify(marker)}\n` }) } },
        ].map(row => JSON.stringify(row)).join('\n'));
        vi.stubEnv('PAPERCUSP_HOME', runtimeHome);
        const recover = () => recoverHistoricalCensusWriterEvidence([{ ref: 'indexed:writer', sessionId: 'fixture',
          toolInput: 'truncated', startedAt, finishedAt }], async () => ({ bytes, sha256: createHash('sha256').update(bytes).digest('hex') }));
        let records = await recover();
        expect(records[0].sourceBindings).toHaveLength(1);
        const unknown = join(f.container, 'unknown-sibling.log');
        await writeFile(unknown, 'unproven sibling');
        if (condition === 'forged-bindings') {
          records[0].sourceBindings![0].files.push({ path: '../unknown-sibling.log', kind: 'file', executable: false, sha256: 'a'.repeat(64) });
          records[0].sourceOperations = { status: 'supported', version: 'shell-quote:source-operations-v1',
            operations: [{ kind: 'hardlink-copy', source, destination: f.container }] };
        }
        if (condition === 'copied-record') records = [{ ...records[0] }];
        if (condition === 'changed-command') records[0].toolInput = records[0].toolInput.replace(destination, f.container);
        if (condition === 'changed-ref') records[0].ref += ':forged';
        if (condition === 'changed-terminal') records[0].terminal!.output = 'replacement completion';
        if (condition === 'changed-source') {
          await writeFile(join(source, 'module.js'), 'changed together');
          expect(verifierSourceFiles(source)).toEqual(verifierSourceFiles(destination));
        }
        if (condition === 'added-file') await writeFile(join(destination, 'unknown.js'), 'unrecorded');
        if (condition === 'linked-file') {
          await rm(join(destination, 'module.js')); await symlink(join(source, 'module.js'), join(destination, 'module.js'));
        }
        if (condition === 'linked-destination') {
          await rename(destination, destination + '-original'); await symlink(destination + '-original', destination);
        }
        if (condition === 'changed-receipt') {
          await writeFile(join(f.evidenceRoot, 'dependencies.json'), JSON.stringify({ ...dependency, sourceCommit: 'b'.repeat(40) }));
        }
        const produced = await historicalVerifierArtifactCensusProducer(records, condition === 'foreign-home' ? [] : [runtimeHome]);
        const admitted = ['valid', 'forged-bindings'].includes(condition);
        expect(produced.declarations.some(row => row.name === 'test-artifacts/copy/module.js')).toBe(admitted);
        expect(produced.declarations.some(row => row.name === 'test-artifacts/unknown-sibling.log')).toBe(false);
        expect(produced.declarations.some(row => row.name.endsWith('unknown.js'))).toBe(false);
        if (admitted) {
          const census = await collectStateCensus({ ...produced, readCatalogs: async () => [] });
          expect(census.inventory.some(row => row.name === 'test-artifacts/copy/module.js' && row.classification === 'state')).toBe(true);
          expect(census.residue.some(row => row.name === 'test-artifacts/unknown-sibling.log')).toBe(true);
        } else expect(produced).toEqual({ roots: [], declarations: [] });
      } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
    });
    it('consumes recovered git archives without granting ownership to their surrounding directory', async () => {
      const home = await mkdtemp(join(tmpdir(), 'historical-archive-census-'));
      try {
        const runtimeHome = join(home, '.papercusp'), repo = join(home, 'repo');
        const destination = join(runtimeHome, 'test-artifacts', 'archive');
        await mkdir(repo); await mkdir(join(destination, 'nested'), { recursive: true });
        execFileSync('git', ['init', '--quiet', repo]);
        const git = (args: string[], input?: string) => execFileSync('git', ['-C', repo,
          '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { input, encoding: 'utf8' }).trim();
        const blob = git(['hash-object', '-w', '--stdin'], 'original source');
        const nested = git(['mktree'], `100644 blob ${blob}\tinput.txt\n`);
        const tree = git(['mktree'], `040000 tree ${nested}\tnested\n`);
        const commit = git(['commit-tree', tree, '-m', 'fixture source']);
        await writeFile(join(destination, 'nested', 'input.txt'), 'original source');
        const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: commit, submodules: [],
          testedInputs: [{ path: 'nested/input.txt', sha256: createHash('sha256').update('original source').digest('hex') }],
          files: verifierSourceFiles(destination) };
        await writeFile(join(destination, '.verifier-source.json'), JSON.stringify(receipt) + '\n');
        const f = await fixture(runtimeHome, { '': JSON.stringify(receipt) + '\n' }, commit);
        const marker = { taskId: 'fixture-verifier-task', manifestPath: f.manifestPath,
          manifestSha256: createHash('sha256').update(await readFile(f.manifestPath)).digest('hex') };
        const startedAt = '2026-11-10T10:00:00.000Z', finishedAt = '2026-11-10T10:00:01.000Z';
        const archive = Buffer.from([
          { type: 'response_item', timestamp: startedAt, payload: { type: 'custom_tool_call', name: 'exec', call_id: 'writer',
            input: `text(await tools.exec_command({cmd:${JSON.stringify(`git -C ${repo} archive --format=tar ${commit} | tar -x -C ${destination}`)}}));` } },
          { type: 'response_item', timestamp: finishedAt, payload: { type: 'custom_tool_call_output', call_id: 'writer',
            output: JSON.stringify({ exit_code: 0, output: `VERIFIER_TASK_EVIDENCE ${JSON.stringify(marker)}\n` }) } },
        ].map(row => JSON.stringify(row)).join('\n'));
        vi.stubEnv('PAPERCUSP_HOME', runtimeHome);
        const records = await recoverHistoricalCensusWriterEvidence([{ ref: 'indexed:writer', sessionId: 'fixture',
          toolInput: 'truncated', startedAt, finishedAt }], async () => ({ bytes: archive,
          sha256: createHash('sha256').update(archive).digest('hex') }));
        const produce = () => historicalVerifierArtifactCensusProducer(records, [runtimeHome]);
        expect((await produce()).declarations.map(row => row.name)).toEqual(expect.arrayContaining([
          'test-artifacts', 'test-artifacts/archive', 'test-artifacts/archive/nested', 'test-artifacts/archive/nested/input.txt',
        ]));
        await writeFile(join(f.container, 'unknown-sibling'), 'unproven');
        const census = await collectStateCensus({ ...await produce(), readCatalogs: async () => [] });
        expect(census.residue.some(row => row.name === 'test-artifacts/unknown-sibling')).toBe(true);
        await writeFile(join(destination, 'nested', 'input.txt'), 'substituted source');
        expect(await produce()).toEqual({ roots: [], declarations: [] });
      } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
    });
    it.each(['source-commit', 'dependency-commit', 'dependency-source-digest', 'raw-source-digest',
      'source-schema', 'dependency-schema', 'malformed-source', 'missing-source', 'changed-source'])(
      'refuses independently pinned but inconsistent receipt cross-links: %s', async mismatch => {
        const home = await mkdtemp(join(tmpdir(), 'historical-original-crosslinks-'));
        try {
          const runtimeHome = join(home, '.papercusp');
          const source = { ...sourceReceipt(), testedInputs: [{ path: 'input.txt', sha256: 'a'.repeat(64) }] };
          const dependency = { schemaVersion: 'verifier-dependencies-v1', sourceCommit: source.sourceCommit,
            sourceReceiptSha256: createHash('sha256').update(JSON.stringify(source)).digest('hex') };
          if (mismatch === 'source-commit') source.sourceCommit = 'b'.repeat(40);
          if (mismatch === 'dependency-commit') dependency.sourceCommit = 'b'.repeat(40);
          if (mismatch === 'dependency-source-digest') dependency.sourceReceiptSha256 = 'b'.repeat(64);
          if (mismatch === 'raw-source-digest') dependency.sourceReceiptSha256 = createHash('sha256')
            .update(JSON.stringify(source) + '\n').digest('hex');
          if (mismatch === 'source-schema') source.schemaVersion = 'foreign-source-v1';
          if (mismatch === 'dependency-schema') dependency.schemaVersion = 'foreign-dependencies-v1';
          // Same commit with a different source object must still fail its link.
          if (mismatch === 'changed-source') source.testedInputs[0].path = 'foreign';
          const f = await fixture(runtimeHome, {
            '': mismatch === 'malformed-source' ? '{' : JSON.stringify(source) + '\n',
            '.dependencies.json': JSON.stringify(dependency) + '\n',
          });
          if (mismatch === 'missing-source') {
            const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
            delete manifest.artifacts['source.json'];
            await writeFile(f.manifestPath, JSON.stringify(manifest));
          }
          const prefix = `archive:codex:fixture:sha256:${'a'.repeat(64)}:`;
          const marker = { taskId: 'fixture-verifier-task', manifestPath: f.manifestPath,
            manifestSha256: createHash('sha256').update(await readFile(f.manifestPath)).digest('hex') };
          const record = { ref: `${prefix}line:1:call:writer`, toolInput: '', receipt: '', startedAt: '', finishedAt: '',
            terminal: { exitCode: 0, ref: `${prefix}line:2:call:writer`, output: `VERIFIER_TASK_EVIDENCE ${JSON.stringify(marker)}\n` } };
          const operation = { kind: 'hardlink-copy' as const, source: '/source', destination: '/destination' };
          expect(await readHistoricalCensusSourceReceipt(record, operation, [runtimeHome])).toBeNull();
          if (['source-commit', 'source-schema', 'malformed-source', 'missing-source'].includes(mismatch)) {
            expect(await readHistoricalCensusSourceReceipt(record, { kind: 'git-archive', repository: '/repository',
              commit: 'a'.repeat(40), destination: '/destination' }, [runtimeHome])).toBeNull();
          }
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    const originals = async (home: string, runtimeHomes: string[] = []) => {
      const result = await runtimeSidefileCensusProducer(home, {}, [], runtimeHomes);
      const roots = [...result.roots];
      const focused = await runtimeTestArtifactCensusDeclarations([join(home, '.papercusp'), ...runtimeHomes, ...runtimeHomes], roots);
      expect(focused.filter(entry => entry.producer === 'source-preview-verifier-original'))
        .toEqual(result.declarations.filter(entry => entry.producer === 'source-preview-verifier-original'));
      expect(roots).toEqual(result.roots);
      return { ...result, declarations: result.declarations.filter(entry => entry.producer === 'source-preview-verifier-original') };
    };
    it('uses actual retained writer bytes in ordinary and registered homes, leaving unknown siblings unresolved', async () => {
      const home = await mkdtemp(join(tmpdir(), 'verifier-census-'));
      try {
        const first = await fixture(join(home, '.papercusp'));
        await fixture(join(home, 'registered'));
        await fixture(join(home, 'unregistered'));
        const unknown = join(first.container, 'request.json');
        await writeFile(unknown, 'unproven input');
        const before = await readFile(first.taskReceiptPath);
        const result = await originals(home, [join(home, 'registered')]);
        expect(result.declarations.filter(entry => entry.name.endsWith('.task.json'))).toHaveLength(2);
        expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
        expect(result.roots.some(root => root.path === join(home, 'unregistered'))).toBe(false);
        for (const suffix of first.suffixes) expect(result.declarations.some(entry => entry.name === `test-artifacts/arbitrary-name.json${suffix}`)).toBe(true);
        const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
        expect(census.residue.some(entry => entry.name === 'test-artifacts/request.json')).toBe(true);
        expect(census.ok).toBe(false);
        expect(await readFile(first.taskReceiptPath)).toEqual(before);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['missing-manifest', 'partial-bundle', 'retained-bytes', 'retained-task', 'manifest-task', 'manifest-run',
      'manifest-path', 'artifact-path', 'unknown-role', 'pending-task', 'linked-manifest', 'linked-retained', 'linked-root', 'linked-container'])
      ('rejects %s custody without adopting any originals', async corruption => {
        const home = await mkdtemp(join(tmpdir(), 'invalid-verifier-census-'));
        try {
          const f = await fixture(join(home, '.papercusp'));
          const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
          if (corruption === 'missing-manifest') await rm(f.manifestPath);
          if (corruption === 'partial-bundle') await rm(join(f.evidenceRoot, 'phases.jsonl'));
          if (corruption === 'retained-bytes') await writeFile(join(f.evidenceRoot, 'stdout.log'), 'corrupt');
          if (corruption === 'retained-task') {
            const bytes = Buffer.from((await readFile(f.taskReceiptPath, 'utf8')).replace('completed', 'deferred'));
            await writeFile(join(f.evidenceRoot, 'task.json'), bytes);
            manifest.artifacts['task.json'].sha256 = createHash('sha256').update(bytes).digest('hex');
            manifest.artifacts['task.json'].sizeBytes = bytes.length;
          }
          if (corruption === 'manifest-task') manifest.taskId = 'foreign-task';
          if (corruption === 'manifest-run') manifest.runId = 'f'.repeat(64);
          if (corruption === 'artifact-path') manifest.artifacts['source.json'].path = f.receiptPath;
          if (corruption === 'unknown-role') manifest.artifacts['request.json'] = manifest.artifacts['source.json'];
          if (['retained-task', 'manifest-task', 'manifest-run', 'artifact-path', 'unknown-role'].includes(corruption))
            await writeFile(f.manifestPath, JSON.stringify(manifest));
          if (corruption === 'manifest-path' || corruption === 'pending-task') {
            const receipt = JSON.parse(await readFile(f.taskReceiptPath, 'utf8'));
            if (corruption === 'manifest-path') receipt.evidenceManifestPath = join(home, 'manifest.json');
            else receipt.cleanup = 'pending';
            await writeFile(f.taskReceiptPath, JSON.stringify(receipt));
          }
          const link = async (path: string) => { await rename(path, `${path}-target`); await symlink(`${path}-target`, path); };
          if (corruption === 'linked-manifest') await link(f.manifestPath);
          if (corruption === 'linked-retained') await link(join(f.evidenceRoot, 'source.json'));
          if (corruption === 'linked-root') await link(f.evidenceRoot);
          if (corruption === 'linked-container') await link(f.container);
          expect((await originals(home)).declarations).toEqual([]);
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    it.each(['changed', 'linked', 'missing'])('leaves %s originals unknown while retaining independently proven siblings', async corruption => {
      const home = await mkdtemp(join(tmpdir(), 'changed-verifier-census-'));
      try {
        const f = await fixture(join(home, '.papercusp'));
        const path = `${f.receiptPath}.stdout.log`;
        if (corruption === 'changed') await writeFile(path, 'changed stream');
        if (corruption === 'missing') await rm(path);
        if (corruption === 'linked') { await rename(path, `${path}-target`); await symlink(`${path}-target`, path); }
        const result = await originals(home);
        expect(result.declarations.some(entry => entry.name.endsWith('.stdout.log'))).toBe(false);
        expect(result.declarations.some(entry => entry.name.endsWith('.stderr.log'))).toBe(true);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  });
  describe('native router retained census evidence', () => {
    const fixture = async (runtimeHome: string, partial = false, sourceFamily = false, large = false) => {
      const container = join(runtimeHome, 'test-artifacts', 'arbitrary-run-name');
      await mkdir(container, { recursive: true, mode: 0o700 });
      const packet = await mkdtemp(join(container, 'native-router-'));
      const out = sourceFamily ? join(container, 'arbitrary-report.json') : null;
      const sourceFiles: string[] = [];
      if (out) {
        await writeFile(out, JSON.stringify({ rows: [], padding: large ? 'x'.repeat(17 * 1024 * 1024) : '' }), { mode: 0o600 });
        sourceFiles.push(out);
        for (const suffix of ['.modules', '.native-processes', '.processes']) {
          const directory = `${out}${suffix}`;
          await mkdir(directory, { mode: 0o700 });
          const path = join(directory, 'writer-output');
          await writeFile(path, `retained ${suffix}`, { mode: 0o600 });
          sourceFiles.push(path);
        }
      }
      const identity = { workspace: 'fixture-workspace', harness: 'fixture', runId: 'fixture-run' };
      const auxiliary = ['stdout', 'stderr', 'command-exit.json'].map(role => ({
        role, state: 'produced' as const, path: join(packet, `group-0.${role}`),
      }));
      for (const entry of auxiliary) await writeFile(entry.path, entry.role === 'command-exit.json'
        ? JSON.stringify({ writer: 'router-owned-child-close', status: 0 }) : `retained ${entry.role}`, { mode: 0o600 });
      const expected: NativeCustodyGroup[] = [{ id: 'group-0', attempt: 'primary', selected: ['/fixture/test.ts'], runner: 'vitest',
        armed: sourceFamily, out, cwd: '/fixture', auxiliary: partial
          ? [...auxiliary, { role: 'report', state: 'unavailable', reason: 'fixture-missing-report' }] : auxiliary }];
      const contract = { identity, expected };
      await writeFile(join(packet, 'expected.json'), JSON.stringify(contract), { mode: 0o600 });
      const saved = retainNativeProofPacket(packet, { ...contract,
        observations: [{ id: 'group-0', out, captureComplete: true }], execution: 'router-settled' });
      await writeFile(join(packet, 'locator.json'), JSON.stringify(saved.locator), { mode: 0o600 });
      return { packet, container, saved, out, sourceFiles };
    };
    it.each(['valid', 'retained', 'untrusted-ref', 'changed', 'linked-file', 'linked-directory', 'foreign', 'forged-writer', 'failed-writer', 'changed-receipt', 'corrupt-packet'])(
      'derives only exact bounded verifier outputs from complete historical custody: %s', async condition => {
        const home = await mkdtemp(join(tmpdir(), 'bounded-verifier-census-'));
        try {
          const runtimeHome = join(home, '.papercusp');
          const f = await fixture(runtimeHome);
          const names = ['bg-memory-trace.log', 'bg-memory-sources.json', 'bg-memory-jit.dump',
            'bg-memory-observation.json', 'bg-memory-build.json', 'bg-memory-proof.json'];
          const rawArtifacts: Record<string, { sha256: string; byteLength: number }> = {};
          for (const name of names) {
            const bytes = Buffer.from(`original ${name}`);
            await writeFile(join(f.container, name), bytes);
            rawArtifacts[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
          }
          const unknown = join(f.container, 'unproven-output.json'); await writeFile(unknown, 'unknown sibling');
          const path = join(f.container, 'bounded-proof-receipt.json');
          const sourceSha256 = 'a'.repeat(64); const createdAt = new Date().toISOString();
          const cleanup = { fixtureRootAbsent: true, processes: {} };
          const receipt = { createdAt, workItem: 'WI-6554700010044858', testRunId: 23654091,
            sourcePath: 'packages/operator-core/lib/source-preview-export.test.ts', sourceSha256, terminalExitCode: 0,
            nativeManifest: { path: join(f.packet, 'objects', f.saved.locator.manifest.ref),
              sha256: f.saved.locator.manifest.sha256, byteLength: f.saved.locator.manifest.byteLength }, rawArtifacts, cleanup };
          await writeFile(path, JSON.stringify(receipt));
          const writer = await readFile(new URL('./fixtures/bounded-proof-writer.txt', import.meta.url), 'utf8');
          let toolInput = writer.replace('579a09b1f4b64092cb2d1217cc853483ec8addbf9beb66ce2b4f4d958882bfb8.native-proof.json',
            `${receipt.nativeManifest.sha256}.native-proof.json`).replace('len(b)==1533779', `len(b)==${receipt.nativeManifest.byteLength}`);
          if (condition === 'forged-writer') toolInput = toolInput.replace('raw_names=', 'other_names=');
          const startedAt = new Date(Date.parse(createdAt) - 1000).toISOString();
          const finishedAt = new Date(Date.parse(createdAt) + 1000).toISOString();
          const terminal = { exit_code: condition === 'failed-writer' ? 1 : 0,
            output: JSON.stringify({ receipt: path, cleanup, testRunId: 23654091, sourceSha256 }) };
          const archive = Buffer.from([
            { type: 'response_item', timestamp: startedAt, payload: { type: 'custom_tool_call', name: 'exec', call_id: 'writer', input: toolInput } },
            { type: 'response_item', timestamp: finishedAt, payload: { type: 'custom_tool_call_output', call_id: 'unrelated', output: '{}' } },
            { type: 'response_item', timestamp: finishedAt, payload: { type: 'custom_tool_call_output', call_id: 'writer', output: JSON.stringify(terminal) } },
          ].map(row => JSON.stringify(row)).join('\n'));
          const records = await recoverHistoricalCensusWriterEvidence([{ ref: 'indexed:bounded', sessionId: 'bounded-fixture',
            toolInput: toolInput.slice(0, 1000), startedAt, finishedAt }], async () => ({ bytes: archive,
            sha256: createHash('sha256').update(archive).digest('hex'),
            source: condition === 'retained' ? 'live-jsonl' : 'archive-manifest' }));
          if (condition === 'retained') expect(records[0].ref).toMatch(/^retained:codex:/);
          if (condition === 'untrusted-ref') records[0].ref = 'indexed:bounded';
          const target = join(f.container, names[0]);
          if (condition === 'changed') await writeFile(target, 'changed bytes');
          if (condition === 'linked-file') { await rename(target, `${target}-target`); await symlink(`${target}-target`, target); }
          if (condition === 'linked-directory') { await rename(f.container, `${f.container}-target`); await symlink(`${f.container}-target`, f.container); }
          if (condition === 'changed-receipt') await writeFile(path, JSON.stringify({ ...receipt, sourceSha256: 'b'.repeat(64) }));
          if (condition === 'corrupt-packet') await writeFile(receipt.nativeManifest.path, 'corrupt retained packet');
          const result = await historicalVerifierArtifactCensusProducer(records, condition === 'foreign' ? [join(home, 'foreign')] : [runtimeHome]);
          const declared = (file: string) => result.declarations.some(entry => entry.name === relative(runtimeHome, file));
          if (['valid', 'retained', 'changed', 'linked-file'].includes(condition)) {
            expect(declared(path)).toBe(true);
            expect(declared(target)).toBe(['valid', 'retained'].includes(condition));
            expect(declared(join(f.container, names[1]))).toBe(true);
            expect(declared(unknown)).toBe(false);
            const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
            expect(census.residue.some(entry => entry.name === relative(runtimeHome, unknown))).toBe(true);
            expect(result.declarations.every(entry => !entry.descendants && !entry.prune && entry.classification === 'state')).toBe(true);
          } else expect(result).toEqual({ roots: [], declarations: [] });
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    const native = async (home: string, runtimeHomes: string[] = []) => {
      const result = await runtimeSidefileCensusProducer(home, {}, [], runtimeHomes);
      const roots = [...result.roots];
      const focused = await runtimeTestArtifactCensusDeclarations([join(home, '.papercusp'), ...runtimeHomes, ...runtimeHomes], roots);
      expect(focused.filter(entry => entry.producer === 'test-file-native-router-custody'))
        .toEqual(result.declarations.filter(entry => entry.producer === 'test-file-native-router-custody'));
      expect(roots).toEqual(result.roots);
      return { ...result, declarations: result.declarations.filter(entry => entry.producer === 'test-file-native-router-custody') };
    };
    it.each(['valid', 'changed', 'linked-file', 'linked-container', 'foreign-container', 'foreign-out', 'unknown-role', 'not-produced', 'node'])(
      'classifies only exact local reporter auxiliary outputs: %s', async condition => {
        const home = await mkdtemp(join(tmpdir(), 'router-auxiliary-census-'));
        try {
          const runtimeHome = join(home, '.papercusp');
          const f = await fixture(runtimeHome);
          const contract = JSON.parse(await readFile(join(f.packet, 'expected.json'), 'utf8'));
          const roles = ['report', 'PC_EXECUTED_SOURCE_MAP_RESULT', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE'];
          const parent = condition === 'foreign-container' ? join(runtimeHome, 'test-artifacts', 'other-run')
            : condition === 'foreign-out' ? runtimeHome : f.container;
          await mkdir(parent, { recursive: true });
          const paths = roles.map((_, index) => join(parent, `arbitrary-reporter-output-${index}`));
          for (const path of paths) await writeFile(path, `retained ${path}`, { mode: 0o600 });
          const unknown = join(f.container, 'unproven-reporter-output');
          await writeFile(unknown, 'unproven neighbor');
          contract.expected[0].auxiliary.push(...roles.map((role, index) => condition === 'not-produced'
            ? { role, state: 'not-requested', reason: 'reporter-unset' }
            : { role: condition === 'unknown-role' ? `unknown-${index}` : role, state: 'produced', path: paths[index] }));
          if (condition === 'node') contract.expected[0].runner = 'node';
          await writeFile(join(f.packet, 'expected.json'), JSON.stringify(contract), { mode: 0o600 });
          const saved = retainNativeProofPacket(f.packet, { ...contract,
            observations: [{ id: 'group-0', out: null, captureComplete: true }], execution: 'router-settled' });
          await writeFile(join(f.packet, 'locator.json'), JSON.stringify(saved.locator), { mode: 0o600 });
          if (condition === 'changed') await writeFile(paths[0], 'changed after capture');
          if (condition === 'linked-file') {
            await rename(paths[0], `${paths[0]}-target`); await symlink(`${paths[0]}-target`, paths[0]);
          }
          if (condition === 'linked-container') {
            await rename(f.container, `${f.container}-target`); await symlink(`${f.container}-target`, f.container);
          }
          const result = await native(home);
          const declared = (path: string) => result.declarations.some(entry => entry.name === relative(runtimeHome, path));
          for (const [index, path] of paths.entries()) {
            expect(declared(path)).toBe(condition === 'valid'
              || (['changed', 'linked-file'].includes(condition) && index !== 0));
          }
          expect(declared(unknown)).toBe(false);
          expect(result.declarations.every(entry => !entry.descendants && !entry.prune && entry.classification === 'state')).toBe(true);
          expect(saved.manifest.verdicts.acceptance).toBe('unmeasured');
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    it.each([false, true])('classifies exact captured source families including chunked OUT=%s, preserving unknown siblings', async large => {
      const home = await mkdtemp(join(tmpdir(), 'source-family-census-'));
      try {
        const runtimeHome = join(home, '.papercusp');
        const f = await fixture(runtimeHome, false, true, large);
        const unknown = join(`${f.out}.modules`, 'not-captured');
        await writeFile(unknown, 'not owned');
        const result = await native(home);
        for (const path of f.sourceFiles) expect(result.declarations.some(entry => entry.name === relative(runtimeHome, path))).toBe(true);
        expect(result.declarations.some(entry => entry.name === relative(runtimeHome, unknown))).toBe(false);
        expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
        const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
        expect(census.residue.some(entry => entry.name === relative(runtimeHome, unknown))).toBe(true);
        expect(f.saved.manifest.verdicts.acceptance).toBe('unmeasured');
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['changed', 'linked-file', 'linked-directory', 'missing', 'foreign-container', 'foreign-out'])(
      'leaves %s source originals unresolved while retaining independent custody', async corruption => {
        const home = await mkdtemp(join(tmpdir(), 'invalid-source-family-census-'));
        try {
          const runtimeHome = join(home, '.papercusp');
          const f = await fixture(runtimeHome, false, true);
          const path = f.sourceFiles[1];
          if (corruption === 'changed') await writeFile(path, 'changed');
          if (corruption === 'missing') await rm(path);
          if (corruption === 'linked-file' || corruption === 'linked-directory') {
            const target = corruption === 'linked-file' ? path : dirname(path);
            await rename(target, `${target}-target`); await symlink(`${target}-target`, target);
          }
          if (corruption.startsWith('foreign')) {
            const foreign = corruption === 'foreign-out' ? join(runtimeHome, 'foreign-owned-file')
              : join(runtimeHome, 'test-artifacts', 'unrelated-container', 'report.json');
            await mkdir(dirname(foreign), { recursive: true });
            await writeFile(foreign, await readFile(f.out!));
            // The real writer can retain foreign inputs. Byte custody does
            // not adopt an original outside this packet's local output roots.
            const contract = JSON.parse(await readFile(join(f.packet, 'expected.json'), 'utf8'));
            contract.expected[0].out = foreign;
            const saved = retainNativeProofPacket(f.packet, { ...contract,
              observations: [{ id: 'group-0', out: contract.expected[0].out, captureComplete: true }], execution: 'router-settled' });
            await writeFile(join(f.packet, 'expected.json'), JSON.stringify(contract), { mode: 0o600 });
            await writeFile(join(f.packet, 'locator.json'), JSON.stringify(saved.locator), { mode: 0o600 });
            expect((await native(home)).declarations.some(entry => entry.name === relative(runtimeHome, foreign))).toBe(false);
          }
          const result = await native(home);
          expect(result.declarations.some(entry => entry.name === relative(runtimeHome, path))).toBe(false);
          expect(result.declarations.some(entry => entry.name.endsWith('/locator.json'))).toBe(true);
          if (!corruption.startsWith('foreign')) {
            expect(result.declarations.some(entry => entry.name === relative(runtimeHome, f.sourceFiles[2]))).toBe(true);
          }
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    it('uses verified custody in ordinary and registered homes while preserving unknown neighbors', async () => {
      const home = await mkdtemp(join(tmpdir(), 'native-census-'));
      try {
        const runtimeHome = join(home, '.papercusp');
        const registered = join(home, 'registered');
        const first = await fixture(runtimeHome);
        await fixture(registered);
        const unregistered = join(home, 'unregistered');
        await fixture(unregistered);
        const unknown = [join(first.container, 'owner.txt'), join(first.packet, 'owner.txt'),
          join(first.packet, 'objects', 'unreferenced.json')];
        for (const path of unknown) await writeFile(path, 'unknown retained input', { mode: 0o600 });
        const before = await readFile(join(first.packet, 'expected.json'));
        const result = await native(home, [registered]);
        expect(result.roots.some(root => root.path === unregistered)).toBe(false);
        expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
        const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
        for (const path of unknown) expect(census.residue.some(entry => path.endsWith(entry.name))).toBe(true);
        expect(census.inventory.filter(entry => entry.name.endsWith('/locator.json')).every(entry => entry.classification === 'state')).toBe(true);
        expect(census.inventory.filter(entry => entry.name.endsWith('/locator.json'))).toHaveLength(2);
        expect(await readFile(join(first.packet, 'expected.json'))).toEqual(before);
        expect(census.ok).toBe(false);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['object', 'expected', 'locator', 'linked-packet', 'linked-metadata', 'public-metadata', 'missing-locator'])(
      'leaves %s evidence unresolved', async corruption => {
        const home = await mkdtemp(join(tmpdir(), 'invalid-native-census-'));
        try {
          const { packet, saved } = await fixture(join(home, '.papercusp'));
          if (corruption === 'object') await writeFile(join(packet, 'objects', saved.locator.manifest.ref), '{}', { mode: 0o600 });
          if (corruption === 'expected') await writeFile(join(packet, 'expected.json'), JSON.stringify({ identity: {}, expected: [] }));
          if (corruption === 'locator') await writeFile(join(packet, 'locator.json'), '{}');
          if (corruption === 'public-metadata') await chmod(join(packet, 'expected.json'), 0o644);
          if (corruption === 'missing-locator') await rm(join(packet, 'locator.json'));
          if (corruption === 'linked-packet') { await rename(packet, `${packet}-target`); await symlink(`${packet}-target`, packet); }
          if (corruption === 'linked-metadata') {
            await rename(join(packet, 'expected.json'), join(home, 'expected.json'));
            await symlink(join(home, 'expected.json'), join(packet, 'expected.json'));
          }
          expect((await native(home)).declarations).toEqual([]);
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    it('preserves partial custody without treating it as native proof or acceptance', async () => {
      const home = await mkdtemp(join(tmpdir(), 'partial-native-census-'));
      try {
        const { saved } = await fixture(join(home, '.papercusp'), true);
        expect(saved.status).toBe('partial');
        expect(saved.manifest.verdicts).toMatchObject({ nativeProof: 'unqualified', acceptance: 'unmeasured' });
        expect((await native(home)).declarations.some(entry => entry.name.endsWith('/locator.json'))).toBe(true);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('preserves moved proof bytes while leaving changed original streams unresolved', async () => {
      const home = await mkdtemp(join(tmpdir(), 'moved-native-census-'));
      try {
        const { packet, container } = await fixture(join(home, '.papercusp'));
        await writeFile(join(packet, 'group-0.stdout'), 'changed original stream');
        let result = await native(home);
        expect(result.declarations.some(entry => entry.name.endsWith('/group-0.stdout'))).toBe(false);
        expect(result.declarations.some(entry => entry.name.endsWith('/group-0.stderr'))).toBe(true);
        await rename(container, `${container}-moved`);
        result = await native(home);
        expect(result.declarations.some(entry => entry.name.endsWith('/locator.json'))).toBe(true);
        expect(result.declarations.some(entry => entry.name.endsWith('/group-0.stderr'))).toBe(false);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('does not follow linked artifact containers or runtime homes', async () => {
      const home = await mkdtemp(join(tmpdir(), 'redirected-native-census-'));
      try {
        const runtimeHome = join(home, '.papercusp');
        const { container } = await fixture(runtimeHome);
        await rename(container, join(home, 'retained-container'));
        await symlink(join(home, 'retained-container'), container);
        expect((await native(home)).declarations).toEqual([]);
        await rename(runtimeHome, `${runtimeHome}-target`);
        await symlink(`${runtimeHome}-target`, runtimeHome);
        expect((await native(home)).declarations).toEqual([]);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  });
  it('retains runtime writer directories under the relocated active workspace without pruning credentials or diagnostics', async () => {
    const result = runtimeRetainedCensusProducer();
    expect(result.roots).toEqual([{ id: 'runtime-retained', path: '/relocated/workspaces/registered-project/.papercusp' }]);
    expect(result.declarations.map(entry => [entry.name, entry.classification, entry.prune])).toEqual([
      ['deploy-credentials', 'state', undefined], ['crash-reports', 'state', undefined], ['snapshot-fold-checkpoints', 'state', undefined],
      ['env-switcher-prefs.json', 'config', undefined],
      ['db-encryption-key', 'secret', undefined], ['oauth-state-key', 'secret', undefined],
      ['superuser-token', 'secret', undefined],
      ['granted-capabilities.json', 'config', undefined], ['extended-grants.json', 'config', undefined],
      ['local-announce-identity.json', 'state', undefined],
      ['migration-failure-cooldown.json', 'state', undefined],
      ['posthog.json', 'secret', undefined], ['release-sha256-cache.json', 'cache', undefined],
    ]);
    const writers = [
      ['../deployment/account-link-cli.ts', "papercuspPath('deploy-credentials'"],
      ['../process-supervision/fatal-diagnostics.ts', "papercuspPath('crash-reports')"],
      ['../sync/hyperbee/boot.ts', "'snapshot-fold-checkpoints'"],
      ['../harness/env-switcher-prefs.ts', "const FILE = 'env-switcher-prefs.json'"],
      ['../db-encryption.ts', "papercuspPath('db-encryption-key')"],
      ['../oauth/state.ts', "papercuspPath('oauth-state-key')"],
      ['../superuser-token.ts', "papercuspPath('superuser-token')"],
      ['../../../../libs/papercusp/packages/cli/src/consent.ts', "return join(papercuspRoot(), 'granted-capabilities.json')"],
      ['../../../../libs/papercusp/packages/cli/src/consent.ts', "return join(papercuspRoot(), 'extended-grants.json')"],
      ['../sync/hyperbee/local-announce-identity.ts', "papercuspPath('local-announce-identity.json')"],
      ['../db-boot-migrate.ts', "papercuspPath('migration-failure-cooldown.json')"],
    ];
    for (const [path, marker] of writers) expect(await readFile(new URL(path, import.meta.url), 'utf8')).toContain(marker);
    const installed = installedRootCensusProducers();
    expect(installed.declarations.find(entry => entry.producer === 'deployment-account-link')).toMatchObject({
      root: 'install-root-0', name: 'registered-project/.papercusp/deploy-credentials', classification: 'state',
    });
    expect(installed.declarations.find(entry => entry.producer === 'deployment-account-link')?.descendants).toBeUndefined();
  });
  it('retains the exact bearer in known homes without reading credentials or claiming copies and foreign homes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'retained-bearer-census-'));
    const homes = ['active', 'registered', 'default', 'legacy'].map(name => join(parent, name));
    const foreign = join(parent, 'foreign');
    const bytes = 'private-fixture-bearer-with-no-disclosure';
    const stamps = new Map<string, Awaited<ReturnType<typeof lstat>>>();
    try {
      for (const home of [...homes, foreign]) {
        await mkdir(join(home, 'nested'), { recursive: true });
        for (const name of ['superuser-token', 'superuser-token.bak', 'nested/superuser-token']) {
          const path = join(home, name);
          await writeFile(path, bytes, { mode: 0o600 });
          stamps.set(path, await lstat(path));
        }
      }
      const producers = homes.map(runtimeRetainedCensusProducer);
      const roots = producers.flatMap((producer, index) => producer.roots.map(root => ({ ...root, id: `known-${index}` })));
      const declarations = producers.flatMap((producer, index) => producer.declarations.map(entry => ({ ...entry, root: `known-${index}` })));
      const census = await collectStateCensus({ roots, declarations, readCatalogs: async () => [] });
      for (const root of roots) {
        expect(census.inventory.find(entry => entry.root === root.id && entry.name === 'superuser-token'))
          .toMatchObject({ classification: 'secret', producers: ['superuser-token'], problem: null });
        expect(census.residue.filter(entry => entry.root === root.id).map(entry => entry.name).sort())
          .toEqual(['nested', 'nested/superuser-token', 'superuser-token.bak']);
      }
      expect(roots.some(root => root.path === foreign)).toBe(false);
      expect(JSON.stringify(census)).not.toContain(bytes);
      for (const [path, before] of stamps) {
        const after = await lstat(path);
        for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(before[field]);
        expect(await readFile(path, 'utf8')).toBe(bytes);
      }
      expect(census.ok).toBe(false);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('uses the anchor producer path without resolving a backend or reading private key bytes', () => {
    expect(anchorSecretCensusProducer()).toEqual({ roots: [{ id: 'anchor-key-parent', path: '/fixture/sensitive' }],
      declarations: [{ kind: 'path', root: 'anchor-key-parent', name: 'anchor-key', classification: 'secret', producer: 'ledger-anchor-key' }] });
  });
  it('retains the keychain writer directory as sensitive state without pruning it', () => {
    expect(identityKeychainCensusProducer()).toEqual({ roots: [{ id: 'identity-keychain-parent', path: '/fixture/sensitive' }],
      declarations: [{ kind: 'path', root: 'identity-keychain-parent', name: 'identity', classification: 'secret', producer: 'identity-keychain', descendants: true }] });
  });
  it('derives retained database schema footprints from literal migration arrays without executing source', () => {
    const tables = migrationProducerTables('// CREATE TABLE fake (id text)\nexport const APP_MIGRATIONS = [`CREATE TABLE IF NOT EXISTS records (id text)`, `CREATE TABLE receipts (id text)`] as const;\nthrow new Error("must not execute");');
    expect(tables).toEqual(['public.records', 'public.receipts']);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'arbitrary' };
    const sources = [{ producer: 'fixture:migrations', tables }];
    expect(migrationDatabaseCensusDeclarations(entry, ['public.records'], sources)).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, tables, sources)[0]).toMatchObject({ name: 'arbitrary', classification: 'state', producer: 'fixture:migrations' });
    expect(migrationDatabaseCensusDeclarations(entry, tables, [{ producer: 'fixture:migrations', tables: [...tables, 'public.new_feature'] }])[0])
      .toMatchObject({ classification: 'state', producer: 'fixture:migrations:migration-prefix:2/3' });
  });
  it('retains canonical consult schema only with matching column names and types', async () => {
    const source = (await canonicalSqlMigrationCensusSources()).find(source => source.producer === 'canonical-sql-migration:834-consult-threads.sql');
    expect(source).toBeDefined();
    expect(source!.tables).toEqual(['harness_shared.consult_state', 'harness_shared.consult_post_meta']);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'arbitrary' };
    const columns = source!.columns!;
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], columns)[0])
      .toMatchObject({ classification: 'state', producer: source!.producer });
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!])).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], columns.filter(column => column.name !== 'routing'))).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], columns.map(column => column.name === 'routing' ? { ...column, type: 'text' } : column))).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables.map(table => table.replace('harness_shared.', 'public.')), [source!], columns)).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], [...columns, { table: source!.tables[0], name: 'dispatch_attempts', type: 'integer' }])[0]?.classification).toBe('state');
  });
  it('ignores SQL prose and rejects unsupported or unterminated schema evidence', () => {
    expect(sqlMigrationCensusSource("-- CREATE TABLE fake.first (id text);\nSELECT $$CREATE TABLE fake.second (id text);$$;", 'fixture')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE x.first (id text); CREATE TABLE x.second (id unsupported);', 'fixture')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE x.first (id text); CREATE TABLE x.second (id text', 'fixture')).toBeNull();
    expect(sqlMigrationCensusSource("CREATE TABLE x.first (id text DEFAULT 'a,b)'); CREATE TABLE x.second (id bigint, CHECK (id > 0));", 'fixture')?.tables).toEqual(['x.first', 'x.second']);
  });
  it('matches declared enum identities and rejects missing, wrong-case or wrong-schema metadata', () => {
    const source = sqlMigrationCensusSource('CREATE TYPE public."Role" AS ENUM(\'BUYER\'); CREATE TABLE first (role public."Role"); CREATE TABLE second (role public."Role" NOT NULL);', 'enum');
    expect(source?.columns).toHaveLength(2);
    expect(source?.columns?.[0]).toMatchObject({ type: 'USER-DEFINED', udtSchema: 'public', udtName: 'Role' });
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' };
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns)).toHaveLength(1);
    for (const patch of [{ udtName: 'role' }, { udtSchema: 'other' }, { udtName: undefined }, { type: 'text' }]) {
      expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns!.map(column => ({ ...column, ...patch })))).toEqual([]);
    }
    expect(sqlMigrationCensusSource('CREATE TABLE first (id text); CREATE TABLE second (role "Role");', 'missing')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE first (id text[]); CREATE TABLE second (id text);', 'array')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE first (id timestamp nonsense); CREATE TABLE second (id text);', 'unsupported')).toBeNull();
  });
  it('distinguishes timestamp zones and matches double precision metadata', () => {
    const source = sqlMigrationCensusSource('CREATE TABLE "Records" ("Created" timestamp without time zone, score double precision); CREATE TABLE receipts (created timestamp, received timestamptz, updated timestamp with time zone);', 'drizzle');
    expect(source?.columns?.map(column => column.type)).toEqual([
      'timestamp without time zone', 'double precision', 'timestamp without time zone',
      'timestamp with time zone', 'timestamp with time zone',
    ]);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' };
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns)).toHaveLength(1);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns!.map(column =>
      column.name === 'Created' ? { ...column, type: 'timestamp with time zone' } : column))).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns!.map(column =>
      column.name === 'score' ? { ...column, type: 'real' } : column))).toEqual([]);
  });
  it('preserves quoted identifier case while rejecting SQL-looking identifier prose', () => {
    const source = sqlMigrationCensusSource('CREATE TABLE "Records" ("Id" text); CREATE TABLE public."Receipts" (id bigint);', 'quoted');
    expect(source?.tables).toEqual(['public.Records', 'public.Receipts']);
    expect(source?.columns).toEqual([{ table: 'public.Records', name: 'Id', type: 'text' }, { table: 'public.Receipts', name: 'id', type: 'bigint' }]);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' };
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns)).toHaveLength(1);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables.map(name => name.toLowerCase()), [source!], source!.columns)).toEqual([]);
    expect(sqlMigrationCensusSource('SELECT "CREATE TABLE x.first (id text); CREATE TABLE x.second (id text)";', 'spoof')).toBeNull();
    expect(sqlMigrationCensusSource('/* outer /* CREATE TABLE x.first (id text) */ CREATE TABLE x.second (id text) */', 'spoof')).toBeNull();
  });
  it.skipIf(process.getuid?.() === 0)('does not classify unreadable installed source roots or abort readable source discovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unreadable-migration-census-'));
    const privateRoot = join(directory, 'private');
    const app = join(directory, 'app');
    try {
      await mkdir(privateRoot);
      await mkdir(join(app, 'drizzle'), { recursive: true });
      await writeFile(join(app, 'drizzle.config.ts'), "export default defineConfig({ out: './drizzle' });");
      await writeFile(join(app, 'drizzle/0000.sql'), 'CREATE TABLE public.first (id text); CREATE TABLE public.second (id text);');
      await chmod(privateRoot, 0);
      const sources = await registeredProjectMigrationSources([{ slug: 'private', path: privateRoot }, { slug: 'app', path: app }]);
      expect(sources).toHaveLength(1);
      expect(sources[0].producer).toContain('registry:app:');
    } finally { await chmod(privateRoot, 0o700); await rm(directory, { recursive: true, force: true }); }
  });
  it('discovers registered sibling migrations while excluding linked and missing sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'registered-migration-census-'));
    try {
      const app = join(directory, 'sibling');
      const linked = join(directory, 'linked');
      for (const path of [app, linked]) await mkdir(join(path, 'packages/data/src'), { recursive: true });
      const source = join(app, 'packages/data/src/migrations.ts');
      await writeFile(source, 'export const CALENDAR_MIGRATIONS = [`CREATE TABLE calendars (id text)`, `CREATE TABLE calendar_events (id text)`]; throw new Error("must not execute");');
      await symlink(source, join(linked, 'packages/data/src/migrations.ts'));
      const result = await registeredProjectMigrationSources([
        { slug: 'calendar', path: app }, { slug: 'duplicate', path: app },
        { slug: 'linked', path: linked }, { slug: 'missing', path: join(directory, 'absent') },
      ]);
      expect(result).toEqual([{ producer: `app-migrations:registry:calendar:${app}`, tables: ['public.calendars', 'public.calendar_events'] }]);
      expect(migrationDatabaseCensusDeclarations({ kind: 'database', root: 'postgres-cluster:123', name: 'calendar_app' }, result[0].tables, result)[0])
        .toMatchObject({ classification: 'state', producer: result[0].producer });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('proves an older migration schema after an earlier table insertion from exact-path Git history', async () => {
    const app = await mkdtemp(join(tmpdir(), 'historical-migration-census-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', app, ...args]);
      const name = 'packages/data/src/migrations.ts';
      await mkdir(join(app, 'packages/data/src'), { recursive: true });
      const old = 'export const APP_MIGRATIONS = [`CREATE TABLE calls (id text, search_document tsvector)`, `CREATE TABLE segments (id text)`];';
      await writeFile(join(app, name), old);
      await writeFile(join(app, 'unrelated.ts'), 'export const APP_MIGRATIONS = [`CREATE TABLE impostor (id text)`, `CREATE TABLE unrelated (id text)`];');
      git('init', '-q');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'old');
      const blob = git('rev-parse', `HEAD:${name}`).toString().trim();
      await writeFile(join(app, name), old.replace('`, `CREATE TABLE segments', '`, `CREATE TABLE preparations (id text)`, `CREATE TABLE segments'));
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'insert earlier table');
      const sources = await registeredProjectMigrationSources([{ slug: 'app', path: app }]);
      const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'arbitrary' };
      const tables = ['public.calls', 'public.segments'];
      const columns = [{ table: tables[0], name: 'id', type: 'text' },
        { table: tables[0], name: 'search_document', type: 'tsvector' },
        { table: tables[1], name: 'id', type: 'text' }];
      expect(migrationDatabaseCensusDeclarations(entry, tables, [sources[0]], columns)).toEqual([]);
      expect(migrationDatabaseCensusDeclarations(entry, tables, sources, columns)).toEqual([
        { ...entry, classification: 'state', producer: `app-migrations:registry:app:${app}:git-blob:${blob}:${name}` },
      ]);
      expect(migrationDatabaseCensusDeclarations(entry, tables, sources, columns.slice(1))).toEqual([]);
      expect(migrationDatabaseCensusDeclarations(entry, ['public.impostor', 'public.unrelated'], sources, columns)).toEqual([]);
      // A linked current source cannot confer access to any historical schema.
      await rm(join(app, name));
      await symlink(join(app, 'unrelated.ts'), join(app, name));
      expect(await registeredProjectMigrationSources([{ slug: 'linked', path: app }])).toEqual([]);
      expect(migrationProducerTables('export const APP_MIGRATIONS = [`CREATE TABLE a (id text)`, ...extra, `CREATE TABLE b (id text)`]')).toEqual([]);
    } finally { await rm(app, { recursive: true, force: true }); }
  });
  it('discovers literal Drizzle SQL from registered and installed-unit roots without executing config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drizzle-census-'));
    try {
      const app = join(directory, 'app');
      await mkdir(join(app, 'drizzle'), { recursive: true });
      const config = join(app, 'drizzle.config.ts');
      await writeFile(config, "export default defineConfig({ out: './drizzle' }); throw new Error('must not execute');");
      await writeFile(join(app, 'drizzle/0000_init.sql'), 'CREATE TABLE "Records" ("Id" text); CREATE TABLE "Receipts" (id bigint);');
      await writeFile(join(directory, 'app.service'), `[Unit]\nWorkingDirectory=/not/source\n[Service]\nWorkingDirectory=${app}\nEnvironmentFile=/must/not/read\n`);
      const units = await unitCensusDeclarations(directory, 'user');
      const registered = await registeredProjectMigrationSources([{ slug: 'app', path: app }]);
      expect(registered[0]?.tables).toEqual(['public.Records', 'public.Receipts']);
      const installed = await registeredProjectMigrationSources([], units);
      expect(installed[0]?.tables).toEqual(registered[0].tables);
      expect(installed[0]?.producer).toContain('unit:systemd-user:app.service');
      for (const out of ["process.env.OUT", "'../outside'", "'./linked'", "'./drizzle', ...overrides"]) {
        await writeFile(config, `export default defineConfig({ out: ${out} });`);
        expect(await registeredProjectMigrationSources([], units)).toEqual([]);
      }
      await symlink(join(app, 'drizzle'), join(app, 'linked'));
      await writeFile(config, "export default defineConfig({ out: './linked' });");
      expect(await registeredProjectMigrationSources([], units)).toEqual([]);
      await rm(config);
      await writeFile(join(directory, 'external-config.ts'), "export default defineConfig({ out: './drizzle' });");
      await symlink(join(directory, 'external-config.ts'), config);
      expect(await registeredProjectMigrationSources([], units)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('derives only active exact service environment files without reading their values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'unit-env-census-'));
    try {
      const root = { id: 'state', path: join(home, '.papercusp') };
      await mkdir(root.path);
      for (const name of ['reset.env', 'wrong-section.env', 'private value.env', 'percent%.env', 'unproven.env']) {
        await writeFile(join(root.path, name), 'credential bytes are never parsed', { mode: 0o000 });
      }
      await writeFile(join(home, 'app.service'), `[Unit]\nEnvironmentFile=%h/.papercusp/wrong-section.env\n[Service]\nEnvironmentFile=%h/.papercusp/reset.env\nEnvironmentFile=\nEnvironmentFile="%h/.papercusp/private value.env"\nEnvironmentFile='%h/.papercusp/percent%%.env'\nEnvironmentFile=-%h/.papercusp/missing.env\nEnvironmentFile=%h/.papercusp/*.env\nEnvironmentFile=%h/.papercusp/%u.env\nEnvironmentFile=%h/.papercusp/unproven.env \\\nEnvironmentFile=%h/.papercusp/unproven.env\n`);
      const units = await unitCensusDeclarations(home, 'user');
      const declarations = await unitEnvironmentFileCensusDeclarations(units, [root], home);
      expect(declarations.map(entry => entry.name)).toEqual(['private value.env', 'percent%.env']);
      expect(declarations.every(entry => entry.classification === 'secret' && !entry.descendants)).toBe(true);
      expect(JSON.stringify(declarations)).not.toContain('credential bytes');
      const census = await collectStateCensus({ roots: [root], declarations, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name).sort()).toEqual(['reset.env', 'unproven.env', 'wrong-section.env']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('retains exact environment links but excludes linked parents, directories and out-of-root paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'unit-env-links-'));
    try {
      const root = { id: 'state', path: join(home, 'state') };
      const outside = join(home, 'outside');
      await mkdir(root.path); await mkdir(outside);
      await writeFile(join(outside, 'private.env'), 'must not be opened', { mode: 0o000 });
      await symlink(join(outside, 'private.env'), join(root.path, 'mounted.env'));
      await symlink(join(outside, 'missing.env'), join(root.path, 'dangling.env'));
      await symlink(outside, join(root.path, 'linked-parent'));
      await mkdir(join(root.path, 'directory.env'));
      const paths = [join(root.path, 'mounted.env'), join(root.path, 'dangling.env'),
        join(root.path, 'linked-parent', 'private.env'), join(root.path, 'directory.env'),
        join(outside, 'private.env'), join(root.path, '..', 'outside', 'private.env'), root.path];
      await writeFile(join(home, 'app.service'), `[Service]\n${paths.map(path => `EnvironmentFile=${path}`).join('\n')}\n`);
      const units = await unitCensusDeclarations(home, 'user');
      expect((await unitEnvironmentFileCensusDeclarations(units, [root], home)).map(entry => entry.name))
        .toEqual(['mounted.env', 'dangling.env']);
      expect(await readlink(join(root.path, 'mounted.env'))).toBe(join(outside, 'private.env'));
      expect(await unitEnvironmentFileCensusDeclarations([{ ...units[0], producer: 'forged' }], [root], home)).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('accepts same-name installed links without following aliases, masks or shadow definitions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'unit-env-shadow-'));
    try {
      const root = { id: 'home', path: home };
      const shadow = join(home, 'shadow'); await mkdir(shadow);
      await writeFile(join(home, 'private.env'), 'private');
      const definition = '[Service]\nEnvironmentFile=%h/private.env\n';
      await writeFile(join(shadow, 'app.service'), definition);
      await symlink(join(shadow, 'app.service'), join(home, 'app.service'));
      const units = [...await unitCensusDeclarations(home, 'user'), ...await unitCensusDeclarations(shadow, 'user')];
      expect(await unitEnvironmentFileCensusDeclarations(units, [root], home)).toEqual([{
        kind: 'path', root: 'home', name: 'private.env', classification: 'secret',
        producer: 'unit-environment-file:systemd-user:app.service',
      }]);
      await symlink(join(shadow, 'app.service'), join(home, 'alias.service'));
      await symlink('/dev/null', join(home, 'masked.service'));
      await symlink(join(home, 'missing.service'), join(home, 'missing.service'));
      await writeFile(join(shadow, 'masked.service'), definition);
      await writeFile(join(shadow, 'missing.service'), definition);
      const linked = [...await unitCensusDeclarations(home, 'user'), ...await unitCensusDeclarations(shadow, 'user')];
      expect((await unitEnvironmentFileCensusDeclarations(linked, [root], home)).map(entry => entry.producer))
        .toEqual(['unit-environment-file:systemd-user:app.service']);
      await rm(join(home, 'app.service')); await writeFile(join(home, 'app.service'), definition);
      expect(await unitEnvironmentFileCensusDeclarations(await unitCensusDeclarations(home, 'system'), [root], home)).toEqual([]);
      const user = await unitCensusDeclarations(home, 'user');
      expect((await unitEnvironmentFileCensusDeclarations(user, [root], home))[0]).toMatchObject({ name: 'private.env', classification: 'secret' });
      await writeFile(join(home, 'app.service'), '[Service]\nEnvironmentFile=%h/private.env\nEnvironmentFile=""\n');
      expect(await unitEnvironmentFileCensusDeclarations(user, [root], home)).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('joins local service database config with the measured catalogue and excludes remote endpoints', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unit-db-census-'));
    try {
      await writeFile(join(path, 'app.service'), '[Service]\nEnvironment="APP_DATABASE_URL=postgresql://user:private@127.0.0.1:5432/app" "OTHER_DATABASE_URL=postgresql://remote:private@example.com/app"\n');
      const units = await unitCensusDeclarations(path, 'user');
      const databases = [{ kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' }];
      const result = await unitDatabaseCensusDeclarations(units, databases, 'postgresql://localhost/operator');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'app', classification: 'state', producer: 'unit-database-config:systemd-user:app.service:APP_DATABASE_URL' });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(await unitDatabaseCensusDeclarations(units, [], 'postgresql://localhost/operator')).toEqual([]);
      await writeFile(join(path, 'runtime.env'), 'APP_DATABASE_URL=postgresql://user:private@localhost:5432/app\n');
      await writeFile(join(path, 'app.service'), `[Service]\nEnvironmentFile=${join(path, 'runtime.env')}\nEnvironmentFile=-${join(path, 'missing.env')}\n`);
      expect(await unitDatabaseCensusDeclarations(units, databases, 'postgresql://localhost/operator')).toHaveLength(1);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('continues inspecting surviving units when a discovered transient definition disappears', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unit-db-disappeared-'));
    try {
      const definition = '[Service]\nEnvironment=APP_DATABASE_URL=postgresql://localhost:5432/app\n';
      await writeFile(join(path, 'gone.service'), definition);
      await writeFile(join(path, 'live.service'), definition);
      const units = await unitCensusDeclarations(path, 'user');
      await rm(join(path, 'gone.service'));
      const result = await unitDatabaseCensusDeclarations(units,
        [{ kind: 'database', root: 'postgres-cluster:123', name: 'app' }], 'postgresql://localhost/operator');
      expect(result).toHaveLength(1);
      expect(result[0].producer).toContain('live.service');
      // Unexpected inspection errors still fail closed.
      await writeFile(join(path, 'live.service'), 'x'.repeat(65_537));
      await expect(unitDatabaseCensusDeclarations(units, [], 'postgresql://localhost/operator'))
        .rejects.toThrow('Service database config bound exceeded');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('derives hosted config paths from writer overrides and keeps credentials secret', async () => {
    const writer = await readFile(new URL('../../../../apps/operator/scripts/systemd/deploy-hosted-control-plane.sh', import.meta.url), 'utf8');
    expect(writer).toContain('PAPERCUSP_HOSTED_CP_ENV_FILE');
    expect(writer).toContain('hosted-control-plane.env');
    vi.stubEnv('PAPERCUSP_HOSTED_CP_ENV_FILE', '/fixture/credentials/hosted.env');
    vi.stubEnv('PUI_PORTAL_LINKS_ENV', '/fixture/config/links.env');
    try {
      const result = hostedConfigurationCensusProducers();
      expect(result.declarations.find(entry => entry.producer === 'deploy-hosted-control-plane')).toMatchObject({ name: 'hosted.env', classification: 'secret' });
      expect(result.declarations.find(entry => entry.producer === 'publish-tui-release')).toMatchObject({ name: 'links.env', classification: 'config' });
    } finally { vi.unstubAllEnvs(); }
  });
  it('retains the consumed VM environment as a secret after home relocation without owning neighboring files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vm-config-census-'));
    const directory = join(home, '.papercusp');
    const file = join(directory, 'build-vms.env');
    try {
      vi.stubEnv('PAPERCUSP_HOME', join(home, 'workspace-home'));
      await mkdir(directory);
      await writeFile(file, 'private VM config must not enter census output', { mode: 0o600 });
      await writeFile(join(directory, 'unproven.env'), 'foreign');
      await mkdir(join(directory, 'copied'));
      await writeFile(join(directory, 'copied', 'build-vms.env'), 'foreign');
      const before = await lstat(file);
      const result = hostedConfigurationCensusProducers(home);
      const declarations = result.declarations.filter(entry => entry.producer === 'admin-build-vm-config');
      expect(declarations).toHaveLength(1);
      const roots = result.roots.filter(root => root.id === declarations[0].root);
      expect(roots[0].path).toBe(directory);
      const census = await collectStateCensus({ roots, declarations, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === 'build-vms.env')).toMatchObject({
        classification: 'secret', producers: ['admin-build-vm-config'],
      });
      expect(census.residue.map(entry => entry.name).sort()).toEqual(['copied', 'copied/build-vms.env', 'unproven.env']);
      expect(JSON.stringify(census)).not.toContain('private VM config');
      expect(await lstat(file)).toEqual(before);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('qualifies operator state from the configured URL and pins the SU side-db to its writer', async () => {
    const source = await readFile(new URL('../../../../libs/papercusp/packages/locks/src/su-lock-store.ts', import.meta.url), 'utf8');
    expect(source).toContain("'/papercusp_su$1'");
    expect(configuredOperatorDatabaseCensusDeclarations('postgres-cluster:123', 'postgresql://user:password@localhost:5432/relocated')).toEqual([
      { kind: 'database', root: 'postgres-cluster:123', name: 'relocated', classification: 'state', producer: 'embedded-pg-discovery-operator' },
      { kind: 'database', root: 'postgres-cluster:123', name: 'papercusp_su', classification: 'state', producer: 'su-lock-store' },
    ]);
    expect(() => configuredOperatorDatabaseCensusDeclarations('port:5432', 'postgresql://localhost/db')).toThrow('identity');
  });
  it('retains the initdb maintenance database only with fixed catalog identity on the measured cluster', async () => {
    const marker = 'default administrative connection database';
    const catalog = { oid: 5, datname: 'postgres', datistemplate: false, marker };
    const sql = vi.fn().mockResolvedValueOnce([{ system_identifier: '123' }]).mockResolvedValueOnce([catalog]);
    expect(await maintenanceDatabaseCensusDeclarations(sql as unknown as Sql, 'postgres-cluster:123')).toEqual([
      { kind: 'database', root: 'postgres-cluster:123', name: 'postgres', classification: 'state', producer: 'postgres-initdb-maintenance' },
    ]);
    for (const impostor of [{ ...catalog, oid: 12345 }, { ...catalog, marker: null },
      { ...catalog, datname: 'customer' }, { ...catalog, datistemplate: true }]) {
      const other = vi.fn().mockResolvedValueOnce([{ system_identifier: '123' }]).mockResolvedValueOnce([impostor]);
      expect(await maintenanceDatabaseCensusDeclarations(other as unknown as Sql, 'postgres-cluster:123')).toEqual([]);
    }
    const foreign = vi.fn().mockResolvedValue([{ system_identifier: '456' }]);
    await expect(maintenanceDatabaseCensusDeclarations(foreign as unknown as Sql, 'postgres-cluster:123')).rejects.toThrow('mismatch');
    expect(foreign).toHaveBeenCalledTimes(1);
    await expect(maintenanceDatabaseCensusDeclarations(sql as unknown as Sql, 'port:5432')).rejects.toThrow('identity');
  });
  it('uses the template producer readiness marker rather than treating similar database names as disposable', async () => {
    const source = await readFile(new URL('../../../../libs/test-config/src/pg-migrate.ts', import.meta.url), 'utf8');
    expect(source).toContain("const TEMPLATE_READY_MARK = 'pc-template-ready';");
    const sql = vi.fn(async () => [{ datname: 'tmpl_fixture', marker: 'pc-template-ready' },
      { datname: 'tmpl_customer', marker: null }, { datname: 'customer', marker: 'pc-template-ready' }]);
    expect(await templateDatabaseCensusDeclarations(sql as unknown as Sql, 'postgres-cluster:123')).toEqual([
      { kind: 'database', root: 'postgres-cluster:123', name: 'tmpl_fixture', classification: 'dev-only', producer: 'pg-migrate-template-ready' },
    ]);
    await expect(templateDatabaseCensusDeclarations(sql as unknown as Sql, 'port:5432')).rejects.toThrow('identity');
  });
  it('qualifies arbitrarily named Python environments by marker and package layout', async () => {
    const path = await mkdtemp(join(tmpdir(), 'virtualenv-census-'));
    try {
      const environment = join(path, 'arbitrary');
      await mkdir(join(environment, 'lib', 'python3.12', 'site-packages'), { recursive: true });
      await mkdir(join(environment, 'bin'));
      await writeFile(join(environment, 'bin', 'python'), 'fixture');
      await writeFile(join(environment, 'pyvenv.cfg'), 'home = /usr/bin\nversion_info = 3.12.3\ninclude-system-site-packages = false\n');
      expect(await virtualenvCacheDeclaration({ id: 'fixture', path }, 'arbitrary')).toMatchObject({ name: 'arbitrary', classification: 'cache', prune: true });
      await rm(join(environment, 'lib'), { recursive: true });
      await expect(virtualenvCacheDeclaration({ id: 'fixture', path }, 'arbitrary')).rejects.toThrow();
      await expect(virtualenvCacheDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('pins analysis-cache ownership to the actual writer and honors relocation', async () => {
    const writer = await readFile(new URL('../../../../scripts/lib/strip-comments-and-strings.mjs', import.meta.url), 'utf8');
    expect(writer).toContain('process.env.PAPERCUSP_STRIP_CACHE_DIR');
    expect(writer).toContain("path.join(os.homedir(), '.papercusp', 'cache', 'strip-ranges')");
    vi.stubEnv('PAPERCUSP_STRIP_CACHE_DIR', '/fixture/analysis/cache');
    try {
      expect(stripRangeCacheCensusProducer()).toMatchObject({ roots: [{ path: '/fixture/analysis' }],
        declarations: [{ name: 'cache', classification: 'cache', prune: true }] });
      vi.stubEnv('PAPERCUSP_STRIP_CACHE_DIR', '');
      expect(stripRangeCacheCensusProducer('/fixture/home')).toMatchObject({
        roots: [{ path: '/fixture/home/.papercusp/cache' }],
        declarations: [{ name: 'strip-ranges', classification: 'cache', prune: true }],
      });
    } finally { vi.unstubAllEnvs(); }
  });
  it('retains only completed direct restore clones and refuses active or symlinked targets', async () => {
    const path = await mkdtemp(join(tmpdir(), 'restore-census-'));
    try {
      const target = join(path, '.restored', 'snapshot', 'clone');
      await mkdir(target, { recursive: true });
      const rows = [{ id: '123', target, phase: 'done' }, { id: '124', target: join(path, '.restored', 'active', 'clone'), phase: 'started' }];
      const sql = vi.fn(async () => rows) as unknown as Sql;
      const declarations = await restoredCloneCensusDeclarations(sql, 'workspace', path, [{ id: 'home', path }]);
      expect(declarations).toHaveLength(1);
      expect(declarations[0]).toMatchObject({ name: '.restored/snapshot/clone', classification: 'state', recoveryStorage: { restoreEventId: '123' } });
      await rm(target, { recursive: true });
      await symlink(path, target, 'dir');
      expect(await restoredCloneCensusDeclarations(sql, 'workspace', path, [{ id: 'home', path }])).toEqual([]);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('preserves published portal generations only after matching their producer manifest', async () => {
    const path = await mkdtemp(join(tmpdir(), 'release-census-'));
    try {
      await mkdir(join(path, 'generation'));
      const manifest = { schemaVersion: 2, release: 'generation', buildId: 'build', sourceRoot: '/source', publishedAt: '2026-10-08T00:00:00Z' };
      await writeFile(join(path, 'generation', '.papercusp-release.json'), JSON.stringify(manifest));
      await writeFile(join(path, 'generation', 'standalone-entry.mjs'), 'fixture');
      const owner = await portalReleaseStorageDeclaration({ id: 'fixture', path }, 'generation');
      expect(owner.classification).toBe('state');
      expect(owner.releaseStorage?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
      await writeFile(join(path, 'generation', '.papercusp-release.json'), JSON.stringify({ ...manifest, sourceRoot: 'C:\\portal' }));
      expect((await portalReleaseStorageDeclaration({ id: 'fixture', path }, 'generation')).classification).toBe('state');
      await writeFile(join(path, 'generation', '.papercusp-release.json'), JSON.stringify({ ...manifest, release: 'other' }));
      await expect(portalReleaseStorageDeclaration({ id: 'fixture', path }, 'generation')).rejects.toThrow('manifest');
      await expect(portalReleaseStorageDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('reads peer marker evidence without modifying storage and rejects malformed or linked markers', async () => {
    const path = await mkdtemp(join(tmpdir(), 'peer-census-'));
    try {
      await mkdir(join(path, 'hyperbee', 'db'), { recursive: true });
      const marker = 'device/platform=linux\ndevice/inode=123\ndevice/created=456\n';
      await writeFile(join(path, 'hyperbee', 'CORESTORE'), marker);
      const declaration = await peerStorageDeclaration({ id: 'fixture', path }, 'hyperbee');
      expect(declaration.peerStorage?.markerSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(join(path, 'hyperbee', 'CORESTORE'), 'utf8')).toBe(marker);
      await writeFile(join(path, 'hyperbee', 'CORESTORE'), 'not a device file');
      await expect(peerStorageDeclaration({ id: 'fixture', path }, 'hyperbee')).rejects.toThrow('marker');
      await rm(join(path, 'hyperbee', 'CORESTORE'));
      await writeFile(join(path, 'elsewhere'), marker);
      await symlink(join(path, 'elsewhere'), join(path, 'hyperbee', 'CORESTORE'));
      await expect(peerStorageDeclaration({ id: 'fixture', path }, 'hyperbee')).rejects.toThrow();
      await expect(peerStorageDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('measures primary Git metadata and preserves linked pointers within the same inventory root', async () => {
    const path = await mkdtemp(join(tmpdir(), 'git-storage-census-'));
    try {
      const git = join(path, 'primary', '.git');
      await mkdir(join(git, 'objects'), { recursive: true });
      await mkdir(join(git, 'refs'), { recursive: true });
      await writeFile(join(git, 'HEAD'), `${'a'.repeat(40)}\n`);
      const primary = await gitStorageDeclaration({ id: 'fixture', path }, 'primary');
      expect(primary.gitStorage?.head).toBe('a'.repeat(40));
      const linked = join(git, 'worktrees', 'linked');
      await mkdir(linked, { recursive: true });
      await writeFile(join(linked, 'HEAD'), `${'a'.repeat(40)}\n`);
      await writeFile(join(linked, 'commondir'), '../..\n');
      await mkdir(join(path, 'linked'));
      await writeFile(join(path, 'linked', '.git'), `gitdir: ${linked}\n`);
      const pointer = await gitStorageDeclaration({ id: 'fixture', path }, 'linked');
      expect(pointer.producer).toBe('git-worktree-pointer');
      expect(pointer.gitStorage).toBeUndefined();
      const worktree = await gitStorageDeclaration({ id: 'fixture', path }, 'linked', true);
      expect(worktree.name).toBe('linked');
      expect(worktree.gitStorage?.head).toBe('a'.repeat(40));
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('refuses repository traversal before invoking Git', async () => {
    await expect(gitStorageDeclaration({ id: 'fixture', path: '/fixture' }, '../outside'))
      .rejects.toThrow('Invalid repository path');
  });
  it('refuses unverified PG storage and traversal paths before creating ownership', async () => {
    const path = await mkdtemp(join(tmpdir(), 'pg-storage-owner-'));
    try {
      await writeFile(join(path, 'PG_VERSION'), 'not-postgres');
      await expect(postgresStorageDeclaration({ id: 'fixture', path }, '.')).rejects.toThrow('Invalid PG storage version');
      await expect(postgresStorageDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('Invalid PG storage path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('pins baseline classification to the current producer identity format', async () => {
    const producer = await readFile(new URL('../../../../libs/test-config/src/baseline-schema-global-setup.ts', import.meta.url), 'utf8');
    expect(producer).toContain('const dbName = `papercusp_it_baseline_${randomBytes(6).toString(\'hex\')}`;');
  });
  it('classifies only exact producer-shaped integration baselines, not similar production names', () => {
    const entries = ['papercusp_it_baseline_123456abcdef', 'papercusp_it_baseline_customer', 'scratch_customer'].map(name =>
      ({ kind: 'database' as const, root: 'cluster', name }));
    expect(integrationBaselineCensusDeclarations(entries).map(entry => entry.name))
      .toEqual(['papercusp_it_baseline_123456abcdef']);
  });
  it('qualifies catalog entries with measured physical PG identity, not a port or DB name', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray): Promise<Record<string, string>[]> => [])
      .mockResolvedValueOnce([{ system_identifier: '123456789' }])
      .mockResolvedValueOnce([{ datname: 'app' }]);
    expect(await physicalDatabaseCensusEntries(sql as unknown as Sql)).toEqual([
      { kind: 'database', root: 'postgres-cluster:123456789', name: 'app' },
    ]);
    await expect(physicalDatabaseCensusEntries(vi.fn(async () => []) as unknown as Sql))
      .rejects.toThrow('physical database cluster identity');
  });
  it('merges nested roots without losing child-relative secret ownership or conflating prefixes', () => {
    const parent = join(tmpdir(), 'nested-census', 'app');
    const sibling = `${parent}-other`;
    const result = mergeNestedCensusRoots({ roots: [
      { id: 'child', path: join(parent, 'secrets') }, { id: 'parent', path: parent },
      { id: 'sibling', path: sibling },
    ], declarations: [{ kind: 'path', root: 'child', name: 'key', classification: 'secret', producer: 'key' }] });
    expect(result.roots.map(root => root.id)).toEqual(['parent', 'sibling']);
    expect(result.roots.map(root => root.path)).toEqual([parent, sibling]);
    expect(result.declarations[0]).toMatchObject({ root: 'parent', name: 'secrets/key', classification: 'secret' });
  });
  it('composes writer roots and rewrites declaration identities consistently', () => {
    const result = installedRootCensusProducers();
    expect(new Set(result.roots.map(root => root.path)).size).toBe(result.roots.length);
    expect(result.declarations.every(entry => result.roots.some(root => root.id === entry.root))).toBe(true);
    expect(result.declarations.some(entry => entry.name === 'db-key' && entry.classification === 'secret')).toBe(true);
  });
  it('derives scratch cache ownership from the relocated writer root', () => {
    const result = scratchCensusProducer();
    expect(result.roots[0].path).toBe('/relocated/cache');
    expect(result.declarations[0]).toMatchObject({ name: 'spills', classification: 'cache', prune: true });
  });
  it('derives unit classification from installer sources, not installed-unit observations', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unit-producer-'));
    try {
      await writeFile(join(path, 'app.service'), '[Service]');
      await symlink('/dev/null', join(path, 'masked.service'));
      await writeFile(join(path, 'data.mount'), '[Mount]');
      await writeFile(join(path, 'README.md'), 'not a unit');
      const declarations = await unitCensusDeclarations(path, 'user');
      expect(declarations.map(entry => entry.name).sort()).toEqual(['app.service', 'data.mount', 'masked.service']);
      expect(declarations[0].classification).toBe('config');
      expect(declarations[0].producer).toBe(`unit-definition:${path}`);
      expect((await unitCensusDeclarations(path, 'user', 'dev-only'))[0].classification).toBe('dev-only');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'linux')('discovers runtime and relocated unit definitions through systemd load paths', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'unit-load-paths-'));
    const user = join(runtime, 'systemd', 'user');
    const transient = join(runtime, 'systemd', 'transient');
    const data = join(runtime, 'relocated-data', 'systemd', 'user');
    vi.stubEnv('XDG_RUNTIME_DIR', runtime);
    try {
      for (const source of [user, transient, data]) await mkdir(source, { recursive: true });
      await writeFile(join(user, 'runtime.service'), '[Service]\nExecStart=/bin/true\n');
      await symlink('/dev/null', join(user, 'masked.service'));
      await writeFile(join(transient, 'task.service'), '[Service]\nExecStart=/bin/true\n');
      await writeFile(join(data, 'relocated.timer'), '[Timer]\nOnBootSec=1\n');
      const readPaths = vi.fn(async () => [user, transient, data, user, join(runtime, 'missing')]);
      const declarations = await installedUnitCensusDeclarations('user', readPaths);
      expect(readPaths).toHaveBeenCalledWith('user');
      expect(declarations.map(row => row.name).sort()).toEqual([
        'masked.service', 'relocated.timer', 'runtime.service', 'task.service',
      ]);
      expect(declarations.find(row => row.name === 'runtime.service')).toMatchObject({
        root: 'systemd-user', classification: 'config', producer: `unit-definition:${user}`,
      });
      expect(declarations.find(row => row.name === 'task.service')?.classification).toBe('dev-only');
      await expect(installedUnitCensusDeclarations('user', async () => [])).rejects.toThrow('Invalid systemd unit source paths');
      await expect(installedUnitCensusDeclarations('user', async () => ['relative'])).rejects.toThrow('Invalid systemd unit source paths');
      await expect(installedUnitCensusDeclarations('user', async () => { throw new Error('resolver unavailable'); }))
        .rejects.toThrow('resolver unavailable');
    } finally {
      vi.unstubAllEnvs();
      await rm(runtime, { recursive: true, force: true });
    }
  });
  it('uses the registry writer root without blanket-classifying sibling workspaces', () => {
    const producer = workspaceRegistryCensusProducer();
    expect(producer.roots).toEqual([{ id: 'workspace-registry', path: '/relocated/workspaces' }]);
    expect(producer.declarations).toEqual(expect.arrayContaining([{
      kind: 'path', root: 'workspace-registry', name: 'registry.json',
      classification: 'config', producer: 'workspace-registry',
    }, {
      kind: 'path', root: 'workspace-registry', name: 'registered-project',
      classification: 'state', producer: 'workspace-registry',
    }]));
  });
  it('retains native shared identity paths without inheriting ownership into copies or linked targets', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'desktop-shared-identity-census-'));
    const registry = join(parent, 'registry');
    const shared = join(registry, '.shared', '.papercusp');
    const external = join(parent, 'external-key');
    const key = join(shared, 'identity', 'keypair-owner.enc');
    const announcement = join(shared, 'local-announce-identity.json');
    try {
      await mkdir(join(shared, 'identity'), { recursive: true });
      await mkdir(join(shared, 'identity-copy'));
      await mkdir(join(shared, 'nested', 'identity'), { recursive: true });
      await writeFile(key, 'encrypted identity fixture', { mode: 0o600 });
      await writeFile(announcement, '{"identityMode":"authoring"}', { mode: 0o600 });
      await writeFile(external, 'external identity fixture', { mode: 0o600 });
      await symlink(external, join(shared, 'identity', 'external'));
      await writeFile(join(shared, 'foreign'), 'unattributed state');
      await writeFile(`${announcement}.bak`, await readFile(announcement));
      await writeFile(join(shared, 'identity-copy', 'keypair-owner.enc'), await readFile(key));
      await writeFile(join(shared, 'nested', 'identity', 'keypair-owner.enc'), await readFile(key));
      const before = await Promise.all([key, announcement, external].map(async path =>
        ({ path, bytes: await readFile(path), metadata: await lstat(path) })));
      // A source-tree census does not inherit the native launcher's overrides.
      vi.stubEnv('PAPERCUSP_IDENTITY_DIR', join(parent, 'other-identity'));
      vi.stubEnv('PAPERCUSP_ANNOUNCE_IDENTITY_CACHE', join(parent, 'other-announcement'));
      const producer = workspaceRegistryCensusProducer();
      const result = await collectStateCensus({ ...producer,
        roots: producer.roots.map(root => ({ ...root, path: registry })), readCatalogs: async () => [] });
      for (const name of ['.shared/.papercusp', '.shared/.papercusp/local-announce-identity.json']) {
        expect(result.inventory.find(entry => entry.name === name)).toMatchObject({ classification: 'state', problem: null });
        expect(producer.declarations.find(entry => entry.name === name)?.descendants).toBeUndefined();
      }
      for (const name of ['.shared/.papercusp/identity', '.shared/.papercusp/identity/keypair-owner.enc']) {
        expect(result.inventory.find(entry => entry.name === name)).toMatchObject({
          classification: 'secret', producers: ['identity-keychain'], problem: null });
      }
      expect(result.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        '.shared/.papercusp/foreign', '.shared/.papercusp/local-announce-identity.json.bak',
        '.shared/.papercusp/identity-copy', '.shared/.papercusp/identity-copy/keypair-owner.enc',
        '.shared/.papercusp/nested', '.shared/.papercusp/nested/identity',
        '.shared/.papercusp/nested/identity/keypair-owner.enc',
      ]));
      expect(result.ok).toBe(false);
      expect(await readlink(join(shared, 'identity', 'external'))).toBe(external);
      expect(result.inventory.some(entry => entry.name.includes('external/'))).toBe(false);
      for (const { path, bytes, metadata } of before) {
        expect(await readFile(path)).toEqual(bytes);
        const after = await lstat(path);
        for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(metadata[field]);
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(parent, { recursive: true, force: true });
    }
  });
  it('retains desktop shared and registered credential entries without inheriting ownership into siblings or copies', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'desktop-workspace-census-'));
    const registry = join(parent, 'registry');
    const linkTarget = join(parent, 'credential-target');
    const config = 'user-authored identity configuration';
    try {
      await writeFile(linkTarget, 'fixture credential');
      for (const workspace of ['registered-project', 'unregistered']) {
        const path = join(registry, workspace);
        await mkdir(join(path, '.claude'), { recursive: true });
        await symlink(linkTarget, join(path, '.claude.json'));
        await symlink(linkTarget, join(path, '.claude', '.credentials.json'));
        await writeFile(join(path, '.gitconfig'), config);
        await writeFile(join(path, '.claude', 'unrelated'), 'foreign');
        await writeFile(join(path, '.gitconfig.bak'), config);
      }
      await mkdir(join(registry, '.shared', 'nested'), { recursive: true });
      await mkdir(join(registry, '.shared', 'dev-source'), { recursive: true });
      await mkdir(join(registry, '.shared', 'dev-source', '.git'));
      await mkdir(join(registry, '.shared', 'dev-source-copy'));
      await mkdir(join(registry, '.shared', 'nested', 'dev-source'), { recursive: true });
      await mkdir(join(registry, 'unregistered', 'dev-source'), { recursive: true });
      await mkdir(join(registry, '.shared', 'code-server'), { recursive: true });
      await mkdir(join(registry, '.shared', '.papercusp'), { recursive: true });
      const sourcePath = join(registry, '.shared', 'dev-source', 'user-edit.ts');
      await writeFile(sourcePath, 'user-authored source');
      await writeFile(join(registry, '.shared', 'dev-source', '.git', 'HEAD'), 'ref: refs/heads/user-work\n');
      await writeFile(join(registry, '.shared', 'dev-source-copy', 'user-edit.ts'), 'user-authored source');
      await symlink(linkTarget, join(registry, '.shared', 'dev-source', 'external'));
      const sourceBefore = await lstat(sourcePath);
      await writeFile(join(registry, '.shared', 'wsl-state.json'), '{"bootstrapped":true}');
      await writeFile(join(registry, '.shared', 'wsl-state.json.bak'), '{"bootstrapped":true}');
      await writeFile(join(registry, '.shared', 'nested', 'wsl-state.json'), '{"bootstrapped":true}');
      const before = await lstat(linkTarget);
      const producer = workspaceRegistryCensusProducer();
      const result = await collectStateCensus({ ...producer,
        roots: producer.roots.map(root => ({ ...root, path: registry })), readCatalogs: async () => [] });
      const expected = [
        ['.shared', 'state'], ['.shared/wsl-state.json', 'config'], ['.shared/dev-source', 'state'],
        ['.shared/.papercusp', 'state'],
        ['registered-project/.claude', 'state'], ['registered-project/.claude.json', 'secret'],
        ['registered-project/.claude/.credentials.json', 'secret'], ['registered-project/.gitconfig', 'config'],
      ];
      for (const [name, classification] of expected) {
        expect(result.inventory.find(entry => entry.name === name)).toMatchObject({ classification, problem: null });
        const declaration = producer.declarations.find(entry => entry.name === name);
        expect(declaration?.descendants).toBe(name === '.shared/dev-source' ? true : undefined);
        expect(declaration?.prune).toBeUndefined();
      }
      expect(result.representedSubtrees).toEqual([{
        kind: 'path', root: 'workspace-registry', name: '.shared/dev-source',
        evidenceRef: 'source:apps/operator/lib/dev-source-extract.ts#extractDevSourceTree',
        disposition: 'preserve-state-subtree',
      }]);
      expect(result.residue.map(entry => entry.name).sort()).toEqual([
        '.shared/code-server', '.shared/dev-source-copy',
        '.shared/dev-source-copy/user-edit.ts', '.shared/nested/dev-source',
        '.shared/nested', '.shared/nested/wsl-state.json', '.shared/wsl-state.json.bak',
        'registered-project/.claude/unrelated', 'registered-project/.gitconfig.bak',
        'unregistered', 'unregistered/.claude', 'unregistered/.claude.json',
        'unregistered/.claude/.credentials.json', 'unregistered/.claude/unrelated',
        'unregistered/.gitconfig', 'unregistered/.gitconfig.bak', 'unregistered/dev-source',
      ].sort());
      expect(result.ok).toBe(false);
      expect(await readlink(join(registry, 'registered-project', '.claude.json'))).toBe(linkTarget);
      expect(await readFile(linkTarget, 'utf8')).toBe('fixture credential');
      expect(await readFile(join(registry, 'registered-project', '.gitconfig'), 'utf8')).toBe(config);
      const after = await lstat(linkTarget);
      for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(before[field]);
      const sourceAfter = await lstat(sourcePath);
      for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(sourceAfter[field]).toBe(sourceBefore[field]);
      expect(await readFile(sourcePath, 'utf8')).toBe('user-authored source');
      expect(await readFile(join(registry, '.shared', 'dev-source', '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/user-work\n');
      expect(await readlink(join(registry, '.shared', 'dev-source', 'external'))).toBe(linkTarget);
      const workspaceWriter = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/workspaces.rs', import.meta.url), 'utf8');
      expect(workspaceWriter).toContain('workspaces_root().join(".shared")');
      expect(workspaceWriter).toContain('let ws_claude_dir = workspace_dir.join(".claude")');
      expect(workspaceWriter).toContain('workspace_dir.join(".claude.json")');
      expect(workspaceWriter).toContain('ws_claude_dir.join(".credentials.json")');
      expect(workspaceWriter).toContain('workspace_dir.join(".gitconfig")');
      const wslWriter = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/wsl_setup.rs', import.meta.url), 'utf8');
      expect(wslWriter).toContain('let dir = crate::workspaces::shared_data_dir()');
      expect(wslWriter).toContain('Ok(dir.join("wsl-state.json"))');
      const sidecarWriter = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/main.rs', import.meta.url), 'utf8');
      expect(sidecarWriter).toContain('shared_state_dir.join("dev-source")');
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('does not follow a linked desktop source tree into an external target', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'linked-desktop-source-census-'));
    const registry = join(parent, 'registry');
    const target = join(parent, 'external-source');
    try {
      await mkdir(join(registry, '.shared'), { recursive: true });
      await mkdir(target);
      const foreignPath = join(target, 'foreign.ts');
      await writeFile(foreignPath, 'external user work');
      await symlink(target, join(registry, '.shared', 'dev-source'));
      const before = await lstat(foreignPath);
      const producer = workspaceRegistryCensusProducer();
      const result = await collectStateCensus({ ...producer,
        roots: producer.roots.map(root => ({ ...root, path: registry })), readCatalogs: async () => [] });
      expect(result.inventory.map(entry => entry.name).sort()).toEqual(['.shared', '.shared/dev-source']);
      expect(result.representedSubtrees).toEqual([]);
      expect(await readlink(join(registry, '.shared', 'dev-source'))).toBe(target);
      expect(await readFile(foreignPath, 'utf8')).toBe('external user work');
      const after = await lstat(foreignPath);
      for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(before[field]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('verifies filesystem and all catalogs together and fails on a new host entry', async () => {
    const path = await mkdtemp(join(tmpdir(), 'host-census-'));
    try {
      await writeFile(join(path, 'config'), 'fixture');
      const declarations: CensusDeclaration[] = [
        { kind: 'path', root: 'home', name: 'config', classification: 'config', producer: 'fixture' },
        { kind: 'database', root: 'cluster', name: 'db', classification: 'state', producer: 'fixture' },
        { kind: 'unit', root: 'systemd-user', name: 'app.service', classification: 'config', producer: 'fixture' },
        { kind: 'secret', root: 'vault', name: 'key', classification: 'secret', producer: 'fixture' },
      ];
      const input = { roots: [{ id: 'home', path }], declarations,
        readDatabases: async () => declarations.filter(entry => entry.kind === 'database'),
        readUnits: async () => declarations.filter(entry => entry.kind === 'unit'),
        readSecrets: async () => declarations.filter(entry => entry.kind === 'secret'),
      };
      expect((await verifyHostStateCensus(input)).inventory).toHaveLength(4);
      await writeFile(join(path, 'unowned'), 'new state');
      await expect(verifyHostStateCensus(input)).rejects.toThrow('unclassified:path:home:unowned');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('inventories disabled installed units and distinguishes system/user scopes', async () => {
    const read = async () => '[{"unit_file":"backup.service","state":"disabled"}]';
    expect(await unitCensusEntries('user', read)).toEqual([
      { kind: 'unit', root: 'systemd-user', name: 'backup.service' },
    ]);
    expect((await unitCensusEntries('system', read))[0].root).toBe('systemd-system');
  });
  it('rejects malformed or failed unit catalogs instead of treating them as empty', async () => {
    for (const body of ['{}', '[{}]', 'not-json']) {
      await expect(unitCensusEntries('user', async () => body)).rejects.toThrow();
    }
    await expect(unitCensusEntries('user', async () => { throw new Error('systemd unavailable'); }))
      .rejects.toThrow('systemd unavailable');
  });
  it('inventories every returned database without silently classifying unexpected databases', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray) => [{ datname: 'papercusp' }, { datname: 'unexpected' }]);
    const entries = await databaseCensusEntries(sql as unknown as Sql, 'cluster-123');
    expect(entries).toEqual([
      { kind: 'database', root: 'cluster-123', name: 'papercusp' },
      { kind: 'database', root: 'cluster-123', name: 'unexpected' },
    ]);
    expect(sql.mock.calls[0][0].join('')).toContain('WHERE NOT datistemplate');
  });

  it('propagates catalog failures and refuses unqualified cluster identity', async () => {
    const sql = vi.fn(async () => { throw new Error('unavailable'); });
    await expect(databaseCensusEntries(sql as unknown as Sql, 'cluster-123')).rejects.toThrow('unavailable');
    await expect(databaseCensusEntries(sql as unknown as Sql, '')).rejects.toThrow('cluster identity');
  });
  it('uses producer-resolved paths rather than assuming secrets live in the default home', () => {
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_KEY_FILE', '/mounted/secrets/oauth-key');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', '/mounted/secrets/fleet-token');
    try {
      const result = secretCensusProducers();
      expect(result.roots.map(root => root.path)).toEqual(['/mounted/secrets', '/scoped/home', '/fixture/config/papercusp']);
      expect(result.declarations.map(entry => [entry.name, entry.classification, entry.producer]))
        .toEqual([['db-key', 'secret', 'db-encryption'], ['superuser-token', 'secret', 'superuser-token'],
          ['google-oauth-client.json', 'secret', 'google-oauth-desktop-client'],
          ['oauth-key', 'secret', 'oauth-state-signing-key'],
          ['fleet-token', 'secret', 'fleet-claude-token']]);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('OAuth signing-key census uses the real path resolver without loading keys', () => {
  it.each([undefined, '', ' \t '])('resolves a blank override (%j) through the relocated host home without creating it', async override => {
    const fixture = await mkdtemp(join(tmpdir(), 'oauth-key-census-'));
    const home = join(fixture, 'absent-home');
    vi.stubEnv('PAPERCUSP_HOME', home);
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_KEY_FILE', override);
    try {
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'oauth-state-signing-key')!;
      expect(entry).toEqual({ kind: 'path', root: entry.root, name: 'oauth-state-key',
        classification: 'secret', producer: 'oauth-state-signing-key' });
      expect(result.roots.find(root => root.id === entry.root)?.path).toBe(home);
      await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });

  it.each(['a'.repeat(64), '', 'not-a-valid-signing-key'])('classifies a relocated unreadable key without reading, repairing or exposing its contents (%#)', async contents => {
    const fixture = await mkdtemp(join(tmpdir(), 'oauth-key-census-'));
    const key = join(fixture, 'mounted-key');
    vi.stubEnv('PAPERCUSP_HOME', join(fixture, 'unused-home'));
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_KEY_FILE', ` ${key} \t`);
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_SECRET', 'environment-secret-must-not-appear-in-census');
    try {
      await writeFile(key, contents);
      await writeFile(join(fixture, 'unknown-key-sibling'), 'unowned');
      if (process.platform !== 'win32') {
        await chmod(key, 0);
        await expect(readFile(key)).rejects.toMatchObject({ code: 'EACCES' });
      }
      const before = await lstat(key);
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'oauth-state-signing-key')!;
      const root = result.roots.find(row => row.id === entry.root)!;
      expect(root.path).toBe(fixture);
      expect(entry.name).toBe('mounted-key');
      const census = await collectStateCensus({ roots: [root], declarations: [entry], readCatalogs: async () => [] });
      expect(census.inventory.find(row => row.name === 'mounted-key')).toMatchObject({
        classification: 'secret', producers: ['oauth-state-signing-key'], problem: null,
      });
      expect(census.residue.map(row => row.name)).toEqual(['unknown-key-sibling']);
      expect(await lstat(key)).toEqual(before);
      expect(JSON.stringify(result)).not.toContain('environment-secret-must-not-appear-in-census');
      if (contents) expect(JSON.stringify(result)).not.toContain(contents);
      await expect(lstat(join(fixture, 'unused-home'))).rejects.toMatchObject({ code: 'ENOENT' });
      await chmod(key, 0o600);
      expect(await readFile(key, 'utf8')).toBe(contents);
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });

  it('declares an absent mounted key without creating the key or its parent', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'oauth-key-census-'));
    const mount = join(fixture, 'absent-mount');
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_KEY_FILE', join(mount, 'signing.key'));
    try {
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'oauth-state-signing-key')!;
      expect(entry.name).toBe('signing.key');
      expect(result.roots.find(root => root.id === entry.root)?.path).toBe(mount);
      await expect(lstat(mount)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });
});

describe('fleet token census uses the real host token resolver without loading credentials', () => {
  it.each([undefined, ''])('keeps the default host token independent of a relocated workspace (%j)', override => {
    vi.stubEnv('PAPERCUSP_HOME', '/unused/relocated/workspace');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', override);
    try {
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'fleet-claude-token')!;
      expect(entry).toEqual({ kind: 'path', root: entry.root, name: 'claude-token',
        classification: 'secret', producer: 'fleet-claude-token' });
      expect(result.roots.find(root => root.id === entry.root)?.path).toBe(join(homedir(), '.papercusp'));
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['sk-ant-oat01-retained-fixture', '', 'malformed-but-retained'])('retains an unreadable mounted token without reading or changing it (%#)', async contents => {
    const fixture = await mkdtemp(join(tmpdir(), 'fleet-token-census-'));
    const token = join(fixture, 'mounted-token');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', token);
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'ambient-token-must-not-appear');
    try {
      await writeFile(token, contents);
      await writeFile(join(fixture, 'unowned-token-backup'), 'unowned');
      if (process.platform !== 'win32') {
        await chmod(token, 0);
        await expect(readFile(token)).rejects.toMatchObject({ code: 'EACCES' });
      }
      const before = await lstat(token);
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'fleet-claude-token')!;
      const root = result.roots.find(row => row.id === entry.root)!;
      expect(root.path).toBe(fixture);
      const census = await collectStateCensus({ roots: [root], declarations: [entry], readCatalogs: async () => [] });
      expect(census.inventory.find(row => row.name === 'mounted-token')).toMatchObject({
        classification: 'secret', producers: ['fleet-claude-token'], problem: null,
      });
      expect(census.residue.map(row => row.name)).toEqual(['unowned-token-backup']);
      expect(await lstat(token)).toEqual(before);
      expect(JSON.stringify(result)).not.toContain('ambient-token-must-not-appear');
      if (contents) expect(JSON.stringify(result)).not.toContain(contents);
      await chmod(token, 0o600);
      expect(await readFile(token, 'utf8')).toBe(contents);
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });

  it('declares a missing mounted token without creating its directory or file', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'fleet-token-census-'));
    const mount = join(fixture, 'absent-mount');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', join(mount, 'fleet-token'));
    try {
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'fleet-claude-token')!;
      expect(entry.name).toBe('fleet-token');
      expect(result.roots.find(row => row.id === entry.root)?.path).toBe(mount);
      await expect(lstat(mount)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });

  it('inventories the configured link without walking its target or creating a missing credential', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'fleet-token-census-'));
    const mount = join(fixture, 'mount');
    const target = join(fixture, 'absent-target');
    const token = join(mount, 'fleet-token');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', token);
    try {
      await mkdir(mount);
      await symlink(target, token);
      const before = await lstat(token);
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'fleet-claude-token')!;
      const root = result.roots.find(row => row.id === entry.root)!;
      const census = await collectStateCensus({ roots: [root], declarations: [entry], readCatalogs: async () => [] });
      expect(census.inventory).toEqual([{ kind: 'path', root: root.id, name: 'fleet-token',
        classification: 'secret', producers: ['fleet-claude-token'], problem: null }]);
      expect(await lstat(token)).toEqual(before);
      await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });
});
