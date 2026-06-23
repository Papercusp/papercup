/**
 * work-items-stale-claims.integration.test.ts — the dead-holder claim sweep
 * (owner-reported gap 2026-06-11) against real Postgres. Liveness must match
 * the mig-225 alias-aware rule exactly: coord_presence heartbeat OR a
 * RUNNING/RESTARTING spawned_agents row matched on ANY alias.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { reclaimStaleWorkItemClaims, reclaimStaleIssueClaims } from './work-items-stale-claims';

const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text PRIMARY KEY,
    heartbeat_at timestamptz
  )`;
const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    session_owner text,
    run_id text,
    status text NOT NULL,
    heartbeat_at timestamptz,
    finished_at timestamptz,
    cancelled_at timestamptz
  )`;
const ENGINEER_ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default',
    issue_id text NOT NULL,
    kind text, scope text, title text, body text, severity text, source text, state text,
    assignee text, assigned_by text, assigned_at timestamptz, payload jsonb,
    found_during text, linked_feature_id text, created_by text, signal_origin text,
    created_at timestamptz, updated_at timestamptz, origin text DEFAULT 'local',
    PRIMARY KEY (workspace_id, issue_id))`;

let db: FreshPgDb;
let sql: postgres.Sql;
const WS = 'default';
const H = 'papercup';

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // claim path's P-005 readiness clause reads work_item_deps
  await sql.unsafe(PRESENCE_DDL);
  await sql.unsafe(SPAWNED_DDL);
  await sql.unsafe(ENGINEER_ISSUES_DDL);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.work_items, harness_shared.coord_presence, harness_shared.spawned_agents`;
});

async function seedIssue(
  issueId: string,
  kind: string,
  assignee: string | null,
  assignedAgoMin: number,
  state = 'open',
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, kind, scope, title, state, assignee, assigned_by, assigned_at, created_at, updated_at)
    VALUES
      (${WS}, ${issueId}, ${kind}, 'operator', ${issueId}, ${state}, ${assignee},
       ${kind === 'task' ? 'operator' : null},
       ${assignee ? sql`now() - make_interval(mins => ${assignedAgoMin})` : null}, now(), now())`;
}

async function assigneeOf(issueId: string): Promise<string | null> {
  const [row] = await sql<{ assignee: string | null }[]>`
    SELECT assignee FROM harness_shared.engineer_issues WHERE issue_id = ${issueId}`;
  return row?.assignee ?? null;
}

async function seedItem(
  featureId: string,
  takenBy: string | null,
  takenAgoMin: number,
  status = 'todo',
  requeueCount = 0,
  lastProgressAgoMin: number | null = null,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, item_kind, title, status, requeue_count, taken_by, taken_at, last_progress_at, created_ts, updated_ts)
    VALUES
      (${WS}, ${H}, ${featureId}, 'feature', ${featureId}, ${status}, ${requeueCount}, ${takenBy},
       ${takenBy ? sql`now() - make_interval(mins => ${takenAgoMin})` : null},
       ${lastProgressAgoMin == null ? null : sql`now() - make_interval(mins => ${lastProgressAgoMin})`},
       ${Date.now()}, ${Date.now()})`;
}

/** Seed a spawned_agents row. status defaults to a terminal 'failed'; finishedAgoMin
 *  controls finished_at (recency bound for the spawn-exit leg). */
