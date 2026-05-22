/**
 * Unit coverage for RevisionsPanel's pure formatters (P-017).
 *
 * The row's display is non-obvious in three places — author labels
 * branch on `authorKind`, the rationale placeholder branches on
 * `sessionKind`, and the timestamp branches on age. Lock the
 * branching now so a later restyle can't drop a case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatAuthor,
  formatRationale,
  formatTimestamp,
} from './RevisionsPanel';
import type { PlanRevision } from './plans-api';

const NOW = new Date('2026-05-22T12:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const base: PlanRevision = {
  id: 1,
  seq: 1,
  contentHash: 'h',
  rationale: null,
  authorKind: 'agent',
  authorId: '',
  sessionId: null,
  sessionKind: null,
  createdAt: NOW,
  diffStat: { added: 0, removed: 0 },
};

describe('formatAuthor', () => {
  it('human with email keeps the local part', () => {
    expect(
      formatAuthor({ ...base, authorKind: 'human', authorId: 'pandawamble@gmail.com' }),
    ).toBe('pandawamble');
  });

  it('human without "@" gets a length cap', () => {
    expect(
      formatAuthor({ ...base, authorKind: 'human', authorId: 'a'.repeat(40) }),
    ).toBe('a'.repeat(24));
  });

  it('agent id keeps the first two dash-chunks', () => {
    expect(
      formatAuthor({ ...base, authorKind: 'agent', authorId: 'pus-abcdef01-2345-6789' }),
    ).toBe('pus-abcdef01');
  });

  it('agent id without dashes gets a length cap', () => {
    expect(
      formatAuthor({ ...base, authorKind: 'agent', authorId: 'noDashIdentifierAtAllOver16' }),
    ).toBe('noDashIdentifier');
  });
});

describe('formatRationale', () => {
  it('returns the rationale verbatim when present', () => {
    expect(
      formatRationale({ ...base, rationale: 'why we did it' }),
    ).toBe('why we did it');
  });

  it('blank rationale falls through to the placeholder', () => {
    const node = formatRationale({ ...base, rationale: '   ' });
    expect(node).not.toBe('   ');
  });

  it('git_backfill → commit-message placeholder', () => {
    const node = formatRationale({ ...base, sessionKind: 'git_backfill' });
    const props = (node as { props?: { children?: string } }).props;
    expect(props?.children).toBe('(no commit message)');
  });

  it('plan_run with no rationale → summarisable hint', () => {
    const node = formatRationale({ ...base, sessionKind: 'plan_run' });
    const props = (node as { props?: { children?: string } }).props;
    expect(props?.children).toContain('summarisable');
  });

  it('no sessionKind → direct-edit placeholder', () => {
    const node = formatRationale({ ...base, sessionKind: null });
    const props = (node as { props?: { children?: string } }).props;
    expect(props?.children).toBe('(direct edit — no rationale)');
  });
});

describe('formatTimestamp', () => {
  it('invalid → empty string', () => {
    expect(formatTimestamp(0)).toBe('');
    expect(formatTimestamp(Number.NaN)).toBe('');
  });

  it('today → HH:MM', () => {
    expect(formatTimestamp(NOW - 3 * 3600_000)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('within a year → not HH:MM', () => {
    const s = formatTimestamp(NOW - 30 * 86_400_000);
    expect(s).not.toMatch(/^\d{2}:\d{2}$/);
    expect(s.length).toBeGreaterThan(0);
  });

  it('beyond a year → distinct from the within-year form', () => {
    const withinYear = formatTimestamp(NOW - 30 * 86_400_000);
    const beyondYear = formatTimestamp(NOW - 400 * 86_400_000);
    // Locale-independent: the year-branch must produce a different
    // shape than the within-year branch. Some locales render the
    // 2-digit year as `'25`, others as `25`, others as `2025` —
    // testing the precise glyph is locale-bound. Distinct output is
    // what matters.
    expect(beyondYear).not.toBe(withinYear);
    expect(beyondYear).not.toMatch(/^\d{2}:\d{2}$/);
  });
});
