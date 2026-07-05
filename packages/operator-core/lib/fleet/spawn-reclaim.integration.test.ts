/**
 * spawn-reclaim.integration.test.ts — orphaned-spawn reclaim (P-011, real PG).
 *
 * Plan: unify-agent-spawn-chokepoint-2026-06-06. A 'running'/'restarting'
 * spawned_agents row whose launching host died (heartbeat went stale) is
 * reclaimed to 'failed' so it stops counting against the concurrency ceiling; a
 * freshly-heartbeated row is left alone; terminal rows are never touched.
 * heartbeatSpawns bumps the lease for live spawns.
 */
import { hostname } from 'node:os';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  reclaimOrphanedSpawns,
  reclaimWedgedSpawns,
  type WedgedSpawnCandidate,
  heartbeatSpawns,
  recordSpawnPid,
  isSpawnProcessAlive,
  reconcileSpawnAdmissionOnBoot,
  launcherBootId,
  __setLauncherBootIdForTests,
  releaseClaimsOfDeadSpawns,
  sweepStaleSpawnClaims,
} from './spawn-reclaim';

const SPAWNED_AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY, workspace_id text NOT NULL, harness_slug text,
    parent_spawn_id text, parent_role text, child_role text NOT NULL,
    feature_id text, chunk_id text, run_id text,
    status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz, duration_ms bigint, exit_code int, output_tail text, error_message text,
    cancel_requested boolean NOT NULL DEFAULT false, session_owner text,
    coordination_domain text NOT NULL DEFAULT 'default', plan_slug text, item_id text,
    model_spec text, model_tier text, brief text,
    restart_strategy text NOT NULL DEFAULT 'one_for_one', restart_count int NOT NULL DEFAULT 0,
    restart_window_start timestamptz, cancel_reason text, cancelled_at timestamptz,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    last_output_at timestamptz,
    pid integer, launcher_host text, launcher_boot_id text)`;

// Minimal stand-in for the prod `harness_features_consolidated` VIEW — the boot
// reconcile LEFT JOINs it (feature_id, workspace_id, harness_slug → status) to
// decide whether a reclaimed bee's work-item is non-terminal (EI-85 relaunch),
// and the dead-holder release UPDATEs its claim columns (taken_by/taken_at/…).
const FEATURES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    feature_id text NOT NULL, workspace_id text NOT NULL, harness_slug text NOT NULL,
    status text, taken_by text, taken_at timestamptz, last_progress_at timestamptz,
    updated_ts bigint, PRIMARY KEY (feature_id, workspace_id, harness_slug))`;

// Minimal stand-ins for the other two claim surfaces the dead-holder release
// frees: engineer_issues.assignee (+ assigned_at/origin/updated_at — the columns
// releaseIssue writes) and plan_item_claims.owner.
const ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default', issue_id text NOT NULL,
    assignee text, assigned_at timestamptz, origin text NOT NULL DEFAULT 'local',
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id, issue_id))`;
const PLAN_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.plan_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
    item_id text NOT NULL, owner text NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id))`;

const WS = 'default';
const STALE = { staleMs: 5 * 60_000 };
// EI-85: same-host candidates whose pid is alive are kept; everything else is
// reclaimed. The OS liveness check is injected so the alive/dead branches are
// deterministic — `alivePids` decides which recorded pids read as alive.
const alivePids = new Set<number>();
const fakeAlive = (pid: number) => alivePids.has(pid);
const STALE_FAKE = { ...STALE, isAlive: fakeAlive };
let db: FreshPgDb;

/** Insert a spawn row with an explicit heartbeat age (seconds ago) + status,
 *  optionally with a recorded pid + launcher host (EI-85). `runId` overrides the
 *  default `r-<id>` (P-033: a `launch-%` run_id selects the in-process-launch
 *  liveness class). */
async function insertSpawn(
  spawnId: string,
  status: string,
  heartbeatAgoSec: number,
  rec: {
    pid?: number;
    host?: string;
    runId?: string;
    bootId?: string;
    childRole?: string;
    featureId?: string;
    itemId?: string;
    parentRole?: string;
    /** Seconds-ago for last_output_at (wedge tests). Omitted ⇒ NULL (no output yet). */
    lastOutputAgoSec?: number;
  } = {},
) {
  const lastOutput =
    rec.lastOutputAgoSec != null
      ? db.sql`now() - ${rec.lastOutputAgoSec}::int * interval '1 second'`
      : db.sql`NULL`;
  await db.sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, child_role, parent_role, feature_id, item_id, run_id, status, started_at, heartbeat_at, last_output_at, pid, launcher_host, launcher_boot_id)
    VALUES (${spawnId}, ${WS}, 'papercup', ${rec.childRole ?? 'worker'}, ${rec.parentRole ?? null},
            ${rec.featureId ?? null}, ${rec.itemId ?? null}, ${rec.runId ?? 'r-' + spawnId}, ${status},
            now() - interval '10 minutes', now() - ${heartbeatAgoSec}::int * interval '1 second', ${lastOutput},
            ${rec.pid ?? null}, ${rec.host ?? null}, ${rec.bootId ?? null})`;
}

/** Seed a work-item row so the reconcile's LEFT JOIN resolves a feature's status. */
async function insertWorkItem(featureId: string, status: string) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated (feature_id, workspace_id, harness_slug, status)
    VALUES (${featureId}, ${WS}, 'papercup', ${status})
    ON CONFLICT (feature_id, workspace_id, harness_slug) DO UPDATE SET status = EXCLUDED.status`;
}

async function statusOf(spawnId: string): Promise<string> {
  const rows = await db.sql<{ status: string }[]>`
    SELECT status FROM harness_shared.spawned_agents WHERE spawn_id = ${spawnId}`;
  return rows[0]?.status ?? '(none)';
}

async function runningCount(): Promise<number> {
  const rows = await db.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.spawned_agents
     WHERE workspace_id = ${WS} AND status IN ('running', 'restarting')`;
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  db = await createFreshPgDb('spawn-reclaim');
  await db.sql.unsafe(SPAWNED_AGENTS_DDL);
  await db.sql.unsafe(FEATURES_DDL);
  await db.sql.unsafe(ISSUES_DDL);
  await db.sql.unsafe(PLAN_CLAIMS_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.spawned_agents`;
  await db.sql`TRUNCATE harness_shared.harness_features_consolidated`;
  await db.sql`TRUNCATE harness_shared.engineer_issues`;
  await db.sql`TRUNCATE harness_shared.plan_item_claims`;
  alivePids.clear();
});

