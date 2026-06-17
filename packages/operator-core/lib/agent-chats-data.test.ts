/**
 * Coverage for agent-chats-data pure helpers: isValidChatRole (rejects
 * 'feedback', otherwise gated on the known-roles registry) and rowToChat (the
 * PG-row → ChatRow mapping with transcript JSON-parse vs passthrough, bigint→
 * Number token/cost coercion, bigint epoch-ms → ISO timestamp coercion
 * (migration 116), null defaults). known-roles is mocked.
 *
 * Plus listChats LIMIT/OFFSET bounding + column projection (F-C1): the query
 * is always bounded — default 100, clamped to 1..100, offset for paging — AND
 * projects only the needed columns (NO `SELECT *`, no `transcript` jsonb body;
 * just `jsonb_array_length(...) AS turn_count`) so the forever-growing
 * agent_chats table can't be SELECT *'d in full and a 100-row page doesn't drag
 * every transcript body over the wire. db-org is mocked to capture the SQL +
 * bound args; rowToChatSummary maps the projected row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./known-roles', () => ({
  getKnownRoles: () => ['worker', 'scoper', 'validator', 'orchestrator'],
}));

// Capture the SQL + bound args that listChats hands to the legacy client.
const allMock = vi.fn(async () => [] as Array<Record<string, unknown>>);
let lastSql = '';
vi.mock('@papercusp/db-org', () => ({
  getLegacyClient: () => ({
    prepare: (sql: string) => {
      lastSql = sql;
      return { all: allMock };
    },
  }),
}));

import {
  isValidChatRole,
  rowToChat,
  rowToChatSummary,
  listChats,
  LIST_CHATS_DEFAULT_LIMIT,
} from './agent-chats-data';

describe('isValidChatRole', () => {
  it('accepts a known role', () => {
    expect(isValidChatRole('worker')).toBe(true);
  });
  it("rejects 'feedback' explicitly", () => {
    expect(isValidChatRole('feedback')).toBe(false);
  });
  it('rejects an unknown role', () => {
    expect(isValidChatRole('nonexistent')).toBe(false);
  });
});

describe('rowToChat', () => {
  it('parses a string transcript + coerces bigint totals', () => {
    const c = rowToChat({
      id: 'c1',
      role: 'worker',
      feature_id: 'F-1',
      title: 'Chat',
      transcript: JSON.stringify([{ role: 'user', text: 'hi' }]),
      total_input_tokens: 100n,
      total_output_tokens: 50n,
      total_cost_usd_cents: 7n,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    });
    expect(c.transcript).toEqual([{ role: 'user', text: 'hi' }]);
    expect(c.total_input_tokens).toBe(100);
    expect(c.total_output_tokens).toBe(50);
    expect(c.total_cost_usd_cents).toBe(7);
    expect(c.archived_at).toBeNull();
  });

  it('coerces bigint/number/string epoch-ms timestamps to ISO (migration 116)', () => {
    const ms = 1_700_000_000_000;
    const iso = new Date(ms).toISOString();
    // bigint (postgres-js int8), number, and numeric-string all coerce.
    expect(rowToChat({ id: 'c', role: 'worker', created_at: BigInt(ms), updated_at: ms }).created_at).toBe(iso);
    expect(rowToChat({ id: 'c', role: 'worker', created_at: ms, updated_at: String(ms) }).updated_at).toBe(iso);
    // archived_at: null stays null, a value coerces to ISO.
    expect(rowToChat({ id: 'c', role: 'worker', created_at: ms, updated_at: ms }).archived_at).toBeNull();
    expect(rowToChat({ id: 'c', role: 'worker', created_at: ms, updated_at: ms, archived_at: ms }).archived_at).toBe(iso);
  });

  it('passes an array transcript through + defaults missing fields', () => {
    const c = rowToChat({ id: 'c2', role: 'scoper', transcript: [{ role: 'a', text: 'b' }], created_at: 'c', updated_at: 'u' });
    expect(c.transcript).toEqual([{ role: 'a', text: 'b' }]);
    expect(c.feature_id).toBeNull();
    expect(c.title).toBeNull();
    expect(c.total_input_tokens).toBe(0);
    expect(c.total_cost_usd_cents).toBe(0);
  });

  it('defaults an absent transcript to []', () => {
    const c = rowToChat({ id: 'c3', role: 'worker', created_at: 'c', updated_at: 'u' });
    expect(c.transcript).toEqual([]);
  });
});

describe('rowToChatSummary', () => {
  it('coerces bigint/number turn_count + totals and never carries a transcript', () => {
    const s = rowToChatSummary({
      id: 'c1',
      role: 'worker',
      feature_id: 'F-1',
      title: 'Chat',
      turn_count: 12n,
      total_input_tokens: 100,
      total_output_tokens: 50n,
      total_cost_usd_cents: 7n,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      archived_at: null,
    });
    expect(s.turn_count).toBe(12);
    expect(s.total_input_tokens).toBe(100);
    expect(s.total_output_tokens).toBe(50);
    expect(s).not.toHaveProperty('transcript');
    expect(s.created_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(s.archived_at).toBeNull();
  });

  it('defaults a missing turn_count to 0', () => {
    const s = rowToChatSummary({ id: 'c2', role: 'scoper', created_at: 'c', updated_at: 'u' });
    expect(s.turn_count).toBe(0);
    expect(s.feature_id).toBeNull();
    expect(s.title).toBeNull();
  });
});

describe('listChats — bounded query (F-C1)', () => {
  afterEach(() => {
    allMock.mockClear();
    allMock.mockResolvedValue([]);
  });

  it('always applies a LIMIT + OFFSET (default 100, offset 0)', async () => {
    const r = await listChats({ slug: 'foo' });
    expect(r.ok).toBe(true);
    expect(lastSql).toContain('LIMIT ? OFFSET ?');
    expect(lastSql).toContain('WHERE archived_at IS NULL'); // active-only by default
    expect(allMock).toHaveBeenCalledWith(LIST_CHATS_DEFAULT_LIMIT, 0);
  });

  it('projects columns (no SELECT *, no transcript body — turn_count instead)', async () => {
    await listChats({ slug: 'foo' });
    expect(lastSql).not.toContain('SELECT *');
    // the heavy jsonb body is replaced by its length
    expect(lastSql).toContain('jsonb_array_length');
    expect(lastSql).toContain('AS turn_count');
    // `transcript` is referenced exactly ONCE — inside the length expression,
    // never selected as a bare body column.
    expect((lastSql.match(/transcript/g) ?? []).length).toBe(1);
    expect(lastSql).toContain('COALESCE(transcript');
  });

  it('maps projected rows via rowToChatSummary (turn_count, no transcript field)', async () => {
    allMock.mockResolvedValueOnce([
      {
        id: 'c1',
        role: 'worker',
        feature_id: 'F-1',
        title: 'Chat',
        turn_count: 4n,
        total_input_tokens: 10n,
        total_output_tokens: 5n,
        total_cost_usd_cents: 2n,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        archived_at: null,
      },
    ]);
    const r = await listChats({ slug: 'foo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [chat] = r.data.chats;
    expect(chat.turn_count).toBe(4);
    expect(chat).not.toHaveProperty('transcript');
    expect(chat.total_input_tokens).toBe(10);
  });

  it('clamps limit above 100 down to 100', async () => {
    await listChats({ slug: 'foo', limit: 5000 });
    expect(allMock).toHaveBeenCalledWith(100, 0);
  });

  it('clamps limit at/below 0 up to 1', async () => {
    await listChats({ slug: 'foo', limit: 0 });
    expect(allMock).toHaveBeenCalledWith(1, 0);
    allMock.mockClear();
    await listChats({ slug: 'foo', limit: -10 });
    expect(allMock).toHaveBeenCalledWith(1, 0);
  });

  it('threads a custom limit + offset (keyset paging)', async () => {
    await listChats({ slug: 'foo', limit: 25, offset: 50 });
    expect(allMock).toHaveBeenCalledWith(25, 50);
  });

  it('floors a negative offset to 0 and truncates fractional values', async () => {
    await listChats({ slug: 'foo', limit: 10.9, offset: -3 });
    expect(allMock).toHaveBeenCalledWith(10, 0);
  });

  it('includeArchived drops the archived_at filter but stays bounded', async () => {
    await listChats({ slug: 'foo', includeArchived: true, limit: 30 });
    expect(lastSql).toContain('LIMIT ? OFFSET ?');
    expect(lastSql).not.toContain('WHERE archived_at IS NULL');
    expect(allMock).toHaveBeenCalledWith(30, 0);
  });
});
