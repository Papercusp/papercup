/**
 * conversations-resolve.test.ts — the conversations:resolve HANDLER guard + shaping
 * (resolveConversation, which closes the thread + captures the answer to mem0, is
 * mocked). This pins the handler's own logic:
 *   • the required-arg guard — accepted_answer OR accepted_post_id is mandatory; without
 *     either it refuses WITHOUT touching the store (you can't resolve with no answer);
 *   • the store-error → { ok:false, reason } mapping;
 *   • the success shaping (state + captured + notified_subscribers).
 * A regression that drops the guard (resolving an empty answer) or loses the capture
 * surfacing is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-resolve.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ resolveConversation: vi.fn() }));

import { resolveConversation } from '../conversations';
const resolveM = vi.mocked(resolveConversation);
const tool = (await import('./conversations-resolve')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) =>
  tool.handler({ conversation_id: 'c1', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('conversations:resolve handler', () => {
  it('requires an accepted answer or post id — refuses without touching the store', async () => {
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: false, reason: 'need_accepted_answer_or_post_id' });
    expect(resolveM).not.toHaveBeenCalled();
  });

  it('maps a store error to { ok:false, reason }', async () => {
    resolveM.mockResolvedValue({ error: 'not_found' } as never);
    const b = body(await call({ accepted_post_id: 7 }));
    expect(b).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('on success reports state, capture target, and notified subscribers', async () => {
    resolveM.mockResolvedValue({
      conversation: { id: 'c1', state: 'resolved' }, capture: 'mem0', delivered: 4,
    } as never);
    const b = body(await call({ accepted_answer: 'do it this way' }));
    expect(b).toMatchObject({
      ok: true, conversation_id: 'c1', state: 'resolved', captured: 'mem0', notified_subscribers: 4,
    });
    // the accepted answer reached the store
    expect(resolveM.mock.calls[0]![1]).toMatchObject({ conversation_id: 'c1', accepted_answer: 'do it this way' });
  });
});
