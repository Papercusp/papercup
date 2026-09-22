/**
 * R-5, live plane — the plan-agent brief's plan-execution-agent count is a LIVE
 * ASSIGNMENT count, never a heartbeat-freshness threshold, and two reads in the
 * same process agree.
 *
 * Real PG on purpose. The unit suite for this module injects `deps`, so it can
 * only assert that the arithmetic over an ALREADY-CLASSIFIED presence list is
 * right. The thing R-5 actually claims — that the classification comes from the
 * shared liveness oracle rather than a `heartbeat_at > now() - interval` filter
 * — is invisible at that layer: both implementations produce identical results
 * for every fresh-heartbeat row, which is every row a unit fixture bothers to
 * write. Only a row that heartbeats perfectly WHILE BEING DEAD separates them,
 * and that row has to go through the real presence table and the real oracle.
 *
 * ⚠ THE WARM-DEAD CASE IS THE WHOLE POINT (WI-10002379, and the same trap as
 * WI-10002439): a heartbeat implementation counts a warm-dead session as ONE,
 * a live-assignment implementation counts ZERO. Fresh/warm agreement passes
 * under BOTH, so without this case that clause of the bar is unfalsifiable by
 * its own check.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { readDelegationCounts } from './delegation-counts';

const { createOrgTestDb } = await import('../test/_org-test-db');
const { _resetHarnessAdminUrlCacheForTests } = await import('./embedded-pg-discovery');

const WORKSPACE = 'delegation-counts-live-ws';
const SAVED_ADMIN_URL = process.env.HARNESS_ADMIN_DATABASE_URL;

/**
 * The cold-start probe body, run in a child with VITEST unset (see the D-014 case
 * at the bottom of this file for why that is the only place the prime executes).
 *
 * It reads ONE population and prints it between sentinels. The module specifier is
 * absolute so the child resolves the same source this file imports, and reading it
 * from `PROBE_DELEGATION_MODULE` first keeps the subject path overridable — that
 * single fallback is what makes a copy-out mutation probe possible without ever
 * mutating the shared tree.
 */
const COLD_PROBE_SOURCE = `
  const mod = process.env.PROBE_DELEGATION_MODULE || ${JSON.stringify(new URL('./delegation-counts.ts', import.meta.url).href)};
  const { readDelegationCounts } = await import(mod);
  const counts = await readDelegationCounts({ workspaceId: process.env.PROBE_WORKSPACE, sourceTimeoutMs: 30000 });
  const read = counts.plansAwaitingDelegation;
  process.stdout.write('<<PROBE ' + JSON.stringify({
    status: read.status,
    count: read.status === 'known' ? read.value.count : null,
    degradedSources: counts.degradedSources,
  }) + ' PROBE>>');
`;

/**
 * A pid that is CONFIRMED dead right now.
 *
 * `probeProcessLiveness` returns `false` only on an affirmative ESRCH, so a pid
 * that has been recycled would make this row inconclusive (`null`) rather than
 * dead — the test would then pass for the wrong reason. PID wrap happens ~daily
 * on this box under fleet load, so the deadness is ASSERTED here rather than
 * assumed: if the pid came back alive we would be measuring nothing.
 */
