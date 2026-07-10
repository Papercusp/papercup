/**
 * carry-journal (queen-memory-hybrid-2026-07-02 L1a) — the append-mode ring
 * replacing the single REPLACE carry-note slot. Pure-ring bounds + the brief's
 * journal rendering (newest-first trajectory).
 */
import { describe, expect, it } from 'vitest';
import {
  appendCarryJournal,
  CARRY_JOURNAL_MAX_ENTRIES,
  CARRY_JOURNAL_NOTE_MAX_CHARS,
  CARRY_JOURNAL_TOTAL_MAX_CHARS,
} from './wake';

describe('appendCarryJournal (pure ring)', () => {
  it('appends and preserves order (oldest first in storage)', () => {
    const j1 = appendCarryJournal(undefined, 'first', 1);
    const j2 = appendCarryJournal(j1, 'second', 2);
    expect(j2.map((e) => e.note)).toEqual(['first', 'second']);
    expect(j2[1].at).toBe(2);
  });

  it('blank note appends nothing (trajectory persists)', () => {
    const j = appendCarryJournal([{ at: 1, note: 'kept' }], '   ', 2);
    expect(j).toEqual([{ at: 1, note: 'kept' }]);
  });

  it('caps entry count — oldest dropped first', () => {
    let j: Array<{ at: number; note: string }> = [];
    for (let i = 0; i < CARRY_JOURNAL_MAX_ENTRIES + 5; i++) j = appendCarryJournal(j, `n${i}`, i);
    expect(j.length).toBe(CARRY_JOURNAL_MAX_ENTRIES);
    expect(j[0].note).toBe('n5'); // 0..4 evicted
  });

  it('caps per-note chars and total chars', () => {
    const long = 'x'.repeat(CARRY_JOURNAL_NOTE_MAX_CHARS + 100);
    const j1 = appendCarryJournal([], long, 1);
    expect(j1[0].note.length).toBe(CARRY_JOURNAL_NOTE_MAX_CHARS);

    let j: Array<{ at: number; note: string }> = [];
    const half = 'y'.repeat(CARRY_JOURNAL_NOTE_MAX_CHARS);
    for (let i = 0; i < CARRY_JOURNAL_MAX_ENTRIES; i++) j = appendCarryJournal(j, half, i);
    const total = j.reduce((n, e) => n + e.note.length, 0);
    expect(total).toBeLessThanOrEqual(CARRY_JOURNAL_TOTAL_MAX_CHARS);
    expect(j.length).toBeGreaterThan(0);
  });

  it('never mutates its input', () => {
    const input = [{ at: 1, note: 'a' }];
    appendCarryJournal(input, 'b', 2);
    expect(input).toEqual([{ at: 1, note: 'a' }]);
  });
});
