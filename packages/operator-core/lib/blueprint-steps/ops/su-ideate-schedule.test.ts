import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuIdeateScheduleDeps } from '../../scout/su-ideate-schedule';
import { setSuIdeateScheduleDeps, suIdeateScheduleOp } from './su-ideate-schedule';

function refuseLaunch(): SuIdeateScheduleDeps {
  return {
    listHarnesses: async () => ['eligible'],
    readLastPass: async () => ({ lastPassMs: null, lastLens: null }),
    learningEnabled: async () => true,
    countObservationsSince: async () => 10,
    readIdeaQueue: async () => ({ total: 0, pending: 0 }),
    listLaunches: async () => [],
    launch: async () => ({ ok: false, error: 'governor admission refused' }),
  };
}

afterEach(() => {
  setSuIdeateScheduleDeps(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('scheduled su ideate decision diagnostics', () => {
  it('exposes the actual launch refusal when the scheduled context has no logger', async () => {
    vi.stubEnv('PAPERCUSP_SU_IDEATE_OBS_THRESHOLD', '10');
    setSuIdeateScheduleDeps(refuseLaunch());
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const output = await suIdeateScheduleOp.run({}, { workspaceId: 'ws' } as never);

    expect(output.decisions).toEqual([{
      harnessSlug: 'eligible', disposition: 'launch-failed',
      observationsSince: 10, error: 'governor admission refused',
    }]);
    expect(log).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(String(log.mock.calls[0][0]).slice('su-ideate:schedule '.length));
    expect(diagnostic).toEqual(output);
    expect(diagnostic.decisions[0].error).toBe('governor admission refused');
  });

  it('uses a supplied program logger without a second console emission', async () => {
    vi.stubEnv('PAPERCUSP_SU_IDEATE_OBS_THRESHOLD', '10');
    setSuIdeateScheduleDeps(refuseLaunch());
    const fallback = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = vi.fn();
    await suIdeateScheduleOp.run({}, { workspaceId: 'ws', log } as never);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('governor admission refused'));
    expect(fallback).not.toHaveBeenCalled();
  });
});
