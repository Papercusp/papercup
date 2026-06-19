/**
 * conversations-promote.test.ts — the conversations:promote HANDLER shaping
 * (promoteConversation, which mints the issue + re-parents the thread, is mocked).
 * Pins the store-error → { ok:false, reason } mapping and the success shaping: the
 * minted issue, thread_carried flag, and the hint that interpolates the new issue id
 * into the issues:comment follow-up. A regression that loses the error mapping or the
 * issue-id wiring is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-promote.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ promoteConversation: vi.fn() }));

import { promoteConversation } from '../conversations';
const promoteM = vi.mocked(promoteConversation);
const tool = (await import('./conversations-promote')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ conversation_id: 'c1', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('conversations:promote handler', () => {
  it('maps a store error to { ok:false, reason }', async () => {
    promoteM.mockResolvedValue({ error: 'not_found' } as never);
    expect(body(await call())).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('on success surfaces the issue, thread_carried, and an issues:comment hint', async () => {
    promoteM.mockResolvedValue({
      conversation: { id: 'c1', state: 'promoted' },
      issue: { id: 'EI-9' },
      thread_reparented: true,
      delivered: 3,
    } as never);
    const b = body(await call({ severity: 'major' }));
    expect(b).toMatchObject({
      ok: true, conversation_id: 'c1', state: 'promoted',
      issue: { id: 'EI-9' }, thread_carried: true, notified_subscribers: 3,
    });
    expect(String(b.hint)).toContain('EI-9');
    // severity passed through to the store
    expect(promoteM.mock.calls[0]![1]).toMatchObject({ conversation_id: 'c1', severity: 'major' });
  });
});
