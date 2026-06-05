/**
 * conversations-store.ts — the PG store for `coord_conversations` (migration
 * 132), the conversation/question domain object's OWN scalars. Mirrors the
 * @papercusp/coordination capability-store shape (getSql / ensureSchema /
 * workspaceId) so it composes with PgThreadStore / PgTaggableStore /
 * PgEntitySubscriptionStore over the same handle + workspace.
 *
 * The conversation rides the substrate for everything shared (thread, tags,
 * subscriptions); this store is ONLY the conversation row (kind, asker, seed
 * text, Lifecycle state, the accepted answer). Lifecycle is interface-only in
 * the substrate — the `state` column here is that scalar.
 *
 * `ensureConversationsTable` mirrors migration 132 so the package's own vitest
 * rig can stand the schema up standalone; the operator passes a no-op
 * ensureSchema (schema is migrations-only — repo storage policy).
 */

import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

export type ConversationKind = 'question' | 'discussion';
export type ConversationScope = 'operator' | 'harness';
export type ConversationState = 'open' | 'resolved' | 'closed';

export const CONVERSATION_KINDS: readonly ConversationKind[] = ['question', 'discussion'];

export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  scope: ConversationScope;
  harness_slug: string | null;
  asker_id: string;
  title: string | null;
  body: string;
  state: ConversationState;
  accepted_answer: string | null;
  accepted_post_id: number | null;
  capture_target: string | null;
  promoted_issue_id: string | null;
  /** ISO-8601. */
  created_ts: string;
  updated_ts: string;
  resolved_ts: string | null;
}

export interface CreateConversationInput {
  id: string;
  kind: ConversationKind;
  scope: ConversationScope;
  harness_slug?: string | null;
  asker_id: string;
  title?: string | null;
  body: string;
  /** ISO-8601 create time (host clock). */
  created_ts: string;
}

export interface ListConversationsOpts {
  kind?: ConversationKind;
  scope?: ConversationScope;
  harness_slug?: string;
  state?: ConversationState;
  limit?: number;
}

export interface ConversationStoreOptions {
  /** The org Postgres handle (postgres-js tagged template). Called per use. */
  getSql: () => Sql;
  /** Ensure coord_conversations exists before first use (no-op in the operator;
   *  ensureConversationsTable on the package test rig). */
  ensureSchema: () => Promise<void>;
  /** Coordination scope (parity with the capability stores). Default 'default'. */
  workspaceId?: string;
}

function tsToIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(v as string).toISOString();
}
function tsToIsoOrNull(v: unknown): string | null {
  return v == null ? null : tsToIso(v);
}

interface ConversationRowDb {
  id: string;
  kind: ConversationKind;
  scope: ConversationScope;
  harness_slug: string | null;
  asker_id: string;
  title: string | null;
  body: string;
  state: ConversationState;
  accepted_answer: string | null;
  accepted_post_id: string | number | null;
  capture_target: string | null;
  promoted_issue_id: string | null;
  created_at: unknown;
  updated_at: unknown;
  resolved_at: unknown;
}

function toRow(r: ConversationRowDb): ConversationRow {
  return {
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    harness_slug: r.harness_slug,
    asker_id: r.asker_id,
    title: r.title,
    body: r.body,
    state: r.state,
    accepted_answer: r.accepted_answer,
    accepted_post_id: r.accepted_post_id == null ? null : Number(r.accepted_post_id),
    capture_target: r.capture_target,
    promoted_issue_id: r.promoted_issue_id,
    created_ts: tsToIso(r.created_at),
    updated_ts: tsToIso(r.updated_at),
    resolved_ts: tsToIsoOrNull(r.resolved_at),
  };
}

const SELECT_COLS = `id, kind, scope, harness_slug, asker_id, title, body, state,
  accepted_answer, accepted_post_id, capture_target, promoted_issue_id, created_at, updated_at, resolved_at`;

export class PgConversationStore {
  private readonly ws: string;
  constructor(private readonly opts: ConversationStoreOptions) {
    this.ws = opts.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  }

