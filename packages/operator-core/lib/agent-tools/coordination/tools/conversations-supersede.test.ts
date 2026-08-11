/** Handler shaping for conversations:supersede. The production workflow is
 * mocked here; core lifecycle and atomic row semantics live in
 * conversations-core.test.ts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ supersedeConversation: vi.fn() }));

import { supersedeConversation } from '../conversations';
const supersedeM = vi.mocked(supersedeConversation);
const tool = (await import('./conversations-supersede')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => vi.clearAllMocks());

describe('conversations:supersede handler', () => {
  it('maps a lifecycle error to the item instead of failing the whole call', async () => {
    supersedeM.mockResolvedValue({ error: 'already_superseded' } as never);
    const result = await body({
      id: 'conv-old',
      replacement: { body: 'corrected question' },
    });
    expect(result).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(result.results[0]).toMatchObject({ ok: false, id: 'conv-old', error: 'already_superseded' });
  });

  it('returns the RETRACTED pointer and replacement thread id', async () => {
    supersedeM.mockResolvedValue({
      conversation: { id: 'conv-old', state: 'superseded', superseded_by: 'conv-new' },
      replacement: { conversation: { id: 'conv-new', state: 'open' }, thread_id: 'thr-conv-new' },
      delivered: 2,
    } as never);
    const result = await body({
      id: 'conv-old',
      replacement: { body: 'corrected question', topics: ['release'] },
      reason: 'old premise falsified',
    });
    expect(result).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(result.results[0]).toMatchObject({
      ok: true,
      id: 'conv-old',
      state: 'superseded',
      superseded_by: 'conv-new',
      replacement: { id: 'conv-new', state: 'open', thread_id: 'thr-conv-new' },
      notified_subscribers: 2,
    });
    expect(supersedeM).toHaveBeenCalledWith({ ownerId: 'me' }, {
      conversation_id: 'conv-old',
      replacement: { body: 'corrected question', topics: ['release'] },
      reason: 'old premise falsified',
    });
  });
});
