/**
 * conversations-get.test.ts — the conversations:get HANDLER projection (getConversation
 * is mocked). Pins the not_found mapping and the deliberate field-subset projection: the
 * conversation's chosen fields are surfaced, and each post is projected to exactly
 * {id, author_id, body, created_ts} (extra store columns are dropped, not leaked). A
 * regression that leaks/loses a field or drops the not_found guard is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-get.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../conversations', () => ({ getConversation: vi.fn() }));

import { getConversation } from '../conversations';
const getM = vi.mocked(getConversation);
const tool = (await import('./conversations-get')).default;

type Out = { content: { text: string }[] };
const call = (id = 'c1') => tool.handler({ conversation_id: id } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('conversations:get handler', () => {
  it('maps a missing conversation to { ok:false, reason:not_found }', async () => {
    getM.mockResolvedValue(null as never);
    expect(body(await call())).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('projects the conversation fields, topics, count, and trims post fields', async () => {
    getM.mockResolvedValue({
      conversation: {
        id: 'c1', kind: 'question', state: 'resolved', scope: 'global', harness_slug: null,
        title: 'How?', body: 'the seed', asker_id: 'a1', accepted_answer: 'do X',
        accepted_post_id: 9, capture_target: 'mem0', promoted_issue_id: null,
        created_ts: 't0', resolved_ts: 't1',
      },
      topics: ['arch'],
      subscriber_count: 2,
      posts: [{ id: 1, author_id: 'b1', body: 'reply', created_ts: 't2', secret: 'DROP_ME' }],
    } as never);
    const b = body(await call());
    expect(b).toMatchObject({
      ok: true,
      conversation: { id: 'c1', kind: 'question', state: 'resolved', accepted_post_id: 9, capture_target: 'mem0' },
      topics: ['arch'],
      subscriber_count: 2,
    });
    expect(b.posts).toEqual([{ id: 1, author_id: 'b1', body: 'reply', created_ts: 't2' }]);
    expect(b.posts[0]).not.toHaveProperty('secret'); // extra store columns are not leaked
  });
});
