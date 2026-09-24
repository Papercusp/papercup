// @vitest-environment node
/**
 * adv-sessions-resumable-ordering.integration.test.ts — `listResumableSessions` orders by
 * ACTIVITY and guarantees every backend a place, proven against a REAL, fully-migrated
 * `harness_shared` schema.
 *
 * WHY REAL PG (and why no fake-`sql` unit test can replace this): the entire fix is SQL
 * semantics. The ordering key is a GREATEST over three tables and the per-agent guarantee is a
 * pair of window functions — a mocked `sql` hands back whatever rows the test author already
 * decided on, so it can assert the query TEXT but never that the query SELECTS THE RIGHT ROWS.
 * Both defects this pins down shipped green under exactly that kind of coverage.
 *
 * The two defects (owner report 2026-08-12, WI-38226 — "psu --resume is not listing any codex
 * sessions... there were active codex sessions in that window"):
 *
 *  1. ORDERED BY THE WRONG COLUMN. `ORDER BY started_at DESC` looks like a recency sort but
 *     `started_at` is mutable — resume claim/activity-repair paths bump it to now() when an ended row
 *     comes back — so it means "last (re)activation". A session that has been running and busy
 *     for hours never reactivates, so it sorts BELOW one that resumed a minute ago and did
 *     nothing since. Measured live at the time: 53 of the 74 codex sessions active within the
 *     past hour ranked outside the top 30 by `started_at`, the worst at rank 233.
 *  2. AGENT-BLIND WINDOW. A flat `LIMIT n` across 13.3k claude / 1.1k codex / 261 omp rows is a
 *     lottery the quiet backends lose, and the picker renders the survivors with no hint that a
 *     whole CLI was withheld.
 *
 * Each test seeds the population that MAKES the old query wrong, so a revert fails here rather
 * than passing and reaching the owner's terminal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { listResumableSessions } from './adv-sessions';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WS = 'resumable-ordering-it';

/**
 * listResumableSessions is deliberately CROSS-WORKSPACE (you may want to resume a session from
 * another workspace), so it cannot be scoped away from other files' rows — hence a full clear of
 * the three tables it reads. That is the established contract of this fixture, which serializes
 * its consumers behind a session-level advisory lock precisely so a global clear is safe.
 */
async function cleanup(): Promise<void> {
  await admin`DELETE FROM harness_shared.adv_sessions`;
  await admin`DELETE FROM harness_shared.coord_presence`;
  await admin`DELETE FROM harness_shared.tool_invocations`;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
  await cleanup();
}, 120_000);
afterAll(async () => {
  await cleanup().catch(() => {});
  await fx.dispose();
});
beforeEach(cleanup);

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

/** A tracked, resumable-shaped session row (agent + cwd + delivered port). */
async function seedSession(o: {
  agent: 'claude' | 'codex' | 'omp';
  owner: string;
  startedMinAgo: number;
  endedMinAgo?: number;
}): Promise<number> {
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, agent, cwd, coord_owner_id, started_at, ended_at)
    VALUES (${WS}, 'console', ${o.agent}, '/repo', ${o.owner}, ${ago(o.startedMinAgo)},
            ${o.endedMinAgo == null ? null : ago(o.endedMinAgo)})
    RETURNING id
  `;
  // `id` is a bigint: this admin client hands it back as a STRING while the store's own client
  // parses it to a number, so an uncoerced compare fails on type alone ('137' vs 137) — a
  // failure that reads exactly like "the row is missing from the result".
  return Number(row!.id);
}

/** A tool call by this session's owner — the durable "it was working" evidence. */
async function seedToolCall(owner: string, minAgo: number): Promise<void> {
  await admin`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
       coord_owner_id, invoked_at)
    VALUES (${WS}, 'h', 'p', 'some:verb', 'su', 'spawn', 'w', 'ok', ${owner}, ${ago(minAgo)})
  `;
}

async function seedPresence(owner: string, lastActiveMinAgo: number): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, last_active_at)
    VALUES (${owner}, ${WS}, ${ago(lastActiveMinAgo)})
  `;
}

