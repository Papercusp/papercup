// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCoordCapabilityTables, PgEntitySubscriptionStore } from '@papercusp/coordination/capabilities';
import { ensureCoordEventLogTable, PgCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog } from '../agent-tools/coordination/log';
import { readDirectedInbox } from '../agent-tools/coordination/messages';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const workspaceId = 'reference-fanout-test';
const worker = fileURLToPath(new URL('../../test/_reference-fanout-worker.mts', import.meta.url));
let db: OrgTestDb;

function workerOptions() {
  return { env: { ...process.env, REFERENCE_FANOUT_TEST_DSN: db.adminDsn },
    cwd: fileURLToPath(new URL('../../', import.meta.url)) };
}

function child(mode: string, slug = '', point = '', workflowId = '') {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', worker, mode, slug, point, workflowId], {
    ...workerOptions(), encoding: 'utf8', timeout: 90_000,
  });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  if (point === 'refresh-error') expect(result.status, output).toBe(1);
  else if (point && point !== 'graceful') expect(result.signal, output).toBe('SIGKILL');
  else expect(result.status, output).toBe(0);
  if (point) expect(output).toContain('FANOUT_BOUNDARY ' + point);
  if (mode === 'work' && !point) expect(output).toContain('FANOUT_COMPLETE ' + workflowId);
}

async function outstanding(id: string) {
  const [row] = await db.adminSql`SELECT fanout_retry_at IS NOT NULL AS pending
    FROM harness_shared.substrate_outbox WHERE id = ${id}`;
  return row.pending as boolean;
}

const inbox = (follower: string) => readDirectedInbox(follower, { kinds: ['notify'] });

