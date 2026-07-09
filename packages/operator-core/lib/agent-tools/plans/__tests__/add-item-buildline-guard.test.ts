/**
 * add-item-buildline-guard.test.ts — buildItemLine's newline guard (WI-3447).
 *
 * An item is ONE physical line (ITEM_LINE_RE's `(.*)$` does not span newlines).
 * A newline in item text — e.g. a multi-line paste — would split the built line,
 * truncating the item and orphaning the remainder as stray prose (silent
 * corruption). buildItemLine collapses any newline-bearing whitespace run to a
 * single space so the line always parses back to the intended item. Pure.
 */
import { describe, it, expect } from 'vitest';
import { buildItemLine } from '../add-item';
import { parsePlan } from '../parser';

describe('buildItemLine — newline guard (WI-3447)', () => {
  it('single-line text is unchanged (no-op)', () => {
    expect(buildItemLine('P-001', 'a normal item', [])).toBe('- **P-001** `todo` a normal item');
  });

  it('collapses a newline so the built line stays a single valid item line', () => {
    const line = buildItemLine('P-002', 'first part\nsecond part', []);
    expect(line).toBe('- **P-002** `todo` first part second part');
    expect(line.includes('\n')).toBe(false);
  });

  it('collapses CRLF and blank-line runs (multi-line paste) to single spaces', () => {
    const line = buildItemLine('P-003', 'multi\r\nline\n\ntext here', []);
    expect(line).toBe('- **P-003** `todo` multi line text here');
  });

  it('the built line round-trips to ONE parsed item carrying the full text', () => {
    const body = '## Phase 1\n\n' + buildItemLine('P-004', 'line one\nline two', ['P-001']);
    const items = parsePlan(body).items;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe('P-004');
    expect(items[0]?.text).toBe('line one line two');
    expect(items[0]?.blockedBy).toEqual(['P-001']);
  });
});
