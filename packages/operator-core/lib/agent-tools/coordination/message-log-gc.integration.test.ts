/**
 * message-log-gc.integration.test.ts — gcOldOperatorMessages, the physical
 * retention GC over operator-scope coord_event_log `messages`.
 *
 * Proves the WI-401 safety contract: delete fully-aged operator-scope message
 * threads atomically; keep recent threads, harness-scoped/federating threads,
 * orphan replies, other surfaces, and any thread whose msg_id is referenced by
 * coord_thread_posts.post_msg_id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { gcOldOperatorMessages } = await import('./message-log-gc');

let rootSql: postgres.Sql;
const remainingIds = async () =>
  (await rootSql<{ msg_id: string }[]>`SELECT msg_id FROM harness_shared.coord_event_log ORDER BY msg_id`).map((r) => r.msg_id);

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `mgc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_event_log (
      id bigserial PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      surface text NOT NULL,
      writer_key text,
      msg_id text NOT NULL,
      body jsonb NOT NULL,
      harness_slug text,
      ts timestamptz DEFAULT now() NOT NULL
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_thread_posts (
      id bigserial PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      thread_id text NOT NULL,
      author_id text,
      body text NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      post_msg_id text,
      harness_slug text
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_event_log, harness_shared.coord_thread_posts RESTART IDENTITY`;
});

async function msg(opts: {
  msgId: string;
  ageDays: number;
  relatedTo?: string;
  harness?: string | null;
  surface?: string;
}) {
  const body = opts.relatedTo
    ? { kind: 'message', msg_id: opts.msgId, related_msg_id: opts.relatedTo }
    : { kind: 'message', msg_id: opts.msgId };
  await rootSql`
    INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, harness_slug, ts)
    VALUES (${opts.surface ?? 'messages'}, ${opts.msgId}, ${rootSql.json(body)}, ${opts.harness ?? null},
            now() - make_interval(days => ${opts.ageDays}))`;
}

async function postRef(msgId: string) {
  await rootSql`
    INSERT INTO harness_shared.coord_thread_posts (thread_id, author_id, body, post_msg_id)
    VALUES ('thread-1', 'agent', 'post', ${msgId})`;
}

describe('gcOldOperatorMessages (PG)', () => {
  it('deletes only fully-aged operator-scope rooted threads, preserving thread/ref safety', async () => {
    await msg({ msgId: 'standalone-old', ageDays: 45 });

    await msg({ msgId: 'thread-old-root', ageDays: 45 });
    await msg({ msgId: 'thread-old-reply', ageDays: 44, relatedTo: 'thread-old-root' });
    await msg({ msgId: 'thread-old-grandchild', ageDays: 43, relatedTo: 'thread-old-reply' });

    await msg({ msgId: 'recent-child-root', ageDays: 45 });
    await msg({ msgId: 'recent-child', ageDays: 1, relatedTo: 'recent-child-root' });

    await msg({ msgId: 'harness-child-root', ageDays: 45 });
    await msg({ msgId: 'harness-child', ageDays: 45, relatedTo: 'harness-child-root', harness: 'peer-hive' });

    await msg({ msgId: 'harness-root', ageDays: 45, harness: 'peer-hive' });
    await msg({ msgId: 'operator-child-of-harness-root', ageDays: 45, relatedTo: 'harness-root' });

    await msg({ msgId: 'orphan-reply', ageDays: 45, relatedTo: 'missing-root' });

    await msg({ msgId: 'post-ref-root', ageDays: 45 });
    await msg({ msgId: 'post-ref-reply', ageDays: 45, relatedTo: 'post-ref-root' });
    await postRef('post-ref-reply');

    await msg({ msgId: 'old-presence', ageDays: 45, surface: 'presence' });

    const n = await gcOldOperatorMessages(30);
    expect(n).toBe(4); // standalone + 3-message old thread
    expect(await remainingIds()).toEqual([
      'harness-child',
      'harness-child-root',
      'harness-root',
      'old-presence',
      'operator-child-of-harness-root',
      'orphan-reply',
      'post-ref-reply',
      'post-ref-root',
      'recent-child',
      'recent-child-root',
    ]);
  });

  it('retentionDays controls the fully-aged cutoff', async () => {
    await msg({ msgId: 'root', ageDays: 10 });
    await msg({ msgId: 'reply', ageDays: 10, relatedTo: 'root' });
    expect(await gcOldOperatorMessages(14)).toBe(0);
    expect(await gcOldOperatorMessages(7)).toBe(2);
  });
});
