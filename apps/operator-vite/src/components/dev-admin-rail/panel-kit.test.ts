/**
 * @vitest-environment jsdom
 *
 * Tests for formatRelative — the "12s ago / 4m ago / 2h ago / 3d ago" renderer.
 * Run with: cd apps/operator-vite && npx vitest run src/components/dev-admin-rail/panel-kit.test.ts
 */
import { describe, expect, it } from 'vitest';
import { formatRelative } from './panel-kit';

const ago = (ms: number) => Date.now() - ms;

describe('formatRelative', () => {
  it('renders an em-dash for null/undefined/0', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
    expect(formatRelative(0)).toBe('—');
  });

  it('renders "just now" for a future timestamp', () => {
    expect(formatRelative(Date.now() + 10_000)).toBe('just now');
  });

  it('renders seconds, minutes, hours, and days', () => {
    expect(formatRelative(ago(5_000))).toBe('5s ago');
    expect(formatRelative(ago(5 * 60_000))).toBe('5m ago');
    expect(formatRelative(ago(3 * 3_600_000))).toBe('3h ago');
    expect(formatRelative(ago(2 * 86_400_000))).toBe('2d ago');
  });
});
