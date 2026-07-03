import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import captureTool from './capture';
import { coerceCaptureKind } from './capture-coerce';
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

describe('improvements:capture — observation strict/fail-loud (P-012)', () => {
  // The tool's args zod is the strip-or-reject boundary (the handler-direct tests above bypass it).
  // `.strict()` on the observation object makes an UNKNOWN key a LOUD arg-parse error instead of a
  // silent strip — the silent strip dropped data live (su-2a0b4: an Overwatch scorecard against the
  // not-yet-deployed schema persisted scope-only, no error). Tested via the exposed args zod.
  const argsSchema = (
    captureTool as unknown as {
      args: { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown[] } } };
    }
  ).args;

  it('accepts a known observation (kind/scope/confidence/refs)', () => {
    const r = argsSchema.safeParse({
      title: 'friction note',
      lane: 'observation',
      observation: { kind: 'friction', scope: 'self', confidence: 'high', refs: ['tool:foo'] },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a rubric-graded observation (rubricRef + ratings with evidence)', () => {
    const r = argsSchema.safeParse({
      title: 'scorecard',
      lane: 'observation',
      observation: {
        rubricRef: 'hive-coordination-health',
        ratings: { placement: { rating: 'healthy', evidence: '0 stalls this wake' } },
      },
    });
    expect(r.success).toBe(true);
  });

  it('REJECTS an unknown observation field (was silently stripped — su-2a0b4) and names the key', () => {
    const r = argsSchema.safeParse({
      title: 'scorecard against a newer schema',
      lane: 'observation',
      observation: { kind: 'friction', bogusNewField: 'a field the deployed schema does not know' },
    });
    expect(r.success).toBe(false);
    // fail-loud: the rejection NAMES the unrecognized key (not a silent strip / no opaque pass)
    expect(JSON.stringify(r.success ? [] : r.error!.issues)).toContain('bogusNewField');
  });
});
