import { describe, it, expect } from 'vitest';
import { countStarted, hivesRunningLabel, type HiveControlRow } from './hive-control';

const row = (slug: string, started: boolean): HiveControlRow => ({ slug, started });

describe('countStarted', () => {
  it('counts only started hives', () => {
    expect(countStarted([row('a', true), row('b', false), row('c', true)])).toBe(2);
  });
  it('is 0 for empty + all-stopped', () => {
    expect(countStarted([])).toBe(0);
    expect(countStarted([row('a', false), row('b', false)])).toBe(0);
  });
  it('requires started===true (no truthy coercion on a partial row)', () => {
    // The predicate is strict so a missing/odd `started` never counts as running.
    const rows = [{ slug: 'x', started: true }, { slug: 'y', started: false }] as HiveControlRow[];
    expect(countStarted(rows)).toBe(1);
  });
});

describe('hivesRunningLabel', () => {
  it('pluralizes the hive count', () => {
    expect(hivesRunningLabel(0)).toBe('0 hives running');
    expect(hivesRunningLabel(1)).toBe('1 hive running');
    expect(hivesRunningLabel(3)).toBe('3 hives running');
  });
});