async function subscribeFixture() {
  const slug = 'restart-' + randomUUID();
  const ref = 'F-' + randomUUID();
  const followers = [slug + '-explicit', slug + '-holder'];
  const sql = db.adminSql;
  const store = new PgEntitySubscriptionStore({ getSql: () => sql, ensureSchema: async () => {}, workspaceId });
  for (const [index, subscriber_id] of followers.entries()) {
    await store.subscribe({ subscriber_id, target_kind: 'object', target_ref: 'feature:' + ref,
      reason: index === 0 ? 'explicit' : 'held_item', created_ts: new Date().toISOString() });
  }
  async function capture(title: string) {
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id, title, status)
      VALUES (${workspaceId}, ${slug}, ${ref}, ${title}, 'todo')
      ON CONFLICT (harness_slug, feature_id) DO UPDATE SET title = EXCLUDED.title`;
    const [row] = await sql`SELECT id::text FROM harness_shared.substrate_outbox
      WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug} AND key = ${ref} AND row->>'title' = ${title}`;
    expect(row, 'committed capture of ' + title).toBeDefined();
    await sql`UPDATE harness_shared.substrate_outbox SET drained_at = 1, fanout_retry_at = 0 WHERE id = ${row.id}`;
    child('admit', slug);
    const jobs = await sql`SELECT workflow_uuid FROM dbos.workflow_status WHERE name = 'referenceFanout' AND status = 'ENQUEUED'`;
    expect(jobs, 'newly admitted workflow in the private database').toHaveLength(1);
    expect(await outstanding(row.id), 'queue admission must retain the outbox retry').toBe(true);
    return { id: row.id as string, workflow: jobs[0].workflow_uuid as string, title };
  }
  return { slug, ref, followers, capture };
}

beforeAll(async () => {
  db = await createOrgTestDb();
  await ensureCoordCapabilityTables(db.adminSql);
  await ensureCoordEventLogTable(db.adminSql);
  configureCoordLog(new PgCoordLog({ getSql: () => db.adminSql, ensureSchema: async () => {}, workspaceId }));
  child('init');
}, 180_000);

afterAll(async () => {
  resetCoordLog();
  await db?.cleanup();
});

describe('reference fan-out survives process restart', () => {
  it.each(['before-ack', 'between-recipients', 'mid-refresh', 'graceful'])(
    'delivers each eligible change once across %s', async point => {
      const { slug, ref, followers, capture } = await subscribeFixture();
      const sql = db.adminSql;
      const first = await capture('version one');
      const versions = [first];
      if (point === 'mid-refresh') {
        child('work', slug, '', first.workflow);
        for (const follower of followers) expect(await inbox(follower)).toHaveLength(1);
        versions.push(await capture('version two'));
      }
      const current = versions[versions.length - 1];
      child('work', slug, point, current.workflow);
      const steps = await sql`SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid = ${current.workflow}
        AND error IS NULL ORDER BY function_id`;
      const acked = steps.filter(step => step.function_name === 'write-recipient').length;
      expect(acked).toBe(point === 'between-recipients' || point === 'graceful' ? 1 : 0);
      const writes = (await Promise.all(followers.map(inbox))).flat().filter(entry => entry.summary?.endsWith(current.title));
      expect(writes).toHaveLength(point === 'mid-refresh' ? 0 : 1);
      expect(await outstanding(current.id)).toBe(true);

      child('work', slug, '', current.workflow);
      for (const follower of followers) {
        const messages = await inbox(follower);
        expect(messages.map(entry => [entry.msg_id, entry.summary])).toEqual(versions.map(version => [
          'fan-' + version.id + '-' + follower, 'feature ' + ref + ' → todo: ' + version.title,
        ]));
      }
      await sql`UPDATE harness_shared.substrate_outbox SET fanout_retry_at = 0
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug} AND fanout_retry_at IS NOT NULL`;
      child('admit', slug);
      for (const version of versions) expect(await outstanding(version.id)).toBe(false);
    }, 240_000);

  it('delivers the newer change committed during fan-out when the first worker is killed', async () => {
    const { slug, ref, followers, capture } = await subscribeFixture();
    const first = await capture('version one');
    const running = fork(worker, ['work', slug, 'hold-before-ack', first.workflow], {
      ...workerOptions(), execArgv: ['--import', 'tsx/esm'],
    });
    const stopped = once(running, 'exit');
    let second: Awaited<ReturnType<typeof capture>>;
    try {
      const [message] = await Promise.race([
        once(running, 'message', { signal: AbortSignal.timeout(60_000) }),
        stopped.then(([code, signal]) => { throw new Error('Worker stopped before first write: ' + (signal ?? code)); }),
      ]);
      expect(message).toBe('recipient-written');
      second = await capture('version two');
      expect(second.workflow).not.toBe(first.workflow);
      const [job] = await db.adminSql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${first.workflow}`;
      expect(job.status).toBe('PENDING');
      expect((await Promise.all(followers.map(inbox))).flat()).toHaveLength(1);
    } finally {
      running.kill('SIGKILL');
      await stopped;
    }
    expect((await stopped)[1]).toBe('SIGKILL');
    child('work', slug, '', second.workflow);
    for (const follower of followers) {
      expect((await inbox(follower)).map(entry => [entry.msg_id, entry.summary])).toEqual(
        [first, second].map(version => ['fan-' + version.id + '-' + follower, 'feature ' + ref + ' → todo: ' + version.title]));
    }
  }, 240_000);

  it('retries an older failed refresh without moving recipients behind a newer durable version', async () => {
    const { slug, ref, followers, capture } = await subscribeFixture();
    const sql = db.adminSql;
    const first = await capture('older');
    child('work', slug, 'refresh-error', first.workflow);
    const [failed] = await sql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${first.workflow}`;
    expect(failed.status).toBe('ERROR');
    await sql`UPDATE harness_shared.substrate_outbox SET fanout_retry_at = ${Date.now() + 3_600_000} WHERE id = ${first.id}`;
    const newer = await capture('newer');
    child('work', slug, '', newer.workflow);
    for (const follower of followers) expect((await inbox(follower)).map(row => row.msg_id)).toEqual(['fan-' + newer.id + '-' + follower]);

    await sql`UPDATE harness_shared.substrate_outbox SET fanout_retry_at = 0 WHERE id = ${first.id}`;
    child('admit', slug);
    const retries = await sql`SELECT workflow_uuid FROM dbos.workflow_status WHERE forked_from = ${first.workflow}`;
    expect(retries).toHaveLength(1);
    child('work', slug, '', retries[0].workflow_uuid);
    for (const follower of followers) {
      expect((await inbox(follower)).map(row => [row.msg_id, row.summary])).toEqual([
        ['fan-' + newer.id + '-' + follower, 'feature ' + ref + ' → todo: newer'],
      ]);
    }
    await sql`UPDATE harness_shared.substrate_outbox SET fanout_retry_at = 0 WHERE id IN (${first.id}, ${newer.id})`;
    child('admit', slug);
    expect(await outstanding(first.id)).toBe(false);
    expect(await outstanding(newer.id)).toBe(false);
  }, 240_000);
});
