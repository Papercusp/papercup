import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Governor, type AdmissionContext } from '../../resource-governor/admission';
import { MemoryAdmissionQueueStore } from '../../resource-governor/memory-admission-queue-store';
import { WorkItemAdmissionQueueDriver } from '../../resource-governor/queue';
import { admissionContextFromEnvironment, beginGovernedExecution, governedExecutionLeaseTtlForTimeout,
  withGovernedExecution, type GovernedOperationInput } from '../../resource-governor/execution';

const ports = vi.hoisted(() => ({
  fork: vi.fn(), spawn: vi.fn(), capture: vi.fn(), symlink: vi.fn(), rm: vi.fn(), writeFile: vi.fn(),
  attach: vi.fn(), stop: vi.fn(), executionApi: {} as Record<string, unknown>,
}));
vi.mock('node:child_process', async original => ({ ...await original<object>(), fork: ports.fork, spawn: ports.spawn }));
vi.mock('node:fs/promises', async original => ({ ...await original<object>(),
  symlink: ports.symlink, rm: ports.rm, writeFile: ports.writeFile }));
vi.mock('../../agent-mcp-client', () => ({ connectAgentMcp: vi.fn() }));
vi.mock('../../../test/isolated-integration-proof', () => ({
  captureIsolatedWorker: ports.capture,
  isolatedTestFileWorkerOptions: () => ({ timeoutMs: 1000, testTimeoutMs: 1000 }),
  isolatedWorkerReceipt: (output: string, prefix: string) =>
    output.split('\n').find(line => line.startsWith(prefix + ' '))?.slice(prefix.length + 1),
}));
vi.mock('../../../test/private-http-workspace-preflight', () => ({
  preparePrivateOperatorApiBundle: async () => ({ sha256: 'prepared-source', receiptSha256: 'prepared-receipt' }),
  privateMcpSourceSha: () => 'prepared-source',
  privateBundleRuntimeEnv: (env: NodeJS.ProcessEnv) => ({ ...env, NODE_OPTIONS: '' }),
  assertPrivateMcpSourceIdentity: vi.fn(), resolvePreparedPrivateApiBundle: vi.fn(),
  resolvePreparedPrivateApiSourceSha: vi.fn(), stopPrivateOperatorHost: vi.fn(), waitForPrivateOperator: vi.fn(),
}));
vi.mock('../../../../../scripts/lib/governed-test-process.mjs', async original => {
  const actual = await original<typeof import('../../../../../scripts/lib/governed-test-process.mjs')>();
  return { ...actual,
    createGovernedProcessDemandSampler: () => ({ attach: ports.attach, stop: ports.stop }),
    // Real bridge and receipt lifecycle, with the maintained hermetic store.
    runGovernedTestProcess: (options: Record<string, unknown>, run: unknown) =>
      actual.runGovernedTestProcess({ ...options, executionApi: ports.executionApi }, run),
  };
});
import { managedCapabilityApiProofOptions } from './_managed-capability-api-proof';
import { startManagedApiHost } from './__fixtures__/managed-api-client.mts';

const actualDemand = { cpuWeight: 0.4, memoryBytes: 123456, diskBytes: 789, fileDescriptors: 9 };
const filePath = 'packages/operator-core/lib/agent-tools/capability/managed-capability-api.integration.test.ts';
const child = { pid: 43210 } as ChildProcess;
const host = { pid: 43211 } as ChildProcess;
const success = { code: 0, signal: null, output: [
  'MANAGED_API_CLEANUP ' + JSON.stringify({ rows: 1, processes: 'gone', browserRoots: 'gone', terminalRecorded: true }),
  'MANAGED_API_PROOF ' + JSON.stringify({ transport: 'http', kernel: 'retained-across-clients',
    browser: 'retained-across-clients', image: 'original-raster', patch: 'canonical-peer-lock-and-all-hunks',
    pty: 'refused-without-private-session-bus', foreignHandles: 'refused' }),
].join('\n') };

