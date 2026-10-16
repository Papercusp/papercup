import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as Sql | null, ws: 'ws-local-event-types' }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws, backgroundWorkspaceIds: () => [h.ws] }));
vi.mock('../agent-tools/coordination/identity', async (original) => ({
  ...(await original<typeof import('../agent-tools/coordination/identity')>()),
  resolveAgentIdentity: () => ({ workspaceId: h.ws, ownerId: 'su-local-event-author', ownerLabel: 'Author', userId: null, source: 'static-client' }),
}));
import emit from '../agent-tools/events/emit';
import { getEventKey } from '../event-key-registry-store';
import { readSavedEventCatalog, saveEventType } from './saved-event-type';
import { mergeInstalledEventCatalog, keyMatchesCatalog } from './await/catalog';
import { registerAwait } from './await/store';
import { setAutoPumpEnabledForTests } from './await/engine';

describe('locally authored event type (real Postgres)', () => {
  let db: OrgTestDb;
  let previousPump: boolean;
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    previousPump = setAutoPumpEnabledForTests(false);
  }, 180_000);
  afterAll(async () => {
    setAutoPumpEnabledForTests(previousPump);
    h.sql = null;
    await db?.cleanup();
  });

  it('declares without firing, reloads from durable storage, then validates and queues exactly one wake', async () => {
    const invoke = async (args: Record<string, unknown>) => {
      const result = await emit.handler(args as never, { workspaceId: h.ws, role: 'operator' } as never);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    const declared = await invoke({ event: 'local:smoke-ready', announce: true, announceScope: 'global', save: true,
      title: 'Smoke ready', payloadSchema: { type: 'object', properties: { ready: { const: true } }, required: ['ready'] } });
    expect(declared).toMatchObject({ announced: true, saved: true, event: 'local:smoke-ready' });
    const firesBefore = await db.adminSql`SELECT * FROM harness_shared.event_key_fires WHERE event_key = 'local:smoke-ready'`;
    expect(firesBefore).toHaveLength(0);
    // A fresh store read is independent of the declaration handler's process memory.
    expect(await getEventKey(db.adminSql, h.ws, 'local:smoke-ready')).toMatchObject({ title: 'Smoke ready', contributor: 'local:su-local-event-author' });
    expect(keyMatchesCatalog('local:smoke-ready', mergeInstalledEventCatalog(await readSavedEventCatalog(h.ws, db.adminSql)).entries)).toBe(true);
    await registerAwait({ subscriberId: 'su-local-event-waiter', eventKey: declared.event, minSleepSec: 0,
      wakeHandle: { kind: 'plan-run', runId: 999 }, timeoutSec: 600, timeoutBehavior: 'wake' });
    await expect(invoke({ event: declared.event, payload: { ready: false } })).rejects.toThrow('event_payload_invalid');
    expect(await db.adminSql`SELECT * FROM harness_shared.event_wake_deliveries WHERE event_key = 'local:smoke-ready'`).toHaveLength(0);
    expect(await invoke({ event: declared.event, payload: { ready: true } })).toMatchObject({ woken: 1, waiters: 1 });
    expect(await db.adminSql`SELECT subscriber_id, payload FROM harness_shared.event_wake_deliveries WHERE event_key = 'local:smoke-ready'`)
      .toEqual([expect.objectContaining({ subscriber_id: 'su-local-event-waiter', payload: { ready: true } })]);
    await expect(saveEventType({ workspaceId: h.ws, ownerId: 'someone-else', event: declared.event }, db.adminSql)).rejects.toThrow('event_type_owned');
    await saveEventType({ workspaceId: h.ws, ownerId: 'su-local-event-author', event: declared.event, eventStatus: 'retired' }, db.adminSql);
    expect(await readSavedEventCatalog(h.ws, db.adminSql)).toEqual([]);
  });
});
