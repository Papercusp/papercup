/**
 * store.integration.test.ts — task-manager/store.ts against REAL Postgres
 * (task-manager-no-escape-2026-07-27, P-003).
 *
 * EI-18824358724907941: `clearVanishedUnaccounted([])` used to plug a literal NUL
 * byte ('\x00none') into a query parameter as a sentinel to avoid an empty
 * `<> ALL(...)` array — Postgres rejects ANY string containing 0x00 outright
 * ("invalid byte sequence for encoding \"UTF8\": 0x00"), so it failed on EVERY
 * tick with zero currently-unaccounted residue (the common, healthy case), which
 * is what the `task-reconcile` background routine's watchdog failure
 * (EI-18824358724907941) reported. This never showed up in the stubbed unit
 * tests (reconcile-tick.test.ts fakes `clearVanishedUnaccounted` entirely) — it
 * needs a REAL Postgres round-trip to reproduce, hence this integration test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../test/_pg-helpers';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskTerminalProvenance } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const store = await import('./store');

const WS = 'default';
let db: FreshPgDb;

async function insertUnaccounted(taskId: string, cgroupPath = '/sys/fs/cgroup/foo') {
  await db.sql`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, root_task_id, class, title, argv,
      launched_by, cgroup_path, pid, confined, state, detail
    ) VALUES (
      ${taskId}, ${WS}, ${taskId}, 'other', 'sample cmdline',
      '[]'::jsonb, 'unknown', ${cgroupPath}, 1, false, 'unaccounted', '{}'::jsonb
    )
  `;
}

async function insertAgentSessionTask(input: {
  taskId: string;
  coordOwnerId: string;
  state?: 'pending' | 'running' | 'exited';
  taskClass?: string;
  sessionId?: string | null;
}) {
  const state = input.state ?? 'running';
  await db.sql`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, root_task_id, class, title, argv,
      launched_by, confined, state, session_id, ended_at, detail
    ) VALUES (
      ${input.taskId}, ${WS}, ${input.taskId}, ${input.taskClass ?? 'agent-session'},
      ${input.taskId}, '[]'::jsonb, 'test', true, ${state}, ${input.sessionId ?? null},
      CASE WHEN ${state === 'exited'} THEN now() ELSE NULL END,
      jsonb_build_object('coordOwnerId', ${input.coordOwnerId}::text)
    )
  `;
}

beforeAll(async () => {
  db = await createFreshPgDb('task-ledger-store');
  h.sql = db.sql;
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '696-task-ledger.sql'));
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '700-task-ledger-bash-job-id-idx.sql'));
  await db.sql`
    CREATE TABLE harness_shared.adv_sessions (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      coord_owner_id text,
      session_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz
    )
  `;
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.task_ledger`;
  await db.sql`DELETE FROM harness_shared.adv_sessions`;
});

describe('agent-session native-id binding (EI-21268871278252116)', () => {
  it('binds every matching live task when enrolment lands before bootstrap, without crossing owner/class/state', async () => {
    await insertAgentSessionTask({ taskId: 'match-pending', coordOwnerId: 'su-owner', state: 'pending' });
    await insertAgentSessionTask({ taskId: 'match-running', coordOwnerId: 'su-owner' });
    await insertAgentSessionTask({
      taskId: 'match-rebind',
      coordOwnerId: 'su-owner',
      sessionId: 'native-predecessor',
    });
    await insertAgentSessionTask({ taskId: 'wrong-owner', coordOwnerId: 'su-other' });
    await insertAgentSessionTask({ taskId: 'wrong-class', coordOwnerId: 'su-owner', taskClass: 'bash-job' });
    await insertAgentSessionTask({ taskId: 'ended-owner', coordOwnerId: 'su-owner', state: 'exited' });

    const bound = await store.bindLiveAgentSessionTasksToNativeSession({
      workspaceId: WS,
      coordOwnerId: 'su-owner',
      sessionId: 'native-current',
    });

    expect(bound.sort()).toEqual(['match-pending', 'match-rebind', 'match-running']);
    const rows = await db.sql`
      SELECT task_id, session_id FROM harness_shared.task_ledger ORDER BY task_id
    `;
    expect(Object.fromEntries(rows.map((row) => [row.task_id, row.session_id]))).toEqual({
      'ended-owner': null,
      'match-pending': 'native-current',
      'match-rebind': 'native-current',
      'match-running': 'native-current',
      'wrong-class': null,
      'wrong-owner': null,
    });
  });

  it('binds one newly enrolled task to the newest open owner session when bootstrap lands first', async () => {
    await db.sql`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, coord_owner_id, session_id, started_at, ended_at)
      VALUES
        (${WS}, 'su-owner', 'native-closed', now() - interval '3 minutes', now()),
        (${WS}, 'su-owner', 'native-older-open', now() - interval '2 minutes', null),
        (${WS}, 'su-owner', 'native-newest-open', now() - interval '1 minute', null),
        (${WS}, 'su-other', 'native-other', now(), null)
    `;
    await insertAgentSessionTask({ taskId: 'late-enrolment', coordOwnerId: 'su-owner' });
    await insertAgentSessionTask({ taskId: 'other-owner-task', coordOwnerId: 'su-other' });
    await insertAgentSessionTask({ taskId: 'ended-late', coordOwnerId: 'su-owner', state: 'exited' });

    await expect(store.bindAgentSessionTaskToLatestNativeSession('late-enrolment')).resolves.toBe('native-newest-open');
    await expect(store.bindAgentSessionTaskToLatestNativeSession('ended-late')).resolves.toBeNull();

    const rows = await db.sql`
      SELECT task_id, session_id FROM harness_shared.task_ledger ORDER BY task_id
    `;
    expect(Object.fromEntries(rows.map((row) => [row.task_id, row.session_id]))).toEqual({
      'ended-late': null,
      'late-enrolment': 'native-newest-open',
      'other-owner-task': null,
    });
  });
});

describe('P-012 terminal provenance writer', () => {
  async function liveTask(
    taskId: string,
    input: { memoryMaxBytes?: number | null; peakMemoryBytes?: number | null } = {},
  ) {
    const row = await store.registerTask(
      {
        class: 'bash-job',
        title: taskId,
        argv: ['/bin/bash'],
        launchedBy: 'test',
        memoryMaxBytes: input.memoryMaxBytes ?? null,
      },
      { taskId, workspaceId: WS, reserveScope: true, unitKind: 'service' },
    );
    await store.markSpawned(taskId, {
      pid: 42,
      processIdentity: 'linux:boot:42',
      scopeUnit: row.scopeUnit,
      cgroupPath: `/user.slice/papercusp.slice/${row.scopeUnit}`,
      confined: true,
    });
    if (input.peakMemoryBytes != null) {
      await store.touchAlive([{ taskId, metrics: { peakMemoryBytes: input.peakMemoryBytes, lastMemoryBytes: 1 } }]);
    }
    return (await store.getTask(taskId))!;
  }

  function terminal(scopeUnit: string, over: Partial<TaskTerminalProvenance> = {}) {
    return {
      capturedAt: '2026-08-24T16:00:00.000Z',
      scopeUnit,
      cgroupPath: null,
      invocationId: 'terminal-invocation',
      loadState: 'loaded',
      activeState: 'failed',
      serviceResult: 'oom-kill',
      execMainCode: 2,
      execMainStatus: 9,
      memoryMaxBytes: 32 * 1024 * 1024,
      peakMemoryBytes: 32 * 1024 * 1024,
      peakMemorySource: 'systemd' as const,
      ...over,
    };
  }

  it("records a cgroup-cap OOM as killed/137/exit_reason='oom-kill' with its exact unit identity", async () => {
    const max = 32 * 1024 * 1024;
    const row = await liveTask('oomtask', { memoryMaxBytes: max });

    await expect(
      store.closeTask('oomtask', {
        state: 'exited',
        exitCode: 1,
        terminalProvenance: terminal(row.scopeUnit!),
      }),
    ).resolves.toBe(true);

    const [stored] = await db.sql`
      SELECT state, exit_code, exit_reason, memory_max_bytes::text,
             peak_memory_bytes::text, detail
        FROM harness_shared.task_ledger WHERE task_id = 'oomtask'
    `;
    expect(stored).toMatchObject({
      state: 'killed',
      exit_code: 137,
      exit_reason: 'oom-kill',
      memory_max_bytes: String(max),
      peak_memory_bytes: String(max),
    });
    expect(stored!.detail.terminalProvenance).toMatchObject({
      scopeUnit: row.scopeUnit,
      cgroupPath: `/user.slice/papercusp.slice/${row.scopeUnit}`,
      invocationId: 'terminal-invocation',
      serviceResult: 'oom-kill',
      peakMemorySource: 'systemd',
    });
    expect((await store.getTask('oomtask'))?.terminalProvenance?.serviceResult).toBe('oom-kill');
  });

  it('distinguishes timeout, ordinary exit 1, manual kill, and uncapped host/ancestor OOM', async () => {
    const timeout = await liveTask('timeouttask', { memoryMaxBytes: 64 * 1024 * 1024 });
    await store.closeTask('timeouttask', {
      state: 'killed',
      exitReason: 'signal SIGTERM',
      terminalProvenance: terminal(timeout.scopeUnit!, {
        serviceResult: 'timeout',
        execMainStatus: 15,
        memoryMaxBytes: 64 * 1024 * 1024,
        peakMemoryBytes: 2 * 1024 * 1024,
      }),
    });

    await liveTask('exit1task');
    await store.closeTask('exit1task', { state: 'exited', exitCode: 1 });

    await liveTask('manualtask');
    await store.closeTask('manualtask', { state: 'killed', exitReason: 'scope kill SIGTERM' });

    const host = await liveTask('hostoomtask');
    await store.closeTask('hostoomtask', {
      state: 'killed',
      terminalProvenance: terminal(host.scopeUnit!, {
        memoryMaxBytes: null,
        peakMemoryBytes: 8 * 1024 * 1024,
      }),
    });

    const rows = await db.sql`
      SELECT task_id, state, exit_code, exit_reason
        FROM harness_shared.task_ledger ORDER BY task_id
    `;
    expect(Object.fromEntries(rows.map((row) => [row.task_id, row]))).toMatchObject({
      timeouttask: { state: 'timed_out', exit_code: 143, exit_reason: 'timeout' },
      exit1task: { state: 'exited', exit_code: 1, exit_reason: null },
      manualtask: { state: 'killed', exit_code: null, exit_reason: 'scope kill SIGTERM' },
      hostoomtask: { state: 'killed', exit_code: 137, exit_reason: 'host-oom' },
    });
  });

  it('refuses to attach terminal evidence from a different scope identity', async () => {
    const row = await liveTask('identitytask', { memoryMaxBytes: 32 * 1024 * 1024 });
    await expect(
      store.closeTask('identitytask', {
        state: 'killed',
        terminalProvenance: terminal('pc-other.service'),
      }),
    ).resolves.toBe(false);
    expect((await store.getTask(row.taskId))?.state).toBe('running');
  });
});

describe('clearVanishedUnaccounted (EI-18824358724907941)', () => {
  it('does NOT throw when stillPresent is empty — the common zero-residue tick', async () => {
    await insertUnaccounted('t-1');
    await expect(store.clearVanishedUnaccounted([], { workspaceId: WS })).resolves.toBe(1);
    const row = (await db.sql`SELECT state, exit_reason FROM harness_shared.task_ledger WHERE task_id = 't-1'`)[0];
    expect(row.state).toBe('stranded');
    expect(row.exit_reason).toBe('unaccounted residue no longer present');
  });

  it('closes ALL currently-unaccounted rows when nothing is still present (vacuous-TRUE semantics, not a no-op)', async () => {
    await insertUnaccounted('t-1');
    await insertUnaccounted('t-2', '/sys/fs/cgroup/bar');
    await expect(store.clearVanishedUnaccounted([], { workspaceId: WS })).resolves.toBe(2);
  });

  it('keeps a row named in stillPresent, closes the rest (non-empty path unchanged)', async () => {
    await insertUnaccounted('t-1');
    await insertUnaccounted('t-2', '/sys/fs/cgroup/bar');
    const closed = await store.clearVanishedUnaccounted(['t-1'], { workspaceId: WS });
    expect(closed).toBe(1);
    const rows = await db.sql`SELECT task_id, state FROM harness_shared.task_ledger ORDER BY task_id`;
    expect(rows).toEqual([
      { task_id: 't-1', state: 'unaccounted' },
      { task_id: 't-2', state: 'stranded' },
    ]);
  });

  it('is a no-op when there is nothing unaccounted at all (empty table, empty stillPresent)', async () => {
    await expect(store.clearVanishedUnaccounted([], { workspaceId: WS })).resolves.toBe(0);
  });
});

describe('upsertUnaccounted scope identity', () => {
  it('persists managed scope_unit canonically and backfills it on conflict without erasing it', async () => {
    const group = {
      taskId: 't-scope-unit',
      cgroupPath: '/sys/fs/cgroup/papercusp.slice/pc-t-scope-unit.scope',
      scopeUnit: null as string | null,
      pids: [11],
      sampleCmdline: 'managed residue',
    };

    await store.upsertUnaccounted([group], { workspaceId: WS });
    let [row] = await db.sql`
      SELECT scope_unit FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}
    `;
    expect(row!.scope_unit).toBeNull();

    await store.upsertUnaccounted([{ ...group, scopeUnit: 'pc-t-scope-unit.scope', pids: [12] }], { workspaceId: WS });
    [row] = await db.sql`
      SELECT scope_unit FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}
    `;
    expect(row!.scope_unit).toBe('pc-t-scope-unit.scope');

    await store.upsertUnaccounted([{ ...group, pids: [13] }], { workspaceId: WS });
    [row] = await db.sql`
      SELECT scope_unit FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}
    `;
    expect(row!.scope_unit).toBe('pc-t-scope-unit.scope');
  });

  it('redacts credential-bearing residue titles before persisting and on conflict refresh', async () => {
    const group = {
      taskId: 't-redaction',
      cgroupPath: '/sys/fs/cgroup/papercusp.slice/pc-t-redaction.scope',
      scopeUnit: 'pc-t-redaction.scope',
      pids: [11],
      sampleCmdline: 'DATABASE_URL=postgresql://user:opaque-password@localhost/app',
    };

    await store.upsertUnaccounted([group], { workspaceId: WS });
    let [row] = await db.sql`SELECT title FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}`;
    expect(row!.title).toBe('DATABASE_URL=[redacted]');

    await store.upsertUnaccounted([{ ...group, sampleCmdline: 'AWS_ACCESS_KEY_ID=opaque-aws-access-key' }], {
      workspaceId: WS,
    });
    [row] = await db.sql`SELECT title FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}`;
    expect(row!.title).toBe('AWS_ACCESS_KEY_ID=[redacted]');
    expect(row!.title).not.toContain('opaque-');
  });
});

describe('registerTask detector-placeholder adoption', () => {
  it('adopts a managed scope placeholder instead of losing its provenance to a duplicate key', async () => {
    const taskId = 'race1234';
    const scopeUnit = `pc-${taskId}.scope`;
    const cgroupPath = `/sys/fs/cgroup/papercusp.slice/${scopeUnit}`;

    await store.upsertUnaccounted(
      [
        {
          taskId,
          cgroupPath,
          scopeUnit,
          pids: [321],
          sampleCmdline: 'node invoke-once.js',
        },
      ],
      { workspaceId: WS },
    );

    const row = await store.registerTask(
      {
        class: 'sidecar',
        title: 'invoke-once',
        argv: ['node', 'invoke-once.js'],
        launchedBy: 'test',
      },
      { workspaceId: WS, taskId, reserveScope: true, unitKind: 'scope' },
    );

    expect(row).toMatchObject({
      taskId,
      class: 'sidecar',
      title: 'invoke-once',
      launchedBy: 'test',
      scopeUnit,
      cgroupPath,
      pid: 321,
      state: 'pending',
    });
    expect(row.detail).toMatchObject({ pids: [321], scopeUnit });
  });

  it('rejects a duplicate registered task id instead of overwriting its provenance', async () => {
    const taskId = 'duplicate1234';
    await store.registerTask(
      {
        class: 'sidecar',
        title: 'original',
        argv: ['node', 'original.js'],
        launchedBy: 'original-owner',
      },
      { workspaceId: WS, taskId, reserveScope: true, unitKind: 'scope' },
    );

    await expect(
      store.registerTask(
        {
          class: 'agent-session',
          title: 'replacement',
          argv: ['node', 'replacement.js'],
          launchedBy: 'replacement-owner',
        },
        { workspaceId: WS, taskId, reserveScope: true, unitKind: 'scope' },
      ),
    ).rejects.toThrow(/not an adoptable residue/);

    const [row] = await db.sql`
      SELECT class, title, launched_by FROM harness_shared.task_ledger WHERE task_id = ${taskId}
    `;
    expect(row).toEqual({ class: 'sidecar', title: 'original', launched_by: 'original-owner' });
  });
});

describe('registerTask unit identity', () => {
  it('reserves a transient service unit when the caller selects service mode', async () => {
    const row = await store.registerTask(
      {
        class: 'bash-job',
        title: 'service reservation',
        argv: ['echo', 'ok'],
        launchedBy: 'test',
      },
      { workspaceId: WS, taskId: 'abc123', reserveScope: true, unitKind: 'service' },
    );

    expect(row.scopeUnit).toBe('pc-abc123.service');
    const [dbRow] = await db.sql`
      SELECT scope_unit FROM harness_shared.task_ledger WHERE task_id = 'abc123'
    `;
    expect(dbRow!.scope_unit).toBe('pc-abc123.service');
  });
});

describe('updateTaskLimits', () => {
  it('persists every runtime budget field so the processes:list ledger read reflects systemd changes', async () => {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, confined, state, cpu_weight, tasks_max, detail
      ) VALUES (
        't-limits', ${WS}, 't-limits', 'other', 'runtime limits',
        '[]'::jsonb, 'test', true, 'running', 100, 512, '{}'::jsonb
      )
    `;

    await expect(
      store.updateTaskLimits('t-limits', {
        memoryMaxBytes: 6_442_450_944,
        cpuWeight: 20,
        tasksMax: 256,
      }),
    ).resolves.toBe(true);

    const [row] = await db.sql`
      SELECT memory_max_bytes::text, cpu_weight::text, tasks_max::text
        FROM harness_shared.task_ledger
       WHERE task_id = 't-limits'
    `;
    expect(row).toEqual({
      memory_max_bytes: '6442450944',
      cpu_weight: '20',
      tasks_max: '256',
    });
  });

  it('retains omitted budget fields during a partial runtime retune', async () => {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, confined, state, memory_max_bytes, cpu_weight, tasks_max, detail
      ) VALUES (
        't-limits-partial', ${WS}, 't-limits-partial', 'other', 'partial runtime limits',
        '[]'::jsonb, 'test', true, 'running', 1024, 100, 512, '{}'::jsonb
      )
    `;

    await expect(store.updateTaskLimits('t-limits-partial', { cpuWeight: 40 })).resolves.toBe(true);
    const [row] = await db.sql`
      SELECT memory_max_bytes::text, cpu_weight::text, tasks_max::text
        FROM harness_shared.task_ledger
       WHERE task_id = 't-limits-partial'
    `;
    expect(row).toEqual({
      memory_max_bytes: '1024',
      cpu_weight: '40',
      tasks_max: '512',
    });
  });
});

/**
 * D-014 (process-lifecycle-no-orphans-2026-08-02). `markSpawned` stamps the
 * unconfined REASON into `detail`, which is shared jsonb other writers already use —
 * `startBackground` puts `bashJobId` there, and `findByBashJobId` reads it back via
 * `detail ->> 'bashJobId'`.
 *
 * So the merge has to be a merge. A plain `detail = '{...}'::jsonb` assignment would
 * pass every unit test (they mock the sql tag) and silently destroy the bashJobId
 * lookup in production — a background job that becomes unfindable the moment it is
 * marked running. These run against real Postgres precisely because that class of
 * mistake is invisible to a mocked query.
 */
