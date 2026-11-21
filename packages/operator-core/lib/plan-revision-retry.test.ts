import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { assertNativePlanRetry, assertNativePlanSaveTraffic, installPlanRetryExpression, installPlanSaveObservation, lostAcknowledgement, type SaveAttempt } from '../../../apps/operator/e2e/_plan-revision-retry';

const slug = 'revision-retry-11111111-2222-4333-8444-555555555555-2026-11-21';
const workspace = 'verify-tauri-isolated-1234';
const harness = 'test-plan';
const endpoint = '/api/admin/plans/set-content';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('native Plans save observation', () => {
  const scope = { origin: 'http://127.0.0.1:18881', workspace, harness, slug: slug.replace('retry', 'citation') };
  const location = { href: scope.origin + '/adv?ws=' + workspace + '&plan=' + scope.slug };

  it('counts actual Saves when timing is absent and refuses missing, extra or unsuccessful submissions', () => {
    const accepted = { harness: 'matched', httpStatus: 200, result: 'accepted' };
    const stale = { harness: 'matched', httpStatus: 409, result: 'stale' };
    const timing = { path: endpoint };
    assertNativePlanSaveTraffic([accepted], [], false);
    assertNativePlanSaveTraffic([accepted], null, false);
    assertNativePlanSaveTraffic([accepted, stale], [timing], true);
    expect(() => assertNativePlanSaveTraffic([], [], false)).toThrow();
    expect(() => assertNativePlanSaveTraffic(null, [timing], false)).toThrow();
    expect(() => assertNativePlanSaveTraffic([accepted, accepted], [], false)).toThrow();
    expect(() => assertNativePlanSaveTraffic([accepted], [timing, timing], false)).toThrow();
    expect(() => assertNativePlanSaveTraffic([stale], [], false)).toThrow();
    expect(() => assertNativePlanSaveTraffic([{ ...accepted, harness: 'different' }], [], false)).toThrow();
  });

  it.each([
    { status: 200, body: '{"ok":true}', result: 'accepted', scopeField: { harness }, selection: 'matched' },
    { status: 409, body: '{"error":"stale"}', result: 'stale', scopeField: {}, selection: 'omitted' },
    { status: 200, body: '{"ok":false,"error":"missing_plan"}', result: 'refused', scopeField: { harness: 'other' }, selection: 'different' },
    { status: 502, body: 'Unavailable', result: 'unreadable', scopeField: { harness }, selection: 'matched' },
  ])('retains a $result response without consuming or changing it', async ({ status, body, result, scopeField, selection }) => {
    const response = new Response(body, { status });
    const transport = async (_path: string, _init: RequestInit) => response;
    const win = { fetch: transport, __planSaveObservation: undefined as undefined | (() => Promise<unknown[]>) };
    runInNewContext(installPlanSaveObservation(scope), { window: win, location, URL });
    const send = (target: string) => win.fetch(endpoint, { method: 'POST', body: JSON.stringify({ slug: target, ...scopeField }) });
    await send('another-plan');
    const delivered = await send(scope.slug);
    expect(delivered).toBe(response);
    expect(await delivered.text()).toBe(body);
    expect(await win.__planSaveObservation!()).toEqual([{ harness: selection, httpStatus: status, result }]);
    expect(win.fetch).toBe(transport);
  });

  it('distinguishes a transport rejection from a request the page never sent', async () => {
    const failure = new TypeError('connection lost');
    const transport = async (_path: string, _init: RequestInit) => { throw failure; };
    const win = { fetch: transport, __planSaveObservation: undefined as undefined | (() => Promise<unknown[]>) };
    const install = () => runInNewContext(installPlanSaveObservation(scope), { window: win, location, URL });
    install();
    expect(await win.__planSaveObservation!()).toEqual([]);
    install();
    await expect(win.fetch(endpoint, { method: 'POST', body: JSON.stringify({ slug: scope.slug, harness }) })).rejects.toBe(failure);
    expect(await win.__planSaveObservation!()).toEqual([{ harness: 'matched', httpStatus: null, result: 'transport-error' }]);
    expect(win.fetch).toBe(transport);
  });
});

