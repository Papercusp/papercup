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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./known-roles', () => ({
  getKnownRoles: () => ['worker', 'scoper', 'validator', 'orchestrator'],
}));

// Capture the SQL + bound args that the data layer hands to the legacy client.
// The same fake client backs listChats (.all), getChat/createChat (.get +
// .run) and archiveChat (.run) — every prepare() records its SQL + bound
// args so a test can assert exactly which statements ran (and which DIDN'T).
const allMock = vi.fn(async () => [] as Array<Record<string, unknown>>);
const getMock = vi.fn(async () => undefined as Record<string, unknown> | undefined);
const runMock = vi.fn(async () => undefined);
let lastSql = '';
/** Every (sql, boundArgs) pair prepared+executed, in order. */
const calls: Array<{ sql: string; args: unknown[] }> = [];
vi.mock('@papercusp/db-org', () => ({
  getLegacyClient: () => ({
    prepare: (sql: string) => {
      lastSql = sql;
      return {
        all: (...args: unknown[]) => {
          calls.push({ sql, args });
          return allMock(...(args as []));
        },
        get: (...args: unknown[]) => {
          calls.push({ sql, args });
          return getMock(...(args as []));
        },
        run: (...args: unknown[]) => {
          calls.push({ sql, args });
          return runMock(...(args as []));
        },
      };
    },
  }),
}));

import {
  isValidChatRole,
  rowToChat,
  rowToChatSummary,
  listChats,
  getChat,
  createChat,
  archiveChat,
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

// ── write/read paths against the fake legacy client ────────────────────────
// These exercise the SQL each fn issues + the result envelope. The shared
// `calls[]` log lets us assert exactly which statements ran — crucial for AC2,
// where the dead `pre` SELECT must NOT run.

beforeEach(() => {
  calls.length = 0;
  allMock.mockReset();
  allMock.mockResolvedValue([]);
  getMock.mockReset();
  getMock.mockResolvedValue(undefined);
  runMock.mockReset();
  runMock.mockResolvedValue(undefined);
});

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  role: 'worker',
  feature_id: null,
  title: 'Chat',
  transcript: '[]',
  total_input_tokens: 0n,
  total_output_tokens: 0n,
  total_cost_usd_cents: 0n,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  archived_at: null,
  ...over,
});

