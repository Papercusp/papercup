/**
 * feature-message-durability.integration.test.ts — plan
 * harness-test-coverage-for-launch P-009.
 *
 * The role-to-role baton in the pipeline is a durable feature message:
 * `messages:send` (feature-scoped) writes a row into `harness_<slug>.messages`
 * with from_feature_id / to_feature_id, and the receiving role reads it back via
 * `messages:inbox` (which subsumed the old `messages:feature_inbox`). Until now the
 * only coverage was `messages-tools.test.ts`, which mocks `executeAction` — it
 * proves the SEND tool builds the right op, but NOTHING proved the message is
 * durably stored and correctly delivered to the addressed feature.
 *
 * This drives the REAL `messages:inbox` handler (it only needs `ctx.tx`) against a
 * REAL Postgres (testcontainers) holding a faithful per-harness `messages` table
 * (002-per-harness-template + migration-044 feature columns). We assert the
 * handoff survives a connection drop (= operator restart), is feature-scoped,
 * created_at-ordered, status-filtered (dismiss = archived), and lossless.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from './_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- exercise the REAL inbox handler
import inboxTool from '../../../packages/agent-mcp/src/tools/messages/inbox';

const SLUG = 'test-p009';
const SCHEMA = `harness_${SLUG.replace(/-/g, '_')}`; // mirrors migration-044's mapping

// Faithful per-harness messages DDL (002-per-harness-template.sql lines 207-230,
// + the to_feature_id / from_feature_id columns migration 044 adds + its index).
const MESSAGES_DDL = `
  CREATE TABLE ${SCHEMA}.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_slug TEXT NOT NULL,
    to_slug TEXT NOT NULL,
    to_role TEXT,
    from_feature_id TEXT,
    to_feature_id TEXT,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT,
    parent_message_id UUID,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    CHECK (status IN ('pending', 'acknowledged', 'archived'))
  );
  CREATE INDEX messages_to_feature_idx ON ${SCHEMA}.messages(to_feature_id, status)
    WHERE to_feature_id IS NOT NULL;
`;

let db: FreshPgDb;

type MsgSeed = {
  from_slug?: string;
  from_feature_id?: string | null;
  to_role?: string | null;
  to_feature_id?: string | null;
  kind?: string;
  subject: string;
  body?: string | null;
  status?: 'pending' | 'acknowledged' | 'archived';
  created_at: string; // ISO — explicit so ordering is deterministic
};

async function seed(m: MsgSeed): Promise<void> {
  await db.sql`
    INSERT INTO ${db.sql(SCHEMA)}.messages
      (from_slug, to_slug, to_role, from_feature_id, to_feature_id, kind, subject, body, status, created_at)
    VALUES (
      ${m.from_slug ?? 'worker'}, ${SLUG}, ${m.to_role ?? null},
      ${m.from_feature_id ?? null}, ${m.to_feature_id ?? null},
      ${m.kind ?? 'feature-note'}, ${m.subject}, ${m.body ?? null},
      ${m.status ?? 'pending'}, ${m.created_at}
    )
  `;
}

// Call the real handler exactly as the dispatcher would, but with a minimal ctx
// (the handler only reads ctx.tx). Defaults are applied by the dispatcher's zod
// parse in production, so we pass every field explicitly here.
function inbox(
  tx: postgres.Sql,
  over: { feature_id?: string; status?: 'pending' | 'acknowledged' | 'archived' | 'all'; detail?: 'summary' | 'full'; limit?: number } = {},
) {
  return inboxTool.handler(
    { slug: SLUG, detail: 'full', status: 'pending', limit: 50, ...over },
    { tx } as never,
  ) as Promise<{ data: Array<Record<string, unknown>>; degraded?: boolean; degradedReasons?: string[] }>;
}

beforeAll(async () => {
  db = await createFreshPgDb('fmsg');
  await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await db.sql.unsafe(MESSAGES_DDL);
}, 60_000);

afterAll(async () => {
  if (db) await db.cleanup();
});

describe('feature-message handoff durability (messages:inbox over real PG)', () => {
  it('delivers a feature-scoped baton to the addressed feature, newest-first, and nothing else', async () => {
    await seed({ to_feature_id: 'F-2', subject: 'scoper→worker A', created_at: '2026-06-01T10:00:00Z' });
    await seed({ to_feature_id: 'F-2', subject: 'scoper→worker B', created_at: '2026-06-01T10:05:00Z' });
    await seed({ to_feature_id: 'F-2', subject: 'scoper→worker C', created_at: '2026-06-01T10:02:00Z' });
    await seed({ to_feature_id: 'F-9', subject: 'other feature', created_at: '2026-06-01T10:09:00Z' });
    await seed({ to_feature_id: null, to_role: 'director', subject: 'harness-level', created_at: '2026-06-01T10:10:00Z' });

    const res = await inbox(db.sql, { feature_id: 'F-2', status: 'all' });
    expect(res.degraded).toBeFalsy();
    // Only F-2's three, ordered created_at DESC (B 10:05, C 10:02, A 10:00).
    expect(res.data.map((r) => r.subject)).toEqual(['scoper→worker B', 'scoper→worker C', 'scoper→worker A']);
    expect(res.data.every((r) => r.to_feature_id === 'F-2')).toBe(true);
  });

  it('survives a connection drop (operator restart) — the baton is read from PG, not memory', async () => {
    // A genuinely separate pool to the SAME database = "after restart". Rows seeded
    // on the original connection must still be delivered through the fresh client.
    const fresh = freshClientToSameDb();
    try {
      const res = await inbox(fresh, { feature_id: 'F-2', status: 'all' });
      expect(res.data).toHaveLength(3);
      expect(res.data.map((r) => r.subject)).toContain('scoper→worker B');
    } finally {
      await fresh.end({ timeout: 5 });
    }
  });

  it('honors the status filter so dismiss (status=archived) hides the message from the default inbox', async () => {
    await seed({ to_feature_id: 'F-3', subject: 'live note', status: 'pending', created_at: '2026-06-01T11:00:00Z' });
    await seed({ to_feature_id: 'F-3', subject: 'dismissed note', status: 'archived', created_at: '2026-06-01T11:01:00Z' });

    const pending = await inbox(db.sql, { feature_id: 'F-3', status: 'pending' });
    expect(pending.data.map((r) => r.subject)).toEqual(['live note']);

    const all = await inbox(db.sql, { feature_id: 'F-3', status: 'all' });
    expect(all.data.map((r) => r.subject).sort()).toEqual(['dismissed note', 'live note']);
  });

  it('separates harness-level messages (to_feature_id NULL) from feature batons', async () => {
    const harnessLevel = await inbox(db.sql, { status: 'all' }); // no feature_id
    expect(harnessLevel.data.every((r) => r.to_feature_id === null)).toBe(true);
    expect(harnessLevel.data.map((r) => r.subject)).toContain('harness-level');
    // ...and a feature read never leaks the harness-level one.
    const f2 = await inbox(db.sql, { feature_id: 'F-2', status: 'all' });
    expect(f2.data.map((r) => r.subject)).not.toContain('harness-level');
  });

  it('is lossless and dup-free — every distinct seeded baton is delivered exactly once', async () => {
    const f2 = await inbox(db.sql, { feature_id: 'F-2', status: 'all' });
    const ids = f2.data.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toHaveLength(3); // no loss
  });
});

// A second pool to the SAME throwaway DB the helper created. Rebuilt from the
// helper client's connection options (postgres-js stores host/port as arrays).
function freshClientToSameDb(): postgres.Sql {
  const opts = (db.sql as unknown as { options: Record<string, unknown> }).options;
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  return postgres({
    host: first(opts.host) as string,
    port: first(opts.port) as number,
    database: first(opts.database) as string,
    username: opts.user as string,
    password: opts.pass as string,
    max: 2,
    onnotice: () => {},
    prepare: false,
  });
}