function governor() {
  const store = new MemoryAdmissionQueueStore();
  const driver = new WorkItemAdmissionQueueDriver(store, { namespace: 'managed-proof-test' });
  const deps = { driver, governor: new Governor(driver) };
  const runGovernedOperation = vi.fn((input: GovernedOperationInput, run: (context: AdmissionContext) => Promise<unknown>) =>
    withGovernedExecution({ idempotencyKey: input.idempotencyKey!, admissionClass: input.admissionClass,
      demand: input.demand, payloadRef: input.payloadRef }, input, deps, run));
  ports.executionApi = { admissionContextFromEnvironment, governedExecutionLeaseTtlForTimeout, runGovernedOperation };
  return { ...deps, store, runGovernedOperation };
}
async function execute() {
  const proof = managedCapabilityApiProofOptions(filePath);
  await proof.prepare!('/private-proof');
  await proof.execute!(vi.fn(), '/private-proof');
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'test-runtime-managed-admission');
  vi.stubEnv('PAPERCUSP_ADMISSION_CONTEXT', '');
  ports.fork.mockReturnValue(child); ports.spawn.mockReturnValue(host);
  ports.capture.mockResolvedValue(success); ports.stop.mockReturnValue(actualDemand);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('managed API proof admission', () => {
  it('waits for admission, forwards the receipt to both children, and exact-releases after capture', async () => {
    const d = governor();
    let admit!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const enqueue = d.store.enqueue.bind(d.store);
    vi.spyOn(d.store, 'enqueue').mockImplementation(async record => { await admitted; return enqueue(record); });
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    ports.capture.mockImplementation(async () => {
      expect(startManagedApiHost('/prepared-api.mjs', ports.fork.mock.calls[0][2].env).host).toBe(host);
      await finished; return success;
    });
    const pending = execute();
    await vi.waitFor(() => expect(d.runGovernedOperation).toHaveBeenCalledOnce());
    expect(ports.fork).not.toHaveBeenCalled();
    admit();
    await vi.waitFor(() => expect(ports.capture).toHaveBeenCalledOnce());
    const [{ receiptId, record }] = d.store.records();
    expect(record.state).toBe('running');
    const context = JSON.parse(ports.fork.mock.calls[0][2].env.PAPERCUSP_ADMISSION_CONTEXT);
    expect(context).toMatchObject({ receiptId, leaseId: record.lease!.leaseId });
    expect(JSON.parse(ports.spawn.mock.calls[0][2].env.PAPERCUSP_ADMISSION_CONTEXT)).toEqual(context);
    expect(ports.attach).toHaveBeenCalledExactlyOnceWith(child.pid);
    expect(ports.stop).not.toHaveBeenCalled();
    finish(); await pending;
    expect(d.store.records()).toHaveLength(1);
    expect(d.store.records()[0].record).toMatchObject({ state: 'completed', actualDemand, lease: undefined });
    expect(ports.rm).toHaveBeenCalledWith('/private-proof/node_modules');
    expect(ports.writeFile).toHaveBeenCalledWith('/private-proof/managed-api-proof.json', expect.any(String));
  });
  it('inherits the parent without a second receipt or premature release', async () => {
    const d = governor();
    const parent = await beginGovernedExecution({ idempotencyKey: 'parent', admissionClass: 'process' },
      { owner: 'parent-test-file' }, d);
    vi.stubEnv('PAPERCUSP_ADMISSION_CONTEXT', JSON.stringify(parent.context));
    await execute();
    expect(d.runGovernedOperation).not.toHaveBeenCalled();
    expect(d.store.size).toBe(1);
    expect(d.store.records()[0].record.state).toBe('running');
    expect(JSON.parse(ports.fork.mock.calls[0][2].env.PAPERCUSP_ADMISSION_CONTEXT)).toEqual(parent.context);
    await parent.finish(actualDemand);
    expect(d.store.records()[0].record).toMatchObject({ state: 'completed', actualDemand });
  });
  it('does not fork on admission failure and removes the evidence symlink', async () => {
    const d = governor(); d.store.fail = true;
    await expect(execute()).rejects.toThrow();
    expect(ports.fork).not.toHaveBeenCalled(); expect(ports.capture).not.toHaveBeenCalled();
    expect(ports.rm).toHaveBeenCalledWith('/private-proof/node_modules');
    expect(ports.stop).toHaveBeenCalled();
  });
  it('cancels the same receipt on a synchronous fork failure', async () => {
    const d = governor();
    ports.fork.mockImplementationOnce(() => { throw new Error('fork failed'); });
    await expect(execute()).rejects.toThrow('fork failed');
    expect(d.store.records()).toHaveLength(1);
    expect(d.store.records()[0].record).toMatchObject({ state: 'cancelled', lease: undefined });
    expect(ports.capture).not.toHaveBeenCalled();
  });
  it.each([
    { code: 1, signal: null, output: 'assertion failed', expected: 'completed' },
    { code: null, signal: 'SIGTERM', output: 'watchdog terminated worker', expected: 'cancelled' },
  ])('preserves the $expected lifecycle for failed results', async ({ expected, ...result }) => {
    const d = governor(); ports.capture.mockResolvedValueOnce(result);
    await expect(execute()).rejects.toThrow();
    expect(d.store.records()).toHaveLength(1);
    expect(d.store.records()[0].record).toMatchObject({ state: expected, lease: undefined,
      ...(expected === 'completed' ? { actualDemand } : {}) });
    expect(ports.writeFile).not.toHaveBeenCalled();
  });
});
describe('private managed API host boundary', () => {
  it.each([undefined, '{', '{}', JSON.stringify({ contractVersion: 1 })])(
    'refuses missing or malformed context before spawn (%s)', context => {
      expect(() => startManagedApiHost('/prepared-api.mjs', { PAPERCUSP_ADMISSION_CONTEXT: context }))
        .toThrow('admitted parent receipt and lease');
      expect(ports.spawn).not.toHaveBeenCalled();
    });
  it('requires receipt and lease, preserving the valid parent exactly', async () => {
    const d = governor();
    const parent = await beginGovernedExecution({ idempotencyKey: 'host-parent', admissionClass: 'process' },
      { owner: 'parent-test-file' }, d);
    for (const missing of ['receiptId', 'leaseId']) {
      const broken = { ...parent.context, [missing]: undefined };
      expect(() => startManagedApiHost('/prepared-api.mjs', { PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(broken) }))
        .toThrow('admitted parent receipt and lease');
    }
    expect(ports.spawn).not.toHaveBeenCalled();
    const result = startManagedApiHost('/prepared-api.mjs', {
      PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(parent.context), PRIVATE_CONTROL: 'preserved',
    });
    expect(result.hostEnv.PRIVATE_CONTROL).toBe('preserved');
    expect(JSON.parse(result.hostEnv.PAPERCUSP_ADMISSION_CONTEXT!)).toEqual(parent.context);
    expect(ports.spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, ['/prepared-api.mjs'],
      { env: result.hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(d.store.records()[0].record.state).toBe('running');
    await parent.finish(actualDemand);
  });
});
