/**
 * adopt-terminal-session.test.ts — enrolling the psu sessions a human started by
 * typing in a terminal (WI-41197, plan terminal-psu-session-enrolment-2026-08-24).
 *
 * The assertions here are about the three properties that make this safe to run
 * on every heartbeat of every live session, once a minute, forever:
 *
 *   IDEMPOTENT   the steady-state beat writes nothing and reads nothing. Getting
 *                this wrong does not throw — it silently writes 1,440 duplicate
 *                ledger rows per session per day.
 *   UNCONFINED   we ADOPT the launcher's existing `vte-spawn` cgroup and never
 *                ask for a new scope. The confined branch shells out to
 *                `systemd-run`, which is both impossible here (the process is
 *                already in a scope) and refused inside an agent session.
 *   FAIL-OPEN    the caller is a liveness heartbeat. A ledger fault must cost a
 *                row, never a live agent's liveness signal — and must NOT be
 *                cached, or the retry the next beat would perform is suppressed.
 *
 * `closeAdoptedTerminalSessions` is tested for the asymmetry that makes the
 * whole feature worth having: a row is closed when its supervisor is provably
 * gone, and deliberately LEFT OPEN when the session ended while the launcher
 * lived on — that survivor is the zombie this item exists to expose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store is mocked wholesale so this stays a unit test: importing it for real
// pulls the PG client graph in, and every store call in this module is injected.
vi.mock('./store', () => ({
  registerTask: vi.fn(async () => ({})),
  markSpawned: vi.fn(async () => ({})),
  closeTask: vi.fn(async () => true),
  listTasks: vi.fn(async () => []),
  bindAgentSessionTaskToLatestNativeSession: vi.fn(async () => null),
}));

import { beginSyncEnrolment } from './enroll-sync';
import {
  adoptTerminalSession,
  closeAdoptedTerminalSessions,
  isAdoptedTerminalSessionRow,
  resetAdoptedTerminalSessionsForTest,
  TERMINAL_LAUNCH_SURFACE,
  type AdoptTerminalSessionDeps,
} from './adopt-terminal-session';
import { isAutoReapExempt, type TaskRow } from './types';

const VTE_CGROUP =
  '/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-abc.scope';

/** A `CgroupFs` that answers for exactly one pid, like the real /proc would. */
function fakeFs(pid: number, cmdline = 'node /repo/apps/operator/scripts/psu-launcher.mjs') {
  return {
    readFile: (path: string) => (path === `/proc/${pid}/cmdline` ? cmdline : null),
    readDir: () => [],
    isDir: () => false,
  };
}

/** A begin/complete pair that records what the module asked the primitives for. */
function enrolmentSpies(taskId = 'task-abc') {
  const enrolment = {
    taskId,
    confined: false,
    unconfinedReason: 'caller-veto' as const,
    unitKind: 'scope' as const,
    scopeUnit: null,
    enrolled: true,
    registrationReady: null as Promise<void> | null,
    wrap: (binary: string, argv: string[]) => ({ binary, argv }),
  };
  const begin = vi.fn(() => enrolment);
  const complete = vi.fn(() => {
    enrolment.registrationReady = Promise.resolve();
  });
  return { enrolment, begin, complete };
}

function deps(over: Partial<AdoptTerminalSessionDeps> = {}): AdoptTerminalSessionDeps {
  const { begin, complete } = enrolmentSpies();
  return {
    fs: fakeFs(4242),
    listTasks: vi.fn(async () => []),
    begin: begin as unknown as AdoptTerminalSessionDeps['begin'],
    complete: complete as unknown as AdoptTerminalSessionDeps['complete'],
    enabled: () => true,
    readIdentity: () => 'linux:boot-1:99999',
    ...over,
  };
}

beforeEach(() => {
  resetAdoptedTerminalSessionsForTest();
  vi.clearAllMocks();
});

