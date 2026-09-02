/**
 * deployment-position.test.ts — the shared path→deployment-position join
 * (EI-22181490624100467).
 *
 * The subject is the FAIL-SOFT contract and the one derived conclusion built on
 * top of it: which cited paths are MEASURED as not live. Every assertion about an
 * absence here is paired with a positive control, because a filter that never
 * matches produces an empty `undeployedPaths` that is indistinguishable from
 * "everything is deployed" — the exact silent-wrong-answer shape this record
 * exists to expose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { gitPipelinePosition } = vi.hoisted(() => ({ gitPipelinePosition: vi.fn() }));
vi.mock('./git-pipeline-position', () => ({ gitPipelinePosition }));

import {
  citationDeploymentForPaths,
  deploymentPositionForPaths,
  MAX_DEPLOYMENT_POSITION_PATHS,
} from './deployment-position';

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

/** `deployed` measured false — the code is committed but not live. */
function undeployed(path: string) {
  return position(path, {
    positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
  });
}

beforeEach(() => {
  gitPipelinePosition.mockReset();
});

describe('deploymentPositionForPaths', () => {
  it('dedups and trims the supplied paths before probing', async () => {
    gitPipelinePosition.mockImplementation(({ path }: { path: string }) => position(path));

    const result = await deploymentPositionForPaths(['src/a.ts', '  src/a.ts  ', 'src/b.ts', '']);

    expect(gitPipelinePosition).toHaveBeenCalledTimes(2);
    expect(result.totalPaths).toBe(2);
    expect(result.paths.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('bounds the fan-out and reports truncation rather than probing every path', async () => {
    const paths = Array.from({ length: MAX_DEPLOYMENT_POSITION_PATHS + 5 }, (_, i) => `src/f${i}.ts`);
    gitPipelinePosition.mockImplementation(({ path }: { path: string }) => position(path));

    const result = await deploymentPositionForPaths(paths);

    expect(gitPipelinePosition).toHaveBeenCalledTimes(MAX_DEPLOYMENT_POSITION_PATHS);
    expect(result.truncated).toBe(true);
    expect(result.totalPaths).toBe(paths.length);
  });

  it('keeps one failed probe from hiding the other paths, and records it as unknown', async () => {
    gitPipelinePosition.mockImplementation(({ path }: { path: string }) => {
      if (path === 'src/boom.ts') throw new Error('probe exploded');
      return position(path);
    });

    const result = await deploymentPositionForPaths(['src/boom.ts', 'src/ok.ts']);

    expect(result.unknownPaths).toEqual(['src/boom.ts']);
    expect(result.paths.map((entry) => entry.path)).toEqual(['src/ok.ts']);
  });
});

describe('citationDeploymentForPaths', () => {
  it('reports a path whose deployed leg was MEASURED false (positive control)', async () => {
    gitPipelinePosition.mockImplementation(({ path }: { path: string }) => undeployed(path));

    const result = await citationDeploymentForPaths(['src/not-live.ts']);

    // Without this control, every "does not appear" assertion below would also pass
    // against a filter that can never match anything.
    expect(result.undeployedPaths).toEqual(['src/not-live.ts']);
  });

  it('never reports an UNKNOWN deployed leg as undeployed', async () => {
    gitPipelinePosition.mockImplementation(({ path }: { path: string }) =>
      position(path, {
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        positionsUnknown: ['deployed'],
      }),
    );

    const result = await citationDeploymentForPaths(['src/degraded.ts']);

    // `deployed:false` here is degradation, not measurement. Reporting it as
    // undeployed would be a confident wrong answer about live state.
    expect(result.undeployedPaths).toEqual([]);
    expect(result.unknownPaths).toEqual(['src/degraded.ts']);
  });

  it('never reports a path whose probe THREW as undeployed', async () => {
    gitPipelinePosition.mockImplementation(() => {
      throw new Error('probe exploded');
    });

    const result = await citationDeploymentForPaths(['src/boom.ts']);

    expect(result.undeployedPaths).toEqual([]);
    expect(result.unknownPaths).toEqual(['src/boom.ts']);
  });

  it('never reports a NEWER-COMMIT artifact as undeployed, and names it instead', async () => {
    gitPipelinePosition.mockImplementation(({ path }: { path: string }) =>
      position(path, {
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        positionsNewerCommit: ['inMain', 'deployed'],
      }),
    );

    const result = await citationDeploymentForPaths(['src/peer-commit.ts']);

    // The probe itself already disclaimed this `false`: it is about the newest commit
    // touching the file (routinely a peer's, on a whole-tree-swept checkout), not about
    // the cited change. Publishing it as `undeployedPaths` would tell the ship gate the
    // graded evidence is not live when nothing of the sort was measured.
    expect(result.undeployedPaths).toEqual([]);
    expect(result.newerCommitPaths).toEqual(['src/peer-commit.ts']);
  });

  it('carries positionsNewerCommit onto the compact row rather than dropping it', async () => {
    gitPipelinePosition.mockImplementation(({ path }: { path: string }) =>
      position(path, {
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        positionsNewerCommit: ['deployed'],
      }),
    );

    const result = await citationDeploymentForPaths(['src/peer-commit.ts']);

    // Dropping the flag is how the artifact goes silent: the row would show a bare
    // `deployed:false` with nothing recording that the probe had disclaimed it.
    expect(result.paths[0]?.positionsNewerCommit).toEqual(['deployed']);
  });

  it('suppresses only the DEPLOYED leg, not any newer-commit flag (control)', async () => {
    gitPipelinePosition.mockImplementation(({ path }: { path: string }) =>
      position(path, {
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        // `inMain` is an artifact; `deployed` was genuinely measured.
        positionsNewerCommit: ['inMain'],
      }),
    );

    const result = await citationDeploymentForPaths(['src/not-live.ts']);

    // Without this control the leg-specific `includes('deployed')` test could be
    // widened to "any newer-commit flag suppresses the path" and every assertion
    // above would still pass — while real undeployed evidence silently vanished.
    expect(result.undeployedPaths).toEqual(['src/not-live.ts']);
    expect(result.newerCommitPaths).toEqual([]);
  });

  it('separates measured-undeployed from deployed and unknown in one batch', async () => {
    gitPipelinePosition.mockImplementation(({ path }: { path: string }) => {
      if (path === 'src/not-live.ts') return undeployed(path);
      if (path === 'src/degraded.ts') {
        return position(path, {
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          positionsUnknown: ['deployed'],
        });
      }
      return position(path);
    });

    const result = await citationDeploymentForPaths([
      'src/live.ts',
      'src/not-live.ts',
      'src/degraded.ts',
    ]);

    expect(result.undeployedPaths).toEqual(['src/not-live.ts']);
    expect(result.unknownPaths).toEqual(['src/degraded.ts']);
    expect(result.totalPaths).toBe(3);
  });
});