describe('native Plans lost-acknowledgement fixture', () => {
  it.each(['stale', 'accepted'] as const)('retains one real write and the %s reply to its identical retry', async result => {
    const before = { version: 1, contentHash: hash('initial') };
    let current = before;
    const received: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method !== 'POST' || request.url !== endpoint) {
        response.end(JSON.stringify(current));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const submitted = JSON.parse(body);
      received.push(body);
      if (submitted.slug !== slug) {
        response.end(JSON.stringify({ ok: false, code: 'unknown_plan' }));
      } else if (submitted.expectedHash === current.contentHash && submitted.expectedVersion === current.version) {
        current = { version: current.version + 1, contentHash: hash(submitted.content) };
        response.end(JSON.stringify({ ok: true }));
      } else {
        response.statusCode = result === 'stale' ? 409 : 200;
        response.end(JSON.stringify(result === 'stale' ? { ok: false, code: 'stale' } : { ok: true }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing local fixture port');
      const origin = 'http://127.0.0.1:' + address.port;
      const transport = (path: string, init?: RequestInit) => fetch(new URL(path, origin), init);
      const win: { fetch: typeof transport; __planSaveObservation?: () => Promise<unknown[]>;
        __planRevisionRetry?: { attempts: SaveAttempt[]; finish(): SaveAttempt[] } } = { fetch: transport };
      const location = { href: origin + '/adv?ws=' + workspace + '&plan=' + slug };
      runInNewContext(installPlanSaveObservation({ origin, workspace, slug, harness }), { window: win, location, URL });
      const observedFetch = win.fetch;
      runInNewContext(installPlanRetryExpression({ origin, workspace, slug, harness }),
        { window: win, location, URL, crypto: webcrypto, TextEncoder, Uint8Array });
      expect(win.__planRevisionRetry?.attempts).toHaveLength(0);
      const body = { slug, harness, expectedHash: before.contentHash, expectedVersion: before.version, content: 'edited' };
      const send = (payload: typeof body) => win.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      expect(await (await send({ ...body, slug: 'some-other-plan' })).json()).toEqual({ ok: false, code: 'unknown_plan' });
      expect(win.__planRevisionRetry?.attempts).toHaveLength(0);

      await expect(send(body)).rejects.toThrow(lostAcknowledgement);
      const afterFirst = await (await transport('/document')).json();
      expect(win.__planRevisionRetry?.attempts).toHaveLength(1);
      const retryResponse = await send(body);
      expect(retryResponse.status).toBe(result === 'stale' ? 409 : 200);
      const afterRetry = await (await transport('/document')).json();
      expect(win.fetch).toBe(observedFetch);
      const attempts = win.__planRevisionRetry!.finish();
      expect(received.slice(1)).toEqual([JSON.stringify(body), JSON.stringify(body)]);
      expect(attempts.map(a => a.requestHash)).toEqual([hash(JSON.stringify(body)), hash(JSON.stringify(body))]);
      expect(win.__planRevisionRetry).toBeUndefined();
      const trace = { attempts, before, afterFirst, afterRetry, editorObservedLoss: true,
        editorAfterRetry: result === 'accepted' ? 'saved' as const : 'conflict' as const };
      assertNativePlanRetry(trace);
      await send(body);
      expect(received).toHaveLength(4);
      expect(attempts).toHaveLength(2);
      const submissions = await win.__planSaveObservation!();
      expect(submissions).toHaveLength(3);
      expect(() => assertNativePlanSaveTraffic(submissions, [], true)).toThrow('unexpected number');
      expect(win.fetch).toBe(transport);
      expect(() => assertNativePlanRetry({ ...trace, attempts: attempts.slice(0, 1) })).toThrow();
      expect(() => assertNativePlanRetry({ ...trace, attempts: [...attempts, attempts[1]!] })).toThrow();
      expect(() => assertNativePlanRetry({ ...trace, attempts: [attempts[0]!, { ...attempts[1]!, requestHash: hash('different') }] })).toThrow();
      expect(() => assertNativePlanRetry({ ...trace, afterRetry: { ...afterRetry, version: afterFirst.version + 1 } })).toThrow();
    } finally {
      const stopped = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await stopped;
    }
  });

  it('requires the selected private origin, workspace and plan before installing the fixture', () => {
    const scope = { origin: 'http://127.0.0.1:18881', workspace, slug, harness };
    const location = { href: scope.origin + '/adv?ws=' + workspace + '&plan=' + slug };
    for (const change of [{ origin: 'http://127.0.0.1:3170' }, { workspace: 'shared' }, { slug: 'other' }]) {
      const win = { fetch };
      expect(() => runInNewContext(installPlanRetryExpression({ ...scope, ...change }), { window: win, location, URL })).toThrow(/disposable/);
      expect(win.fetch).toBe(fetch);
    }
  });
});
