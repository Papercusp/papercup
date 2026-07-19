/**
 * message-agent.test.ts — the coord:message-agent HANDLER (EI-58). Pins:
 *   • no `to` → opens a harness-scoped conversation with NO ping (D-005
 *     graceful degradation) — notifyAgents is never called;
 *   • a single `to` → opens the conversation, then reaches that one agent via
 *     notifyAgents with the right objectRef/summary/body (item_ref+plan_slug
 *     folded into the summary; wake defaults to unset/false);
 *   • an array `to` → ONE thread, all addressees passed to notifyAgents in one
 *     call (not one notifyAgents call per addressee);
 *   • `wake:true` is threaded through to notifyAgents.
 *
 * `openConversation` (../conversations) and `notifyAgents` (../notify-agents)
 * are mocked at the module boundary — the same pattern already used by 8
 * sibling tests (conversations-post.test.ts, conversations-join.test.ts, …).
 * Because vi.mock replaces the module before its own imports evaluate, this
 * never touches the real `@papercusp/db-org` chain — no separate deps-injection
 * seam is needed to unit-test this handler's shaping logic.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/message-agent.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me' })) }));
vi.mock('../conversations', () => ({ openConversation: vi.fn() }));
vi.mock('../notify-agents', () => ({ notifyAgents: vi.fn() }));

import { openConversation } from '../conversations';
import { notifyAgents } from '../notify-agents';
const openM = vi.mocked(openConversation);
const notifyM = vi.mocked(notifyAgents);
const tool = (await import('./message-agent')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) =>
  tool.handler({ body: 'hello', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  openM.mockResolvedValue({ conversation: { id: 'c1' }, thread_id: 't1' } as never);
  notifyM.mockResolvedValue({ notified: [], subscribed: [], woke: 0 });
});

describe('coord:message-agent handler', () => {
  it('no `to` opens a harness-scoped conversation with no ping (D-005)', async () => {
    const b = body(await call({ harness: 'papercusp' }));
    expect(openM).toHaveBeenCalledWith(
      { ownerId: 'me', ownerLabel: 'Me' },
      expect.objectContaining({ kind: 'discussion', body: 'hello', harness_slug: 'papercusp' }),
    );
    expect(notifyM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, conversation_id: 'c1', thread_id: 't1', to: [], notified: [], subscribed: [], woke: 0 });
  });

  it('a single `to` reaches that one agent via notifyAgents on the new conversation', async () => {
    notifyM.mockResolvedValue({ notified: ['peer-1'], subscribed: ['peer-1'], woke: 0 });
    const b = body(await call({ to: 'peer-1', item_ref: 'P-9', plan_slug: 'plan-x' }));
    expect(notifyM).toHaveBeenCalledTimes(1);
    expect(notifyM).toHaveBeenCalledWith(
      { ownerId: 'me', ownerLabel: 'Me' },
      expect.objectContaining({
        addressees: ['peer-1'],
        objectRef: { kind: 'conversation', ref: 'c1' },
        summary: expect.stringContaining('plan-x P-9'),
        planSlug: 'plan-x',
      }),
    );
    expect(notifyM.mock.calls[0]![1]).not.toHaveProperty('wake');
    expect(b).toMatchObject({ ok: true, to: ['peer-1'], notified: ['peer-1'], subscribed: ['peer-1'] });
  });

  it('an array `to` opens ONE thread and reaches all addressees in a single notifyAgents call', async () => {
    notifyM.mockResolvedValue({ notified: ['peer-1', 'peer-2'], subscribed: ['peer-1', 'peer-2'], woke: 0 });
    const b = body(await call({ to: ['peer-1', 'peer-2'] }));
    expect(openM).toHaveBeenCalledTimes(1);
    expect(notifyM).toHaveBeenCalledTimes(1);
    expect(notifyM).toHaveBeenCalledWith(
      { ownerId: 'me', ownerLabel: 'Me' },
      expect.objectContaining({ addressees: ['peer-1', 'peer-2'] }),
    );
    expect(b.to).toEqual(['peer-1', 'peer-2']);
  });

  it('wake:true is threaded through to notifyAgents', async () => {
    await call({ to: 'peer-1', wake: true });
    expect(notifyM).toHaveBeenCalledWith({ ownerId: 'me', ownerLabel: 'Me' }, expect.objectContaining({ wake: true }));
  });
});
