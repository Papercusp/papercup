/**
 * tool-sequence-patterns.integration.test.ts — the parts of the miner that live in
 * SQL, against real Postgres (okf-frontmatter §D).
 *
 * These cannot be covered by the unit suite: it injects a fake `sql` that ignores
 * the query text entirely and hands back a fixed row array, so the provenance
 * filter and — the reason this file exists — the row cap's DIRECTION are invisible
 * to it. Both are places where the query can be wrong while every unit test passes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { graduateToolSequences } from './tool-sequence-patterns';

const { createOrgTestDb } = await import('../test/_org-test-db');

const DAY = 24 * 3600_000;

describe('tool-sequence mining (real PG)', () => {
  let db: OrgTestDb;
  const ws = 'ws-seq-sql';
  const now = Date.now();
  let n = 0;
  type Row = Record<string, string>;
  const pending: Row[] = [];

  const invoke = (agent: string, tool: string, at: number, transport = 'mcp') => {
    pending.push({
      workspace_id: ws,
      harness_slug: 'h',
      plugin_name: 'agentmcp',
      tool_name: tool,
      role: 'su',
      spawn_id: `sp-${n++}`,
      window_key: 'w',
      invoked_at: new Date(at).toISOString(),
      status: 'ok',
      transport,
      coord_owner_id: agent,
    });
  };

  /** Bulk-insert: the truncation control needs >1000 rows (the maxRows floor). */
  const flush = async () => {
    while (pending.length) {
      const batch = pending.splice(0, 500);
      await db.adminSql`INSERT INTO harness_shared.tool_invocations ${db.adminSql(batch)}`;
    }
  };

  /** A 2-call dance by 3 agents, twice per window, in the given day-windows. */
  const dance = (tools: [string, string], windowsBack: number[]) => {
    for (const wb of windowsBack) {
      const base = now - (wb + 0.5) * DAY;
      for (const agent of ['a1', 'a2', 'a3']) {
        for (let rep = 0; rep < 2; rep++) {
          const t0 = base + rep * 10 * 60_000;
          invoke(agent, tools[0], t0);
          invoke(agent, tools[1], t0 + 3_000);
        }
      }
    }
  };

  beforeAll(async () => {
    db = await createOrgTestDb();
    // RECENT dance: the trailing three windows, so it can graduate.
    dance(['new:one', 'new:two'], [0, 1, 2]);
    // OLD dance: the leading three windows only.
    dance(['old:one', 'old:two'], [4, 5, 6]);
    // Background traffic in every window — it keeps the lift marginals non-degenerate
    // AND supplies the bulk that makes a 1000-row cap actually bite: windows 0–2 alone
    // carry ~756 rows, so the newest 1000 spans exactly the recent dance and no more.
    for (let wb = 0; wb < 7; wb++) {
      const base = now - (wb + 0.8) * DAY;
      for (const agent of ['a1', 'a2', 'a3']) {
        for (let rep = 0; rep < 60; rep++) {
          const t0 = base + rep * 7 * 60_000;
          invoke(agent, 'noise:x', t0);
          invoke(agent, 'noise:y', t0 + 2_000);
        }
      }
    }
    await flush();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const opts = {
    workspaceId: ws,
    windows: 7,
    windowHours: 24,
    minStreak: 3,
    minOccurrences: 4,
    minAgents: 3,
    minLift: 2,
  };

  it('sees both dances when nothing is truncated (fixture control)', async () => {
    const res = await graduateToolSequences(db.adminSql, opts);
    const labels = res.candidates.map((c) => c.label);

    expect(res.stats.truncated).toBe(false);
    expect(labels).toContain('new:one → new:two');
    expect(labels).toContain('old:one → old:two');
    // Only the recent one persists into the trailing windows.
    expect(res.graduated.map((c) => c.label)).toContain('new:one → new:two');
    expect(res.graduated.map((c) => c.label)).not.toContain('old:one → old:two');
  });

  /**
   * REGRESSION CONTROL for a defect measured on live data 2026-08-09.
   *
   * The row cap used to read `ORDER BY invoked_at ASC LIMIT n`, which keeps the
   * OLDEST rows and therefore deletes the TRAILING windows. Graduation counts a
   * streak backwards from the most recent window, so under truncation every
   * candidate scored zero and NOTHING could ever graduate — while a four-figure
   * held list made the miner look healthy and merely picky. Live: 0 graduated /
   * 1,610 held at the 200k cap against 6 / 3,118 uncapped.
   *
   * Under truncation the RECENT dance must survive and the OLD one must be the
   * casualty. This test fails against the old ordering in both directions at once,
   * which is what makes it worth its runtime.
   */
  it('truncation drops the OLDEST rows, never the newest — the streak depends on recency', async () => {
    // Small enough that only the trailing windows fit.
    const res = await graduateToolSequences(db.adminSql, { ...opts, maxRows: 1000 });

    expect(res.stats.truncated).toBe(true);
    const labels = res.candidates.map((c) => c.label);
    expect(labels).toContain('new:one → new:two');
    expect(labels).not.toContain('old:one → old:two');
    // And the whole point: a truncated read can still graduate something.
    expect(res.graduated.map((c) => c.label)).toContain('new:one → new:two');
  });

  it('excludes in_process rows — a tool implementation fan-out is not an agent decision', async () => {
    // A dance recorded ONLY as in_process: it is one tool's internals, and however
    // often it repeats it must never be mined as agent behaviour.
    for (const wb of [0, 1, 2]) {
      const base = now - (wb + 0.3) * DAY;
      for (const agent of ['a1', 'a2', 'a3']) {
        for (let rep = 0; rep < 3; rep++) {
          const t0 = base + rep * 9 * 60_000;
          invoke(agent, 'inner:one', t0, 'in_process');
          invoke(agent, 'inner:two', t0 + 2_000, 'in_process');
        }
      }
    }
    await flush();
    const res = await graduateToolSequences(db.adminSql, opts);
    expect(res.candidates.map((c) => c.label)).not.toContain('inner:one → inner:two');
  });
});
