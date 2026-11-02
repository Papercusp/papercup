import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTracker } from '@papercusp/tooldef';
import telemetryTool from './telemetry';

const deps = vi.hoisted(() => ({
  telemetryRollup: vi.fn(),
  handlerPhaseRollup: vi.fn(),
  flagPollSuspects: vi.fn(),
  runtimeObservabilityHealth: vi.fn(),
  readRuntimeSecurityCensus: vi.fn(),
}));

vi.mock('../../dev-data', () => ({
  telemetryRollup: deps.telemetryRollup,
  handlerPhaseRollup: deps.handlerPhaseRollup,
  flagPollSuspects: deps.flagPollSuspects,
}));
vi.mock('../../observability/runtime', () => ({
  runtimeObservabilityHealth: deps.runtimeObservabilityHealth,
  readRuntimeSecurityCensus: deps.readRuntimeSecurityCensus,
}));

type ToolResponse = { content: Array<{ type: string; text: string }> };

function callTool(args: Record<string, unknown>, phases?: ReturnType<typeof createPhaseTracker>) {
  return (telemetryTool as unknown as {
    handler: (args: unknown, ctx: unknown) => Promise<ToolResponse>;
  }).handler(args, { phases });
}

describe('dev:telemetry phase attribution', () => {
  it('routes actual-host discovery without running SQL rollups', async () => {
    const captured = { status: 'unavailable', populationComplete: false, unresolved: ['host-not-registered'] };
    deps.readRuntimeSecurityCensus.mockResolvedValue(captured);
    const tracker = createPhaseTracker();
    const result = await callTool({ view: 'security-census', limit: 7 }, tracker);
    expect(JSON.parse(result.content[0]!.text)).toEqual(captured);
    expect(deps.readRuntimeSecurityCensus).toHaveBeenCalledWith(7);
    expect(deps.telemetryRollup).not.toHaveBeenCalled();
    expect(deps.handlerPhaseRollup).not.toHaveBeenCalled();
    expect(tracker.intervals().map(({ phase }) => phase)).toEqual(['dev:telemetry:security-census']);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    deps.telemetryRollup.mockResolvedValue({ entries: [] });
    deps.handlerPhaseRollup.mockResolvedValue({ phases: [] });
    deps.flagPollSuspects.mockReturnValue([]);
    deps.runtimeObservabilityHealth.mockReturnValue({ status: 'ok' });
  });

  it('tracks both concurrent rollup branches when phase detail is requested', async () => {
    let finishTelemetry!: (value: { entries: [] }) => void;
    let finishPhases!: (value: { phases: [] }) => void;
    deps.telemetryRollup.mockReturnValue(new Promise((resolve) => { finishTelemetry = resolve; }));
    deps.handlerPhaseRollup.mockReturnValue(new Promise((resolve) => { finishPhases = resolve; }));

    const tracker = createPhaseTracker();
    const resultPromise = callTool({ phasesFor: 'coord:orient' }, tracker);

    expect(tracker.snapshot().activePhases.sort()).toEqual([
      'dev:telemetry:handler-phase-rollup',
      'dev:telemetry:rollup',
    ]);

    finishTelemetry({ entries: [] });
    finishPhases({ phases: [] });
    await resultPromise;

    expect(tracker.intervals().map(({ phase }) => phase).sort()).toEqual([
      'dev:telemetry:handler-phase-rollup',
      'dev:telemetry:rollup',
    ]);
    expect(deps.flagPollSuspects).toHaveBeenCalledWith([], 24);
  });

  it('tracks the telemetry rollup without requesting optional phase detail', async () => {
    const tracker = createPhaseTracker();

    await callTool({}, tracker);

    expect(tracker.intervals().map(({ phase }) => phase)).toEqual(['dev:telemetry:rollup']);
    expect(deps.handlerPhaseRollup).not.toHaveBeenCalled();
  });

  it('still runs the rollup when a direct handler call has no phase tracker', async () => {
    await callTool({});

    expect(deps.telemetryRollup).toHaveBeenCalledOnce();
  });
});
