import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskRow, TaskState } from './types';
import type { ScanResult } from './scan';
import type { ScannedProcess } from './reconcile';

const store = vi.hoisted(() => ({
  touched: [] as unknown[],
  stranded: [] as { taskId: string; reason: string }[],
  upserted: [] as { taskId: string }[],
  cleared: [] as string[][],
}));

vi.mock('./store', () => ({
  listLiveTasks: async () => [] as TaskRow[],
  touchAlive: async (u: unknown[]) => {
    store.touched.push(...u);
    return u.length;
  },
  markStranded: async (v: { taskId: string; reason: string }[]) => {
    store.stranded.push(...v);
    return v.length;
  },
  upsertUnaccounted: async (g: { taskId: string }[]) => {
    store.upserted.push(...g);
    return g.map((x) => x.taskId);
  },
  clearVanishedUnaccounted: async (keep: string[]) => {
    store.cleared.push(keep);
    return 0;
  },
  residueTaskId: (p: string) => `u${p.replace(/[^a-z0-9]/g, '').slice(0, 12)}`,
}));

const { reconcileTick, resetNotifyDebounce } = await import('./reconcile-tick');

const OURS = '/user.slice/user@1000.service/papercusp.slice';

function row(over: Partial<TaskRow> & { taskId: string }): TaskRow {
  return {
    workspaceId: 'w',
    rootTaskId: over.taskId,
    class: 'bash-job',
    title: 't',
    argv: [],
    confined: true,
    scopeUnit: `pc-${over.taskId}.scope`,
    state: 'running' as TaskState,
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    lastSeenAt: new Date(Date.now() - 600_000).toISOString(),
    launchedBy: 'su-test',
    detail: {},
    ...over,
  };
}

function scanResult(processes: ScannedProcess[], over: Partial<ScanResult> = {}): ScanResult {
  return {
    processes,
    ownedRootAbs: `/sys/fs/cgroup${OURS}`,
    ownedRootExists: true,
    userManagerRoot: '/user.slice/user@1000.service',
    ownedTruncated: false,
    foreignTruncated: false,
    ...over,
  };
}

const memFs = (files: Record<string, string>) => ({
  readFile: (p: string) => files[p] ?? null,
  readDir: () => [],
  isDir: () => true,
});

beforeEach(() => {
  store.touched.length = 0;
  store.stranded.length = 0;
  store.upserted.length = 0;
  store.cleared.length = 0;
  resetNotifyDebounce();
});

describe('reconcileTick — happy path', () => {
  it('refreshes live rows with metrics sampled from their scope', async () => {
    const dir = `${OURS}/pc-aaa111.scope`;
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'aaa111' })],
      scan: () =>
        scanResult([
          { pid: 10, cgroupPath: dir, processIdentity: 'linux:b:10', cmdline: 'node x', owned: true },
        ]),
      fs: memFs({
        [`/sys/fs/cgroup${dir}/memory.current`]: '5242880',
        [`/sys/fs/cgroup${dir}/cpu.stat`]: 'usage_usec 1234\n',
        [`/sys/fs/cgroup${dir}/pids.current`]: '3',
      }),
    });
    expect(out.summary.alive).toBe(1);
    expect(store.touched[0]).toMatchObject({
      taskId: 'aaa111',
      pid: 10,
      metrics: { lastMemoryBytes: 5242880, cpuUsec: 1234, pidsCurrent: 3 },
    });
    expect(out.degraded).toBe(false);
  });

  it('strands a row the kernel no longer has', async () => {
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'bbb222' })],
      scan: () => scanResult([]),
      fs: memFs({}),
    });
    expect(out.strandedCount).toBe(1);
    expect(store.stranded[0]!.taskId).toBe('bbb222');
  });

  it('persists an unaccounted group and reports it', async () => {
    const sent: { summary: string; kind: 'message' | 'escalation' }[] = [];
    const notify = vi.fn(async (msg: { summary: string; kind: 'message' | 'escalation' }) => {
      sent.push(msg);
    });
    const out = await reconcileTick({
      listLive: async () => [],
      scan: () =>
        scanResult([
          {
            pid: 99,
            cgroupPath: `${OURS}/papercusp-bash-job.slice`,
            processIdentity: 'linux:b:99',
            cmdline: 'rogue',
            owned: true,
          },
        ]),
      fs: memFs({}),
      notify,
    });
    expect(out.unaccountedPersisted).toBe(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(sent[0]!.summary).toMatch(/unaccounted cgroup/);
  });

  it('keeps a closed scope attached to its ORIGINAL task id rather than forking a phantom', async () => {
    await reconcileTick({
      listLive: async () => [],
      scan: () =>
        scanResult([
          {
            pid: 5,
            cgroupPath: `${OURS}/pc-ccc333.scope`,
            processIdentity: null,
            cmdline: 'zombie',
            owned: true,
          },
        ]),
      fs: memFs({}),
    });
    expect(store.upserted[0]!.taskId).toBe('ccc333');
  });
});