  async create(input: CreateConversationInput): Promise<ConversationRow> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, created_at, updated_at)
      VALUES (${this.ws}, ${input.id}, ${input.kind}, ${input.scope}, ${input.harness_slug ?? null},
              ${input.asker_id}, ${input.title ?? null}, ${input.body}, ${input.created_ts}, ${input.created_ts})
      ON CONFLICT (workspace_id, id) DO NOTHING`;
    const row = await this.get(input.id);
    if (!row) throw new Error(`coord_conversations: failed to read back conversation ${input.id}`);
    return row;
  }

  async get(id: string): Promise<ConversationRow | null> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const rows = await sql<ConversationRowDb[]>`
      SELECT ${sql.unsafe(SELECT_COLS)}
        FROM harness_shared.coord_conversations
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(opts: ListConversationsOpts = {}): Promise<ConversationRow[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await sql<ConversationRowDb[]>`
      SELECT ${sql.unsafe(SELECT_COLS)}
        FROM harness_shared.coord_conversations
       WHERE workspace_id = ${this.ws}
         AND ${opts.kind ? sql`kind = ${opts.kind}` : sql`TRUE`}
         AND ${opts.scope ? sql`scope = ${opts.scope}` : sql`TRUE`}
         AND ${opts.harness_slug ? sql`harness_slug = ${opts.harness_slug}` : sql`TRUE`}
         AND ${opts.state ? sql`state = ${opts.state}` : sql`TRUE`}
       ORDER BY created_at DESC
       LIMIT ${limit}`;
    return rows.map(toRow);
  }

  /** Update the Lifecycle state (and resolved_at when resolving). */
  async setState(id: string, state: ConversationState, opts: { now_ts: string } = { now_ts: new Date().toISOString() }): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      UPDATE harness_shared.coord_conversations
         SET state = ${state},
             updated_at = ${opts.now_ts},
             resolved_at = ${state === 'resolved' ? opts.now_ts : null}
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
  }

  /** Record the accepted answer + where it was captured (D-004). */
  async setAcceptedAnswer(
    id: string,
    input: { answer: string; post_id?: number | null; capture_target?: string | null; now_ts: string },
  ): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      UPDATE harness_shared.coord_conversations
         SET accepted_answer = ${input.answer},
             accepted_post_id = ${input.post_id ?? null},
             capture_target = ${input.capture_target ?? null},
             updated_at = ${input.now_ts}
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
  }

  /** Mark the conversation promoted to an engineer issue (D-005): record the
   *  issue id + close the conversation (the discussion continues on the issue). */
  async setPromoted(id: string, input: { issue_id: string; now_ts: string }): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      UPDATE harness_shared.coord_conversations
         SET promoted_issue_id = ${input.issue_id},
             state = 'closed',
             updated_at = ${input.now_ts}
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
  }

  /** Bump updated_at on activity (a new reply/answer). */
  async touch(id: string, now_ts: string): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      UPDATE harness_shared.coord_conversations
         SET updated_at = ${now_ts}
       WHERE workspace_id = ${this.ws} AND id = ${id}`;
  }
}

/**
 * Re-parent a Threadable thread from one object to another (D-005 promote) and
 * RE-KEY it (thread + its posts) to the destination's thread_id, in one tx so
 * the posts follow. Re-keying (not just moving the parent) is required because
 * the destination domain's lazy getOrCreateThread does INSERT … ON CONFLICT
 * (thread_id) DO NOTHING then read-by-parent — if we moved the parent but kept
 * the old thread_id, that lazy create would INSERT a 2nd thread for the same
 * parent and trip the (parent_kind,parent_ref) UNIQUE index. Re-keying to the
 * destination's own thread_id makes that lazy create a clean no-op. No-op if
 * `from` has no thread.
 *
 * `newThreadId` MUST equal the destination domain's thread_id convention
 * (engineer_issues: `issue-thread-<EI-id>`). This is a localized substrate
 * operation pending a first-class ThreadableStore.reparent() capability +
 * parent-first getOrCreateThread (flagged to the substrate owner) — which would
 * remove the thread_id coupling entirely.
 */
export async function reparentThread(
  sql: Sql,
  ws: string,
  from: { kind: string; ref: string },
  to: { kind: string; ref: string },
  newThreadId: string,
): Promise<{ reparented: boolean; thread_id?: string }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ thread_id: string }[]>`
      SELECT thread_id FROM harness_shared.coord_threads
       WHERE workspace_id = ${ws} AND parent_kind = ${from.kind} AND parent_ref = ${from.ref}`;
    const old = rows[0]?.thread_id;
    if (!old) return { reparented: false };
    await tx`
      UPDATE harness_shared.coord_thread_posts
         SET thread_id = ${newThreadId}
       WHERE workspace_id = ${ws} AND thread_id = ${old}`;
    await tx`
      UPDATE harness_shared.coord_threads
         SET thread_id = ${newThreadId}, parent_kind = ${to.kind}, parent_ref = ${to.ref}
       WHERE workspace_id = ${ws} AND thread_id = ${old}`;
    return { reparented: true, thread_id: newThreadId };
  }) as Promise<{ reparented: boolean; thread_id?: string }>;
}

/** Create coord_conversations + its indexes if absent. Idempotent. Mirrors
 *  libs/papercusp/libs/db/sql/132-coordination-conversations.sql (for the
 *  package/integration test rig — the operator uses the migration). */
export async function ensureConversationsTable(sql: Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_conversations (
      workspace_id     text NOT NULL DEFAULT 'default',
      id               text NOT NULL,
      kind             text NOT NULL,
      scope            text NOT NULL DEFAULT 'operator',
      harness_slug     text,
      asker_id         text NOT NULL,
      title            text,
      body             text NOT NULL DEFAULT '',
      state            text NOT NULL DEFAULT 'open',
      accepted_answer  text,
      accepted_post_id bigint,
      capture_target   text,
      promoted_issue_id text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      resolved_at      timestamptz,
      PRIMARY KEY (workspace_id, id),
      CONSTRAINT coord_conversations_kind_check  CHECK (kind  = ANY (ARRAY['question','discussion'])),
      CONSTRAINT coord_conversations_scope_check CHECK (scope = ANY (ARRAY['operator','harness'])),
      CONSTRAINT coord_conversations_state_check CHECK (state = ANY (ARRAY['open','resolved','closed'])),
      CONSTRAINT coord_conversations_scope_slug_check CHECK (
          (scope = 'harness'  AND harness_slug IS NOT NULL AND harness_slug <> '')
       OR (scope = 'operator' AND harness_slug IS NULL)
      )
    )`;
  await sql`
    CREATE INDEX IF NOT EXISTS coord_conversations_open_idx
      ON harness_shared.coord_conversations (workspace_id, kind, created_at DESC)
      WHERE state = 'open'`;
  await sql`
    CREATE INDEX IF NOT EXISTS coord_conversations_scope_idx
      ON harness_shared.coord_conversations (workspace_id, scope, harness_slug, created_at DESC)`;
}
