/**
 * P-002 integration proof: the voice router's owner-continuity dependency is
 * the production operator-conversations store, exercised against real
 * Postgres. Unit fakes can prove which dependency is called; this suite proves
 * that repeated local and Phone turns resolve the same persisted active row.
 */
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTestPg } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const WORKSPACE_ID = 'ws-voice-router-integration';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql, db: h.db }),
  };
});

const { getOrCreateActiveConversation } = await import('./operator-conversations');
const { createVoiceTurnRouter } = await import('./voice-turn-router');

const owner = {
  kind: 'owner',
  subjectId: 'owner-1',
  authenticated: true,
  authoritySource: 'owner-session',
} as const;

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `voice_router_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  rootSql = postgres(url.toString(), { max: 4, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_conversations (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      workspace_id text DEFAULT '' NOT NULL,
      harness_slug text,
      subject_kind text DEFAULT 'global' NOT NULL,
      subject_ref text,
      title text,
      status text DEFAULT 'active' NOT NULL,
      started_at bigint NOT NULL,
      ended_at bigint,
      el_conversation_ids text[] DEFAULT '{}' NOT NULL,
      has_audio boolean DEFAULT false NOT NULL
    );
  `);
  await rootSql.unsafe(
    readFileSync(resolve(SQL_DIR, '168-operator-conversation-summary.sql'), 'utf8'),
  );
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('voice-turn router owner continuity (real operator-conversation store)', () => {
  it('links local and Phone owner turns to one persisted active operator conversation', async () => {
    const getOrCreateCallConversation = vi.fn(async ({ callSessionId }: { callSessionId: string }) => ({
      id: `call:${callSessionId}`,
    }));
    const route = createVoiceTurnRouter({
      getOrCreateActiveOperatorConversation: getOrCreateActiveConversation,
      getOrCreateCallConversation,
      resolveOwnerTools: async () => ['calendar:list'],
    });
    const common = {
      workspaceId: WORKSPACE_ID,
      turnId: 'turn-local',
      sequence: 0,
      occurredAt: '2026-08-31T16:00:00.000Z',
      transport: 'papercup-local' as const,
      latencyClass: 'deliberative' as const,
      transcript: 'Continue our conversation.',
      resolvedPrincipal: owner,
    };

    const local = await route(common);
    const persisted = await getOrCreateActiveConversation(WORKSPACE_ID);
    const phone = await route({
      ...common,
      turnId: 'turn-phone',
      sequence: 1,
      transport: 'phone-livekit',
      latencyClass: 'interactive',
      transcript: 'Continue by phone.',
      callSessionId: 'room-owner',
    });

    expect(local.turn.conversation).toEqual({
      kind: 'operator',
      id: persisted.id,
      parentOperatorConversationId: null,
    });
    expect(phone.turn.conversation).toEqual({
      kind: 'phone-call',
      id: 'call:room-owner',
      parentOperatorConversationId: persisted.id,
    });
    expect(getOrCreateCallConversation).toHaveBeenCalledOnce();

    const rows = await rootSql<{ id: string }[]>`
      SELECT id
        FROM harness_shared.operator_conversations
       WHERE workspace_id = ${WORKSPACE_ID}
         AND subject_kind = 'global'
         AND subject_ref IS NULL
         AND status = 'active'`;
    expect(rows).toEqual([{ id: persisted.id }]);
  });
});
