import { describe, expect, it, vi } from 'vitest';

// The bridge is intentionally a plain-Node `.mjs` module so both repository
// test CLIs remain executable with `node scripts/*.mjs`.
import {
  buildGovernedProcessDemand,
  classifyGovernedTestProcessOutcome,
  createGovernedProcessDemandSampler,
  governedProcessIdempotencyKey,
  runGovernedTestProcess,
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
    });
    expect(result.info.inherited).toBe(false);
    expect(JSON.parse(result.childEnv.PAPERCUSP_ADMISSION_CONTEXT)).toEqual(context);
  });
});
