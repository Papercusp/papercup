/**
 * terminal-now-stamp.test.ts — the `## Now` banner written when a plan reaches
 * a terminal lifecycle status.
 *
 * The property under test is not "a banner appears" but "a reader who trusts
 * the Now block is told the truth FIRST, and nothing the author wrote is lost".
 * Both halves are asserted through the real parser (`parsePlan`), because the
 * structured `now.state` / `now.next` fields are read as often as the prose and
 * were the surface that actually misled an agent (see terminal-now-stamp.ts).
 */

import { describe, expect, it } from 'vitest';
import { parsePlan } from './parser';
import { stampTerminalNowBlock, TERMINAL_NOW_STAMP_MARK } from './terminal-now-stamp';

const FM = ['---', 'title: T', 'slug: t-2026-08-12', 'status: shipped', 'updated: 2026-08-12', '---', ''].join('\n');

function doc(nowBody: string, tail = '\n## Background\n\nBody prose.\n'): string {
  return `${FM}\n# T\n\n## Now\n\n${nowBody}\n${tail}`;
}

const STALE_NOW = ['**State:** SHIP BLOCKER (the only one): the acceptance rubric is UNGRADED.', '', '**Next:** Grade it, then flip the plan to shipped.'].join('\n');

const AT = new Date('2026-08-12T20:00:00Z');

describe('stampTerminalNowBlock', () => {
  it('leads BOTH structured fields with the closure banner', () => {
    const out = stampTerminalNowBlock(doc(STALE_NOW), 'shipped', AT);
    expect(out).not.toBeNull();
    const now = parsePlan(out as string).now;
    expect(now?.state.startsWith(TERMINAL_NOW_STAMP_MARK)).toBe(true);
    expect(now?.state).toContain('SHIPPED 2026-08-12');
    // The lying instruction must not survive as the parsed `next` — that field
    // is what a resuming agent reads as "the thing to do".
    expect(now?.next.startsWith('none — the plan is shipped.')).toBe(true);
    expect(now?.next).not.toMatch(/^Grade it/);
  });

  it('destroys nothing — the author State and Next survive verbatim', () => {
    const out = stampTerminalNowBlock(doc(STALE_NOW), 'shipped', AT) as string;
    expect(out).toContain('SHIP BLOCKER (the only one): the acceptance rubric is UNGRADED.');
    expect(out).toContain('Grade it, then flip the plan to shipped.');
    // …and the rest of the document is untouched.
    expect(out).toContain('## Background');
    expect(out).toContain('Body prose.');
  });

  it('is idempotent — a second terminal flip does not nest a second banner', () => {
    const once = stampTerminalNowBlock(doc(STALE_NOW), 'shipped', AT) as string;
    expect(stampTerminalNowBlock(once, 'shipped', AT)).toBeNull();
    expect(stampTerminalNowBlock(once, 'superseded', AT)).toBeNull();
    expect(once.match(new RegExp(TERMINAL_NOW_STAMP_MARK, 'g'))).toHaveLength(1);
  });

  it('labels a superseded plan as superseded, not shipped', () => {
    const out = stampTerminalNowBlock(doc(STALE_NOW), 'superseded', AT) as string;
    const now = parsePlan(out).now;
    expect(now?.state).toContain('SUPERSEDED 2026-08-12');
    expect(now?.state).not.toContain('SHIPPED 2026-08-12');
    expect(now?.next).toContain('the plan is superseded');
  });

  it('returns null for a non-terminal status', () => {
    for (const status of ['draft', 'ready', 'active', '']) {
      expect(stampTerminalNowBlock(doc(STALE_NOW), status, AT)).toBeNull();
    }
  });

  it('returns null when the plan has no ## Now block — never invents one', () => {
    const body = `${FM}\n# T\n\n## Background\n\nNo anchor here.\n`;
    expect(stampTerminalNowBlock(body, 'shipped', AT)).toBeNull();
  });

  it('carries preamble prose written above the **State:** marker', () => {
    const out = stampTerminalNowBlock(
      doc(`Context paragraph the parser attributes to neither field.\n\n${STALE_NOW}`),
      'shipped',
      AT,
    ) as string;
    expect(out).toContain('Context paragraph the parser attributes to neither field.');
    const now = parsePlan(out).now;
    expect(now?.state.startsWith(TERMINAL_NOW_STAMP_MARK)).toBe(true);
  });

  it('carries a free-prose Now block that has no State/Next markers at all', () => {
    const out = stampTerminalNowBlock(doc('Just a paragraph, no markers.'), 'shipped', AT) as string;
    expect(out).toContain('Just a paragraph, no markers.');
    const now = parsePlan(out).now;
    expect(now?.state.startsWith(TERMINAL_NOW_STAMP_MARK)).toBe(true);
    expect(now?.next).toBe('none — the plan is shipped.');
  });

  it('handles a Now block with only a **Next:** (no State)', () => {
    const out = stampTerminalNowBlock(doc('**Next:** do the thing'), 'shipped', AT) as string;
    const now = parsePlan(out).now;
    expect(now?.state.startsWith(TERMINAL_NOW_STAMP_MARK)).toBe(true);
    expect(now?.next).toContain('do the thing');
    expect(now?.next.startsWith('none — the plan is shipped.')).toBe(true);
  });

  it('CONTROL: an unstamped shipped plan still reads as live work (the bug)', () => {
    // Calibration — proves the assertions above are measuring the stamp and not
    // something the fixture already satisfied.
    const now = parsePlan(doc(STALE_NOW)).now;
    expect(now?.state.startsWith(TERMINAL_NOW_STAMP_MARK)).toBe(false);
    expect(now?.next).toBe('Grade it, then flip the plan to shipped.');
  });
});
