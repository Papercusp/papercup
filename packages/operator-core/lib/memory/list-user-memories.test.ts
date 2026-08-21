/**
 * list-user-memories.test.ts — UNIT invariants for the settings-page / sync
 * read projection (task #36, memory public-release hardening).
 *
 * The sibling list-user-memories.integration.test.ts covers enrichment, scope
 * mapping, and sort against REAL Postgres — so it can never exercise the path
 * that matters most for a public release: what happens when that Postgres is
 * DOWN. This file covers the invariants a healthy-PG integration test structurally
 * cannot:
 *
 *  1. DEGRADED-NEVER-SILENT (read side, the twin of WI-4208's write journal): the
 *     audit enrichment is best-effort BY CONTRACT — a PG outage, a pre-migration
 *     schema, or a missing anchors table must degrade to UN-ENRICHED rows and can
 *     NEVER throw and break the list. A user whose canonical store is down still
 *     sees their memories.
 *  2. SCOPE ISOLATION (no cross-tenant bleed): backend.list is asked for EXACTLY the
 *     caller's own pool plus one pool per harness in the active workspace — never
 *     another user, never a wildcard.
 *  3. A harness-registry failure still lists the user's personal pool.
 *
 * Run: cd packages/operator-core && npx vitest run lib/memory/list-user-memories.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
const h: { sql: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>; ws: string; harnesses: string[]; entries: Row[] } = {
  sql: async () => [],
  ws: 'ws-1',
  harnesses: [],
  entries: [],
};

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (s: TemplateStringsArray, ...v: unknown[]) => h.sql(s, ...v),
      { begin: vi.fn() },
    ),
  }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: h.harnesses.map((slug) => ({ slug })) })),
}));
const listSpy = vi.fn(async (_arg: { scope: string[] }): Promise<Row[]> => h.entries);
vi.mock('./backend', () => ({ getMemoryBackend: () => ({ name: 'fake', list: listSpy }) }));

import { listUserMemories } from './list-user-memories';
import { loadHarnessRegistry } from '../harness-registry';

const USER = 'user-1';
const lastScope = (): string[] => listSpy.mock.calls.at(-1)![0].scope;

beforeEach(() => {
  vi.clearAllMocks();
  h.sql = async () => [];
  h.ws = 'ws-1';
  h.harnesses = [];
  h.entries = [];
});

describe('listUserMemories — degraded-never-silent (enrichment failure can never break the list)', () => {
  it('a DOWN canonical store (sql throws) returns the un-enriched rows, does NOT throw', async () => {
    h.entries = [{ id: '123e4567-e89b-12d3-a456-426614174000', text: 'a fact typed before PG died', kind: 'user', scope: USER }];
    h.sql = async () => {
      throw new Error('ECONNREFUSED: canonical store unreachable');
    };
    const rows = await listUserMemories(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'a fact typed before PG died', scope: 'user' });
    expect(rows[0].audit).toBeUndefined(); // enrichment skipped, row survives
  });

  it('a missing anchors table (only the anchor query throws) still enriches audit state, empty broken_anchors', async () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    h.entries = [{ id, text: 'enriched despite no anchors table', scope: USER }];
    h.sql = async (strings) => {
      const q = strings.join('');
      if (q.includes('memory_anchors')) throw new Error('relation "harness_shared.memory_anchors" does not exist');
      // canonical query succeeds
      return [{ id, state: 'active', last_validated_at: null, last_surfaced_at: null, created_at: '2026-06-01T00:00:00Z', updated_at: null }];
    };
    const rows = await listUserMemories(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0].audit).toMatchObject({ state: 'active', broken_anchors: [] });
  });

  it('the list survives even when EVERYTHING downstream of backend.list is down', async () => {
    h.entries = [
      { id: 'opaque-a', text: 'fact a', scope: USER },
      { id: 'opaque-b', text: 'fact b', scope: USER },
    ];
    h.sql = async () => {
      throw new Error('total PG outage');
    };
    await expect(listUserMemories(USER)).resolves.toHaveLength(2);
  });
});

describe('listUserMemories — scope isolation (no cross-tenant bleed)', () => {
  it('asks backend.list for ONLY the caller\'s pool when there are no harnesses', async () => {
    h.harnesses = [];
    await listUserMemories(USER);
    expect(lastScope()).toEqual([USER]);
  });

  it('adds one harness: pool per harness in the active workspace — never another user or a wildcard', async () => {
    h.harnesses = ['alpha', 'beta'];
    await listUserMemories(USER);
    const scope = lastScope();
    expect(scope).toEqual([USER, 'harness:alpha', 'harness:beta']);
    expect(scope).not.toContain('*');
    expect(scope.filter((s) => s.startsWith('user') && s !== USER)).toEqual([]);
  });

  it('a harness-registry failure still lists the user\'s personal pool (never empties the whole list)', async () => {
    vi.mocked(loadHarnessRegistry).mockRejectedValueOnce(new Error('registry unreachable'));
    h.harnesses = ['ignored-because-registry-threw'];
    h.entries = [{ id: 'x', text: 'my fact', scope: USER }];
    const rows = await listUserMemories(USER);
    expect(lastScope()).toEqual([USER]); // no harness pools, but the user pool is intact
    expect(rows).toHaveLength(1);
  });
});

describe('listUserMemories — opts.limit (EI-12937: bounded window instead of the whole corpus)', () => {
  const mkEntries = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`,
      text: `fact ${i}`,
      scope: USER,
      // Distinct turn_at epochs (the metadata fallback sortKey reads when there's no
      // canonical created_at/updated_at) so "most recent first" is unambiguous —
      // higher i = more recent.
      metadata: { turn_at: i },
    }));

  it('no limit (omitted) ⇒ today\'s exact unbounded behavior, unchanged', async () => {
    h.entries = mkEntries(5);
    const rows = await listUserMemories(USER);
    expect(rows).toHaveLength(5);
  });

  it('limit smaller than the corpus ⇒ returns exactly `limit` rows, the MOST RECENT ones', async () => {
    h.entries = mkEntries(10);
    const rows = await listUserMemories(USER, { limit: 3 });
    expect(rows).toHaveLength(3);
    // Newest-first: ids 9, 8, 7 (the highest turn_at epochs) are the 3 most recent.
    expect(rows.map((r) => r.id)).toEqual(['id-9', 'id-8', 'id-7']);
  });

  it('limit larger than the corpus ⇒ returns the whole (unpadded) list, no error', async () => {
    h.entries = mkEntries(3);
    const rows = await listUserMemories(USER, { limit: 100 });
    expect(rows).toHaveLength(3);
  });

  it('limit: 0 ⇒ an empty list (a legitimate edge, not a no-op unbounded fetch)', async () => {
    h.entries = mkEntries(5);
    const rows = await listUserMemories(USER, { limit: 0 });
    expect(rows).toHaveLength(0);
  });

  it('the slice happens AFTER sorting, never before — never truncate-then-sort', async () => {
    // Entries arrive out of order from the backend; limiting must still return the
    // true most-recent 2, not just "the first 2 the backend happened to return".
    h.entries = [
      { id: 'old', text: 'old', scope: USER, metadata: { turn_at: 1 } },
      { id: 'newest', text: 'newest', scope: USER, metadata: { turn_at: 100 } },
      { id: 'mid', text: 'mid', scope: USER, metadata: { turn_at: 50 } },
    ];
    const rows = await listUserMemories(USER, { limit: 2 });
    expect(rows.map((r) => r.id)).toEqual(['newest', 'mid']);
  });
});
