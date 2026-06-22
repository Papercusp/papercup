/**
 * Integration test for coord_conversations federation (Track A,
 * distributed-coordination-shared-harness-2026-06-04). Real Postgres.
 *
 * Proves the full send + apply seam for the FIRST coord-content surface:
 *   1. CAPTURE: the migration-144 triggers enqueue a substrate_outbox row for a
 *      HARNESS-scoped, local-origin conversation — and enqueue NOTHING for an
 *      operator-scope conversation or a remote-origin (projected) row.
 *   2. RESHAPE: outboxRowToLocalWriteOp turns that outbox row into a
 *      'coord-conversations' LocalWriteOp with epoch-ms timestamps.
 *   3. APPLY: the projection's writeToPg upserts a remote row with origin='remote'
 *      (the echo-guard input) and a NULL accepted_post_id (the local-only field),
 *      and deleteFromPg removes it.
 *
 * Owns its schema (column-faithful coord_conversations + the real 102 outbox /
 * capture function + migration 144 verbatim); does not touch the dev DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from "./../../../../test/_work-items-schema";
import {
  buildCoordConversationProjection,
  type CoordConversationRow,
} from '../projections/coord-conversation';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');
const OUTBOX_MIGRATION = resolve(SQL_DIR, 'archive/102-substrate-outbox.sql');
const FED_MIGRATION = resolve(SQL_DIR, '144-coord-conversations-federation.sql');

/**
 * Strip psql meta-commands (\set …) and the standalone BEGIN;/COMMIT; wrapper so
 * postgres-js can run the body over a pooled (max>1) connection (it refuses bare
 * BEGIN/COMMIT in `unsafe`). The migration runner wraps in its own transaction;
 * here each statement runs autocommit, which is fine for a throwaway test DB.
 */
function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const WS = 'ws_conv';
const HARNESS = 'fed';

interface OutboxDbRow {
  workspace_id: string;
  harness_slug: string;
  table_name: string;
  op: string;
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
}

