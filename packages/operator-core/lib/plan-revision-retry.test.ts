import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { assertNativePlanRetry, installPlanRetryExpression, lostAcknowledgement, type SaveAttempt } from '../../../apps/operator/e2e/_plan-revision-retry';

const slug = 'revision-retry-11111111-2222-4333-8444-555555555555-2026-11-21';
const workspace = 'verify-tauri-isolated-1234';
const harness = 'test-plan';
const endpoint = '/api/admin/plans/set-content';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

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
      const win: { fetch: typeof transport; __planRevisionRetry?: { attempts: SaveAttempt[]; finish(): SaveAttempt[] } } = { fetch: transport };
      const location = { href: origin + '/adv?ws=' + workspace + '&plan=' + slug };
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
      expect(win.fetch).toBe(transport);
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
