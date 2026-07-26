/** owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270) — the wall
 *  fact slot's pure key/body normalization (facts:assert { slot: 'wall' }). */
import { describe, expect, it } from 'vitest';
import { WALL_BODY_PREFIX, WALL_KEY_PREFIX, normalizeWallSlot } from './assert';

describe('normalizeWallSlot', () => {
  it('prefixes key and body onto the slot encoding', () => {
    const r = normalizeWallSlot(
      'mac-vm-creds-public-leak-owner-rotation',
      'mac VM sudo/loginwindow passwords have been public since 2026-06-22 — rotation is owner-authority.',
    );
    expect(r.key).toBe('wall:mac-vm-creds-public-leak-owner-rotation');
    expect(r.body).toBe(
      `${WALL_BODY_PREFIX}mac VM sudo/loginwindow passwords have been public since 2026-06-22 — rotation is owner-authority.`,
    );
  });

  it('is idempotent — an already-slotted key/body is unchanged (re-assert hits the same upsert key)', () => {
    const once = normalizeWallSlot('cred-rotation', 'rotation still pending.');
    const twice = normalizeWallSlot(once.key, once.body);
    expect(twice).toEqual(once);
  });

  it('key prefix check is case-insensitive; body marker match is exact', () => {
    expect(normalizeWallSlot('WALL:already', 'x').key).toBe('WALL:already');
    expect(normalizeWallSlot('k', `${WALL_BODY_PREFIX}x`).body.startsWith(WALL_BODY_PREFIX)).toBe(true);
    expect(normalizeWallSlot('k', `${WALL_BODY_PREFIX}x`).body.indexOf(WALL_BODY_PREFIX, 1)).toBe(-1);
  });

  it('constants stay greppable: key LIKE pattern + visible marker', () => {
    expect(WALL_KEY_PREFIX).toBe('wall:');
    expect(WALL_BODY_PREFIX).toContain('⚠ WALL');
  });
});
