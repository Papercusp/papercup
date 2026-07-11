/**
 * unsubscribe.test.ts — the events:unsubscribe HANDLER (WI-4014 Part 2), bulk by
 * default, mirroring topics-unsubscribe.test.ts's pattern. unsubscribeEventKey is
 * mocked at the module seam; identity faked; the handler + its zod schema run REAL.
 * Pins that the handler resolves the caller's identity and unsubscribes THAT
 * identity from each named event key (idempotent), single ({ key }) is n=1 of the
 * envelope, many ({ keys:[…] } / items:[…]) fan over each key, every result
 * self-describes its `key`, and one failing key NEVER fails the rest.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/events/unsubscribe.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../coordination/event-subscriptions', () => ({ unsubscribeEventKey: vi.fn() }));

import { unsubscribeEventKey } from '../coordination/event-subscriptions';
const unsubM = vi.mocked(unsubscribeEventKey);
const tool = (await import('./unsubscribe')).default;

type Out = { data: any };
const call = (args: Record<string, unknown>) =>
  tool.handler(tool.args.parse(args) as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data;

beforeEach(() => vi.clearAllMocks());

describe('events:unsubscribe handler (bulk)', () => {
  it('single { key } unsubscribes the caller identity and returns an n=1 envelope', async () => {
    const b = body(await call({ key: 'lock:grant:t1' }));
    expect(unsubM).toHaveBeenCalledWith({ ownerId: 'me' }, 'lock:grant:t1');
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results).toEqual([{ ok: true, key: 'lock:grant:t1' }]);
  });

  it('many { keys:[…] } unsubscribes each, self-describing by key', async () => {
    const b = body(await call({ keys: ['a', 'b'] }));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { key: string }) => r.key)).toEqual(['a', 'b']);
    expect(unsubM).toHaveBeenCalledWith({ ownerId: 'me' }, 'a');
    expect(unsubM).toHaveBeenCalledWith({ ownerId: 'me' }, 'b');
  });

  it('items:[{ key }] unsubscribes each too (heterogeneous shorthand)', async () => {
    const b = body(await call({ items: [{ key: 'x' }, { key: 'y' }] }));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(unsubM).toHaveBeenCalledWith({ ownerId: 'me' }, 'x');
    expect(unsubM).toHaveBeenCalledWith({ ownerId: 'me' }, 'y');
  });

  it('one failing key NEVER fails the rest', async () => {
    unsubM.mockImplementation(async (_id, key) => {
      if (key === 'bad') throw new Error('boom');
    });
    const b = body(await call({ items: [{ key: 'good' }, { key: 'bad' }] }));
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    const byKey = Object.fromEntries(b.results.map((r: { key: string }) => [r.key, r]));
    expect(byKey.good).toMatchObject({ ok: true, key: 'good' });
    expect(byKey.bad).toMatchObject({ ok: false, key: 'bad', error: 'boom' });
  });

  it('unsubscribing from a key you do not follow is idempotent (no-op resolves ok)', async () => {
    unsubM.mockResolvedValueOnce(undefined); // store.unsubscribe is itself a soft no-op
    const b = body(await call({ key: 'never-followed' }));
    expect(b.ok).toBe(true);
    expect(b.results).toEqual([{ ok: true, key: 'never-followed' }]);
  });

  it('rejects an empty call (no key / keys / items) at the zod boundary', () => {
    expect(() => tool.args.parse({})).toThrow();
  });
});
