import { describe, expect, it, vi } from 'vitest';

// The bridge is intentionally a plain-Node `.mjs` module so both repository
// test CLIs remain executable with `node scripts/*.mjs`.
import {
  buildGovernedProcessDemand,
  classifyGovernedTestProcessOutcome,
  createGovernedProcessDemandSampler,
  governedProcessIdempotencyKey,
  runGovernedTestProcess,
  GOVERNED_TEST_PROCESS_DEFAULT_DISK_BYTES,
  GOVERNED_TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS,
  GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES,
} from '../../../../scripts/lib/governed-test-process.mjs';

const context = {
  contractVersion: 1,
  requestId: 'request-1',
  rootRequestId: 'request-1',
  parentRequestId: null,
  receiptId: 'WI-TEST-1',
  parentReceiptId: null,
  idempotencyKey: 'test-process-1',
  admissionClass: 'process',
  priority: 0,
  demand: { cpuWeight: 1 },
  depth: 0,
  createdAtMs: 1,
  decisionGeneration: 1,
  leaseId: 'lease-1',
};

describe('governed test-process bridge', () => {
  it('builds a bounded process reservation and stable idempotency key', () => {
    expect(buildGovernedProcessDemand({ fileCount: 3 })).toEqual({
      cpuWeight: 1,
      memoryBytes: 1024 * 1024 * 1024,
      diskBytes: 256 * 1024 * 1024,
      fileDescriptors: 19,
    });
    const first = governedProcessIdempotencyKey('affected tests', 'run-1');
    expect(first).toBe(governedProcessIdempotencyKey('affected tests', 'run-1'));
    expect(first).toMatch(/^test-process:affected_tests:[0-9a-f]{40}$/);
    expect(first.length).toBeLessThanOrEqual(200);
  });

  it('records peak resource observations and keeps stop idempotent', () => {
    let now = 1_000;
    let snapshot = { cpuMicros: 100, rssBytes: 10, fileDescriptors: 4 };
    const sampler = createGovernedProcessDemandSampler(
      buildGovernedProcessDemand(),
      { readSnapshot: () => snapshot, now: () => now, intervalMs: 60_000 },
    );
    sampler.attach(42);
    now = 2_000;
    snapshot = { cpuMicros: 1_500_100, rssBytes: 30, fileDescriptors: 8 };
    sampler.sample();
    now = 3_000;
    snapshot = { cpuMicros: 3_000_100, rssBytes: 20, fileDescriptors: 6 };
    expect(sampler.stop({ diskBytes: 123 })).toEqual({
      cpuWeight: 1.5,
      memoryBytes: 30,
      diskBytes: 123,
      fileDescriptors: 8,
    });
    expect(sampler.stop({ diskBytes: 999 })).toEqual({
      cpuWeight: 1.5,
      memoryBytes: 30,
      diskBytes: 123,
      fileDescriptors: 8,
    });
  });

  it('cancels undetermined starts and releases measured real exits', () => {
    expect(classifyGovernedTestProcessOutcome({
      code: null,
      signal: 'SIGKILL',
      timedOut: true,
      output: '',
    })).toMatchObject({ kind: 'cancel' });
    expect(classifyGovernedTestProcessOutcome({
      code: 2,
      signal: null,
      output: 'TEST_FILE_ROUTE_ERROR requested=1 matched=0',
    })).toMatchObject({ kind: 'cancel' });
    expect(classifyGovernedTestProcessOutcome({
      code: 1,
      signal: null,
      output: 'Tests 1 failed',
      actualDemand: { memoryBytes: 7 },
    })).toEqual({ kind: 'release', actualDemand: { memoryBytes: 7 } });
  });

  it('reuses a valid inherited context without creating a second receipt', async () => {
    const runGovernedOperation = vi.fn();
    const executionApi = {
      admissionContextFromEnvironment: vi.fn((value: string | undefined) => value ? context : undefined),
      governedExecutionLeaseTtlForTimeout: vi.fn(() => 1234),
      runGovernedOperation,
    };
    const inheritedEnv = { PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(context) };
    const result = await runGovernedTestProcess(
      { executionApi, workspaceId: 'ws', env: inheritedEnv, owner: 'runner', timeoutMs: 100 },
      async (received: typeof context, childEnv: Record<string, string>, info: { inherited: boolean }) => ({
        received,
        childEnv,
        info,
      }),
    );
    expect(result.info.inherited).toBe(true);
    expect(result.received).toEqual(context);
    expect(JSON.parse(result.childEnv.PAPERCUSP_ADMISSION_CONTEXT)).toEqual(context);
    expect(runGovernedOperation).not.toHaveBeenCalled();
  });

  it('admits direct starts with a timeout-derived lease and forwards the new context', async () => {
    const runGovernedOperation = vi.fn(async (_input: unknown, run: (ctx: typeof context) => Promise<unknown>) => run(context));
    const executionApi = {
      admissionContextFromEnvironment: vi.fn(() => undefined),
      governedExecutionLeaseTtlForTimeout: vi.fn(() => 4567),
      runGovernedOperation,
    };
    const result = await runGovernedTestProcess(
      {
        executionApi,
        workspaceId: 'ws',
        env: {},
        owner: 'runner',
        timeoutMs: 1000,
        demand: { cpuWeight: 1 },
        idempotencyKey: 'explicit-key',
        settle: () => ({ kind: 'release' }),
      },
      async (_received: typeof context, childEnv: Record<string, string>, info: { inherited: boolean }) => ({
        childEnv,
        info,
      }),
    );
    const [input] = runGovernedOperation.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).toMatchObject({
      workspaceId: 'ws',
      namespace: 'test-process',
      owner: 'runner',
      idempotencyKey: 'explicit-key',
      leaseTtlMs: 4567,
      // WI-638180: every caller of this bridge is a one-shot CLI. Without this
      // flag the admission runs on the process-wide `getOrgPg()` pool, which no
      // library may close — the runner then finishes all of its work and hangs
      // forever on two idle PgBouncer sockets, which a supervisor reads as a
      // wedged test run rather than a completed one.
      dedicatedClient: true,
    });
    expect(result.info.inherited).toBe(false);
    expect(JSON.parse(result.childEnv.PAPERCUSP_ADMISSION_CONTEXT)).toEqual(context);
  });

  it('lets a long-lived embedder opt back onto the shared pool (WI-638180)', async () => {
    // The default is the safe one, so the escape hatch needs its own coverage:
    // an in-process host must be able to keep the shared pool it already owns.
    const runGovernedOperation = vi.fn(async (_input: unknown, run: (ctx: typeof context) => Promise<unknown>) => run(context));
    await runGovernedTestProcess(
      {
        executionApi: {
          admissionContextFromEnvironment: vi.fn(() => undefined),
          governedExecutionLeaseTtlForTimeout: vi.fn(() => 1000),
          runGovernedOperation,
        },
        workspaceId: 'ws',
        env: {},
        owner: 'embedded-runner',
        dedicatedClient: false,
      },
      async () => 'ok',
    );
    const [input] = runGovernedOperation.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input.dedicatedClient).toBe(false);
  });
});

