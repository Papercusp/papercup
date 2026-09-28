import { describe, expect, it, vi } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import '../../index';
import tool from './gate_ownership';
import { readGateOwnership, unmeasuredCell, unownedCell, type CellOwnership } from '../../coord/gate-ownership';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { gitPipelinePosition } from '../../git-pipeline-position';
import { GATE_OWNERSHIP_CELL } from '../../cell-registrations';

vi.mock('../../coord/gate-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coord/gate-ownership')>()),
  readGateOwnership: vi.fn(),
}));
vi.mock('../../git-pipeline-position', () => ({ gitPipelinePosition: vi.fn() }));

describe('dev:gate_ownership', () => {
  it('is registered by the operator tool index that serves the ownership cell', () => {
    expect(lookupByMcpName('dev:gate_ownership')).toBeDefined();
  });

  it('resolves the ownership cell without entering an unrelated slow pipeline leg', async () => {
    vi.mocked(gitPipelinePosition).mockImplementation(() => new Promise(() => {}));
    // Built from the module's own cell constructor so the fixture is typed against
    // the real CellOwnership shape (no `as never` escape; check-mock-cast-escape).
    const ownership: CellOwnership = {
      ...unownedCell('green-stall:papercusp'),
      assessment: 'held-live',
      claimState: 'held',
      takenBy: 'su-live',
    };
    mockResolvedTyped(vi.mocked(readGateOwnership), ownership);

    const result = await tool.handler({}, { harnessSlug: 'papercusp' } as never);

    expect(readGateOwnership).toHaveBeenCalledWith({ harness: 'papercusp' });
    expect(gitPipelinePosition).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      data: { gate: { ownership }, assessments: { gateOwnership: 'held-live' } },
    });
    expect(GATE_OWNERSHIP_CELL.changeSignal).toEqual({
      kind: 'poll', tool: 'dev:gate_ownership', path: 'gate.ownership.claimState',
    });
  });

  it('emits the ownership unknown through the cell declared verdict channel', async () => {
    const unknown = { code: 'resolver-failed', detail: 'ownership store unreachable' };
    mockResolvedTyped(vi.mocked(readGateOwnership), unmeasuredCell('green-stall:papercusp', unknown.detail));

    const result = await tool.handler({}, { harnessSlug: '*' } as never);

    // The superuser '*' sentinel names no harness, so the tool resolves it away and
    // readGateOwnership applies its own operator-home default.
    expect(readGateOwnership).toHaveBeenCalledWith({ harness: undefined });
    expect(result).toMatchObject({
      data: { verdictUnknown: [{ leg: 'gate.ownership.claimState', unknown }] },
    });
  });
});
