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

async function seedTaskItem(
  featureId: string,
  takenBy: string | null,
  takenAgoMin: number,
  status = 'todo',
  requeueCount = 0,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, requeue_count, taken_by, taken_at, created_ts, updated_ts)
    VALUES
      (${WS}, ${H}, ${featureId}, 'task', ${featureId}, ${status}, ${requeueCount}, ${takenBy},
       ${takenBy ? sql`now() - make_interval(mins => ${takenAgoMin})` : null},
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

/**
 * WI-1999: mark a holder as locally KNOWN but not live — a STALE presence row
 * (heartbeat 1h ago, far past the 10-min grace). The DEAD leg only reaps holders
 * this node has EVER seen (work_items federate, presence does not — a never-seen
 * holder is possibly a live agent on another hive node). Tests that mean
 * "a local bee that died" seed this; tests that mean "never seen here" don't.
 */
async function markKnown(alias: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.coord_presence VALUES (${alias}, now() - interval '1 hour')
    ON CONFLICT (owner_id) DO NOTHING`;
}

async function statusOf(featureId: string): Promise<{ status: string; requeue_count: number; taken_by: string | null }> {
  const [row] = await sql<{ status: string; requeue_count: number; taken_by: string | null }[]>`
    SELECT status, requeue_count, taken_by
      FROM harness_shared.harness_features_consolidated WHERE feature_id = ${featureId}`;
  return row;
}

async function workItemStatusOf(featureId: string): Promise<{ status: string; requeue_count: number; taken_by: string | null }> {
  const [row] = await sql<{ status: string; requeue_count: number; taken_by: string | null }[]>`
    SELECT status, requeue_count, taken_by
      FROM harness_shared.work_items WHERE feature_id = ${featureId}`;
  return row;
}

describe('reclaimStaleWorkItemClaims', () => {
  it('releases a claim whose holder has a stale presence row and no nursery row (the dead-bee case)', async () => {
    await seedItem('F-001', 'opspawn-dead-123', 30);
    await markKnown('opspawn-dead-123'); // WI-1999: locally KNOWN (stale) — a never-seen holder is skipped
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
    await markKnown('su-dead-noanchor');
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

  // EI-6992: a 'task' item_kind is ISSUE-family (familyOf('task') === 'issue'), so in
  // real production use it only ever carries the issue vocabulary (open/resolved/
  // closed — written by createIssue/setIssueState), never the feature vocabulary
  // (todo/wip/done) these tests used to seed. The reaper must NEVER touch an
  // issue-family row's status — only clear taken_by/taken_at — regardless of what
  // that status is; see the `freed-issue` StaleClaimAction doc for why (the reaper
  // was previously writing feature-vocabulary literals onto these rows, silently
  // corrupting them out of their valid open|resolved|closed vocabulary).
  it('releases an orphaned issue-family (task) row from the canonical work_items table WITHOUT touching its status', async () => {
    await seedTaskItem('WI-TASK-1', 'su-dead-task-holder', 30, 'open');
    await markKnown('su-dead-task-holder');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({
      feature_id: 'WI-TASK-1',
      item_kind: 'task',
      former_status: 'open',
      new_status: 'open',
      former_taken_by: 'su-dead-task-holder',
      reason: 'dead',
      action: 'freed-issue',
    });
    expect(await workItemStatusOf('WI-TASK-1')).toMatchObject({ status: 'open', requeue_count: 0, taken_by: null });
  });

  it('a dead-held issue-family (task) row keeps its status verbatim — never requeued to the feature `todo`/`wip` vocabulary, and requeue_count never increments', async () => {
    await seedTaskItem('WI-TASK-2', 'su-dead-task-holder-2', 30, 'open', 2);
    await markKnown('su-dead-task-holder-2');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'WI-TASK-2',
      item_kind: 'task',
      former_status: 'open',
      new_status: 'open',
      action: 'freed-issue',
      requeue_count: 2,
    });
    expect(await workItemStatusOf('WI-TASK-2')).toMatchObject({ status: 'open', requeue_count: 2, taken_by: null });
  });

  it('a terminal (resolved) issue-family (task) row is freed but its status is untouched (never coerced to a feature terminal literal)', async () => {
    await seedTaskItem('WI-TASK-3', 'su-dead-task-holder-3', 30, 'resolved');
    await markKnown('su-dead-task-holder-3');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'WI-TASK-3',
      item_kind: 'task',
      former_status: 'resolved',
      new_status: 'resolved',
      action: 'freed-issue',
    });
    expect(await workItemStatusOf('WI-TASK-3')).toMatchObject({ status: 'resolved', taken_by: null });
  });

  it('a mid-flight NULL-taken_at dead-holder claim is requeued → todo (EI-2534)', async () => {
    await seedItem('F-015', 'su-dead-noanchor2', 30, 'in_progress');
    await markKnown('su-dead-noanchor2');
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
    await markKnown('opspawn-dead-mid');
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
    await markKnown('opspawn-dead-val');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'validating', new_status: 'todo', action: 'requeued' });
  });

  it('the requeue counter increments each sweep until the cap, then DEAD-LETTERS to blocked (P-002, D-007)', async () => {
    // Seed already at cap-1 (default cap 3 → requeue_count 2): the next reclaim is
    // the 3rd, which exhausts the cap and parks the poison item in `blocked`.
    await seedItem('F-010', 'opspawn-dead-poison', 30, 'in_progress', 2);
    await markKnown('opspawn-dead-poison');
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
    await markKnown('opspawn-dead-cap1');
    const r = await reclaimStaleWorkItemClaims(sql, { requeueCap: 1 });
    // cap 1 → first reclaim already exhausts it.
    expect(r.released[0]).toMatchObject({ new_status: 'blocked', action: 'dead-lettered', requeue_count: 1 });
  });

  it('a TERMINAL (passed) row is freed but NOT requeued or re-broadcast (the F-FIX-038 fix)', async () => {
    await seedItem('F-012', 'opspawn-dead-done', 30, 'passed', 0);
    await markKnown('opspawn-dead-done');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'passed', new_status: 'passed', action: 'freed-terminal' });
    expect(await statusOf('F-012')).toMatchObject({ status: 'passed', taken_by: null });
  });

  it('a `deprecated` row is freed but kept terminal', async () => {
    await seedItem('F-012b', 'opspawn-dead-dep', 30, 'deprecated', 0);
    await markKnown('opspawn-dead-dep');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'deprecated', new_status: 'deprecated', action: 'freed-terminal' });
  });

  it('a `blocked` row is freed but kept blocked (its own delegator-notify signal path)', async () => {
    await seedItem('F-013', 'opspawn-dead-blk', 30, 'blocked', 1);
    await markKnown('opspawn-dead-blk');
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
    await markKnown('opspawn-dead-9');
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

// WI-2689 (reclaim-churn fix): a holder whose keepalive lapsed but whose coord_presence
// row still beat RECENTLY (within the parked grace, past the short live window) is a
// loop-dropped member about to be re-armed, NOT a dead one. Reaping its claim at the bare
// live grace produced the claim→release→reclaim ping-pong that dominated the dedup/churn
// ratio (WI-2118 reclaimed 3x+). The parked grace holds such a holder back until its beat
// ages past the window — protecting the resumable, still promptly reaping the truly dead.
describe('WI-2689 parked-grace (reclaim-churn fix)', () => {
  it('feature reaper: a holder that BEAT within the parked grace is NOT reaped, even past the live window', async () => {
    await seedItem('F-PK1', 'su-parked-1', 30); // claim 30 min old — past the 10-min live grace
    // Heartbeat 15 min ago: past the 10-min live window (not "alive") but within the 30-min parked window.
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-1', now() - interval '15 minutes')`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-PK1')).taken_by).toBe('su-parked-1');
  });

  it('feature reaper: once the beat ages past the parked grace, the holder IS reaped (bounded, not indefinite)', async () => {
    await seedItem('F-PK2', 'su-parked-2', 40);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-2', now() - interval '45 minutes')`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-PK2']);
    expect(r.released[0]).toMatchObject({ reason: 'dead' });
  });

  it('feature reaper: a parkedGraceMs override == base grace disables the extra protection (configurable backoff)', async () => {
    await seedItem('F-PK3', 'su-parked-3', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-3', now() - interval '15 minutes')`;
    // parkedGraceMs 10m == base grace → the 15-min-stale beat is now past it → reaped.
    const r = await reclaimStaleWorkItemClaims(sql, { parkedGraceMs: 10 * 60_000 });
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-PK3']);
  });

  it('feature reaper: parkedGraceMs is clamped to be ≥ graceMs (a parked holder never waits LESS)', async () => {
    await seedItem('F-PK4', 'su-parked-4', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-4', now() - interval '15 minutes')`;
    // Absurdly small parkedGraceMs (1m) is clamped UP to graceMs (20m); the 15-min beat is
    // inside 20m → still protected. Without the clamp it would (wrongly) reap.
    const r = await reclaimStaleWorkItemClaims(sql, { graceMs: 20 * 60_000, parkedGraceMs: 60_000 });
    expect(r.released).toHaveLength(0);
  });

  it('issue reaper: a recently-parked assignee (beat within parked grace) is NOT reaped', async () => {
    await seedIssue('EI-PK1', 'bug', 'su-parked-issue', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-issue', now() - interval '15 minutes')`;
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(0);
    expect(await assigneeOf('EI-PK1')).toBe('su-parked-issue');
  });

  it('issue reaper: the same assignee is reaped once its beat ages past the parked grace', async () => {
    await seedIssue('EI-PK2', 'change', 'su-parked-issue-2', 40);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-parked-issue-2', now() - interval '45 minutes')`;
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released.map((c) => c.issue_id)).toEqual(['EI-PK2']);
  });
});