describe('listResumableSessions orders by activity, not by started_at', () => {
  it('ranks a long-running BUSY session above idle ones that merely started later', async () => {
    // The exact shape of the owner's report: a codex session launched hours ago and working
    // ever since, buried under a pile of claude sessions launched minutes ago that have done
    // nothing. `started_at` orders these backwards; activity orders them correctly.
    const busy = await seedSession({ agent: 'codex', owner: 'su-busy', startedMinAgo: 600 });
    await seedToolCall('su-busy', 1);
    for (let i = 0; i < 10; i++) {
      await seedSession({ agent: 'claude', owner: `su-idle-${i}`, startedMinAgo: 5 + i });
    }

    const rows = await listResumableSessions(30);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(busy);
    // FIRST — it is the only session that has done anything at all.
    expect(ids[0]).toBe(busy);
    // And the row says so: last-active is ~now even though it started 10h ago.
    const busyRow = rows.find((r) => r.id === busy)!;
    expect(Date.parse(busyRow.lastActiveAt!)).toBeGreaterThan(Date.parse(busyRow.startedAt));
  });

  it('a busy session survives a limit that a started_at sort would have evicted it from', async () => {
    // THE REGRESSION THAT REACHED THE OWNER. 30 sessions started after the busy one, so under
    // `ORDER BY started_at DESC LIMIT 30` the busy session is rank 31 — off the end of the list,
    // invisible in the picker, despite being the most recently active thing on the box.
    const busy = await seedSession({ agent: 'codex', owner: 'su-busy', startedMinAgo: 600 });
    await seedToolCall('su-busy', 1);
    for (let i = 0; i < 30; i++) {
      await seedSession({ agent: 'claude', owner: `su-fresh-${i}`, startedMinAgo: 10 + i });
    }

    const rows = await listResumableSessions(30);
    expect(rows.map((r) => r.id)).toContain(busy);
  });

  it('takes the NEWEST of presence and tool-call evidence, and falls back to started_at', async () => {
    // GREATEST, not COALESCE/priority: each source is a lower bound that can be stale or missing
    // on its own. presence-only and tool-only sessions both have to rank on their real activity,
    // and a session with neither must still appear (at its started_at) rather than sort as NULL.
    const presenceOnly = await seedSession({ agent: 'claude', owner: 'su-p', startedMinAgo: 500 });
    await seedPresence('su-p', 2);
    const toolOnly = await seedSession({ agent: 'claude', owner: 'su-t', startedMinAgo: 500 });
    await seedToolCall('su-t', 3);
    // Stale presence + fresh tool call: the fresher evidence must win, or a TTL-refreshed-then-
    // abandoned presence row would outrank a session that is genuinely still working.
    const both = await seedSession({ agent: 'claude', owner: 'su-b', startedMinAgo: 500 });
    await seedPresence('su-b', 400);
    await seedToolCall('su-b', 1);
    const neither = await seedSession({ agent: 'claude', owner: 'su-n', startedMinAgo: 4 });

    const rows = await listResumableSessions(30);
    expect(rows.map((r) => r.id)).toEqual([both, presenceOnly, toolOnly, neither]);

    // The no-evidence row degrades to started_at rather than dropping out or going null.
    const neitherRow = rows.find((r) => r.id === neither)!;
    expect(neitherRow.lastActiveAt).toBe(neitherRow.startedAt);
  });

  it('surfaces an ENDED session at its activity, and keeps it resumable', async () => {
    // Resume revives ended rows, so they belong in the list — ranked by when they were last
    // working, not by the reactivation-stamped started_at.
    const ended = await seedSession({
      agent: 'omp', owner: 'su-ended', startedMinAgo: 300, endedMinAgo: 200,
    });
    await seedToolCall('su-ended', 210);
    const rows = await listResumableSessions(30);
    expect(rows.map((r) => r.id)).toContain(ended);
    expect(rows.find((r) => r.id === ended)!.endedAt).toBeTruthy();
  });
});

