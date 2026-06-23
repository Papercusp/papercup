/**
 * work-queue-health.integration.test.ts — the stuck-items metric + reaper-liveness
 * reader (work-queue-stuck-item-recovery-2026-06-17 P-010) against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import {
  readWorkQueueHealth,
  readHarnessStuckFeatures,
  recordSweepRun,
  readSweepRun,
  STALE_CLAIM_SWEEP_NAME,
} from './work-queue-health';

const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text PRIMARY KEY, heartbeat_at timestamptz)`;
const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY, session_owner text, run_id text, status text NOT NULL, heartbeat_at timestamptz)`;
const ENGINEER_ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default', issue_id text NOT NULL,
    kind text, scope text, title text, body text, severity text, source text, state text,
    assignee text, assigned_by text, assigned_at timestamptz, payload jsonb,
    found_during text, linked_feature_id text, created_by text, signal_origin text,
    created_at timestamptz, updated_at timestamptz, origin text DEFAULT 'local',
    PRIMARY KEY (workspace_id, issue_id))`;
const SWEEP_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.periodic_sweep_runs (
    sweep_name text PRIMARY KEY, last_run_at timestamptz NOT NULL DEFAULT now(),
    last_released integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`;
const PLAN_ASSIGNMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.plan_item_assignments (
    workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL, item_id text NOT NULL,
    assignee_name text, assigned_by_user text, assigned_ts timestamptz, released_ts timestamptz,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id))`;
const AGENT_NAME_SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_name_sessions (
    workspace_id text NOT NULL, session_owner_id text NOT NULL, agent_name text NOT NULL,
    PRIMARY KEY (workspace_id, session_owner_id))`;

let db: FreshPgDb;
let sql: postgres.Sql;
const WS = 'default';
const H = 'papercup';

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(PRESENCE_DDL);
  await sql.unsafe(SPAWNED_DDL);
  await sql.unsafe(ENGINEER_ISSUES_DDL);
  await sql.unsafe(SWEEP_RUNS_DDL);
  await sql.unsafe(PLAN_ASSIGNMENTS_DDL);
  await sql.unsafe(AGENT_NAME_SESSIONS_DDL);
}, 120_000);

afterAll(async () => { await db?.cleanup(); });

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.work_items, harness_shared.coord_presence, harness_shared.spawned_agents, harness_shared.periodic_sweep_runs, harness_shared.plan_item_assignments, harness_shared.agent_name_sessions `;
});

async function seedFeature(id: string, status: string, takenBy: string | null, takenAgoMin: number, harness = H): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, taken_at, created_ts, updated_ts)
    VALUES (${WS}, ${harness}, ${id}, 'feature', ${id}, ${status}, ${takenBy},
       ${takenBy ? sql`now() - make_interval(mins => ${takenAgoMin})` : null}, ${Date.now()}, ${Date.now()})`;
}
async function seedIssue(id: string, kind: string, assignee: string | null, agoMin: number, state = 'open'): Promise<void> {
  await sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, kind, scope, title, state, assignee, assigned_at, created_at, updated_at)
    VALUES (${WS}, ${id}, ${kind}, 'operator', ${id}, ${state}, ${assignee},
       ${assignee ? sql`now() - make_interval(mins => ${agoMin})` : null}, now(), now())`;
}

describe('readWorkQueueHealth — stuck-items metric (P-008)', () => {
  it('counts a freed-but-non-dispatchable feature as stuck', async () => {
    await seedFeature('F-1', 'in_progress', null, 0); // taken_by NULL + non-dispatchable status
    const h = await readWorkQueueHealth(sql, { workspaceId: WS });
    expect(h.stuckFeatures).toBe(1);
  });

  it('does NOT count todo/passed/deprecated/blocked freed rows as stuck', async () => {
    await seedFeature('F-todo', 'todo', null, 0);
    await seedFeature('F-passed', 'passed', null, 0);
    await seedFeature('F-dep', 'deprecated', null, 0);
    await seedFeature('F-blk', 'blocked', null, 0);
    const h = await readWorkQueueHealth(sql, { workspaceId: WS });
    expect(h.stuckFeatures).toBe(0);
  });

  it('counts a dead-HELD feature claim past grace (reaper backlog)', async () => {
    await seedFeature('F-2', 'in_progress', 'opspawn-dead', 30); // dead holder, 30min > grace
    const h = await readWorkQueueHealth(sql, { workspaceId: WS });
    expect(h.deadHeldFeatures).toBe(1);
  });

  it('a dead-held claim with a LIVE holder (fresh presence) is not counted', async () => {
    await seedFeature('F-3', 'in_progress', 'su-live', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-live', now())`;
    const h = await readWorkQueueHealth(sql, { workspaceId: WS });
    expect(h.deadHeldFeatures).toBe(0);
  });

  it('counts a dead-assigned open bug/change issue across the issue family', async () => {
    await seedIssue('EI-1', 'bug', 'opspawn-dead-bug', 30);
    await seedIssue('EI-2', 'change', 'opspawn-dead-chg', 30);
    await seedIssue('EI-3', 'task', 'delegate:s', 999); // task excluded
    await seedIssue('EI-4', 'bug', 'opspawn-dead', 30, 'resolved'); // terminal excluded
    const h = await readWorkQueueHealth(sql, { workspaceId: WS });
    expect(h.deadAssignedIssues).toBe(2);
  });

  it('counts a seeded stuck row across BOTH families in one read', async () => {
    await seedFeature('F-4', 'validating', null, 0); // stuck feature
    await seedIssue('EI-5', 'bug', 'opspawn-dead-bug2', 30); // dead-assigned issue
    const h = await readWorkQueueHealth(sql, { workspaceId: WS });
    expect(h.stuckFeatures).toBe(1);
    expect(h.deadAssignedIssues).toBe(1);
  });

  // EI-2535: the plan-item RESERVATION detector — the alarm half of the dead-holder
  // assignment reaper. assignmentGraceMs is small here so the seeded ages cross it.
  async function seedAssignment(item: string, name: string, agoMin: number): Promise<void> {
    await sql`INSERT INTO harness_shared.plan_item_assignments
      (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_ts, released_ts)
      VALUES (${WS}, ${H}, 'p', ${item}, ${name}, now() - make_interval(mins => ${agoMin}), NULL)`;
  }

  it('counts a dead-holder plan-item assignment past the assignment grace', async () => {
    await seedAssignment('P-001', 'su-dead-asg', 30);
    const h = await readWorkQueueHealth(sql, { workspaceId: WS, assignmentGraceMs: 10 * 60 * 1000 });
    expect(h.deadHeldAssignments).toBe(1);
  });

  it('does NOT count an assignment whose name has a live ADOPTING session', async () => {
    await seedAssignment('P-002', 'builder-1', 30);
    await sql`INSERT INTO harness_shared.agent_name_sessions VALUES (${WS}, 'su-live-asg', 'builder-1')`;
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-live-asg', now())`;
    const h = await readWorkQueueHealth(sql, { workspaceId: WS, assignmentGraceMs: 10 * 60 * 1000 });
    expect(h.deadHeldAssignments).toBe(0);
  });

  it('does NOT count an assignment reserved WITHIN the assignment grace', async () => {
    await seedAssignment('P-003', 'su-recent-asg', 1);
    const h = await readWorkQueueHealth(sql, { workspaceId: WS, assignmentGraceMs: 10 * 60 * 1000 });
    expect(h.deadHeldAssignments).toBe(0);
  });
});

describe('readWorkQueueHealth — reaper liveness (P-009)', () => {
  it('reaperStale=true and age null when the sweep has never recorded a run', async () => {
    const h = await readWorkQueueHealth(sql, { workspaceId: WS });
    expect(h.reaperLastRunMs).toBeNull();
    expect(h.reaperAgeMs).toBeNull();
    expect(h.reaperStale).toBe(true);
  });

  it('a fresh recorded run → reaperStale=false', async () => {
    await recordSweepRun(sql, STALE_CLAIM_SWEEP_NAME, 3);
    const h = await readWorkQueueHealth(sql, { workspaceId: WS });
    expect(h.reaperStale).toBe(false);
    expect(h.reaperLastReleased).toBe(3);
    expect(h.reaperAgeMs).not.toBeNull();
    expect(h.reaperAgeMs!).toBeLessThan(60_000);
  });

  it('the staleness alarm FIRES when the recorded last-run is older than the threshold', async () => {
    // Stamp a last_run 10 min ago — older than the 5-min default staleness window.
    await sql`INSERT INTO harness_shared.periodic_sweep_runs (sweep_name, last_run_at, last_released)
      VALUES (${STALE_CLAIM_SWEEP_NAME}, now() - interval '10 minutes', 0)`;
    const h = await readWorkQueueHealth(sql, { workspaceId: WS });
    expect(h.reaperStale).toBe(true);
    expect(h.reaperAgeMs!).toBeGreaterThan(5 * 60 * 1000);
  });

  it('honors a custom stalenessMs', async () => {
    await recordSweepRun(sql, STALE_CLAIM_SWEEP_NAME, 0);
    // age is ~0; with a 0ms window any positive age is stale, with a huge window it is fresh.
    const fresh = await readWorkQueueHealth(sql, { workspaceId: WS, stalenessMs: 10 * 60_000 });
    expect(fresh.reaperStale).toBe(false);
  });

  it('readSweepRun returns null before any run, the recorded values after', async () => {
    expect(await readSweepRun(sql, STALE_CLAIM_SWEEP_NAME)).toBeNull();
    await recordSweepRun(sql, STALE_CLAIM_SWEEP_NAME, 7);
    const run = await readSweepRun(sql, STALE_CLAIM_SWEEP_NAME);
    expect(run?.lastReleased).toBe(7);
  });
});

describe('readHarnessStuckFeatures — per-harness slice (P-008, harness:health)', () => {
  it('scopes stuck + dead-held counts to one harness', async () => {
    await seedFeature('F-a', 'in_progress', null, 0, 'papercup'); // stuck, papercup
    await seedFeature('F-b', 'in_progress', 'opspawn-dead', 30, 'papercup'); // dead-held, papercup
    await seedFeature('F-c', 'in_progress', null, 0, 'other-harness'); // stuck, OTHER harness
    const ph = await readHarnessStuckFeatures(sql, WS, 'papercup');
    expect(ph).toEqual({ stuckFeatures: 1, deadHeldFeatures: 1 });
    const oh = await readHarnessStuckFeatures(sql, WS, 'other-harness');
    expect(oh).toEqual({ stuckFeatures: 1, deadHeldFeatures: 0 });
  });
});
