/** P-015 (deterministic-context-carry) — the dead-end fact slot's pure
 *  key/body normalization (facts:assert { slot: 'dead-end' }). */
import { describe, expect, it } from 'vitest';
import { DEAD_END_BODY_PREFIX, DEAD_END_KEY_PREFIX, normalizeDeadEndSlot } from './assert';

describe('normalizeDeadEndSlot', () => {
  it('prefixes key and body onto the slot encoding', () => {
    const r = normalizeDeadEndSlot('fs-watch-route', 'inotify recursion hits the watch limit at repo scale.');
    expect(r.key).toBe('dead-end:fs-watch-route');
    expect(r.body).toBe(`${DEAD_END_BODY_PREFIX}inotify recursion hits the watch limit at repo scale.`);
  });

  it('is idempotent — an already-slotted key/body is unchanged (re-assert hits the same upsert key)', () => {
    const once = normalizeDeadEndSlot('fs-watch-route', 'inotify recursion hits the watch limit.');
    const twice = normalizeDeadEndSlot(once.key, once.body);
    expect(twice).toEqual(once);
  });

  it('key prefix check is case-insensitive; body marker match is exact', () => {
    expect(normalizeDeadEndSlot('DEAD-END:already', 'x').key).toBe('DEAD-END:already');
    expect(normalizeDeadEndSlot('k', `${DEAD_END_BODY_PREFIX}x`).body.startsWith(DEAD_END_BODY_PREFIX)).toBe(true);
    expect(
      normalizeDeadEndSlot('k', `${DEAD_END_BODY_PREFIX}x`).body.indexOf(DEAD_END_BODY_PREFIX, 1),
    ).toBe(-1);
  });

  it('constants stay greppable: key LIKE pattern + visible marker', () => {
    expect(DEAD_END_KEY_PREFIX).toBe('dead-end:');
    expect(DEAD_END_BODY_PREFIX).toContain('⛔ DEAD END');
  });
});
