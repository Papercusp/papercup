import { describe, it, expect, vi } from 'vitest';
import {
  isPlaywrightMcpProcess,
  planOrphanedMcpReap,
  reapOrphanedMcpProcesses,
  DEFAULT_MIN_AGE_MS,
  KILL_GRACE_MS,
  type McpProcInfo,
  type McpKillDeps,
} from './orphaned-mcp-reaper';

// Real, representative cmdlines from the live host measurement (EI-18691186726153223).
const NPM_EXEC_ROOT = 'npm exec @playwright/mcp@latest --browser chromium --headless';
const SH_WRAPPER = 'sh -c playwright-mcp --browser chromium --headless';
const NODE_BIN = 'node /home/x/.npm/_npx/9833c18b2d85bc59/node_modules/.bin/playwright-mcp --browser chromium --headless';
const E2E_TEST_RUN = 'npx playwright test apps/operator/e2e/some.spec.ts'; // MUST NEVER match
const CLAUDE_PARENT = 'claude --dangerously-skip-permissions --session-id abc';
const UNRELATED_NODE = '/usr/bin/node /home/x/papercup/apps/operator/bin/hono-host.ts';

function proc(p: Partial<McpProcInfo> & { pid: number; ppid: number }): McpProcInfo {
  return { cmd: '', startedAtMs: 0, advSessionId: null, ...p };
}

describe('isPlaywrightMcpProcess (safety-critical identification)', () => {
  it('matches the three known playwright-mcp launch-chain forms', () => {
    expect(isPlaywrightMcpProcess(NPM_EXEC_ROOT)).toBe(true);
    expect(isPlaywrightMcpProcess(SH_WRAPPER)).toBe(true);
    expect(isPlaywrightMcpProcess(NODE_BIN)).toBe(true);
  });

  it('NEVER matches the committed Playwright E2E test runner — bare "playwright" is not enough', () => {
    expect(isPlaywrightMcpProcess(E2E_TEST_RUN)).toBe(false);
  });

  it('never matches the owning claude process or unrelated node processes', () => {
    expect(isPlaywrightMcpProcess(CLAUDE_PARENT)).toBe(false);
    expect(isPlaywrightMcpProcess(UNRELATED_NODE)).toBe(false);
  });
});

