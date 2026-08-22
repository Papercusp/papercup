import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskRow, TaskState } from './types';

const store = vi.hoisted(() => ({
  rows: new Map<string, TaskRow>(),
  closed: [] as { taskId: string; state: string; reason: string | null }[],
}));

vi.mock('./store', () => ({
  getTask: async (id: string) => store.rows.get(id) ?? null,
  getSubtree: async (rootId: string) => [...store.rows.values()].filter((r) => r.rootTaskId === rootId),
  closeTask: async (id: string, input: { state: string; exitReason?: string | null }) => {
    store.closed.push({ taskId: id, state: input.state, reason: input.exitReason ?? null });
    return true;
  },
}));

const { killTask, killScopeUnit, freezeTask, thawTask, limitTask, verifyPidStillOurs } = await import('./control');

function row(over: Partial<TaskRow> & { taskId: string }): TaskRow {
  const r: TaskRow = {
    workspaceId: 'w',
    rootTaskId: over.taskId,
    class: 'bash-job',
    title: 't',
    argv: [],
    confined: true,
    scopeUnit: `pc-${over.taskId}.scope`,
    cgroupPath: `/papercusp.slice/pc-${over.taskId}.scope`,
    state: 'running' as TaskState,
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    launchedBy: 'su-test',
    detail: {},
    ...over,
  };
  store.rows.set(r.taskId, r);
  return r;
}

beforeEach(() => {
  store.rows.clear();
  store.closed.length = 0;
});

describe('verifyPidStillOurs — the recycled-pid rail', () => {
  const d = (identity: string | null) =>
    ({ readIdentity: () => identity }) as unknown as Parameters<typeof verifyPidStillOurs>[1];

  it('accepts a pid whose kernel identity still matches', () => {
    const r = row({ taskId: 'a1', confined: false, scopeUnit: null, pid: 10, processIdentity: 'linux:b:1' });
    expect(verifyPidStillOurs(r, d('linux:b:1'))).toEqual({ ok: true, pid: 10, weak: false });
  });

  it('REFUSES a pid that now belongs to a different process', () => {
    const r = row({ taskId: 'a2', confined: false, scopeUnit: null, pid: 10, processIdentity: 'linux:b:1' });
    const v = verifyPidStillOurs(r, d('linux:b:999'));
    expect(v).toMatchObject({ ok: false, error: 'identity_mismatch' });
    expect((v as { detail: string }).detail).toMatch(/refusing to signal a recycled pid/);
  });

  it('reports a gone pid as a mismatch rather than signalling into the void', () => {
    const r = row({ taskId: 'a3', confined: false, scopeUnit: null, pid: 10, processIdentity: 'linux:b:1' });
    expect(verifyPidStillOurs(r, d(null))).toMatchObject({ ok: false, error: 'identity_mismatch' });
  });

  it('allows a row that never captured an identity, but marks it WEAK', () => {
    const r = row({ taskId: 'a4', confined: false, scopeUnit: null, pid: 10, processIdentity: null });
    expect(verifyPidStillOurs(r, d('linux:b:7'))).toEqual({ ok: true, pid: 10, weak: true });
  });

  it('has no target when the row has no pid at all', () => {
    const r = row({ taskId: 'a5', confined: false, scopeUnit: null, pid: null });
    expect(verifyPidStillOurs(r, d('x'))).toMatchObject({ ok: false, error: 'no_target' });
  });
});

