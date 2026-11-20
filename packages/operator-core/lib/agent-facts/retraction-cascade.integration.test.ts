import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { applyMigrationForTest } from '../../test/_pg-helpers';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { configureCoordLog, resetCoordLog } from '../agent-tools/coordination/log';
import { readInbox } from '../agent-tools/coordination/messages';
import { resolveAgentIdentity } from '../agent-tools/coordination/identity';
import factsList from '../agent-tools/facts/list';
import factsRetract from '../agent-tools/facts/retract';
import factsAssert from '../agent-tools/facts/assert';
import { activeWorkspaceId } from '../workspace-registry';
import { assertFact, retractFact, sweepExpiredFacts } from './store';
import { readFactCascade, type FactCascadeProgress, type FactChangeRef } from './cascade-progress';
import { readAssumptionFlags } from './retraction-cascade';

let db: OrgTestDb;
let fixture: BaselineCoordFixture;
let workspace: string;
const ctx = { isSuperuser: true, uiClientId: 'su-fact-recovery' } as never;
const recipient = resolveAgentIdentity(ctx).ownerId;
const migration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1652-fact-change-cascade-progress.sql', import.meta.url));
const fact = (key: string) => ({ scope: 'workspace' as const, key, body: 'The supporting observation.', ttlSec: 3600,
  confidence: 'verified' as const });

beforeAll(async () => {
  db = await createOrgTestDb();
  fixture = await setupBaselineCoordFixture({ dsn: db.adminDsn });
  workspace = activeWorkspaceId();
  const [target] = await getOrgPg().sql`SELECT current_database() AS name`;
  expect(target.name).toBe(db.dbName);
  await applyMigrationForTest(db.adminSql, existsSync(migration) ? migration : migration + '.DRAFT');
  configureCoordLog(new PgCoordLog({ getSql: () => db.adminSql, workspaceId: workspace, ensureSchema: async () => {} }));
}, 180_000);
afterAll(async () => {
  resetCoordLog();
  try { await fixture?.dispose(); } finally { await db?.cleanup(); }
});

