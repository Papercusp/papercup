/**
 * audience.integration.test.ts — subscription-scoped lifecycle delivery end-to-end
 * against REAL Postgres (coord-emit-subscription-scoping-2026-06-05, Brief 28).
 *
 * Proves the brief's acceptance with real coord stores + the real inbox filter:
 *  • `@plan` resolves to plan subscribers ∪ tagged-topic subscribers ∪ presence-on-plan
 *  • `@object` resolves to the work-item's subscribers
 *  • `@file` resolves to active presence editing that file
 *  • through filterInbox: a watcher receives the event, a non-watcher does NOT
 *    (the broadcast-volume drop), and the legacy `['*']` would have reached them.
 *
 * The PG-backed resolution (subscriptions + coord_links tags) runs against a
 * throwaway testcontainer DB; presence (pure array filtering) is injected, since
 * its logic is covered by the unit suite (./audience.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  ensureCoordCapabilityTables,
  PgEntitySubscriptionStore,
  PgLinkStore,
} from '@papercusp/coordination/capabilities';
import { filterInbox, type CoordEnvelope } from '@papercusp/coordination/core';
import {
  expandAudience,
  objectSelector,
  type ActivePresence,
  type AudienceResolvers,
} from './audience';

const WS = 'default';
const NOW = '2026-06-05T00:00:00.000Z';

const PRESENCE: ActivePresence[] = [
  { ownerId: 'on-plan', planSlug: 'my-plan', files: [] },
  { ownerId: 'elsewhere', planSlug: 'other-plan', files: ['other.ts'] },
  { ownerId: 'file-editor', planSlug: 'other-plan', files: ['apps/x/app.rs'] },
];

let db: FreshPgDb;
let sql: postgres.Sql;
let resolvers: AudienceResolvers;

beforeAll(async () => {
  db = await createFreshPgDb('audience');
  sql = db.sql;
  await ensureCoordCapabilityTables(sql);
  const opts = { getSql: () => sql, ensureSchema: async () => {}, workspaceId: WS };
  const subs = new PgEntitySubscriptionStore(opts);
  const links = new PgLinkStore(opts);

  // Real subscriptions: a plan subscriber, a topic subscriber (with the plan
  // tagged to that topic), and a work-item object subscriber.
  await subs.subscribe({ subscriber_id: 'plan-sub', target_kind: 'object', target_ref: 'plan:my-plan', delivery_mode: 'full', created_ts: NOW });
  await subs.subscribe({ subscriber_id: 'topic-sub', target_kind: 'topic', target_ref: 'area-x', delivery_mode: 'full', created_ts: NOW });
  await links.link({ kind: 'plan', ref: 'my-plan' }, { kind: 'topic', ref: 'area-x' }, 'tagged', { created_ts: NOW });
  await subs.subscribe({ subscriber_id: 'obj-sub', target_kind: 'object', target_ref: 'feature:demo#F-1', delivery_mode: 'full', created_ts: NOW });

  resolvers = {
    async listTargetSubscribers(kind, ref) {
      return (await subs.listTargetSubscribers(kind, ref)).map((r) => r.subscriber_id);
    },
    async listActivePresence() {
      return PRESENCE;
    },
    async listTaggedTopics(kind, ref) {
      const ls = await links.listOut({ kind, ref }, { rel: 'tagged' });
      return ls.filter((l) => l.dst.kind === 'topic').map((l) => l.dst.ref);
    },
    // Fleet resolution is unit-tested in audience.test.ts (pure branch wiring) and
    // e2e in the plan's P-012 (real coord_presence + agent_fleets); this @plan/@topic/
    // @object integration test stays scoped, so the fleet resolvers stub to empty.
    async listFleetMembers() {
      return [];
    },
    async listFleetLeader() {
      return [];
    },
  };
});

afterAll(async () => {
  await db.cleanup();
});

describe('@plan scoping (real PG subscriptions + tags + injected presence)', () => {
  it('resolves to plan subscribers ∪ tagged-topic subscribers ∪ presence-on-plan', async () => {
    const out = await expandAudience(['@plan:my-plan'], resolvers);
    expect(new Set(out)).toEqual(new Set(['plan-sub', 'topic-sub', 'on-plan']));
    expect(out).not.toContain('elsewhere');
    expect(out).not.toContain('file-editor');
  });
});

describe('@object scoping', () => {
  it('resolves to the feature work-item subscribers (real PG)', async () => {
    const out = await expandAudience([objectSelector({ kind: 'feature', ref: 'demo#F-1' })], resolvers);
    expect(out).toEqual(['obj-sub']);
  });
});

describe('@file scoping', () => {
  it('resolves to active presence editing that file', async () => {
    const out = await expandAudience(['@file:apps/x/app.rs'], resolvers);
    expect(out).toEqual(['file-editor']);
  });
});

describe('end-to-end delivery through the real inbox filter', () => {
  it('a watcher receives the lifecycle event; a non-watcher does not (volume drop vs *)', async () => {
    const to = await expandAudience(['@plan:my-plan'], resolvers);
    const env: CoordEnvelope = {
      ts: '2026-06-05T01:00:00.000Z',
      msg_id: 'm1',
      from: 'sender',
      to,
      kind: 'message',
      summary: 'F-1 done',
    };
    const sees = (owner: string) => filterInbox([env], owner).length > 0;

    expect(sees('plan-sub')).toBe(true); // explicit subscriber
    expect(sees('on-plan')).toBe(true); // presence-on-plan watcher
    expect(sees('topic-sub')).toBe(true); // tagged-topic subscriber
    expect(sees('elsewhere')).toBe(false); // not watching → no delivery
    expect(sees('file-editor')).toBe(false);
    expect(sees('sender')).toBe(false); // excludeOwn

    // The legacy broadcast WOULD have reached the non-watcher — this is the drop.
    const broadcast: CoordEnvelope = { ...env, to: ['*'] };
    expect(filterInbox([broadcast], 'elsewhere')).toHaveLength(1);
  });
});
