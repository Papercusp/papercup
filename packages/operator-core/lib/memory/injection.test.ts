import { describe, it, expect, vi, beforeEach } from 'vitest';

// db-org is mocked so the dedup/bump paths (getOrgPg().sql) are deterministic and
// never touch a real PG. `sqlRows` is the canned result the sql tag returns; the
// dedup test sets it to mark a memory id as recently-surfaced.
let sqlRows: Array<{ id: string }> = [];
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: async () => sqlRows }),
}));

vi.mock('./mem0-client', () => ({
  getMemoryClient: vi.fn(),
}));

import { buildMemoryContextBlock, lastUserContext } from './injection';
import { getMemoryClient } from './mem0-client';
import { _resetForTests } from './bump-last-surfaced';

type Hit = { id?: string; memory: string; metadata?: Record<string, unknown> };

// The mem0 client mock: returns the same `results` for the user pull and any
// harness pull (tests that exercise harness fan-out pass harnessSlugs explicitly).
const mockClient = (results: Hit[]) => ({
  search: vi.fn(async (_q: string, _opts: { filters: { user_id: string } }) => ({ results })),
});

beforeEach(() => {
  vi.mocked(getMemoryClient).mockReset();
  sqlRows = [];
  _resetForTests();
});

describe('lastUserContext', () => {
  it('returns empty string for no user messages', () => {
    expect(lastUserContext([])).toBe('');
    expect(lastUserContext([{ role: 'assistant', content: 'hi' }])).toBe('');
  });

  it('joins last N user-turn contents', () => {
    const out = lastUserContext([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'user', content: 'four' },
    ], 3);
    expect(out).toBe('two\nthree\nfour');
  });
});

describe('buildMemoryContextBlock', () => {
  it('returns null when query context is empty', async () => {
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: '' });
    expect(block).toBeNull();
  });

  it('returns null when mem0 client unavailable', async () => {
    vi.mocked(getMemoryClient).mockResolvedValue(null);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('returns null when client throws', async () => {
    vi.mocked(getMemoryClient).mockRejectedValue(new Error('boom'));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('returns null when search throws', async () => {
    const c = mockClient([]);
    c.search = vi.fn(async () => { throw new Error('pg down'); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(c as any);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('returns null when no hits', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([]) as any);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('formats user hits with kind metadata', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([
      { memory: 'User prefers terse replies', metadata: { kind: 'preference' } },
      { memory: 'User name is Aviyn', metadata: { kind: 'identity' } },
    ]) as any);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'who am i' });
    expect(block).toContain('## Operator memory (relevant entries)');
    expect(block).toContain('- [preference] User prefers terse replies');
    expect(block).toContain('- [identity] User name is Aviyn');
  });

  it('labels a harness-scoped hit with its slug', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([
      { memory: 'Project uses PG by default', metadata: { kind: 'project' } },
    ]) as any);
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['papercup'], queryContext: 'storage?',
    });
    expect(block).toContain('- [project @ papercup] Project uses PG by default');
  });

  it('falls back to unknown kind when missing metadata', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([{ memory: 'Bare fact' }]) as any);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toContain('- [unknown] Bare fact');
  });

  it('respects custom heading', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([
      { memory: 'X', metadata: { kind: 'project' } },
    ]) as any);
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'x', heading: 'Brainstorm memory',
    });
    expect(block).toMatch(/^## Brainstorm memory/);
  });

  it('pulls user + harness scopes only — no deprecated workspace pull (D-005)', async () => {
    const c = mockClient([{ memory: 'x', metadata: { kind: 'preference' } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(c as any);
    await buildMemoryContextBlock({
      userId: 'u-123', workspaceId: 'ws-7', harnessSlugs: ['papercup'], queryContext: 'foo',
    });
    const calls = (c.search as ReturnType<typeof vi.fn>).mock.calls;
    const userIds = calls.map((call) => (call[1] as { filters: { user_id: string } }).filters.user_id);
    expect(userIds).toEqual(['u-123', 'harness:papercup']); // never a `workspace:*` pull
    expect(calls[0][1]).toEqual({ filters: { user_id: 'u-123' }, limit: 6 });
  });

  it('dedups a memory surfaced within the watermark window (D-006)', async () => {
    const stale = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const fresh = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([
      { id: stale, memory: 'stale fact', metadata: { kind: 'preference' } },
      { id: fresh, memory: 'fresh fact', metadata: { kind: 'preference' } },
    ]) as any);
    // `stale` was surfaced recently → the guard must drop it; `fresh` stays.
    sqlRows = [{ id: stale }];
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
    expect(block).toContain('fresh fact');
    expect(block).not.toContain('stale fact');
  });

  it('returns null when every hit was recently surfaced', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([
      { id, memory: 'only fact', metadata: { kind: 'preference' } },
    ]) as any);
    sqlRows = [{ id }];
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
    expect(block).toBeNull();
  });
});