async function seedSpawn(
  spawnId: string,
  aliases: { sessionOwner?: string; runId?: string } = {},
  status = 'failed',
  finishedAgoMin = 1,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at, finished_at)
    VALUES (${spawnId}, ${aliases.sessionOwner ?? spawnId}, ${aliases.runId ?? null}, ${status},
            now() - interval '20 minutes', now() - make_interval(mins => ${finishedAgoMin}))`;
}

async function statusOf(featureId: string): Promise<{ status: string; requeue_count: number; taken_by: string | null }> {
  const [row] = await sql<{ status: string; requeue_count: number; taken_by: string | null }[]>`
    SELECT status, requeue_count, taken_by
      FROM harness_shared.harness_features_consolidated WHERE feature_id = ${featureId}`;
  return row;
}

describe('reclaimStaleWorkItemClaims', () => {
  it('releases a claim whose holder has no presence and no nursery row (the dead-bee case)', async () => {
    await seedItem('F-001', 'opspawn-dead-123', 30);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-001',
      former_taken_by: 'opspawn-dead-123',
      former_status: 'todo',
      new_status: 'todo',
      action: 'freed-todo',
    });
    const [row] = await sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id = 'F-001'`;
    expect(row.taken_by).toBeNull();
  });

  it('a holder with a FRESH presence heartbeat is alive — claim kept', async () => {
    await seedItem('F-002', 'su-alive-1', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-1', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('a holder matching a RUNNING nursery row on ANY alias is alive (mig-225 rule)', async () => {
    // taken_by = the RUN ID alias (the EI-311 degraded-bee case), not the spawn_id.
    await seedItem('F-003', 'opspawn-1786-abc', 30);
    await sql`
      INSERT INTO harness_shared.spawned_agents VALUES
        ('s-xyz', 's-xyz', 'opspawn-1786-abc', 'running', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('a nursery row that is NOT running does not confer liveness — claim released', async () => {
    await seedItem('F-004', 's-finished', 30);
    await sql`
      INSERT INTO harness_shared.spawned_agents VALUES
        ('s-finished', 's-finished', 'opspawn-x', 'failed', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-004']);
  });

  it('a stale-heartbeat presence row does not confer liveness — claim released', async () => {
    await seedItem('F-005', 'su-stale', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-stale', now() - interval '1 hour')`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-005']);
  });

  it('claims inside the grace window are NEVER touched, even with a dead holder', async () => {
    await seedItem('F-006', 'opspawn-justdied', 2); // 2 min < 10 min grace
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  // EI-2534 (the stranded-orphan class): a dead-holder claim with NO taken_at
  // anchor. The fleet_assignment view flags it `orphaned` off taken_by alone (it
  // requires no taken_at), but the OLD DEAD leg required taken_at IS NOT NULL, so
  // such a row read orphaned forever yet never reaped — 7 P1 items stranded ~3h.
  // A NULL taken_at must count as past grace: the dead-holder signal alone frees it.
  it('a dead-holder claim with NULL taken_at is freed (EI-2534 strand class)', async () => {
    await seedItem('F-014', 'su-dead-noanchor', 30);
    // Strip the claim-time anchor — taken_by stays set (the orphaned-but-no-anchor row).
    await sql`UPDATE harness_shared.harness_features_consolidated
                 SET taken_at = NULL WHERE feature_id = 'F-014'`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-014',
      former_taken_by: 'su-dead-noanchor',
      reason: 'dead',
      action: 'freed-todo',
    });
    expect((await statusOf('F-014')).taken_by).toBeNull();
  });

  it('a mid-flight NULL-taken_at dead-holder claim is requeued → todo (EI-2534)', async () => {
    await seedItem('F-015', 'su-dead-noanchor2', 30, 'in_progress');
    await sql`UPDATE harness_shared.harness_features_consolidated
                 SET taken_at = NULL WHERE feature_id = 'F-015'`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ feature_id: 'F-015', reason: 'dead', new_status: 'todo', action: 'requeued' });
    expect(await statusOf('F-015')).toMatchObject({ status: 'todo', taken_by: null });
  });

  it('a NULL-taken_at claim held by a LIVE holder is NOT freed (no anchor must not over-reclaim)', async () => {
    await seedItem('F-016', 'su-alive-noanchor', 30);
    await sql`UPDATE harness_shared.harness_features_consolidated
                 SET taken_at = NULL WHERE feature_id = 'F-016'`;
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-noanchor', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-016')).taken_by).toBe('su-alive-noanchor');
  });

  it('a mid-flight (in_progress) row is REQUEUED → todo and re-enters the pool (GAP 1, P-001)', async () => {
    await seedItem('F-007', 'opspawn-dead-mid', 30, 'in_progress');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-007',
      former_status: 'in_progress',
      new_status: 'todo',
      action: 'requeued',
      requeue_count: 1,
    });
    expect(await statusOf('F-007')).toMatchObject({ status: 'todo', requeue_count: 1, taken_by: null });
  });

  it('a `validating` row is also requeued (any non-terminal, non-blocked state)', async () => {
    await seedItem('F-007b', 'opspawn-dead-val', 30, 'validating');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'validating', new_status: 'todo', action: 'requeued' });
  });

  it('the requeue counter increments each sweep until the cap, then DEAD-LETTERS to blocked (P-002, D-007)', async () => {
    // Seed already at cap-1 (default cap 3 → requeue_count 2): the next reclaim is
    // the 3rd, which exhausts the cap and parks the poison item in `blocked`.
    await seedItem('F-010', 'opspawn-dead-poison', 30, 'in_progress', 2);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-010',
      former_status: 'in_progress',
      new_status: 'blocked',
      action: 'dead-lettered',
      requeue_count: 3,
    });
    expect(await statusOf('F-010')).toMatchObject({ status: 'blocked', requeue_count: 3 });
  });

  it('honors a custom requeueCap option', async () => {
    await seedItem('F-011', 'opspawn-dead-cap1', 30, 'in_progress', 0);
    const r = await reclaimStaleWorkItemClaims(sql, { requeueCap: 1 });
    // cap 1 → first reclaim already exhausts it.
    expect(r.released[0]).toMatchObject({ new_status: 'blocked', action: 'dead-lettered', requeue_count: 1 });
  });

  it('a TERMINAL (passed) row is freed but NOT requeued or re-broadcast (the F-FIX-038 fix)', async () => {
    await seedItem('F-012', 'opspawn-dead-done', 30, 'passed', 0);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'passed', new_status: 'passed', action: 'freed-terminal' });
    expect(await statusOf('F-012')).toMatchObject({ status: 'passed', taken_by: null });
  });

  it('a `deprecated` row is freed but kept terminal', async () => {
    await seedItem('F-012b', 'opspawn-dead-dep', 30, 'deprecated', 0);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'deprecated', new_status: 'deprecated', action: 'freed-terminal' });
  });

  it('a `blocked` row is freed but kept blocked (its own delegator-notify signal path)', async () => {
    await seedItem('F-013', 'opspawn-dead-blk', 30, 'blocked', 1);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'blocked', new_status: 'blocked', action: 'freed-blocked' });
    // requeue_count untouched for a blocked freed row.
    expect(await statusOf('F-013')).toMatchObject({ status: 'blocked', requeue_count: 1, taken_by: null });
  });

  it('untaken rows are ignored', async () => {
    await seedItem('F-008', null, 0);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('the freed item is immediately claimable again by a live agent', async () => {
    await seedItem('F-009', 'opspawn-dead-9', 30);
    await reclaimStaleWorkItemClaims(sql);
    const updated = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET taken_by = 'opspawn-new-bee', taken_at = now()
       WHERE feature_id = 'F-009' AND (taken_by IS NULL OR taken_by = '')
       RETURNING feature_id`;
    expect(updated).toHaveLength(1);
  });

  // ── agent-activity-liveness-truth P-003/P-007: spawn-death → IMMEDIATE release ──
  // The incident: a gate-fix bee DIED but its claim sat owned ~1h. A confirmed-
  // terminal spawn's claim must free NOW, not after the 10-min grace.
  it('spawn-exit: a confirmed-terminal spawn frees its claim IMMEDIATELY, inside the grace window', async () => {
    // Claimed only 2 min ago (well inside the 10-min grace) — the DEAD leg would NOT
    // touch it — but its spawn is `failed`, so the spawn-exit leg frees it now.
    await seedItem('F-SE1', 'opspawn-dead-bee', 2);
    await seedSpawn('opspawn-dead-bee', {}, 'failed', 1);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({ feature_id: 'F-SE1', reason: 'spawn-exit', new_status: 'todo' });
    expect((await statusOf('F-SE1')).taken_by).toBeNull();
  });

  it('spawn-exit: matches on ANY alias (taken_by = the run_id of the terminal spawn)', async () => {
    await seedItem('F-SE2', 'opspawn-1900-run', 1, 'in_progress');
    await seedSpawn('s-bee-x', { sessionOwner: 's-bee-x', runId: 'opspawn-1900-run' }, 'cancelled', 1);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ feature_id: 'F-SE2', reason: 'spawn-exit', new_status: 'todo' });
  });

  it('spawn-exit: bounded to recent — a spawn terminal >1h ago does NOT force-free a within-grace claim', async () => {
    await seedItem('F-SE3', 'opspawn-old-dead', 2); // within grace → DEAD leg won't fire
    await seedSpawn('opspawn-old-dead', {}, 'failed', 90); // finished 90 min ago → outside the 1h bound
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0); // neither leg fires
  });

  // ── agent-activity-liveness-truth P-003/P-007: the STALLED leg (flag-gated) ──
  it('stalled: flag OFF (default) — a LIVE holder with stale progress is NOT freed', async () => {
    await seedItem('F-ST1', 'su-alive-stalled', 30, 'in_progress', 0, 30); // last progress 30 min ago
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-stalled', now())`; // alive
    const r = await reclaimStaleWorkItemClaims(sql); // includeStalled defaults false
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-ST1')).taken_by).toBe('su-alive-stalled');
  });

  it('stalled: flag ON — a LIVE holder with stale progress IS freed + requeued (reason stalled)', async () => {
    await seedItem('F-ST2', 'su-alive-stalled2', 30, 'in_progress', 0, 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-stalled2', now())`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-ST2', reason: 'stalled', new_status: 'todo', action: 'requeued' });
    expect((await statusOf('F-ST2')).taken_by).toBeNull();
  });

  it('stalled: flag ON — a LIVE holder making RECENT progress is KEPT (not falsely stalled)', async () => {
    await seedItem('F-ST3', 'su-progressing', 30, 'in_progress', 0, 1); // progressed 1 min ago
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-progressing', now())`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released).toHaveLength(0);
  });

  it('stalled: flag ON — a fresh claim with no progress yet gets the grace window (taken_at fallback)', async () => {
    await seedItem('F-ST4', 'su-fresh', 2, 'in_progress', 0, null); // claimed 2 min ago, no progress yet
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-fresh', now())`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released).toHaveLength(0); // COALESCE(last_progress_at, taken_at) is recent → not stalled
  });

  it('stalled: flag ON — improvement-runner (parked routine lane) is EXEMPT', async () => {
    await seedItem('F-ST5', 'improvement-runner', 30, 'in_progress', 0, 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('improvement-runner', now())`;
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true });
    expect(r.released).toHaveLength(0);
  });

  it('stalled honors a custom stalledMs window', async () => {
    await seedItem('F-ST6', 'su-alive-window', 30, 'in_progress', 0, 8); // progress 8 min ago
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-window', now())`;
    // 8-min-old progress is INSIDE the default 10-min window (kept) but OUTSIDE a 5-min window (freed).
    expect((await reclaimStaleWorkItemClaims(sql, { includeStalled: true })).released).toHaveLength(0);
    const r = await reclaimStaleWorkItemClaims(sql, { includeStalled: true, stalledMs: 5 * 60_000 });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-ST6', reason: 'stalled' });
  });
});

