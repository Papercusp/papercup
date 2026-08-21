/**
 * tool_cooccurrence.integration.test.ts — the dev:tool_cooccurrence miner's
 * SQL against real Postgres. Verifies pairwise co-occurrence support /
 * confidence / lift, the MCP-transport filter (HTTP/ipc rows excluded), the
 * minSupport noise floor, per-turn DISTINCT counting, the burst gap, and the
 * workspace filter.
 *
 * Routes through getOrgPg().sql (raw postgres-js), mocked to the fixture's
 * admin client — the established org-fixture pattern (see brain-pin.integration).
 *
 * Part of tool-call-batching-wrappers-2026-06-21 P-001; re-keyed onto agent
 * decision bursts by okf-frontmatter §D (WI-36875).
 *
 * ⚠ REGRESSION CONTROL — do not "simplify" the fixture by giving the tools in a
 * burst a shared spawn_id. EVERY row below carries its OWN spawn_id, because
 * that is precisely what the old `GROUP BY spawn_id` implementation could not
 * handle: spawn_id is a PER-REQUEST id, so under the old code every one of
 * these turns collapses to a single-tool group and the suite yields ZERO pairs.
 * The arithmetic here is identical to the pre-fix fixture's (A=3, B=2, C=1,
 * total=3) on purpose — same expected numbers, reachable only via burst
 * grouping. Collapsing the spawn_ids would make these tests pass against the
 * bug they exist to catch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

const { toolCooccurrence } = await import('../../dev-data');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

const WS = 'ws-cooccur-test';
// Anchor the fixture inside the query's lookback window, far enough from `now()`
// that the offsets below cannot drift past it.
const T0 = Date.now() - 60 * 60 * 1000;

let nextId = 1;
async function seed(
  db: OrgTestDb,
  agent: string,
  tool: string,
  offsetSec: number,
  opts: { transport?: string; ws?: string } = {},
) {
  const at = new Date(T0 + offsetSec * 1000).toISOString();
  // Each row gets a UNIQUE spawn_id — see the regression-control note above.
  const spawn = `sp-${nextId}`;
  await db.adminSql`
    INSERT INTO harness_shared.tool_invocations
      (id, workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
       coord_owner_id, invoked_at, window_key, status, transport)
    VALUES
      (${nextId++}, ${opts.ws ?? WS}, 'h1', 'core', ${tool}, 'worker', ${spawn},
       ${agent}, ${at}::timestamptz, 'w', 'ok', ${opts.transport ?? 'mcp'})`;
}

describe('toolCooccurrence (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // Agent ag1, three decision bursts separated by >120s idle gaps:
    //   burst 1 (t+0):    A, B        burst 2 (t+600): A, B, C
    //   burst 3 (t+1200): A (single tool, no pair)
    // ⇒ pairs: (A,B) support=2; (A,C) support=1; (B,C) support=1
    //   marginals: A=3, B=2, C=1; total_turns=3
    await seed(db, 'ag1', 'A', 0);
    await seed(db, 'ag1', 'B', 10);
    await seed(db, 'ag1', 'A', 600);
    await seed(db, 'ag1', 'B', 610);
    await seed(db, 'ag1', 'C', 620);
    await seed(db, 'ag1', 'A', 1200);
    // Non-MCP rows that MUST be ignored (else a bogus (A,Z) pair appears):
    await seed(db, 'ag1', 'A', 1800, { transport: 'http' });
    await seed(db, 'ag1', 'Z', 1810, { transport: 'http' });
    // A different-workspace MCP pair (excluded when workspaceIds filters to WS):
    await seed(db, 'ag2', 'A', 0, { ws: 'other-ws' });
    await seed(db, 'ag2', 'B', 10, { ws: 'other-ws' });
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('computes support / confidence / lift for a co-occurring pair (MCP + workspace scoped)', async () => {
    const { totalTurns, entries } = await toolCooccurrence({ workspaceIds: [WS], minSupport: 1, hours: 24 });
    expect(totalTurns).toBe(3); // 3 bursts — http rows + other-ws excluded

    const ab = entries.find((e) => e.tool_a === 'A' && e.tool_b === 'B');
    expect(ab).toBeDefined();
    expect(ab!.support).toBe(2);
    expect(ab!.turns_a).toBe(3); // A in all 3 bursts
    expect(ab!.turns_b).toBe(2); // B in bursts 1,2
    expect(ab!.confidence).toBeCloseTo(1.0, 3); // support / min(3,2) = 2/2
    expect(ab!.lift).toBeCloseTo(1.0, 3); // support*total/(a*b) = 2*3/(3*2)

    // Z only ever appears on non-MCP rows ⇒ never referenced.
    expect(entries.some((e) => e.tool_a === 'Z' || e.tool_b === 'Z')).toBe(false);
  });

  it('pairs tools that share a BURST but not a spawn_id (the spawn-grouping regression)', async () => {
    // Every fixture row has a distinct spawn_id, so this is exactly the case the
    // old `GROUP BY spawn_id` implementation reported as zero.
    const { entries } = await toolCooccurrence({ workspaceIds: [WS], minSupport: 1, hours: 24 });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => `${e.tool_a},${e.tool_b}`).sort()).toEqual(['A,B', 'A,C', 'B,C']);
  });

  it('splits a burst when the idle gap exceeds gapSec', async () => {
    // burst 2's rows are 10s apart; gapSec=5 splits every row into its own turn,
    // so no two tools share a turn and every pair disappears.
    const { totalTurns, entries } = await toolCooccurrence({
      workspaceIds: [WS], minSupport: 1, hours: 24, gapSec: 5,
    });
    expect(totalTurns).toBe(6); // one turn per invocation
    expect(entries).toEqual([]);
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