describe('reclaimOrphanedSpawns (P-011, real PG)', () => {
  it('reclaims a running row whose heartbeat is stale beyond the threshold', async () => {
    await insertSpawn('stale', 'running', 10 * 60); // 10 min stale
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(1);
    expect(r.spawnIds).toEqual(['stale']);
    // The freed workspace rides the result so callers announce the slot-free
    // (spawn-slot:freed:<ws>) to over-ceiling waiters (D-004).
    expect(r.workspaces).toEqual([WS]);
    expect(await statusOf('stale')).toBe('failed');
    const [row] = await db.sql<{ error_message: string; finished_at: Date | null; duration_ms: number | null }[]>`
      SELECT error_message, finished_at, duration_ms FROM harness_shared.spawned_agents WHERE spawn_id = 'stale'`;
    expect(row.error_message).toMatch(/reclaimed: spawn heartbeat stale/);
    expect(row.finished_at).not.toBeNull();
    expect(Number(row.duration_ms)).toBeGreaterThan(0);
  });

  it('frees the concurrency ceiling: a stale running row stops counting after reclaim', async () => {
    await insertSpawn('stale', 'running', 10 * 60);
    await insertSpawn('live', 'running', 5);
    expect(await runningCount()).toBe(2);
    await reclaimOrphanedSpawns(db.sql, STALE);
    expect(await runningCount()).toBe(1); // only the live one still holds a slot
  });

  it('leaves a freshly-heartbeated running row alone', async () => {
    await insertSpawn('fresh', 'running', 5);
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(0);
    expect(r.workspaces).toEqual([]); // nothing freed → nothing to announce
    expect(await statusOf('fresh')).toBe('running');
  });

  it('never touches terminal rows (idempotent)', async () => {
    await insertSpawn('done', 'done', 10 * 60);
    await insertSpawn('failedRow', 'failed', 10 * 60);
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('done')).toBe('done');
    expect(await statusOf('failedRow')).toBe('failed');
  });

  it('reclaims restarting rows too (they also hold a slot)', async () => {
    await insertSpawn('restarting', 'restarting', 10 * 60);
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(1);
    expect(await statusOf('restarting')).toBe('failed');
  });
});

describe('reclaimOrphanedSpawns liveness gate (EI-85: host-died vs child-died)', () => {
  const ME = hostname();

  it('a stale same-host row whose child is ALIVE is NOT reclaimed — its heartbeat is bumped', async () => {
    await insertSpawn('survivor', 'running', 10 * 60, { pid: 4242, host: ME });
    alivePids.add(4242); // /proc says the child is still running (host was only paused)
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('survivor')).toBe('running');
    // Heartbeat bumped so the next sweep also skips it (no longer stale).
    const [row] = await db.sql<{ stale_now: boolean }[]>`
      SELECT heartbeat_at > now() - interval '30 seconds' AS stale_now
        FROM harness_shared.spawned_agents WHERE spawn_id = 'survivor'`;
    expect(row.stale_now).toBe(true);
  });

  it('a stale same-host row whose child is DEAD is reclaimed with a "confirmed dead" reason', async () => {
    await insertSpawn('killed', 'running', 10 * 60, { pid: 9999, host: ME });
    // 9999 not in alivePids → child confirmed dead.
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(1);
    expect(await statusOf('killed')).toBe('failed');
    const [row] = await db.sql<{ error_message: string }[]>`
      SELECT error_message FROM harness_shared.spawned_agents WHERE spawn_id = 'killed'`;
    expect(row.error_message).toMatch(/child process \(pid 9999\) confirmed dead/);
  });

  it('a DIFFERENT-host stale row can\'t be liveness-checked → reclaimed as host-presumed-dead', async () => {
    await insertSpawn('remote', 'running', 10 * 60, { pid: 4242, host: 'some-other-box' });
    alivePids.add(4242); // even though THIS pid is alive locally, it's another host's row
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(1);
    const [row] = await db.sql<{ error_message: string }[]>`
      SELECT error_message FROM harness_shared.spawned_agents WHERE spawn_id = 'remote'`;
    expect(row.error_message).toMatch(/heartbeat stale .* host presumed dead/);
  });

  it('mixed batch: keeps the live survivor, reclaims the dead + the pid-less legacy row', async () => {
    await insertSpawn('alive', 'running', 10 * 60, { pid: 100, host: ME });
    await insertSpawn('dead', 'running', 10 * 60, { pid: 200, host: ME });
    await insertSpawn('legacy', 'running', 10 * 60); // predates pid recording (NULL pid)
    alivePids.add(100);
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(2);
    expect(r.spawnIds.sort()).toEqual(['dead', 'legacy']);
    expect(await statusOf('alive')).toBe('running');
  });
});

/**
 * P-033 (the real-Queen-reclaim fix): an in-process loopback LAUNCH row (Queen
 * wake / overwatch — run_id `launch-%`, recorded with the firing process's pid)
 * is kept alive while that firing process exists, via the REAL isSpawnProcessAlive
 * (kind='launch' → plain /proc-existence, no invoke-once-cmdline requirement). This
 * is what makes the Queen survive past RECLAIM_STALE_MS without a fragile heartbeat
 * setInterval — the 7-reclaim bench symptom (a live Queen reaped at ~310s).
 */
describe('reclaimOrphanedSpawns: in-process LAUNCH rows (P-033 Queen-reclaim fix)', () => {
  const ME = hostname();

  it('keeps a stale launch row whose firing process (this test process) is still alive', async () => {
    // run_id `launch-%` + pid = THIS process → isSpawnProcessAlive(pid,'launch') is
    // alive-by-construction. The REAL liveness check (no injected fake) proves it.
    await insertSpawn('queen-live', 'running', 10 * 60, { pid: process.pid, host: ME, runId: 'launch-1' });
    const r = await reclaimOrphanedSpawns(db.sql, STALE); // STALE = REAL isSpawnProcessAlive
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('queen-live')).toBe('running');
    // Heartbeat bumped → the next sweep also skips it without any setInterval.
    const [row] = await db.sql<{ fresh: boolean }[]>`
      SELECT heartbeat_at > now() - interval '30 seconds' AS fresh
        FROM harness_shared.spawned_agents WHERE spawn_id = 'queen-live'`;
    expect(row.fresh).toBe(true);
  });

  it('reclaims a stale launch row whose firing process is dead (a bogus high pid)', async () => {
    await insertSpawn('queen-dead', 'running', 10 * 60, { pid: 2_147_480_000, host: ME, runId: 'launch-2' });
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(1);
    expect(await statusOf('queen-dead')).toBe('failed');
  });

  it('isSpawnProcessAlive(launch): this process is alive; a bee row (spawn) with the same pid needs invoke-once', () => {
    expect(isSpawnProcessAlive(process.pid, 'launch')).toBe(true);
    // process.pid === process.pid short-circuits to alive for BOTH kinds (we run in it).
    expect(isSpawnProcessAlive(process.pid, 'spawn')).toBe(true);
    // A DIFFERENT live pid: 'launch' accepts any live process; 'spawn' needs invoke-once.
    // (the test runner's own parent pid is alive but is not an invoke-once child.)
    const ppid = process.ppid;
    if (ppid > 1 && ppid !== process.pid) {
      expect(isSpawnProcessAlive(ppid, 'launch')).toBe(true);
      expect(isSpawnProcessAlive(ppid, 'spawn')).toBe(false);
    }
  });
});

