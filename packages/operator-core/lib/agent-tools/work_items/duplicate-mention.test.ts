/**
 * EI-10949 — the dup-close nudge must fire on a work-item duplicate, not on the English
 * word "duplicate".
 *
 * It exists for WI-3646: an item dup-closed 3× with the survivor named only in prose
 * ("dup of WI-3543"), leaving no structured link a scanner could follow. It misfired on a
 * completion that removed a duplicated TYPE INTERFACE — no work-item involved, nothing to
 * link, and a warning the author could only ignore.
 */
import { describe, expect, it } from 'vitest';
import { mentionsWorkItemDuplicate } from './complete';

describe('mentionsWorkItemDuplicate (EI-10949)', () => {
  it('still catches the WI-3646 pattern it exists for — a survivor named only in prose', () => {
    expect(mentionsWorkItemDuplicate('dup of WI-3543')).toBe(true);
    expect(mentionsWorkItemDuplicate('Closing: this is a duplicate of WI-3543.')).toBe(true);
    expect(mentionsWorkItemDuplicate('dupe of EI-9011')).toBe(true);
    expect(mentionsWorkItemDuplicate('duplicates of F-021 were merged')).toBe(true);
  });

  it('no longer fires on ordinary prose about duplicated CODE — the false positive that caused this', () => {
    expect(
      mentionsWorkItemDuplicate('Removed a duplicate of the SelectEntry interface and re-exported it.'),
    ).toBe(false);
    expect(mentionsWorkItemDuplicate('Deduplicated the fixture rows.')).toBe(false);
    expect(mentionsWorkItemDuplicate('the memory recall returns near-duplicate entries')).toBe(false);
  });

  it('does not reach across a sentence boundary for an unrelated id', () => {
    // "duplicate of the type" ends; a LATER sentence mentioning an item must not re-arm it.
    expect(
      mentionsWorkItemDuplicate('Removed a duplicate of the type. Filed separately as WI-4561.'),
    ).toBe(false);
  });

  it('is case-insensitive on both the phrase and the id', () => {
    expect(mentionsWorkItemDuplicate('DUP OF wi-3543')).toBe(true);
  });

  it('ignores a bare mention of an item with no duplicate claim', () => {
    expect(mentionsWorkItemDuplicate('Fixed alongside WI-3543.')).toBe(false);
  });
});