describe('adoptTerminalSession', () => {
  it('enrols UNCONFINED and adopts the launcher pid rather than creating a scope', async () => {
    const d = deps();
    const res = await adoptTerminalSession({ ownerId: 'su-1', pid: 4242 }, d);

    expect(res).toMatchObject({ adopted: true, reason: 'adopted' });
    // confine:false is the load-bearing argument: it is what keeps the enrolment
    // off the `systemd-run` branch that cannot work inside a vte-spawn scope.
    expect(d.begin).toHaveBeenCalledWith({ class: 'agent-session' }, { confine: false });
    // The LAUNCHER's pid is what makes completeSyncEnrolment record its real cgroup.
    expect(d.complete).toHaveBeenCalledWith(expect.anything(), expect.anything(), 4242, expect.anything());
  });

  it('stamps the auto-reap exemption and the provenance the native-session binder needs', async () => {
    const d = deps();
    await adoptTerminalSession({ ownerId: 'su-1', pid: 4242, tty: '/dev/pts/9', host: 'box' }, d);

    const spec = (d.complete as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      class: string;
      launchedBy: string;
      detail: Record<string, unknown>;
    };
    expect(spec.class).toBe('agent-session');
    expect(spec.launchedBy).toBe('su-1');
    expect(spec.detail).toMatchObject({
      launchSurface: TERMINAL_LAUNCH_SURFACE,
      autoReapExempt: true,
      // The bulk binder matches on THIS key; without it the row never gains a
      // native session id and session-end cleanup cannot find it.
      coordOwnerId: 'su-1',
      supervisorPid: 4242,
      tty: '/dev/pts/9',
    });
    // The predicates the rest of the system reads must both accept the row we wrote.
    expect(isAutoReapExempt({ detail: spec.detail })).toBe(true);
    expect(isAdoptedTerminalSessionRow({ detail: spec.detail })).toBe(true);
  });

  it('is idempotent across beats — the second beat writes nothing and reads nothing', async () => {
    const d = deps();
    const first = await adoptTerminalSession({ ownerId: 'su-1', pid: 4242 }, d);
    const second = await adoptTerminalSession({ ownerId: 'su-1', pid: 4242 }, d);

    expect(first.reason).toBe('adopted');
    expect(second).toMatchObject({ adopted: false, reason: 'cached', taskId: first.taskId });
    expect(d.begin).toHaveBeenCalledTimes(1);
    // The steady state must not even query: ~50 sessions beating once a minute.
    expect(d.listTasks).toHaveBeenCalledTimes(1);
  });

  it('re-enrols when the supervisor pid changes (a relaunch under the same owner)', async () => {
    const d = deps({ fs: fakeFs(5000) });
    await adoptTerminalSession({ ownerId: 'su-1', pid: 4242 }, d);
    const relaunched = await adoptTerminalSession({ ownerId: 'su-1', pid: 5000 }, d);

    expect(relaunched.reason).toBe('adopted');
    expect(d.begin).toHaveBeenCalledTimes(2);
  });

  it('reuses a live row that already covers this owner+pid instead of writing a second', async () => {
    const existing = {
      taskId: 'task-existing',
      detail: { launchSurface: TERMINAL_LAUNCH_SURFACE, supervisorPid: 4242 },
    } as unknown as TaskRow;
    const d = deps({ listTasks: vi.fn(async () => [existing]) as AdoptTerminalSessionDeps['listTasks'] });

    const res = await adoptTerminalSession({ ownerId: 'su-1', pid: 4242 }, d);

    expect(res).toMatchObject({ adopted: false, reason: 'existing-row', taskId: 'task-existing' });
    expect(d.begin).not.toHaveBeenCalled();
  });

  it('no-ops without enrolling: flag off, no pid, and a pid that is not alive', async () => {
    const offDeps = deps({ enabled: () => false });
    expect(await adoptTerminalSession({ ownerId: 'su-1', pid: 4242 }, offDeps)).toMatchObject({
      adopted: false,
      reason: 'flag-off',
    });

    const noPid = deps();
    expect(await adoptTerminalSession({ ownerId: 'su-1' }, noPid)).toMatchObject({ reason: 'no-pid' });

    // A beat proves the sender was alive when it was SENT, not now. Enrolling a
    // dead pid writes a row the reconciler can only ever strand.
    const deadPid = deps({ readIdentity: () => null });
    expect(await adoptTerminalSession({ ownerId: 'su-1', pid: 4242 }, deadPid)).toMatchObject({
      reason: 'pid-not-alive',
    });

    for (const d of [offDeps, noPid, deadPid]) expect(d.begin).not.toHaveBeenCalled();
  });

  it('never rejects when the ledger write fails, and does NOT cache it so the next beat retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = deps({
      listTasks: vi.fn(async () => {
        throw new Error('pg down');
      }) as AdoptTerminalSessionDeps['listTasks'],
    });

    const res = await adoptTerminalSession({ ownerId: 'su-1', pid: 4242 }, failing);
    expect(res).toMatchObject({ adopted: false, reason: 'error' });

    // The retry is the point: a cached failure would silence this owner forever.
    const healthy = deps();
    expect((await adoptTerminalSession({ ownerId: 'su-1', pid: 4242 }, healthy)).reason).toBe('adopted');
    warn.mockRestore();
  });

  it('CALIBRATION: the real beginSyncEnrolment really does stay off the systemd-run branch', async () => {
    // Guards the assumption the whole design rests on. If `confine:false` ever
    // starts producing a confined enrolment, the tests above would still pass
    // against their spies while production tried to `systemd-run` inside a
    // vte-spawn scope — the exact failure this file exists to prevent.
    const real = beginSyncEnrolment({ class: 'agent-session' }, { confine: false });
    expect(real.confined).toBe(false);
    expect(real.scopeUnit).toBeNull();
    // `wrap` is the identity when unconfined: no `systemd-run` prefix is added.
    expect(real.wrap('node', ['x.mjs'])).toEqual({ binary: 'node', argv: ['x.mjs'] });
  });
});