// P-006 regression coverage (plan nonblocking-test-materializer-2026-08-28).
//
// The bridge's job is to decide whether a child produced a TRUSTWORTHY verdict.
// `release` teaches the governor a measured demand and settles the receipt as a
// real run; `cancel` says the run proved nothing. Every shape below is one the
// classifier could otherwise settle as a successful release having measured
// nothing — the false green this plan exists to make impossible.

describe('demand construction', () => {
  it('scales the descriptor reservation with the file count, and clamps it', () => {
    expect(buildGovernedProcessDemand({ fileCount: 1 }).fileDescriptors).toBe(17);
    expect(buildGovernedProcessDemand({ fileCount: 8 }).fileDescriptors).toBe(24);
    // A fractional or negative count must never reserve a fractional/absurd budget.
    expect(buildGovernedProcessDemand({ fileCount: 3.9 }).fileDescriptors).toBe(19);
    expect(buildGovernedProcessDemand({ fileCount: -5 }).fileDescriptors).toBe(17);
  });

  it('honours explicit positive overrides', () => {
    expect(
      buildGovernedProcessDemand({ cpuWeight: 2.5, memoryBytes: 5000, diskBytes: 6000, fileDescriptors: 7 }),
    ).toEqual({ cpuWeight: 2.5, memoryBytes: 5000, diskBytes: 6000, fileDescriptors: 7 });
  });

  it('falls back to bounded defaults for zero, negative, and non-finite input', () => {
    const defaults = {
      cpuWeight: 1,
      memoryBytes: GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES,
      diskBytes: GOVERNED_TEST_PROCESS_DEFAULT_DISK_BYTES,
      fileDescriptors: GOVERNED_TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS + 1,
    };
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        buildGovernedProcessDemand({ memoryBytes: bad, diskBytes: bad, fileDescriptors: bad, cpuWeight: -1 }),
      ).toEqual(defaults);
    }
  });

  it('permits a deliberate zero cpu weight while still flooring the byte reservations', () => {
    // The asymmetry is intentional: a zero-cpu reservation is meaningful, a
    // zero-memory one is a missing value.
    expect(buildGovernedProcessDemand({ cpuWeight: 0 }).cpuWeight).toBe(0);
    expect(buildGovernedProcessDemand({ memoryBytes: 0 }).memoryBytes).toBe(
      GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES,
    );
  });
});