describe('reconcileTick — refusing to act on a bad scan', () => {
  it('does NOT mass-strand when our cgroup root does not exist', async () => {
    // A missing root is a SCAN fault. Row-by-row it is indistinguishable from an
    // idle box, so acting on it would report a fleet-wide outage that never
    // happened — the single most damaging thing this tick could do.
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'ddd444' }), row({ taskId: 'eee555' })],
      scan: () => scanResult([], { ownedRootExists: false }),
      fs: memFs({}),
    });
    expect(out.degraded).toBe(true);
    expect(out.degradedReason).toMatch(/does not exist/);
    expect(out.strandedCount).toBe(0);
    expect(store.stranded).toHaveLength(0);
  });

  it('does NOT strand when the OWNED scan hit its process cap', async () => {
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'fff666' })],
      scan: () => scanResult([], { ownedTruncated: true }),
      fs: memFs({}),
    });
    expect(out.degraded).toBe(true);
    expect(out.strandedCount).toBe(0);
  });

  it('a truncated FOREIGN pass does NOT degrade the verdict', async () => {
    // Found by the P-021 live run: on this box the foreign population (500+
    // matching processes) exhausted a SHARED cap, set `truncated`, and put the
    // reconciler into permanent degraded mode — so it would never have closed a
    // stranded row again. A display-only view must never be able to disable the
    // ledger's correctness path.
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'fff667' })],
      scan: () => scanResult([], { foreignTruncated: true }),
      fs: memFs({}),
    });
    expect(out.degraded).toBe(false);
    expect(out.strandedCount).toBe(1);
  });

  it('STILL records positive confirmations on a degraded scan', async () => {
    // Absence is untrustworthy; presence is not. A task we can see is alive stays
    // alive even when the scan is otherwise incomplete.
    const dir = `${OURS}/pc-ggg777.scope`;
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'ggg777' }), row({ taskId: 'hhh888' })],
      scan: () =>
        scanResult(
          [{ pid: 7, cgroupPath: dir, processIdentity: 'linux:b:7', cmdline: 'x', owned: true }],
          { ownedTruncated: true },
        ),
      fs: memFs({}),
    });
    expect(out.touched).toBe(1);
    expect(out.strandedCount).toBe(0);
  });

  it('escalates a degraded scan rather than staying quiet', async () => {
    const sent: { summary: string; kind: 'message' | 'escalation' }[] = [];
    const notify = vi.fn(async (msg: { summary: string; kind: 'message' | 'escalation' }) => {
      sent.push(msg);
    });
    await reconcileTick({
      listLive: async () => [row({ taskId: 'iii999' })],
      scan: () => scanResult([], { ownedRootExists: false }),
      fs: memFs({}),
      notify,
    });
    expect(sent[0]!.kind).toBe('escalation');
  });

  it('an empty scan on an EMPTY ledger is not degraded — nothing to get wrong', async () => {
    const out = await reconcileTick({
      listLive: async () => [],
      scan: () => scanResult([], { ownedRootExists: false }),
      fs: memFs({}),
    });
    expect(out.degraded).toBe(false);
  });
});

describe('reconcileTick — dryRun', () => {
  it('computes a verdict without writing anything', async () => {
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'jjj000' })],
      scan: () => scanResult([]),
      fs: memFs({}),
      dryRun: true,
    });
    expect(out.summary.stranded).toBe(1);
    expect(store.stranded).toHaveLength(0);
    expect(store.touched).toHaveLength(0);
  });
});

describe('reconcileTick — notification discipline', () => {
  it('says nothing at all on a clean tick', async () => {
    const sent: { summary: string; kind: 'message' | 'escalation' }[] = [];
    const notify = vi.fn(async (msg: { summary: string; kind: 'message' | 'escalation' }) => {
      sent.push(msg);
    });
    await reconcileTick({ listLive: async () => [], scan: () => scanResult([]), fs: memFs({}), notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not re-notify an unchanged condition every tick', async () => {
    // 30s cadence x a per-tick broadcast = 2,880 messages/day, which is how a
    // signal becomes noise and then gets muted.
    const sent: { summary: string; kind: 'message' | 'escalation' }[] = [];
    const notify = vi.fn(async (msg: { summary: string; kind: 'message' | 'escalation' }) => {
      sent.push(msg);
    });
    const args = {
      listLive: async () => [],
      scan: () =>
        scanResult([
          { pid: 1, cgroupPath: `${OURS}/x`, processIdentity: null, cmdline: 'r', owned: true },
        ]),
      fs: memFs({}),
      notify,
    };
    await reconcileTick(args);
    await reconcileTick(args);
    await reconcileTick(args);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('re-notifies when the condition CHANGES', async () => {
    const sent: { summary: string; kind: 'message' | 'escalation' }[] = [];
    const notify = vi.fn(async (msg: { summary: string; kind: 'message' | 'escalation' }) => {
      sent.push(msg);
    });
    await reconcileTick({
      listLive: async () => [],
      scan: () =>
        scanResult([
          { pid: 1, cgroupPath: `${OURS}/x`, processIdentity: null, cmdline: 'r', owned: true },
        ]),
      fs: memFs({}),
      notify,
    });
    await reconcileTick({
      listLive: async () => [],
      scan: () =>
        scanResult([
          { pid: 1, cgroupPath: `${OURS}/x`, processIdentity: null, cmdline: 'r', owned: true },
          { pid: 2, cgroupPath: `${OURS}/y`, processIdentity: null, cmdline: 'r2', owned: true },
        ]),
      fs: memFs({}),
      notify,
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
