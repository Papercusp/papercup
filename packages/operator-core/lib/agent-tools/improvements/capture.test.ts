import { describe, it, expect, beforeEach, vi } from 'vitest';
import captureTool from './capture';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: capture-core has its own 31-test suite; this pins the tool
// wrapper's two jobs — (1) deriving the `source` label from the caller's
// identity tier, and (2) passing every arg + the resolved identity through to
// the shared core unchanged. (self-learning-central P-001/P-010.)
vi.mock('../../harness/improvements/capture-core');
vi.mock('../coordination/identity');

const mockCapture = vi.mocked(captureImprovement);
const mockIdentity = vi.mocked(resolveAgentIdentity);

function identity(source: ReturnType<typeof resolveAgentIdentity>['source'], ownerId = 'su-test') {
  return {
    ownerId,
    ownerLabel: `${source} · ${ownerId}`,
    source,
    workspaceId: 'ws-1',
    userId: null,
  } as ReturnType<typeof resolveAgentIdentity>;
}

function callTool(args: Record<string, unknown>, ctx: unknown = {}) {
  return (
    captureTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('improvements:capture tool envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it('maps an omp-hook-session caller to source="su"', async () => {
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-abc'));
    await callTool({ title: 'flaky lock hook', kind: 'bug' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ source: 'su', createdBy: 'su-abc' }));
  });

  it('maps a static-client caller to source="su"', async () => {
    mockIdentity.mockReturnValue(identity('static-client'));
    await callTool({ title: 'x', kind: 'bug' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ source: 'su' }));
  });

  it('maps every other identity tier (e.g. fleet-spawn / principal) to source="engineer"', async () => {
    for (const src of ['fleet-spawn', 'principal', 'signed-spawn', 'power-user-token'] as const) {
      mockCapture.mockClear();
      mockIdentity.mockReturnValue(identity(src));
      await callTool({ title: 'x', kind: 'change' });
      expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ source: 'engineer' }));
    }
  });

  it('passes every arg + the resolved ownerId through to the core unchanged', async () => {
    mockIdentity.mockReturnValue(identity('static-client', 'su-owner'));
    await callTool({
      title: 'db-tooling friction',
      kind: 'change',
      body: 'repro steps',
      severity: 'major',
      subTopic: 'db-tooling',
      scope: 'harness:foo',
      foundDuring: 'WI-9',
      paths: ['a.ts', 'b.ts'],
      force: true,
      checkDuplicatesOnly: false,
      origin: 'drill',
    });
    expect(mockCapture).toHaveBeenCalledWith({
      title: 'db-tooling friction',
      kind: 'change',
      body: 'repro steps',
      severity: 'major',
      subTopic: 'db-tooling',
      scope: 'harness:foo',
      foundDuring: 'WI-9',
      paths: ['a.ts', 'b.ts'],
      force: true,
      checkDuplicatesOnly: false,
      origin: 'drill',
      createdBy: 'su-owner',
      source: 'su',
    });
  });

  it('returns the core result verbatim in the tool envelope', async () => {
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-42', created: true, duplicateOf: null } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    const res = await callTool({ title: 'x', kind: 'bug' });
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ ok: true, id: 'EI-42', created: true, duplicateOf: null });
  });
});