function confirmedDeadPid(): number {
  const reaped = spawnSync(process.execPath, ['-e', '']);
  const pid = reaped.pid;
  if (!pid) throw new Error('could not obtain a reaped pid for the warm-dead fixture');
  try {
    process.kill(pid, 0);
    throw new Error(`pid ${pid} is still alive — the warm-dead fixture would not be warm-dead`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') throw err;
  }
  return pid;
}

describe('R-5 live plan-agent counts (real PG + real liveness oracle)', () => {
  let db: OrgTestDb;
  let deadPid: number;
  const host = os.hostname();

  beforeAll(async () => {
    db = await createOrgTestDb();
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetHarnessAdminUrlCacheForTests();
    deadPid = confirmedDeadPid();

    await db.adminSql`
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, source, intent, current_plan_slug, host, pid, heartbeat_at, agent_role)
      VALUES
        -- WARM-DEAD: heartbeat is as fresh as it gets, the process is gone.
        ('su-warm-dead', 'warm dead', ${WORKSPACE}, 'omp-hook-session', 'executing a plan',
         'plan-warm-dead', ${host}, ${deadPid}, now(), 'su'),
        -- POSITIVE CONTROL: genuinely live (this very test process, turn in flight).
        ('su-really-live', 'really live', ${WORKSPACE}, 'omp-hook-session', 'executing a plan',
         'plan-really-live', ${host}, ${process.pid}, now(), 'su')`;

    // `live` requires a turn IN FLIGHT, not merely a fresh heartbeat — that is
    // the same distinction this test exists to prove, so the positive control
    // has to earn it rather than be asserted into existence. One recent
    // agent_activity row with no trailing session-end marker is what
    // `deriveSessionState` reads as `liveTurn`.
    //
    // The warm-dead row deliberately gets the SAME activity row: it makes the
    // two fixtures differ in exactly ONE variable (the pid's deadness), so a
    // difference in the count cannot be attributed to anything else.
    await db.adminSql`
      INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, kind, summary, created_at)
      VALUES
        (${WORKSPACE}, 'su-really-live', 'tool', 'executing plan work', now()),
        (${WORKSPACE}, 'su-warm-dead',   'tool', 'executing plan work', now())`;
  }, 180_000);

  afterAll(async () => {
    if (SAVED_ADMIN_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
    else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
    _resetHarnessAdminUrlCacheForTests();
    await db?.cleanup();
  });

  it('POSITIVE CONTROL: a genuinely-live agent with a plan lane IS counted', async () => {
    const counts = await readDelegationCounts({ workspaceId: WORKSPACE, sourceTimeoutMs: 30_000 });

    // Guard the instrument before reading the verdict: an `unknown` read is a
    // measurement that did not happen, and `count` is absent on it. Asserting
    // "not 2" against an unmeasured source would pass for the wrong reason.
    expect(counts.planExecutionAgents.status).toBe('known');
    if (counts.planExecutionAgents.status !== 'known') return;
    expect(counts.planExecutionAgents.value.count).toBeGreaterThanOrEqual(1);
  });

  it('WARM-DEAD: a fresh heartbeat on a dead process is NOT counted as executing a plan', async () => {
    const counts = await readDelegationCounts({ workspaceId: WORKSPACE, sourceTimeoutMs: 30_000 });
    expect(counts.planExecutionAgents.status).toBe('known');
    if (counts.planExecutionAgents.status !== 'known') return;

    // Both seeded rows carry a `current_plan_slug` and a heartbeat of `now()`.
    // A heartbeat-freshness implementation therefore counts TWO. The bar says
    // the count is a live-assignment count, so it must be ONE.
    expect(counts.planExecutionAgents.value.count).toBe(1);

    // …and specifically the dead one is the one dropped. Read the oracle's own
    // verdict so a future count change cannot make this assertion vacuous.
    const { resolveSessionStates } = await import('./agent-tools/coordination/liveness-oracle');
    const verdicts = await resolveSessionStates(
      [
        { ownerId: 'su-warm-dead', heartbeatAt: new Date().toISOString(), host, pid: deadPid, source: 'omp-hook-session' },
        { ownerId: 'su-really-live', heartbeatAt: new Date().toISOString(), host, pid: process.pid, source: 'omp-hook-session' },
      ],
      { nowMs: Date.now() },
    );
    expect(verdicts.get('su-warm-dead')?.sessionState).not.toBe('live');
    expect(verdicts.get('su-really-live')?.sessionState).toBe('live');
    // The clause this case exists to falsify, stated as an assertion: the dead
    // row's heartbeat really is fresh, so nothing but the oracle excluded it.
    expect(verdicts.get('su-warm-dead')?.heartbeatFresh).toBe(true);
  });

  it('a warm-dead row is EXCLUDED, not counted as unmeasured (the oracle classified it)', async () => {
    const counts = await readDelegationCounts({ workspaceId: WORKSPACE, sourceTimeoutMs: 30_000 });
    expect(counts.planExecutionAgents.status).toBe('known');
    if (counts.planExecutionAgents.status !== 'known') return;
    // `unmeasured` is reserved for subjects the oracle could NOT classify. A
    // confirmed-dead pid is a classification, so folding it into `unmeasured`
    // would be the silent-drop failure the module header forbids.
    expect(counts.planExecutionAgents.value.unmeasured).toBe(0);
  });

  it('NO CROSS-CALL CACHE: two reads in the same process agree', async () => {
    // Scope, stated honestly: this is the no-cache property (every call re-reads),
    // NOT D-014's cold-start defect. By the time this runs it is the fourth
    // `readDelegationCounts` of the module, and the policy cache behind
    // `isHarnessInScope` is warm — so a first/second comparison here cannot
    // separate a primed read from an unprimed one. D-014 is covered by the COLD
    // PROCESS case below, which is the only place that distinction is observable.
    const first = await readDelegationCounts({ workspaceId: WORKSPACE, sourceTimeoutMs: 30_000 });
    const second = await readDelegationCounts({ workspaceId: WORKSPACE, sourceTimeoutMs: 30_000 });

    for (const key of ['planExecutionAgents', 'plansAwaitingDelegation', 'plansAwaitingAcceptance', 'activeDrainFleets'] as const) {
      const a = first[key];
      const b = second[key];
      expect(a.status, `${key} first read must be measured`).toBe('known');
      expect(b.status, `${key} second read must be measured`).toBe('known');
      if (a.status !== 'known' || b.status !== 'known') continue;
      expect(b.value.count, `${key} disagreed between a fresh and a warm read`).toBe(a.value.count);
    }
    expect(first.degradedSources).toEqual([]);
    expect(second.degradedSources).toEqual([]);
  });

  /**
   * D-014's actual defect, measured the only way it is observable.
   *
   * ⚠ IT IS NOT OBSERVABLE IN THIS PROCESS, AND THAT IS NOT A CHOICE OF STYLE.
   * The fix is `await primeWorkScopePolicy()` in `plansAwaitingDelegation`, and
   * `primeWorkScopePolicy` returns early whenever `process.env.VITEST` is set. So
   * under vitest the fixed line and the unfixed line do literally the same thing,
   * and every in-process assertion about it passes under both. A child process
   * with VITEST unset is the only place the prime runs at all.
   *
   * The defect: `isHarnessInScope` reads the SYNC `workScopePolicy()`, backed by a
   * `placementOverride()` cache that is EMPTY at boot and filled by a 60s refresh.
   * An empty policy is "not enforced", so it returns true for every slug — it
   * fails OPEN, and the count includes out-of-scope plans for the first ~60s of a
   * process. D-014 measured that as 52-on-first-read / 51-thereafter.
   *
   * WHY THE OFF-POLICY RUN IS HERE: it is a calibration, not decoration. It proves
   * 2 is REACHABLE through this exact probe, so the enforcing run's `toBe(1)` is
   * discriminating rather than a number that happens to be what the fixture
   * produces either way. Drop `await primeWorkScopePolicy()` and BOTH runs return
   * 2 — the second assertion is what goes red.
   */
  it('COLD PROCESS (D-014): the FIRST read in a fresh process honours the stored work-scope policy', async () => {
    // Two actionable plans differing in ONE variable: the harness slug, one inside
    // the allow-list and one outside it. Both are `ready` + `template IS NULL` +
    // one `todo` item, and neither slug matches a seeded presence row's
    // `current_plan_slug`, so neither is filtered out as staffed.
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, items)
      VALUES
        (${WORKSPACE}, 'papercusp', 'scope-in-actionable', 'in scope', 'ready', 'seeded by the D-014 cold probe',
         ${db.adminSql.json([{ id: 'P-001', status: 'todo', text: 'seeded actionable item' }])}),
        (${WORKSPACE}, 'sidestage', 'scope-out-actionable', 'out of scope', 'ready', 'seeded by the D-014 cold probe',
         ${db.adminSql.json([{ id: 'P-001', status: 'todo', text: 'seeded actionable item' }])})`;

    const writeWorkScope = async (mode: 'enforce' | 'off') => {
      await db.adminSql`
        INSERT INTO harness_shared.operator_pot_control_policy (workspace_id, payload, updated_at)
        VALUES (
          ${WORKSPACE},
          ${db.adminSql.json({ workScope: { mode, allowHarnesses: ['papercusp'], setBy: 'd014-cold-probe' } })},
          ${Date.now()}
        )
        ON CONFLICT (workspace_id)
          DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`;
    };

    const coldProbe = (): { status: string; count: number | null; degradedSources: string[] } => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HARNESS_ADMIN_DATABASE_URL: db.adminDsn,
        // The policy row is read at `activeWorkspaceId()`, NOT at the workspace
        // passed to readDelegationCounts — pin the child to the fixture's.
        PAPERCUSP_WORKSPACE_ID: WORKSPACE,
        PROBE_WORKSPACE: WORKSPACE,
      };
      // Without this the child inherits VITEST and `primeWorkScopePolicy` no-ops,
      // which is precisely the thing being measured.
      delete env.VITEST;
      delete env.VITEST_WORKER_ID;
      delete env.VITEST_POOL_ID;
      delete env.VITEST_MODE;

      const p = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', COLD_PROBE_SOURCE], {
        env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(p.status, `cold probe exited non-zero: ${p.stderr}`).toBe(0);
      // A sentinel rather than a bare JSON.parse of stdout: the module graph this
      // child loads is free to log, and a parse failure on unrelated chatter would
      // read as a broken subject.
      const m = /<<PROBE (.*) PROBE>>/s.exec(p.stdout ?? '');
      expect(m, `cold probe emitted no result marker.\nstdout: ${p.stdout}\nstderr: ${p.stderr}`).not.toBeNull();
      return JSON.parse((m as RegExpExecArray)[1]);
    };

    // CALIBRATION: policy off ⇒ nothing is out of scope ⇒ both plans count.
    await writeWorkScope('off');
    const unscoped = coldProbe();
    expect(unscoped.degradedSources).toEqual([]);
    expect(unscoped.status, 'the calibration read must be measured, or it calibrates nothing').toBe('known');
    expect(unscoped.count, 'calibration: with the policy off both plans count, so 2 IS reachable here').toBe(2);

    // THE VERDICT: the same probe, same rows, one variable changed — the stored
    // policy now enforces. A cold process that failed open would still answer 2.
    await writeWorkScope('enforce');
    const scoped = coldProbe();
    expect(scoped.degradedSources).toEqual([]);
    expect(scoped.status).toBe('known');
    expect(
      scoped.count,
      'the out-of-scope plan must NOT be counted on a cold first read — an unprimed policy cache fails open (D-014)',
    ).toBe(1);
  }, 300_000);
});
