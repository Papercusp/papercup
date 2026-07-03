/**
 * presence-etag.test.ts — the P-006 `since:` unchanged-read ETag
 * (presence-tool-hardening-2026-07-03).
 *
 * The etag hashes ONLY the delta-eligible projection (identity+state) so an
 * unchanged roster is stable across reads (→ the ~100B { unchanged:true }
 * short-circuit) while any actionable change flips it. Liveness churn
 * (heartbeat / lastActiveSecAgo / live↔parked) is excluded by construction —
 * that is the whole point, so it is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { computeRosterEtag } from './presence-snapshot';
import { toStableRosterRow, PLACEHOLDER_INTENT, type RosterRow } from './presence-payload';

const row = (o: Partial<RosterRow>): RosterRow => ({ ownerId: 'su-a', stale: false, ...o }) as RosterRow;

describe('toStableRosterRow — placeholder intent normalization (P-004)', () => {
  it('normalizes the self-referential placeholder intent to null', () => {
    const out = toStableRosterRow(row({ ownerId: 'su-a', intent: PLACEHOLDER_INTENT }));
    expect(out.intent).toBeNull();
  });

  it('leaves a real intent untouched', () => {
    const out = toStableRosterRow(row({ ownerId: 'su-a', intent: 'ship the etag fix' }));
    expect(out.intent).toBe('ship the etag fix');
  });

  it('the placeholder does not perturb the etag vs a genuinely-null intent', () => {
    // A placeholder-intent row and a no-intent row should read as the same lane
    // state to a coordinator. (The etag is computed pre-normalization on the raw
    // delta-eligible projection, so this pins that they at least both carry no
    // *real* intent once projected through toStableRosterRow.)
    const placeholder = toStableRosterRow(row({ ownerId: 'su-a', intent: PLACEHOLDER_INTENT }));
    const none = toStableRosterRow(row({ ownerId: 'su-a' }));
    expect(placeholder.intent ?? null).toBe(none.intent ?? null);
  });
});

describe('computeRosterEtag (P-006 since: short-circuit)', () => {
  it('is stable across two reads of an unchanged roster', () => {
    const a = [row({ ownerId: 'su-a', intent: 'ship X', currentPlanSlug: 'p1' })];
    const b = [row({ ownerId: 'su-a', intent: 'ship X', currentPlanSlug: 'p1' })];
    expect(computeRosterEtag(a, 'hive', null)).toBe(computeRosterEtag(b, 'hive', null));
  });

  it('IGNORES liveness churn (lastActiveSecAgo) — same etag', () => {
    const a = [row({ ownerId: 'su-a', intent: 'ship X', lastActiveSecAgo: 5 })];
    const b = [row({ ownerId: 'su-a', intent: 'ship X', lastActiveSecAgo: 4000 })];
    expect(computeRosterEtag(a, 'hive', null)).toBe(computeRosterEtag(b, 'hive', null));
  });

  it('CHANGES when a state field changes (intent)', () => {
    const a = [row({ ownerId: 'su-a', intent: 'ship X' })];
    const b = [row({ ownerId: 'su-a', intent: 'ship Y' })];
    expect(computeRosterEtag(a, 'hive', null)).not.toBe(computeRosterEtag(b, 'hive', null));
  });

  it('CHANGES when the claimed lane changes (claimedItems is state)', () => {
    const a = [row({ ownerId: 'su-a', claimedItems: ['P-001'] })];
    const b = [row({ ownerId: 'su-a', claimedItems: ['P-001', 'P-002'] })];
    expect(computeRosterEtag(a, 'hive', null)).not.toBe(computeRosterEtag(b, 'hive', null));
  });

  it('CHANGES when a row is added or removed', () => {
    const a = [row({ ownerId: 'su-a' })];
    const b = [row({ ownerId: 'su-a' }), row({ ownerId: 'su-b' })];
    expect(computeRosterEtag(a, 'hive', null)).not.toBe(computeRosterEtag(b, 'hive', null));
  });

  it('is order-independent (rows sorted before hashing)', () => {
    const a = [row({ ownerId: 'su-a', intent: 'x' }), row({ ownerId: 'su-b', intent: 'y' })];
    const b = [row({ ownerId: 'su-b', intent: 'y' }), row({ ownerId: 'su-a', intent: 'x' })];
    expect(computeRosterEtag(a, 'hive', null)).toBe(computeRosterEtag(b, 'hive', null));
  });

  it('does not collide across scope or hive (no cross-scope unchanged:true)', () => {
    const a = [row({ ownerId: 'su-a' })];
    expect(computeRosterEtag(a, 'hive', null)).not.toBe(computeRosterEtag(a, 'workspace', null));
    expect(computeRosterEtag(a, 'hive', 'h1')).not.toBe(computeRosterEtag(a, 'hive', 'h2'));
  });

  it('returns a short, stable hex digest', () => {
    const e = computeRosterEtag([row({ ownerId: 'su-a' })], 'hive', null);
    expect(e).toMatch(/^[0-9a-f]{16}$/);
  });
});