/**
 * Gap 12 (PID-reuse hardening, spawn-reclaim.ts:73-88): a `spawn` (bee) row records
 * the invoke-once child's pid; the reclaim sweep proves liveness by reading
 * /proc/<pid>/cmdline and requiring it to NAME `invoke-once`. The slot a dead bee
 * held must NOT be kept alive by a *reused* pid now running something else — so a
 * REAL live process whose cmdline lacks invoke-once must read DEAD for kind:'spawn',
 * yet ALIVE for kind:'launch' (any live process). We spawn a real `sleep` child (its
 * cmdline is `sleep\030\0` — definitely no invoke-once) to make the same live pid
 * read DEAD-as-bee but alive-as-launch deterministically against the REAL liveness
 * check, with no injected fake. (process.pid can't be used — it short-circuits to
 * alive for both kinds; a reused pid is, by definition, NOT this process.)
 */
describe('reclaimOrphanedSpawns: spawn-kind PID-reuse (Gap 12, real /proc cmdline check)', () => {
  const ME = hostname();
  let proc: ChildProcess;
  let livePid: number;

  beforeAll(async () => {
    proc = spawnChild('sleep', ['120'], { stdio: 'ignore' });
    livePid = proc.pid!;
    // Give /proc a tick to expose the child's cmdline.
    await new Promise((r) => setTimeout(r, 150));
  });
  afterAll(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } });

  it('a stale spawn-kind row on a REUSED live pid (cmdline lacks invoke-once) reads DEAD → reclaimed', async () => {
    // run_id `r-%` (not launch-%) → kind:'spawn' → strict invoke-once-cmdline check.
    // The pid is a real, alive `sleep` — but it is NOT an invoke-once bee, so the
    // PID-reuse guard reads it dead and the orphaned slot is freed.
    await insertSpawn('reused-bee', 'running', 10 * 60, { pid: livePid, host: ME, runId: 'r-reused-bee' });
    const r = await reclaimOrphanedSpawns(db.sql, STALE); // STALE = REAL isSpawnProcessAlive
    expect(r.reclaimed).toBe(1);
    expect(r.spawnIds).toEqual(['reused-bee']);
    expect(await statusOf('reused-bee')).toBe('failed');
    const [row] = await db.sql<{ error_message: string }[]>`
      SELECT error_message FROM harness_shared.spawned_agents WHERE spawn_id = 'reused-bee'`;
    // Same-host + pid present → the "confirmed dead" reason (not host-presumed-dead).
    expect(row.error_message).toMatch(/child process \(pid .*\) confirmed dead/);
  });

  it('contrast: the SAME live pid as a launch-kind row reads ALIVE → kept (not reclaimed)', async () => {
    // run_id `launch-%` → kind:'launch' → plain /proc-existence; any live process counts.
    await insertSpawn('queen-on-reused', 'running', 10 * 60, { pid: livePid, host: ME, runId: 'launch-reused' });
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('queen-on-reused')).toBe('running');
  });

  it('isSpawnProcessAlive on the real reused pid directly: DEAD as spawn, ALIVE as launch', () => {
    expect(livePid).toBeGreaterThan(1);
    expect(livePid).not.toBe(process.pid);
    expect(isSpawnProcessAlive(livePid, 'spawn')).toBe(false); // cmdline lacks invoke-once
    expect(isSpawnProcessAlive(livePid, 'launch')).toBe(true); // any live process
  });
});

describe('recordSpawnPid + isSpawnProcessAlive (EI-85)', () => {
  it('records the pid + this host on an active row only', async () => {
    await insertSpawn('a', 'running', 5);
    await insertSpawn('term', 'done', 5);
    await recordSpawnPid(db.sql, 'a', 31337);
    await recordSpawnPid(db.sql, 'term', 31338); // terminal → WHERE excludes it
    const rows = await db.sql<{ spawn_id: string; pid: number | null; launcher_host: string | null; launcher_boot_id: string | null }[]>`
      SELECT spawn_id, pid, launcher_host, launcher_boot_id FROM harness_shared.spawned_agents ORDER BY spawn_id`;
    const a = rows.find((r) => r.spawn_id === 'a')!;
    expect(a.pid).toBe(31337);
    expect(a.launcher_host).toBe(hostname());
    // EI-2186: recordSpawnPid also stamps THIS process's boot id, so the boot
    // reconcile / reclaim can tell a live spawn from a prior incarnation's row.
    expect(a.launcher_boot_id).toBe(launcherBootId());
    const term = rows.find((r) => r.spawn_id === 'term')!;
    expect(term.pid).toBeNull();
    expect(term.launcher_boot_id).toBeNull(); // terminal → WHERE excludes it
  });

  it('isSpawnProcessAlive: a bogus pid reads as dead (never a false alive)', () => {
    // pid 1 is guarded out; a very high pid almost certainly does not exist, and
    // even if it did its cmdline would not name invoke-once.
    expect(isSpawnProcessAlive(1)).toBe(false);
    expect(isSpawnProcessAlive(2_147_480_000)).toBe(false);
    expect(isSpawnProcessAlive(-5)).toBe(false);
  });
});

describe('heartbeatSpawns keeps a live spawn out of reclaim range', () => {
  it('bumps heartbeat_at for active rows so a subsequent reclaim skips them', async () => {
    await insertSpawn('live', 'running', 10 * 60); // would be stale
    await heartbeatSpawns(db.sql, ['live']);       // ...but the host heartbeats it
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('live')).toBe('running');
  });

  it('is a no-op for an empty list and never resurrects a terminal row', async () => {
    await insertSpawn('terminal', 'done', 10 * 60);
    await heartbeatSpawns(db.sql, []);             // no-op
    await heartbeatSpawns(db.sql, ['terminal']);   // WHERE excludes terminal
    expect(await statusOf('terminal')).toBe('done');
  });
});

