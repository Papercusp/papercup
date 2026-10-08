/** Real native create/read/reload and signed governance, registered in the surface suite. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';
import { insertHiveIfAbsent } from '../packages/operator-core/lib/hive-store.ts';
import { loadHarnessRegistry, saveHarnessRegistry } from '../packages/operator-core/lib/harness-registry.ts';
import { upsertHiveMember } from '../packages/operator-core/lib/hive-membership-store.ts';
import { authorHivePolicy } from '../packages/operator-core/lib/hive-policy-author.ts';
import { DEFAULT_PLAN_ADMISSION_POLICY } from '../packages/operator-core/lib/agent-tools/plans/plan-admission-policy.ts';
import { readPlanAdmissionGovernanceSnapshot } from '../packages/operator-core/lib/agent-tools/plans/plan-admission-governance-store.ts';
import { getPlanRow } from '../packages/operator-core/lib/agent-tools/plans/source.ts';

if (process.argv.includes('--check-imports')) {
  assert.equal(typeof authorHivePolicy, 'function'); assert.equal(typeof getPlanRow, 'function');
  console.log('DAO_WORKBENCH_IMPORTS_OK'); process.exit(0);
}
const selection = parseSelectionArgs(process.argv.slice(2));
const result = await runHarness({ contract: { name: 'dao-workbench-tauri', phases: [{ id: 'native',
  description: 'Product switch, persisted proposal, real signed member decision and responsive workspaces' }] },
  evidenceRoot: defaultEvidenceRoot('dao-workbench-tauri'), selection, reuseFrom: selection.reuse,
  async runPhase(ctx) {
    assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1');
    const pg = resolveScriptPgUrl();
    assert.ok(pg.source === 'env' && 'via' in pg && pg.via === 'HARNESS_ADMIN_DATABASE_URL');
    const ws = process.env.PAPERCUSP_WORKSPACE_ID!;
    assert.match(ws, /^verify-tauri-isolated-\d+$/);
    const sql = postgres(pg.url, { max: 1, onnotice: () => {} });
    const fixture = JSON.parse(readFileSync(process.env.DAO_WORKBENCH_IDENTITY_FIXTURE!, 'utf8'));
    const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools';
    const native = (...args: string[]) => execFileSync(tool, [...args, '--pid', process.env.VERIFY_TAURI_PID!], { encoding: 'utf8', timeout: 65_000 });
    const ev = (code: string) => native('eval', code);
    const wait = (code: string) => native('wait', '--eval', code, '--timeout', '60000', '--interval', '500');
    const click = (text: string, scope = 'document') => ev(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button '+${JSON.stringify(text)});b.click();return true})()`);
    const field = (label: string, value: string) => ev(`(()=>{const l=[...document.querySelectorAll('.dao-governance label')].find(e=>e.firstChild.textContent.trim()===${JSON.stringify(label)});const e=l?.querySelector('input,textarea,select');if(!e)throw Error('Missing field');const p=e instanceof HTMLSelectElement?HTMLSelectElement.prototype:e instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`);
    const capture = (name: string) => {
      writeFileSync(join(ctx.evidenceDir, name + '.json'), ev('JSON.stringify({url:location.href,text:document.body.innerText})'));
      native('screenshot', '--output', join(ctx.evidenceDir, name + '.png'));
    };
    try {
      ctx.markStep('isolated-owner-policy-and-member-fixture');
      const slug = 'workbench-native';
      const home = join(process.env.PAPERCUSP_HOME!, slug); mkdirSync(home, { recursive: true });
      await insertHiveIfAbsent({ workspaceId: ws, homeSlug: slug, pubkeyBase64: fixture.hive.publicKey,
        keychainId: 'hive:' + ws + ':' + slug, title: 'Native Workbench DAO', description: 'Isolated native acceptance' }, sql);
      const registry = await loadHarnessRegistry(ws);
      await saveHarnessRegistry({ ...registry, projects: [...registry.projects, { slug, path: home, harness_kind: 'hive' }] }, ws);
      await upsertHiveMember({ workspaceId: ws, potHomeSlug: slug, githubUserId: fixture.githubUserId,
        githubUsername: fixture.githubLogin, bindingStatus: 'verified', deviceAttestations: [{ device_pubkey: fixture.device.publicKey, gist_id: 'synthetic-native-gist' }] }, sql);
      const policy = await authorHivePolicy({ workspaceId: ws, potHomeSlug: slug, policy: { membership: 'open', governance: {
        planAdmission: DEFAULT_PLAN_ADMISSION_POLICY, signingAuthority: { members: [{ memberId: fixture.githubLogin,
          publicKey: fixture.device.publicKey, originPeerIds: [fixture.device.publicKey], keyEpoch: 1,
          roles: ['round-open', 'vote', 'finalize'], weight: 1 }], delegations: [] } } } });
      assert.equal(policy.ok, true, 'Synthetic owner could not author a real signed policy');
      ctx.markStep('top-level-product-switch-and-directory');
      native('navigate', '/daos', '--json'); wait("!!document.querySelector('[data-testid=dao-workspace]')");
      wait("!document.body.classList.contains('has-left-sidebar') && !document.body.classList.contains('has-op-chat')");
      click('Refresh'); wait("[...document.querySelectorAll('.dao-card h2')].some(e=>e.textContent==='Native Workbench DAO')");
      click('Open workspace →'); wait("document.querySelector('.dao-page-header h1')?.textContent==='Overview'");
      click('Proposals'); wait("!!document.querySelector('.dao-governance')");
      ctx.markStep('create-real-proposal-through-native-form');
      ev("(()=>{const original=window.fetch;window.__WORKBENCH_PROPOSAL_RESPONSE__=null;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/api/admin/plans/new'))window.__WORKBENCH_PROPOSAL_RESPONSE__={request:args[1]?.body,status:response.status,body:await response.clone().text()};return response};return true})()");
      ev("document.querySelector('.dao-governance details').open=true");
      field('Proposal title', 'Native proposal'); field('Purpose & scope', 'Produce an isolated native record');
      field('How members will verify success', 'Native record persists and its signed decision reloads');
      click('Save draft proposal'); wait("document.querySelector('.dao-governance')?.innerText.includes('Proposal saved as a draft')");
      writeFileSync(join(ctx.evidenceDir, 'proposal-response.json'), ev('JSON.stringify(window.__WORKBENCH_PROPOSAL_RESPONSE__)'));
      const proposalSlug = ev('JSON.parse(window.__WORKBENCH_PROPOSAL_RESPONSE__.body).slug').trim().replace(/^"|"$/g, '');
      assert.match(proposalSlug, /^native-proposal-\d{4}-\d{2}-\d{2}$/, 'Creation receipt must contain the canonical dated plan slug');
      const persistedScopes = await sql`SELECT workspace_id, harness_slug, plan_slug, title FROM harness_shared.harness_plans WHERE plan_slug = ${proposalSlug}`;
      writeFileSync(join(ctx.evidenceDir, 'proposal-scopes.json'), JSON.stringify(persistedScopes, null, 2));
      const row = await getPlanRow(proposalSlug, { workspaceId: ws, harnessSlug: slug });
      assert.ok(row, 'Native draft did not persist');
      assert.equal(row.title, 'Native proposal');
      field('Review proposal', slug + '/' + proposalSlug); wait("document.querySelector('.dao-governance')?.innerText.includes('Deciding as native-workbench-member')");
      assert.equal(ev("String([...document.querySelectorAll('.dao-governance button')].find(e=>e.textContent==='Open voting round').disabled)").trim().replace(/^"|"$/g, ''), 'true');
      ev("document.querySelector('.dao-governance input[type=checkbox]').click()");
      ctx.markStep('real-device-signatures-and-policy-verification');
      click('Open voting round'); wait("document.querySelector('.dao-governance')?.innerText.includes('Voting round opened.')");
      click('Approve'); wait("document.querySelector('.dao-governance')?.innerText.includes('Your approve vote was recorded.')");
      click('Finalize result'); wait("document.querySelector('.dao-governance')?.innerText.includes('Plan admission approved')");
      const snapshot = await readPlanAdmissionGovernanceSnapshot({ workspaceId: ws, potHomeSlug: slug });
      assert.deepEqual(snapshot.integrityErrors, []);
      assert.deepEqual(snapshot.events.map(e => e.body.kind).sort(), ['finalize', 'round-open', 'vote']);
      assert.equal(snapshot.events.find(e => e.body.kind === 'finalize')?.body.kind, 'finalize');
      capture('signed-decision');
      ctx.markStep('reload-and-independent-product-selections');
      ev('location.reload()'); wait("!!document.querySelector('.dao-governance')");
      field('Review proposal', slug + '/' + proposalSlug); wait("document.querySelector('.dao-governance')?.innerText.includes('Plan admission approved')");
      ev("document.querySelector('a[aria-label=Ops]').click()"); wait("!location.pathname.startsWith('/daos')");
      ev("document.querySelector('a[aria-label=\"DAO Management\"]').click()");
      wait("location.pathname==='/daos' && new URLSearchParams(location.search).get('dao')==='workbench-native' && !!document.querySelector('.dao-governance')");
      ctx.markStep('nineteen-sections-and-responsive-layout');
      const ids = ['directory','overview','join','members','proposals','vote','delegation','work','jobs','treasury','funding','billing','ownership','returns','reputation','marketplace','records','settings','inbox'];
      for (const id of ids) {
        ev(`window.__TSR_ROUTER__.navigate({to:'/daos',search:{dao:${JSON.stringify(slug)},daoSection:${JSON.stringify(id)}}})`);
        wait(`new URLSearchParams(location.search).get('daoSection')===${JSON.stringify(id)} && !!document.querySelector('.dao-page-header h1')`);
      }
      // Resize the actual native window through the maintained Tauri bridge.
      // Desktop's normal minimum is 800px; remove only this fixture window's
      // constraint to exercise the approved responsive web interface.
      ev("window.__TAURI__.window.getCurrentWindow().setMinSize(null)");
      ev("window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.window.LogicalSize(390,844))");
      wait("innerWidth<=420 && document.documentElement.scrollWidth<=innerWidth+2");
      capture('mobile-inbox');
      ev("window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.window.LogicalSize(1440,1000))");
      wait("innerWidth>=1300 && document.documentElement.scrollWidth<=innerWidth+2");
      capture('desktop-inbox');
      assert.throws(() => native('check', '--selector', '.dao-intentionally-missing', '--json'), 'Missing selector negative control must fail');
      return { ok: true, proposalHash: row.contentHash, authenticatedEventKinds: snapshot.events.map(e => e.body.kind), sectionIds: ids };
    } catch (error) {
      try { writeFileSync(join(ctx.evidenceDir, 'proposal-response.json'), ev('JSON.stringify(window.__WORKBENCH_PROPOSAL_RESPONSE__ ?? null)')); } catch {}
      try {
        const scopes = await sql`SELECT workspace_id, harness_slug, plan_slug, title FROM harness_shared.harness_plans WHERE title = 'Native proposal' OR plan_slug LIKE 'native-proposal%' OR plan_slug LIKE 'proposal%'`;
        writeFileSync(join(ctx.evidenceDir, 'proposal-scopes.json'), JSON.stringify(scopes, null, 2));
      } catch {}
      try { capture('failure'); } catch {}
      throw error;
    }
    finally { await sql.end(); }
  },
});
console.log(`P019_TAURI_SURFACE_VERIFY_${result.verdict === 'pass' ? 'OK' : 'FAIL'} leg=dao-workbench output=${result.evidenceDir}`);
process.exitCode = result.verdict === 'pass' ? 0 : 1;