describe('listResumableSessions guarantees every backend a place', () => {
  it('keeps codex and omp visible when claude floods the window', async () => {
    // The population that produced the report: claude outnumbers everything, so a flat top-N
    // returns claude and nothing else. Every claude row here is more recently active than every
    // codex/omp row, so ONLY the per-agent floor can rescue them — this cannot pass by accident.
    for (let i = 0; i < 60; i++) {
      const owner = `su-claude-${i}`;
      await seedSession({ agent: 'claude', owner, startedMinAgo: 100 });
      await seedToolCall(owner, 1 + i * 0.01);
    }
    for (let i = 0; i < 3; i++) {
      await seedSession({ agent: 'codex', owner: `su-codex-${i}`, startedMinAgo: 200 + i });
      await seedSession({ agent: 'omp', owner: `su-omp-${i}`, startedMinAgo: 300 + i });
    }

    const rows = await listResumableSessions(30);
    const byAgent = (a: string) => rows.filter((r) => r.agent === a).length;

    expect(byAgent('codex')).toBe(3);
    expect(byAgent('omp')).toBe(3);
    // The global slice is still honored for the dominant backend — the floor ADDS rows for the
    // starved backends, it does not ration the busy one down to the floor.
    expect(byAgent('claude')).toBeGreaterThanOrEqual(30);
  });

  it('caps each backend at the floor rather than returning its whole history', async () => {
    // The floor is a guarantee, not an unbounded per-agent fetch: a backend with hundreds of
    // sessions must not drag them all into a picker the human has to scroll.
    for (let i = 0; i < 40; i++) {
      await seedSession({ agent: 'omp', owner: `su-omp-${i}`, startedMinAgo: 100 + i });
    }
    // limit 1 isolates the floor: exactly one row can come from the global slice.
    const rows = await listResumableSessions(1, { perAgentFloor: 12 });
    expect(rows.filter((r) => r.agent === 'omp')).toHaveLength(12);
  });

  it('orders the whole result by activity even across the floor rows', async () => {
    // The floor decides WHICH rows are included; it must not disturb the ordering of the result,
    // or a floor row lands mid-list at the wrong age and the picker's ages stop descending.
    for (let i = 0; i < 20; i++) {
      const owner = `su-c-${i}`;
      await seedSession({ agent: 'claude', owner, startedMinAgo: 500 });
      await seedToolCall(owner, 10 + i);
    }
    const codexOwner = 'su-x';
    await seedSession({ agent: 'codex', owner: codexOwner, startedMinAgo: 500 });
    await seedToolCall(codexOwner, 15); // lands in the MIDDLE of the claude run

    const rows = await listResumableSessions(5);
    const times = rows.map((r) => Date.parse(r.lastActiveAt!));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(rows.map((r) => r.agent)).toContain('codex');
  });
});

describe('listResumableSessions exact tracked-row recovery', () => {
  it('includes one explicitly requested old row without widening the recent-ended scan', async () => {
    const old = await seedSession({
      agent: 'claude',
      owner: 'su-old-explicit',
      startedMinAgo: 10_000,
      endedMinAgo: 9_000,
    });
    const recent = await seedSession({
      agent: 'claude',
      owner: 'su-recent-control',
      startedMinAgo: 5,
      endedMinAgo: 1,
    });

    // scanLimit:1 excludes `old` from the normal candidate pool. exactId must
    // add only that row while the ordinary global limit still selects `recent`.
    const rows = await listResumableSessions(1, {
      perAgentFloor: 0,
      scanLimit: 1,
      exactId: old,
    });

    expect(rows.map((row) => row.id)).toEqual([recent, old]);
  });
});

