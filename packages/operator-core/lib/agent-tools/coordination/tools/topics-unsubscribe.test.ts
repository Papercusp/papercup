/**
 * topics-unsubscribe.test.ts — the topics:unsubscribe HANDLER (unsubscribeTopic mocked).
 * Thin but pins that the handler resolves the caller's identity and unsubscribes THAT
 * identity from the named topic, echoing it back (the op is idempotent). A regression
 * that unsubscribes the wrong identity is what this catches.
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

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('topics:unsubscribe handler', () => {
  it('unsubscribes the caller identity from the topic and echoes it', async () => {
    const out = (await tool.handler({ topic: 'arch' } as never, {} as never)) as Out;
    expect(unsubM).toHaveBeenCalledWith({ ownerId: 'me' }, 'arch');
    expect(body(out)).toMatchObject({ ok: true, topic: 'arch' });
  });
});
