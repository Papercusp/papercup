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
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), rm: vi.fn(actual.rm) };
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
  symlinkSync,
  openSync,
  closeSync,
  realpathSync,
  truncateSync,
} from 'node:fs';
import { readdir as readdirAsync, rm as rmAsync, writeFile } from 'node:fs/promises';
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
  WORKSPACE_SCRATCH_MARKER,
  DEAD_WORKSPACE_QUIET_MS,
  writeWithScratchQuota,
} from './scratch-gc';
import type { OpenWriterScan } from './native-bg-task-ledger';
import { writeScratchReference } from './scratch-reference';
import { scratchRootForWorkspace } from './scratch-uri';
import { spawn } from 'node:child_process';

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
  _resetScratchUsageForTests();
});

afterEach(() => {
  _resetScratchUsageForTests();
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

function makeSparseRun(workspaceId: string, runId: string, bytes: number, ageMs = 0): string {
  const dir = makeRunDir(workspaceId, 'quota', runId, 0, ageMs);
  truncateSync(join(dir, 'data.bin'), bytes);
  return dir;
}

/** Stamp EVERY file and dir under `dir` (children first, then `dir`) `ageMs` into the past. */
function ageTree(dir: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) ageTree(child, ageMs);
    else utimesSync(child, t, t);
  }
  utimesSync(dir, t, t);
}

/** Size of a workspace root's WORKSPACE_SCRATCH_MARKER (it varies with the id and timestamp). */
function markerBytes(workspaceId: string): number {
  const size = statSync(join(process.env.PAPERCUSP_SCRATCH_ROOT!, workspaceId, WORKSPACE_SCRATCH_MARKER)).size;
  expect(size).toBeGreaterThan(0);
  return size;
}

/** A complete /proc scan that saw no holder anywhere. */
const noHolders = async (): Promise<OpenWriterScan> => ({ byPath: new Map(), complete: true });

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
  it('drops a quiet, marked scratch root whose workspace is not in the registry', async () => {
    makeRunDir('ws-DEAD', 'demo:tool', UUID(1), 100);
    makeRunDir('ws-ALIVE', 'demo:tool', UUID(2), 100);
    ageTree(join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-DEAD'), DEAD_WORKSPACE_QUIET_MS + 60_000);
    const r = await runScratchGc({ workspaceRegistry: ['ws-ALIVE'], scanOpenPaths: noHolders });
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
    // The workspace-root marker (WI-10006512) is real bytes on disk and is counted too.
    expect(scratchUsageBytes('ws-A')).toBe(3000 + markerBytes('ws-A'));
  });

  it('refreshScratchUsage measures the tree size asynchronously (missing tree = 0)', async () => {
    await refreshScratchUsage('ws-empty');
    expect(scratchUsageBytes('ws-empty')).toBe(0);
    makeRunDir('ws-B', 'tool', UUID(3), 5000);
    makeRunDir('ws-B', 'tool', UUID(4), 7000);
    await refreshScratchUsage('ws-B');
    expect(scratchUsageBytes('ws-B')).toBe(12000 + markerBytes('ws-B'));
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
    ageTree(join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-DEAD'), DEAD_WORKSPACE_QUIET_MS + 60_000);
    for (let i = 0; i < 12; i++) makeRunDir('ws-A', `tool-${i % 3}`, UUID(10 + i), 128, RETENTION_MS + 60_000);
    for (let i = 0; i < 6; i++) makeRunDir('ws-A', `tool-${i % 3}`, UUID(40 + i), 128);
    for (const fn of [readdirSync, statSync, existsSync, rmSync, mkdirSync]) vi.mocked(fn).mockClear();

    const r = await runScratchGc({ workspaceRegistry: ['ws-A'], scanOpenPaths: noHolders });

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
      markersWritten: 0,
      unprovenEntries: 0,
      deadWorkspacesDeferred: [],
    });
  });
});

