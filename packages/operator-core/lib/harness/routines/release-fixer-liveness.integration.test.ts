/**
 * release-fixer-liveness.integration.test.ts — the IMPURE half of the P-014 / D-009
 * self-heal: does releaseFixerSpawnAlive correctly read a dispatched fixer's
 * liveness off spawned_agents (the same status + STALE_MS heartbeat rule the
 * fleet_assignment view + the stale-claim reconciler use)? Paired with the pure
 * decideReleaseFixerDispatch unit tests, this proves the full chain that fixes the
 * 2026-06-21 incident: a DEAD fixer → fixerAlive=false → re-dispatch; a LIVE fixer
 * → fixerAlive=true → skip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { launcherBootId } from '../../fleet/spawn-reclaim';
import { releaseFixerSpawnAlive, decideReleaseFixerDispatch } from './release-actions';

const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    session_owner text,
    run_id text,
    status text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz,
    last_output_at timestamptz,
    session_id text,
    pid integer,
    launcher_host text,
    launcher_boot_id text
  )`;

const TOOL_INVOCATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.tool_invocations (
    id bigserial PRIMARY KEY,
    workspace_id text NOT NULL,
    spawn_id text,
    invoked_at timestamptz NOT NULL DEFAULT now()
  )`;

const TASK_LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.task_ledger (
    task_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    class text NOT NULL,
    launched_by text NOT NULL,
    state text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL,
    scope_unit text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb
  )`;

let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(SPAWNED_DDL);
  await sql.unsafe(TASK_LEDGER_DDL);
  await sql.unsafe(TOOL_INVOCATIONS_DDL);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.spawned_agents, harness_shared.task_ledger, harness_shared.tool_invocations`;
});

async function seedSpawn(
  spawnId: string,
  status: string,
  heartbeatAgoMin: number | null,
  identity: {
    pid?: number | null;
    launcherHost?: string | null;
    launcherBootId?: string | null;
    startedAgoMin?: number;
    lastOutputAgoMin?: number | null;
    sessionOwner?: string | null;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, session_owner, run_id, status, started_at, heartbeat_at,
       last_output_at, pid, launcher_host, launcher_boot_id)
    VALUES (${spawnId}, 'papercusp-workspace', ${identity.sessionOwner === undefined ? spawnId : identity.sessionOwner}, ${spawnId}, ${status},
            now() - make_interval(mins => ${identity.startedAgoMin ?? 0}),
            ${heartbeatAgoMin == null ? null : sql`now() - make_interval(mins => ${heartbeatAgoMin})`},
            ${
              identity.lastOutputAgoMin == null
                ? null
                : sql`now() - make_interval(mins => ${identity.lastOutputAgoMin})`
            },
            ${identity.pid ?? null}, ${identity.launcherHost ?? null}, ${identity.launcherBootId ?? null})`;
}

async function seedToolInvocation(spawnId: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.tool_invocations (workspace_id, spawn_id)
    VALUES ('papercusp-workspace', ${spawnId})`;
}

async function seedTaskScope(
  spawnId: string,
  state: string,
  lastSeenAgoMin = 0,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.task_ledger
      (task_id, workspace_id, class, launched_by, state, last_seen_at, detail)
    VALUES (${`task-${spawnId}`}, 'papercusp-workspace', 'agent-session',
            'orchestrator:release-fixer', ${state},
            now() - make_interval(mins => ${lastSeenAgoMin}),
            jsonb_build_object('spawnRecordId', ${spawnId}::text))`;
}

async function seedLegacyTaskScope(
  spawnId: string,
  state: string,
  options: { taskId?: string; lastSeenAgoMin?: number; scopeUnit?: string } = {},
): Promise<void> {
  const taskId = options.taskId ?? `legacy-task-${spawnId}`;
  await sql`
    INSERT INTO harness_shared.task_ledger
      (task_id, workspace_id, class, launched_by, state, started_at, last_seen_at, scope_unit, detail)
    SELECT ${taskId}, 'papercusp-workspace', 'agent-session',
           'orchestrator:release-fixer', ${state}, sa.started_at,
           now() - make_interval(mins => ${options.lastSeenAgoMin ?? 0}),
           ${options.scopeUnit ?? `pc-${taskId}.scope`},
           jsonb_build_object('role', 'release-fixer', 'scopeRequested', true)
      FROM harness_shared.spawned_agents sa
     WHERE sa.spawn_id = ${spawnId}`;
}

describe('releaseFixerSpawnAlive (P-014 / D-009 — the liveness-detection half)', () => {
  it('a RUNNING fixer with a fresh heartbeat is ALIVE → covered (skip re-dispatch)', async () => {
    await seedSpawn('s-fixer-live', 'running', 1);
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-live')).toBe(true);
  });

  it('a fixer whose spawn FAILED is gone → re-dispatch (the incident: a dead fixer)', async () => {
    await seedSpawn('s-fixer-dead', 'failed', 1);
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-dead')).toBe(false);
  });

  it('a terminal spawn row with a live correlated task scope and concrete output remains covered', async () => {
    await seedSpawn('s-fixer-handed-off', 'failed', 30, {
      launcherHost: hostname(),
      launcherBootId: launcherBootId(),
      pid: 999_999_999,
      startedAgoMin: 30,
      lastOutputAgoMin: 1,
    });
    await seedTaskScope('s-fixer-handed-off', 'running');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-handed-off')).toBe(true);
  });

  it('a RUNNING fixer with a live correlated scope remains covered during the pre-turn grace', async () => {
    await seedSpawn('s-fixer-starting', 'running', 30, { startedAgoMin: 1 });
    await seedTaskScope('s-fixer-starting', 'running');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-starting')).toBe(true);
  });

  it('EI-21135879707775738: a reclaimed zero-invocation fixer is not covered by pre-turn grace', async () => {
    // reclaimOrphanedSpawns settles the launch row as failed while the task
    // reconciler can still report the handoff scope as live for a short window.
    // With no output or tool invocation, that stale scope must not suppress a
    // replacement fixer merely because the spawn started recently.
    await seedSpawn('s-fixer-reclaimed-no-turn', 'failed', 1, { startedAgoMin: 1 });
    await seedTaskScope('s-fixer-reclaimed-no-turn', 'running');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-reclaimed-no-turn')).toBe(false);
  });

  it('WI-40422: a heartbeat-only correlated scope past the pre-turn grace does not mask a failed spawn', async () => {
    await seedSpawn('s-fixer-pre-turn-stalled', 'failed', 30, {
      startedAgoMin: 30,
      sessionOwner: null,
    });
    await seedTaskScope('s-fixer-pre-turn-stalled', 'running');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-pre-turn-stalled')).toBe(false);
  });

  it('a correlated tool invocation proves progress after the pre-turn grace', async () => {
    await seedSpawn('s-fixer-tool-progress', 'failed', 30, { startedAgoMin: 30 });
    await seedTaskScope('s-fixer-tool-progress', 'running');
    await seedToolInvocation('s-fixer-tool-progress');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-tool-progress')).toBe(true);
  });

  it('a correlated scope stops covering once the task reconciler closes it', async () => {
    await seedSpawn('s-fixer-scope-ended', 'failed', 30);
    await seedTaskScope('s-fixer-scope-ended', 'exited');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-scope-ended')).toBe(false);
  });

  it('EI-21019097008328015: a settled task scope overrides a fresh-heartbeat spawn row whose recorded pid was reused by an unrelated invoke-once process', async () => {
    // Reproduces the incident: the spawn row still reads `running` with a
    // heartbeat inside the STALE_MS grace window (the launch-only heartbeat that
    // is never refreshed once the fixer dies before its first turn), and its
    // recorded pid now belongs to a DIFFERENT, unrelated invoke-once-launched
    // process — every agent-role spawn (bees, system routines, and
    // release-fixers alike) shares the identical `invoke-once` binary, so a
    // reused pid reads as "alive" regardless of which spawn actually owns it
    // now. `process.pid` stands in for that reused pid: `isSpawnProcessAlive`
    // treats a pid equal to the running process as alive by construction, the
    // same false-positive signal a real pid-reuse collision produces. The
    // task_ledger row for THIS exact spawn id is already terminal, proving the
    // fixer's own tracked process ended — that must win over the pid reading.
    await seedSpawn('s-fixer-pid-aliased', 'running', 1, {
      launcherHost: hostname(),
      launcherBootId: launcherBootId(),
      pid: process.pid,
    });
    await seedTaskScope('s-fixer-pid-aliased', 'exited');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-pid-aliased')).toBe(false);
  });

  it('a stale correlated task row does not keep a dead fixer covered', async () => {
    await seedSpawn('s-fixer-scope-stale', 'failed', 30);
    await seedTaskScope('s-fixer-scope-stale', 'running', 30);

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-scope-stale')).toBe(false);
  });

  it('a live legacy release-fixer task scope without spawnRecordId keeps a dead spawn covered', async () => {
    await seedSpawn('s-fixer-legacy-live', 'failed', 30, {
      startedAgoMin: 30,
      lastOutputAgoMin: 1,
    });
    await seedLegacyTaskScope('s-fixer-legacy-live', 'running');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-legacy-live')).toBe(true);
  });

  it('WI-40422: a heartbeat-only legacy scope past the pre-turn grace does not mask a failed spawn', async () => {
    await seedSpawn('s-fixer-legacy-pre-turn-stalled', 'failed', 30, {
      startedAgoMin: 30,
      sessionOwner: null,
    });
    await seedLegacyTaskScope('s-fixer-legacy-pre-turn-stalled', 'running');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-legacy-pre-turn-stalled')).toBe(false);
  });

  it('a terminal legacy release-fixer task scope does not keep a dead spawn covered', async () => {
    await seedSpawn('s-fixer-legacy-ended', 'failed', 30);
    await seedLegacyTaskScope('s-fixer-legacy-ended', 'exited');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-legacy-ended')).toBe(false);
  });

  it('ambiguous legacy release-fixer task scopes return unknown instead of guessing', async () => {
    await seedSpawn('s-fixer-legacy-ambiguous', 'failed', 30);
    await seedLegacyTaskScope('s-fixer-legacy-ambiguous', 'running', { taskId: 'legacy-a' });
    await seedLegacyTaskScope('s-fixer-legacy-ambiguous', 'running', { taskId: 'legacy-b' });

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-legacy-ambiguous')).toBeNull();
  });

  it('a RUNNING fixer with a STALE heartbeat (crashed mid-run, beats stopped) is gone → re-dispatch', async () => {
    await seedSpawn('s-fixer-stale', 'running', 30); // > 10-min STALE_MS window
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-stale')).toBe(false);
  });

  it('a same-host fixer from a prior launcher boot is gone even with a fresh heartbeat and no PID', async () => {
    await seedSpawn('s-fixer-prior-boot', 'running', 1, {
      launcherHost: hostname(),
      launcherBootId: 'prior-launcher-boot',
      pid: null,
    });
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-prior-boot')).toBe(false);
  });

  it('a same-host fixer with a recorded but absent PID is gone', async () => {
    await seedSpawn('s-fixer-absent-pid', 'running', 1, {
      launcherHost: hostname(),
      launcherBootId: launcherBootId(),
      pid: 999_999_999,
    });
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-absent-pid')).toBe(false);
  });

  it('a COMPLETED (done) fixer is no longer covering the gate → re-dispatch', async () => {
    await seedSpawn('s-fixer-done', 'done', 1);
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-done')).toBe(false);
  });

  it('a missing spawn row → not alive → re-dispatch', async () => {
    expect(await releaseFixerSpawnAlive(sql, 's-never-recorded')).toBe(false);
  });

  it('no spawn id (DBOS-durable fire / legacy record) → null (unknown → presumed covered)', async () => {
    expect(await releaseFixerSpawnAlive(sql, null)).toBeNull();
    expect(await releaseFixerSpawnAlive(sql, undefined)).toBeNull();
  });

  it('end-to-end: a DEAD fixer spawn drives decideReleaseFixerDispatch to RE-DISPATCH', async () => {
    const now = Date.now();
    await seedSpawn('s-fixer-x', 'failed', 1);
    const fixerAlive = await releaseFixerSpawnAlive(sql, 's-fixer-x');
    const d = decideReleaseFixerDispatch({
      lf: { signature: 'sig', at: now - 30 * 60_000, spawnId: 's-fixer-x' },
      signature: 'sig',
      now,
      fixerAlive,
    });
    expect(d).toMatchObject({ dispatch: true, reason: 'self-heal' });
  });

  it('end-to-end: a LIVE fixer spawn drives decideReleaseFixerDispatch to SKIP', async () => {
    const now = Date.now();
    await seedSpawn('s-fixer-y', 'running', 1);
    const fixerAlive = await releaseFixerSpawnAlive(sql, 's-fixer-y');
    const d = decideReleaseFixerDispatch({
      lf: { signature: 'sig', at: now - 30 * 60_000, spawnId: 's-fixer-y' },
      signature: 'sig',
      now,
      fixerAlive,
    });
    expect(d).toMatchObject({ dispatch: false, reason: 'covered' });
  });
});
