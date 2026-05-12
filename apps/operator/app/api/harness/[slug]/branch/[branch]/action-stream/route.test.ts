/**
 * Live in-process round-trip for the action-stream SSE route:
 *
 *   branch-action-bus.publish()  →  sseResponse sink.event()  →  response body bytes
 *
 * Asserts the wire format on the happy path (started → output → completed →
 * terminal close), without spawning anything or touching the dev server.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { publish } from '@/lib/branch-action-bus';
import { _resetChannelsForTest, listChannels } from '@restart/sse';

vi.mock('@/lib/harness-registry', () => ({
  loadHarnessRegistry: async () => ({
    projects: [{ slug: 'probe-slug', path: '/tmp/probe-dir-does-not-exist' }],
  }),
}));

import { GET } from './route';

function makeReq(): { req: Request; abort: () => void } {
  const controller = new AbortController();
  const req = new Request(
    'http://x.test/api/harness/probe-slug/branch/staging/action-stream?name=probe-action&runId=run-probe-1',
    { signal: controller.signal },
  );
  return { req, abort: () => controller.abort() };
}

/** Wait until the branch-action channel has at least one sync subscriber. */
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

/**
 * Helper: open the stream, wait for `attached` AND for the bus subscription
 * to be live (route.setup is async — fs.readFile resolves AFTER attached is
 * enqueued), then run publishFn, then read until predicate matches.
 */
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
  beforeEach(() => { _resetChannelsForTest(); });

  it('emits attached, then live bus events, in publish order, with monotonic ids', { timeout: 15000 }, async () => {
    const { req } = makeReq();
    const res = await GET(req, { params: Promise.resolve({ slug: 'probe-slug', branch: 'staging' }) });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const ch = 'probe-slug:run-probe-1';
    const body = await driveStream(
      res,
      ch,
      () => {
        // Bus subscription is live now; sync onPublish delivers each call inline.
        publish(ch, 'started', '', { runId: 'run-probe-1' });
        publish(ch, 'output', 'line-1\n');
        publish(ch, 'stderr', 'oops\n');
        publish(ch, 'completed', '', { exitCode: 0 });
      },
      (s) => /event: done/.test(s),
    );

    // Wire-format checks:
    expect(body).toMatch(/id: 1\nevent: attached\ndata: \{"runId":"run-probe-1","slug":"probe-slug","branch":"staging","name":"probe-action"\}/);
    expect(body).toContain('event: action-started');
    expect(body).toMatch(/event: output\ndata: \{"line":"line-1"\}/);
    expect(body).toMatch(/event: stderr\ndata: \{"line":"oops"\}/);
    expect(body).toContain('event: action-completed');
    expect(body).toMatch(/event: done\ndata: \{"reason":"terminal","kind":"completed"\}/);

    // Monotonic id ladder (1..N) — attached is id 1, then one id per bus event.
    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids[0]).toBe(1);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('publish-after-terminal does not deliver further frames', async () => {
    const { req } = makeReq();
    const res = await GET(req, { params: Promise.resolve({ slug: 'probe-slug', branch: 'staging' }) });

    const ch = 'probe-slug:run-probe-1';
    const body = await driveStream(
      res,
      ch,
      () => {
        publish(ch, 'started', '');
        publish(ch, 'failed', '', { exitCode: 7 });
        // bus.publish() after 'failed' (terminal) throws since branch-action-bus
        // calls ch.done() on failed. Catch + verify the wire shows the failure.
        try { publish(ch, 'output', 'should-be-dropped'); } catch { /* expected */ }
      },
      (s) => /event: done/.test(s),
    );
    expect(body).toContain('event: action-failed');
    expect(body).toContain('event: done');
    expect(body).not.toContain('should-be-dropped');
  });

  it('rejects an invalid branch with 400', async () => {
    const { req } = makeReq();
    const res = await GET(req, { params: Promise.resolve({ slug: 'probe-slug', branch: 'bogus' as 'staging' }) });
    expect(res.status).toBe(400);
  });

  it('rejects a missing runId with 400', async () => {
    const controller = new AbortController();
    const req = new Request(
      'http://x.test/api/harness/probe-slug/branch/staging/action-stream?name=probe',
      { signal: controller.signal },
    );
    const res = await GET(req, { params: Promise.resolve({ slug: 'probe-slug', branch: 'staging' }) });
    expect(res.status).toBe(400);
  });
});
