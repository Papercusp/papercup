/**
 * Coverage for cross-harness-data — the cross_harness supervisor-notes/
 * recent-activity readers shared by the legacy Hono routes and the
 * cross_harness:* MCP tools.
 *
 * slugToSchema is the SECURITY-LOAD-BEARING mapping: its result is interpolated
 * RAW (no postgres-js escaping) into `sql.unsafe(`…${schema}.supervisor_notes…`)`,
 * so a slug that isn't a single safe identifier segment is a SQL-injection
 * vector. The sibling agent-mcp `messages:inbox` tool guarded the SAME vector
 * with a SLUG_RE; this file pins that slugToSchema now REJECTS a malformed
 * slug (`'a; drop'`, dotted, with whitespace, …) by throwing rather than
 * letting it reach the identifier (TEETH: an injection payload must NOT be
 * interpolated).
 *
 * The readers themselves are pinned with a `getOrgPg().sql` mock that captures
 * the SQL string + bound args (mirrors agent-chats-data.test.ts's capture
 * idiom) so the limit clamps are exercised without a database.
 *
 * (readInbox/readOutbox coverage retired with the readers themselves — plan
 * retire-work-item-mail-surface-2026-07-26 P-002.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── getOrgPg().sql capture rig ────────────────────────────────────────────
// `sql` is used two ways by the module:
//   - sql.unsafe(query, params)  → readSupervisorNotes
//   - sql`…tagged…`              → readRecentActivity (via withWorkspace)
// The hoisted rig records every .unsafe call and lets a test queue the rows
// each call resolves to (FIFO), plus every tagged-template call's bindings.
const H = vi.hoisted(() => {
  const state: {
    unsafeCalls: Array<{ query: string; params: unknown[] }>;
    unsafeQueue: unknown[][]; // FIFO rows per .unsafe call
    taggedCalls: Array<{ strings: readonly string[]; values: unknown[] }>;
  } = { unsafeCalls: [], unsafeQueue: [], taggedCalls: [] };

  // Tagged-template `sql\`…\`` → records the call (readRecentActivity's query).
  const sql = ((strings: readonly string[], ...values: unknown[]) => {
    state.taggedCalls.push({ strings, values });
    return Promise.resolve([]);
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

import { slugToSchema, readSupervisorNotes, readRecentActivity } from './cross-harness-data';

beforeEach(() => {
  H.state.unsafeCalls = [];
  H.state.unsafeQueue = [];
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
