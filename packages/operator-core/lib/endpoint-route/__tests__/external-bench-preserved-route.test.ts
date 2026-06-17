/**
 * Unit tests for /api/external-bench/runs (the Evaluation "Preserved runs"
 * backend). Drives each handler directly with a hand-built RouteContext and a
 * mocked preserved-runs reader, so it asserts the ROUTE's own logic (param
 * validation, response envelopes, 400/404) without touching disk. The merge +
 * summary are covered by external-bench/preserved-runs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const listPreservedRuns = vi.fn();
const readPreservedRun = vi.fn();

vi.mock('../../external-bench/preserved-runs', async (importActual) => ({
  ...(await importActual<typeof import('../../external-bench/preserved-runs')>()),
  listPreservedRuns: (...a: unknown[]) => listPreservedRuns(...a),
  readPreservedRun: (...a: unknown[]) => readPreservedRun(...a),
}));

type Route = { method: string; path: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };
const ctx = (params: Record<string, string> = {}): RouteContext => ({
  principal: null, input: undefined, params, log: () => {}, signal: new AbortController().signal,
});
const req = (path: string): Request => new Request(`http://localhost:3070/api/external-bench${path}`);

async function route(method: string, path: string): Promise<Route> {
  const mod = await import('../routes/external-bench/preserved');
  const r = (mod.default as Route[]).find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`route ${method} ${path} not registered`);
  return r;
}
async function launchRoute(method: string, path: string): Promise<Route> {
  const mod = await import('../routes/external-bench/launch');
  const r = (mod.default as Route[]).find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`launch route ${method} ${path} not registered`);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  listPreservedRuns.mockReturnValue([{ id: 'm3-realqueen-2026-06-16', arm: 'hive-realqueen', mtimeMs: 1 }]);
  readPreservedRun.mockReturnValue({
    id: 'm3-realqueen-2026-06-16',
    run: { arm: 'hive-realqueen' },
    perTask: [{ instanceId: 'x', resolved: true }],
    summary: { arm: 'hive-realqueen', resolvedCount: 6, gradedCount: 11, taskCount: 11, resolvedPct: 6 / 11 },
    coordRates: { counts: { duplicate: 0, breakdown: 1, misalignment: 0, redundant: 2 } },
  });
});

describe('GET /external-bench/runs', () => {
  it('returns the run list envelope', async () => {
    const r = await route('GET', '/external-bench/runs');
    const res = await r.handler(req('/runs'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe('m3-realqueen-2026-06-16');
  });
});

describe('GET /external-bench/runs/:id', () => {
  it('returns the merged detail with the 6/11 summary', async () => {
    const r = await route('GET', '/external-bench/runs/:id');
    const res = await r.handler(req('/runs/m3-realqueen-2026-06-16'), ctx({ id: 'm3-realqueen-2026-06-16' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.resolvedCount).toBe(6);
    expect(body.summary.taskCount).toBe(11);
    expect(readPreservedRun).toHaveBeenCalledWith('m3-realqueen-2026-06-16');
  });

  it('400s on an unsafe run id (path traversal) without reading', async () => {
    const r = await route('GET', '/external-bench/runs/:id');
    const res = await r.handler(req('/runs/..'), ctx({ id: '..' }));
    expect(res.status).toBe(400);
    expect(readPreservedRun).not.toHaveBeenCalled();
  });

  it('404s when the run is not found', async () => {
    readPreservedRun.mockReturnValue(null);
    const r = await route('GET', '/external-bench/runs/:id');
    const res = await r.handler(req('/runs/nope'), ctx({ id: 'nope' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('run_not_found');
  });
});

describe('GET /external-bench/estimate', () => {
  it('returns the shared launch estimate envelope', async () => {
    const r = await launchRoute('GET', '/external-bench/estimate');
    const res = await r.handler(req('/estimate?taskSetId=11-task-pilot&cap=6'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskSetId).toBe('11-task-pilot');
    expect(body.taskCount).toBe(11);
    expect(body.cap).toBe(6);
    expect(body.estCostUsd).toBe(38.5);
  });
});
