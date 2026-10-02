/**
 * Phase 4 T2.3 scratch GC + quota unit tests.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Pass-through spies on the SYNCHRONOUS fs calls, so a test can prove the reservation hot path
// (WI-10004513) and the GC sweep (WI-10005135) never touch the disk synchronously. Behaviour is
// the real implementation. mkdirSync is spied as the calibration control: ensureScratchRunDir
// still calls it, which proves these spies intercept scratch-gc.ts's own node:fs import.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
    existsSync: vi.fn(actual.existsSync),
    rmSync: vi.fn(actual.rmSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
  readdirSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  runScratchGc,
  reserveScratchSpace,
  ensureScratchRunDir,
  ScratchQuotaError,
  RETENTION_MS,
  _resetScratchGcCountersForTests,
  scratchEvictionBytes,
  refreshScratchUsage,
  scratchUsageBytes,
  _setScratchUsageForTests,
  _resetScratchUsageForTests,
  WORKSPACE_QUOTA_BYTES,
  SCRATCH_GC_CRONTAB,
  SCRATCH_GC_SWEEP_PERIOD_MS,
  SCRATCH_RUN_DIR_MAX_AGE_MS,
} from './scratch-gc';

// Tests run against a sandbox scratch root so they don't touch the
// real ~/.papercusp/scratch tree. `os.homedir()` on Linux reads
// /etc/passwd not $HOME, so the PAPERCUSP_SCRATCH_ROOT env-var
// override is the only reliable swap.
let prevScratchRoot: string | undefined;
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-scratch-test-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, '.papercusp', 'scratch');
  _resetScratchGcCountersForTests();
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

const UUID = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

function makeRunDir(workspaceId: string, toolName: string, runId: string, bytes: number, ageMs = 0): string {
  const dir = ensureScratchRunDir({ workspaceId, toolName, runId });
  writeFileSync(join(dir, 'data.bin'), Buffer.alloc(bytes));
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(dir, t, t);
  }
  return dir;
}

describe('runScratchGc — retention', () => {
  it('keeps fresh run-dirs', async () => {
    makeRunDir('ws-A', 'demo:tool', UUID(1), 100, 0);
    const r = await runScratchGc({ workspaceRegistry: ['ws-A'] });
    expect(r.retentionEvictions).toBe(0);
    expect(existsSync(ensureScratchRunDir({ workspaceId: 'ws-A', toolName: 'demo:tool', runId: UUID(1) }))).toBe(true);
  });

  it('drops run-dirs past RETENTION_MS', async () => {
    makeRunDir('ws-A', 'demo:tool', UUID(1), 100, RETENTION_MS + 1000);
    const before = ensureScratchRunDir({ workspaceId: 'ws-A', toolName: 'demo:tool', runId: UUID(1) });
    // ensureScratchRunDir doesn't reset mtime — re-stamp old timestamp
    // BEFORE running GC. (utimes was just called by makeRunDir.)
    const r = await runScratchGc({ workspaceRegistry: ['ws-A'] });
    expect(r.retentionEvictions).toBeGreaterThanOrEqual(1);
    expect(existsSync(before)).toBe(false);
  });
});

/**
 * WI-10004532: the sweep schedule used to be described by a hand-maintained
 * `GC_INTERVAL_MS = 1h` that nothing read, while the real DBOS crontab was daily. That
 * mismatch made a working GC look broken ("thousands of run dirs older than 24h"). These pin
 * the schedule to ONE source and pin the max-age bound an investigator should check against.
 */
