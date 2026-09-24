/** Independent L1s and PG listeners exercise the same bus/adapter/tag mapper used
 * by each host worker. This is a database-boundary test, not a host-process test.
 * The inbox factory is the production readInbox over the real coordination log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { Cache } from '@papercusp/cache';
import { createInvalidationBus } from '@papercusp/sync/server';
import { createPgListenSource, createPgNotifySink } from '@papercusp/sync/server/pg';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { configureCoordLog, resetCoordLog, coordWorkspaceId } from '../agent-tools/coordination/log';
import { readInbox } from '../agent-tools/coordination/messages';
import { tableNameFromChangedEvent, tagsForTableChange } from '../events/cache-eca-rule';
import { cachedRead, __setCachedReadEnabledForTests } from './cached-read';
import { installOperatorCache, resetOperatorCacheForTests } from './instance';

let org: OrgTestDb;
const WS = 'cache-freshness-integration';
let now = 0;
const workers: ReturnType<typeof makeWorker>[] = [];

function makeWorker() {
  const cache = new Cache({ clock: () => now });
  const bus = createInvalidationBus({
    listen: createPgListenSource({
      open: () => postgres(org.adminDsn, { max: 1, idle_timeout: 0 }),
      onListen: () => cache.clearL1(),
    }),
    notify: createPgNotifySink({ getSql: () => org.adminSql }),
    bridge: (name, args) => {
      const table = tableNameFromChangedEvent(name);
      if (table && typeof args?.workspace_id === 'string') {
        cache.invalidateByTags(args.workspace_id, tagsForTableChange(table, args.id));
      }
      return [];
    },
  });
  return { cache, bus, async inbox(owner: string) {
    installOperatorCache(cache);
    return cachedRead({ workspaceId: coordWorkspaceId() }, {
      tool: 'coord:inbox', key: { owner }, tags: ['coord_event_log'], hardTtlMs: 100,
    }, () => readInbox(owner));
  } };
}

async function seed(id: string, to: string[]) {
  await org.adminSql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${WS}, true)`;
    const log = new PgCoordLog({ getSql: () => tx as unknown as Sql, getWorkspaceId: () => WS, ensureSchema: async () => {} });
    await log.appendLine('messages', 'freshness-writer', {
      msg_id: id, kind: 'message', from: 'freshness-writer', to,
      summary: id, ts: new Date().toISOString(),
    });
  });
}
const ids = (rows: Awaited<ReturnType<typeof readInbox>>) => rows.map(row => row.msg_id);

beforeAll(async () => {
  org = await createOrgTestDb();
  configureCoordLog(new PgCoordLog({ getSql: () => org.adminSql, getWorkspaceId: () => WS, ensureSchema: async () => {} }));
  setFlagOverridesForTest({ 'papercusp-cache-layer': true });
  __setCachedReadEnabledForTests(true);
  workers.push(makeWorker(), makeWorker());
  await Promise.all(workers.map(worker => worker.bus.start()));
});
afterAll(async () => {
  await Promise.all(workers.map(worker => worker.bus.stop()));
  __setCachedReadEnabledForTests(false);
  resetOperatorCacheForTests();
  setFlagOverridesForTest(null);
  resetCoordLog();
  await org?.cleanup();
});

describe('cached inbox freshness over independent PG listeners', () => {
  it('delivers a committed directed write and broadcast to both L1s without leaking another recipient', async () => {
    for (const worker of workers) {
      expect(await worker.inbox('alice')).toEqual([]);
      expect(await worker.inbox('bob')).toEqual([]);
    }
    await seed('direct-alice', ['alice']);
    await expect.poll(async () => ids(await workers[0].inbox('alice'))).toContain('direct-alice');
    await expect.poll(async () => ids(await workers[1].inbox('alice'))).toContain('direct-alice');
    for (const worker of workers) expect(ids(await worker.inbox('bob'))).not.toContain('direct-alice');
    await seed('all-readers', ['*']);
    for (const worker of workers) {
      await expect.poll(async () => ids(await worker.inbox('bob'))).toContain('all-readers');
      await expect.poll(async () => ids(await worker.inbox('alice'))).toContain('all-readers');
    }
  });

  it('bounds a missed notification by hard TTL and clears missed writes on listener reconnect', async () => {
    const worker = workers[1];
    await worker.inbox('alice');
    await worker.bus.stop();
    await seed('during-outage', ['alice']);
    expect(ids(await worker.inbox('alice'))).not.toContain('during-outage');
    now = 101;
    expect(ids(await worker.inbox('alice'))).toContain('during-outage');
    await seed('before-reconnect', ['alice']);
    expect(ids(await worker.inbox('alice'))).not.toContain('before-reconnect');
    await worker.bus.start();
    expect(ids(await worker.inbox('alice'))).toContain('before-reconnect');
  });
});