/**
 * EI-2186: the boot-id discriminator. A host/process restart leaves 'running' rows
 * from a DEAD prior incarnation that jam the spawn-admission ceiling. The recorded
 * pid is NOT stable across a reboot (reuse), and a stale launch row's reused pid can
 * read as "alive" so the heartbeat gets bumped and the row is never reclaimed — the
 * permanent jam. A row carrying a DIFFERENT (non-null) boot id than this process is
 * provably orphaned regardless of pid liveness.
 */
describe('reclaimOrphanedSpawns: prior-incarnation boot-id short-circuits the pid false-alive (EI-2186)', () => {
  const ME = hostname();
  let original: string;
  beforeAll(() => { original = launcherBootId(); });
  beforeEach(() => { __setLauncherBootIdForTests('boot-current'); });
  afterAll(() => { __setLauncherBootIdForTests(original); });

  it('a STALE same-host row with a mismatched boot id is reclaimed even though its pid reads ALIVE', async () => {
    // pid IS in alivePids → the pid path alone would KEEP it (the false-alive bug). The
    // boot-id mismatch must override that and reclaim the orphaned slot.
    await insertSpawn('zombie', 'running', 10 * 60, { pid: 4242, host: ME, runId: 'launch-z', bootId: 'boot-prior' });
    alivePids.add(4242);
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(1);
    expect(r.spawnIds).toEqual(['zombie']);
    expect(await statusOf('zombie')).toBe('failed');
    const [row] = await db.sql<{ error_message: string }[]>`
      SELECT error_message FROM harness_shared.spawned_agents WHERE spawn_id = 'zombie'`;
    expect(row.error_message).toMatch(/prior operator incarnation \(boot-id mismatch/);
  });

  it('a STALE same-host row carrying the CURRENT boot id still uses the pid liveness check (kept when alive)', async () => {
    await insertSpawn('current-live', 'running', 10 * 60, { pid: 4243, host: ME, bootId: 'boot-current' });
    alivePids.add(4243); // genuinely alive child of THIS incarnation → kept
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('current-live')).toBe('running');
  });
});

/**
 * EI-2186: reconcileSpawnAdmissionOnBoot — the release-on-host-restart reconcile.
 * Runs ONCE at operator boot and frees same-host admission debits owned by a dead
 * prior incarnation, REGARDLESS of heartbeat freshness (the crucial difference from
 * the periodic sweep — it clears rows the false-alive bump kept fresh).
 */
describe('reconcileSpawnAdmissionOnBoot (EI-2186 boot reconcile)', () => {
  const ME = hostname();
  const CURRENT = 'boot-current';
  let original: string;
  beforeAll(() => { original = launcherBootId(); });
  beforeEach(() => { __setLauncherBootIdForTests(CURRENT); });
  afterAll(() => { __setLauncherBootIdForTests(original); });

  it('reclaims a same-host prior-incarnation row even with a FRESH heartbeat (the jam signature)', async () => {
    // Fresh heartbeat (1s) — the periodic reclaim would never see it as a candidate.
    await insertSpawn('jammed', 'running', 1, { pid: 4242, host: ME, runId: 'launch-old', bootId: 'boot-prior' });
    const r = await reconcileSpawnAdmissionOnBoot(db.sql);
    expect(r.reclaimed).toBe(1);
    expect(r.spawnIds).toEqual(['jammed']);
    expect(r.workspaces).toEqual([WS]);
    expect(await statusOf('jammed')).toBe('failed');
    const [row] = await db.sql<{ error_message: string }[]>`
      SELECT error_message FROM harness_shared.spawned_agents WHERE spawn_id = 'jammed'`;
    expect(row.error_message).toMatch(/reclaimed at operator boot/);
  });

  it('reclaims restarting rows too, and frees the ceiling count', async () => {
    await insertSpawn('r1', 'restarting', 1, { host: ME, bootId: 'boot-prior' });
    await insertSpawn('r2', 'running', 1, { host: ME, bootId: 'boot-prior' });
    expect(await runningCount()).toBe(2);
    const r = await reconcileSpawnAdmissionOnBoot(db.sql);
    expect(r.reclaimed).toBe(2);
    expect(await runningCount()).toBe(0); // ceiling fully freed
  });

  it('does NOT reclaim a row carrying the CURRENT boot id (a live spawn of this process)', async () => {
    await insertSpawn('mine', 'running', 1, { pid: process.pid, host: ME, bootId: CURRENT });
    const r = await reconcileSpawnAdmissionOnBoot(db.sql);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('mine')).toBe('running');
  });

  it('reclaims a null-boot-id row whose heartbeat is STALE (pre-migration orphan)', async () => {
    await insertSpawn('legacy-stale', 'running', 10 * 60, { host: ME });
    const r = await reconcileSpawnAdmissionOnBoot(db.sql);
    expect(r.reclaimed).toBe(1);
    expect(await statusOf('legacy-stale')).toBe('failed');
  });

  it('does NOT reclaim a null-boot-id row whose heartbeat is FRESH (current-process mid-insert, safe)', async () => {
    await insertSpawn('fresh-unstamped', 'running', 2, { host: ME });
    const r = await reconcileSpawnAdmissionOnBoot(db.sql);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('fresh-unstamped')).toBe('running');
  });

  it('leaves a DIFFERENT-host prior-incarnation row alone (a federated peer owns it)', async () => {
    await insertSpawn('peer', 'running', 1, { host: 'other-box', bootId: 'peer-boot' });
    const r = await reconcileSpawnAdmissionOnBoot(db.sql);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('peer')).toBe('running');
  });

  it('never touches terminal rows', async () => {
    await insertSpawn('doneRow', 'done', 1, { host: ME, bootId: 'boot-prior' });
    const r = await reconcileSpawnAdmissionOnBoot(db.sql);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('doneRow')).toBe('done');
  });
});

/**
 * WI-1499 (bg-host-agent-spawn-scope-isolation-2026-07-02): a prior-incarnation
 * candidate whose recorded pid is CONFIRMED ALIVE survived the bg-host restart
 * (systemd-run --user --scope keeps the agent's cgroup outside bg-host's own —
 * see `buildIsolatedScopeArgv` / orchestrator-runner.ts's `runChild`). Such a row
 * is RE-ATTACHED to the fresh incarnation instead of reclaimed: same row, same
 * `running` status, no lost work, no reclaim-churn. Only a `spawn`-kind row (an
 * actual invoke-once bee/queen child) is eligible — a `launch`-kind row (an
 * in-process firing loop, e.g. the hive-loop driver) is ALWAYS reclaimed at boot
 * regardless of pid liveness, because ITS firing process is this process's dead
 * predecessor by construction (it can't have survived a restart of the process
 * that WAS it). isAlive is injected (STALE_FAKE-style) so alive/dead is
 * deterministic without touching a real /proc.
 */