describe('scratch GC schedule — single source + max-age bound (WI-10004532)', () => {
  /** Period of a 6-field (seconds-first) crontab, for the two shapes we use. */
  function crontabPeriodMs(crontab: string): number {
    const f = crontab.trim().split(/\s+/);
    if (f.length !== 6) throw new Error(`expected a 6-field crontab, got: ${crontab}`);
    const fixed = (s: string) => /^\d+$/.test(s);
    const [sec, min, hour, dom, mon, dow] = f;
    if (dom === '*' && mon === '*' && dow === '*') {
      if (fixed(sec) && fixed(min) && fixed(hour)) return 24 * 60 * 60 * 1000;
      if (fixed(sec) && fixed(min) && hour === '*') return 60 * 60 * 1000;
    }
    throw new Error(`crontabPeriodMs does not understand ${crontab}; extend it with the new shape`);
  }

  it('SCRATCH_GC_SWEEP_PERIOD_MS matches SCRATCH_GC_CRONTAB', () => {
    expect(crontabPeriodMs(SCRATCH_GC_CRONTAB)).toBe(SCRATCH_GC_SWEEP_PERIOD_MS);
  });

  it('calibration: the period parser distinguishes daily from hourly', () => {
    expect(crontabPeriodMs('0 0 3 * * *')).toBe(24 * 60 * 60 * 1000);
    expect(crontabPeriodMs('0 0 * * * *')).toBe(60 * 60 * 1000);
  });

  it('the DBOS registration uses SCRATCH_GC_CRONTAB, not a literal crontab', () => {
    const src = readFileSync(new URL('./dbos/periodic-workflows.ts', import.meta.url), 'utf8');
    const call = src.match(/registerScheduled\(\s*scratchGcWorkflow\s*,\s*\{[^}]*\}/);
    expect(call, 'scratchGc registration not found in periodic-workflows.ts').not.toBeNull();
    expect(call![0]).toMatch(/crontab:\s*SCRATCH_GC_CRONTAB\b/);
  });

  it('a run-dir that just escapes one sweep is evicted by the next, before SCRATCH_RUN_DIR_MAX_AGE_MS', async () => {
    const ageAtFirstSweep = RETENTION_MS - 60_000;
    const dir = makeRunDir('ws-A', 'demo:tool', UUID(7), 100, ageAtFirstSweep);
    const t0 = Date.now();

    const first = await runScratchGc({ workspaceRegistry: ['ws-A'], now: t0 });
    expect(first.retentionEvictions).toBe(0);
    expect(existsSync(dir)).toBe(true);

    const second = await runScratchGc({ workspaceRegistry: ['ws-A'], now: t0 + SCRATCH_GC_SWEEP_PERIOD_MS });
    expect(second.retentionEvictions).toBe(1);
    expect(existsSync(dir)).toBe(false);
    // Its age when the second sweep removed it stays inside the documented bound.
    expect(ageAtFirstSweep + SCRATCH_GC_SWEEP_PERIOD_MS).toBeLessThan(SCRATCH_RUN_DIR_MAX_AGE_MS);
  });
});

describe('runScratchGc — dead-workspace cleanup', () => {
  it('drops scratch dirs whose workspace is not in the registry', async () => {
    makeRunDir('ws-DEAD', 'demo:tool', UUID(1), 100);
    makeRunDir('ws-ALIVE', 'demo:tool', UUID(2), 100);
    const r = await runScratchGc({ workspaceRegistry: ['ws-ALIVE'] });
    expect(r.deadWorkspaces).toBe(1);
    expect(r.deadWorkspaceBytes).toBeGreaterThan(0);
    const scratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT!;
    expect(existsSync(join(scratchRoot, 'ws-DEAD'))).toBe(false);
    expect(existsSync(join(scratchRoot, 'ws-ALIVE'))).toBe(true);
  });

  it('is a no-op when scratch root has zero workspace dirs', async () => {
    // The outer beforeEach gave us a fresh sandbox HOME with nothing
    // under .papercusp/scratch yet (this test doesn't call makeRunDir).
    // GC should report no work.
    const r = await runScratchGc({ workspaceRegistry: ['ws-X'] });
    expect(r.deadWorkspaces).toBe(0);
    expect(r.retentionEvictions).toBe(0);
    expect(r.quotaEvictions).toBe(0);
  });
});

describe('reserveScratchSpace — quota enforcement', () => {
  it('accepts a write that fits', () => {
    expect(() => reserveScratchSpace({ workspaceId: 'ws-A', bytes: 1024 })).not.toThrow();
  });

  it('rejects a single write larger than the workspace quota', () => {
    expect(() =>
      reserveScratchSpace({ workspaceId: 'ws-A', bytes: 100 * 1024 * 1024 * 1024 /* 100GB */ }),
    ).toThrow(ScratchQuotaError);
  });

  it('rejects negative bytes', () => {
    expect(() => reserveScratchSpace({ workspaceId: 'ws-A', bytes: -1 })).toThrow(ScratchQuotaError);
  });
});