describe('reclaimStaleIssueClaims (issue-family reaper, GAP 2 / P-005 / D-009)', () => {
  it('a dead-holder OPEN bug → assignee cleared, returned to the open pool', async () => {
    await seedIssue('EI-1', 'bug', 'opspawn-dead-bug', 30);
    await markKnown('opspawn-dead-bug');
    const r = await reclaimStaleIssueClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({ issue_id: 'EI-1', kind: 'bug', former_assignee: 'opspawn-dead-bug' });
    expect(await assigneeOf('EI-1')).toBeNull();
  });

  it('a dead-holder OPEN change → assignee cleared', async () => {
    await seedIssue('EI-2', 'change', 'opspawn-dead-chg', 30);
    await markKnown('opspawn-dead-chg');
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

// ── WI-1999: the remote-holder guard (federated items, local-only presence) ──
// The 2026-07-03 incident: work_items rows FEDERATE across the hive but
// coord_presence is LOCAL-BY-DESIGN, so another node's sweep saw every tower
// holder as "not alive" and shredded LIVE claims (WI-1964 dead-lettered 5x while
// actively driven; WI-1910 requeued 5x). The DEAD leg must only reap holders
// this node has EVER seen; a never-seen-here holder skips until the long-horizon
// fallback (anchored on COALESCE(taken_at, updated_ts)) lapses.
describe('WI-1999 remote-holder guard', () => {
  it('a NEVER-seen-here holder is SKIPPED past grace (possibly a live remote agent)', async () => {
    await seedItem('F-RH1', 'su-remote-node-holder', 30, 'in_progress'); // past grace, no local rows
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
    expect((await statusOf('F-RH1')).taken_by).toBe('su-remote-node-holder');
  });

  it('the SAME holder with a stale local presence row (a dead local bee) IS reaped', async () => {
    await seedItem('F-RH2', 'su-known-dead-bee', 30, 'in_progress');
    await markKnown('su-known-dead-bee');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ feature_id: 'F-RH2', reason: 'dead', action: 'requeued' });
  });

  it('a never-seen holder DOES free once the long-horizon fallback lapses (anchored on taken_at)', async () => {
    await seedItem('F-RH3', 'su-remote-abandoned', 30, 'in_progress'); // taken 30 min ago
    // Fallback shrunk to 15 min → the 30-min-old anchor is past it: truly-abandoned rows still free.
    const r = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-RH3', reason: 'dead' });
  });

  it('a never-seen holder with NULL taken_at anchors the fallback on updated_ts (EI-2534 must not re-strand)', async () => {
    await seedItem('F-RH4', 'su-remote-noanchor', 30, 'in_progress');
    await sql`UPDATE harness_shared.harness_features_consolidated
                 SET taken_at = NULL, updated_ts = ${Date.now() - 30 * 60_000} WHERE feature_id = 'F-RH4'`;
    // Fresh-updated row is skipped…
    expect((await reclaimStaleWorkItemClaims(sql)).released).toHaveLength(0);
    // …but frees once updated_ts is older than the fallback.
    const r = await reclaimStaleWorkItemClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released[0]).toMatchObject({ feature_id: 'F-RH4', reason: 'dead' });
  });

  it('issue reaper parity: a never-seen assignee is SKIPPED, then frees past the fallback', async () => {
    // engineer_issues is not truncated per-test, so assert on EI-RH1 specifically
    // (earlier tests' never-seen assignees legitimately free in the fallback sweep too).
    await seedIssue('EI-RH1', 'bug', 'su-remote-issue-holder', 30);
    expect((await reclaimStaleIssueClaims(sql)).released.map((c) => c.issue_id)).not.toContain('EI-RH1');
    expect(await assigneeOf('EI-RH1')).toBe('su-remote-issue-holder');
    const r = await reclaimStaleIssueClaims(sql, { unknownHolderFallbackMs: 15 * 60_000 });
    expect(r.released.map((c) => c.issue_id)).toContain('EI-RH1');
    expect(await assigneeOf('EI-RH1')).toBeNull();
  });
});
