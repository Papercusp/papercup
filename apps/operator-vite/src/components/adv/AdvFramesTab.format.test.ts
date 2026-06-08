/**
 * @vitest-environment jsdom
 *
 * Tests for the AdvFramesTab pure helpers (formatAge + the stale threshold).
 * Run with: cd apps/operator-vite && npx vitest run src/components/adv/AdvFramesTab.format.test.ts
 */
import { describe, expect, it } from 'vitest';
import { formatAge, STALE_AFTER_MS } from './AdvFramesTab';

describe('formatAge', () => {
  it('renders "now" for a negative age', () => {
    expect(formatAge(-1)).toBe('now');
  });

  it('renders seconds under a minute (rounded)', () => {
    expect(formatAge(0)).toBe('0s ago');
    expect(formatAge(5_000)).toBe('5s ago');
    expect(formatAge(59_400)).toBe('59s ago');
  });

  it('renders whole minutes (floored) at and above a minute', () => {
    expect(formatAge(60_000)).toBe('1m ago');
    expect(formatAge(125_000)).toBe('2m ago'); // 125s → 2m floored
  });
});

describe('STALE_AFTER_MS', () => {
  it('is the documented ~3-interval (20s) threshold', () => {
    expect(STALE_AFTER_MS).toBe(20_000);
  });
});
