/**
 * notify-agents.test.ts — the shared reach-core (coordination-unification P-005).
 * Mocks the four collaborators (subscription store, sendMessage, wakeRecipients,
 * recipient-resolve) and asserts the resolve→subscribe→ping→wake contract:
 * multi-recipient, self-skip + dedupe, short-id resolution, opt-in active wake,
 * and the empty no-op. objectToTargetRef runs for real (a pure ref encoder).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIdentity } from './identity';

const h = vi.hoisted(() => ({
  subscribe: vi.fn(async (_args: unknown) => {}),
  send: vi.fn(async (_id: unknown, _msg: { to: string[] }) => ({})),
  wake: vi.fn(async (_to: readonly string[], _opts: unknown) => ({ woken: 0 })),
  resolve: vi.fn(async (ids: readonly string[]) => [...ids]),
}));

vi.mock('./subscription-store', () => ({ getCoordSubscriptionStore: () => ({ subscribe: h.subscribe }) }));
vi.mock('./messages', () => ({ sendMessage: h.send }));
vi.mock('./inbox-wake', () => ({ wakeRecipients: h.wake }));
vi.mock('./recipient-resolve', () => ({ resolveBestEffortAgainstRoster: h.resolve }));

import { notifyAgents } from './notify-agents';

const identity = { ownerId: 'me', ownerLabel: 'Me', workspaceId: 'ws1', source: 'static-client' } as unknown as AgentIdentity;
const objectRef = { kind: 'issue', ref: 'EI-1' };

beforeEach(() => {
  h.subscribe.mockClear();
  h.send.mockClear();
  h.wake.mockClear().mockImplementation(async () => ({ woken: 0 }));
  h.resolve.mockClear().mockImplementation(async (ids: readonly string[]) => [...ids]);
});

describe('notifyAgents (reach-core)', () => {
  it('subscribes + pings each addressee on the object; returns notified+subscribed', async () => {
    const r = await notifyAgents(identity, { addressees: ['a', 'b'], objectRef, summary: 's', body: 'bod' });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(r.notified).toEqual(['a', 'b']);
    expect(r.subscribed).toEqual(['a', 'b']);
    expect(r.woke).toBe(0);
    expect(h.subscribe.mock.calls[0][0]).toMatchObject({ subscriber_id: 'a', target_kind: 'object' });
    expect((h.send.mock.calls[0][1] as { to: string[] }).to).toEqual(['a']);
  });

  it('skips the sender (self) and dedupes', async () => {
    const r = await notifyAgents(identity, { addressees: ['a', 'me', 'a'], objectRef, summary: 's', body: 'bod' });
    expect(r.notified).toEqual(['a']); // 'me' (self) skipped, duplicate 'a' deduped
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('resolves short handles to full ids before subscribe/ping', async () => {
    h.resolve.mockImplementation(async () => ['su-full-xyz']);
    const r = await notifyAgents(identity, { addressees: ['xyz'], objectRef, summary: 's', body: 'bod' });
    expect(r.notified).toEqual(['su-full-xyz']);
    expect((h.send.mock.calls[0][1] as { to: string[] }).to).toEqual(['su-full-xyz']);
  });

  it('wake:true fires wakeRecipients over the pinged set and returns the woke count', async () => {
    h.wake.mockImplementation(async () => ({ woken: 2 }));
    const r = await notifyAgents(identity, { addressees: ['a', 'b'], objectRef, summary: 's', body: 'bod', wake: true });
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.wake.mock.calls[0][0]).toEqual(['a', 'b']);
    expect(r.woke).toBe(2);
  });

  it('does NOT wake when wake is unset', async () => {
    await notifyAgents(identity, { addressees: ['a'], objectRef, summary: 's', body: 'bod' });
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('empty addressees → no-op', async () => {
    const r = await notifyAgents(identity, { addressees: [], objectRef, summary: 's', body: 'bod' });
    expect(r).toEqual({ notified: [], subscribed: [], woke: 0 });
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a subscribe failure does not block the ping (best-effort)', async () => {
    h.subscribe.mockRejectedValueOnce(new Error('store down'));
    const r = await notifyAgents(identity, { addressees: ['a'], objectRef, summary: 's', body: 'bod' });
    expect(r.subscribed).toEqual([]); // subscribe threw
    expect(r.notified).toEqual(['a']); // ping still happened
  });
});
