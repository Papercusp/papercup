import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), live: vi.fn() }));
vi.mock('../external-bench/run-store', () => ({ listBenchRuns: io.list, getBenchRunDetail: io.detail }));
vi.mock('../external-bench/live-state', () => ({ getBenchRunLiveState: io.live }));
import { resolveNamedQueryV2 } from './index';

beforeEach(() => {
  vi.clearAllMocks();
  io.list.mockResolvedValue([{ id: 'private-run' }]);
  io.detail.mockResolvedValue({ id: 'private-run' });
  io.live.mockResolvedValue({ runId: 'private-run' });
});

describe('Evaluation isolated run workspace', () => {
  const queries = [
    { name: 'evals.benchRuns', args: {}, call: io.list },
    { name: 'evals.benchRun', args: { runId: 'private-run' }, call: io.detail },
    { name: 'evals.benchRunLive', args: { runId: 'private-run' }, call: io.live },
  ];
  it.each(queries)('scopes $name to the selected isolated workspace', async query => {
    const rows = await resolveNamedQueryV2(query.name, { ...query.args, workspaceId: 'bench-private' });
    expect(rows).toHaveLength(1);
    expect(query.call).toHaveBeenCalledWith(...('runId' in query.args ? ['private-run'] : []),
      { workspaceId: 'bench-private' });
  });
  it.each(queries)('preserves the historical active-workspace default for $name', async query => {
    await resolveNamedQueryV2(query.name, query.args);
    expect(query.call).toHaveBeenCalledWith(...('runId' in query.args ? ['private-run'] : []), {});
  });
  it.each(queries)('refuses explicit production scope for $name', async query => {
    await expect(resolveNamedQueryV2(query.name, { ...query.args, workspaceId: 'papercusp-workspace' })).rejects.toThrow('PRODUCTION');
    expect(query.call).not.toHaveBeenCalled();
  });
});
