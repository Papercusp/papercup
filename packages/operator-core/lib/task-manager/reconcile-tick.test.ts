import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskRow, TaskState } from './types';
import type { ScanResult } from './scan';
import type { ScannedProcess } from './reconcile';

const store = vi.hoisted(() => ({
  touched: [] as unknown[],
  stranded: [] as { taskId: string; reason: string }[],
  endedUnobserved: [] as { taskId: string; reason: string; terminalProvenance?: unknown }[],
  recovered: [] as { taskId: string; state: string; exitCode: number | null; reason: string }[],
  upserted: [] as { taskId: string; metrics?: unknown }[],
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
  markEndedUnobserved: async (v: { taskId: string; reason: string; terminalProvenance?: unknown }[]) => {
    store.endedUnobserved.push(...v);
    return v.length;
  },
  markRecoveredFromJobLog: async (v: { taskId: string; state: string; exitCode: number | null; reason: string }[]) => {
    store.recovered.push(...v);
    return v.length;
  },
  upsertUnaccounted: async (g: { taskId: string; metrics?: unknown }[]) => {
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

/**
 * A scanned process, defaulted. Every fixture here is an in-slice process, which
 * `classifyScope` maps to `{ scope: 'owned', exemptReason: null }`.
 *
 * This exists as a factory rather than eight inline literals because it already
 * failed once that way: adding the required `scope` / `exemptReason` fields to
 * `ScannedProcess` stranded all eight sites at once and red-ed the tsc ratchet
 * (WI-7014). Constructing through here means the NEXT required field is one edit,
 * and `tsc` points at this function instead of scattering across the file.
 */
function proc(over: Partial<ScannedProcess> & { pid: number; cgroupPath: string }): ScannedProcess {
  return {
    processIdentity: null,
    cmdline: 'x',
    owned: true,
    scope: 'owned',
    exemptReason: null,
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
  store.endedUnobserved.length = 0;
  store.recovered.length = 0;
  store.upserted.length = 0;
  store.cleared.length = 0;
  resetNotifyDebounce();
});

describe('reconcileTick — happy path', () => {
  it('refreshes live rows with metrics sampled from their scope', async () => {
    const dir = `${OURS}/pc-aaa111.scope`;
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'aaa111' })],
      scan: () => scanResult([proc({ pid: 10, cgroupPath: dir, processIdentity: 'linux:b:10', cmdline: 'node x' })]),
      fs: memFs({
        [`/sys/fs/cgroup${dir}/memory.current`]: '5242880',
        [`/sys/fs/cgroup${dir}/cpu.stat`]: 'usage_usec 1234\n',
        [`/sys/fs/cgroup${dir}/pids.current`]: '3',
        [`/sys/fs/cgroup${dir}/pids.events`]: 'max 8\n',
      }),
    });
    expect(out.summary.alive).toBe(1);
    expect(store.touched[0]).toMatchObject({
      taskId: 'aaa111',
      pid: 10,
      metrics: { lastMemoryBytes: 5242880, cpuUsec: 1234, pidsCurrent: 3, pidsEventsMax: 8 },
    });
    expect(out.degraded).toBe(false);
  });

  it('strands a row the kernel no longer has', async () => {
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'bbb222' })],
      scan: () => scanResult([]),
      fs: memFs({}),
      // D-018: an absent row's scope is a stranding CANDIDATE, so reconcileTick
      // asks checkScopesReleased before deciding stranded vs endedUnobserved.
      // Without an injected fake it falls back to the REAL systemctl-backed
      // probe — which, run for real against a scope that was never created,
      // reports the unit `inactive` (systemd's answer for anything it has
      // never heard of) and would non-deterministically reclassify this row
      // as endedUnobserved. Inject "confirms nothing" to keep this test about
      // stranding, not about this host's live systemd state.
      checkScopesReleased: async () => new Set<string>(),
    });
    expect(out.strandedCount).toBe(1);
    expect(store.stranded[0]!.taskId).toBe('bbb222');
  });

  it('persists an unaccounted group but reports it only after two scans confirm it', async () => {
    const sent: { summary: string; kind: 'message' | 'escalation' }[] = [];
    const notify = vi.fn(async (msg: { summary: string; kind: 'message' | 'escalation' }) => {
      sent.push(msg);
    });
    const cgroupPath = `${OURS}/papercusp-bash-job.slice`;
    const args = {
      listLive: async () => [],
      scan: () =>
        scanResult([
          proc({
            pid: 99,
            cgroupPath,
            processIdentity: 'linux:b:99',
            cmdline: 'rogue',
          }),
        ]),
      fs: memFs({
        [`/sys/fs/cgroup${cgroupPath}/memory.current`]: '4096',
        [`/sys/fs/cgroup${cgroupPath}/memory.peak`]: '8192',
        [`/sys/fs/cgroup${cgroupPath}/cpu.stat`]: 'usage_usec 9876\n',
        [`/sys/fs/cgroup${cgroupPath}/pids.current`]: '2',
      }),
      notify,
    };
    const first = await reconcileTick(args);
    expect(first.unaccountedPersisted).toBe(1);
    expect(store.upserted[0]).toMatchObject({
      taskId: expect.any(String),
      metrics: {
        lastMemoryBytes: 4096,
        peakMemoryBytes: 8192,
        cpuUsec: 9876,
        pidsCurrent: 2,
      },
    });
    expect(first.confirmedUnaccounted).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    const second = await reconcileTick(args);
    expect(second.unaccountedPersisted).toBe(1);
    expect(second.confirmedUnaccounted).toHaveLength(1);
    expect(second.confirmedUnaccounted[0]).toMatchObject({ cgroupPath, pids: [99] });
    expect(notify).toHaveBeenCalledOnce();
    expect(sent[0]!.summary).toMatch(/unaccounted cgroup/);
    expect(sent[0]!.summary).toContain('confirmed across 2 consecutive healthy scans');
    expect(sent[0]!.summary).toContain(`cgroup=${cgroupPath}`);
    expect(sent[0]!.summary).toContain('pids=99');
  });

  it('suppresses a one-scan residue that vanishes before confirmation', async () => {
    const notify = vi.fn();
    const cgroupPath = `${OURS}/papercusp-bash-job.slice`;
    await reconcileTick({
      listLive: async () => [],
      scan: () => scanResult([proc({ pid: 99, cgroupPath, processIdentity: 'linux:b:99', cmdline: 'short-lived' })]),
      fs: memFs({}),
      notify,
    });
    await reconcileTick({ listLive: async () => [], scan: () => scanResult([]), fs: memFs({}), notify });
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * EI-20106565311448967 — the property the fix actually has to deliver.
   *
   * A `papercup-console-*` scope is a desktop terminal window we opened for a human.
   * `spawnConsole` hardcodes `taskScope: null` and `console-spawn.ts` is allowlisted
   * from enrolment, so the scope can NEVER acquire a ledger row: counted as residue it
   * re-notified every 30 minutes forever. Measured on this box: 7 scopes / 14 processes.
   */
  it('does NOT alarm on a human console window that can never hold a ledger row', async () => {
    const notify = vi.fn();
    const args = {
      listLive: async () => [],
      scan: () =>
        scanResult([
          proc({
            pid: 99,
            cgroupPath: `${OURS}/papercusp-agent-session.slice/papercup-console-gnome-terminal-665488-1786388175428.scope`,
            processIdentity: 'linux:b:99',
            cmdline: 'gnome-terminal',
          }),
        ]),
      fs: memFs({}),
      notify,
    };
    await reconcileTick(args);
    expect(notify).not.toHaveBeenCalled();
  });

  it('distinguishes an unmanaged cgroup from a managed scope with no live row (WI-37509)', async () => {
    // A managed scope name proves provenance, not whether its fire-and-forget
    // ledger insert ever succeeded. The notification must stick to present-tense
    // evidence instead of inventing registration history from the scope name.
    const sent: { summary: string }[] = [];
    const args = {
      listLive: async () => [],
      scan: () =>
        scanResult([
          // No managed task scope owns this cgroup.
          proc({
            pid: 99,
            cgroupPath: `${OURS}/papercusp-bash-job.slice`,
            processIdentity: 'linux:b:99',
            cmdline: 'rogue',
          }),
          // Managed provenance, but no live ledger row in this scan.
          proc({
            pid: 100,
            cgroupPath: `${OURS}/pc-ddd444.scope`,
            processIdentity: 'linux:b:100',
            cmdline: 'fleet spawner sidecar',
          }),
        ]),
      fs: memFs({}),
      notify: async (msg: { summary: string }) => {
        sent.push(msg);
      },
    };
    await reconcileTick(args);
    await reconcileTick(args);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.summary).toMatch(/1 outside any managed task scope/);
    expect(sent[0]!.summary).toMatch(/1 in managed scope\(s\) with no live ledger row/);
  });

  it('keeps a closed scope attached to its ORIGINAL task id rather than forking a phantom', async () => {
    await reconcileTick({
      listLive: async () => [],
      scan: () =>
        scanResult([
          proc({
            pid: 5,
            cgroupPath: `${OURS}/pc-ccc333.scope`,
            processIdentity: null,
            cmdline: 'zombie',
          }),
        ]),
      fs: memFs({}),
    });
    expect(store.upserted[0]!.taskId).toBe('ccc333');
  });
});

