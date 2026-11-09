import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import { BENCH_PRIVATE_FIXTURE_TOOL, benchFixtureAllocationSha256, freezeBenchFixtureReadBoundary,
  type BenchFixtureAllocation } from '../../external-bench/private-fixture-reads';

const mocks = vi.hoisted(() => ({ identity: vi.fn(), confinement: vi.fn(), item: vi.fn(), read: vi.fn(), lease: vi.fn(), source: vi.fn(), context: vi.fn() }));
vi.mock('../../external-bench/private-fixture-reads', async original => ({
  ...await original<Record<string, unknown>>(), requireBenchFixtureReadLease: mocks.lease,
  requireBenchFixtureSourcePins: mocks.source, benchFixtureContextSnapshot: mocks.context }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: mocks.identity }));
vi.mock('../../capability-envelope/session-confinement-store', () => ({ readSessionConfinement: mocks.confinement }));
vi.mock('../../work-items', () => ({ getWorkItem: mocks.item, isSelfOwnerRecord: (a: string, b: string) => a === b }));
vi.mock('../../work-items-events', () => ({ isSettledWorkItem: (row: { state: string }) => row.state === 'done' }));
vi.mock('../scorecards/get', () => ({ default: { args: z.object({ issueId: z.string() }).passthrough(), handler: mocks.read } }));
vi.mock('../scorecards/list', () => ({ default: { args: z.object({ rubricRef: z.string() }).passthrough(), handler: mocks.read } }));
vi.mock('../plans/get', () => ({ default: { args: z.object({ slug: z.string() }).passthrough(), handler: mocks.read } }));
vi.mock('../plans/get-specs', () => ({ default: { args: z.object({ slug: z.string() }).passthrough(), handler: mocks.read } }));
import tool from './read-private-fixture';

const allocation: BenchFixtureAllocation = {
  'LATENCY-M1:T01': { A: { issueId: 'EI-own-a' }, B: { issueId: 'EI-own-b' } },
  'LATENCY-M1:T02': { A: { issueId: 'EI-own-a', rubricRef: 'rubric', subjectRef: 'subject', comparisonTime: '2026-11-06T00:00:00Z' },
    B: { issueId: 'EI-own-b', rubricRef: 'rubric', subjectRef: 'subject', comparisonTime: '2026-11-06T00:00:00Z' } },
  'LATENCY-M1:T03': { A: { harness: 'source', slug: 'historical-a', revision: 3, specAsOf: '2026-11-06T00:00:00Z' },
    B: { harness: 'source', slug: 'historical-b', revision: 4, specAsOf: '2026-11-07T00:00:00Z' } },
};
const reads = (taskId = 'LATENCY-M1:T01') => freezeBenchFixtureReadBoundary({
  binding: { workspaceId: 'private', runId: 'run', preregHash: 'a'.repeat(64), assignmentId: 'bench-assignment:own', armId: 'cold', seed: 1 },
  taskId, expectedSha256: benchFixtureAllocationSha256(allocation), allocation })!;
const confinement = (taskId?: string) => ({ denyTools: [], denyOutside: [BENCH_PRIVATE_FIXTURE_TOOL],
  denyAmbientContext: true,
  denyBenchmarkReadsOutside: reads(taskId), denyWorkItemsOutside: { id: 'WI-own', harness: 'assignment', checkout: '/private' },
  imposedBy: 'benchmark-host bench-assignment:own' });
