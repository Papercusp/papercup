import { describe, it, expect } from 'vitest';
import { isAutoPickable } from './work-items-admission';

/**
 * P-001 of shared-hive-trust-admission-2026-06-14. The G2 admission predicate is the
 * single source of truth for every claim/place path; this pins its truth table.
 */
describe('isAutoPickable — G2 admission predicate', () => {
  it('local origin is always pickable (verdict irrelevant)', () => {
    expect(isAutoPickable('local', null)).toBe(true);
    expect(isAutoPickable('local', undefined)).toBe(true);
    expect(isAutoPickable('local', 'reject')).toBe(true);
  });

  it('NULL/undefined origin is pickable (pre-G1 back-compat = local)', () => {
    expect(isAutoPickable(null, null)).toBe(true);
    expect(isAutoPickable(undefined, undefined)).toBe(true);
  });

  it('remote + un-admitted is NOT pickable (quarantined, fail-safe)', () => {
    expect(isAutoPickable('remote', null)).toBe(false);
    expect(isAutoPickable('remote', undefined)).toBe(false);
    expect(isAutoPickable('remote', 'pending')).toBe(false);
    expect(isAutoPickable('remote', 'reject')).toBe(false);
  });

  it('remote becomes pickable only once the auditor admits it', () => {
    expect(isAutoPickable('remote', 'admit')).toBe(true);
  });
});

/**
 * The OWN-NODE default [owner:Avi 2026-07-13: "trust our own nodes ... that should be
 * the default. all new papercusp installs should have that behavior without needing to
 * do anything"].
 *
 * The bug this closes: `origin` records how a row ARRIVED, not who wrote it, so an item
 * we authored ourselves comes back origin='remote' after a federation round-trip. With
 * the auditor unbuilt and the trust list empty it matched no leg — a pot quarantined
 * against its own work, placing nothing while every health signal stayed green.
 */
describe('isAutoPickable — own-node fast-path', () => {
  const OURS = 'b5ab1807fbc9d091f7b6c76d9918549c1631e91dcb998298202f64797d4697ac';
  const STRANGER = '9999999999999999999999999999999999999999999999999999999999999999';
  const own = new Set<string>([OURS]);

  it('admits a remote, NEVER-audited item authored by one of our own keys', () => {
    // The exact shape of the 10 items that deadlocked papercusp's frontier.
    expect(isAutoPickable('remote', null, null, undefined, OURS, own)).toBe(true);
  });

  it("still quarantines a stranger's key — this is a scoped trust decision, not an open door", () => {
    expect(isAutoPickable('remote', null, null, undefined, STRANGER, own)).toBe(false);
  });

  it('a BLANK author_pubkey never qualifies, even though blank-authored local rows exist', () => {
    // Load-bearing: blank local rows are real (pre-federation back-compat). If '' were
    // allowed into the own-key set it would admit EVERY blank-authored remote row.
    expect(isAutoPickable('remote', null, null, undefined, '', new Set(['']))).toBe(false);
    expect(isAutoPickable('remote', null, null, undefined, null, own)).toBe(false);
  });

  it('an EMPTY own-key set admits nothing remote (fail-safe: a fresh install trusts no one yet)', () => {
    expect(isAutoPickable('remote', null, null, undefined, OURS, new Set())).toBe(false);
  });

  it('omitting the own-key args preserves the exact prior behaviour (callers that cannot scope it UNDER-admit)', () => {
    expect(isAutoPickable('remote', null)).toBe(false);
    expect(isAutoPickable('remote', 'admit')).toBe(true);
    expect(isAutoPickable('local', null)).toBe(true);
  });

  it('a rejected verdict does not override the own-node leg — our own key still wins', () => {
    // Deliberate: the auditor lane does not exist in production; an 'admit'-only
    // reading would keep the deadlock. Our own node is trusted on identity, not verdict.
    expect(isAutoPickable('remote', 'reject', null, undefined, OURS, own)).toBe(true);
  });
});
