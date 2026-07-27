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

const { killTask, freezeTask, thawTask, limitTask, verifyPidStillOurs } = await import('./control');

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

  it('escalates to SIGKILL only when the scope still holds processes', async () => {
    row({ taskId: 'b2' });
    const calls: string[][] = [];
    await killTask('b2', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs: { readFile: () => '999\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls.map((c) => c[2])).toEqual(['--signal=SIGTERM', '--signal=SIGKILL']);
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
