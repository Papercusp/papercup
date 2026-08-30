import { describe, expect, it, vi } from 'vitest';
import { makeDeadCitationSweepAction } from './dead-citation-sweep-action';
import type { DeadCitationSweepResult } from '../../dead-citation-sweep';

const emptyResult: DeadCitationSweepResult = { scannedFiles: 10, citedIds: 0, deadCitations: [] };

const withDeadResult: DeadCitationSweepResult = {
  scannedFiles: 10732,
  citedIds: 7330,
  deadCitations: [
    {
      id: 'EI-19375134577577530',
      citationCount: 2,
      samples: [{ file: 'scripts/lint-tsc-operator.mjs', line: 19, text: '// ... EI-19375134577577530 ...' }],
    },
  ],
};

describe('dead-citation-sweep system action', () => {
  it('runs one tick, skips filing, and logs zero when nothing is dead', async () => {
    const run = vi.fn(async () => emptyResult);
    const file = vi.fn(async () => ({ filed: false }));
    const log = vi.fn();
    const action = makeDeadCitationSweepAction({ run, file, log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(run).toHaveBeenCalledOnce();
    expect(file).toHaveBeenCalledWith({ harnessSlug: 'papercusp', result: emptyResult });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('scanned=10 cited=0 dead=0 filed=false'));
  });

  it('files a finding and logs the dead count when a citation is dead', async () => {
    const run = vi.fn(async () => withDeadResult);
    const file = vi.fn(async () => ({ filed: true }));
    const log = vi.fn();
    const action = makeDeadCitationSweepAction({ run, file, log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(file).toHaveBeenCalledWith({ harnessSlug: 'papercusp', result: withDeadResult });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('papercusp: scanned=10732 cited=7330 dead=1 filed=true'),
    );
  });

  it('uses the routine ctx installSlug as the harness scope, not a hardcoded value', async () => {
    const run = vi.fn(async () => emptyResult);
    const file = vi.fn(async () => ({ filed: false }));
    const action = makeDeadCitationSweepAction({ run, file, log: vi.fn() });

    await action({ workspaceId: 'ws', installSlug: 'some-other-harness', triggerConfig: {}, payloadTemplate: {} });

    expect(file).toHaveBeenCalledWith({ harnessSlug: 'some-other-harness', result: emptyResult });
  });
});
