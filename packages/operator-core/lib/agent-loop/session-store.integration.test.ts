/**
 * session-store.integration.test.ts — the loop session store against a REAL
 * fully-migrated Postgres (migration 936).
 *
 * Sibling of approval-store.integration.test.ts (same table family, same
 * rationale): the properties this store exists for — upsert accumulation of
 * totals across turns, replace semantics on the working set, honest
 * unpriced-turn counting — live in the SQL, invisible to a mocked-sql unit
 * test BY CONSTRUCTION.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { ModelMessage } from './model-port';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const {
  clampMessagesForStore,
  loadLoopSession,
  saveLoopSessionTurn,
  STORE_RESULT_MAX_CHARS,
} = await import('./session-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_loop_sessions`;
});

const KEY = { chatId: 'chat-int', workspaceId: 'ws-int' };

const MESSAGES: ModelMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'q1' }] },
  {
    role: 'assistant',
    content: [{ type: 'tool_call', id: 'c1', name: 'do_thing', input: { x: 1 } }],
  },
  { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: { ok: true } }] },
  { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
];

const save = (over: Partial<Parameters<typeof saveLoopSessionTurn>[0]> = {}) =>
  saveLoopSessionTurn({
    ...KEY,
    messages: MESSAGES,
    summary: null,
    compactedCount: 0,
    transcriptTurns: 2,
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, costUsd: 0.001 },
    priced: true,
    ...over,
  });

describe('agent_loop_sessions store (real PG)', () => {
  it('load of a missing row is null', async () => {
    expect(await loadLoopSession(KEY)).toBeNull();
  });

  it('first save inserts; load round-trips messages, anchor, model and totals', async () => {
    await save({ summary: 'S1', compactedCount: 2 });
    const row = await loadLoopSession(KEY);
    expect(row).not.toBeNull();
    expect(row!.messages).toEqual(MESSAGES);
    expect(row!.summary).toBe('S1');
    expect(row!.compactedCount).toBe(2);
    expect(row!.transcriptTurns).toBe(2);
    expect(row!.model).toBe('claude-sonnet-4-6');
    expect(row!.turnCount).toBe(1);
    expect(row!.totals).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      costUsd: 0.001,
      unpricedTurns: 0,
    });
  });

  it('second save REPLACES the working set + anchor and ACCUMULATES totals', async () => {
    await save();
    const nextMessages: ModelMessage[] = [
      ...MESSAGES,
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ];
    await save({
      messages: nextMessages,
      transcriptTurns: 4,
      usage: { inputTokens: 50, outputTokens: 20, costUsd: 0.0005 },
    });
    const row = await loadLoopSession(KEY);
    expect(row!.messages).toEqual(nextMessages);
    expect(row!.transcriptTurns).toBe(4);
    expect(row!.turnCount).toBe(2);
    expect(row!.totals.inputTokens).toBe(150);
    expect(row!.totals.outputTokens).toBe(60);
    expect(row!.totals.cacheReadTokens).toBe(10);
    expect(row!.totals.costUsd).toBeCloseTo(0.0015, 9);
    expect(row!.totals.unpricedTurns).toBe(0);
  });

  it('an unpriced turn counts instead of fabricating $0 into the total', async () => {
    await save();
    await save({
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 123 }, // costUsd IGNORED when priced:false
      priced: false,
    });
    const row = await loadLoopSession(KEY);
    expect(row!.totals.costUsd).toBeCloseTo(0.001, 9); // first turn only
    expect(row!.totals.unpricedTurns).toBe(1);
    expect(row!.totals.inputTokens).toBe(110);
  });

  it('stores oversized tool_result payloads clamped (and clampMessagesForStore is pure)', async () => {
    const big = 'z'.repeat(STORE_RESULT_MAX_CHARS + 500);
    const monster: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: big }] },
    ];
    // Pure clamp: original untouched, clamped copy marked.
    const clamped = clampMessagesForStore(monster);
    expect((monster[1].content[0] as { content: unknown }).content).toBe(big);
    const clampedPart = clamped[1].content[0] as {
      content: { truncated: boolean; fullChars: number; preview: string };
    };
    expect(clampedPart.content.truncated).toBe(true);

    await save({ messages: monster, transcriptTurns: 1 });
    const row = await loadLoopSession(KEY);
    const storedPart = row!.messages[1].content[0] as {
      content: { truncated?: boolean; preview?: string };
    };
    expect(storedPart.content.truncated).toBe(true);
    expect((storedPart.content.preview ?? '').length).toBe(STORE_RESULT_MAX_CHARS);
  });
});
