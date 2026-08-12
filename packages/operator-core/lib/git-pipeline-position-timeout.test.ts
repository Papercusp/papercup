import { describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: childProcessMocks.execFile,
    spawnSync: childProcessMocks.spawnSync,
  };
});

import {
  GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
  realGit,
  realResolveGateCandidates,
} from './git-pipeline-position';

describe('git-pipeline-position subprocess bounds (EI-20262192515275987)', () => {
  it('bounds realGit and preserves its fail-soft null on a timed-out child', async () => {
    childProcessMocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    });

    await expect(realGit('/repo', ['rev-parse', 'HEAD'])).resolves.toBeNull();
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'rev-parse', 'HEAD'],
      expect.objectContaining({
        timeout: GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
      }),
      expect.any(Function),
    );
  });

  it('bounds every gate-candidate probe and degrades a failed probe to null candidates', async () => {
    childProcessMocks.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'timed out' });

    await expect(realResolveGateCandidates('/repo')).resolves.toEqual({
      judgingSha: null,
      nextCandidateSha: null,
    });
    expect(childProcessMocks.spawnSync).toHaveBeenCalled();
    for (const call of childProcessMocks.spawnSync.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          timeout: GIT_PIPELINE_POSITION_SUBPROCESS_TIMEOUT_MS,
        }),
      );
    }
  });
});
