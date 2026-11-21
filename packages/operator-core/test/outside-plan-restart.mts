/** Scripted restart of the session/scheduler application process inside a private network namespace. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const fixture = fileURLToPath(import.meta.url);
const workspaceId = 'default';
const harness = 'papercusp';
const fleet = 'outside-restart';
const owners = ['su-outside-leader', 'su-outside-first', 'su-outside-second'];
const reference = 'tracker: assignment\nwith spaces ';

function context(ownerId: string, dir: string) {
  return { workspaceId, harnessSlug: harness, uiClientId: ownerId, isSuperuser: true, projectDir: dir };
}

async function singleSession(dir: string) {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const { bindSessionOutsidePlanRef } = await import('../lib/session-outside-plan');
  const { default: whoami } = await import('../lib/agent-tools/coordination/tools/whoami');
  const { default: create } = await import('../lib/agent-tools/work_items/create');
  const { default: complete } = await import('../lib/agent-tools/work_items/complete');
  const { getWorkItem } = await import('../lib/work-items');
  const ownerId = 'su-outside-single';
  const ctx = context(ownerId, dir) as Parameters<typeof create.handler>[1];
  const root = await mkdtemp(join(dir, 'checkout-'));
  const files = ['input.txt', 'output.txt'];
  for (const file of files) await writeFile(join(root, file), 'original\n');
  assert.equal((await sql`SELECT 1 FROM harness_shared.work_items LIMIT 1`).length, 0);
  const [row] = await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, agent)
    VALUES (${workspaceId}, 'console', ${ownerId}, 'codex') RETURNING id`;
  await bindSessionOutsidePlanRef({ ownerId, advSessionId: Number(row.id), workspaceId, planRef: reference });
  const identity = await whoami.handler({}, ctx);
  assert.equal(JSON.parse(identity.content[0].text).outsidePlanRef, reference);
  const input = { kind: 'feature', title: 'Revise the input and output examples', harness, assign_to: 'self', state: 'wip' };
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
    return;
  }
  assert.equal(name, 'after');
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
  assert.ok(!name || name === '--single' || name === '--fleet', 'Expected --single, --fleet or no argument');
  const { startDedicatedNativePg } = await import('@papercusp/test-config/pg');
  const { provisionOrgTemplate } = await import('./_org-test-db');
  const root = await mkdtemp(join(tmpdir(), 'outside-plan-restart-'));
  const pg = await startDedicatedNativePg({ baseDir: root, settings: { max_connections: '100' } });
  try {
    const url = pg.getConnectionUri();
    await provisionOrgTemplate(url);
    // Clone the migrated, still-empty database before either scenario creates a session.
    const { default: postgres } = await import('postgres');
    const admin = postgres(url, { max: 1 });
    try {
      const [db] = await admin`SELECT current_database() AS name`;
      await admin`CREATE DATABASE outside_single TEMPLATE ${admin(db.name)}`;
    } finally { await admin.end(); }
    const singleUrl = new URL(url);
    singleUrl.pathname = '/outside_single';
    const phases = name === '--single' ? ['single'] : name === '--fleet' ? ['before', 'after'] : ['single', 'before', 'after'];
    for (const epoch of phases) {
      const target = epoch === 'single' ? singleUrl.href : url;
      console.log(`Starting offline scenario phase: ${epoch}`);
      await exec(process.execPath, ['--import', 'tsx', fixture, epoch, root], {
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: root, PAPERCUSP_HOME: root,
          HARNESS_ADMIN_DATABASE_URL: target, HARNESS_DATABASE_URL: target, PAPERCUSP_WORKSPACE: workspaceId },
        maxBuffer: 8 * 1024 * 1024,
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
