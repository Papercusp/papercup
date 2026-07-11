/**
 * ideator-feedback-priming.test.ts — C-4 grader-feedback priming (P-005,
 * scout-idea-grading-2026-06-12). Pins the contract byte-shapes: the exact
 * heading, the exact entry format (`- [★<grade> · <Owner|Queen> · <lens>]
 * <title>: <feedback…>`), newest-first ordering, and the window/char caps
 * (≤10 entries, ≤1,500 chars total, per-entry truncation). The cycle-deps
 * concat (grader block BELOW the gym stepping-stones in every ideator prompt)
 * is pinned in cycle-deps.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  formatGraderFeedbackPriming,
  gatherGraderFeedbackPriming,
  GRADER_FEEDBACK_HEADING,
  MAX_FEEDBACK_BLOCK_CHARS,
  MAX_FEEDBACK_ENTRIES,
  MAX_FEEDBACK_ENTRY_CHARS,
  type GradedIdeaView,
} from './ideator-feedback-priming';

function graded(over: Partial<GradedIdeaView> = {}): GradedIdeaView {
  return {
    lens: 'analogical',
    ideaId: 'idea-1',
    title: 'Lock-free queue',
    humanGrade: 4,
    humanFeedback: 'good direction, too vague on the mechanism',
    gradedBy: 'owner',
    gradedAt: '2026-06-12T10:00:00.000Z',
    routedAt: '2026-06-11T10:00:00.000Z',
    ...over,
  };
}

describe('formatGraderFeedbackPriming — C-4 shape', () => {
  it('emits the exact heading and the exact entry format', () => {
    const { priming, entries } = formatGraderFeedbackPriming([graded()]);
    expect(priming.startsWith(`${GRADER_FEEDBACK_HEADING}\n`)).toBe(true);
    expect(GRADER_FEEDBACK_HEADING).toBe('## Grader feedback on recent ideas');
    expect(entries).toEqual([
      '- [★4 · Owner · analogical] Lock-free queue: good direction, too vague on the mechanism',
    ]);
  });

  it('labels the grader Owner vs Queen (D-004 — ideators weigh sovereign owner grades)', () => {
    const { entries } = formatGraderFeedbackPriming([
      graded({ gradedBy: 'owner', gradedAt: '2026-06-12T02:00:00.000Z' }),
      graded({ ideaId: 'idea-2', title: 'Queen idea', gradedBy: 'Queen', humanGrade: 2, gradedAt: '2026-06-12T01:00:00.000Z' }),
    ]);
    expect(entries[0]).toContain('· Owner ·');
    expect(entries[1]).toContain('· Queen ·');
    expect(entries[1].startsWith('- [★2 · Queen · analogical] Queen idea:')).toBe(true);
  });

  it('a grade-only entry (no feedback) carries no ": <feedback>" tail', () => {
    const { entries } = formatGraderFeedbackPriming([graded({ humanFeedback: undefined })]);
    expect(entries).toEqual(['- [★4 · Owner · analogical] Lock-free queue']);
  });

  it('orders newest-first by gradedAt, falling back to routedAt', () => {
    const { entries } = formatGraderFeedbackPriming([
      graded({ title: 'oldest', gradedAt: '2026-06-10T00:00:00.000Z' }),
      graded({ title: 'newest', gradedAt: '2026-06-12T00:00:00.000Z' }),
      graded({ title: 'mid-by-routedAt', gradedAt: undefined, routedAt: '2026-06-11T00:00:00.000Z' }),
    ]);
    expect(entries.map((e) => e.split('] ')[1])).toEqual([
      'newest: good direction, too vague on the mechanism',
      'mid-by-routedAt: good direction, too vague on the mechanism',
      'oldest: good direction, too vague on the mechanism',
    ]);
  });

  it('ignores ungraded rows; nothing graded ⇒ empty priming', () => {
    const ungraded = graded({ humanGrade: undefined, humanFeedback: undefined, gradedBy: undefined, gradedAt: undefined });
    expect(formatGraderFeedbackPriming([ungraded])).toEqual({ entries: [], priming: '' });
    expect(formatGraderFeedbackPriming([])).toEqual({ entries: [], priming: '' });
    // A graded row among ungraded ones still surfaces.
    const { entries } = formatGraderFeedbackPriming([ungraded, graded()]);
    expect(entries).toHaveLength(1);
  });

  it('windows to the 10 newest graded ideas (D-003)', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      graded({
        ideaId: `idea-${i}`,
        title: `idea ${i}`,
        gradedAt: `2026-06-12T10:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    const { entries } = formatGraderFeedbackPriming(rows);
    expect(entries).toHaveLength(MAX_FEEDBACK_ENTRIES);
    expect(entries[0]).toContain('idea 24'); // newest first
    expect(entries[9]).toContain('idea 15');
  });

  it('truncates each entry to the per-entry cap with an ellipsis', () => {
    const { entries } = formatGraderFeedbackPriming([graded({ humanFeedback: 'x'.repeat(500) })]);
    expect(entries[0].length).toBeLessThanOrEqual(MAX_FEEDBACK_ENTRY_CHARS);
    expect(entries[0].endsWith('…')).toBe(true);
  });

  it('the whole block stays ≤ 1,500 chars at a worst-case full window', () => {
    const rows = Array.from({ length: MAX_FEEDBACK_ENTRIES + 5 }, (_, i) =>
      graded({
        ideaId: `idea-${i}`,
        title: 'T'.repeat(200),
        humanFeedback: 'f'.repeat(2000),
        gradedAt: `2026-06-12T10:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    const { priming } = formatGraderFeedbackPriming(rows);
    expect(priming.length).toBeLessThanOrEqual(MAX_FEEDBACK_BLOCK_CHARS);
    expect(priming.startsWith(GRADER_FEEDBACK_HEADING)).toBe(true);
  });

  it('drops oldest entries to honor a tightened total cap', () => {
    const rows = [
      graded({ title: 'newest', gradedAt: '2026-06-12T02:00:00.000Z' }),
      graded({ title: 'older', gradedAt: '2026-06-12T01:00:00.000Z' }),
    ];
    const full = formatGraderFeedbackPriming(rows);
    const tight = formatGraderFeedbackPriming(rows, {
      maxBlockChars: GRADER_FEEDBACK_HEADING.length + 1 + full.entries[0].length,
    });
    expect(tight.entries).toEqual([full.entries[0]]); // the newest survives
  });

  it('collapses newlines/whitespace and clamps out-of-range grades defensively', () => {
    const { entries } = formatGraderFeedbackPriming([
      graded({ humanGrade: 9, title: '  multi\n line\ttitle ', humanFeedback: 'a\nb' }),
    ]);
    expect(entries).toEqual(['- [★5 · Owner · analogical] multi line title: a b']);
  });

  it('falls back to the ideaId when the title is absent', () => {
    const { entries } = formatGraderFeedbackPriming([graded({ title: undefined, humanFeedback: undefined })]);
    expect(entries).toEqual(['- [★4 · Owner · analogical] idea-1']);
  });
});

describe('formatGraderFeedbackPriming — P-019 intent ordering', () => {
  // Three graded rows in newest-first input order (a, then b, then c by gradedAt).
  const rows: GradedIdeaView[] = [
    graded({ title: 'a-newest', routedRef: 'wi:1', gradedAt: '2026-06-12T03:00:00.000Z' }),
    graded({ title: 'b-mid', routedRef: 'wi:2', gradedAt: '2026-06-12T02:00:00.000Z' }),
    graded({ title: 'c-oldest', routedRef: 'wi:3', gradedAt: '2026-06-12T01:00:00.000Z' }),
  ];
  const titles = (entries: string[]): string[] => entries.map((e) => e.split('] ')[1].split(':')[0]);

  it('ranks the window most-relevant-first by cosine instead of newest-first', () => {
    const intentSimByRef = new Map([
      ['wi:1', 0.1],
      ['wi:2', 0.9],
      ['wi:3', 0.5],
    ]);
    const { entries } = formatGraderFeedbackPriming(rows, { intentSimByRef });
    expect(titles(entries)).toEqual(['b-mid', 'c-oldest', 'a-newest']);
  });

  it('keeps rows with no resolved sim newest-first, below the ranked ones', () => {
    const intentSimByRef = new Map([['wi:2', 0.8]]); // only b has a vector
    const { entries } = formatGraderFeedbackPriming(rows, { intentSimByRef });
    expect(titles(entries)).toEqual(['b-mid', 'a-newest', 'c-oldest']);
  });

  it('ranks BEFORE the window so a relevant-but-old row survives the cap', () => {
    // Two rows, window of 1: newest is off-topic, oldest is on-topic ⇒ the oldest wins.
    const two: GradedIdeaView[] = [
      graded({ title: 'newest-offtopic', routedRef: 'wi:9', gradedAt: '2026-06-12T05:00:00.000Z' }),
      graded({ title: 'oldest-ontopic', routedRef: 'wi:8', gradedAt: '2026-06-12T01:00:00.000Z' }),
    ];
    const intentSimByRef = new Map([
      ['wi:9', 0.1],
      ['wi:8', 0.95],
    ]);
    const { entries } = formatGraderFeedbackPriming(two, { maxEntries: 1, intentSimByRef });
    expect(entries).toHaveLength(1);
    expect(titles(entries)).toEqual(['oldest-ontopic']);
  });

  it('an empty sim map leaves the ordering byte-identical to newest-first (fail-open)', () => {
    const ranked = formatGraderFeedbackPriming(rows, { intentSimByRef: new Map() });
    const plain = formatGraderFeedbackPriming(rows);
    expect(ranked).toEqual(plain);
  });
});

describe('gatherGraderFeedbackPriming — the reader seam', () => {
  it('formats rows from the injected reader', async () => {
    const res = await gatherGraderFeedbackPriming({ readRows: async () => [graded()] });
    expect(res.entries).toHaveLength(1);
    expect(res.priming).toContain(GRADER_FEEDBACK_HEADING);
  });

  it('degrades to an empty block when the read fails (never crashes a cycle)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await gatherGraderFeedbackPriming({
      readRows: async () => {
        throw new Error('PG down');
      },
    });
    expect(res).toEqual({ entries: [], priming: '' });
  });
});
