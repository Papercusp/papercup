/**
 * topics-unsubscribe.test.ts — the topics:unsubscribe HANDLER, bulk-standardized
 * (bulk-endpoint-standardization-2026-06-21, Phase 4). unsubscribeTopic is mocked at
 * the module seam; identity faked; the handler + its zod schema run REAL. Pins that
 * the handler resolves the caller's identity and unsubscribes THAT identity from each
 * named topic (idempotent), single ({ topic }) is n=1 of the envelope, many
 * ({ topics:[…] } / items:[…]) fan over each topic, every result self-describes its
 * `topic`, and one failing topic NEVER fails the rest. A regression that unsubscribes
 * the wrong identity is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/topics-unsubscribe.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../topics', () => ({ unsubscribeTopic: vi.fn() }));

import { unsubscribeTopic } from '../topics';
const unsubM = vi.mocked(unsubscribeTopic);
const tool = (await import('./topics-unsubscribe')).default;

type Out = { data: any };
const call = (args: Record<string, unknown>) =>
  tool.handler(tool.args.parse(args) as never, {} as never) as Promise<Out>;
const body = (o: Out) => (o.data);

beforeEach(() => vi.clearAllMocks());

describe('topics:unsubscribe handler (bulk)', () => {
  it('single { topic } unsubscribes the caller identity and returns an n=1 envelope', async () => {
    const b = body(await call({ topic: 'arch' }));
    expect(unsubM).toHaveBeenCalledWith({ ownerId: 'me' }, 'arch');
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results).toEqual([{ ok: true, topic: 'arch' }]);
  });

  it('many { topics:[…] } unsubscribes each, self-describing by topic', async () => {
    const b = body(await call({ topics: ['a', 'b'] }));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { topic: string }) => r.topic)).toEqual(['a', 'b']);
    expect(unsubM).toHaveBeenCalledWith({ ownerId: 'me' }, 'a');
    expect(unsubM).toHaveBeenCalledWith({ ownerId: 'me' }, 'b');
  });

  it('one failing topic NEVER fails the rest', async () => {
    unsubM.mockImplementation(async (_id, slug) => {
      if (slug === 'bad') throw new Error('boom');
    });
    const b = body(await call({ items: [{ topic: 'good' }, { topic: 'bad' }] }));
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    const byTopic = Object.fromEntries(b.results.map((r: { topic: string }) => [r.topic, r]));
    expect(byTopic.good).toMatchObject({ ok: true, topic: 'good' });
    expect(byTopic.bad).toMatchObject({ ok: false, topic: 'bad', error: 'boom' });
  });

  it('rejects an empty call (no topic / topics / items) at the zod boundary', () => {
    expect(() => tool.args.parse({})).toThrow();
  });
});