describe('reconcileSpawnAdmissionOnBoot RE-ATTACH (WI-1499 scope-isolated survivors)', () => {
  const ME = hostname();
  let original: string;
  beforeAll(() => { original = launcherBootId(); });
  beforeEach(() => { __setLauncherBootIdForTests('boot-current'); });
  afterAll(() => { __setLauncherBootIdForTests(original); });

  it('RE-ATTACHES a same-host prior-incarnation spawn-kind row whose pid is ALIVE — never reclaimed', async () => {
    await insertSpawn('survivor', 'running', 1, { pid: 4242, host: ME, bootId: 'boot-prior', runId: 'r-survivor' });
    alivePids.add(4242);
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { isAlive: fakeAlive });
    expect(r.reclaimed).toBe(0);
    expect(r.spawnIds).toEqual([]);
    expect(r.reattached).toEqual(['survivor']);
    expect(await statusOf('survivor')).toBe('running'); // untouched status — it never died
    const [row] = await db.sql<{ launcher_boot_id: string; fresh: boolean }[]>`
      SELECT launcher_boot_id, heartbeat_at > now() - interval '30 seconds' AS fresh
        FROM harness_shared.spawned_agents WHERE spawn_id = 'survivor'`;
    expect(row.launcher_boot_id).toBe('boot-current'); // handed off to THIS incarnation
    expect(row.fresh).toBe(true); // heartbeat bumped so the periodic sweep also skips it
  });

  it('RECLAIMS a same-host prior-incarnation spawn-kind row whose pid is DEAD', async () => {
    await insertSpawn('gone', 'running', 1, { pid: 9999, host: ME, bootId: 'boot-prior', runId: 'r-gone' });
    // 9999 not added to alivePids → confirmed dead.
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { isAlive: fakeAlive });
    expect(r.reclaimed).toBe(1);
    expect(r.reattached).toEqual([]);
    expect(await statusOf('gone')).toBe('failed');
  });

  it('a launch-kind row is ALWAYS reclaimed at boot even when its recorded pid reads ALIVE', async () => {
    await insertSpawn('driver', 'running', 1, { pid: 4242, host: ME, bootId: 'boot-prior', runId: 'launch-driver' });
    alivePids.add(4242);
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { isAlive: fakeAlive });
    expect(r.reclaimed).toBe(1);
    expect(r.reattached).toEqual([]);
    expect(await statusOf('driver')).toBe('failed');
  });

  it('mixed batch: re-attaches the live survivor, reclaims the dead sibling + the launch-kind row', async () => {
    await insertSpawn('survivor2', 'running', 1, { pid: 111, host: ME, bootId: 'boot-prior', runId: 'r-survivor2' });
    await insertSpawn('gone2', 'running', 1, { pid: 222, host: ME, bootId: 'boot-prior', runId: 'r-gone2' });
    await insertSpawn('driver2', 'running', 1, { pid: 111, host: ME, bootId: 'boot-prior', runId: 'launch-driver2' });
    alivePids.add(111); // shared pid: alive for the spawn-kind row, irrelevant for the launch-kind row (always reclaimed)
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { isAlive: fakeAlive });
    expect(r.reattached).toEqual(['survivor2']);
    expect(new Set(r.spawnIds)).toEqual(new Set(['gone2', 'driver2']));
    expect(r.reclaimed).toBe(2);
    expect(await statusOf('survivor2')).toBe('running');
    expect(await statusOf('gone2')).toBe('failed');
    expect(await statusOf('driver2')).toBe('failed');
  });

  it('never frees the concurrency ceiling for a re-attached row (it still holds its slot)', async () => {
    await insertSpawn('survivor3', 'running', 1, { pid: 333, host: ME, bootId: 'boot-prior', runId: 'r-survivor3' });
    alivePids.add(333);
    expect(await runningCount()).toBe(1);
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { isAlive: fakeAlive });
    expect(r.reattached).toEqual(['survivor3']);
    expect(await runningCount()).toBe(1); // still counted — the agent is still running
  });
});

/**
 * EI-85 (restart-kills): reconcileSpawnAdmissionOnBoot RE-LAUNCHES a reclaimed
 * queen/bee whose durable work-item is non-terminal, instead of losing the work.
 * The dead row is still settled `failed` (ceiling debit freed); a fresh row is
 * launched via the INJECTED relaunch seam. A terminal/missing work-item is
 * reclaimed-only (the legacy behaviour). The relaunch seam is captured (no live
 * operator), so these pin the BRANCHING + the row-settlement, not a real re-fire.
 */