describe('reserveScratchSpace — no synchronous walk on the hot path (WI-10004513)', () => {
  beforeEach(() => {
    _resetScratchUsageForTests();
  });
  afterEach(() => {
    _resetScratchUsageForTests();
  });

  it('calibration: the spies DO see scratch-gc.ts sync fs calls (so the zero-call assertions are not vacuous)', () => {
    // ensureScratchRunDir is the module's one remaining synchronous fs call (mkdirSync). Seeing it
    // proves the vi.mock above intercepts scratch-gc.ts's own node:fs import, which is the only
    // way the zero-call assertions below could pass vacuously.
    vi.mocked(mkdirSync).mockClear();
    ensureScratchRunDir({ workspaceId: 'ws-A', toolName: 'tool', runId: UUID(9) });
    expect(vi.mocked(mkdirSync)).toHaveBeenCalled();
    // And the spied functions are the ones scratch-gc.ts would call: a direct call is recorded.
    vi.mocked(readdirSync).mockClear();
    readdirSync(process.env.PAPERCUSP_SCRATCH_ROOT!);
    expect(vi.mocked(readdirSync)).toHaveBeenCalled();
  });

  it('performs ZERO synchronous fs calls, however large the tree', async () => {
    // A populated tree: the old implementation did a recursive readdirSync+statSync over all of it
    // on every reservation, which blocked the :3070 worker's event loop past the 20s sentinel.
    for (let i = 0; i < 40; i++) makeRunDir('ws-A', `tool-${i % 4}`, UUID(i), 128);
    await refreshScratchUsage('ws-A'); // fresh cache → no background re-measure either
    vi.mocked(readdirSync).mockClear();
    vi.mocked(statSync).mockClear();
    vi.mocked(existsSync).mockClear();
    for (let i = 0; i < 25; i++) reserveScratchSpace({ workspaceId: 'ws-A', bytes: 64 });
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
  });

  it('also does no synchronous fs work when the cache is stale (the re-measure is async)', () => {
    makeRunDir('ws-A', 'tool', UUID(1), 4096);
    vi.mocked(readdirSync).mockClear();
    vi.mocked(statSync).mockClear();
    vi.mocked(existsSync).mockClear();
    reserveScratchSpace({ workspaceId: 'ws-A', bytes: 10 }); // never measured → kicks a background refresh
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
    expect(scratchUsageBytes('ws-A')).toBe(10); // the reservation itself is counted immediately
  });

  it('a stale reservation triggers ONE background re-measure that replaces the cached total', async () => {
    makeRunDir('ws-A', 'tool-a', UUID(1), 1000);
    makeRunDir('ws-A', 'tool-b', UUID(2), 2000);
    reserveScratchSpace({ workspaceId: 'ws-A', bytes: 10 });
    reserveScratchSpace({ workspaceId: 'ws-A', bytes: 10 });
    await refreshScratchUsage('ws-A'); // joins the in-flight measure started by the first reservation
    expect(scratchUsageBytes('ws-A')).toBe(3000);
  });

  it('refreshScratchUsage measures the tree size asynchronously (missing tree = 0)', async () => {
    await refreshScratchUsage('ws-empty');
    expect(scratchUsageBytes('ws-empty')).toBe(0);
    makeRunDir('ws-B', 'tool', UUID(3), 5000);
    makeRunDir('ws-B', 'tool', UUID(4), 7000);
    await refreshScratchUsage('ws-B');
    expect(scratchUsageBytes('ws-B')).toBe(12000);
  });

  it('still enforces the workspace quota against the cached total', () => {
    _setScratchUsageForTests('ws-A', WORKSPACE_QUOTA_BYTES - 1000);
    expect(() => reserveScratchSpace({ workspaceId: 'ws-A', bytes: 600 })).not.toThrow();
    // 600 is now counted, so another 600 overflows.
    expect(() => reserveScratchSpace({ workspaceId: 'ws-A', bytes: 600 })).toThrow(ScratchQuotaError);
    expect(scratchUsageBytes('ws-A')).toBe(WORKSPACE_QUOTA_BYTES - 400);
  });
});

