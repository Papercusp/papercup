/**
 * Coverage for cross-harness-data — the cross_harness inbox/outbox/supervisor-
 * notes/recent-activity readers shared by the legacy Hono routes and the
 * cross_harness:* MCP tools.
 *
 * slugToSchema is the SECURITY-LOAD-BEARING mapping: its result is interpolated
 * RAW (no postgres-js escaping) into `sql.unsafe(`…${schema}.messages…`)`, so a
 * slug that isn't a single safe identifier segment is a SQL-injection vector.
 * The sibling agent-mcp `messages:inbox` tool guards the SAME vector with a
 * SLUG_RE; this file pins that slugToSchema now REJECTS a malformed slug
 * (`'a; drop'`, dotted, with whitespace, …) by throwing rather than letting it
 * reach the identifier (TEETH: an injection payload must NOT be interpolated).
 *
 * The readers themselves are pinned with a `getOrgPg().sql` mock that captures
 * the SQL string + bound args (mirrors agent-chats-data.test.ts's capture
 * idiom) so the limit clamps, the `status:'all'` bypass, the role-regex branch
 * (valid → role-filtered SQL; invalid → unfiltered branch), and readOutbox's
 * harness_shared exclusion + global sort + cap are exercised without a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── getOrgPg().sql capture rig ────────────────────────────────────────────
// `sql` is used two ways by the module:
//   - sql.unsafe(query, params)  → readInbox/readOutbox(per-schema)/readSupervisorNotes
//   - sql`…tagged…`              → readOutbox's pg_namespace enumeration
// The hoisted rig records every .unsafe call and lets a test queue the rows
// each call resolves to (FIFO), plus the rows the tagged-template call returns.
const H = vi.hoisted(() => {
  const state: {
    unsafeCalls: Array<{ query: string; params: unknown[] }>;
    unsafeQueue: unknown[][]; // FIFO rows per .unsafe call
    namespaceRows: Array<{ nspname: string }>;
    taggedCalls: Array<{ strings: readonly string[]; values: unknown[] }>;
  } = { unsafeCalls: [], unsafeQueue: [], namespaceRows: [], taggedCalls: [] };

  // Tagged-template `sql\`…\`` → returns the queued pg_namespace rows.
  const sql = ((strings: readonly string[], ...values: unknown[]) => {
    state.taggedCalls.push({ strings, values });
    return Promise.resolve(state.namespaceRows);
  }) as unknown as {
    (strings: readonly string[], ...values: unknown[]): Promise<unknown>;
    unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
  };
  sql.unsafe = (query: string, params: unknown[] = []) => {
    state.unsafeCalls.push({ query, params });
    return Promise.resolve(state.unsafeQueue.shift() ?? []);
  };
  const withWorkspace = vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) => fn(sql));
  return { sql, state, withWorkspace };
});

const withWorkspaceMock = H.withWorkspace;

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: H.sql }),
    withWorkspace: H.withWorkspace,
  };
});

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import {
  slugToSchema,
  readInbox,
  readOutbox,
  readSupervisorNotes,
  readRecentActivity,
} from './cross-harness-data';

beforeEach(() => {
  H.state.unsafeCalls = [];
  H.state.unsafeQueue = [];
  H.state.namespaceRows = [];
  H.state.taggedCalls = [];
});

afterEach(() => {
  withWorkspaceMock.mockClear();
});

/** The most-recent .unsafe call (the one the assertion cares about). */
function lastUnsafe() {
  const calls = H.state.unsafeCalls;
  return calls[calls.length - 1];
}

describe('slugToSchema', () => {
  it('prefixes harness_ and replaces dashes with underscores', () => {
    expect(slugToSchema('my-harness')).toBe('harness_my_harness');
    expect(slugToSchema('sheets-clone')).toBe('harness_sheets_clone');
  });
  it('lowercases', () => {
    expect(slugToSchema('Foo-Bar')).toBe('harness_foo_bar');
  });
  it('handles a single-segment slug', () => {
    expect(slugToSchema('papercup')).toBe('harness_papercup');
  });
  it('accepts an underscore-containing slug (already-normalized form)', () => {
    expect(slugToSchema('my_harness')).toBe('harness_my_harness');
  });

  // ── SECURITY: the result is interpolated raw into sql.unsafe — a malformed
  //    slug must be REJECTED, never mapped to an identifier (audit P-029). ──
  describe('rejects an unsafe slug (SQL-injection guard, TEETH)', () => {
    for (const bad of [
      'a; drop',
      "a'; DROP SCHEMA harness_x; --",
      'a b', // whitespace
      'a.b', // dot would survive into the qualified identifier
      'a/b',
      'a)b',
      'a,b',
      '', // empty
      'a$1',
    ]) {
      it(`throws on ${JSON.stringify(bad)}`, () => {
        expect(() => slugToSchema(bad)).toThrow(/invalid harness slug/);
      });
    }
  });
});