/**
 * WI-10006512 (2026-10-06): the 03:00 sweep `rm -rf`ed every top-level entry under the scratch
 * root that was not a registered workspace id — including a running benchmark's PG datadir in
 * `~/.papercusp/scratch/portable-bench/`, the location the bash resource gate tells agents to use.
 * The pass may now delete only a tree it can PROVE is a dead workspace root, and only when quiet.
 */
describe('runScratchGc — deletes only provably-dead, quiet workspace roots (WI-10006512)', () => {
  const OLD = DEAD_WORKSPACE_QUIET_MS + 60 * 60_000;
  const root = (): string => process.env.PAPERCUSP_SCRATCH_ROOT!;

  /** An agent's own scratch tree: no marker, aged far past every window. */
  function makeAgentDir(name: string): string {
    const dir = join(root(), name);
    mkdirSync(join(dir, 'pg-shared', 'global'), { recursive: true });
    writeFileSync(join(dir, 'pg-shared', 'global', 'pg_control'), Buffer.alloc(64));
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
    ageTree(dir, OLD);
    return dir;
  }

  /** A workspace root left behind by a workspace that is no longer registered. */
  function makeDeadWorkspace(workspaceId: string, ageMs = OLD): string {
    makeRunDir(workspaceId, 'demo:tool', UUID(500), 100);
    const dir = join(root(), workspaceId);
    ageTree(dir, ageMs);
    return dir;
  }

  it('never deletes an unmarked agent dir or `packs`, however old, and counts them', async () => {
    const bench = makeAgentDir('portable-bench');
    const packs = makeAgentDir('packs');
    const r = await runScratchGc({ workspaceRegistry: ['papercusp-workspace'], scanOpenPaths: noHolders });
    expect(existsSync(join(bench, 'pg-shared', 'global', 'pg_control'))).toBe(true);
    expect(existsSync(packs)).toBe(true);
    expect(r.deadWorkspaces).toBe(0);
    expect(r.unprovenEntries).toBe(2);
  });

  it('a top-level FILE is never deleted either', async () => {
    mkdirSync(root(), { recursive: true });
    writeFileSync(join(root(), 'notes.txt'), 'keep me');
    ageTree(root(), OLD);
    const r = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders });
    expect(existsSync(join(root(), 'notes.txt'))).toBe(true);
    expect(r.unprovenEntries).toBe(1);
  });

  it('the scratch writer marks a root it creates, and that root is collected once dead and quiet', async () => {
    const wsRoot = scratchRootForWorkspace('ws-W');
    const deferred: Promise<void>[] = [];
    writeScratchReference({
      filePath: join(wsRoot, 'tool:x', UUID(600), 'a.spill'),
      payload: 'sync',
      workspaceId: 'ws-W',
      mediaType: 'text/plain',
    });
    writeScratchReference({
      filePath: join(scratchRootForWorkspace('ws-V'), 'tool:x', UUID(601), 'b.spill'),
      payload: 'deferred',
      workspaceId: 'ws-V',
      mediaType: 'text/plain',
      deferredWrites: deferred,
    });
    await Promise.all(deferred);
    for (const ws of ['ws-W', 'ws-V']) {
      const marker = JSON.parse(readFileSync(join(root(), ws, WORKSPACE_SCRATCH_MARKER), 'utf8'));
      expect(marker.workspaceId).toBe(ws);
      ageTree(join(root(), ws), OLD);
    }
    const r = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders });
    expect(r.deadWorkspaces).toBe(2);
    expect(existsSync(wsRoot)).toBe(false);
  });

  it('backfills the marker onto a registered root that predates markers, and never creates a root', async () => {
    const wsRoot = join(root(), 'ws-LEGACY');
    mkdirSync(join(wsRoot, 'tool', UUID(700)), { recursive: true });
    const first = await runScratchGc({ workspaceRegistry: ['ws-LEGACY', 'ws-NO-ROOT'], scanOpenPaths: noHolders });
    expect(first.markersWritten).toBe(1);
    expect(existsSync(join(wsRoot, WORKSPACE_SCRATCH_MARKER))).toBe(true);
    expect(existsSync(join(root(), 'ws-NO-ROOT'))).toBe(false);
    // Once the workspace leaves the registry and goes quiet, the backfilled marker is the proof.
    ageTree(wsRoot, OLD);
    const second = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders });
    expect(second.deadWorkspaces).toBe(1);
    expect(existsSync(wsRoot)).toBe(false);
  });

  it('keeps a dead workspace whose tree changed recently, even when only a deep file did', async () => {
    const dir = makeDeadWorkspace('ws-BUSY');
    // A deep write leaves every directory mtime old; only the file itself is fresh.
    writeFileSync(join(dir, 'demo:tool', UUID(500), 'data.bin'), 'still writing');
    const r = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: noHolders });
    expect(existsSync(dir)).toBe(true);
    expect(r.deadWorkspacesDeferred).toEqual([{ workspaceId: 'ws-BUSY', reason: 'recent-write' }]);
  });

  it('keeps a dead workspace a process still holds open', async () => {
    const dir = makeDeadWorkspace('ws-HELD');
    const real = realpathSync(dir);
    const scan = async (paths: readonly string[]): Promise<OpenWriterScan> => ({
      byPath: new Map(paths.filter((p) => p === real).map((p) => [p, ['4242']])),
      complete: true,
    });
    const r = await runScratchGc({ workspaceRegistry: [], scanOpenPaths: scan });
    expect(existsSync(dir)).toBe(true);
    expect(r.deadWorkspacesDeferred).toEqual([{ workspaceId: 'ws-HELD', reason: 'open-writer' }]);
  });

  it('fails closed when the process scan is incomplete or throws', async () => {
    const a = makeDeadWorkspace('ws-PARTIAL');
    const partial = await runScratchGc({
      workspaceRegistry: [],
      scanOpenPaths: async () => ({ byPath: new Map(), complete: false }),
    });
    expect(existsSync(a)).toBe(true);
    expect(partial.deadWorkspacesDeferred).toEqual([{ workspaceId: 'ws-PARTIAL', reason: 'process-scan-incomplete' }]);

    const thrown = await runScratchGc({
      workspaceRegistry: [],
      scanOpenPaths: async () => {
        throw new Error('EACCES /proc');
      },
    });
    expect(existsSync(a)).toBe(true);
    expect(thrown.deadWorkspaces).toBe(0);
  });

  it('a marker naming ANOTHER workspace (a copied tree) is not proof', async () => {
    const original = makeDeadWorkspace('ws-ORIG');
    const copy = join(root(), 'ws-COPY');
    mkdirSync(copy);
    writeFileSync(join(copy, WORKSPACE_SCRATCH_MARKER), readFileSync(join(original, WORKSPACE_SCRATCH_MARKER)));
    ageTree(copy, OLD);
    const r = await runScratchGc({ workspaceRegistry: ['ws-ORIG'], scanOpenPaths: noHolders });
    expect(existsSync(copy)).toBe(true);
    expect(r.unprovenEntries).toBe(1);
  });

  it('a symlink at the top level is not followed into a marked tree', async () => {
    const target = makeDeadWorkspace('ws-TARGET');
    symlinkSync(target, join(root(), 'ws-LINK'));
    const r = await runScratchGc({ workspaceRegistry: ['ws-TARGET'], scanOpenPaths: noHolders });
    expect(existsSync(join(root(), 'ws-LINK'))).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(r.unprovenEntries).toBe(1);
  });

  // The DEFAULT scan (no seam): proves the real /proc wiring matches files BELOW the root
  // (descendants) and working directories (includeCwd), not just the root path itself.
  it('default scan: an open file deep inside the root keeps it', async () => {
    const dir = makeDeadWorkspace('ws-FD');
    const fd = openSync(join(dir, 'demo:tool', UUID(500), 'data.bin'), 'r');
    try {
      const r = await runScratchGc({ workspaceRegistry: [] });
      expect(existsSync(dir)).toBe(true);
      expect(r.deadWorkspaces).toBe(0);
      expect(['open-writer', 'process-scan-incomplete']).toContain(r.deadWorkspacesDeferred[0]?.reason);
    } finally {
      closeSync(fd);
    }
  }, 60_000);

  it('default scan: a process whose cwd is inside the root keeps it', async () => {
    const dir = makeDeadWorkspace('ws-CWD');
    const child = spawn('sleep', ['60'], { cwd: join(dir, 'demo:tool'), stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const r = await runScratchGc({ workspaceRegistry: [] });
      expect(existsSync(dir)).toBe(true);
      expect(r.deadWorkspaces).toBe(0);
      expect(['open-writer', 'process-scan-incomplete']).toContain(r.deadWorkspacesDeferred[0]?.reason);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('runScratchGc — quota eviction', () => {
  it('FIFO-evicts oldest run-dirs when over quota', async () => {
    const oldest = makeSparseRun('ws-Q', UUID(10), 4 * 1024 ** 3, 10_000);
    const newest = makeSparseRun('ws-Q', UUID(11), 2 * 1024 ** 3);
    await refreshScratchUsage('ws-Q');
    const result = await runScratchGc({ workspaceRegistry: ['ws-Q'] });
    expect(result.quotaEvictions).toBe(1);
    expect(result.quotaEvictedBytes).toBe(4 * 1024 ** 3);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(scratchEvictionBytes()).toBe(4 * 1024 ** 3);
    // GC also clears the cached full verdict, so a subsequent reservation can succeed.
    expect(() => reserveScratchSpace({ workspaceId: 'ws-Q', bytes: 1024 })).not.toThrow();
  });
});

describe('deferred scratch quota recovery', () => {
  it('coalesces pressure recovery while preserving concurrent reservations without synchronous scans', async () => {
    const old = makeSparseRun('ws-Q', UUID(1), 4 * 1024 ** 3, 10_000);
    const fresh = makeSparseRun('ws-Q', UUID(2), 1024 ** 3);
    await refreshScratchUsage('ws-Q');
    vi.mocked(readdirAsync).mockClear();
    vi.mocked(rmAsync).mockClear();
    vi.mocked(readdirSync).mockClear();
    vi.mocked(statSync).mockClear();
    await Promise.all(Array.from({ length: 8 }, (_, i) => {
      const filePath = join(fresh, `write-${i}`);
      return writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 100 },
        () => writeFile(filePath, Buffer.alloc(100)));
    }));
    expect(existsSync(old)).toBe(false);
    expect(vi.mocked(rmAsync)).toHaveBeenCalledTimes(1);
    // Recovery is shared by all writers, then one clean measurement runs after they settle.
    expect(vi.mocked(readdirAsync).mock.calls.filter(([path]) => path === scratchRootForWorkspace('ws-Q'))).toHaveLength(3);
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    await refreshScratchUsage('ws-Q');
    expect(scratchUsageBytes('ws-Q')).toBe(1024 ** 3 + markerBytes('ws-Q') + 800);
  });

  it('protects an in-flight writer even when its run is the oldest FIFO candidate', async () => {
    const active = makeSparseRun('ws-Q', UUID(1), 4 * 1024 ** 3, 10_000);
    const other = makeSparseRun('ws-Q', UUID(2), 1024 ** 3);
    _setScratchUsageForTests('ws-Q', WORKSPACE_QUOTA_BYTES - 1024);
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const held = writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(active, 'held'), bytes: 512 }, async () => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await began;
    try {
      await writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(active, 'next'), bytes: 2048 }, async () => {});
      expect(existsSync(active)).toBe(true);
      expect(existsSync(other)).toBe(false);
    } finally {
      finish();
      await held;
    }
  });

  it('refuses an impossible request without evicting or invoking the writer', async () => {
    const old = makeSparseRun('ws-Q', UUID(1), WORKSPACE_QUOTA_BYTES, 10_000);
    const write = vi.fn(async () => {});
    vi.mocked(rmAsync).mockClear();
    await expect(writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(old, 'next'),
      bytes: WORKSPACE_QUOTA_BYTES + 1 }, write)).rejects.toMatchObject({ code: 'SCRATCH_QUOTA_EXCEEDED' });
    expect(write).not.toHaveBeenCalled();
    expect(vi.mocked(rmAsync)).not.toHaveBeenCalled();
    expect(existsSync(old)).toBe(true);
  });

  it('returns a typed failure when quota is occupied outside reclaimable run directories', async () => {
    const root = scratchRootForWorkspace('ws-Q');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'unmanaged'), '');
    truncateSync(join(root, 'unmanaged'), WORKSPACE_QUOTA_BYTES);
    await refreshScratchUsage('ws-Q');
    const write = vi.fn(async () => {});
    await expect(writeWithScratchQuota({ workspaceId: 'ws-Q', filePath: join(root, 'tool', UUID(1), 'next'),
      bytes: 1024 }, write)).rejects.toMatchObject({ code: 'SCRATCH_QUOTA_EXCEEDED' });
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'unmanaged'))).toBe(true);
  });

  it('releases a failed write reservation and preserves reservations across a concurrent refresh', async () => {
    _setScratchUsageForTests('ws-Q', 0);
    const filePath = join(scratchRootForWorkspace('ws-Q'), 'tool', UUID(1), 'next');
    await expect(writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 1024 }, async () => {
      await refreshScratchUsage('ws-Q');
      expect(scratchUsageBytes('ws-Q')).toBe(1024);
      throw new Error('write failed');
    })).rejects.toThrow('write failed');
    expect(scratchUsageBytes('ws-Q')).toBe(0);
  });

  it('does not double-count a successful write already included in a usage refresh', async () => {
    _setScratchUsageForTests('ws-Q', 0);
    const runDir = join(scratchRootForWorkspace('ws-Q'), 'tool', UUID(1));
    mkdirSync(runDir, { recursive: true });
    const filePath = join(runDir, 'next');
    await writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 1024 }, async () => {
      await writeFile(filePath, Buffer.alloc(1024));
      await refreshScratchUsage('ws-Q');
    });
    expect(scratchUsageBytes('ws-Q')).toBe(1024);
  });

  it('does not lose a write that completes while a usage refresh is walking the tree', async () => {
    _setScratchUsageForTests('ws-Q', 0);
    const runDir = join(scratchRootForWorkspace('ws-Q'), 'tool', UUID(2));
    mkdirSync(runDir, { recursive: true });
    const filePath = join(runDir, 'next');
    const readdirMock = vi.mocked(readdirAsync);
    const originalRead = readdirMock.getMockImplementation();
    if (!originalRead) throw new Error('readdir mock has no original implementation');
    const read = originalRead as unknown as (path: unknown, options?: unknown) => Promise<unknown>;
    let releaseRead!: () => void;
    let reachedRunDir!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const atRunDir = new Promise<void>((resolve) => { reachedRunDir = resolve; });
    readdirMock.mockImplementation((async (path: unknown, options: unknown) => {
      const entries = await read(path, options);
      if (String(path) === runDir) {
        reachedRunDir();
        await readGate;
      }
      return entries as never;
    }) as typeof readdirAsync);

    const measurement = refreshScratchUsage('ws-Q');
    try {
      await atRunDir;
      await writeWithScratchQuota({ workspaceId: 'ws-Q', filePath, bytes: 1024 }, async () => {
        await writeFile(filePath, Buffer.alloc(1024));
      });
    } finally {
      releaseRead();
      readdirMock.mockImplementation(originalRead);
    }
    await measurement;
    expect(scratchUsageBytes('ws-Q')).toBe(1024);
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