describe('reconcileSpawnAdmissionOnBoot RE-LAUNCH (EI-85 restart-kills)', () => {
  const ME = hostname();
  const PRIOR = { host: ME, bootId: 'boot-prior' };
  let original: string;
  beforeAll(() => { original = launcherBootId(); });
  beforeEach(() => { __setLauncherBootIdForTests('boot-current'); });
  afterAll(() => { __setLauncherBootIdForTests(original); });

  /** A capturing relaunch seam: records every spawn it was asked to re-fire and
   *  returns `accept` (default true → "re-launched"). */
  function captureRelaunch(accept = true) {
    const seen: { spawnId: string; childRole: string; workItemId: string | null; workItemStatus: string | null }[] = [];
    const relaunch = async (s: {
      spawnId: string; childRole: string; workItemId: string | null; workItemStatus: string | null;
    }) => {
      seen.push({ spawnId: s.spawnId, childRole: s.childRole, workItemId: s.workItemId, workItemStatus: s.workItemStatus });
      return accept;
    };
    return { seen, relaunch };
  }

  it('RE-LAUNCHES a bee whose work-item is non-terminal (in_progress) — and still settles the dead row failed', async () => {
    await insertWorkItem('F-1', 'in_progress');
    await insertSpawn('bee1', 'running', 1, { ...PRIOR, childRole: 'bee', parentRole: 'queen', featureId: 'F-1' });
    const { seen, relaunch } = captureRelaunch();
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { relaunch });
    // dead row settled (ceiling freed) AND re-launched
    expect(r.reclaimed).toBe(1);
    expect(await statusOf('bee1')).toBe('failed');
    expect(r.relaunched).toEqual(['bee1']);
    // the seam saw the bee with its resolved work-item status
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ spawnId: 'bee1', childRole: 'bee', workItemId: 'F-1', workItemStatus: 'in_progress' });
    // the reason records the boot reclaim (debit freed even though re-launched)
    const [row] = await db.sql<{ error_message: string }[]>`
      SELECT error_message FROM harness_shared.spawned_agents WHERE spawn_id = 'bee1'`;
    expect(row.error_message).toMatch(/reclaimed at operator boot/);
  });

  it('RECLAIMS-ONLY (no re-launch) a bee whose work-item is TERMINAL (passed)', async () => {
    await insertWorkItem('F-done', 'passed');
    await insertSpawn('beeDone', 'running', 1, { ...PRIOR, childRole: 'bee', parentRole: 'queen', featureId: 'F-done' });
    const { seen, relaunch } = captureRelaunch();
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { relaunch });
    expect(r.reclaimed).toBe(1);
    expect(await statusOf('beeDone')).toBe('failed');
    expect(r.relaunched).toEqual([]); // terminal work → no re-launch
    expect(seen).toHaveLength(0);
  });

  it('RECLAIMS-ONLY a bee with NO work-item id (nothing durable to resume)', async () => {
    await insertSpawn('beeNoItem', 'running', 1, { ...PRIOR, childRole: 'bee', parentRole: 'queen' });
    const { seen, relaunch } = captureRelaunch();
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { relaunch });
    expect(r.relaunched).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(await statusOf('beeNoItem')).toBe('failed');
  });

  it('RE-LAUNCHES a queen unconditionally (the hive driver, no single work-item)', async () => {
    await insertSpawn('queen1', 'running', 1, { ...PRIOR, childRole: 'queen', runId: 'blueprint-run:default:coding:1' });
    const { seen, relaunch } = captureRelaunch();
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { relaunch });
    expect(r.relaunched).toEqual(['queen1']);
    expect(seen[0]).toMatchObject({ childRole: 'queen' });
    expect(await statusOf('queen1')).toBe('failed');
  });

  it('a relaunch seam that DECLINES (returns false) leaves the row reclaimed, not in `relaunched`', async () => {
    await insertWorkItem('F-2', 'validating');
    await insertSpawn('beeDeclined', 'running', 1, { ...PRIOR, childRole: 'bee', parentRole: 'queen', featureId: 'F-2' });
    const { relaunch } = captureRelaunch(false); // seam declines
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { relaunch });
    expect(r.reclaimed).toBe(1);
    expect(r.relaunched).toEqual([]); // declined → not counted as relaunched
    expect(await statusOf('beeDeclined')).toBe('failed'); // still settled (debit freed)
  });

  it('a throwing relaunch seam never aborts the reconcile — the row stays reclaimed', async () => {
    await insertWorkItem('F-3', 'in_progress');
    await insertSpawn('beeThrow', 'running', 1, { ...PRIOR, childRole: 'bee', parentRole: 'queen', featureId: 'F-3' });
    const relaunch = async () => { throw new Error('boom'); };
    // The reconcile catches + logs the re-fire failure (a warn is EXPECTED here);
    // mock it so vitest-fail-on-console doesn't trip, and assert it was logged.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await reconcileSpawnAdmissionOnBoot(db.sql, { relaunch });
      expect(r.reclaimed).toBe(1);
      expect(r.relaunched).toEqual([]);
      expect(await statusOf('beeThrow')).toBe('failed');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/boot re-launch failed for bee beeThrow/));
    } finally {
      warn.mockRestore();
    }
  });

  it('WITHOUT a relaunch seam (flag OFF), the reconcile is reclaim-only (legacy, byte-identical)', async () => {
    await insertWorkItem('F-4', 'in_progress');
    await insertSpawn('beeNoSeam', 'running', 1, { ...PRIOR, childRole: 'bee', parentRole: 'queen', featureId: 'F-4' });
    const r = await reconcileSpawnAdmissionOnBoot(db.sql); // no relaunch passed
    expect(r.reclaimed).toBe(1);
    expect(r.relaunched).toEqual([]);
    expect(await statusOf('beeNoSeam')).toBe('failed');
  });

  it('mixed batch: re-launches the non-terminal bee + the queen, reclaims-only the terminal + non-queen/bee rows', async () => {
    await insertWorkItem('F-live', 'in_progress');
    await insertWorkItem('F-dead', 'deprecated');
    await insertSpawn('beeLive', 'running', 1, { ...PRIOR, childRole: 'bee', parentRole: 'queen', featureId: 'F-live' });
    await insertSpawn('beeDead', 'running', 1, { ...PRIOR, childRole: 'bee', parentRole: 'queen', featureId: 'F-dead' });
    await insertSpawn('queenX', 'running', 1, { ...PRIOR, childRole: 'queen' });
    await insertSpawn('workerX', 'running', 1, { ...PRIOR, childRole: 'worker', featureId: 'F-live' });
    const { seen, relaunch } = captureRelaunch();
    const r = await reconcileSpawnAdmissionOnBoot(db.sql, { relaunch });
    expect(r.reclaimed).toBe(4); // all four dead rows settled (ceiling fully freed)
    expect(new Set(r.relaunched)).toEqual(new Set(['beeLive', 'queenX'])); // only these re-launch
    expect(new Set(seen.map((s) => s.spawnId))).toEqual(new Set(['beeLive', 'queenX']));
    for (const id of ['beeLive', 'beeDead', 'queenX', 'workerX']) {
      expect(await statusOf(id)).toBe('failed');
    }
  });
});

/** liveness-hardening P-008: the same heartbeat tick stamps last_output_at for
 *  spawns whose stream moved — zero extra write cadence, monotonic. */
describe('heartbeatSpawns stamps last_output_at (P-008 stream activity)', () => {
  async function lastOutputOf(spawnId: string): Promise<number | null> {
    const rows = await db.sql<{ t: Date | null }[]>`
      SELECT last_output_at AS t FROM harness_shared.spawned_agents WHERE spawn_id = ${spawnId}`;
    return rows[0]?.t ? rows[0].t.getTime() : null;
  }

  it('stamps output spawns and leaves silent ones NULL in one tick', async () => {
    await insertSpawn('talking', 'running', 0);
    await insertSpawn('silent', 'running', 0);
    const at = Date.now() - 1_000;
    await heartbeatSpawns(db.sql, ['talking', 'silent'], new Map([['talking', at]]));
    expect(await lastOutputOf('talking')).toBe(at);
    expect(await lastOutputOf('silent')).toBeNull();
  });

  it('is monotonic — a racing older stamp never regresses last_output_at', async () => {
    await insertSpawn('bee', 'running', 0);
    const newer = Date.now();
    const older = newer - 60_000;
    await heartbeatSpawns(db.sql, ['bee'], new Map([['bee', newer]]));
    await heartbeatSpawns(db.sql, ['bee'], new Map([['bee', older]]));
    expect(await lastOutputOf('bee')).toBe(newer);
  });

  it('never stamps a terminal row', async () => {
    await insertSpawn('gone', 'done', 0);
    await heartbeatSpawns(db.sql, ['gone'], new Map([['gone', Date.now()]]));
    expect(await lastOutputOf('gone')).toBeNull();
  });
});