describe('coord_conversations federation (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('coord_conv_fed');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);

    await db.sql.unsafe(`
      DO $r$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
          CREATE ROLE harness_app NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
          CREATE ROLE harness_admin NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
          CREATE ROLE harness_zero NOLOGIN;
        END IF;
      END $r$;
    `);

    // Column-faithful coord_conversations (mig 132), pre-144 (no origin/author_pubkey).
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.coord_conversations (
        workspace_id      text DEFAULT 'default' NOT NULL,
        id                text NOT NULL,
        kind              text NOT NULL,
        scope             text DEFAULT 'operator' NOT NULL,
        harness_slug      text,
        asker_id          text NOT NULL,
        title             text,
        body              text DEFAULT '' NOT NULL,
        state             text DEFAULT 'open' NOT NULL,
        accepted_answer   text,
        accepted_post_id  bigint,
        capture_target    text,
        promoted_issue_id text,
        created_at        timestamptz DEFAULT now() NOT NULL,
        updated_at        timestamptz DEFAULT now() NOT NULL,
        resolved_at       timestamptz,
        fed_ts            bigint, -- EI-79 step 2 (mig 181): PG-level LWW guard column
        fed_hlc           text,   -- D-001 (mig 314): the HLC ordering key the guard compares
        CONSTRAINT coord_conversations_pkey PRIMARY KEY (workspace_id, id),
        CONSTRAINT coord_conversations_kind_check  CHECK (kind  = ANY (ARRAY['question','discussion'])),
        CONSTRAINT coord_conversations_scope_check CHECK (scope = ANY (ARRAY['operator','harness'])),
        CONSTRAINT coord_conversations_state_check CHECK (state = ANY (ARRAY['open','resolved','closed'])),
        CONSTRAINT coord_conversations_scope_slug_check CHECK (
            (scope = 'harness'  AND harness_slug IS NOT NULL AND harness_slug <> '')
         OR (scope = 'operator' AND harness_slug IS NULL))
      );
    `);

    // Migration 102 attaches capture triggers to the two consolidated tables, so
    // they must exist before we apply it. Minimal column-faithful stubs (the
    // trigger only needs origin/workspace_id/harness_slug + the key columns).
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_features_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        feature_id TEXT NOT NULL, author_pubkey TEXT,
        origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, feature_id)
      );
      CREATE TABLE harness_shared.harness_issues_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        issue_id TEXT NOT NULL, author_pubkey TEXT,
        origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, issue_id)
      );
    `);

    // The real outbox table + capture_substrate_outbox function (mig 102).
    await db.sql.unsafe(readFileSync(OUTBOX_MIGRATION, 'utf8'));
    // Migration 144 verbatim (adds origin/author_pubkey + the capture triggers).
    await db.sql.unsafe(stripMeta(readFileSync(FED_MIGRATION, 'utf8')));
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function countOutbox(): Promise<number> {
    const [r] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    return r.n;
  }

  it('a harness-scoped local conversation enqueues exactly one put outbox row', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, state)
      VALUES (${WS}, 'conv-1', 'question', 'harness', ${HARNESS}, 'su-1', 'Q1', 'body1', 'open')
    `;
    const rows = await db.sql<OutboxDbRow[]>`
      SELECT workspace_id, harness_slug, table_name, op, key, row, ts FROM harness_shared.substrate_outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe('coord_conversations');
    expect(rows[0].op).toBe('put');
    expect(rows[0].key).toBe('conv-1');
    expect(rows[0].harness_slug).toBe(HARNESS);
    expect(rows[0].workspace_id).toBe(WS);
  });

  it('an operator-scope conversation enqueues NOTHING (federation is harness-only)', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, body)
      VALUES (${WS}, 'conv-op', 'discussion', 'operator', NULL, 'su-1', 'operator scope')
    `;
    expect(await countOutbox()).toBe(0);
  });

  it('a remote-origin conversation enqueues NOTHING (echo-loop guard)', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, body, origin)
      VALUES (${WS}, 'conv-remote', 'question', 'harness', ${HARNESS}, 'su-2', 'from a peer', 'remote')
    `;
    expect(await countOutbox()).toBe(0);
  });

  it('an UPDATE that changes the row enqueues another put; the reshape builds a coord-conversations op', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`UPDATE harness_shared.coord_conversations
      SET state = 'resolved', accepted_answer = 'because Y', resolved_at = now()
      WHERE workspace_id = ${WS} AND id = 'conv-1'`;
    const rows = await db.sql<OutboxDbRow[]>`
      SELECT workspace_id, harness_slug, table_name, op, key, row, ts FROM harness_shared.substrate_outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('put');

    const op = outboxRowToLocalWriteOp({
      table_name: rows[0].table_name,
      op: rows[0].op as 'put',
      key: rows[0].key,
      ts: rows[0].ts,
      row: rows[0].row,
    } as OutboxRow);
    expect(op.type).toBe('put');
    expect(op.table).toBe('coord-conversations');
    expect(op.hbKey).toBe('conv-1');
    const value = (op as { value: CoordConversationRow }).value;
    expect(value.id).toBe('conv-1');
    expect(value.kind).toBe('question');
    expect(value.scope).toBe('harness');
    expect(value.state).toBe('resolved');
    expect(value.accepted_answer).toBe('because Y');
    expect(typeof value.created_at).toBe('number');
    expect(value.created_at).toBeGreaterThan(0);
    expect(typeof value.resolved_at).toBe('number');
  });

  it('a DELETE of a harness-scoped row enqueues a del op', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`DELETE FROM harness_shared.coord_conversations WHERE workspace_id = ${WS} AND id = 'conv-1'`;
    const rows = await db.sql<OutboxDbRow[]>`
      SELECT op, key, table_name FROM harness_shared.substrate_outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('del');
    expect(rows[0].key).toBe('conv-1');
    expect(rows[0].table_name).toBe('coord_conversations');
  });

  it("projection writeToPg upserts a remote row (origin='remote', accepted_post_id NULL) and deleteFromPg removes it", async () => {
    const proj = buildCoordConversationProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    const remote: CoordConversationRow = {
      harness_slug: HARNESS,
      id: 'conv-from-peer',
      kind: 'question',
      scope: 'harness',
      asker_id: 'peer-user',
      title: 'remote Q',
      body: 'asked on another machine',
      state: 'open',
      accepted_answer: null,
      capture_target: null,
      promoted_issue_id: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      resolved_at: null,
    };
    await proj.writeToPg(remote, { authorPubkey: 'peerPubkeyAAA', origin: 'remote' });

    const [row] = await db.sql<
      { origin: string; author_pubkey: string | null; accepted_post_id: number | null; state: string; created_at: Date }[]
    >`SELECT origin, author_pubkey, accepted_post_id, state, created_at
        FROM harness_shared.coord_conversations WHERE workspace_id = ${WS} AND id = 'conv-from-peer'`;
    expect(row.origin).toBe('remote');
    expect(row.author_pubkey).toBe('peerPubkeyAAA');
    expect(row.accepted_post_id).toBeNull();
    expect(row.state).toBe('open');

    // Upsert (LWW) — a later state update applies on conflict.
    await proj.writeToPg({ ...remote, state: 'resolved', accepted_answer: 'ans' }, { authorPubkey: 'peerPubkeyAAA', origin: 'remote' });
    const [updated] = await db.sql<{ state: string; accepted_answer: string | null }[]>`
      SELECT state, accepted_answer FROM harness_shared.coord_conversations WHERE workspace_id = ${WS} AND id = 'conv-from-peer'`;
    expect(updated.state).toBe('resolved');
    expect(updated.accepted_answer).toBe('ans');

    await proj.deleteFromPg('conv-from-peer');
    const remaining = await db.sql`SELECT 1 FROM harness_shared.coord_conversations WHERE workspace_id = ${WS} AND id = 'conv-from-peer'`;
    expect(remaining).toHaveLength(0);
  });

  it('two-peer convergence: a conversation written on A lands on B (origin=remote) via the real reshape→decode→project chain', async () => {
    // Peer B: a SEPARATE database with the post-144 coord_conversations shape.
    // (The Hyperswarm transport between A's outbox-drain and B's merge is proven
    // table-agnostic by feature-content-federation.integration.test.ts — this
    // test exercises the conversation-SPECIFIC links the swarm carries opaquely:
    // A's trigger → outbox → outboxRowToLocalWriteOp → decodeValue → B's writeToPg.)
    const dbB = await createFreshPgDb('coord_conv_fed_b');
    try {
      await dbB.sql.unsafe(`
        CREATE TABLE harness_shared.coord_conversations (
          workspace_id text DEFAULT 'default' NOT NULL, id text NOT NULL,
          kind text NOT NULL, scope text DEFAULT 'operator' NOT NULL, harness_slug text,
          asker_id text NOT NULL, title text, body text DEFAULT '' NOT NULL,
          state text DEFAULT 'open' NOT NULL, accepted_answer text, accepted_post_id bigint,
          capture_target text, promoted_issue_id text,
          created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
          resolved_at timestamptz, origin text NOT NULL DEFAULT 'local', author_pubkey text,
          fed_ts bigint, -- EI-79 step 2 (mig 181): PG-level LWW guard column
          fed_hlc text,  -- D-001 (mig 314): the HLC ordering key the guard compares
          CONSTRAINT coord_conversations_pkey PRIMARY KEY (workspace_id, id),
          CONSTRAINT coord_conversations_kind_check  CHECK (kind  = ANY (ARRAY['question','discussion'])),
          CONSTRAINT coord_conversations_scope_check CHECK (scope = ANY (ARRAY['operator','harness'])),
          CONSTRAINT coord_conversations_state_check CHECK (state = ANY (ARRAY['open','resolved','closed'])),
          CONSTRAINT coord_conversations_scope_slug_check CHECK (
              (scope = 'harness' AND harness_slug IS NOT NULL AND harness_slug <> '')
           OR (scope = 'operator' AND harness_slug IS NULL))
        );
      `);
      const projB = buildCoordConversationProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: dbB.sql });

      // The op-apply step a peer performs for each merged op: decode then write.
      async function applyOnB(outboxRow: { table_name: string; op: string; key: string; ts: number; row: Record<string, unknown> | null }) {
        const op = outboxRowToLocalWriteOp(outboxRow as OutboxRow);
        if (op.type === 'del') {
          await projB.deleteFromPg(op.hbKey);
          return;
        }
        const decoded = projB.decodeValue((op as { value: unknown }).value);
        expect(decoded, 'reshaped conversation value must satisfy the projection decoder').not.toBeNull();
        await projB.writeToPg(decoded!, { authorPubkey: 'peerA-pubkey', origin: 'remote' });
      }

      async function latestOutbox() {
        await db.sql`DELETE FROM harness_shared.substrate_outbox`;
        return null;
      }
      async function readOutbox() {
        const rows = await db.sql<OutboxDbRow[]>`
          SELECT table_name, op, key, row, ts FROM harness_shared.substrate_outbox ORDER BY id`;
        return rows;
      }

      // 1. CREATE on A → converges to B with origin='remote'.
      await latestOutbox();
      await db.sql`
        INSERT INTO harness_shared.coord_conversations
          (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, state)
        VALUES (${WS}, 'conv-conv', 'question', 'harness', ${HARNESS}, 'su-A', 'cross-machine Q', 'asked on A', 'open')`;
      for (const r of await readOutbox()) await applyOnB(r);
      const [onB] = await dbB.sql<{ title: string; state: string; origin: string; harness_slug: string }[]>`
        SELECT title, state, origin, harness_slug FROM harness_shared.coord_conversations WHERE id = 'conv-conv'`;
      expect(onB.title).toBe('cross-machine Q');
      expect(onB.state).toBe('open');
      expect(onB.origin).toBe('remote');
      expect(onB.harness_slug).toBe(HARNESS);

      // 2. UPDATE on A (resolve) → B converges to the new state.
      await latestOutbox();
      await db.sql`UPDATE harness_shared.coord_conversations
        SET state='resolved', accepted_answer='answered on A', resolved_at=now()
        WHERE workspace_id=${WS} AND id='conv-conv'`;
      for (const r of await readOutbox()) await applyOnB(r);
      const [onB2] = await dbB.sql<{ state: string; accepted_answer: string | null }[]>`
        SELECT state, accepted_answer FROM harness_shared.coord_conversations WHERE id = 'conv-conv'`;
      expect(onB2.state).toBe('resolved');
      expect(onB2.accepted_answer).toBe('answered on A');

      // 3. DELETE on A → B converges to absent.
      await latestOutbox();
      await db.sql`DELETE FROM harness_shared.coord_conversations WHERE workspace_id=${WS} AND id='conv-conv'`;
      for (const r of await readOutbox()) await applyOnB(r);
      const gone = await dbB.sql`SELECT 1 FROM harness_shared.coord_conversations WHERE id = 'conv-conv'`;
      expect(gone).toHaveLength(0);
    } finally {
      await dbB.cleanup();
    }
  });
});
