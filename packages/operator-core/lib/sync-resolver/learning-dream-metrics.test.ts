import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistryEntryV2, resolveNamedQueryV2 } from './index';
import { queryNamesForTriggerEvent } from './table-to-query-names';

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(), controls: vi.fn(), tx: {},
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'metrics-workspace' }));
vi.mock('../route-workspace', () => ({ routeWithWorkspace: (fn: (tx: unknown) => unknown) => fn(mocks.tx) }));
vi.mock('../dream/dream-metrics', () => ({ readDreamMetrics: mocks.metrics }));
vi.mock('../dream/dream-control', () => ({ readDreamControlSnapshot: mocks.controls }));

describe('learning.dream metrics use the existing scoped sync path', () => {
  beforeEach(() => {
    mocks.metrics.mockReset().mockResolvedValue({ schemaVersion: 'dream-metrics-v1', population: { attempts: 501 } });
    mocks.controls.mockReset().mockResolvedValue({ potSlug: 'pot', manual: { active: false } });
  });
  it('preserves the default control read and resolves explicit metrics with the requested window', async () => {
    await expect(resolveNamedQueryV2('learning.dream', { potSlug: 'pot' })).resolves.toEqual([
      { potSlug: 'pot', manual: { active: false } },
    ]);
    expect(mocks.metrics).not.toHaveBeenCalled();
    const args = { potSlug: 'pot', view: 'metrics', since: '2026-09-07T00:00:00Z', until: '2026-09-08T00:00:00Z' };
    await expect(resolveNamedQueryV2('learning.dream', args)).resolves.toEqual([
      { schemaVersion: 'dream-metrics-v1', population: { attempts: 501 } },
    ]);
    expect(mocks.metrics).toHaveBeenCalledWith(mocks.tx, {
      workspaceId: 'metrics-workspace', potSlug: 'pot', since: args.since, until: args.until,
    });
  });
  it('does not convert a metrics read failure into an empty or zero report', async () => {
    mocks.metrics.mockRejectedValue(new Error('metrics read failed'));
    await expect(resolveNamedQueryV2('learning.dream', { potSlug: 'pot', view: 'metrics' })).rejects.toThrow(/metrics read failed/);
  });
  it('validates view/date arguments and invalidates on run, grade and experiment changes', () => {
    const schema = getRegistryEntryV2('learning.dream')!.argsSchema!;
    expect(() => schema.parse({ potSlug: 'pot', view: 'made-up' })).toThrow();
    expect(() => schema.parse({ potSlug: 'pot', view: 'metrics', since: 'bad-date' })).toThrow();
    for (const table of ['dream_runs', 'scout_routed_ideas', 'experiment_runs'])
      expect(queryNamesForTriggerEvent(`harness_shared.${table}.changed`)).toContain('learning.dream');
  });
});
