/**
 * conversations-join.test.ts — the conversations:join HANDLER branch + shaping
 * (join/leaveConversation are mocked). Pins the leave-vs-join branch (leave:true routes
 * to leaveConversation and does NOT join), the store-error → { ok:false, reason }
 * mapping, and the success shaping (echoes the resolved delivery mode). A regression
 * that loses the leave branch or the mode echo is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-join.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ joinConversation: vi.fn(), leaveConversation: vi.fn() }));

import { joinConversation, leaveConversation } from '../conversations';
const joinM = vi.mocked(joinConversation);
const leaveM = vi.mocked(leaveConversation);
const tool = (await import('./conversations-join')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ conversation_id: 'c1', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('conversations:join handler', () => {
  it('leave:true routes to leaveConversation and does not join', async () => {
    const b = body(await call({ leave: true }));
    expect(leaveM).toHaveBeenCalledWith({ ownerId: 'me' }, 'c1');
    expect(b).toMatchObject({ ok: true, left: 'c1' });
    expect(joinM).not.toHaveBeenCalled();
  });

  it('maps a join store error to { ok:false, reason }', async () => {
    joinM.mockResolvedValue({ error: 'not_found' } as never);
    expect(body(await call({ mode: 'full' }))).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('on success echoes the resolved delivery mode', async () => {
    joinM.mockResolvedValue({ mode: 'digest' } as never);
    const b = body(await call({ mode: 'digest' }));
    expect(b).toMatchObject({ ok: true, conversation_id: 'c1', mode: 'digest' });
  });
});