describe('killTask — confined path', () => {
  it('kills by SCOPE, never by pid', async () => {
    row({ taskId: 'b1', pid: 4242 });
    const calls: string[][] = [];
    const kill = vi.fn();
    const out = await killTask('b1', {
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as never,
      kill,
    });
    expect(out.ok).toBe(true);
    expect(calls[0]).toEqual(['--user', 'kill', '--signal=SIGTERM', 'pc-b1.scope']);
    // The pid path must not be touched for a confined task — that is the whole
    // point of addressing the cgroup.
    expect(kill).not.toHaveBeenCalled();
    expect(store.closed).toEqual([{ taskId: 'b1', state: 'killed', reason: 'scope kill SIGTERM' }]);
  });

  it('reports SIGKILL-delivered teardown as pending instead of advising a retry', async () => {
    row({ taskId: 'b2' });
    const calls: string[][] = [];
    const out = await killTask('b2', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs: { readFile: () => '999\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls.map((c) => c[2])).toEqual(['--signal=SIGTERM', '--signal=SIGKILL']);
    // EI-20130774106283501: SIGKILL delivery is terminal even when cgroup
    // teardown/reaping outlives the bounded response window. The row remains
    // live for reconciliation, but the caller must not retry a successful kill.
    expect(out).toMatchObject({ ok: true, taskId: 'b2' });
    expect((out as { detail: string }).detail).toMatch(/termination pending/);
    expect((out as { detail: string }).detail).toMatch(/no retry is required/);
    expect(store.closed).toHaveLength(0);
  });

  it('handles a slow SIGTERM trap that exits after the SIGKILL response window', async () => {
    row({ taskId: 'b2-slow' });
    const scopePath = '/sys/fs/cgroup/papercusp.slice/pc-b2-slow.scope';
    const calls: string[][] = [];
    let sigkillDelivered = false;
    let postKillReads = 0;
    const fs = {
      readFile: (path: string) => {
        if (path !== `${scopePath}/cgroup.procs`) return '';
        if (!sigkillDelivered) return '999\n';
        postKillReads++;
        return postKillReads <= 6 ? '999\n' : '';
      },
      readDir: () => [],
      isDir: () => true,
    };
    const out = await killTask('b2-slow', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs,
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[2] === '--signal=SIGKILL') sigkillDelivered = true;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls.map((c) => c[2])).toEqual(['--signal=SIGTERM', '--signal=SIGKILL']);
    expect(out).toMatchObject({ ok: true, taskId: 'b2-slow' });
    expect((out as { detail: string }).detail).toMatch(/termination pending/);
    // The simulated trap has now completed, just after the bounded response
    // window; the kill result did not misclassify it as a retryable failure.
    expect(fs.readFile(`${scopePath}/cgroup.procs`)).toBe('');
    expect(store.closed).toHaveLength(0);
  });

  it('EI-19478780721557822 recurrence guard: never reports ok:true while the subtree survives, and leaves the row LIVE for a retry', async () => {
    // No escalateAfterMs at all — the plain SIGTERM path. Before this fix, the
    // code returned ok:true immediately after `systemctl kill` exited 0, with
    // zero verification that anything actually died.
    row({ taskId: 'b2b' });
    const out = await killTask('b2b', {
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
    // The dangerous half of the bug: a false success ALSO closed the row as
    // 'killed', which then made every subsequent taskId-mode kill attempt fail
    // with `not_live` — the reported "escape hatch closed too". A row that is
    // NOT actually dead must stay live so a retry (or processes:list) can find it.
    expect(store.closed).toHaveLength(0);
  });

  it('deep-walks nested cgroups when verifying — a descendant delegated into a sub-cgroup is not invisible', async () => {
    // Top-level cgroup.procs is EMPTY (the leader exited), but a descendant left
    // a process behind in a nested child directory — the shape a bare, single-
    // directory `cgroup.procs` read cannot see (readCgroupProcs deliberately
    // reads ONE directory only; walkCgroupTree recurses).
    row({ taskId: 'b2c' });
    const scopeDir = '/sys/fs/cgroup/papercusp.slice/pc-b2c.scope';
    const out = await killTask('b2c', {
      sleep: async () => {},
      fs: {
        readFile: (p: string) => (p.endsWith('/child/cgroup.procs') ? '5555\n' : ''),
        readDir: (p: string) => (p === scopeDir ? ['child'] : []),
        isDir: () => true,
      },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete', detail: expect.stringContaining('1 process') });
    expect(store.closed).toHaveLength(0);
  });

  it('does NOT escalate when the scope emptied after SIGTERM', async () => {
    row({ taskId: 'b3' });
    const calls: string[][] = [];
    await killTask('b3', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs: { readFile: () => '', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls).toHaveLength(1);
  });

  it('surfaces a systemctl failure instead of claiming success', async () => {
    row({ taskId: 'b4' });
    const out = await killTask('b4', {
      execFileAsync: (async () => {
        throw new Error('Unit pc-b4.scope not loaded.');
      }) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'command_failed' });
    expect(store.closed).toHaveLength(0);
  });
});

describe('killTask — reapTerminalResidue (WI-37521)', () => {
  it('refuses a terminal row exactly as before when the flag is absent — no behaviour change', async () => {
    row({ taskId: 'r1', state: 'killed' });
    const kill = vi.fn();
    const out = await killTask('r1', {
      kill,
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
    });
    expect(out).toMatchObject({ ok: false, error: 'not_live' });
    expect(kill).not.toHaveBeenCalled();
    expect(store.closed).toHaveLength(0);
  });

  it('reaps a terminal row whose scope is POSITIVELY re-verified to still hold processes', async () => {
    row({ taskId: 'r2', state: 'killed' });
    const calls: string[][] = [];
    let signalled = false;
    const out = await killTask('r2', {
      reapTerminalResidue: true,
      // Before the signal: the scope holds a live pid (the whole premise of the
      // reap). After: it's gone — the signal actually worked.
      fs: { readFile: () => (signalled ? '' : '4242\n'), readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        signalled = true;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: true, taskId: 'r2' });
    expect((out as { detail: string }).detail).toMatch(/TERMINAL-ROW REAP/);
    expect(calls[0]).toEqual(['--user', 'kill', '--signal=SIGTERM', 'pc-r2.scope']);
    // The row's OWN state must NOT be rewritten — closeTask no-ops on an
    // already-ended row by design, and this must never fight that.
    expect(store.closed).toHaveLength(0);
  });

  it('still refuses when the flag is set but the scope is actually empty — nothing to reap', async () => {
    row({ taskId: 'r3', state: 'exited' });
    const out = await killTask('r3', {
      reapTerminalResidue: true,
      fs: { readFile: () => '', readDir: () => [], isDir: () => true },
    });
    expect(out).toMatchObject({ ok: false, error: 'not_live' });
    expect((out as { detail: string }).detail).toMatch(/nothing to reap/);
  });

  it('still refuses an UNCONFINED terminal row even with the flag — pid re-verification is not trustworthy here', async () => {
    row({ taskId: 'r4', state: 'exited', confined: false, scopeUnit: null, pid: 999, processIdentity: 'linux:b:1' });
    const kill = vi.fn();
    const out = await killTask('r4', { reapTerminalResidue: true, kill, readIdentity: () => 'linux:b:1' });
    expect(out).toMatchObject({ ok: false, error: 'not_live' });
    expect((out as { detail: string }).detail).toMatch(/unconfined/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('an INCOMPLETE reap (survivors after the verification window) is reported honestly, not as success', async () => {
    row({ taskId: 'r5', state: 'killed' });
    const out = await killTask('r5', {
      reapTerminalResidue: true,
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
    expect(store.closed).toHaveLength(0);
  });
});

describe('killTask — residue diagnostics on an incomplete kill (EI-21065795494500135)', () => {
  it('reports WHICH kernel state the survivors are stuck in, not a bare unexplained count — all zombie', async () => {
    row({ taskId: 'residue1' });
    const scopeDir = '/sys/fs/cgroup/papercusp.slice/pc-residue1.scope';
    const out = await killTask('residue1', {
      sleep: async () => {},
      fs: {
        readFile: (p: string) => {
          if (p === `${scopeDir}/cgroup.procs`) return '101\n102\n103\n';
          const m = /^\/proc\/(\d+)\/stat$/.exec(p);
          return m ? `${m[1]} (node) Z 1` : null;
        },
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
    const detail = (out as { detail: string }).detail;
    // The base "N process(es) still alive" phrasing existing callers assert on
    // must survive unchanged — the diagnostics are an ADDITION, not a rewrite.
    expect(detail).toMatch(/3 process\(es\) still alive/);
    expect(detail).toMatch(/3 zombie/);
    expect(detail).toMatch(/ALL zombie/);
    expect(detail).toMatch(/re-escalating will not help/);
  });

  it('buckets a MIXED survivor population and only warns "uninterruptible" — never "all zombie" — when they are not all zombies', async () => {
    row({ taskId: 'residue2' });
    const scopeDir = '/sys/fs/cgroup/papercusp.slice/pc-residue2.scope';
    const states: Record<string, string> = { '201': 'Z', '202': 'D', '203': 'R' };
    const out = await killTask('residue2', {
      sleep: async () => {},
      fs: {
        readFile: (p: string) => {
          if (p === `${scopeDir}/cgroup.procs`) return '201\n202\n203\n';
          const m = /^\/proc\/(\d+)\/stat$/.exec(p);
          return m ? `${m[1]} (node) ${states[m[1]]} 1` : null;
        },
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    const detail = (out as { detail: string }).detail;
    expect(detail).toMatch(/1 zombie/);
    expect(detail).toMatch(/1 uninterruptible-sleep/);
    expect(detail).toMatch(/1 running/);
    expect(detail).not.toMatch(/ALL zombie/);
    expect(detail).toMatch(/blocked inside the kernel/);
  });

  it('degrades to "unknown" instead of crashing when a survivor pid\'s /proc/<pid>/stat is unreadable', async () => {
    row({ taskId: 'residue3' });
    const scopeDir = '/sys/fs/cgroup/papercusp.slice/pc-residue3.scope';
    const out = await killTask('residue3', {
      sleep: async () => {},
      fs: {
        readFile: (p: string) => (p === `${scopeDir}/cgroup.procs` ? '301\n' : null),
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
    expect((out as { detail: string }).detail).toMatch(/1 unknown/);
  });
});

describe('killScopeUnit — explicit orphan-scope teardown', () => {
  it('resolves a validated Papercusp scope, requires a live cgroup, and verifies it empty', async () => {
    let alive = true;
    const calls: string[][] = [];
    const out = await killScopeUnit('pc-orphan123.scope', {
      fs: {
        readFile: () => (alive ? '4242\n' : ''),
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[1] === 'show') {
          return {
            stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope\n',
            stderr: '',
          };
        }
        alive = false;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: true, scopeUnit: 'pc-orphan123.scope' });
    expect(calls[0]).toEqual([
      '--user',
      'show',
      '-p',
      'ControlGroup',
      '--value',
      'pc-orphan123.scope',
    ]);
    expect(calls[1]).toEqual(['--user', 'kill', '--signal=SIGTERM', 'pc-orphan123.scope']);
  });

  it('refuses an invalid or empty scope without issuing a kill', async () => {
    const exec = vi.fn(async () => ({
      stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope\n',
      stderr: '',
    }));
    expect(await killScopeUnit('other-service.scope', { execFileAsync: exec as never })).toMatchObject({
      ok: false,
      error: 'no_target',
    });
    expect(exec).not.toHaveBeenCalled();

    const empty = await killScopeUnit('pc-orphan123.scope', {
      fs: { readFile: () => '', readDir: () => [], isDir: () => true },
      execFileAsync: (async () => ({
        stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope\n',
        stderr: '',
      })) as never,
    });
    expect(empty).toMatchObject({ ok: false, error: 'not_live' });
  });

  it('accepts a validated Papercusp transient service unit', async () => {
    let alive = true;
    const calls: string[][] = [];
    const out = await killScopeUnit('pc-service123.service', {
      fs: {
        readFile: () => (alive ? '4242\n' : ''),
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[1] === 'show') {
          return {
            stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-service123.service\n',
            stderr: '',
          };
        }
        alive = false;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: true, scopeUnit: 'pc-service123.service' });
    expect(calls[1]).toEqual(['--user', 'kill', '--signal=SIGTERM', 'pc-service123.service']);
  });

  it('never reports success while an orphan scope survives the verification window', async () => {
    const out = await killScopeUnit('pc-orphan123.scope', {
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async () => ({
        stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope\n',
        stderr: '',
      })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
  });
});

describe('killTask — refusals', () => {
  it('refuses a row that is not live-owned', async () => {
    row({ taskId: 'c1', state: 'unaccounted' });
    // Residue is REPORT-ONLY (D-010): the whole point is that we do not act on a
    // classification we may have got wrong.
    expect(await killTask('c1')).toMatchObject({ ok: false, error: 'not_live' });
  });

  it('refuses an already-ended row', async () => {
    row({ taskId: 'c2', state: 'exited' });
    expect(await killTask('c2')).toMatchObject({ ok: false, error: 'not_live' });
  });

  it('refuses an unconfined row whose pid was recycled — and does NOT signal', async () => {
    row({ taskId: 'c3', confined: false, scopeUnit: null, pid: 77, processIdentity: 'linux:b:1' });
    const kill = vi.fn();
    const out = await killTask('c3', { kill, readIdentity: () => 'linux:b:2' });
    expect(out).toMatchObject({ ok: false, error: 'identity_mismatch' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('closes the row as stranded when the pid is simply gone', async () => {
    row({ taskId: 'c4', confined: false, scopeUnit: null, pid: 77, processIdentity: 'linux:b:1' });
    const out = await killTask('c4', { kill: vi.fn(), readIdentity: () => null });
    expect(out.ok).toBe(false);
    expect(store.closed).toEqual([
      { taskId: 'c4', state: 'stranded', reason: 'process gone at kill time' },
    ]);
  });

  it('is a clean not-found for an unknown id', async () => {
    expect(await killTask('nope')).toMatchObject({ ok: false, error: 'task_not_found' });
  });
});

describe('killTask — subtree', () => {
  it('signals logically-nested tasks that got their own scopes', async () => {
    row({ taskId: 'd1' });
    row({ taskId: 'd2', rootTaskId: 'd1', parentTaskId: 'd1' });
    row({ taskId: 'd3', rootTaskId: 'd1', parentTaskId: 'd2' });
    const units: string[] = [];
    await killTask('d1', {
      includeSubtree: true,
      execFileAsync: (async (_f: string, args: string[]) => {
        units.push(args[args.length - 1]!);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(units.sort()).toEqual(['pc-d1.scope', 'pc-d2.scope', 'pc-d3.scope']);
  });
});

describe('freeze / thaw', () => {
  it('freezes and thaws a confined scope', async () => {
    row({ taskId: 'e1' });
    const calls: string[][] = [];
    const exec = (async (_f: string, args: string[]) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    }) as never;
    expect((await freezeTask('e1', { execFileAsync: exec })).ok).toBe(true);
    expect((await thawTask('e1', { execFileAsync: exec })).ok).toBe(true);
    expect(calls).toEqual([
      ['--user', 'freeze', 'pc-e1.scope'],
      ['--user', 'thaw', 'pc-e1.scope'],
    ]);
  });

  it('refuses to fake a freeze on an unconfined task', async () => {
    // SIGSTOP on the leader would leave every child running — a half-frozen
    // subtree is worse than an honest refusal.
    row({ taskId: 'e2', confined: false, scopeUnit: null, pid: 5 });
    expect(await freezeTask('e2')).toMatchObject({ ok: false, error: 'unsupported' });
  });
});

describe('limitTask', () => {
  it('applies budgets at runtime', async () => {
    row({ taskId: 'f1' });
    const calls: string[][] = [];
    const out = await limitTask(
      'f1',
      { memoryMaxBytes: 2_147_483_648, cpuWeight: 20, tasksMax: 512 },
      {
        execFileAsync: (async (_f: string, args: string[]) => {
          calls.push(args);
          return { stdout: '', stderr: '' };
        }) as never,
      },
    );
    expect(out.ok).toBe(true);
    expect(calls[0]).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'pc-f1.scope',
      'MemoryMax=2147483648',
      'CPUWeight=20',
      'TasksMax=512',
    ]);
  });

  it('rejects an empty budget rather than issuing a no-op command', async () => {
    row({ taskId: 'f2' });
    expect(await limitTask('f2', {})).toMatchObject({ ok: false, error: 'no_target' });
  });
});