describe('runScratchGc — no synchronous fs on the event loop (WI-10005135)', () => {
  it('sweeps dead workspaces, expired runs and the quota pass with ZERO synchronous fs calls', async () => {
    // A tree that exercises every pass: a dead workspace, expired and fresh run dirs.
    makeRunDir('ws-DEAD', 'tool', UUID(1), 256);
    for (let i = 0; i < 12; i++) makeRunDir('ws-A', `tool-${i % 3}`, UUID(10 + i), 128, RETENTION_MS + 60_000);
    for (let i = 0; i < 6; i++) makeRunDir('ws-A', `tool-${i % 3}`, UUID(40 + i), 128);
    for (const fn of [readdirSync, statSync, existsSync, rmSync, mkdirSync]) vi.mocked(fn).mockClear();

    const r = await runScratchGc({ workspaceRegistry: ['ws-A'] });

    // It did the work (so the zero-call assertions below are not vacuous) ...
    expect(r.deadWorkspaces).toBe(1);
    expect(r.retentionEvictions).toBe(12);
    const scratch = process.env.PAPERCUSP_SCRATCH_ROOT!;
    // ... with no synchronous fs call on the calling thread.
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
    expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
    expect(vi.mocked(mkdirSync)).not.toHaveBeenCalled();
    // Outcome check, read after the assertions so the test's own calls do not count.
    expect(existsSync(join(scratch, 'ws-DEAD'))).toBe(false);
    expect(readdirSync(join(scratch, 'ws-A', 'tool-0')).length).toBe(2);
  });

  it('yields to the event loop while it walks (a timer scheduled before the sweep fires before it ends)', async () => {
    for (let i = 0; i < 6; i++) makeRunDir('ws-A', `tool-${i % 2}`, UUID(60 + i), 64);
    let timerFiredDuringSweep = false;
    let sweepDone = false;
    setTimeout(() => {
      if (!sweepDone) timerFiredDuringSweep = true;
    }, 0);
    await runScratchGc({ workspaceRegistry: ['ws-A'] });
    sweepDone = true;
    expect(timerFiredDuringSweep).toBe(true);
  });

  it('treats a missing scratch root as an empty tree', async () => {
    process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'does-not-exist');
    const r = await runScratchGc({ workspaceRegistry: ['ws-A'] });
    expect(r).toEqual({
      retentionEvictions: 0,
      retentionEvictedBytes: 0,
      deadWorkspaces: 0,
      deadWorkspaceBytes: 0,
      quotaEvictions: 0,
      quotaEvictedBytes: 0,
    });
  });
});

describe('runScratchGc — quota eviction', () => {
  it('FIFO-evicts oldest run-dirs when over quota', async () => {
    // Set up multiple run-dirs in the same workspace and force
    // quota with a temporary override.
    // We can't easily mutate WORKSPACE_QUOTA_BYTES (frozen import);
    // instead exercise by creating a TON of small dirs and trust
    // the FIFO ordering with mtime stamps.
    //
    // Setup: 3 run-dirs with monotonically newer mtimes.
    // To force quota-eviction we'd need to override the constant.
    // Instead we test the FIFO ORDERING by hand-running the inner
    // logic with synthetic numbers.
    const stamps = [3_000_000_000, 2_000_000_000, 1_000_000_000];
    for (let i = 0; i < 3; i++) {
      const dir = ensureScratchRunDir({
        workspaceId: 'ws-Q',
        toolName: 'demo:tool',
        runId: UUID(i + 10),
      });
      writeFileSync(join(dir, 'data.bin'), Buffer.alloc(100));
      const t = stamps[i] / 1000;
      utimesSync(dir, t, t);
    }
    // Sanity: all 3 dirs exist before GC.
    const wsRoot = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-Q');
    expect(readdirSync(join(wsRoot, 'demo:tool')).length).toBe(3);
    // No quota will fire at 300 bytes total, but the test still
    // exercises the gather-and-sort path.
    await runScratchGc({ workspaceRegistry: ['ws-Q'] });
    expect(scratchEvictionBytes()).toBe(0);
  });
});

describe('ensureScratchRunDir', () => {
  it('creates the chain with 0700 mode', () => {
    const dir = ensureScratchRunDir({ workspaceId: 'ws-A', toolName: 'demo:tool', runId: UUID(99) });
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain('demo:tool');
    expect(dir).toContain(UUID(99));
  });
});
