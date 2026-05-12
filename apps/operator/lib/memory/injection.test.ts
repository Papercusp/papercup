import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMemoryContextBlock, lastUserContext } from './injection';

vi.mock('./mem0-client', () => ({
  getMemoryClient: vi.fn(),
}));

import { getMemoryClient } from './mem0-client';

const mockClient = (
  results: Array<{ memory: string; metadata?: Record<string, unknown> }>,
  sharedResults: typeof results = [],
) => ({
  search: vi.fn(async (_q: string, opts: { filters: { user_id: string } }) => {
    const isShared = opts.filters.user_id.startsWith('workspace:');
    return { results: isShared ? sharedResults : results };
  }),
});

beforeEach(() => {
  vi.mocked(getMemoryClient).mockReset();
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
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: '',
    });
    expect(block).toBeNull();
  });

  it('returns null when mem0 client unavailable', async () => {
    vi.mocked(getMemoryClient).mockResolvedValue(null);
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'auth?',
    });
    expect(block).toBeNull();
  });

  it('returns null when client throws', async () => {
    vi.mocked(getMemoryClient).mockRejectedValue(new Error('boom'));
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'auth?',
    });
    expect(block).toBeNull();
  });

  it('returns null when search throws', async () => {
    const c = mockClient([]);
    c.search = vi.fn(async () => { throw new Error('pg down'); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(c as any);
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'auth?',
    });
    expect(block).toBeNull();
  });

  it('returns null when no hits', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([]) as any);
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'auth?',
    });
    expect(block).toBeNull();
  });

  it('formats user hits with kind metadata', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([
      { memory: 'User prefers terse replies', metadata: { kind: 'preference' } },
      { memory: 'User name is Aviyn', metadata: { kind: 'identity' } },
    ]) as any);
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'who am i',
    });
    expect(block).toContain('## Operator memory (relevant entries)');
    expect(block).toContain('- [preference] User prefers terse replies');
    expect(block).toContain('- [identity] User name is Aviyn');
  });

  it('marks workspace-shared entries as [shared]', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient(
      [{ memory: 'Personal note', metadata: { kind: 'preference' } }],
      [{ memory: 'Workspace fact', metadata: { kind: 'project', shared: true } }],
    ) as any);
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'auth?',
    });
    expect(block).toContain('- [preference] Personal note');
    expect(block).toContain('- [project [shared]] Workspace fact');
  });

  it('falls back to unknown kind when missing metadata', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([
      { memory: 'Bare fact' },
    ]) as any);
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'auth?',
    });
    expect(block).toContain('- [unknown] Bare fact');
  });

  it('respects custom heading', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(mockClient([
      { memory: 'X', metadata: { kind: 'project' } },
    ]) as any);
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'x',
      heading: 'Brainstorm memory',
    });
    expect(block).toMatch(/^## Brainstorm memory/);
  });

  it('workspace-only mode (no userId) pulls only shared memories', async () => {
    const c = mockClient(
      [{ memory: 'personal', metadata: { kind: 'preference' } }],
      [{ memory: 'workspace fact', metadata: { kind: 'project' } }],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(c as any);
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws-9', queryContext: 'auth?',
    });
    expect(block).toContain('workspace fact');
    expect(block).not.toContain('personal');
    // Verify only one search call happened (no per-user pull)
    const calls = (c.search as ReturnType<typeof vi.fn>).mock.calls;
    const userIds = calls.map((c) => (c[1] as { filters: { user_id: string } }).filters.user_id);
    expect(userIds).toEqual(['workspace:ws-9']);
  });

  it('workspace-only mode honors `limit` for the shared pull', async () => {
    const c = mockClient([], [{ memory: 'x', metadata: { kind: 'project' } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(c as any);
    await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', queryContext: 'q', limit: 9,
    });
    const calls = (c.search as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0][1] as { limit: number }).limit).toBe(9);
  });

  it('passes filter shape mem0 v3 expects (snake_case user_id)', async () => {
    const c = mockClient([{ memory: 'x', metadata: { kind: 'preference' } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getMemoryClient).mockResolvedValue(c as any);
    await buildMemoryContextBlock({
      userId: 'u-123', workspaceId: 'ws-7', queryContext: 'foo',
    });
    const calls = (c.search as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toEqual({ filters: { user_id: 'u-123' }, limit: 6 });
    expect(calls[1][1]).toEqual({ filters: { user_id: 'workspace:ws-7' }, limit: 3 });
  });
});
