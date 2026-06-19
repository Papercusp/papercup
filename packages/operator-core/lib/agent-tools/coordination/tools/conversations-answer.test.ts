/**
 * conversations-answer.test.ts — the conversations:answer HANDLER shaping
 * (answerQuestion is mocked). Pins the store-error → { ok:false, reason } mapping and
 * the success shaping, including the hint that interpolates the new post_id into the
 * conversations:resolve { accepted_post_id } call the asker will make. A regression
 * that loses the error mapping or the post_id wiring in the hint is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-answer.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ answerQuestion: vi.fn() }));

import { answerQuestion } from '../conversations';
const answerM = vi.mocked(answerQuestion);
const tool = (await import('./conversations-answer')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ conversation_id: 'c1', body: 'the answer', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('conversations:answer handler', () => {
  it('maps a store error to { ok:false, reason }', async () => {
    answerM.mockResolvedValue({ error: 'not_a_question' } as never);
    expect(body(await call())).toMatchObject({ ok: false, reason: 'not_a_question' });
  });

  it('on success reports post_id, subscribers, and a resolve hint wired to the post_id', async () => {
    answerM.mockResolvedValue({ post: { id: 42 }, delivered: 2 } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, conversation_id: 'c1', post_id: 42, notified_subscribers: 2 });
    expect(String(b.hint)).toContain('accepted_post_id: 42');
  });
});
