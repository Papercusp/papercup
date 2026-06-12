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

// The harness registry backs the member→hive resolution (learning-packs
// P-004). Canned per-test via `registryProjects`; default empty ⇒ no hive pull.
let registryProjects: Array<{ slug: string; harness_kind?: string; hive_slug?: string }> = [];
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: registryProjects })),
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
  registryProjects = [];
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
    // (injectMinScore() 0.45) + the hybrid push lexical bar (injectMinLexScore()
    // 0.40) — the no-LLM-in-the-loop precision gate (P-031 / D-003).
    expect(b.search.mock.calls).toEqual([
      ['foo', { scope: 'u-123', limit: 6, minScore: 0.45, minLexScore: 0.4 }],
      ['foo', { scope: ['harness:papercup'], limit: 3, minScore: 0.45, minLexScore: 0.4 }],
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

  it('pulls + labels the hive pool for a member harness (learning-packs P-004)', async () => {
    registryProjects = [
      { slug: 'member-a', hive_slug: 'my-hive' },
      { slug: 'my-hive', harness_kind: 'hive' },
    ];
    const b = mockBackend([{ id: 'h1', text: 'Tests ship with the feature', kind: 'feedback' }]);
    useBackend(b);
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['member-a'], queryContext: 'testing?',
    });
    // Second pull = harness pool, third = hive pool resolved from the registry.
    expect(b.search.mock.calls).toEqual([
      ['testing?', { scope: ['harness:member-a'], limit: 3, minScore: 0.45, minLexScore: 0.4 }],
      ['testing?', { scope: ['hive:my-hive'], limit: 3, minScore: 0.45, minLexScore: 0.4 }],
    ]);
    expect(block).toContain('- [feedback @ hive:my-hive] (id=h1) Tests ship with the feature');
  });

  it('budget: hive-pack rows yield first under the cap; truncation is announced; only injected ids get watermarked (P-011)', async () => {
    const prev = process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS;
    process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS = '120';
    try {
      const organic = { id: 'org-1', text: 'this project tests via make test', kind: 'reference' };
      const packed = {
        id: 'pk-1',
        text: 'Tests ship with the feature — a long seeded learning body that will not fit the tiny budget'.repeat(2),
        kind: 'feedback',
        metadata: { source: 'pack', pack_id: 'papercusp-default' },
      };
      useBackend(mockBackend([organic, packed]));
      const block = await buildMemoryContextBlock({
        userId: null, workspaceId: 'ws', hiveSlugs: ['h'], queryContext: 'testing?',
      });
      expect(block).toContain('make test'); // organic admitted first
      expect(block).not.toContain('Tests ship with the feature'); // pack row dropped by the cap
      expect(block).toContain('memory budget is full'); // truncation announced honestly
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS;
      else process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS = prev;
    }
  });

  it('explicit hiveSlugs: [] suppresses the hive pull; explicit slugs skip resolution', async () => {
    registryProjects = [{ slug: 'member-a', hive_slug: 'my-hive' }];
    const suppressed = mockBackend([{ id: 'x', text: 'x', kind: 'project' }]);
    useBackend(suppressed);
    await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', harnessSlugs: ['member-a'], hiveSlugs: [], queryContext: 'q',
    });
    expect(suppressed.search.mock.calls.map((c) => c[1].scope)).toEqual([['harness:member-a']]);

    const pinned = mockBackend([{ id: 'y', text: 'y', kind: 'feedback' }]);
    useBackend(pinned);
    const block = await buildMemoryContextBlock({
      userId: null, workspaceId: 'ws', hiveSlugs: ['other-hive'], queryContext: 'q',
    });
    expect(pinned.search.mock.calls.map((c) => c[1].scope)).toEqual([['hive:other-hive']]);
    expect(block).toContain('@ hive:other-hive');
  });

  describe('two-tier markers (self-learning-frontier P-022 / FB-08, D-006)', () => {
    const rows = [
      { id: 'p1', text: 'A probationary lesson', kind: 'project', metadata: { tier: 'probationary' } },
      { id: 'v1', text: 'A validated fact', kind: 'project' },
    ] as never[];
    const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_TRANSFER_HARNESS';

    it('flag dark (the D-001 default) ⇒ byte-identical output, no markers', async () => {
      useBackend(mockBackend(rows));
      const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
      expect(block).toContain('- [project] (id=p1) A probationary lesson');
      expect(block).not.toContain('probationary]');
    });

    it('flag armed ⇒ probationary entries are marked, still injected (admission is free)', async () => {
      process.env[FLAG_ENV] = '1';
      try {
        useBackend(mockBackend(rows));
        const block = await buildMemoryContextBlock({ userId: 'u1', workspaceId: 'ws', queryContext: 'q' });
        expect(block).toContain('- [project · probationary] (id=p1) A probationary lesson');
        expect(block).toContain('- [project] (id=v1) A validated fact'); // legacy grandfathered
      } finally {
        delete process.env[FLAG_ENV];
      }
    });
  });
});
