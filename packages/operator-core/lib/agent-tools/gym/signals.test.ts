import { describe, it, expect, beforeEach, vi } from 'vitest';
import signalsTool from './signals';
import { evaluateSignals, knownSignals } from '../../gym/primitives';
import { readDrillOutcomes } from '../../red-queen/store';

// PG-free unit: evaluateSignals (the guardrail core) has its own suite; this pins
// the TOOL — the drillOutcomes precedence (explicit > loaded > none), the
// drillSource bookkeeping, the SignalContext assembly (plantedBug defaults), and
// the ok = (no unknown signals) flag (harness-blueprint-orchestration P-012 / D-022,
// FB-23 / P-048).
vi.mock('../../gym/primitives', () => ({ evaluateSignals: vi.fn(), knownSignals: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../red-queen/store', () => ({ readDrillOutcomes: vi.fn() }));

const mockEval = vi.mocked(evaluateSignals);
const mockKnown = vi.mocked(knownSignals);
const mockReadDrills = vi.mocked(readDrillOutcomes);

function callTool(args: Record<string, unknown>) {
  return (
    signalsTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, {});
}

const aDrill = () => ({ drillId: 'd1', status: 'resolved', origin: 'drill' });

describe('gym:signals tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEval.mockReturnValue({ results: [{ name: 'regressionsFromTests', value: false, applicable: true }], unknown: [] } as unknown as ReturnType<
      typeof evaluateSignals
    >);
    mockKnown.mockReturnValue(['regressionsFromTests'] as unknown as ReturnType<typeof knownSignals>);
    mockReadDrills.mockResolvedValue([aDrill(), aDrill()] as unknown as Awaited<ReturnType<typeof readDrillOutcomes>>);
  });

  it('does no I/O and reports drillSource:none when neither drillOutcomes nor loadDrillOutcomes is given', async () => {
    const res = await callTool({ signals: ['regressionsFromTests'] });
    expect(mockReadDrills).not.toHaveBeenCalled();
    const body = JSON.parse(res.content[0].text);
    expect(body.drillSource).toEqual({ mode: 'none', count: 0 });
  });

  it('uses explicit drillOutcomes (mode:explicit) and never reads PG', async () => {
    const res = await callTool({ signals: ['drillResolveRate'], drillOutcomes: [aDrill(), aDrill(), aDrill()] });
    expect(mockReadDrills).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text).drillSource).toEqual({ mode: 'explicit', count: 3 });
  });

  it('loads the live drill corpus (mode:loaded) when loadDrillOutcomes is set, forwarding the filters', async () => {
    const res = await callTool({
      signals: ['drillResolveRate'],
      loadDrillOutcomes: true,
      drillClass: 'smoke-fail',
      drillsSinceTs: '2026-06-01T00:00:00Z',
      drillsLimit: 100,
    });
    expect(mockReadDrills).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: expect.any(String),
      classId: 'smoke-fail',
      sinceTs: '2026-06-01T00:00:00Z',
      limit: 100,
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.drillSource).toMatchObject({ mode: 'loaded', count: 2 });
  });

  it('explicit drillOutcomes WIN over loadDrillOutcomes (no PG read)', async () => {
    await callTool({ signals: ['drillResolveRate'], loadDrillOutcomes: true, drillOutcomes: [aDrill()] });
    expect(mockReadDrills).not.toHaveBeenCalled();
  });

  it('assembles plantedBug with defaulted defect/signature into the signal context', async () => {
    await callTool({ signals: ['plantedBugCaught'], plantedBug: { location: 'src/x.ts' } });
    const ctx = mockEval.mock.calls[0][1] as { plantedBug: { location: string; defect: string; detectionSignature: string } };
    expect(ctx.plantedBug).toEqual({ location: 'src/x.ts', defect: '', detectionSignature: '' });
  });

  it('ok=false when any signal name is unknown; ok=true when all resolve', async () => {
    mockEval.mockReturnValue({ results: [], unknown: ['bogusSignal'] } as unknown as ReturnType<typeof evaluateSignals>);
    const bad = JSON.parse((await callTool({ signals: ['bogusSignal'] })).content[0].text);
    expect(bad.ok).toBe(false);
    expect(bad.unknown).toEqual(['bogusSignal']);

    mockEval.mockReturnValue({ results: [], unknown: [] } as unknown as ReturnType<typeof evaluateSignals>);
    const good = JSON.parse((await callTool({ signals: ['regressionsFromTests'] })).content[0].text);
    expect(good.ok).toBe(true);
  });
});
