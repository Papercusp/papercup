/**
 * dispatch-handle.test.ts — P-012 (coordination-spec-adoption-2026-08-03).
 *
 * The property under test is NOT "a handle is produced". It is that a handle is
 * produced ONLY when both halves resolve, because the failure this design exists
 * to prevent is a plausible-looking call that resolves to the wrong subject —
 * the caller-relativity lesson the state-plane handles paid for (D-101).
 */
import { describe, expect, it } from 'vitest';
import {
  buildDispatchHandle,
  isDispatchable,
  type DispatchCandidate,
} from './dispatch-handle';

const peer = (over: Partial<DispatchCandidate> = {}): DispatchCandidate => ({
  ownerId: 'su-peer',
  label: 'su · peer',
  sessionState: 'parked',
  wakeable: true,
  claimedItems: [],
  ...over,
});

const lane = { planSlug: 'my-plan', items: ['P-001', 'P-002'], harness: 'papercusp' };

describe('isDispatchable — parked + wakeable only', () => {
  it('accepts parked + wakeable', () => {
    expect(isDispatchable(peer())).toBe(true);
  });

  // A live peer is mid-turn; pushing a lane at it races its own claim. This is
  // the case most likely to be "fixed" by a well-meaning later edit, so it is
  // pinned rather than left to the reader of the filter expression.
  it.each([
    ['live', { sessionState: 'live' }],
    ['draining', { sessionState: 'draining' }],
    ['suspect', { sessionState: 'suspect' }],
    ['ended', { sessionState: 'ended' }],
    ['parked but not wakeable', { wakeable: false }],
    ['parked, wakeable unknown', { wakeable: null }],
  ])('rejects %s', (_label, over) => {
    expect(isDispatchable(peer(over as Partial<DispatchCandidate>))).toBe(false);
  });
});

describe('buildDispatchHandle — a ready call, or nothing', () => {
  it('emits a fully-filled call when a lane AND a dispatchable peer both resolve', () => {
    const h = buildDispatchHandle(lane, [peer()], { selfOwnerId: 'su-me' });
    expect(h).toMatchObject({
      tool: 'coord:dispatch',
      call: {
        to: 'su-peer',
        planSlug: 'my-plan',
        items: ['P-001', 'P-002'],
        harness: 'papercusp',
      },
    });
    // the note must be non-empty — dispatch requires it, so a handle without one
    // is not actually invocable as-is, which defeats the whole mechanism
    expect((h as { call: { note: string } }).call.note.length).toBeGreaterThan(0);
  });

  it('emits NO handle and needs:items when peers exist but no lane resolves', () => {
    const h = buildDispatchHandle({ planSlug: null, items: [] }, [peer()], {
      selfOwnerId: 'su-me',
    });
    expect(h).toMatchObject({ unreadable: { needs: 'items' } });
    expect(h).not.toHaveProperty('call');
  });

  // The specific broken shape D-101 names: a real `to` with empty `items` fires a
  // bare wake while READING as a hand-off.
  it('emits NO handle when a plan slug exists but the item list is empty', () => {
    const h = buildDispatchHandle({ planSlug: 'my-plan', items: [] }, [peer()], {
      selfOwnerId: 'su-me',
    });
    expect(h).toMatchObject({ unreadable: { needs: 'items' } });
    expect(h).not.toHaveProperty('call');
  });

  it('emits NO handle and needs:target when a lane resolves but nobody is dispatchable', () => {
    const h = buildDispatchHandle(lane, [peer({ sessionState: 'live' })], {
      selfOwnerId: 'su-me',
    });
    expect(h).toMatchObject({ unreadable: { needs: 'target' } });
    expect(h).not.toHaveProperty('call');
  });

  it('stays silent (null) when there is no lane and no peer — not an unreadable', () => {
    // An `unreadable` asserts a handle was WANTED. Emitting one on every idle
    // presence read would just be the mention again, wearing a new field name.
    expect(buildDispatchHandle({ planSlug: null, items: [] }, [])).toBeNull();
  });

  it('never targets the caller', () => {
    const h = buildDispatchHandle(lane, [peer({ ownerId: 'su-me' })], {
      selfOwnerId: 'su-me',
    });
    expect(h).toMatchObject({ unreadable: { needs: 'target' } });
  });

  it('picks the lightest-loaded peer and lists the rest as alternatives', () => {
    const h = buildDispatchHandle(
      lane,
      [
        peer({ ownerId: 'su-busy', claimedItems: ['P-010', 'P-011'] }),
        peer({ ownerId: 'su-free', claimedItems: [] }),
        peer({ ownerId: 'su-one', claimedItems: ['P-020'] }),
      ],
      { selfOwnerId: 'su-me' },
    );
    expect((h as { call: { to: string } }).call.to).toBe('su-free');
    expect((h as { alsoWakeable: string[] }).alsoWakeable).toEqual(['su-one', 'su-busy']);
    // the pick is explained, so a caller can disagree with it rather than having
    // to reverse-engineer why this peer
    expect((h as { because: string }).because).toMatch(/lightest dispatchable peer/);
  });

  it('honours a caller-supplied note over the generated one', () => {
    const h = buildDispatchHandle({ ...lane, note: 'take the parser half' }, [peer()]);
    expect((h as { call: { note: string } }).call.note).toBe('take the parser half');
  });

  it('omits harness rather than sending an empty one', () => {
    const h = buildDispatchHandle({ planSlug: 'p', items: ['P-001'] }, [peer()]);
    expect((h as { call: Record<string, unknown> }).call).not.toHaveProperty('harness');
  });
});
