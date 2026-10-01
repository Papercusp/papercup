import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn, SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPerformanceChild } from './sidecar-performance';
import { measurementManifestFixture } from './fixtures/measurement-manifest';
import { Governor, type AdmissionContext } from '../../resource-governor/admission';
import { withGovernedExecution, type runGovernedOperation } from '../../resource-governor/execution';
import { MemoryAdmissionQueueStore } from '../../resource-governor/memory-admission-queue-store';
import { WorkItemAdmissionQueueDriver } from '../../resource-governor/queue';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-admission-')); dirs.push(dir);
  const manifest = measurementManifestFixture(dir), cell = manifest.cells[0], arm = manifest.arms[0];
  const input = { manifest, cell, arm, manifestSha256: 'a'.repeat(64), manifestFile: path.join(dir, 'manifest.json'),
    mdenseonModel: dir, rawOutput: path.join(dir, 'out.json'), logFd: 1 };
  const child = new EventEmitter() as ChildProcess;
  const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
  const context: AdmissionContext = { contractVersion: 1, requestId: 'child-request', rootRequestId: 'root-request',
    parentRequestId: 'parent-request', receiptId: 'RG-child', parentReceiptId: 'RG-parent', idempotencyKey: 'child',
    admissionClass: 'embedding', priority: 0, demand: {}, depth: 1, createdAtMs: 1, decisionGeneration: 1 };
  const writeReceipt = () => fs.writeFileSync(input.rawOutput, JSON.stringify({ ownerId: manifest.ownerId,
    manifestSha256: input.manifestSha256, cellId: cell.id, armId: arm.id, report: { resource: { peakRssMiB: 3.5 } } }));
  const store = new MemoryAdmissionQueueStore();
  const driver = new WorkItemAdmissionQueueDriver(store, { namespace: 'embedding-performance' });
  const governor = new Governor(driver);
  const governedOperation: typeof runGovernedOperation = (options, run) => withGovernedExecution({
    idempotencyKey: options.idempotencyKey!, admissionClass: options.admissionClass, parent: options.parent,
    demand: options.demand, payloadRef: options.payloadRef, metadata: options.metadata,
  }, { owner: options.owner, measureActualDemand: options.measureActualDemand }, { governor, driver }, run);
  const current = async () => (await store.find('embedding-performance', `embedding-performance:${input.manifestSha256}:${cell.id}`))?.record;
  return { input, child, spawnProcess, context, writeReceipt, store, governedOperation, current };
}
describe('fresh performance child admission', () => {
  it('admits before spawn, propagates lineage and holds the operation until child exit with actual RSS', async () => {
    const f = fixture(); vi.stubEnv('PAPERCUSP_ADMISSION_CONTEXT', JSON.stringify(f.context));
    let admit!: () => void;
    const gate = new Promise<void>((resolve) => { admit = resolve; });
    let requested = false;
    const governedOperation: typeof runGovernedOperation = async (input, run) => {
      expect(input.parent).toEqual(f.context);
      expect(input.dedicatedClient).toBe(true);
      expect(input.demand?.memoryBytes).toBeGreaterThan(0);
      requested = true;
      await gate;
      return f.governedOperation(input, run);
    };
    const done = runPerformanceChild(f.input, { governedOperation, spawnProcess: f.spawnProcess, workspaceId: 'test' });
    await vi.waitFor(() => expect(requested).toBe(true));
    expect(f.spawnProcess).not.toHaveBeenCalled();
    admit();
    await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledOnce());
    expect((await f.current())?.state).toBe('running');
    const env = (vi.mocked(f.spawnProcess).mock.calls[0][2] as SpawnOptions).env!;
    expect(env.PAPERCUSP_FORBID_REAL_PG).toBe('1');
    expect(JSON.parse(env.PAPERCUSP_ADMISSION_CONTEXT!)).toMatchObject({ rootRequestId: f.context.rootRequestId,
      parentRequestId: f.context.requestId, receiptId: expect.any(String), leaseId: expect.any(String) });
    f.writeReceipt(); f.child.emit('exit', 0);
    await expect(done).resolves.toBe(0);
    expect(await f.current()).toMatchObject({ state: 'completed',
      actualDemand: { cpuWeight: f.input.arm.execution.intraOpThreads, memoryBytes: 3.5 * 1024 * 1024 } });
  });
  it('never starts a model child when durable admission refuses', async () => {
    const f = fixture();
    f.store.fail = true;
    await expect(runPerformanceChild(f.input, { governedOperation: f.governedOperation, spawnProcess: f.spawnProcess, workspaceId: 'test' }))
      .rejects.toThrow();
    expect(f.spawnProcess).not.toHaveBeenCalled();
    expect(await f.current()).toBeUndefined();
  });
  it.each(['spawn', 'exit'] as const)('keeps %s failure inside the governed cancellation boundary', async (failure) => {
    const f = fixture();
    const done = runPerformanceChild(f.input, { governedOperation: f.governedOperation, spawnProcess: f.spawnProcess, workspaceId: 'test' });
    const rejected = expect(done).rejects.toThrow(failure === 'spawn' ? 'spawn failed' : 'exit 7');
    await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledOnce());
    if (failure === 'spawn') f.child.emit('error', new Error('spawn failed'));
    else f.child.emit('exit', 7);
    await rejected;
    expect((await f.current())?.state).toBe('cancelled');
  });
  it('cancels a successful child whose resource receipt belongs to another cell', async () => {
    const f = fixture();
    const done = runPerformanceChild(f.input, { governedOperation: f.governedOperation, spawnProcess: f.spawnProcess, workspaceId: 'test' });
    const rejected = expect(done).rejects.toThrow('resource receipt');
    await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledOnce());
    f.writeReceipt();
    const receipt = JSON.parse(fs.readFileSync(f.input.rawOutput, 'utf8')); receipt.cellId = 'another-cell';
    fs.writeFileSync(f.input.rawOutput, JSON.stringify(receipt)); f.child.emit('exit', 0);
    await rejected;
    expect((await f.current())?.state).toBe('cancelled');
  });
});
