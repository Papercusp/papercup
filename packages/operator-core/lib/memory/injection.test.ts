import { describe, it, expect, vi, beforeEach } from 'vitest';

// db-org is mocked so the dedup/bump paths (getOrgPg().sql) are deterministic and
// never touch a real PG. `sqlRows` is the canned result the sql tag returns; the
// dedup test sets it to mark a memory id as recently-surfaced.
let sqlRows: Array<{ id: string }> = [];
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: async () => sqlRows }),
}));

vi.mock('./backend', () => ({
  getMemoryBackend: vi.fn(),
}));

import { buildMemoryContextBlock, lastUserContext } from './injection';
import { getMemoryBackend } from './backend';
import { _resetForTests } from './bump-last-surfaced';

type Row = { id: string; text: string; kind?: string };

// The neutral-backend mock (generalize-memory-backend-swappable D-003):
// `search` stamps each canned row with the scope it was queried under,
// mimicking the real backend's per-pool attribution.
const mockBackend = (rows: Row[], availability: { ok: boolean; reason?: string } = { ok: true }) => ({
  name: 'fake',
  available: vi.fn(async () => availability),
  search: vi.fn(async (_q: string, opts: { scope: string | readonly string[] }) => {
    const scope = typeof opts.scope === 'string' ? opts.scope : opts.scope[0];
    return rows.map((r) => ({ ...r, scope }));
  }),
});

const useBackend = (b: ReturnType<typeof mockBackend>): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

beforeEach(() => {
  vi.mocked(getMemoryBackend).mockReset();
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
    useBackend(mockBackend([]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: '' });
    expect(block).toBeNull();
  });

  it('returns null when the backend is unavailable', async () => {
    useBackend(mockBackend([], { ok: false, reason: 'mem0_unavailable' }));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('returns null when the availability probe throws', async () => {
    const b = mockBackend([]);
    b.available = vi.fn(async () => { throw new Error('boom'); });
    useBackend(b);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('returns null when search throws', async () => {
    const b = mockBackend([]);
    b.search = vi.fn(async () => { throw new Error('pg down'); });
    useBackend(b);
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('returns null when no hits', async () => {
    useBackend(mockBackend([]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toBeNull();
  });

  it('formats user hits with their kind', async () => {
    useBackend(mockBackend([
      { id: 'i1', text: 'User prefers terse replies', kind: 'preference' },
      { id: 'i2', text: 'User name is Aviyn', kind: 'identity' },
    ]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'who am i' });
    expect(block).toContain('## Operator memory (relevant entries)');
    expect(block).toContain('- [preference] (id=i1) User prefers terse replies');
    expect(block).toContain('- [identity] (id=i2) User name is Aviyn');
  });

  it('labels a harness-scoped hit with its slug', async () => {
    useBackend(mockBackend([
      { id: 'i3', text: 'Project uses PG by default', kind: 'project' },
    ]));
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['papercup'], queryContext: 'storage?',
    });
    expect(block).toContain('- [project @ papercup] (id=i3) Project uses PG by default');
  });

  it('falls back to unknown kind when the entry has none', async () => {
    useBackend(mockBackend([{ id: 'i4', text: 'Bare fact' }]));
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'auth?' });
    expect(block).toContain('- [unknown] (id=i4) Bare fact');
  });

  it('respects custom heading', async () => {
    useBackend(mockBackend([{ id: 'i5', text: 'X', kind: 'project' }]));
    const block = await buildMemoryContextBlock({
      userId: 'u1', workspaceId: 'ws', queryContext: 'x', heading: 'Brainstorm memory',
    });
    expect(block).toMatch(/^## Brainstorm memory/);
  });

  it('pulls user + harness scopes only — no deprecated workspace pull (D-005)', async () => {
    const b = mockBackend([{ id: 'i6', text: 'x', kind: 'preference' }]);
    useBackend(b);
    await buildMemoryContextBlock({
      userId: 'u-123', workspaceId: 'ws-7', harnessSlugs: ['papercup'], queryContext: 'foo',
    });
    // One user pull (limit 6) + one harness pull (per-pool limit 3) —
    // never a `workspace:*` scope. Both pulls carry the inject relevance floor
    // (injectMinScore() default 0.42) — the no-LLM-in-the-loop quality gate.
    expect(b.search.mock.calls).toEqual([
      ['foo', { scope: 'u-123', limit: 6, minScore: 0.42 }],
      ['foo', { scope: ['harness:papercup'], limit: 3, minScore: 0.42 }],
    ]);
  });

  it('dedups a memory surfaced within the watermark window (D-006)', async () => {
    const stale = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const fresh = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    useBackend(mockBackend([
      { id: stale, text: 'stale fact', kind: 'preference' },
      { id: fresh, text: 'fresh fact', kind: 'preference' },
    ]));
    // `stale` was surfaced recently → the guard must drop it; `fresh` stays.
    sqlRows = [{ id: stale }];
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
    expect(block).toContain('fresh fact');
    expect(block).not.toContain('stale fact');
  });

  it('returns null when every hit was recently surfaced', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    useBackend(mockBackend([
      { id, text: 'only fact', kind: 'preference' },
    ]));
    sqlRows = [{ id }];
    const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
    expect(block).toBeNull();
  });
});