describe('readInbox', () => {
  it('a malformed slug is REJECTED before any SQL runs (no injection)', async () => {
    await expect(readInbox('a; drop')).rejects.toThrow(/invalid harness slug/);
    expect(H.state.unsafeCalls).toHaveLength(0); // nothing reached the DB
  });

  it('interpolates the validated schema into the FROM and defaults status=pending', async () => {
    await readInbox('sheets-clone');
    const call = lastUnsafe();
    expect(call.query).toContain('FROM harness_sheets_clone.messages');
    // default status pending, default limit 20, slug bound as $1
    expect(call.params).toEqual(['sheets-clone', 'pending', 20]);
  });

  it('clamps limit above 200 down to 200', async () => {
    await readInbox('h', { limit: 5000 });
    expect(lastUnsafe().params).toContain(200);
    expect(lastUnsafe().params).not.toContain(5000);
  });

  it('clamps limit at/below 0 up to 1', async () => {
    await readInbox('h', { limit: 0 });
    expect(lastUnsafe().params[lastUnsafe().params.length - 1]).toBe(1);
    await readInbox('h', { limit: -10 });
    expect(lastUnsafe().params[lastUnsafe().params.length - 1]).toBe(1);
  });

  it("status:'all' is forwarded as a bound arg (the SQL's $='all' bypass)", async () => {
    await readInbox('h', { status: 'all' });
    // The query carries the `$2 = 'all' OR status = $2` bypass and 'all' is bound.
    expect(lastUnsafe().query).toContain("= 'all' OR status =");
    expect(lastUnsafe().params).toContain('all');
  });

  describe('role-regex branch (/^[a-z][a-z0-9_-]*$/i)', () => {
    it('a VALID role → role-filtered SQL (to_role clause + role bound as $3)', async () => {
      await readInbox('h', { role: 'engineer' });
      const call = lastUnsafe();
      expect(call.query).toContain('to_role IS NULL OR to_role = $3');
      // valid-role branch binds [slug, status, role, limit]
      expect(call.params).toEqual(['h', 'pending', 'engineer', 20]);
    });

    it("an INVALID role ('a b') → UNFILTERED branch (no to_role WHERE clause, role not bound)", async () => {
      await readInbox('h', { role: 'a b' });
      const call = lastUnsafe();
      // `to_role` survives as a projected COLUMN; the filter CLAUSE is what's dropped.
      expect(call.query).not.toContain('to_role IS NULL OR to_role = $3');
      // unfiltered branch binds [slug, status, limit] — role is dropped
      expect(call.params).toEqual(['h', 'pending', 20]);
    });

    it("an INVALID role ('; --') → UNFILTERED branch (injection-shaped role never bound to a filter)", async () => {
      await readInbox('h', { role: '; --' });
      const call = lastUnsafe();
      expect(call.query).not.toContain('to_role IS NULL OR to_role = $3');
      expect(call.params).toEqual(['h', 'pending', 20]);
    });

    it('a null/absent role → unfiltered branch', async () => {
      await readInbox('h', { role: null });
      expect(lastUnsafe().query).not.toContain('to_role IS NULL OR to_role = $3');
      expect(lastUnsafe().params).toEqual(['h', 'pending', 20]);
    });
  });
});