describe('closeAdoptedTerminalSessions', () => {
  const adopted = (over: Partial<TaskRow> = {}): TaskRow =>
    ({
      taskId: 'task-1',
      processIdentity: 'linux:boot-1:1234',
      cgroupPath: VTE_CGROUP,
      detail: { launchSurface: TERMINAL_LAUNCH_SURFACE, autoReapExempt: true, supervisorPid: 4242, coordOwnerId: 'su-1' },
      ...over,
    }) as unknown as TaskRow;

  it('closes a row whose supervisor is gone, so a routine exit is not filed as a strand', async () => {
    const close = vi.fn(async () => true);
    const res = await closeAdoptedTerminalSessions([adopted()], { readIdentity: () => null, close });

    expect(res.closedTaskIds).toEqual(['task-1']);
    expect(close).toHaveBeenCalledWith('task-1', expect.objectContaining({ state: 'exited' }));
  });

  it('LEAVES a row open when the session ended but the launcher is still alive', async () => {
    // This survivor is the zombie the whole item exists to surface: a launcher
    // holding a slot and a cgroup after its session reached a terminal state.
    // Closing it here would re-hide exactly the corpse we are hunting.
    const close = vi.fn(async () => true);
    const res = await closeAdoptedTerminalSessions([adopted()], {
      readIdentity: () => 'linux:boot-1:1234',
      close,
    });

    expect(res.stillLiveTaskIds).toEqual(['task-1']);
    expect(close).not.toHaveBeenCalled();
  });

  it('treats pid REUSE as gone — a live pid with a different identity is not ours', async () => {
    // PID wrap happens roughly daily under fleet load here, so "the pid is alive"
    // is not the same question as "our process is alive".
    const close = vi.fn(async () => true);
    const res = await closeAdoptedTerminalSessions([adopted()], {
      readIdentity: () => 'linux:boot-1:99999',
      close,
    });

    expect(res.closedTaskIds).toEqual(['task-1']);
  });

  it('ignores rows that were not adopted by this module', async () => {
    const close = vi.fn(async () => true);
    const headless = adopted({ detail: { headless: true } } as Partial<TaskRow>);
    const res = await closeAdoptedTerminalSessions([headless], { readIdentity: () => null, close });

    expect(res).toEqual({ closedTaskIds: [], stillLiveTaskIds: [] });
    expect(close).not.toHaveBeenCalled();
  });
});
