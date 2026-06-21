/**
 * tool_cooccurrence.integration.test.ts — the dev:tool_cooccurrence miner's
 * SQL against real Postgres. Verifies pairwise co-occurrence support /
 * confidence / lift, the MCP-transport filter (HTTP/ipc rows excluded), the
 * minSupport noise floor, per-spawn DISTINCT counting, and the workspace filter.
 *
 * Routes through getOrgPg().sql (raw postgres-js), mocked to the fixture's
 * admin client — the established org-fixture pattern (see brain-pin.integration).
 *
 * Part of tool-call-batching-wrappers-2026-06-21 P-001.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));

const { toolCooccurrence } = await import('../../dev-data');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

const WS = 'ws-cooccur-test';

let nextId = 1;
async function seed(
  db: OrgTestDb,
  spawn: string,
  tool: string,
  opts: { transport?: string; ws?: string } = {},
) {
  await db.adminSql`
    INSERT INTO harness_shared.tool_invocations
      (id, workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status, transport)
    VALUES
      (${nextId++}, ${opts.ws ?? WS}, 'h1', 'core', ${tool}, 'worker', ${spawn}, 'w', 'ok', ${opts.transport ?? 'mcp'})`;
}

describe('toolCooccurrence (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // 3 in-workspace MCP spawns:
    //   s1: A, B        s2: A, B, C        s3: A (single tool, no pair)
    // ⇒ pairs: (A,B) support=2; (A,C) support=1; (B,C) support=1
    //   marginals: A=3, B=2, C=1; total_spawns=3
    await seed(db, 's1', 'A');
    await seed(db, 's1', 'B');
    await seed(db, 's2', 'A');
    await seed(db, 's2', 'B');
    await seed(db, 's2', 'C');
    await seed(db, 's3', 'A');
    // Non-MCP rows that MUST be ignored (else a bogus (A,Z) pair appears):
    await seed(db, 's4', 'A', { transport: 'http' });
    await seed(db, 's4', 'Z', { transport: 'http' });
    // A different-workspace MCP pair (excluded when workspaceIds filters to WS):
    await seed(db, 's5', 'A', { ws: 'other-ws' });
    await seed(db, 's5', 'B', { ws: 'other-ws' });
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('computes support / confidence / lift for a co-occurring pair (MCP + workspace scoped)', async () => {
    const { totalSpawns, entries } = await toolCooccurrence({ workspaceIds: [WS], minSupport: 1, hours: 24 });
    expect(totalSpawns).toBe(3); // s1,s2,s3 — http s4 + other-ws s5 excluded

    const ab = entries.find((e) => e.tool_a === 'A' && e.tool_b === 'B');
    expect(ab).toBeDefined();
    expect(ab!.support).toBe(2);
    expect(ab!.spawns_a).toBe(3); // A in s1,s2,s3
    expect(ab!.spawns_b).toBe(2); // B in s1,s2
    expect(ab!.confidence).toBeCloseTo(1.0, 3); // support / min(3,2) = 2/2
    expect(ab!.lift).toBeCloseTo(1.0, 3); // support*total/(a*b) = 2*3/(3*2)

    // Z only ever appears on non-MCP rows ⇒ never referenced.
    expect(entries.some((e) => e.tool_a === 'Z' || e.tool_b === 'Z')).toBe(false);
  });

  it('honors the minSupport noise floor', async () => {
    const { entries } = await toolCooccurrence({ workspaceIds: [WS], minSupport: 2, hours: 24 });
    expect(entries.map((e) => `${e.tool_a},${e.tool_b}`)).toEqual(['A,B']);
  });

  it('excludes other workspaces when workspaceIds is set', async () => {
    const { entries } = await toolCooccurrence({ workspaceIds: ['other-ws'], minSupport: 1, hours: 24 });
    expect(entries).toHaveLength(1);
    expect(entries[0].support).toBe(1);
    expect(entries[0].tool_a).toBe('A');
    expect(entries[0].tool_b).toBe('B');
  });
});
