// @vitest-environment node
/**
 * makeHarnessTestingDataSource — the TestingDataSource the /adv Harness
 * Tests tab injects into <DomainTestPanel>. The harness run route is
 * SYNCHRONOUS (POST returns the finished result), so this adapter bridges
 * it to the panel's async startRun→runId / pollRun→snapshot contract by
 * stashing the finished result client-side, keyed by runId.
 *
 * Covers:
 *  - URL + phase encoding on each read endpoint
 *  - startRun stashes the POST result; pollRun returns it once, then null
 *  - non-ok fallbacks: fetchStatuses→{}, fetchHealth→null, fetchDomain/
 *    startRun throw `HTTP <status>`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHarnessTestingDataSource } from './harness-testing-data-source';

type FetchImpl = (url: string, init?: RequestInit) => Promise<unknown>;

function stubFetch(impl: FetchImpl) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const notOk = (status: number) => ({ ok: false, status, json: async () => ({}) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('makeHarnessTestingDataSource — read endpoints', () => {
  it('fetchDomain hits domain-detail with the encoded domainId + phase', async () => {
    const spy = stubFetch(async () => ok({ id: 'd1' }));
    const ds = makeHarnessTestingDataSource('my harness', 'staging');
    const res = await ds.fetchDomain('voice/qa');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(
      '/api/harness/my%20harness/testing/domain-detail?domainId=voice%2Fqa&phase=staging',
    );
    expect(res).toEqual({ id: 'd1' });
  });

  it('fetchDomain throws HTTP <status> on a non-ok response', async () => {
    stubFetch(async () => notOk(404));
    const ds = makeHarnessTestingDataSource('h', 'staging');
    await expect(ds.fetchDomain('d')).rejects.toThrow('HTTP 404');
  });

  it('fetchStatuses unwraps the statuses map and encodes the URL', async () => {
    const spy = stubFetch(async () => ok({ statuses: { 'a.test.ts': { status: 'pass' } } }));
    const ds = makeHarnessTestingDataSource('h', 'production');
    const out = await ds.fetchStatuses('dom');
    expect(spy.mock.calls[0][0]).toBe(
      '/api/harness/h/testing/file-status?domainId=dom&phase=production',
    );
    expect(out).toEqual({ 'a.test.ts': { status: 'pass' } });
  });

  it('fetchStatuses falls back to {} when the body has no statuses key', async () => {
    stubFetch(async () => ok({}));
    const ds = makeHarnessTestingDataSource('h', 'staging');
    expect(await ds.fetchStatuses('dom')).toEqual({});
  });

  it('fetchStatuses falls back to {} on a non-ok response', async () => {
    stubFetch(async () => notOk(500));
    const ds = makeHarnessTestingDataSource('h', 'staging');
    expect(await ds.fetchStatuses('dom')).toEqual({});
  });

  it('fetchHealth returns the body on ok, null on non-ok', async () => {
    stubFetch(async () => ok({ pass: 3, fail: 0 }));
    let ds = makeHarnessTestingDataSource('h', 'staging');
    expect(await ds.fetchHealth('dom')).toEqual({ pass: 3, fail: 0 });

    stubFetch(async () => notOk(503));
    ds = makeHarnessTestingDataSource('h', 'staging');
    expect(await ds.fetchHealth('dom')).toBeNull();
  });

  it('fetchHistory hits file-history with the encoded filePath + limit + phase and returns rows (P-007/P-020)', async () => {
    const rows = [{ status: 'pass', finishedAt: 1 }];
    const spy = stubFetch(async () => ok({ rows }));
    const ds = makeHarnessTestingDataSource('h', 'staging');
    const out = await ds.fetchHistory('any.ts', 10);
    expect(spy.mock.calls[0][0]).toBe(
      '/api/harness/h/testing/file-history?filePath=any.ts&limit=10&phase=staging',
    );
    expect(out).toEqual(rows);
  });

  it('fetchHistory falls back to [] when the body has no rows key', async () => {
    stubFetch(async () => ok({}));
    const ds = makeHarnessTestingDataSource('h', 'staging');
    expect(await ds.fetchHistory('any.ts', 10)).toEqual([]);
  });

  it('fetchHistory falls back to [] on a non-ok response (fail-soft, never throws into the panel)', async () => {
    stubFetch(async () => notOk(500));
    const ds = makeHarnessTestingDataSource('h', 'staging');
    expect(await ds.fetchHistory('any.ts', 10)).toEqual([]);
  });
});

describe('makeHarnessTestingDataSource — synchronous run bridged to startRun/pollRun', () => {
  it('startRun POSTs to /run with the phase query and the JSON body', async () => {
    const spy = stubFetch(async () =>
      ok({ runId: 'r1', status: 'pass', exitCode: 0, output: 'ok', finishedAt: 123 }),
    );
    const ds = makeHarnessTestingDataSource('h', 'staging');
    const { runId } = await ds.startRun({ runner: 'vitest' });
    expect(runId).toBe('r1');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/harness/h/testing/run?phase=staging');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ runner: 'vitest' });
  });

  it('pollRun returns the stashed finished snapshot, and is idempotent (the panel polls once on a synchronous run)', async () => {
    stubFetch(async () =>
      ok({ runId: 'r9', status: 'fail', exitCode: 1, output: 'boom', finishedAt: 456 }),
    );
    const ds = makeHarnessTestingDataSource('h', 'staging');
    const { runId } = await ds.startRun({ runner: 'vitest' });
    const snap = {
      status: 'fail' as const,
      exitCode: 1,
      output: 'boom',
      finishedAt: 456,
    };
    // The stash is read, not drained: pollRun is a plain `Map.get(...) ?? null`,
    // so a repeat poll of the SAME runId still yields the snapshot (the panel
    // only polls once for a synchronous run, so this never changes behavior).
    expect(await ds.pollRun(runId)).toEqual(snap);
    expect(await ds.pollRun(runId)).toEqual(snap);
  });

  it('an unknown runId polls to null', async () => {
    stubFetch(async () => ok({ runId: 'r1', status: 'pass', exitCode: 0, output: '', finishedAt: 1 }));
    const ds = makeHarnessTestingDataSource('h', 'staging');
    expect(await ds.pollRun('never-started')).toBeNull();
  });

  it('two dataSource instances do not share run stashes (closure-local)', async () => {
    stubFetch(async () => ok({ runId: 'shared-id', status: 'pass', exitCode: 0, output: '', finishedAt: 1 }));
    const a = makeHarnessTestingDataSource('h', 'staging');
    const b = makeHarnessTestingDataSource('h', 'staging');
    await a.startRun({ runner: 'vitest' });
    // b never started this run → its own map is empty.
    expect(await b.pollRun('shared-id')).toBeNull();
  });

  it('startRun throws HTTP <status> on a non-ok run response', async () => {
    stubFetch(async () => notOk(500));
    const ds = makeHarnessTestingDataSource('h', 'staging');
    await expect(ds.startRun({ runner: 'vitest' })).rejects.toThrow('HTTP 500');
  });
});
