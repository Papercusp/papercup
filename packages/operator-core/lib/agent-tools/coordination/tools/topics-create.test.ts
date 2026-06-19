/**
 * topics-create.test.ts — the topics:create HANDLER projection (createTopic mocked).
 * Pins the result shaping: the topic subset, the `created` flag (true for a genuinely
 * new topic, false for a no-op re-create of an existing slug), and the
 * new_topic_subscribers_notified count. A regression that mislabels a re-create as
 * created (spuriously notifying subscribers) is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/topics-create.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../topics', () => ({ createTopic: vi.fn() }));

import { createTopic } from '../topics';
const createM = vi.mocked(createTopic);
const tool = (await import('./topics-create')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ slug: 'federation', description: 'cross-hive stuff', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('topics:create handler', () => {
  it('reports created:true and the notified count for a new topic', async () => {
    createM.mockResolvedValue({
      topic: { slug: 'federation', title: 'Federation', description: 'cross-hive stuff' },
      created: true, notified: 4,
    } as never);
    const b = body(await call());
    expect(b).toMatchObject({
      ok: true,
      topic: { slug: 'federation', title: 'Federation', description: 'cross-hive stuff' },
      created: true,
      new_topic_subscribers_notified: 4,
    });
  });

  it('reports created:false for a no-op re-create of an existing slug', async () => {
    createM.mockResolvedValue({
      topic: { slug: 'federation', title: null, description: 'existing' },
      created: false, notified: 0,
    } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, created: false, new_topic_subscribers_notified: 0 });
  });
});
