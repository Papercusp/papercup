/**
 * topics-subscribe.test.ts — the topics:subscribe HANDLER, bulk-standardized
 * (bulk-endpoint-standardization-2026-06-21, Phase 4). subscribeTopic is mocked at
 * the module seam; identity faked; the handler + its zod schema run REAL. Pins the
 * keyed-array contract: single ({ topic }) is n=1 of the same envelope, homogeneous
 * (topics:[…]+mode) fans the SAME mode/ttl over each topic, heterogeneous
 * (items:[…]) carries per-item mode/ttl, every result self-describes its `topic`,
 * and one failing topic NEVER fails the rest (top-level ok stays true; counts.failed
 * tells the truth).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/topics-subscribe.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionRow } from '@papercusp/coordination/capabilities';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../topics', () => ({ subscribeTopic: vi.fn() }));

import { subscribeTopic } from '../topics';
const subM = vi.mocked(subscribeTopic);
const tool = (await import('./topics-subscribe')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) =>
  tool.handler(tool.args.parse(args) as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

const sub = (target_ref: string, over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: 1,
  subscriber_id: 'me',
  target_kind: 'topic',
  target_ref,
  delivery_mode: 'full',
  created_ts: '2026-06-22T00:00:00.000Z',
  expires_ts: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  subM.mockImplementation(async (_id, slug, opts) =>
    sub(slug as string, { delivery_mode: (opts?.mode ?? 'full') as never }),
  );
});

describe('topics:subscribe handler (bulk)', () => {
  it('single { topic } returns an n=1 envelope keyed by topic', async () => {
    const b = body(await call({ topic: 'arch', mode: 'digest', ttl_sec: 3600 }));
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results).toEqual([
      { ok: true, topic: 'arch', subscription: { topic: 'arch', mode: 'digest', expires_ts: null } },
    ]);
    expect(subM).toHaveBeenCalledWith({ ownerId: 'me' }, 'arch', { mode: 'digest', ttl_sec: 3600 });
  });

  it('homogeneous { topics:[…], mode } fans the SAME mode over each topic', async () => {
    const b = body(await call({ topics: ['a', 'b'], mode: 'mention' }));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { topic: string }) => r.topic)).toEqual(['a', 'b']);
    expect(subM).toHaveBeenCalledWith({ ownerId: 'me' }, 'a', { mode: 'mention', ttl_sec: undefined });
    expect(subM).toHaveBeenCalledWith({ ownerId: 'me' }, 'b', { mode: 'mention', ttl_sec: undefined });
  });

  it('heterogeneous items:[…] carry per-item mode (item wins over batch default)', async () => {
    const b = body(await call({ mode: 'full', items: [{ topic: 'x', mode: 'digest' }, { topic: 'y' }] }));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(subM).toHaveBeenCalledWith({ ownerId: 'me' }, 'x', { mode: 'digest', ttl_sec: undefined });
    expect(subM).toHaveBeenCalledWith({ ownerId: 'me' }, 'y', { mode: 'full', ttl_sec: undefined });
  });

  it('one failing topic NEVER fails the rest — partial failure self-describes by topic', async () => {
    subM.mockImplementation(async (_id, slug) => {
      if (slug === 'bad') throw new Error('boom');
      return sub(slug as string);
    });
    const b = body(await call({ topics: ['good', 'bad'] }));
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    const byTopic = Object.fromEntries(b.results.map((r: { topic: string }) => [r.topic, r]));
    expect(byTopic.good.ok).toBe(true);
    expect(byTopic.bad).toMatchObject({ ok: false, topic: 'bad', error: 'boom' });
  });

  it('rejects an empty call (no topic / topics / items) at the zod boundary', () => {
    expect(() => tool.args.parse({})).toThrow();
  });

  it('rejects an invalid mode at the zod boundary (full|digest|mention only)', () => {
    expect(() => tool.args.parse({ topic: 'x', mode: 'loud' })).toThrow();
  });
});