/**
 * reclaimWedgedSpawns (RECLAIM_STALLED, real PG) — the "stalled, not just dead" half
 * of the spawn-reclaim floor. Selects supervised-LIVE (fresh heartbeat) rows that are
 * stream-silent past the ACTION threshold and were launched by THIS incarnation, then
 * hands each to the injected reap seam. These are the recurrence guards for BRIEF D:
 * a wedged bee MUST be selected for reclaim (if the wiring is reverted, the happy-path
 * test fails), and the safety filters MUST hold (no killing of fresh / no-output /
 * stale-host / cross-host / cross-incarnation / operator-pid / terminal rows).
 */
describe('reclaimWedgedSpawns (RECLAIM_STALLED — wedged-but-alive reclaim, real PG)', () => {
  const ME2 = hostname();
  const BOOT = launcherBootId();
  // A child pid distinct from the operator (test-runner) pid — the SQL excludes
  // pid = process.pid so an in-process launch (Queen) is never killed.
  const CHILD_PID = process.pid + 1;
  const SILENT = { silentMs: 30 * 60_000, staleMs: 5 * 60_000 };

  /** A reap seam that records the candidates it was handed and accepts them all. */
  function recordingReap() {
    const seen: WedgedSpawnCandidate[] = [];
    const fn = async (c: WedgedSpawnCandidate) => {
      seen.push(c);
      return true;
    };
    return { fn, seen };
  }

  /** Insert a row that IS a valid wedged candidate unless an override breaks one rule. */
  async function insertWedged(
    spawnId: string,
    over: {
      status?: string;
      heartbeatAgoSec?: number;
      lastOutputAgoSec?: number;
      host?: string;
      bootId?: string;
      pid?: number;
    } = {},
  ) {
    await insertSpawn(spawnId, over.status ?? 'running', over.heartbeatAgoSec ?? 5, {
      host: over.host ?? ME2,
      bootId: over.bootId ?? BOOT,
      pid: over.pid ?? CHILD_PID,
      lastOutputAgoSec: over.lastOutputAgoSec ?? 31 * 60, // silent 31 min > 30-min action window
    });
  }

  it('reaps a wedged same-host this-incarnation child: fresh heartbeat + output silent > action window', async () => {
    await insertWedged('wedged');
    const { fn, seen } = recordingReap();
    const r = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(r.reclaimed).toBe(1);
    expect(r.spawnIds).toEqual(['wedged']);
    expect(r.workspaces).toEqual([WS]); // freed → announced to over-ceiling waiters
    // The candidate carries the observed silence so the seam can frame the reason.
    expect(seen).toHaveLength(1);
    expect(seen[0].spawnId).toBe('wedged');
    expect(seen[0].silentMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('does NOT reap a spawn that emitted recently (silent under the action window)', async () => {
    await insertWedged('chatty', { lastOutputAgoSec: 2 * 60 }); // 2 min silent
    const { fn, seen } = recordingReap();
    const r = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(r.reclaimed).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('does NOT reap a spawn with NO observed output (absence of signal ≠ wedge)', async () => {
    // lastOutputAgoSec omitted ⇒ last_output_at NULL.
    await insertSpawn('mute', 'running', 5, { host: ME2, bootId: BOOT, pid: CHILD_PID });
    const { fn } = recordingReap();
    const r = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(r.reclaimed).toBe(0);
  });

  it('does NOT reap a stale-heartbeat spawn — the orphan sweep owns that one', async () => {
    await insertWedged('stale-host', { heartbeatAgoSec: 10 * 60 }); // heartbeat 10 min stale
    const { fn } = recordingReap();
    const r = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(r.reclaimed).toBe(0);
  });

  it('does NOT reap a DIFFERENT-host wedged row (the owning host reaps it)', async () => {
    await insertWedged('remote', { host: 'some-other-box' });
    const { fn } = recordingReap();
    const r = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(r.reclaimed).toBe(0);
  });

  it('does NOT reap a PRIOR-incarnation row (boot-id mismatch — not locally killable)', async () => {
    await insertWedged('prior', { bootId: 'some-dead-prior-boot-id' });
    const { fn } = recordingReap();
    const r = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(r.reclaimed).toBe(0);
  });

  it('does NOT reap an in-process launch recorded with the operator pid (never kills the Queen/operator)', async () => {
    await insertWedged('queen-launch', { pid: process.pid });
    const { fn } = recordingReap();
    const r = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(r.reclaimed).toBe(0);
  });

  it('never touches terminal rows', async () => {
    for (const status of ['done', 'failed', 'cancelled', 'reaped']) {
      await insertWedged(`term-${status}`, { status });
    }
    const { fn } = recordingReap();
    const r = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(r.reclaimed).toBe(0);
  });

  it('counts only the rows the seam ACCEPTS (a declined row is not reclaimed)', async () => {
    await insertWedged('take');
    await insertWedged('decline');
    const r = await reclaimWedgedSpawns(
      db.sql,
      async (c) => c.spawnId === 'take',
      SILENT,
    );
    expect(r.reclaimed).toBe(1);
    expect(r.spawnIds).toEqual(['take']);
  });

  it('is idempotent — a row the seam settled terminal is not re-reaped next sweep', async () => {
    await insertWedged('once');
    // Seam simulates cancelSubtree: flip the row terminal, the way the real reap does.
    const reapAndSettle = async (c: WedgedSpawnCandidate) => {
      await db.sql`UPDATE harness_shared.spawned_agents SET status = 'cancelled' WHERE spawn_id = ${c.spawnId}`;
      return true;
    };
    const first = await reclaimWedgedSpawns(db.sql, reapAndSettle, SILENT);
    expect(first.reclaimed).toBe(1);
    const { fn, seen } = recordingReap();
    const second = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(second.reclaimed).toBe(0); // already terminal → never offered again
    expect(seen).toHaveLength(0);
  });

  it('reaps restarting rows too (they also hold a concurrency slot)', async () => {
    await insertWedged('restarting-wedge', { status: 'restarting' });
    const { fn } = recordingReap();
    const r = await reclaimWedgedSpawns(db.sql, fn, SILENT);
    expect(r.reclaimed).toBe(1);
  });
});

// ————————————————————————————————————————————————————————————————————————————
// Dead-holder claim release (2026-07-02): reclaiming a nursery row to 'failed'
// must also free the durable claims the dead spawn still holds — feature
// taken_by, issue assignee, plan_item_claims.owner — or every re-placement's
// compare-and-claim rejects until a slower lane ages the claim off.
// ————————————————————————————————————————————————————————————————————————————

/** Seed a feature row already CLAIMED by `takenBy` (taken_at seconds-ago). */
async function insertClaimedFeature(
  featureId: string,
  takenBy: string,
  opts: { status?: string; takenAgoSec?: number } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (feature_id, workspace_id, harness_slug, status, taken_by, taken_at)
    VALUES (${featureId}, ${WS}, 'papercup', ${opts.status ?? 'wip'}, ${takenBy},
            now() - ${opts.takenAgoSec ?? 60}::int * interval '1 second')`;
}

async function featureClaim(featureId: string): Promise<{ taken_by: string | null; status: string | null }> {
  const rows = await db.sql<{ taken_by: string | null; status: string | null }[]>`
    SELECT taken_by, status FROM harness_shared.harness_features_consolidated
     WHERE feature_id = ${featureId}`;
  return rows[0] ?? { taken_by: '(none)', status: '(none)' };
}

describe('dead-holder claim release (reclaim frees taken_by/assignee/plan claims)', () => {
  it('reclaimOrphanedSpawns frees the reclaimed spawn’s feature + issue + plan claims and requeues the feature', async () => {
    await insertSpawn('s-dead-1', 'running', 10 * 60);
    await insertClaimedFeature('F-100', 's-dead-1', { status: 'wip' });
    await db.sql`
      INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, assignee, assigned_at)
      VALUES (${WS}, 'EI-9001', 's-dead-1', now())`;
    await db.sql`
      INSERT INTO harness_shared.plan_item_claims (workspace_id, harness_slug, plan_slug, item_id, owner)
      VALUES (${WS}, 'papercup', 'some-plan', 'P-001', 's-dead-1')`;

    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(1);
    expect(r.claimsReleased).toEqual({ features: 1, issues: 1, planClaims: 1 });

    expect(await featureClaim('F-100')).toEqual({ taken_by: null, status: 'todo' });
    const [issue] = await db.sql<{ assignee: string | null; assigned_at: Date | null }[]>`
      SELECT assignee, assigned_at FROM harness_shared.engineer_issues WHERE issue_id = 'EI-9001'`;
    expect(issue.assignee).toBeNull();
    expect(issue.assigned_at).toBeNull();
    const claims = await db.sql<{ item_id: string }[]>`
      SELECT item_id FROM harness_shared.plan_item_claims WHERE owner = 's-dead-1'`;
    expect(claims).toHaveLength(0);
  });

  it('a claim in a NON-requeue state is freed but keeps its status (mirrors releaseSpawnWorkItemClaim)', async () => {
    await insertSpawn('s-dead-2', 'running', 10 * 60);
    await insertClaimedFeature('F-101', 's-dead-2', { status: 'blocked' });
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(1);
    expect(await featureClaim('F-101')).toEqual({ taken_by: null, status: 'blocked' });
  });

  it('a LIVE spawn’s claim is untouched by the reclaim sweep', async () => {
    await insertSpawn('s-live-1', 'running', 5); // fresh heartbeat — not a candidate
    await insertClaimedFeature('F-102', 's-live-1');
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(0);
    expect(await featureClaim('F-102')).toEqual({ taken_by: 's-live-1', status: 'wip' });
  });

  it('IDLE sweep (no fresh orphans) still clears the HISTORIC backlog: claims whose s-… holder is already terminal', async () => {
    await insertSpawn('s-settled', 'failed', 60); // settled by a pre-fix sweep — terminal row, claim left behind
    await insertClaimedFeature('F-103', 's-settled');
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(0);
    expect(r.claimsReleased).toEqual({ features: 1, issues: 0, planClaims: 0 });
    expect(await featureClaim('F-103')).toEqual({ taken_by: null, status: 'todo' });
  });

  it('sweepStaleSpawnClaims: absent-row guard — a young claim with NO nursery row is kept (cup:spawn’s claim-then-insert window), an old one is freed', async () => {
    await insertClaimedFeature('F-104', 's-ghost-young', { takenAgoSec: 5 * 60 });
    await insertClaimedFeature('F-105', 's-ghost-old', { takenAgoSec: 2 * 3600 });
    const released = await sweepStaleSpawnClaims(db.sql);
    expect(released.features).toBe(1);
    expect(await featureClaim('F-104')).toEqual({ taken_by: 's-ghost-young', status: 'wip' });
    expect(await featureClaim('F-105')).toEqual({ taken_by: null, status: 'todo' });
  });

  it('sweepStaleSpawnClaims never touches a claim held by a RUNNING spawn, or a non-spawn (human/session) holder', async () => {
    await insertSpawn('s-running', 'running', 5);
    await insertClaimedFeature('F-106', 's-running');
    await insertClaimedFeature('F-107', 'su-human-session', { takenAgoSec: 3 * 3600 });
    const released = await sweepStaleSpawnClaims(db.sql);
    expect(released.features).toBe(0);
    expect(await featureClaim('F-106')).toEqual({ taken_by: 's-running', status: 'wip' });
    expect(await featureClaim('F-107')).toEqual({ taken_by: 'su-human-session', status: 'wip' });
  });

  it('releaseClaimsOfDeadSpawns is a no-op for an empty id list', async () => {
    await insertClaimedFeature('F-108', 's-whoever');
    const released = await releaseClaimsOfDeadSpawns(db.sql, []);
    expect(released).toEqual({ features: 0, issues: 0, planClaims: 0 });
    expect(await featureClaim('F-108')).toEqual({ taken_by: 's-whoever', status: 'wip' });
  });

  it('boot reconcile frees the dead bee’s claim BEFORE relaunch, so the relaunched bee can re-claim under its new spawn id', async () => {
    __setLauncherBootIdForTests('boot-now');
    try {
      await insertSpawn('s-boot-dead', 'running', 5, {
        host: hostname(), bootId: 'boot-prior', childRole: 'bee', featureId: 'F-109',
      });
      await insertClaimedFeature('F-109', 's-boot-dead', { status: 'wip' });
      // Relaunch seam records what it saw; by the time it fires the claim must be free.
      const claimStateAtRelaunch: Array<string | null> = [];
      const r = await reconcileSpawnAdmissionOnBoot(db.sql, {
        relaunch: async () => {
          claimStateAtRelaunch.push((await featureClaim('F-109')).taken_by);
          return true;
        },
      });
      expect(r.relaunched).toEqual(['s-boot-dead']);
      expect(claimStateAtRelaunch).toEqual([null]);
    } finally {
      __setLauncherBootIdForTests(null);
    }
  });
});
