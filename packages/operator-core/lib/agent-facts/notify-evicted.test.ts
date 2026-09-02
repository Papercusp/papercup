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

/**
 * EI-19449079650310753 — the notice must name the key that ACTUALLY decided.
 *
 * Reciting "ranked by confidence first" is accurate about the SQL and misleading
 * about reality: measured 2026-08-03, every scope at or near the cap held exactly
 * ONE confidence tier, so that key separated nothing and the TTL decided alone.
 * An author whose fact was already `verified` reads the recital and reaches for a
 * lever that cannot move. Each test below pins one way of getting that wrong.
 */
describe('renderEvictionNotice — which key actually decided', () => {
  const render = (ranking: Parameters<typeof renderEvictionNotice>[1]['ranking']) =>
    renderEvictionNotice([victim()], {
      writerOwnerId: 'su-writer',
      scope: 'harness',
      scopeRef: 'papercusp',
      ranking,
    }).body;

  it('says the TTL decided — and that raising confidence CANNOT help — when every fact shares a tier', () => {
    const body = render({ confidenceDiscriminated: false, prevailingConfidence: 'verified' });
    expect(body).toMatch(/the TTL, NOT confidence/i);
    // The operative instruction. Without it the reader still reasonably concludes
    // "mark it verified next time" — which is a no-op, because it already was.
    expect(body).toMatch(/re-asserting at a HIGHER CONFIDENCE cannot help/i);
    expect(body).toMatch(/remaining fraction of (?:your )?declared TTL/i);
    expect(body).toContain('`verified`');
  });

  it('names confidence as the decider only when tiers genuinely differ', () => {
    const body = render({ confidenceDiscriminated: true, prevailingConfidence: null });
    expect(body).toMatch(/WHICH KEY DECIDED YOURS: confidence/i);
    // Must NOT tell an author in a genuinely mixed scope that confidence is inert
    // — there it is a real lever, and the advice inverts.
    expect(body).not.toMatch(/the TTL, NOT confidence/i);
  });

  it('reports UNDETERMINED rather than guessing when the ranking context is absent', () => {
    const body = render(null);
    expect(body).toMatch(/not determined for this eviction/i);
    // Undetermined must not silently read as either verdict.
    expect(body).not.toMatch(/the TTL, NOT confidence/i);
    expect(body).not.toMatch(/WHICH KEY DECIDED YOURS: confidence\b/i);
  });

  it('does NOT claim a shared tier when tiers merely RANK equally (unset vs provisional)', () => {
    // unset and 'provisional' both rank 1, so the ordering separated nothing —
    // but they are not the same tier, and saying they are would be a false
    // statement about the data. `prevailingConfidence: null` is that case.
    const body = render({ confidenceDiscriminated: false, prevailingConfidence: null });
    expect(body).toMatch(/ranks EQUALLY on confidence/i);
    expect(body).not.toMatch(/SAME confidence tier/i);
    // Specifically must not render the null as a literal tier name.
    expect(body).not.toContain('`unset`');
    expect(body).not.toContain('`null`');
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
    // WI-2142302 made this path LOUD (console.warn) rather than fully silent —
    // still never throws, which is what this test pins; the warning itself is
    // covered below under "silent failures are now loud".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      sendMessage.mockRejectedValueOnce(new Error('coord plane down'));
      await expect(
        notifyEvictedFactOwners({
          evicted: [victim()],
          writerOwnerId: 'su-writer',
          scope: 'harness',
          scopeRef: 'papercusp',
        }),
      ).resolves.toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('one owner failing does not silence the others', async () => {
    // See note above: this path now logs a warning for the failed owner (WI-2142302).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      sendMessage.mockRejectedValueOnce(new Error('nope'));
      const notified = await notifyEvictedFactOwners({
        evicted: [victim({ createdBy: 'su-a' }), victim({ createdBy: 'su-b' })],
        writerOwnerId: 'su-writer',
        scope: 'harness',
        scopeRef: 'papercusp',
      });
      expect(notified).toEqual(['su-b']);
    } finally {
      warn.mockRestore();
    }
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

/**
 * WI-2142302 — a dead notifier used to be indistinguishable from a healthy one:
 * every failure path returned/swallowed with nothing logged, so "does this still
 * work" could only be answered by querying coord_event_log, and a broken notifier
 * passes that check trivially (zero rows either way). These pin that each catch
 * now logs BEFORE it swallows, without changing the return contract.
 */
describe('notifyEvictedFactOwners — silent failures are now loud (WI-2142302)', () => {
  it('logs a warning (and still returns []) when the coord plane throws for one owner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      sendMessage.mockRejectedValueOnce(new Error('coord plane down'));
      const notified = await notifyEvictedFactOwners({
        evicted: [victim()],
        writerOwnerId: 'su-writer',
        scope: 'harness',
        scopeRef: 'papercusp',
      });
      expect(notified).toEqual([]);
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('su-owner'))).toBe(true);
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('coord plane down'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs an error (and still returns []) when the pipeline itself throws before any send', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A non-iterable `evicted` makes groupVictimsByOwner's `for...of` throw
      // BEFORE any sendMessage call — the one path that reaches the OUTER catch
      // rather than the per-owner inner one.
      const notified = await notifyEvictedFactOwners({
        evicted: null as unknown as FactEviction[],
        writerOwnerId: 'su-writer',
        scope: 'harness',
        scopeRef: 'papercusp',
      });
      expect(notified).toEqual([]);
      expect(error).toHaveBeenCalled();
      expect(error.mock.calls.some(([msg]) => String(msg).includes('NO owner was notified'))).toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('warns when an evicted fact has no resolvable owner (a real gap) — not when every victim is the writer (expected)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The genuine gap: nobody can be told.
      const notified = await notifyEvictedFactOwners({
        evicted: [victim({ createdBy: '' })],
        writerOwnerId: 'su-writer',
        scope: 'workspace',
      });
      expect(notified).toEqual([]);
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('no resolvable'))).toBe(true);
      warn.mockClear();

      // The benign case: self-eviction needs no notice and must NOT warn.
      const notifiedSelf = await notifyEvictedFactOwners({
        evicted: [victim({ createdBy: 'su-writer' })],
        writerOwnerId: 'su-writer',
        scope: 'workspace',
      });
      expect(notifiedSelf).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a summary line naming the writer on a successful notification, so an evicting agent has a queryable trail', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await notifyEvictedFactOwners({
        evicted: [victim()],
        writerOwnerId: 'su-writer',
        scope: 'harness',
        scopeRef: 'papercusp',
      });
      expect(log.mock.calls.some(([msg]) => String(msg).includes('writer=su-writer'))).toBe(true);
      expect(log.mock.calls.some(([msg]) => String(msg).includes('su-owner'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