describe('readOutbox', () => {
  function nsRow(nspname: string) {
    return { nspname };
  }
  function msg(over: Record<string, unknown> = {}) {
    return {
      id: 'm',
      from_slug: 'me',
      to_slug: 't',
      to_role: null,
      kind: 'note',
      subject: 's',
      body: 'b',
      parent_message_id: null,
      status: 'pending',
      created_at: '2026-06-11T00:00:00.000Z',
      acknowledged_at: null,
      ...over,
    };
  }

  it("enumerates harness_% namespaces EXCLUDING harness_shared (WHERE nspname <> 'harness_shared')", async () => {
    H.state.namespaceRows = [];
    await readOutbox('me');
    // The tagged-template enumeration query carries the harness_shared exclusion.
    const enumQuery = H.state.taggedCalls[0]?.strings.join('');
    expect(enumQuery).toContain("LIKE 'harness\\_%'");
    expect(enumQuery).toContain("nspname <> 'harness_shared'");
  });

  it('reads from every enumerated schema, with from_slug bound as $1', async () => {
    H.state.namespaceRows = [nsRow('harness_a'), nsRow('harness_b'), nsRow('harness_c')];
    H.state.unsafeQueue = [[], [], []];
    await readOutbox('me');
    expect(H.state.unsafeCalls).toHaveLength(3);
    expect(H.state.unsafeCalls.map((c) => c.query.match(/FROM (\w+)\.messages/)?.[1])).toEqual([
      'harness_a',
      'harness_b',
      'harness_c',
    ]);
    for (const c of H.state.unsafeCalls) expect(c.params[0]).toBe('me');
  });

  it('concatenates per-schema rows then GLOBALLY sorts by created_at DESC', async () => {
    H.state.namespaceRows = [nsRow('harness_a'), nsRow('harness_b')];
    // Interleaved timestamps across two schemas — global order must re-sort.
    H.state.unsafeQueue = [
      [msg({ id: 'a1', created_at: '2026-06-11T01:00:00.000Z' }), msg({ id: 'a2', created_at: '2026-06-11T03:00:00.000Z' })],
      [msg({ id: 'b1', created_at: '2026-06-11T02:00:00.000Z' }), msg({ id: 'b2', created_at: '2026-06-11T04:00:00.000Z' })],
    ];
    const rows = await readOutbox('me');
    expect(rows.map((r) => r.id)).toEqual(['b2', 'a2', 'b1', 'a1']);
  });

  it('caps the merged result at the (clamped) limit', async () => {
    H.state.namespaceRows = [nsRow('harness_a'), nsRow('harness_b')];
    H.state.unsafeQueue = [
      [msg({ id: 'a1', created_at: '2026-06-11T01:00:00.000Z' }), msg({ id: 'a2', created_at: '2026-06-11T05:00:00.000Z' })],
      [msg({ id: 'b1', created_at: '2026-06-11T02:00:00.000Z' }), msg({ id: 'b2', created_at: '2026-06-11T04:00:00.000Z' })],
    ];
    const rows = await readOutbox('me', 2);
    // newest two across both schemas
    expect(rows.map((r) => r.id)).toEqual(['a2', 'b2']);
    // per-schema LIMIT is also the clamped value
    for (const c of H.state.unsafeCalls) expect(c.params[1]).toBe(2);
  });

  it('clamps limit above 200 / at-or-below 0 (200 cap, 1 floor)', async () => {
    H.state.namespaceRows = [nsRow('harness_a')];
    H.state.unsafeQueue = [[]];
    await readOutbox('me', 5000);
    expect(H.state.unsafeCalls[0].params[1]).toBe(200);

    H.state.unsafeCalls = [];
    H.state.unsafeQueue = [[]];
    await readOutbox('me', 0);
    expect(H.state.unsafeCalls[0].params[1]).toBe(1);
  });
});

describe('readSupervisorNotes', () => {
  it('a malformed slug is rejected before any SQL runs', async () => {
    await expect(readSupervisorNotes('a; drop')).rejects.toThrow(/invalid harness slug/);
    expect(H.state.unsafeCalls).toHaveLength(0);
  });

  it('reads from the validated schema.supervisor_notes with default limit 10', async () => {
    await readSupervisorNotes('my-harness');
    const call = lastUnsafe();
    expect(call.query).toContain('FROM harness_my_harness.supervisor_notes');
    expect(call.params).toEqual([10]);
  });

  it('caps the limit at 100', async () => {
    await readSupervisorNotes('h', 5000);
    expect(lastUnsafe().params).toEqual([100]);
  });

  it('floors the limit at 1', async () => {
    await readSupervisorNotes('h', 0);
    expect(lastUnsafe().params).toEqual([1]);
  });
});

describe('readRecentActivity', () => {
  it('runs under the active workspace and clamps limit to 200', async () => {
    await readRecentActivity(5000);
    expect(withWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(withWorkspaceMock.mock.calls[0][0]).toBe('ws-test');
    // The clamped limit (200) is interpolated into the tagged-template query.
    const tagged = H.state.taggedCalls[0];
    expect(tagged.values).toContain(200);
  });

  it('floors the limit at 1', async () => {
    await readRecentActivity(0);
    expect(H.state.taggedCalls[0].values).toContain(1);
  });

  it('defaults to limit 20 when unspecified', async () => {
    await readRecentActivity();
    expect(H.state.taggedCalls[0].values).toContain(20);
  });
});