async function seed(key: string, count: number, options: { reverse?: boolean; acrossHarnesses?: boolean; withoutOwner?: boolean } = {}) {
  const original = await assertFact({ ...fact(key), createdBy: recipient });
  const versionId = String(original.id);
  const declared = [{ key, scope: 'workspace', scopeRef: null, versionId: original.id, confidence: 'verified' }];
  const rows = Array.from({ length: count }, (_, i) => ({
    harness: options.acrossHarnesses && i % 2 ? key + '-b' : key + '-a',
    id: key + '-item-' + String(i).padStart(5, '0'),
  }));
  const order = options.reverse ? [...rows].reverse() : rows;
  await db.adminSql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, status, created_ts, updated_ts, closed_ts, title, summary, origin, terminal_owner, payload)
    SELECT ${workspace}, r.harness, r.id, 'task', 'done', 1, 1, 1, 'Fact citation', 'Original close', 'local',
           ${options.withoutOwner ? null : recipient}, ${JSON.stringify({ _assumptions: { declared } })}::text::jsonb
      FROM jsonb_to_recordset(${JSON.stringify(order)}::text::jsonb) AS r(harness text, id text)`;
  return { key, versionId, expected: rows.map(r => [r.harness, r.id]).sort() };
}

async function change(key: string, path: 'direct' | 'supersede' | 'retire') {
  if (path === 'direct') {
    const args = factsRetract.args.parse({ scope: 'workspace', key, reason: 'Private control' });
    const result = await factsRetract.handler(args, ctx) as { data: { retracted: boolean; cascade: FactCascadeProgress } };
    expect(result.data.retracted).toBe(true);
    return result.data.cascade;
  }
  const args = factsAssert.args.parse(path === 'retire'
    ? { ...fact(key + '-next'), supersedes: [key] }
    : { ...fact(key), confidence: 'suspected' });
  const result = await factsAssert.handler(args, ctx) as { content: Array<{ text: string }> };
  const data = JSON.parse(result.content[0].text);
  expect(data.ok).toBe(true);
  return data.cascades[0] as FactCascadeProgress;
}

async function read(original: FactCascadeProgress, items = false, after?: { harness: string; item: string }) {
  const args = original.recovery.args;
  const input = factsList.args.parse({ ...args, cascade: { ...args.cascade, items, after } });
  return (await factsList.handler(input, ctx) as { data: { progress: FactCascadeProgress;
    delivery?: { items: Array<{ harness: string; item: string }>; omitted: number;
      next: { cascade: { after: { harness: string; item: string } } } | null } } }).data;
}

async function verify(original: FactCascadeProgress, subject: Awaited<ReturnType<typeof seed>>) {
  const { expected, key, versionId } = subject;
  const first = await read(original, true);
  expect(first.progress).toMatchObject({ state: 'complete', matched: expected.length, remainingCandidates: 0,
    pendingDeliveries: 0, unknownRecipients: 0 });
  const items: string[][] = [];
  let page = first.delivery!;
  for (;;) {
    items.push(...page.items.map(row => [row.harness, row.item]));
    expect(page.omitted).toBe(expected.length - items.length);
    if (!page.next) break;
    page = (await read(original, true, page.next.cascade.after)).delivery!;
  }
  expect(items.sort()).toEqual(expected);
  const rows = await db.adminSql`SELECT harness_slug, feature_id, status, closed_ts, payload
    FROM harness_shared.work_items WHERE workspace_id = ${workspace} AND harness_slug IN (${key+'-a'}, ${key+'-b'})`;
  expect(rows.map(r => [r.harness_slug, r.feature_id]).sort()).toEqual(expected);
  for (const row of rows) {
    expect([row.status, Number(row.closed_ts)]).toEqual(['done', 1]);
    expect(readAssumptionFlags(row.payload).map(f => String(f.versionId))).toEqual([versionId]);
  }
  const notices = (await readInbox(recipient)).filter(message =>
    (message.factChangeCascade as { generation?: FactChangeRef } | undefined)?.generation?.versionId === versionId);
  expect(notices).toHaveLength(1);
}

async function interruptSweep(boundary: 'before-commit' | 'after-commit') {
  await new Promise<void>((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('../../test/fact-cascade-successor.mts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 90_000,
      env: { ...process.env, HARNESS_DATABASE_URL: db.appDsn, HARNESS_ADMIN_DATABASE_URL: db.adminDsn,
        DATABASE_URL: db.adminDsn, PAPERCUSP_WORKSPACE_ID: workspace, PAPERCUSP_PGBOUNCER: '0', PAPERCUSP_SKIP_PG_DISCOVERY: '1' },
    });
    let reached = false;
    let diagnostic = '';
    child.stderr?.on('data', chunk => { diagnostic += chunk; });
    child.on('error', reject);
    child.on('message', value => {
      reached = (value as { boundary?: string }).boundary === boundary;
      child.kill('SIGKILL');
    });
    child.on('exit', (code, signal) => reached && signal === 'SIGKILL' ? resolve() :
      reject(new Error('Private maintenance child exited before ' + boundary + ': ' + (code ?? signal) + ' ' + diagnostic)));
    child.send({ database: db.dbName, boundary });
  });
}

describe('fact-change recovery through the normal writers and maintenance', () => {
  it('the normal fact writer reaches the decisive work item across 499, 500 and 501 matches', async () => {
    for (const path of ['direct', 'retire', 'supersede'] as const) {
      for (const count of [499, 500, 501]) {
        const subject = await seed('fact-' + path + '-' + count, count);
        const progress = await change(subject.key, path);
        expect(progress.recovery.args.cascade.versionId).toBe(subject.versionId);
        expect(progress).toMatchObject({ scanned: Math.min(500, count), remainingCandidates: Math.max(0, count - 500) });
        if (count === 501) {
          expect((await read(progress)).progress.state).toBe('pending');
          await sweepExpiredFacts();
        }
        await verify(progress, subject);
      }
    }
  }, 180_000);

  it('resumes multiple fact change batches fairly after restart and reordered source rows', async () => {
    const a = await seed('reordered-a', 1503, { reverse: true, acrossHarnesses: true });
    const b = await seed('reordered-b', 1503, { acrossHarnesses: true });
    const pa = await change(a.key, 'direct');
    const pb = await change(b.key, 'supersede');
    await interruptSweep('before-commit');
    expect((await read(pa)).progress.scanned).toBe(500);
    expect((await read(pb)).progress.scanned).toBe(500);
    await interruptSweep('after-commit');
    await sweepExpiredFacts();
    expect((await read(pa)).progress.scanned).toBe(1000);
    expect((await read(pb)).progress.scanned).toBe(1000);
    for (let round = 0; round < 4; round++) await Promise.all([sweepExpiredFacts(), sweepExpiredFacts()]);
    await verify(pa, a);
    await verify(pb, b);
  }, 180_000);

  it('preserves cascade custody for supersession, retired keys and direct retraction across retries', async () => {
    for (const path of ['supersede', 'retire', 'direct'] as const) {
      const subject = await seed('custody-' + path, 1, { withoutOwner: true });
      const progress = await change(subject.key, path);
      expect(progress).toMatchObject({ state: 'pending', matched: 1, unknownRecipients: 1 });
      await db.adminSql`UPDATE harness_shared.agent_facts SET expires_at = now() - interval '31 days'
        WHERE workspace_id = ${workspace} AND id = ${subject.versionId}::bigint`;
      await sweepExpiredFacts();
      const original = await db.adminSql`SELECT id FROM harness_shared.agent_facts WHERE workspace_id = ${workspace}
        AND id = ${subject.versionId}::bigint`;
      expect(original).toHaveLength(1);
      await db.adminSql`UPDATE harness_shared.work_items SET terminal_owner = ${recipient}
        WHERE workspace_id = ${workspace} AND harness_slug = ${subject.key+'-a'}`;
      await Promise.all([sweepExpiredFacts(), sweepExpiredFacts()]);
      await sweepExpiredFacts();
      await verify(progress, subject);
      const wrong = { ...progress.recovery.args, scope: 'workspace' as const, scopeRef: null, key: 'other',
        ...progress.recovery.args.cascade };
      expect(await readFactCascade(db.adminSql, workspace, wrong)).toMatchObject({ state: 'unknown', resync: { args: { key: 'other' } } });
    }
  }, 90_000);

  it('recovers an acknowledged fact change after page or delivery failure and a lost writer response', async () => {
    // The fault lives only inside the migrated private database. A successful
    // fact mutation must retain the job even when the first page rolls back.
    await db.adminSql.unsafe(`CREATE FUNCTION harness_shared.p018_interrupt() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private interruption'; END $$`);
    const originalWarn = console.warn.bind(console);
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      if (args[0] !== '[retraction-cascade] retained pending generation') originalWarn(...args);
    });
    try {
      for (const path of ['direct', 'supersede', 'retire'] as const) {
        const subject = await seed('interrupted-' + path, 1);
        await db.adminSql.unsafe(`CREATE TRIGGER p018_page BEFORE UPDATE OF payload ON harness_shared.work_items
          FOR EACH ROW WHEN (NEW.payload ? '_assumptionFlags') EXECUTE FUNCTION harness_shared.p018_interrupt()`);
        const unknown = await change(subject.key, path);
        expect(unknown.state).toBe('unknown');
        await db.adminSql.unsafe('DROP TRIGGER p018_page ON harness_shared.work_items');
        // Start again with only the original scope/key. Neither the writer
        // receipt nor an assumed next version number is available here.
        const resync = await factsList.handler(factsList.args.parse({ scope: 'workspace', key: subject.key, cascadeHistory: true }), ctx) as
          { data: { history: { generations: Array<FactCascadeProgress['recovery']>; omitted: number } } };
        expect(resync.data.history.omitted).toBe(0);
        const [generation] = resync.data.history.generations;
        expect(generation.args.cascade.versionId).toBe(subject.versionId);
        const recovered = { ...unknown, recovery: generation };
        expect((await read(recovered)).progress.state).toBe('unknown');
        await db.adminSql.unsafe(`CREATE TRIGGER p018_notice BEFORE INSERT ON harness_shared.coord_event_log
          FOR EACH ROW WHEN (NEW.msg_id LIKE 'fact-change-%') EXECUTE FUNCTION harness_shared.p018_interrupt()`);
        await sweepExpiredFacts();
        expect((await read(recovered)).progress.state).toBe('unknown');
        await db.adminSql.unsafe('DROP TRIGGER p018_notice ON harness_shared.coord_event_log');
        await Promise.all([sweepExpiredFacts(), sweepExpiredFacts()]);
        await verify(recovered, subject);
      }
      expect(warn.mock.calls.filter(([message]) => message === '[retraction-cascade] retained pending generation')).toHaveLength(6);
    } finally {
      warn.mockRestore();
      await db.adminSql.unsafe('DROP TRIGGER IF EXISTS p018_page ON harness_shared.work_items');
      await db.adminSql.unsafe('DROP TRIGGER IF EXISTS p018_notice ON harness_shared.coord_event_log');
      await db.adminSql.unsafe('DROP FUNCTION harness_shared.p018_interrupt()');
    }
  }, 90_000);

  it('recovers historical same-ID closes in different harnesses without crossing workspaces', async () => {
    const original = await assertFact({ ...fact('legacy-twin'), createdBy: recipient });
    const rollback = new Error('end private pre-1444 compatibility fixture');
    await expect(db.adminSql.begin(async tx => {
      const sql = tx as unknown as Sql;
      // Migration 1444 forbids this historical population. Only recreate its
      // predecessor layout inside this disposable transaction.
      await tx`DROP INDEX harness_shared.work_items_workspace_feature_id_uq`;
      const close = JSON.stringify({ _assumptions: { declared: [
        { scope: 'workspace', key: 'legacy-twin', scopeRef: null, versionId: original.id },
      ] } });
      await tx`INSERT INTO harness_shared.work_items
        (workspace_id,harness_slug,feature_id,item_kind,status,created_ts,updated_ts,closed_ts,title,summary,origin,terminal_owner,payload)
        SELECT s.workspace, s.harness, 'legacy-twin-id', 'task','done',1,1,1,'Legacy close','Original','local',
               ${recipient}, ${close}::text::jsonb
        FROM (VALUES (${workspace}::text,'legacy-a'),(${workspace},'legacy-b'),('other-private-workspace','legacy-foreign')) s(workspace,harness)`;
      expect(await retractFact({ workspaceId: workspace, scope: 'workspace', key: 'legacy-twin', retractedBy: recipient }, sql)).toBe(true);
      const rows = await tx`SELECT workspace_id,harness_slug,payload FROM harness_shared.work_items WHERE feature_id='legacy-twin-id'
        ORDER BY workspace_id,harness_slug`;
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(readAssumptionFlags(row.payload)).toHaveLength(row.workspace_id === workspace ? 1 : 0);
      throw rollback;
    }).catch(error => { if (error !== rollback) throw error; })).resolves.toBeUndefined();
    const [schema] = await db.adminSql`SELECT to_regclass('harness_shared.work_items_workspace_feature_id_uq') IS NOT NULL AS restored`;
    expect(schema.restored).toBe(true);
  });

  it('advances through an indexed page containing only other scopes', async () => {
    const key = 'same-key-different-scope';
    const input = { ...fact(key), scope: 'harness' as const, createdBy: recipient };
    const original = await assertFact({ ...input, scopeRef: 'wanted' });
    const other = await assertFact({ ...input, scopeRef: 'other' });
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,status,created_ts,updated_ts,closed_ts,title,summary,origin,terminal_owner,payload)
      SELECT ${workspace}, 'prefix-scope', 'prefix-' || lpad(n::text, 4, '0'), 'task', 'done',1,1,1,'Scoped close','Original','local',
        ${recipient}, jsonb_build_object('_assumptions', jsonb_build_object('declared', jsonb_build_array(jsonb_build_object(
          'scope','harness','scopeRef', CASE WHEN n=501 THEN 'wanted' ELSE 'other' END, 'key',${key}::text,
          'versionId',CASE WHEN n=501 THEN ${original.id!}::bigint ELSE ${other.id!}::bigint END))))
      FROM generate_series(1,501) n ORDER BY n DESC`;
    let initial: FactCascadeProgress | undefined;
    await retractFact({ scope: 'harness', scopeRef: 'wanted', key, retractedBy: recipient, onCascade: p => { initial = p; } });
    expect(initial).toMatchObject({ scanned: 500, matched: 0, remainingCandidates: 1, state: 'pending' });
    await sweepExpiredFacts();
    const end = await read(initial!, true);
    expect(end.progress).toMatchObject({ scanned: 501, matched: 1, state: 'complete' });
    expect(end.delivery?.items).toEqual([{ harness: 'prefix-scope', item: 'prefix-0501' }]);
  });
});
