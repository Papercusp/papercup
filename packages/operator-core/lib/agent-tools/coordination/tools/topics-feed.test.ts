/**
 * topics-feed.test.ts — the topics:feed HANDLER (a READ), bulk-standardized
 * (bulk-endpoint-standardization-2026-06-21, Phase 4). topicFeed is mocked at the
 * module seam; identity faked; the handler + its zod schema run REAL. Pins the
 * keyed-array contract for a read: single ({ topic }) is n=1, many ({ topics:[…] }
 * / items:[…]) read each topic's own feed, every result self-describes its `topic`
 * + carries that topic's feed (count + items), and a topic that fails to read NEVER
 * fails the rest (top-level ok stays true; counts.failed tells the truth).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/topics-feed.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../../topics-feed', () => ({ topicFeed: vi.fn() }));

import { topicFeed } from '../../../topics-feed';
const feedM = vi.mocked(topicFeed);
const tool = (await import('./topics-feed')).default;

type Out = { data: any };
const call = (args: Record<string, unknown>) =>
  tool.handler(tool.args.parse(args) as never, {} as never) as Promise<Out>;
const body = (o: Out) => (o.data);

const item = (ref: string) => ({ kind: 'feature', ref, title: ref, state: 'open' });

beforeEach(() => {
  vi.clearAllMocks();
  feedM.mockResolvedValue([] as never);
});

describe('topics:feed handler (bulk)', () => {
  it('single { topic } returns an n=1 envelope carrying that topic feed', async () => {
    feedM.mockResolvedValue([item('F-1'), item('F-2')] as never);
    const b = body(await call({ topic: 'arch' }));
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results).toEqual([
      { ok: true, topic: 'arch', count: 2, items: [item('F-1'), item('F-2')] },
    ]);
    expect(feedM).toHaveBeenCalledWith('arch');
  });

  it('many { topics:[…] } reads each topic feed, self-describing by topic', async () => {
    feedM.mockImplementation(async (t: string) => (t === 'a' ? [item('F-9')] : []) as never);
    const b = body(await call({ topics: ['a', 'b'] }));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    const byTopic = Object.fromEntries(b.results.map((r: { topic: string }) => [r.topic, r]));
    expect(byTopic.a).toMatchObject({ ok: true, topic: 'a', count: 1 });
    expect(byTopic.b).toMatchObject({ ok: true, topic: 'b', count: 0, items: [] });
  });

  it('a topic that fails to read NEVER fails the rest', async () => {
    feedM.mockImplementation(async (t: string) => {
      if (t === 'bad') throw new Error('read failed');
      return [item('F-3')] as never;
    });
    const b = body(await call({ items: [{ topic: 'good' }, { topic: 'bad' }] }));
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    const byTopic = Object.fromEntries(b.results.map((r: { topic: string }) => [r.topic, r]));
    expect(byTopic.good).toMatchObject({ ok: true, topic: 'good', count: 1 });
    expect(byTopic.bad).toMatchObject({ ok: false, topic: 'bad', error: 'read failed' });
  });

  it('rejects an empty call (no topic / topics / items) at the zod boundary', () => {
    expect(() => tool.args.parse({})).toThrow();
  });
});
