/**
 * hive-loop-spawn-hygiene.integration.test.ts — plan hive-loop-e2e-testing-2026-06-10
 * P-005: concurrency + hygiene of the spawn chain, driven through the REAL
 * operator-spawn engine (`spawnAgentInHarness`) with REAL OS child processes.
 *
 * The unit halves already exist (spawn-reclaim.integration.test.ts proves the
 * reclaim SQL; nursery.integration.test.ts proves cancelSubtree's claim/lock
 * release). THIS file proves the pieces wired together as the loop runs them:
 *
 *   1. CEILING + QUEUE/AWAIT (D-004 — never silent-drop): with the fleet
 *      ceiling at 2 and two live spawns, a third spawn is rejected WITH the
 *      `spawn-slot:freed:<ws>` wake key and a durable failed nursery row; a
 *      waiter registered on that key (what `events:await` does) is FIRED when a
 *      slot frees, and the retried spawn is admitted — the freed slot starts
 *      the queued work.
 *   2. CANCEL: cancelSubtree + abortLocalSpawn (the two halves of fleet:cancel)
 *      flip the durable row to 'cancelled' AND actually kill the running OS
 *      process — the slot-free announce rides the child's exit.
 *   3. STALE-HEARTBEAT RECLAIM: 'running' rows from a dead host (heartbeat_at
 *      10 min stale) are reclaimed in-line by the next spawn attempt — flipped
 *      to 'failed' with the reclaim message, their slots freed (the new spawn
 *      is admitted at what was a full ceiling) and the slot key fired.
 *
 * The ONLY stub is `spawnInvokeOnce` (the agent-CLI boundary): replaced with a
 * real `sleep` child process that honors the engine's AbortSignal — so the
 * nursery rows, heartbeat loop, ceiling counts, announce path, and abort
 * registry are all the production code paths.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn as spawnProc } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-spawn-hyg';
const SLUG = 'spawn-hyg';
const CEILING = 2;

process.env.PAPERCUSP_WORKSPACE_ID = WS;
process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';

// ── Seam: the agent-CLI boundary. A real OS child (sleep) that honors the
// engine's AbortSignal — SIGTERM on abort, like the real invoke-once kill path.
const h = vi.hoisted(() => ({
  pids: [] as number[],
  sleepSec: 30,
}));
const stubInvokeOnce = async (
  _projectDir: string,
  _role: string,
  _extras: string[],
  _extraEnv: Record<string, string>,
  opts?: { signal?: AbortSignal },
) =>
  new Promise<{ output: string; exitCode: number; stderr: string }>((resolve) => {
    const child = spawnProc('sleep', [String(h.sleepSec)], { stdio: 'ignore' });
    if (child.pid) h.pids.push(child.pid);
    const onAbort = () => child.kill('SIGTERM');
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('exit', (code, sig) => {
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve({ output: 'stub agent done', exitCode: sig ? 1 : (code ?? 0), stderr: sig ? `killed: ${sig}` : '' });
    });
  });
vi.mock('../dbos/orchestrator-runner', () => ({
  spawnInvokeOnce: stubInvokeOnce,
  // spawnInvokeOnceWithFallback (the sidecar-rollout wrapper, PAPERCUSP_SPAWNER_SIDECAR
  // opt-in) is what operator-spawn.ts actually calls now; with the env unset (the
  // default, and unset here) it just delegates straight to spawnInvokeOnce, so the
  // mock does the same — vi.mock replaces the WHOLE module, so an unlisted export is
  // undefined, not "falls through to the real implementation".
  spawnInvokeOnceWithFallback: stubInvokeOnce,
}));
// Pin the fleet ceiling to 2 so the test fills it with two spawns.
vi.mock('../rate-limit-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rate-limit-config')>();
  return {
    ...actual,
    getCachedRateLimitConfig: () => ({ ...actual.getCachedRateLimitConfig(), maxSimultaneousAgents: CEILING }),
  };
});

let db: OrgTestDb;
let projectDir: string;
let spawnAgentInHarness: typeof import('./operator-spawn').spawnAgentInHarness;
let abortLocalSpawn: typeof import('./operator-spawn').abortLocalSpawn;
let spawnSlotEventKey: typeof import('./operator-spawn').spawnSlotEventKey;
let cancelSubtree: typeof import('./nursery').cancelSubtree;
let registerAwait: typeof import('../events/await/store').registerAwait;

beforeAll(async () => {
  db = await createOrgTestDb();
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.DATABASE_URL = db.adminDsn;

  ({ spawnAgentInHarness, abortLocalSpawn, spawnSlotEventKey } = await import('./operator-spawn'));
  ({ cancelSubtree } = await import('./nursery'));
  ({ registerAwait } = await import('../events/await/store'));

  // Register the test harness project (the registry the engine resolves from).
  projectDir = mkdtempSync(join(tmpdir(), 'spawn-hyg-'));
  const { saveHarnessRegistry } = await import('../harness-registry');
  await saveHarnessRegistry({ projects: [{ slug: SLUG, path: projectDir }] }, WS);
}, 180_000);

afterAll(async () => {
  // Belt-and-suspenders: no stub child outlives the test file.
  for (const pid of h.pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await db?.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

// coding-hive-bee-vs-coding-factory-scoper-2026-06-23: `validator` is a coding-FACTORY
// push-pipeline role that `spawnAgentInHarness` now refuses without pushed-feature
// context (no featureId / FEATURE_ID= extra / chunkId — "has nothing to do"). This
// test only exercises the generic spawn/nursery/ceiling machinery (concurrency,
// cancel, stale-heartbeat reclaim), not real pipeline routing, so a dummy featureId
// satisfies the guard exactly as its own error message suggests.
const spawnOne = () =>
  spawnAgentInHarness({ workspaceId: WS, harness: SLUG, role: 'validator', parentRole: 'operator', featureId: 'F-spawn-hyg-test' });

async function rowStatus(spawnId: string): Promise<string> {
  const [r] = await db.adminSql`
    SELECT status FROM harness_shared.spawned_agents WHERE spawn_id = ${spawnId}`;
  return r?.status as string;
}

async function pollFor(pred: () => Promise<boolean>, what: string, deadlineMs = 15_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function awaitFired(awaitId: number | string): Promise<boolean> {
  const [r] = await db.adminSql`
    SELECT fired_at FROM harness_shared.event_awaits WHERE id = ${awaitId}`;
  return r?.fired_at != null;
}

describe('spawn-chain concurrency + hygiene (P-005)', () => {
  it('ceiling → queue/await; cancel kills the child + frees the slot; the fired waiter retry is admitted', async () => {
    // The over-ceiling rejection's console.error IS the expected signal —
    // capture it (in-test: fail-on-console re-patches console per-test).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Fill the ceiling with two real children.
    const s1 = await spawnOne();
    const s2 = await spawnOne();
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(true);
    expect(await rowStatus(s1.spawnId!)).toBe('running');
    expect(await rowStatus(s2.spawnId!)).toBe('running');

    // Over-ceiling: queue+await, never silent-drop (D-004).
    const s3 = await spawnOne();
    expect(s3.ok).toBe(false);
    expect(s3.awaitEvent).toBe(spawnSlotEventKey(WS));
    expect(s3.error).toMatch(/fleet ceiling 2/);
    expect(await rowStatus(s3.spawnId!)).toBe('failed'); // durable visibility of the rejection
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('fleet ceiling'))).toBe(true);

    // The waiter an over-ceiling caller registers (events:await on the wake key).
    const waiter = await registerAwait({
      subscriberId: 'p005-waiter-1',
      eventKey: s3.awaitEvent!,
      policy: 'notify',
      workspaceId: WS,
    });
    expect(await awaitFired(waiter.id as never)).toBe(false);

    // ── Cancel s1: the durable flip + claim/lock release, then the local
    // process abort — the two halves of fleet:cancel.
    const actor = { ownerId: 'p005-op', ownerLabel: 'operator', source: 'principal', workspaceId: WS, userId: null };
    const res = await cancelSubtree(db.adminSql as never, {
      workspaceId: WS,
      rootSpawnId: s1.spawnId!,
      reason: 'P-005 cancel',
      actor: actor as never,
    });
    expect(res.cancelled.map((c) => c.spawnId)).toEqual([s1.spawnId]);
    expect(abortLocalSpawn(s1.spawnId!)).toBe(true);

    // The OS process actually dies, the row is terminal 'cancelled', and the
    // child's exit announces the freed slot → the waiter's await FIRES.
    const pid1 = h.pids[0];
    await pollFor(
      async () => {
        try {
          process.kill(pid1, 0);
          return false;
        } catch {
          return true;
        }
      },
      'stub child of s1 to die',
    );
    expect(await rowStatus(s1.spawnId!)).toBe('cancelled');
    await pollFor(() => awaitFired(waiter.id as never), 'spawn-slot:freed await to fire');

    // The woken waiter retries — and is admitted into the freed slot.
    const s4 = await spawnOne();
    expect(s4.ok).toBe(true);
    expect(await rowStatus(s4.spawnId!)).toBe('running');

    // Wind down: cancel the rest so nothing leaks past the test.
    for (const sid of [s2.spawnId!, s4.spawnId!]) {
      await cancelSubtree(db.adminSql as never, {
        workspaceId: WS,
        rootSpawnId: sid,
        reason: 'P-005 teardown',
        actor: actor as never,
      });
      abortLocalSpawn(sid);
    }
    await pollFor(
      async () => {
        const [r] = await db.adminSql`
          SELECT count(*)::int AS n FROM harness_shared.spawned_agents
           WHERE workspace_id = ${WS} AND status IN ('running','restarting')`;
        return r.n === 0;
      },
      'all spawns terminal',
    );
  }, 120_000);

  it('stale-heartbeat orphans are reclaimed in-line: slots freed, rows failed, waiter fired, new spawn admitted', async () => {
    // A dead host left two 'running' rows that fill the ceiling — heartbeats
    // 10 min stale (threshold is 5 min).
    const now = Date.now();
    for (const sid of ['s-orphan-1', 's-orphan-2']) {
      await db.adminSql`
        INSERT INTO harness_shared.spawned_agents
          (spawn_id, workspace_id, harness_slug, child_role, parent_role, run_id,
           status, started_at, heartbeat_at)
        VALUES
          (${sid}, ${WS}, ${SLUG}, 'worker', 'operator', ${`orphan-${now}`},
           'running', now() - interval '20 minutes', now() - interval '10 minutes')`;
    }
    const [pre] = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.spawned_agents
       WHERE workspace_id = ${WS} AND status IN ('running','restarting')`;
    expect(pre.n).toBe(CEILING); // the ceiling is (apparently) full

    const waiter = await registerAwait({
      subscriberId: 'p005-waiter-2',
      eventKey: spawnSlotEventKey(WS),
      policy: 'notify',
      workspaceId: WS,
    });

    // The next spawn attempt reclaims BEFORE counting (P-011): orphans freed,
    // announce fired, spawn admitted.
    const s = await spawnOne();
    expect(s.ok).toBe(true);

    for (const sid of ['s-orphan-1', 's-orphan-2']) {
      const [r] = await db.adminSql`
        SELECT status, error_message FROM harness_shared.spawned_agents WHERE spawn_id = ${sid}`;
      expect(r.status).toBe('failed');
      expect(r.error_message).toMatch(/heartbeat stale/);
    }
    await pollFor(() => awaitFired(waiter.id as never), 'reclaim slot-free await to fire');

    // Teardown the live spawn.
    const actor = { ownerId: 'p005-op', ownerLabel: 'operator', source: 'principal', workspaceId: WS, userId: null };
    await cancelSubtree(db.adminSql as never, {
      workspaceId: WS,
      rootSpawnId: s.spawnId!,
      reason: 'P-005 teardown',
      actor: actor as never,
    });
    abortLocalSpawn(s.spawnId!);
    await pollFor(async () => (await rowStatus(s.spawnId!)) === 'cancelled', 'final spawn cancelled');
  }, 120_000);
});
