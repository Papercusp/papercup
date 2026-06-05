/**
 * Live in-process round-trip for the action-stream SSE route via Hono app.
 * Asserts the wire format on the happy path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: async () => ({
      projects: [{ slug: 'probe-slug', path: '/tmp/probe-dir-does-not-exist' }],
    }),
  };
});
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

import { Hono } from 'hono';
import { publish } from '../../branch-action-bus';
import { _resetChannelsForTest, listChannels } from '@papercusp/sse';
import { registerAllRoutes } from '../register';

let app: Hono;

function makeReq(urlSuffix = 'name=probe-action&runId=run-probe-1') {
  return app.request(`/api/harness/probe-slug/branch/staging/action-stream?${urlSuffix}`);
}

async function waitForBusSubscriber(channelKey: string, timeoutMs = 2000): Promise<void> {
  const key = `branch-action:${channelKey}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = listChannels().find((ch) => ch.key === key);
    if (c && c.syncHandlers > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`bus subscriber on ${key} never registered`);
}

async function driveStream(
  res: Response,
  channelKey: string,
  afterAttached: () => void,
  predicate: (acc: string) => boolean,
  maxBytes = 64_000,
): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let acc = '';
  let armed = false;
  while (acc.length < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
    if (!armed && /event: attached/.test(acc)) {
      armed = true;
      await waitForBusSubscriber(channelKey);
      afterAttached();
    }
    if (armed && predicate(acc)) break;
  }
  try { reader.releaseLock(); } catch { /* ignore */ }
  return acc;
}

describe('action-stream route — live bus → SSE wire', () => {
  beforeEach(() => {
    _resetChannelsForTest();
    app = new Hono().basePath('/api');
    registerAllRoutes(app);
  });

  it('emits attached, then live bus events, in publish order, with monotonic ids', { timeout: 15000 }, async () => {
    const res = await makeReq();
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const ch = 'probe-slug:run-probe-1';
    const body = await driveStream(
      res,
      ch,
      () => {
        publish(ch, 'started', '', { runId: 'run-probe-1' });
        publish(ch, 'output', 'line-1\n');
        publish(ch, 'stderr', 'oops\n');
        publish(ch, 'completed', '', { exitCode: 0 });
      },
      (s) => /event: done/.test(s),
    );

    expect(body).toMatch(/id: 1\nevent: attached\ndata: \{"runId":"run-probe-1","slug":"probe-slug","branch":"staging","name":"probe-action"\}/);
    expect(body).toContain('event: action-started');
    expect(body).toMatch(/event: output\ndata: \{"line":"line-1"\}/);
    expect(body).toMatch(/event: stderr\ndata: \{"line":"oops"\}/);
    expect(body).toContain('event: action-completed');
    expect(body).toMatch(/event: done\ndata: \{"reason":"terminal","kind":"completed"\}/);

    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids[0]).toBe(1);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('publish-after-terminal does not deliver further frames', async () => {
    const res = await makeReq();
    const ch = 'probe-slug:run-probe-1';
    const body = await driveStream(
      res,
      ch,
      () => {
        publish(ch, 'started', '');
        publish(ch, 'failed', '', { exitCode: 7 });
        try { publish(ch, 'output', 'should-be-dropped'); } catch { /* expected */ }
      },
      (s) => /event: done/.test(s),
    );
    expect(body).toContain('event: action-failed');
    expect(body).toContain('event: done');
    expect(body).not.toContain('should-be-dropped');
  });

  it('rejects an invalid branch with 400', async () => {
    const res = await app.request('/api/harness/probe-slug/branch/bogus/action-stream?name=probe&runId=run-probe-1');
    expect(res.status).toBe(400);
  });

  it('rejects a missing runId with 400', async () => {
    const res = await app.request('/api/harness/probe-slug/branch/staging/action-stream?name=probe');
    expect(res.status).toBe(400);
  });
});
