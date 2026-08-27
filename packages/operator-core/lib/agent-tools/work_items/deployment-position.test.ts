import { beforeEach, describe, expect, it, vi } from 'vitest';

const { gitPipelinePosition } = vi.hoisted(() => ({ gitPipelinePosition: vi.fn() }));
vi.mock('../../git-pipeline-position', () => ({ gitPipelinePosition }));

import { deploymentPositionForEvidence, MAX_DEPLOYMENT_POSITION_PATHS } from './deployment-position';

function position(path: string, overrides: Record<string, unknown> = {}) {
  return {
    targetSha: `${path}-sha`,
    deployedSha: 'deployed-sha',
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    blockedOn: null,
    positionsUnknown: [],
    ...overrides,
  };
}

beforeEach(() => {
  gitPipelinePosition.mockReset();
});

describe('deploymentPositionForEvidence', () => {
  it('returns no signal when completion evidence is absent and an explicit unknown when paths are absent', async () => {
    await expect(deploymentPositionForEvidence(null)).resolves.toBeUndefined();
    await expect(deploymentPositionForEvidence({ verifiedHow: 'unit' })).resolves.toMatchObject({
      paths: [],
      unknownPaths: [],
      totalPaths: 0,
      truncated: false,
      unknownReason: 'no-filesChanged',
    });
  });

  it('resolves top-level and nested filesChanged paths in parallel and keeps compact positions', async () => {
    gitPipelinePosition.mockImplementation(async ({ path }: { path: string }) => position(path));

    const result = await deploymentPositionForEvidence({
      filesChanged: ['src/a.ts'],
      verification: { filesChanged: ['src/b.ts', 'src/a.ts'] },
    });

    expect(gitPipelinePosition).toHaveBeenCalledTimes(2);
    expect(gitPipelinePosition).toHaveBeenCalledWith({ path: 'src/a.ts' });
    expect(gitPipelinePosition).toHaveBeenCalledWith({ path: 'src/b.ts' });
    expect(result).toEqual({
      paths: [
        {
          path: 'src/a.ts',
          targetSha: 'src/a.ts-sha',
          deployedSha: 'deployed-sha',
          positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
          blockedOn: null,
        },
        {
          path: 'src/b.ts',
          targetSha: 'src/b.ts-sha',
          deployedSha: 'deployed-sha',
          positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
          blockedOn: null,
        },
      ],
      unknownPaths: [],
      totalPaths: 2,
      truncated: false,
    });
  });

  it('keeps one probe failure and unknown pipeline legs explicit without failing the batch', async () => {
    gitPipelinePosition
      .mockResolvedValueOnce(position('src/a.ts', { positionsUnknown: ['deployed'] }))
      .mockRejectedValueOnce(new Error('pipeline unavailable'));

    await expect(
      deploymentPositionForEvidence({ filesChanged: ['src/a.ts', 'src/b.ts'] }),
    ).resolves.toMatchObject({
      paths: [
        {
          path: 'src/a.ts',
          positionsUnknown: ['deployed'],
        },
      ],
      unknownPaths: ['src/a.ts', 'src/b.ts'],
      totalPaths: 2,
      truncated: false,
    });
  });

  it('bounds path fan-out and records truncation', async () => {
    gitPipelinePosition.mockImplementation(async ({ path }: { path: string }) => position(path));
    const filesChanged = Array.from({ length: MAX_DEPLOYMENT_POSITION_PATHS + 2 }, (_, i) => `src/${i}.ts`);

    const result = await deploymentPositionForEvidence({ filesChanged });

    expect(gitPipelinePosition).toHaveBeenCalledTimes(MAX_DEPLOYMENT_POSITION_PATHS);
    expect(result).toMatchObject({ totalPaths: filesChanged.length, truncated: true });
    expect(result?.paths).toHaveLength(MAX_DEPLOYMENT_POSITION_PATHS);
  });
});