describe('reconcileTick — endedUnobserved wiring (D-018)', () => {
  it('marks endedUnobserved (not stranded) when checkScopesReleased confirms the candidate scope', async () => {
    const checkScopesReleased = vi.fn(async (units: readonly string[]) => new Set(units));
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'ttt111' })],
      scan: () => scanResult([]),
      fs: memFs({}),
      checkScopesReleased,
    });
    expect(checkScopesReleased).toHaveBeenCalledWith(['pc-ttt111.scope']);
    expect(out.strandedCount).toBe(0);
    expect(out.endedUnobservedCount).toBe(1);
    expect(store.stranded).toHaveLength(0);
    expect(store.endedUnobserved).toEqual([expect.objectContaining({ taskId: 'ttt111' })]);
  });

  it('still strands when checkScopesReleased confirms nothing', async () => {
    const checkScopesReleased = vi.fn(async () => new Set<string>());
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'uuu222' })],
      scan: () => scanResult([]),
      fs: memFs({}),
      checkScopesReleased,
    });
    expect(out.strandedCount).toBe(1);
    expect(out.endedUnobservedCount).toBe(0);
    expect(store.endedUnobserved).toHaveLength(0);
  });

  it('only queries candidate units — rows whose scope IS visible in the scan are never asked about', async () => {
    const dir = `${OURS}/pc-vvv333.scope`;
    const checkScopesReleased = vi.fn(async () => new Set<string>());
    await reconcileTick({
      listLive: async () => [row({ taskId: 'vvv333' }), row({ taskId: 'www444' })],
      scan: () => scanResult([proc({ pid: 1, cgroupPath: dir, processIdentity: 'linux:b:1', cmdline: 'x' })]),
      fs: memFs({}),
      checkScopesReleased,
    });
    // vvv333 is alive (its scope is in the scan) — only www444's scope is a candidate.
    expect(checkScopesReleased).toHaveBeenCalledWith(['pc-www444.scope']);
  });

  it('skips checkScopesReleased entirely when there are no candidates', async () => {
    const dir = `${OURS}/pc-xxx555.scope`;
    const checkScopesReleased = vi.fn(async () => new Set<string>());
    await reconcileTick({
      listLive: async () => [row({ taskId: 'xxx555' })],
      scan: () => scanResult([proc({ pid: 1, cgroupPath: dir, processIdentity: 'linux:b:1', cmdline: 'x' })]),
      fs: memFs({}),
      checkScopesReleased,
    });
    expect(checkScopesReleased).not.toHaveBeenCalled();
  });

  it('persists and then resets a failed unit terminal snapshot in the same tick', async () => {
    const terminal = {
      capturedAt: '2026-08-24T16:00:00.000Z',
      scopeUnit: 'pc-oom777.service',
      cgroupPath: null,
      invocationId: 'oom-invocation',
      loadState: 'loaded',
      activeState: 'failed',
      serviceResult: 'oom-kill',
      execMainCode: 2,
      execMainStatus: 9,
      memoryMaxBytes: 32 * 1024 * 1024,
      peakMemoryBytes: 32 * 1024 * 1024,
      peakMemorySource: 'systemd' as const,
    };
    const inspectTaskUnitTerminals = vi.fn(async () => new Map([[terminal.scopeUnit, terminal]]));
    const resetFailedTaskUnit = vi.fn(async () => true);

    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'oom777', scopeUnit: terminal.scopeUnit })],
      scan: () => scanResult([]),
      fs: memFs({}),
      inspectTaskUnitTerminals,
      resetFailedTaskUnit,
    });

    expect(out.endedUnobservedCount).toBe(1);
    expect(store.endedUnobserved[0]).toMatchObject({
      taskId: 'oom777',
      terminalProvenance: terminal,
    });
    expect(resetFailedTaskUnit).toHaveBeenCalledWith(terminal);
  });

  // WI-10004208 — a SUCCESSFUL transient service is garbage-collected at once, so
  // a row whose operator-host watcher died reaches the reconciler with systemd
  // answering not-found and no exit. The runner's JOB END in the log is the exit.
  const collected = (unit: string) => ({
    capturedAt: '2026-09-30T07:59:12.032Z',
    scopeUnit: unit,
    cgroupPath: null,
    invocationId: null,
    loadState: 'not-found',
    activeState: 'inactive',
    serviceResult: null,
    execMainCode: null,
    execMainStatus: null,
    memoryMaxBytes: null,
    peakMemoryBytes: null,
    peakMemorySource: 'unknown' as const,
  });

  it('closes a collected unit from the runner JOB END in its log instead of ended_unobserved', async () => {
    const terminal = collected('pc-ok888.service');
    const readJobLogTerminal = vi.fn(() => ({ status: 'completed' as const, exitCode: 0 }));
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'ok888', scopeUnit: terminal.scopeUnit, logPath: '/logs/ok888.log' })],
      scan: () => scanResult([]),
      fs: memFs({}),
      inspectTaskUnitTerminals: vi.fn(async () => new Map([[terminal.scopeUnit, terminal]])),
      resetFailedTaskUnit: vi.fn(async () => true),
      readJobLogTerminal,
    });
    expect(readJobLogTerminal).toHaveBeenCalledWith('/logs/ok888.log');
    expect(out.recoveredFromJobLogCount).toBe(1);
    expect(out.endedUnobservedCount).toBe(0);
    expect(store.endedUnobserved).toHaveLength(0);
    expect(store.recovered).toEqual([
      expect.objectContaining({ taskId: 'ok888', state: 'exited', exitCode: 0, reason: expect.stringMatching(/^runner-log: /) }),
    ]);
  });

  it('keeps a failed runner exit as exited with its real non-zero code', async () => {
    const terminal = collected('pc-bad999.service');
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'bad999', scopeUnit: terminal.scopeUnit, logPath: '/logs/bad999.log' })],
      scan: () => scanResult([]),
      fs: memFs({}),
      inspectTaskUnitTerminals: vi.fn(async () => new Map([[terminal.scopeUnit, terminal]])),
      resetFailedTaskUnit: vi.fn(async () => true),
      readJobLogTerminal: () => ({ status: 'failed', exitCode: 4 }),
    });
    expect(out.recoveredFromJobLogCount).toBe(1);
    expect(store.recovered[0]).toMatchObject({ taskId: 'bad999', state: 'exited', exitCode: 4 });
  });

  it('still records ended_unobserved when the log carries no JOB END (no evidence is not a verdict)', async () => {
    const terminal = collected('pc-none000.service');
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'none000', scopeUnit: terminal.scopeUnit, logPath: '/logs/none000.log' })],
      scan: () => scanResult([]),
      fs: memFs({}),
      inspectTaskUnitTerminals: vi.fn(async () => new Map([[terminal.scopeUnit, terminal]])),
      resetFailedTaskUnit: vi.fn(async () => true),
      readJobLogTerminal: () => null,
    });
    expect(out.recoveredFromJobLogCount).toBe(0);
    expect(out.endedUnobservedCount).toBe(1);
    expect(store.endedUnobserved).toEqual([expect.objectContaining({ taskId: 'none000' })]);
  });

  it('never reads the log when systemd still holds the exit status (systemd stays authoritative)', async () => {
    const terminal = { ...collected('pc-held111.service'), loadState: 'loaded', activeState: 'failed', serviceResult: 'exit-code', execMainCode: 1, execMainStatus: 4 };
    const readJobLogTerminal = vi.fn(() => ({ status: 'completed' as const, exitCode: 0 }));
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'held111', scopeUnit: terminal.scopeUnit, logPath: '/logs/held111.log' })],
      scan: () => scanResult([]),
      fs: memFs({}),
      inspectTaskUnitTerminals: vi.fn(async () => new Map([[terminal.scopeUnit, terminal]])),
      resetFailedTaskUnit: vi.fn(async () => true),
      readJobLogTerminal,
    });
    expect(readJobLogTerminal).not.toHaveBeenCalled();
    expect(out.recoveredFromJobLogCount).toBe(0);
    expect(store.endedUnobserved[0]).toMatchObject({ taskId: 'held111', terminalProvenance: terminal });
  });

  it('a degraded scan skips BOTH markStranded and markEndedUnobserved', async () => {
    const checkScopesReleased = vi.fn(async (units: readonly string[]) => new Set(units));
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'yyy666' })],
      scan: () => scanResult([], { ownedRootExists: false }),
      fs: memFs({}),
      checkScopesReleased,
    });
    expect(out.degraded).toBe(true);
    expect(out.strandedCount).toBe(0);
    expect(out.endedUnobservedCount).toBe(0);
    expect(store.stranded).toHaveLength(0);
    expect(store.endedUnobserved).toHaveLength(0);
  });

  it('defaults to the real systemctl-backed terminal inspector when none is injected (fails soft off-Linux/CI)', async () => {
    // No release/terminal dep passed — reconcileTick falls back to the real
    // module import, which fails soft on any error. This just proves the tick
    // does not throw and still produces a verdict.
    const out = await reconcileTick({
      listLive: async () => [row({ taskId: 'zzz777' })],
      scan: () => scanResult([]),
      fs: memFs({}),
    });
    expect(out.summary.stranded + out.summary.endedUnobserved).toBe(1);
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
      checkScopesReleased: async () => new Set<string>(), // hermetic — see 'strands a row the kernel no longer has'
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
        scanResult([proc({ pid: 7, cgroupPath: dir, processIdentity: 'linux:b:7', cmdline: 'x' })], {
          ownedTruncated: true,
        }),
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
      checkScopesReleased: async () => new Set<string>(), // hermetic — see 'strands a row the kernel no longer has'
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
      scan: () => scanResult([proc({ pid: 1, cgroupPath: `${OURS}/x`, processIdentity: null, cmdline: 'r' })]),
      fs: memFs({}),
      notify,
    };
    await reconcileTick(args);
    await reconcileTick(args);
    await reconcileTick(args);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('re-notifies when the condition CHANGES — clears, then re-opens', async () => {
    // A genuine condition change is the category OPENING or CLOSING, not its count
    // moving. This used to assert 1 -> 2 residue cgroups re-notified; that is a
    // MAGNITUDE change, and treating it as an event is exactly EI-20108913085212631.
    const sent: { summary: string; kind: 'message' | 'escalation' }[] = [];
    const notify = vi.fn(async (msg: { summary: string; kind: 'message' | 'escalation' }) => {
      sent.push(msg);
    });
    const withResidue = {
      listLive: async () => [],
      scan: () => scanResult([proc({ pid: 1, cgroupPath: `${OURS}/x`, processIdentity: null, cmdline: 'r' })]),
      fs: memFs({}),
      notify,
    };
    const clear = { listLive: async () => [], scan: () => scanResult([]), fs: memFs({}), notify };

    await reconcileTick(withResidue); // first observation — hold
    await reconcileTick(withResidue); // opens after confirmation -> notify #1
    await reconcileTick(clear); // closes -> resets the debounce key, no message
    await reconcileTick(withResidue); // first observation — hold
    await reconcileTick(withResidue); // re-opens after confirmation -> notify #2

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('EI-20108913085212631: a churning COUNT does not defeat the debounce', async () => {
    // The regression. Residue cgroups wobble as processes come and go (6 -> 5 -> 6 is
    // the healthy steady state on a busy box, not an event). The debounce key used to
    // interpolate the raw counts, so every wobble minted a new key and re-fired the
    // alarm on the very next tick — measured at 5 messages in 7 minutes.
    const sent: { summary: string; kind: 'message' | 'escalation' }[] = [];
    const notify = vi.fn(async (msg: { summary: string; kind: 'message' | 'escalation' }) => {
      sent.push(msg);
    });
    const residue = (n: number) => ({
      listLive: async () => [],
      scan: () =>
        scanResult(
          Array.from({ length: n }, (_, i) =>
            proc({ pid: i + 1, cgroupPath: `${OURS}/r${i}`, processIdentity: null, cmdline: `r${i}` }),
          ),
        ),
      fs: memFs({}),
      notify,
    });

    await reconcileTick(residue(1));
    await reconcileTick(residue(2));
    await reconcileTick(residue(1));
    await reconcileTick(residue(3));
    await reconcileTick(residue(2));

    // The condition never closed, so this is ONE alarm — not five.
    expect(notify).toHaveBeenCalledOnce();
    expect(sent[0]!.summary).toContain('unaccounted cgroup(s)');
  });
});