describe('listResumableSessions port filtering without whole-row serialization', () => {
  it('excludes pending and failed ports from every candidate arm, including exact-id recovery', async () => {
    const delivered = await seedSession({ agent: 'codex', owner: 'su-delivered', startedMinAgo: 3 });
    const pendingLive = await seedSession({ agent: 'claude', owner: 'su-pending-live', startedMinAgo: 1 });
    const pendingEnded = await seedSession({ agent: 'omp', owner: 'su-pending-ended', startedMinAgo: 2, endedMinAgo: 1 });
    const failed = await seedSession({ agent: 'claude', owner: 'su-failed', startedMinAgo: 4 });
    await admin`UPDATE harness_shared.adv_sessions SET port_status = 'pending' WHERE id IN (${pendingLive}, ${pendingEnded})`;
    await admin`UPDATE harness_shared.adv_sessions SET port_status = 'failed' WHERE id = ${failed}`;
    // The picker deliberately spans workspaces; the optimization must preserve that scope.
    await admin`UPDATE harness_shared.adv_sessions SET workspace_id = 'other-resumable-workspace' WHERE id = ${delivered}`;
    for (const exactId of [pendingLive, pendingEnded, failed]) {
      expect((await listResumableSessions(30, { exactId })).map((row) => row.id)).toEqual([delivered]);
    }
  });

  it('works before the port column exists and immediately observes its later availability', async () => {
    const pending = await seedSession({ agent: 'codex', owner: 'su-rollout', startedMinAgo: 1 });
    await admin`UPDATE harness_shared.adv_sessions SET port_status = 'pending' WHERE id = ${pending}`;
    // This suite holds the baseline schema mutex. Rename preserves the column and its
    // constraints while exercising a real parse-time absence, then restore in finally.
    await admin`ALTER TABLE harness_shared.adv_sessions RENAME COLUMN port_status TO port_status_rollout_test`;
    try {
      expect((await listResumableSessions()).map((row) => row.id)).toEqual([pending]);
    } finally {
      await admin`ALTER TABLE harness_shared.adv_sessions RENAME COLUMN port_status_rollout_test TO port_status`;
    }
    expect(await listResumableSessions()).toEqual([]);
  });

  it('measures the candidate filter on the same large-launch-payload fixture', async () => {
    await admin`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, agent, cwd, coord_owner_id, started_at, ended_at, launch_spec)
      SELECT ${WS}, 'console', 'codex', '/repo', 'su-filter-' || i,
             now() - i * interval '1 minute', now() - i * interval '1 minute',
             jsonb_build_object('v', 1, 'workspaceId', ${WS}::text, 'harnessSlug', 'papercusp',
                                'benchmarkPayload', repeat(md5(i::text), 512))
        FROM generate_series(1, 1000) i
    `;
    const legacy = () => admin`
      SELECT a.id FROM harness_shared.adv_sessions a
       WHERE a.agent IS NOT NULL AND a.cwd IS NOT NULL
         AND COALESCE(to_jsonb(a)->>'port_status', 'delivered') = 'delivered'
       ORDER BY GREATEST(a.started_at, COALESCE(a.ended_at, a.started_at)) DESC LIMIT 300
    `;
    const direct = () => admin`
      SELECT a.id FROM harness_shared.adv_sessions a
       WHERE a.agent IS NOT NULL AND a.cwd IS NOT NULL
         AND COALESCE(a.port_status, 'delivered') = 'delivered'
       ORDER BY GREATEST(a.started_at, COALESCE(a.ended_at, a.started_at)) DESC LIMIT 300
    `;
    expect(await direct()).toEqual(await legacy());
    const timings: Record<'legacy' | 'direct', number[]> = { legacy: [], direct: [] };
    // Alternate order to avoid assigning all cold/early effects to one variant.
    for (let i = 0; i < 100; i++) {
      for (const mode of (i % 2 ? ['direct', 'legacy'] : ['legacy', 'direct']) as Array<'legacy' | 'direct'>) {
        const start = performance.now();
        await (mode === 'legacy' ? legacy() : direct());
        timings[mode].push(performance.now() - start);
      }
    }
    const p50 = (values: number[]) => [...values].sort((a, b) => a - b)[50];
    console.info('RESUMABLE_FILTER_BENCHMARK', JSON.stringify({
      rows: 1000, payloadChars: 16384, callsPerMode: 100,
      p50Ms: { legacy: p50(timings.legacy), direct: p50(timings.direct) },
    }));
    // Exercise the actual listing too: both limits and persisted harness scope survive.
    const rows = await listResumableSessions(30);
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.harnessSlug === 'papercusp')).toBe(true);
    const burst = await Promise.all(Array.from({ length: 8 }, () => listResumableSessions(30)));
    for (const concurrentRows of burst) expect(concurrentRows).toEqual(rows);
  }, 120_000);
});
