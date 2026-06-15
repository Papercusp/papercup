/**
 * list-user-memories.integration.test.ts — the shared user-memory list projection
 * against real Postgres. The audit enrichment reads `harness_shared.memory_canonical`
 * + `memory_anchors` via `getOrgPg().sql`; the rest of the list is composed from the
 * neutral memory backend. We mock the backend + harness registry (pure seams) and run
 * the enrichment against the fixture's admin client (the org-fixture pattern), seeding
 * real canonical/anchor rows so the id::text join, broken-anchor pull, ISO timestamp
 * normalization, and newest-first sort are validated end-to-end.
 *
 * Part of whole-app-test-coverage-breadth-2026-06-14 P-006 (integration tier).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

interface FakeEntry {
  id: string;
  text: string;
  kind?: string;
  scope: string;
  metadata?: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  sql: null as unknown,
  entries: [] as FakeEntry[],
  ws: 'ws-mem-test',
}));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: () => Promise.resolve({ projects: [] }),
}));
vi.mock('./backend', () => ({
  getMemoryBackend: () => ({ list: (_opts: unknown) => Promise.resolve(h.entries) }),
}));

const { listUserMemories } = await import('./list-user-memories');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const USER = 'user-mem-1';

describe('listUserMemories (real PG enrichment)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // Seed a canonical row with explicit timestamps; returns its uuid.
  async function seedCanonical(opts: {
    state?: string;
    created?: string;
    updated?: string;
    validated?: string | null;
  }): Promise<string> {
    const rows = await db.adminSql<Array<{ id: string }>>`
      INSERT INTO harness_shared.memory_canonical (state, created_at, updated_at, last_validated_at)
      VALUES (
        ${opts.state ?? 'active'},
        ${opts.created ?? '2026-01-01T00:00:00Z'},
        ${opts.updated ?? '2026-01-01T00:00:00Z'},
        ${opts.validated ?? null}
      )
      RETURNING id::text AS id`;
    return rows[0].id;
  }

  it('returns un-enriched rows when no canonical row matches', async () => {
    h.entries = [{ id: 'opaque-non-uuid', text: 'a fact', kind: 'project', scope: USER }];
    const rows = await listUserMemories(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('a fact');
    expect(rows[0].scope).toBe('user');
    expect(rows[0].audit).toBeUndefined();
  });

  it('enriches a row with audit state + ISO-normalized timestamps', async () => {
    const id = await seedCanonical({
      state: 'active',
      created: '2026-03-01T10:00:00Z',
      updated: '2026-03-02T11:00:00Z',
      validated: '2026-03-02T12:00:00Z',
    });
    h.entries = [{ id, text: 'enriched fact', scope: USER }];
    const rows = await listUserMemories(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0].audit?.state).toBe('active');
    // ISO-normalized (the WebKit-safe form): ends with Z, parseable.
    expect(rows[0].updated_at).toMatch(/Z$/);
    expect(Number.isNaN(Date.parse(rows[0].updated_at!))).toBe(false);
    expect(rows[0].audit?.last_validated_at).toMatch(/Z$/);
    expect(rows[0].audit?.broken_anchors).toEqual([]);
  });

  it('surfaces broken anchors (last_check_ok = false) for the row', async () => {
    const id = await seedCanonical({ state: 'broken_anchor' });
    await db.adminSql`
      INSERT INTO harness_shared.memory_anchors (memory_id, kind, value, last_check_ok)
      VALUES (${id}::uuid, 'file', 'gone.ts', false)`;
    // a healthy anchor should NOT surface
    await db.adminSql`
      INSERT INTO harness_shared.memory_anchors (memory_id, kind, value, last_check_ok)
      VALUES (${id}::uuid, 'plan', 'still-here', true)`;
    h.entries = [{ id, text: 'broken fact', scope: USER }];
    const rows = await listUserMemories(USER);
    expect(rows[0].audit?.broken_anchors).toHaveLength(1);
    expect(rows[0].audit?.broken_anchors[0]).toMatchObject({ kind: 'file', value: 'gone.ts' });
  });

  it('maps harness: scope onto { scope: harness, harness_slug }', async () => {
    h.entries = [{ id: 'x', text: 'h fact', scope: 'harness:alpha' }];
    const rows = await listUserMemories(USER);
    expect(rows[0].scope).toBe('harness');
    expect(rows[0].harness_slug).toBe('alpha');
  });

  it('sorts newest-first by updated_at, falling back to metadata.turn_at', async () => {
    const older = await seedCanonical({ updated: '2026-02-01T00:00:00Z' });
    const newer = await seedCanonical({ updated: '2026-05-01T00:00:00Z' });
    h.entries = [
      { id: older, text: 'older', scope: USER },
      { id: newer, text: 'newer', scope: USER },
      { id: 'no-canon', text: 'turn-based', scope: USER, metadata: { turn_at: Date.parse('2026-04-01T00:00:00Z') } },
    ];
    const rows = await listUserMemories(USER);
    expect(rows.map((r) => r.text)).toEqual(['newer', 'turn-based', 'older']);
  });
});
