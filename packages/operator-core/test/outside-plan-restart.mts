/** Scripted restart of the session/scheduler application process inside a private network namespace. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(import.meta.url);
const workspaceId = 'default';
const harness = 'papercusp';
const fleet = 'outside-restart';
const owners = ['su-outside-leader', 'su-outside-first', 'su-outside-second'];
const reference = 'tracker: assignment\nwith spaces ';

// Every run has its own network namespace, including its loopback ports.
const port = 41855;

async function readThroughRestartedOperator(epoch: string, dir: string) {
  const [{ Client }, { StreamableHTTPClientTransport }, { waitForPrivateOperator, stopPrivateOperatorHost },
    { superuserTokenPath, readSuperuserToken }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('./private-http-workspace-preflight'), import('../lib/superuser-token'),
  ]);
  assert.equal(superuserTokenPath(), join(dir, 'superuser-token'));
  if (epoch === 'before') {
    const { mutateHarnessRegistry } = await import('../lib/harness-registry');
    const path = join(dir, 'project');
    await mkdir(join(path, '.papercusp'), { recursive: true });
    await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects, { slug: harness, path }] }), workspaceId);
    await writeFile(superuserTokenPath(), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  }
  const { resolveWorkspaceForHarnessSlugIn } = await import('../lib/harness-core');
  assert.equal(await resolveWorkspaceForHarnessSlugIn(workspaceId, harness), workspaceId,
    'The private project must be registered before each HTTP operator starts');
  const token = readSuperuserToken();
  assert.ok(token);
  const saved = JSON.parse(await readFile(join(dir, 'items.json'), 'utf8')) as { ids: string[]; leader: string };
  const base = 'http://127.0.0.1:' + port;
  const headers = { Authorization: 'Bearer ' + token, origin: base, 'x-papercusp-workspace': workspaceId };
  const env = { ...process.env, PAPERCUSP_HONO_PORT: String(port), PAPERCUSP_BIND_HOST: '127.0.0.1',
    PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_SKIP_PG_DISCOVERY: '1', PAPERCUSP_BACKGROUND_WORKERS: '0',
    PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_DBOS_ORCHESTRATOR: '0', PAPERCUSP_DBOS_ROUTINES: '0',
    PAPERCUSP_DBOS_TIMERS: '0', PAPERCUSP_DBOS_AUTOLOOP: '0', PAPERCUSP_CLUSTER: '0',
    PAPERCUSP_SPAWNER_SIDECAR: '0', PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: '0', MALLOC_ARENA_MAX: '2' };
  const evidenceDir = join(dir, 'http-' + epoch);
  await mkdir(evidenceDir);
  const hostFile = fileURLToPath(new URL('../../../apps/operator/bin/hono-host.ts', import.meta.url));
  const host = spawn(process.execPath, ['--import', 'tsx', hostFile], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  const client = new Client({ name: 'outside-plan-restart', version: '1' });
  try {
    await waitForPrivateOperator({ host, base, headers, evidenceDir, environment: env, timeoutMs: 150_000 });
    const url = new URL('/api/mcp', base);
    const reads = ['coord:whoami', 'scheduler:get_claim_spec', 'work_items:get'];
    url.search = new URLSearchParams({ superuser: '1', workspace: workspaceId, harness, client: owners[0],
      tools: reads.join(','), format: 'json', structured: '1' }).toString();
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    const listing = await client.listTools();
    async function call(name: string, args: Record<string, unknown>) {
      const advertised = listing.tools.find(tool => tool.name === name);
      assert.ok(advertised, 'Private operator did not list ' + name);
      type Output = { structuredContent?: Record<string, any>; content?: Array<{ type: string; text?: string }> };
      try {
        const reply = await client.callTool({ name, arguments: args,
          _meta: { 'papercusp/batchResponseVersion': 'batch-v1', structured: true, format: 'json' } });
        assert.ok(!reply.isError, JSON.stringify(reply.content));
        let output = reply as Output;
        if (output.structuredContent?.batchId !== undefined) {
          const batch = output.structuredContent;
          assert.deepEqual(batch.counts, { ok: 1, failed: 0 });
          assert.equal(batch.results.length, 1);
          assert.equal(batch.results[0].ok, true);
          output = batch.results[0].output;
        }
        if (output.structuredContent) return output.structuredContent;
        const json = output.content?.find(entry => entry.type === 'text' && entry.text?.trimStart().startsWith('{'));
        assert.ok(json?.text, 'Missing JSON response');
        return JSON.parse(json.text);
      } catch (cause) {
        throw new Error(`Private operator ${epoch} restart, ${name} (pid=${host.pid})`, { cause });
      }
    }
    const identity = await call('coord:whoami', {});
    assert.equal(identity.ownerId, owners[0]);
    assert.equal(identity.outsidePlanRef, reference);
    const policy = await call('scheduler:get_claim_spec', { fleet, workspace: workspaceId, history: 0 });
    assert.deepEqual(policy.spec.view.filter, { field: 'id', op: 'in', value: saved.ids });
    for (const id of [saved.leader, ...saved.ids]) {
      const item = await call('work_items:get', { id, harness });
      assert.equal(item.results[0].workItem.externalPlanRef, reference);
    }
    console.log('Verified HTTP session, work-item references and fleet admission', JSON.stringify({ epoch, pid: host.pid }));
  } finally {
    try { await client.close(); } finally { await stopPrivateOperatorHost(host); }
  }
}

function context(ownerId: string, dir: string) {
  return { workspaceId, harnessSlug: harness, uiClientId: ownerId, isSuperuser: true, projectDir: dir };
}

async function singleSession(dir: string) {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const { bindSessionOutsidePlanRef } = await import('../lib/session-outside-plan');
  const { default: whoami } = await import('../lib/agent-tools/coordination/tools/whoami');
  const { default: declare } = await import('../lib/agent-tools/coordination/tools/declare-intent');
  const { default: create } = await import('../lib/agent-tools/work_items/create');
  const { default: complete } = await import('../lib/agent-tools/work_items/complete');
  const { getWorkItem } = await import('../lib/work-items');
  const ownerId = 'su-outside-single';
  const ctx = context(ownerId, dir) as Parameters<typeof create.handler>[1];
  const root = await mkdtemp(join(dir, 'checkout-'));
  const files = ['input.txt', 'output.txt'];
  for (const file of files) await writeFile(join(root, file), 'original\n');
  assert.equal((await sql`SELECT 1 FROM harness_shared.harness_plans LIMIT 1`).length, 0);
  assert.equal((await sql`SELECT 1 FROM harness_shared.work_items LIMIT 1`).length, 0);
  const [row] = await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, agent)
    VALUES (${workspaceId}, 'console', ${ownerId}, 'codex') RETURNING id`;
  await bindSessionOutsidePlanRef({ ownerId, advSessionId: Number(row.id), workspaceId, planRef: reference });
  const identity = await whoami.handler({}, ctx);
  assert.equal(JSON.parse(identity.content[0].text).outsidePlanRef, reference);
  const intent = await declare.handler(declare.args.parse({ intent: 'Update all remaining examples in the checkout' }), ctx);
  const declaration = JSON.parse(intent.content[0].text);
  assert.equal(declaration.ok, true);
  assert.equal(declaration.presence.currentPlanSlug, null);
  assert.match(declaration.overCoverageHint, /work_items:claim/);
  // Exercise the title heuristic that ordinarily suggests binding an unlinked residual.
  const input = { kind: 'feature', title: 'Revise the input and output examples for deferred acceptance', harness, pot: harness,
    assign_to: 'self', state: 'wip' };
  const conflict = await create.handler(create.args.parse({ ...input, planRef: reference,
    plan_item: { slug: 'client', item: 'P-001' } }), ctx);
  assert.equal(conflict.data?.counts?.failed, 1);
  assert.match(JSON.stringify(conflict.data), /plan_item/);
  assert.match(JSON.stringify(conflict.data), /planRef/);
  assert.equal((await sql`SELECT 1 FROM harness_shared.work_items LIMIT 1`).length, 0);
  const created = await create.handler(create.args.parse(input), ctx);
  const id = created.data?.results?.[0]?.id;
  assert.ok(typeof id === 'string', JSON.stringify(created.data));
  const held = await getWorkItem(id, harness);
  assert.equal(held?.assignee, ownerId);
  assert.equal(held?.externalPlanRef, reference);
  for (const file of files) {
    await writeFile(join(root, file), 'updated\n');
    assert.equal(await readFile(join(root, file), 'utf8'), 'updated\n');
  }
  const completed = await complete.handler(complete.args.parse({ id, harness, state: 'done', assumptions: 'none',
    completion: { summary: 'Updated both checkout examples.', testsRun: 'Read back both example files.',
      testResult: 'Both files contained the requested replacement.', verifiedHow: 'manual', filesChanged: files,
      verification: { workOutcome: 'introduced-change' } } }), ctx);
  assert.equal(completed.data?.results?.[0]?.ok, true, JSON.stringify(completed.data));
  for (const [tool, reply] of Object.entries({ whoami: identity, declare: intent, create: created, complete: completed })) {
    assert.doesNotMatch(JSON.stringify(reply),
      /plans:(?:new|start|add-item)|pass plan_item:|(?:create|bind|activate) (?:a |the |your )?(?:Papercusp )?plan\b/i,
      'Unexpected planning instruction from ' + tool);
  }
  assert.equal((await getWorkItem(id, harness))?.state, 'done');
  assert.equal((await sql`SELECT 1 FROM harness_shared.harness_plans LIMIT 1`).length, 0);
}

async function phase(name: string, dir: string) {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const { bindSessionOutsidePlanRef, readSessionOutsidePlanRef } = await import('../lib/session-outside-plan');
  const { buildFleetWorkItemsClaimSpec } = await import('../lib/scheduler/fleet-work-items');
  const { getClaimSpecRecord, setClaimSpec, fleetSpecBeeKey } = await import('../lib/scheduler/claim-spec-store');
  const { getNextWorkItem } = await import('../lib/scheduler/get-next');
  const { createWorkItem, getWorkItem } = await import('../lib/work-items');
  const { resolveWorkItemOutsidePlanRef } = await import('../lib/work-item-external-plan');
  const key = { cupId: fleetSpecBeeKey(fleet), workspaceId };
  const receiptPath = join(dir, 'items.json');
  if (name === 'before') {
    assert.equal((await sql`SELECT 1 FROM harness_shared.harness_plans LIMIT 1`).length, 0);
    assert.equal((await sql`SELECT 1 FROM harness_shared.work_items LIMIT 1`).length, 0);
    for (const ownerId of owners) {
      const [row] = await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, agent)
        VALUES (${workspaceId}, 'console', ${ownerId}, 'codex') RETURNING id`;
      await bindSessionOutsidePlanRef({ ownerId, advSessionId: Number(row.id), workspaceId, planRef: reference });
    }
    const externalPlanRef = resolveWorkItemOutsidePlanRef({}, await readSessionOutsidePlanRef(owners[0], workspaceId));
    assert.equal(externalPlanRef, reference);
    const leader = await createWorkItem({ harness, workspaceId, title: 'Verify the assignment', kind: 'feature',
      externalPlanRef, assignee: owners[0] });
    const stray = await createWorkItem({ harness, workspaceId, title: 'Unrelated work', kind: 'feature' });
    const ids: string[] = [];
    for (const title of ['Implement parser', 'Update output', 'Check parser result']) {
      ids.push((await createWorkItem({ harness, workspaceId, title, kind: 'feature', externalPlanRef })).id);
    }
    await sql`INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES (${workspaceId}, 'feature', ${harness + '#' + ids[2]}, 'feature', ${harness + '#' + ids[0]}, 'blocks')`;
    assert.equal((await setClaimSpec({ ...key, spec: buildFleetWorkItemsClaimSpec(fleet, ids),
      updatedBy: owners[0], potSlug: harness }, sql)).ok, true);
    const { spec } = await getClaimSpecRecord(key, sql);
    const first = await getNextWorkItem(spec, { assignee: owners[1] }, { harness, workspaceId });
    assert.ok(first && ids.slice(0, 2).includes(first.workItem.id));
    await writeFile(receiptPath, JSON.stringify({ leader: leader.id, stray: stray.id, ids, first: first.workItem.id }));
    if (process.argv.includes('--http')) await readThroughRestartedOperator(name, dir);
    return;
  }
  assert.equal(name, 'after');
  if (process.argv.includes('--http')) await readThroughRestartedOperator(name, dir);
  const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as { ids: string[]; first: string; stray: string; leader: string };
  for (const owner of owners) assert.equal(await readSessionOutsidePlanRef(owner, workspaceId), reference);
  const { spec } = await getClaimSpecRecord(key, sql);
  assert.deepEqual(spec.view.filter, { field: 'id', op: 'in', value: saved.ids });
  for (const id of [saved.leader, ...saved.ids]) {
    assert.equal((await getWorkItem(id, harness))?.externalPlanRef, reference);
  }
  const pull = (assignee: string) => getNextWorkItem(spec, { assignee }, { harness, workspaceId });
  const { default: complete } = await import('../lib/agent-tools/work_items/complete');
  async function finish(id: string, ownerId: string) {
    const item = await getWorkItem(id, harness);
    assert.equal(item?.externalPlanRef, reference);
    assert.equal(item?.assignee, ownerId);
    const args = complete.args.parse({ id, harness, state: 'done', assumptions: 'none', completion: {
      summary: 'Verified the assigned fixture record after restarting the application process.',
      testsRun: 'Read the persisted work-item and compare its outside reference and assignee with the expected values.',
      testResult: 'The reference and assigned session matched.', verifiedHow: 'manual', filesChanged: [],
      verification: { workOutcome: 'verified-existing' },
    } });
    const result = await complete.handler(args, { workspaceId, harnessSlug: harness, uiClientId: ownerId,
      isSuperuser: true, projectDir: dir } as Parameters<typeof complete.handler>[1]);
    const body = result.data as { results?: Array<{ ok: boolean }> };
    assert.equal(body?.results?.[0]?.ok, true, JSON.stringify(result));
  }
  const second = await pull(owners[2]);
  assert.ok(second && second.workItem.id !== saved.first && saved.ids.slice(0, 2).includes(second.workItem.id));
  assert.equal(await pull(owners[1]), null);
  await finish(saved.first, owners[1]);
  await finish(second.workItem.id, owners[2]);
  const last = await pull(owners[1]);
  assert.equal(last?.workItem.id, saved.ids[2]);
  await finish(saved.ids[2], owners[1]);
  assert.equal(await pull(owners[2]), null);
  assert.ok(!(await getWorkItem(saved.stray, harness))?.assignee);
  await finish(saved.leader, owners[0]);
  for (const id of [saved.leader, ...saved.ids]) assert.equal((await getWorkItem(id, harness))?.state, 'done');
  assert.equal((await sql`SELECT 1 FROM harness_shared.harness_plans LIMIT 1`).length, 0);
}

async function main() {
  assert.ok(Object.values(networkInterfaces()).flat().every(address => address?.internal),
    'Run this test in a loopback-only network namespace');
  const [name, dir] = process.argv.slice(2);
  if (name === 'single' || name === 'before' || name === 'after') {
    assert.equal(new URL(process.env.HARNESS_ADMIN_DATABASE_URL!).hostname, '127.0.0.1');
    if (name === 'single') await singleSession(dir);
    else await phase(name, dir);
    return;
  }
  assert.ok(!name || ['--single', '--fleet', '--http'].includes(name), 'Expected --single, --fleet, --http or no argument');
  const { startDedicatedNativePg } = await import('@papercusp/test-config/pg');
  const { provisionOrgTemplate } = await import('./_org-test-db');
  const root = await mkdtemp(join(tmpdir(), 'outside-plan-restart-'));
  const pg = await startDedicatedNativePg({ baseDir: root, settings: { max_connections: '100' } });
  try {
    const url = pg.getConnectionUri();
    await provisionOrgTemplate(url);
    // The migration set installs rubric plans even on a new cluster.
    const { default: postgres } = await import('postgres');
    const admin = postgres(url, { max: 1 });
    try {
      const seeds = await admin`DELETE FROM harness_shared.harness_plans WHERE template = 'rubric'
        RETURNING workspace_id, harness_slug, plan_slug`;
      console.log('Removed migrated rubric plans from private fixture:', JSON.stringify(seeds));
      assert.deepEqual(Array.from(await admin`SELECT workspace_id, harness_slug, plan_slug
        FROM harness_shared.harness_plans`), [], 'Unexpected plan in fresh migration fixture');
      const [db] = await admin`SELECT current_database() AS name`;
      await admin`CREATE DATABASE outside_single TEMPLATE ${admin(db.name)}`;
    } finally { await admin.end(); }
    const singleUrl = new URL(url);
    singleUrl.pathname = '/outside_single';
    const phases = name === '--single' ? ['single'] : name ? ['before', 'after'] : ['single', 'before', 'after'];
    for (const epoch of phases) {
      const target = epoch === 'single' ? singleUrl.href : url;
      console.log(`Starting offline scenario phase: ${epoch}`);
      await new Promise<void>((resolve, reject) => {
        const args = ['--import', 'tsx', fixture, epoch, root];
        if (name === '--http') args.push('--http');
        const worker = spawn(process.execPath, args, {
          stdio: ['ignore', 'inherit', 'inherit'],
          env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: root, PAPERCUSP_HOME: root,
            HARNESS_ADMIN_DATABASE_URL: target, HARNESS_DATABASE_URL: target, PAPERCUSP_WORKSPACE: workspaceId },
        });
        worker.once('error', reject);
        worker.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(
          `Offline scenario phase ${epoch} exited with ${signal ?? code}`)));
      });
      console.log(`Passed offline scenario phase: ${epoch}`);
    }
    if (phases.includes('after')) console.log('Fresh database, isolated network, application-process restart and exact-set drain verified.');
  } finally {
    await pg.stop();
    await rm(root, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