describe('getChat', () => {
  it('404s when the row is absent', async () => {
    getMock.mockResolvedValueOnce(undefined);
    const r = await getChat({ slug: 'foo', chatId: 'missing' });
    expect(r).toEqual({ ok: false, status: 404, error: 'chat not found' });
    // only the chat SELECT ran — no feature-lock probe for a missing chat
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('SELECT * FROM agent_chats WHERE id = ?');
    expect(calls[0].args).toEqual(['missing']);
  });

  it('returns the mapped chat with feature_lock=null when no feature_id', async () => {
    getMock.mockResolvedValueOnce(ROW({ feature_id: null }));
    const r = await getChat({ slug: 'foo', chatId: 'c1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe('c1');
    expect(r.data.feature_lock).toBeNull();
    // no harness_features probe when feature_id is null
    expect(calls.some((c) => /harness_features/.test(c.sql))).toBe(false);
  });

  it('reads feature-lock state when the chat carries a feature_id', async () => {
    getMock
      // 1st .get → the chat row (feature-locked)
      .mockResolvedValueOnce(ROW({ feature_id: 'F-7' }))
      // 2nd .get → readFeatureLockState's harness_features row
      .mockResolvedValueOnce({ taken_by: 'worker-3', taken_at: 't', expires_at: null });
    const r = await getChat({ slug: 'foo', chatId: 'c1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.feature_lock).toEqual({
      taken_by: 'worker-3',
      taken_at: 't',
      expires_at: null,
      active: true,
    });
    // the lock probe queried harness_features by (slug, feature_id)
    const probe = calls.find((c) => /harness_features/.test(c.sql));
    expect(probe).toBeDefined();
    expect(probe?.args).toEqual(['foo', 'F-7']);
  });

  it('wraps a thrown error as a 500 envelope', async () => {
    getMock.mockRejectedValueOnce(new Error('pg exploded'));
    const r = await getChat({ slug: 'foo', chatId: 'c1' });
    expect(r).toEqual({ ok: false, status: 500, error: 'failed to load chat: pg exploded' });
  });
});

describe('createChat', () => {
  it('rejects an unknown role before touching the db', async () => {
    const r = await createChat({ slug: 'foo', role: 'bogus' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/role must be one of/);
    expect(calls).toHaveLength(0); // never reached the db
  });

  it('rejects a malformed feature_id before touching the db', async () => {
    const r = await createChat({ slug: 'foo', role: 'worker', feature_id: 'not a feature' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/invalid feature_id/);
    expect(calls).toHaveLength(0);
  });

  it('inserts then re-selects the row; defaults title to role when no feature', async () => {
    getMock.mockResolvedValueOnce(ROW({ role: 'worker', title: 'worker', feature_id: null }));
    const r = await createChat({ slug: 'foo', role: 'worker' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.feature_lock).toBeNull();
    // one INSERT + one SELECT, no harness_features probe
    const insert = calls.find((c) => /INSERT INTO agent_chats/.test(c.sql));
    expect(insert).toBeDefined();
    // INSERT bound args: (id, role, feature_id, title, transcript)
    expect(insert?.args.slice(1)).toEqual(['worker', null, 'worker', '[]']);
    expect(calls.some((c) => /harness_features/.test(c.sql))).toBe(false);
  });

  it('derives "role · feature" title and probes the feature lock when feature_id given', async () => {
    getMock
      .mockResolvedValueOnce(ROW({ role: 'worker', feature_id: 'F-9', title: 'worker · F-9' }))
      .mockResolvedValueOnce({ taken_by: null, taken_at: null, expires_at: null });
    const r = await createChat({ slug: 'foo', role: 'worker', feature_id: 'F-9' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.feature_lock).toEqual({
      taken_by: null,
      taken_at: null,
      expires_at: null,
      active: false, // taken_by null → not active
    });
    const insert = calls.find((c) => /INSERT INTO agent_chats/.test(c.sql));
    expect(insert?.args.slice(1)).toEqual(['worker', 'F-9', 'worker · F-9', '[]']);
    expect(calls.some((c) => /harness_features/.test(c.sql))).toBe(true);
  });

  it('honors an explicit title over the derived default', async () => {
    getMock.mockResolvedValueOnce(ROW({ role: 'scoper', title: 'Custom' }));
    await createChat({ slug: 'foo', role: 'scoper', title: 'Custom' });
    const insert = calls.find((c) => /INSERT INTO agent_chats/.test(c.sql));
    expect(insert?.args[3]).toBe('Custom');
  });

  it('wraps an insert failure as a 500 envelope', async () => {
    runMock.mockRejectedValueOnce(new Error('unique violation'));
    const r = await createChat({ slug: 'foo', role: 'worker' });
    expect(r).toEqual({ ok: false, status: 500, error: 'failed to create chat: unique violation' });
  });
});

describe('archiveChat (AC2 — orphaned `pre` SELECT removed)', () => {
  it('issues ONLY the archive UPDATE — no role/feature_id pre-SELECT', async () => {
    const r = await archiveChat({ slug: 'foo', chatId: 'c1' });
    expect(r).toEqual({ ok: true, data: { ok: true } });
    // exactly one statement: the UPDATE. The dead `SELECT role, feature_id`
    // (orphaned by the experts-rip-out refactor) must NOT run — this test
    // FAILS against the old code, which prepared+ran that extra SELECT.
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/UPDATE agent_chats SET archived_at = \?, updated_at = \? WHERE id = \?/);
    // and nobody SELECTed role/feature_id as a side-channel
    expect(calls.some((c) => /SELECT role, feature_id/.test(c.sql))).toBe(false);
    // archiving never touches a feature lock
    expect(calls.some((c) => /harness_features/.test(c.sql))).toBe(false);
  });

  it('sets archived_at and updated_at to the same epoch-ms, keyed by chatId', async () => {
    const before = Date.now();
    await archiveChat({ slug: 'foo', chatId: 'c1' });
    const after = Date.now();
    const [archivedAt, updatedAt, id] = calls[0].args as [number, number, string];
    expect(archivedAt).toBe(updatedAt); // single now() snapshot
    expect(archivedAt).toBeGreaterThanOrEqual(before);
    expect(archivedAt).toBeLessThanOrEqual(after);
    expect(id).toBe('c1');
  });

  it('wraps an update failure as a 500 envelope', async () => {
    runMock.mockRejectedValueOnce(new Error('deadlock'));
    const r = await archiveChat({ slug: 'foo', chatId: 'c1' });
    expect(r).toEqual({ ok: false, status: 500, error: 'failed to archive chat: deadlock' });
  });
});