describe('planOrphanedMcpReap (pure decision core)', () => {
  const NOW = 10_000_000;
  const OLD = NOW - DEFAULT_MIN_AGE_MS - 1000; // just past the age floor
  const YOUNG = NOW - 1000; // freshly spawned

  function threeProcGroup(rootPid: number, startedAtMs: number, advSessionId: number | null): McpProcInfo[] {
    const shPid = rootPid + 1;
    const nodePid = rootPid + 2;
    return [
      proc({ pid: rootPid, ppid: 1, cmd: NPM_EXEC_ROOT, startedAtMs, advSessionId }),
      proc({ pid: shPid, ppid: rootPid, cmd: SH_WRAPPER, startedAtMs: startedAtMs + 5, advSessionId }),
      proc({ pid: nodePid, ppid: shPid, cmd: NODE_BIN, startedAtMs: startedAtMs + 10, advSessionId }),
    ];
  }

  it('groups a full npm-exec -> sh -> node chain into one reap group rooted at the topmost process', () => {
    const processes = threeProcGroup(100, OLD, 42);
    const plan = planOrphanedMcpReap({ processes, nowMs: NOW });
    expect(plan.reap).toHaveLength(1);
    expect(plan.reap[0].rootPid).toBe(100);
    expect(plan.reap[0].pids.sort()).toEqual([100, 101, 102]);
    expect(plan.reap[0].advSessionId).toBe(42);
  });

  it('never includes an ancestor (the owning claude session) in the group', () => {
    const processes: McpProcInfo[] = [
      proc({ pid: 50, ppid: 1, cmd: CLAUDE_PARENT, startedAtMs: OLD, advSessionId: 42 }),
      ...threeProcGroup(100, OLD, 42).map((p) => (p.pid === 100 ? { ...p, ppid: 50 } : p)),
    ];
    const plan = planOrphanedMcpReap({ processes, nowMs: NOW });
    expect(plan.reap).toHaveLength(1);
    expect(plan.reap[0].pids).not.toContain(50);
  });

  it('skips a group younger than minAgeMs (default 30 minutes)', () => {
    const processes = threeProcGroup(100, YOUNG, 42);
    const plan = planOrphanedMcpReap({ processes, nowMs: NOW });
    expect(plan.reap).toHaveLength(0);
    expect(plan.skippedTooYoung).toHaveLength(1);
  });

  it('skips a group with no PAPERCUSP_ADV_SESSION_ID anywhere — never touches non-agent-spawned playwright-mcp', () => {
    const processes = threeProcGroup(100, OLD, null);
    const plan = planOrphanedMcpReap({ processes, nowMs: NOW });
    expect(plan.reap).toHaveLength(0);
    expect(plan.skippedNoAgentAnchor).toHaveLength(1);
  });

  it('finds the agent anchor even when only a descendant (not the root) carries the env var', () => {
    const [root, sh, node] = threeProcGroup(100, OLD, null);
    const processes = [root, sh, { ...node, advSessionId: 42 }];
    const plan = planOrphanedMcpReap({ processes, nowMs: NOW });
    expect(plan.reap).toHaveLength(1);
    expect(plan.reap[0].advSessionId).toBe(42);
  });

  it('leaves unrelated processes (e2e test runs, other node procs) completely alone', () => {
    const processes: McpProcInfo[] = [
      ...threeProcGroup(100, OLD, 42),
      proc({ pid: 200, ppid: 1, cmd: E2E_TEST_RUN, startedAtMs: OLD, advSessionId: 42 }),
      proc({ pid: 201, ppid: 1, cmd: UNRELATED_NODE, startedAtMs: OLD, advSessionId: 42 }),
    ];
    const plan = planOrphanedMcpReap({ processes, nowMs: NOW });
    const allTouched = new Set(plan.reap.flatMap((g) => g.pids));
    expect(allTouched.has(200)).toBe(false);
    expect(allTouched.has(201)).toBe(false);
  });

  it('handles multiple independent groups and orders reap by age (oldest first)', () => {
    const older = threeProcGroup(100, OLD - 100_000, 1);
    const newer = threeProcGroup(300, OLD, 2);
    const plan = planOrphanedMcpReap({ processes: [...older, ...newer], nowMs: NOW });
    expect(plan.reap).toHaveLength(2);
    expect(plan.reap[0].rootPid).toBe(100); // older group first
    expect(plan.reap[1].rootPid).toBe(300);
  });

  it('caps groups per sweep at maxGroupsPerSweep', () => {
    const groups = [1000, 2000, 3000].map((base, i) => threeProcGroup(base, OLD - i, i + 1)).flat();
    const plan = planOrphanedMcpReap({ processes: groups, nowMs: NOW, maxGroupsPerSweep: 2 });
    expect(plan.reap).toHaveLength(2);
  });

  it('a lone sh/node fragment with a dead root is still grouped and reaped (fallback roots)', () => {
    // root already gone; sh's ppid now points to init (1) — sh itself becomes the root.
    const processes: McpProcInfo[] = [
      proc({ pid: 101, ppid: 1, cmd: SH_WRAPPER, startedAtMs: OLD, advSessionId: 42 }),
      proc({ pid: 102, ppid: 101, cmd: NODE_BIN, startedAtMs: OLD + 5, advSessionId: 42 }),
    ];
    const plan = planOrphanedMcpReap({ processes, nowMs: NOW });
    expect(plan.reap).toHaveLength(1);
    expect(plan.reap[0].pids.sort()).toEqual([101, 102]);
  });
});

