/**
 * self-marker.test.ts — unit guards for the caller self-identification overlay
 * (coord:presence / fleet:assignments / coord:orient).
 *
 * Pure logic — no PG, no operator. Run:
 *   npx vitest run lib/agent-tools/coordination/self-marker.test.ts
 */

import { describe, expect, it } from 'vitest';
import { resolveSelfRef, markSelfRows, type SelfRef } from './self-marker';

const SELF: SelfRef = { ownerId: 'su-self', ownerLabel: 'su · self' };

describe('markSelfRows', () => {
  it('stamps isSelf:true on the caller\'s own row only', () => {
    const rows = [
      { ownerId: 'su-self', intent: 'mine' },
      { ownerId: 'su-other', intent: 'theirs' },
      { ownerId: 'fed:peer@box', intent: '' },
    ];
    const out = markSelfRows(rows, SELF);
    expect(out[0]).toMatchObject({ ownerId: 'su-self', isSelf: true });
    expect(out[1]).not.toHaveProperty('isSelf');
    expect(out[2]).not.toHaveProperty('isSelf');
  });

  it('marks exactly one row even when several share a role/label', () => {
    // The transcript bug: two `su` agents, indistinguishable. Only the caller's
    // id matches, so exactly one row is flagged.
    const rows = [{ ownerId: 'su-aaa' }, { ownerId: 'su-self' }, { ownerId: 'su-bbb' }];
    const out = markSelfRows(rows, SELF);
    expect(out.filter((r) => (r as { isSelf?: boolean }).isSelf)).toHaveLength(1);
    expect((out[1] as { isSelf?: boolean }).isSelf).toBe(true);
  });

  it('does not mutate the input row — the marked row is a fresh object', () => {
    const mine = { ownerId: 'su-self', intent: 'mine' };
    const out = markSelfRows([mine], SELF);
    expect(out[0]).not.toBe(mine); // new object
    expect(mine).not.toHaveProperty('isSelf'); // original untouched
  });

  it('passes non-self rows through by reference (byte-identical to the snapshot)', () => {
    const other = { ownerId: 'su-other' };
    const out = markSelfRows([other], SELF);
    expect(out[0]).toBe(other); // unchanged reference
  });

  it('honours a custom idKey (fleet:assignments keys the id under agentId)', () => {
    const rows = [
      { agentId: 'su-self', label: 'me' },
      { agentId: 'su-other', label: 'them' },
    ];
    const out = markSelfRows(rows, SELF, 'agentId');
    expect(out[0]).toMatchObject({ isSelf: true });
    expect(out[1]).not.toHaveProperty('isSelf');
  });

  it('is a no-op when self is undefined (unattributable caller)', () => {
    const rows = [{ ownerId: 'su-self' }];
    const out = markSelfRows(rows, undefined);
    expect(out).toBe(rows); // same array, untouched
    expect(out[0]).not.toHaveProperty('isSelf');
  });

  it('marks nothing when the caller is not present in the roster', () => {
    const rows = [{ ownerId: 'su-x' }, { ownerId: 'su-y' }];
    const out = markSelfRows(rows, SELF);
    expect(out.some((r) => (r as { isSelf?: boolean }).isSelf)).toBe(false);
  });
});

describe('resolveSelfRef', () => {
  it('returns the caller\'s ownerId + label for an attributable (superuser) ctx', () => {
    const self = resolveSelfRef({ isSuperuser: true, uiClientId: 'sess-abcd1234' });
    expect(self).toEqual({ ownerId: 'sess-abcd1234', ownerLabel: 'su · sess-abc' });
  });

  it('returns undefined for an unattributable ctx (best-effort, never throws)', () => {
    expect(resolveSelfRef({})).toBeUndefined();
    expect(resolveSelfRef(undefined)).toBeUndefined();
    expect(resolveSelfRef(null)).toBeUndefined();
  });
});