describe('markSpawned detail merge (D-014)', () => {
  /** Note the `::jsonb` on a bound literal rather than `${JSON.stringify(...)}::jsonb`:
   *  under this harness's client the latter binds as a jsonb STRING, not an object,
   *  which is exactly the ambiguity `markSpawned` now refuses to depend on. */
  async function insertPending(taskId: string, detailJson: string) {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, pid, confined, state, detail
      ) VALUES (
        ${taskId}, ${WS}, ${taskId}, 'other', 'sample', '[]'::jsonb,
        'unknown', null, false, 'pending', ${db.sql.unsafe(`'${detailJson}'::jsonb`)}
      )
    `;
  }

  it('stamps unconfinedReason WITHOUT clobbering an existing bashJobId', async () => {
    await insertPending('t-merge', '{"bashJobId":"bash-42"}');

    await store.markSpawned('t-merge', { pid: 123, confined: false, unconfinedReason: 'probe-pending' });

    const [row] =
      await db.sql`SELECT detail, confined, state FROM harness_shared.task_ledger WHERE task_id = 't-merge'`;
    expect(row!.detail).toEqual({ bashJobId: 'bash-42', unconfinedReason: 'probe-pending' });
    expect(row!.confined).toBe(false);
    expect(row!.state).toBe('running');
  });

  it('keeps the bashJobId lookup working after the stamp — the thing a clobber would break', async () => {
    await insertPending('t-lookup', '{"bashJobId":"bash-99"}');

    await store.markSpawned('t-lookup', { pid: 126, confined: false, unconfinedReason: 'probe-pending' });

    // `detail ->> 'bashJobId'` is how findByBashJobId resolves a background job. A
    // replace-instead-of-merge, or a merge that produced an array, returns nothing here.
    //
    // WI-8806: the `detail ? 'bashJobId'` clause mirrors the production query exactly --
    // it is what lets the planner use the PARTIAL task_ledger_bash_job_id_idx. Kept here
    // so this test exercises the same predicate set production does; without it the test
    // would still pass while silently diverging from the shape it claims to pin.
    const [row] = await db.sql`
      SELECT task_id FROM harness_shared.task_ledger
       WHERE detail ? 'bashJobId' AND detail ->> 'bashJobId' = 'bash-99'
    `;
    expect(row?.task_id).toBe('t-lookup');
  });

  it('leaves detail untouched when the task is confined (no reason to record)', async () => {
    await insertPending('t-confined', '{"bashJobId":"bash-7"}');

    await store.markSpawned('t-confined', { pid: 124, confined: true, unconfinedReason: null });

    const [row] = await db.sql`SELECT detail, confined FROM harness_shared.task_ledger WHERE task_id = 't-confined'`;
    expect(row!.detail).toEqual({ bashJobId: 'bash-7' });
    expect(row!.confined).toBe(true);
  });

  it('always merges into an OBJECT, never an array (the `||` string footgun)', async () => {
    await insertPending('t-shape', '{}');

    await store.markSpawned('t-shape', { pid: 125, confined: false, unconfinedReason: 'no-scope-support' });

    const [row] = await db.sql`
      SELECT jsonb_typeof(detail) AS t, detail FROM harness_shared.task_ledger WHERE task_id = 't-shape'
    `;
    expect(row!.t).toBe('object');
    expect(row!.detail).toEqual({ unconfinedReason: 'no-scope-support' });
  });
});