describe('worker-exit classification', () => {
  // One case per token in the untrustworthy-output pattern, so removing a token
  // fails HERE rather than silently widening `release`. Each carries code 0 —
  // the false-green shape, where the child claims success while its own output
  // says no verdict was produced.
  const untrustworthyOutput: [string, string][] = [
    ['a crashed vitest worker', 'Worker exited unexpectedly'],
    ['a watchdog marker', 'TEST_FILE_WATCHDOG fired after 120s'],
    ['a route error', 'TEST_FILE_ROUTE_ERROR requested=3 matched=0'],
    ['a cgroup task ceiling', 'fork failed: TasksMax limit reached'],
    ['a termination signal named in output', 'child received SIGTERM'],
    ['a kill signal named in output', 'runner sent SIGKILL to the pool'],
  ];

  it.each(untrustworthyOutput)('refuses to release after %s', (_label, text) => {
    expect(classifyGovernedTestProcessOutcome({ code: 0, signal: null, stderr: text })).toMatchObject({
      kind: 'cancel',
    });
  });

  it('scans stdout, stderr, and the combined output field alike', () => {
    for (const key of ['stdout', 'stderr', 'output']) {
      expect(
        classifyGovernedTestProcessOutcome({ code: 0, signal: null, [key]: 'Worker exited unexpectedly' }),
      ).toMatchObject({ kind: 'cancel' });
    }
  });
});

describe('no false green', () => {
  // CALIBRATION — without this, every assertion below would still pass if the
  // classifier degenerated into always-cancel, which would prove nothing.
  it('does release a clean, trustworthy exit', () => {
    expect(
      classifyGovernedTestProcessOutcome({
        code: 0,
        signal: null,
        stdout: 'Test Files  1 passed (1)',
        actualDemand: { memoryBytes: 3 },
      }),
    ).toEqual({ kind: 'release', actualDemand: { memoryBytes: 3 } });
  });

  const untrustworthy: [string, Record<string, unknown>][] = [
    ['a success code delivered alongside a kill signal', { code: 0, signal: 'SIGKILL' }],
    ['a spawnSync status of 0 that was still signalled', { status: 0, signal: 'SIGTERM' }],
    ['no exit code at all', { code: null, signal: null }],
    ['a watchdog timeout carrying a success code', { code: 0, signal: null, timedOut: true }],
    ['the internal watchdog flag', { code: 0, signal: null, __watchdogTimedOut: true }],
    ['the public watchdog flag', { code: 0, signal: null, watchdogTimedOut: true }],
    ['an abort before any verdict', { code: 0, signal: null, aborted: true }],
    ['a spawn failure', { code: 0, signal: null, spawnError: 'ENOENT' }],
    ['the internal spawn-failure field', { code: 0, signal: null, __spawnError: 'EACCES' }],
    ['a start failure that produced no output', { code: null, error: new Error('boom') }],
  ];

  it.each(untrustworthy)('never settles %s as a release', (_label, outcome) => {
    expect(classifyGovernedTestProcessOutcome(outcome).kind).toBe('cancel');
  });

  it('carries no measured demand on a refusal, so a cancelled run cannot teach the governor', () => {
    const settled = classifyGovernedTestProcessOutcome({
      code: 0,
      signal: 'SIGKILL',
      actualDemand: { memoryBytes: 999 },
    });
    expect(settled.kind).toBe('cancel');
    expect(settled.actualDemand).toBeUndefined();
  });
});

describe('receipt lifecycle and demand accounting', () => {
  it('refuses a malformed invocation instead of starting an ungoverned child', async () => {
    await expect(runGovernedTestProcess(null, async () => 'ran')).rejects.toThrow(/options are required/);
    await expect(runGovernedTestProcess({}, undefined)).rejects.toThrow(/callback is required/);
  });

  it('falls back to the planned reservation when nothing could be measured', () => {
    const planned = buildGovernedProcessDemand({ fileCount: 2 });
    const sampler = createGovernedProcessDemandSampler(planned, {
      readSnapshot: () => ({ cpuMicros: null, rssBytes: null, fileDescriptors: null }),
      now: () => 1,
      intervalMs: 60_000,
    });
    sampler.attach(7);
    expect(sampler.stop()).toEqual(planned);
  });

  it('stays fail-soft when a procfs read throws or the pid is invalid', () => {
    const planned = buildGovernedProcessDemand();
    const sampler = createGovernedProcessDemandSampler(planned, {
      readSnapshot: () => {
        throw new Error('procfs vanished');
      },
      now: () => 1,
      intervalMs: 60_000,
    });
    sampler.attach(0);
    expect(() => sampler.sample()).not.toThrow();
    expect(sampler.stop()).toEqual(planned);
  });
});
