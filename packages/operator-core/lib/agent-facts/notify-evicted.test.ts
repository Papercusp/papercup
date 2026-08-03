/**
 * EI-19442566203468589 — the cap-eviction notice actually reaches the fact's OWNER.
 *
 * Every assertion here pins a way this notice could be delivered and still be
 * USELESS, which is the failure mode that matters: the previous behaviour was not
 * a crash, it was silence, and silence is what a broken notification degrades
 * back into.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Typed with its real arity: a bare `vi.fn(async () => …)` infers a ZERO-arg
// mock, so `mock.calls[0][1]` (the send options — the thing every assertion here
// inspects) is a type error rather than a value.
const sendMessage = vi.fn(async (_identity: unknown, _opts: Record<string, unknown>) => ({}) as unknown);
vi.mock('../agent-tools/coordination/messages', () => ({
  sendMessage: (identity: unknown, opts: Record<string, unknown>) => sendMessage(identity, opts),
}));

import { groupVictimsByOwner, notifyEvictedFactOwners, renderEvictionNotice } from './notify-evicted';
import type { FactEviction } from './store';

const victim = (over: Partial<FactEviction> = {}): FactEviction =>
  ({
    key: 'some-standing-fact',
    confidence: 'verified',
    expiresAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'su-owner',
    ...over,
  }) as FactEviction;

beforeEach(() => sendMessage.mockClear());

describe('groupVictimsByOwner', () => {
  it('sends ONE message per owner, not one per evicted key', () => {
    const grouped = groupVictimsByOwner(
      [victim({ key: 'a' }), victim({ key: 'b' }), victim({ key: 'c', createdBy: 'su-other' })],
      'su-writer',
    );
    expect([...grouped.keys()].sort()).toEqual(['su-other', 'su-owner']);
    expect(grouped.get('su-owner')!.map((v) => v.key)).toEqual(['a', 'b']);
  });

  it('never messages the writer about their own eviction', () => {
    // Self-eviction is already visible to the writer via the assert receipt, and
    // WI-7292 stopped a write evicting the row it just inserted. A self-notice is
    // pure noise in an inbox read under pressure.
    expect(groupVictimsByOwner([victim({ createdBy: 'su-writer' })], 'su-writer').size).toBe(0);
  });

  it('drops victims with no recorded author instead of addressing an empty owner', () => {
    expect(groupVictimsByOwner([victim({ createdBy: '' })], 'su-writer').size).toBe(0);
  });
});

describe('renderEvictionNotice', () => {
  const { summary, body } = renderEvictionNotice([victim()], {
    writerOwnerId: 'su-writer',
    scope: 'harness',
    scopeRef: 'papercusp',
  });

  it('names the key and the scope that destroyed it', () => {
    expect(summary).toContain('some-standing-fact');
    expect(summary).toContain('harness/papercusp');
  });

  it('rules out the two wrong explanations the owner would otherwise reach for', () => {
    // Without this, the owner's first two hypotheses are "it expired" and "I
    // retracted it" — both wrong, and both cheap to eliminate up front.
    expect(body).toMatch(/NOT an expiry/i);
    expect(body).toMatch(/NOT a retraction/i);
  });

  it('tells the owner what to DO, including the cost of doing it', () => {
    expect(body).toMatch(/re-assert/i);
    // Re-asserting into a still-full scope evicts someone else. A notice that
    // omits this turns one victim into a cascade of them.
    expect(body).toMatch(/evict the next-lowest-ranked/i);
  });

  it('explains victim selection so eviction is predictable rather than mysterious', () => {
    expect(body).toMatch(/confidence/i);
    expect(body).toMatch(/TTL/i);
  });
});

describe('notifyEvictedFactOwners', () => {
  it('delivers to the fact owner, addressed to them directly', async () => {
    const notified = await notifyEvictedFactOwners({
      evicted: [victim()],
      writerOwnerId: 'su-writer',
      scope: 'harness',
      scopeRef: 'papercusp',
    });
    expect(notified).toEqual(['su-owner']);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ to: ['su-owner'] });
  });

  it('does NOT categorise the message — a category is default-EXCLUDED from coord:inbox', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Adding `category` is the obvious
    // tidy-up ("it is a system notice, tag it"), and it would deliver this into
    // the ambient channel coord:inbox filters out by default — silently
    // re-creating the exact invisibility the fix removes. The notice would still
    // be "sent", every test of delivery would still pass, and the owner would
    // still never see it.
    await notifyEvictedFactOwners({
      evicted: [victim()],
      writerOwnerId: 'su-writer',
      scope: 'harness',
      scopeRef: 'papercusp',
    });
    expect(sendMessage.mock.calls[0][1]).not.toHaveProperty('category');
  });

  it('never throws when the coord plane fails — an assert must not fail on its notice', async () => {
    sendMessage.mockRejectedValueOnce(new Error('coord plane down'));
    await expect(
      notifyEvictedFactOwners({
        evicted: [victim()],
        writerOwnerId: 'su-writer',
        scope: 'harness',
        scopeRef: 'papercusp',
      }),
    ).resolves.toEqual([]);
  });

  it('one owner failing does not silence the others', async () => {
    sendMessage.mockRejectedValueOnce(new Error('nope'));
    const notified = await notifyEvictedFactOwners({
      evicted: [victim({ createdBy: 'su-a' }), victim({ createdBy: 'su-b' })],
      writerOwnerId: 'su-writer',
      scope: 'harness',
      scopeRef: 'papercusp',
    });
    expect(notified).toEqual(['su-b']);
  });

  it('sends nothing when the only victim is the writer', async () => {
    const notified = await notifyEvictedFactOwners({
      evicted: [victim({ createdBy: 'su-writer' })],
      writerOwnerId: 'su-writer',
      scope: 'harness',
      scopeRef: 'papercusp',
    });
    expect(notified).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
