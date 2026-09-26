import { describe, expect, it, vi } from 'vitest';
import tool from './gate_ownership';
import { readGateOwnership } from '../../coord/gate-ownership';
import { gitPipelinePosition } from '../../git-pipeline-position';
import { GATE_OWNERSHIP_CELL } from '../../cell-registrations';

vi.mock('../../coord/gate-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coord/gate-ownership')>()),
  readGateOwnership: vi.fn(),
}));
vi.mock('../../git-pipeline-position', () => ({ gitPipelinePosition: vi.fn() }));

describe('dev:gate_ownership', () => {
  it('resolves the ownership cell without entering an unrelated slow pipeline leg', async () => {
    vi.mocked(gitPipelinePosition).mockImplementation(() => new Promise(() => {}));
    const ownership = { assessment: 'held-live', claimState: 'held', takenBy: 'su-live' };
    vi.mocked(readGateOwnership).mockResolvedValue(ownership as never);

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
});