describe('reclaimStaleIssueClaims (issue-family reaper, GAP 2 / P-005 / D-009)', () => {
  it('a dead-holder OPEN bug → assignee cleared, returned to the open pool', async () => {
    await seedIssue('EI-1', 'bug', 'opspawn-dead-bug', 30);
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({ issue_id: 'EI-1', kind: 'bug', former_assignee: 'opspawn-dead-bug' });
    expect(await assigneeOf('EI-1')).toBeNull();
  });

  it('a dead-holder OPEN change → assignee cleared', async () => {
    await seedIssue('EI-2', 'change', 'opspawn-dead-chg', 30);
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released.map((c) => c.issue_id)).toEqual(['EI-2']);
    expect(await assigneeOf('EI-2')).toBeNull();
  });

  it('a `task` (delegate) issue is NEVER reaped — a durable conversational binding (D-009)', async () => {
    // Stale assigned_at + a dead holder: a bug here WOULD be reaped, but a task must NOT be.
    await seedIssue('EI-3', 'task', 'delegate:sess-abc', 999);
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
    expect(await assigneeOf('EI-3')).toBe('delegate:sess-abc');
  });

  it('resolved / closed issues are untouched even with a dead holder', async () => {
    await seedIssue('EI-4', 'bug', 'opspawn-dead-resolved', 30, 'resolved');
    await seedIssue('EI-5', 'bug', 'opspawn-dead-closed', 30, 'closed');
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
    expect(await assigneeOf('EI-4')).toBe('opspawn-dead-resolved');
    expect(await assigneeOf('EI-5')).toBe('opspawn-dead-closed');
  });

  it('alias-aware liveness parity with the feature path: a RUNNING nursery alias keeps the claim', async () => {
    await seedIssue('EI-6', 'bug', 'opspawn-1900-xyz', 30);
    await sql`INSERT INTO harness_shared.spawned_agents VALUES ('s-bee', 's-bee', 'opspawn-1900-xyz', 'running', now())`;
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
    expect(await assigneeOf('EI-6')).toBe('opspawn-1900-xyz');
  });

  it('a fresh coord_presence heartbeat keeps the claim; claims inside grace are untouched', async () => {
    await seedIssue('EI-7', 'bug', 'su-alive-issue', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-issue', now())`;
    await seedIssue('EI-8', 'bug', 'opspawn-justclaimed', 2); // inside 10-min grace
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('unassigned open issues are ignored', async () => {
    await seedIssue('EI-9', 'bug', null, 0);
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
  });
});