const ctx = { workspaceId: 'private' } as PapercuspUnifiedToolContext;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockReturnValue({ ownerId: 'su-solver', workspaceId: 'private' });
  mocks.confinement.mockResolvedValue(confinement());
  mocks.item.mockResolvedValue({ harness: 'assignment', assignee: 'su-solver', state: 'wip' });
  mocks.read.mockResolvedValue({ data: { ok: true, evidence: 'actual handler output' } });
  mocks.lease.mockResolvedValue(undefined);
  mocks.source.mockResolvedValue(undefined);
});
describe('assignment-holder private fixture read route', () => {
  it('uses the exact held checkout and host pins for context pages and withholds revoked reads', async () => {
    const { createHash } = await import('node:crypto');
    const text = JSON.stringify({ entry: { key: 'raw', text: 'é🧪 '.repeat(3000) } });
    mocks.context.mockResolvedValue({ text, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
    const request = { operation: 'context', case: 'A', source: 'corpus', entryKey: 'raw' } as const;
    const reply = await tool.handler(request, ctx);
    expect(mocks.context).toHaveBeenCalledWith(reads(), { tool: 'frozen-context', args: { source: 'corpus', entryKey: 'raw' } }, '/private', { workspaceId: 'private' });
    expect(reply).toMatchObject({ data: { privateFixtureResult: { complete: false, offset: 0 } } });
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.lease.mockRejectedValue(Error('revoked host lease'));
    await expect(tool.handler(request, ctx)).rejects.toThrow(/revoked/);
  });
  it('resolves source IDs server-side and returns the delegated handler output', async () => {
    expect(await tool.handler({ operation: 'card', case: 'B' }, ctx)).toEqual({ data: { ok: true, evidence: 'actual handler output' } });
    expect(mocks.confinement).toHaveBeenCalledWith('su-solver', 'private');
    expect(mocks.item).toHaveBeenCalledWith('WI-own', 'assignment');
    expect(mocks.read).toHaveBeenCalledWith({ issueId: 'EI-own-b' }, ctx);
  });
  it.each(['unbound', 'expired', 'foreign-workspace', 'foreign-owner', 'terminal', 'missing-item', 'ambient', 'malformed-item'])
    ('refuses %s without reaching a product reader', async state => {
      if (state === 'unbound') mocks.confinement.mockResolvedValue(null);
      if (state === 'expired') mocks.confinement.mockResolvedValue({ ...confinement(), denyOutside: [] });
      if (state === 'foreign-workspace') mocks.identity.mockReturnValue({ ownerId: 'su-solver', workspaceId: 'foreign' });
      if (state === 'foreign-owner') mocks.item.mockResolvedValue({ harness: 'assignment', assignee: 'su-peer', state: 'wip' });
      if (state === 'terminal') mocks.item.mockResolvedValue({ harness: 'assignment', assignee: 'su-solver', state: 'done' });
      if (state === 'missing-item') mocks.item.mockResolvedValue(null);
      if (state === 'ambient') mocks.confinement.mockResolvedValue({ ...confinement(), denyAmbientContext: false });
      if (state === 'malformed-item') mocks.confinement.mockResolvedValue({ ...confinement(),
        denyWorkItemsOutside: { id: 'WI-own', harness: '../foreign', checkout: '/private' } });
      await expect(tool.handler({ operation: 'card', case: 'A' }, ctx)).rejects.toThrow(/requires|require/);
      expect(mocks.read).not.toHaveBeenCalled();
    });
  it('delegates historical plan and spec reads with their original selectors', async () => {
    mocks.confinement.mockResolvedValue(confinement('LATENCY-M1:T03'));
    await tool.handler({ operation: 'plan', case: 'A' }, ctx);
    expect(mocks.read).toHaveBeenLastCalledWith({ harness: 'source', slug: 'historical-a', revision: 3, mode: 'full', includeEnrichments: false }, ctx);
    await tool.handler({ operation: 'specs', case: 'B' }, ctx);
    expect(mocks.read).toHaveBeenLastCalledWith({ harness: 'source', slug: 'historical-b', asOf: '2026-11-07T00:00:00Z' }, ctx);
    await expect(tool.handler({ operation: 'card', case: 'A' }, ctx)).rejects.toThrow(/not declared/);
  });
  it('refuses a revoked host before reading, even while the work item and confinement remain live', async () => {
    mocks.lease.mockRejectedValue(Error('revoked host lease'));
    await expect(tool.handler({ operation: 'card', case: 'A' }, ctx)).rejects.toThrow(/revoked/);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('withholds an in-flight result when the host stops during its product read', async () => {
    mocks.lease.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('revoked host lease'));
    await expect(tool.handler({ operation: 'card', case: 'A' }, ctx)).rejects.toThrow(/revoked/);
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.lease).toHaveBeenCalledTimes(2);
  });
  it('withholds output if stored source bytes change during the delegated read', async () => {
    mocks.source.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('source content differs'));
    await expect(tool.handler({ operation: 'card', case: 'A' }, ctx)).rejects.toThrow(/source content/);
    expect(mocks.read).toHaveBeenCalledOnce();
  });
  it('checks the lease after post-read source validation, so that validation cannot outlive its host', async () => {
    mocks.source.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      mocks.lease.mockRejectedValue(Error('host stopped during source validation'));
    });
    await expect(tool.handler({ operation: 'card', case: 'A' }, ctx)).rejects.toThrow(/host stopped/);
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
