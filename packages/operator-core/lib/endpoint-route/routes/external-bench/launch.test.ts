import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ launch: vi.fn(), cancel: vi.fn(), grade: vi.fn(),
  remove: vi.fn(), detail: vi.fn(), export: vi.fn() }));
vi.mock('../../../external-bench/run-launcher', () => ({
  launchBenchRun: io.launch,
  cancelBenchRun: io.cancel,
}));
vi.mock('../../../external-bench/grade-runner', () => ({ gradeBenchRun: io.grade }));
vi.mock('../../../external-bench/run-store', () => ({ deleteBenchRun: io.remove, getBenchRunDetail: io.detail }));
vi.mock('../../../external-bench/export-bundle', () => ({ buildExportBundle: io.export }));
vi.mock('../../../external-bench/estimate', () => ({
  estimateBenchLaunch: vi.fn(), estimateCurrentBenchLaunch: vi.fn(),
}));

import routes from './launch';

const launch = routes[0];
const principal = { slug: 'authenticated-benchmark-host', capabilities: ['capability:terminal'] };
const context = { principal, log: vi.fn() };
const current = {
  workspaceId: 'private-benchmark-workspace', protocolRunId: 'frozen-study',
  preregHash: 'a'.repeat(64), seed: 3,
  observation: { runtimeWorkspaceId: 'runtime', workerUnit: 'worker', gatewayUnit: 'gateway' },
};

function post(body: unknown) {
  return new Request('http://localhost/api/external-bench/runs/launch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  io.launch.mockResolvedValue({ runId: 'current-run', done: Promise.resolve() });
  io.cancel.mockResolvedValue({ cancelled: true });
  io.grade.mockResolvedValue({ runId: 'current-run', done: Promise.resolve() });
  io.remove.mockResolvedValue({ deleted: true });
  io.detail.mockResolvedValue({ id: 'current-run' });
  io.export.mockReturnValue({ predictions: [] });
});

describe('benchmark run HTTP workspace continuity', () => {
  const actions = [
    { index: 1, method: 'POST', path: '/cancel', call: io.cancel, nested: true },
    { index: 3, method: 'POST', path: '/grade', call: io.grade, nested: true },
    { index: 5, method: 'DELETE', path: '', call: io.remove, nested: false },
  ];

  it.each(actions)('preserves isolated workspace for $path/$method', async action => {
    const req = new Request(`http://localhost/api/external-bench/runs/current-run${action.path}?workspaceId=bench-private`,
      { method: action.method });
    const response = await routes[action.index].handler(req, { params: { id: 'current-run' } } as never) as Response;
    expect(response.status).toBe(200);
    expect(action.call).toHaveBeenCalledWith('current-run', action.nested
      ? { scope: { workspaceId: 'bench-private' } } : { workspaceId: 'bench-private' });
  });

  it.each(actions)('retains historical default scope for $path/$method', async action => {
    const req = new Request(`http://localhost/api/external-bench/runs/current-run${action.path}`, { method: action.method });
    const response = await routes[action.index].handler(req, { params: { id: 'current-run' } } as never) as Response;
    expect(response.status).toBe(200);
    expect(action.call).toHaveBeenCalledWith('current-run', action.nested ? { scope: {} } : {});
  });

  it.each(actions)('refuses explicit production scope before $path/$method', async action => {
    const req = new Request(`http://localhost/api/external-bench/runs/current-run${action.path}?workspaceId=papercusp-workspace`,
      { method: action.method });
    const response = await routes[action.index].handler(req, { params: { id: 'current-run' } } as never) as Response;
    expect(response.status).toBe(400);
    expect(action.call).not.toHaveBeenCalled();
  });

  it('refuses export when the requested workspace does not own the run', async () => {
    io.detail.mockResolvedValue(null);
    const response = await routes[4].handler(new Request(
      'http://localhost/api/external-bench/runs/current-run/export?workspaceId=bench-private'),
    { params: { id: 'current-run' } } as never) as Response;
    expect(response.status).toBe(404);
    expect(io.detail).toHaveBeenCalledWith('current-run', { workspaceId: 'bench-private' });
    expect(io.export).not.toHaveBeenCalled();
  });

  it('exports the snapshot after matching its isolated workspace', async () => {
    const response = await routes[4].handler(new Request(
      'http://localhost/api/external-bench/runs/current-run/export?workspaceId=bench-private'),
    { params: { id: 'current-run' } } as never) as Response;
    expect(response.status).toBe(200);
    expect(io.detail).toHaveBeenCalledWith('current-run', { workspaceId: 'bench-private' });
    expect(io.export).toHaveBeenCalledWith('current-run');
  });
});

describe('benchmark launch HTTP admission', () => {
  it.each(['swe-bench-pro', 'frontier-swe', 'minecraft'])(
    'preserves the %s suite for frozen runner admission', async suite => {
      const response = await launch.handler(post({ arm: 'papercusp', taskSetId: 'custom',
        taskIds: ['task-1'], suite, current }), context as never) as Response;

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, runId: 'current-run' });
      expect(io.launch).toHaveBeenCalledOnce();
      const [input, deps] = io.launch.mock.calls[0];
      expect(input).toMatchObject({ arm: 'papercusp', taskSetId: 'custom', taskIds: ['task-1'], suite, current });
      expect(deps.currentContext.workspaceId).toBe(current.workspaceId);
      expect(deps.currentContext.principal).toEqual({ ...principal, capabilities: new Set(principal.capabilities) });
    },
  );

  it('keeps an omitted suite available for the existing runner default', async () => {
    const response = await launch.handler(post({ arm: 'su-independent', taskSetId: '11-task-pilot' }),
      context as never) as Response;
    expect(response.status).toBe(200);
    expect(io.launch.mock.calls[0][0].suite).toBeUndefined();
    expect(io.launch.mock.calls[0][1]).toEqual({});
  });

  it('passes admission failures back without substituting another suite', async () => {
    io.launch.mockRejectedValue(new Error('conflicting_run_active: private-run'));
    const response = await launch.handler(post({ arm: 'papercusp', taskSetId: 'custom',
      suite: 'frontier-swe', current }), context as never) as Response;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'conflicting_run_active: private-run' });
    expect(io.launch).toHaveBeenCalledOnce();
    expect(io.launch.mock.calls[0][0].suite).toBe('frontier-swe');
  });
});