describe('reapOrphanedMcpProcesses (impure sweep, injected deps)', () => {
  const NOW = 10_000_000;
  const OLD = NOW - DEFAULT_MIN_AGE_MS - 1000;

  function makeDeps(overrides: Partial<McpKillDeps> = {}): McpKillDeps {
    const procs = new Map<number, { cmd: string; ppid: number; startedAtMs: number; env: string; alive: boolean }>([
      [100, { cmd: NPM_EXEC_ROOT, ppid: 1, startedAtMs: OLD, env: 'PAPERCUSP_ADV_SESSION_ID=42\0FOO=bar', alive: true }],
      [101, { cmd: SH_WRAPPER, ppid: 100, startedAtMs: OLD + 1, env: 'PAPERCUSP_ADV_SESSION_ID=42', alive: true }],
      [102, { cmd: NODE_BIN, ppid: 101, startedAtMs: OLD + 2, env: 'PAPERCUSP_ADV_SESSION_ID=42', alive: true }],
    ]);
    return {
      listProc: async () => [...procs.keys()].map(String),
      readCmdline: async (pid) => {
        const p = procs.get(pid);
        if (!p) throw new Error('gone');
        return p.cmd;
      },
      readEnviron: async (pid) => {
        const p = procs.get(pid);
        if (!p) throw new Error('gone');
        return p.env;
      },
      readStat: async (pid) => {
        const p = procs.get(pid);
        if (!p) throw new Error('gone');
        return `${pid} (x) S ${p.ppid} 0 0 0 0 0 0 0 0 0 0 0`;
      },
      startedAtMs: async (pid) => procs.get(pid)?.startedAtMs ?? null,
      sigterm: vi.fn((pid: number) => {
        const p = procs.get(pid);
        if (p) p.alive = false;
        return true;
      }),
      sigkill: vi.fn(() => true),
      pidAlive: (pid) => procs.get(pid)?.alive ?? false,
      wait: async () => {},
      ...overrides,
    };
  }

  it('dryRun (default) classifies and reports without ever signalling', async () => {
    const deps = makeDeps();
    const result = await reapOrphanedMcpProcesses({ deps, patterns: undefined });
    expect(result.dryRun).toBe(true);
    expect(result.groupsPlanned).toBe(1);
    expect(result.killed.sort()).toEqual([100, 101, 102]);
    expect(deps.sigterm).not.toHaveBeenCalled();
    expect(deps.sigkill).not.toHaveBeenCalled();
  });

  it('a real sweep SIGTERMs the whole group and reports them killed once they exit within grace', async () => {
    const deps = makeDeps();
    const result = await reapOrphanedMcpProcesses({ dryRun: false, deps });
    expect(result.dryRun).toBe(false);
    expect(deps.sigterm).toHaveBeenCalledTimes(3);
    expect(deps.sigkill).not.toHaveBeenCalled(); // all exited within grace via the fake sigterm
    expect(result.killed.sort()).toEqual([100, 101, 102]);
  });

  it('SIGKILLs a survivor that ignores SIGTERM', async () => {
    const deps = makeDeps({
      sigterm: vi.fn(() => true), // does NOT flip alive=false — survives the grace window
    });
    const result = await reapOrphanedMcpProcesses({ dryRun: false, deps });
    expect(deps.sigkill).toHaveBeenCalled();
    expect(result.killed.sort()).toEqual([100, 101, 102]);
  });

  it('the pid-recycle guard refuses to signal a pid whose cmdline changed underneath it', async () => {
    const deps = makeDeps();
    const originalReadCmdline = deps.readCmdline;
    deps.readCmdline = async (pid: number) => {
      if (pid === 102) return 'some-unrelated-recycled-process --flag'; // pid got reused
      return originalReadCmdline(pid);
    };
    const result = await reapOrphanedMcpProcesses({ dryRun: false, deps });
    expect(deps.sigterm).not.toHaveBeenCalledWith(102);
    expect(result.killed).not.toContain(102);
  });

  it('never signals anything when no group clears the age/anchor floors', async () => {
    const deps = makeDeps();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(OLD + 1000); // groups read as "young"
    try {
      const result = await reapOrphanedMcpProcesses({ dryRun: false, deps });
      expect(result.groupsPlanned).toBe(0);
      expect(deps.sigterm).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('a sampling failure degrades to a clean no-op result, never throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps({ listProc: async () => { throw new Error('boom'); } });
      await expect(reapOrphanedMcpProcesses({ dryRun: false, deps })).resolves.toMatchObject({
        scanned: 0,
        groupsPlanned: 0,
        killed: [],
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('KILL_GRACE_MS is a sane positive window', () => {
    expect(KILL_GRACE_MS).toBeGreaterThan(0);
    expect(KILL_GRACE_MS).toBeLessThan(30_000);
  });
});
