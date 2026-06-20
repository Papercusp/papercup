import { describe, it, expect } from 'vitest';
import { boundSummaries, SUMMARY_ROW_CAP, SUMMARIES_TOTAL_BUDGET } from './list';

/**
 * EI-1597 — work_items:list returned the full WorkItem array with each row's full
 * `summary` body, so a 40-item backlog produced 73KB on one line and overflowed the
 * agent result cap. boundSummaries excerpts each row's summary (budget-aware); the
 * full body stays reachable via work_items:get { id }.
 */
describe('boundSummaries (EI-1597 — work_items:list row summary bound)', () => {
  it('returns a short summary unchanged, with no truncation flags', () => {
    const rows = [{ id: 'WI-1', summary: 'short' }];
    const out = boundSummaries(rows);
    expect(out[0]).toEqual(rows[0]);
    expect('summary_truncated' in out[0]).toBe(false);
  });

  it('excerpts a long summary to the cap and stamps summary_truncated + summary_full_chars', () => {
    const long = 'x'.repeat(SUMMARY_ROW_CAP + 500);
    const out = boundSummaries([{ id: 'WI-1', summary: long }]);
    const r = out[0] as { summary: string; summary_truncated?: true; summary_full_chars?: number };
    // n=1 → cap = min(CAP, floor(BUDGET/1)) = CAP
    expect(r.summary.length).toBe(SUMMARY_ROW_CAP);
    expect(r.summary_truncated).toBe(true);
    expect(r.summary_full_chars).toBe(long.length);
  });

  it('keeps TOTAL summary text bounded by the budget at ANY list size (max limit)', () => {
    const n = 500; // the tool's max limit
    const rows = Array.from({ length: n }, (_, i) => ({ id: `WI-${i}`, summary: 'y'.repeat(1000) }));
    const out = boundSummaries(rows);
    const total = out.reduce((s, r) => s + (r.summary?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(SUMMARIES_TOTAL_BUDGET);
    expect(out[0].summary?.length).toBe(Math.floor(SUMMARIES_TOTAL_BUDGET / n));
  });

  it('reproduces the 40-item backlog overflow scenario (now bounded)', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `WI-${i}`, summary: 'z'.repeat(1800) }));
    const out = boundSummaries(rows);
    const total = out.reduce((s, r) => s + (r.summary?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(SUMMARIES_TOTAL_BUDGET);
    // cap for n=40 = min(240, floor(16000/40)=400) = 240
    expect(out[0].summary?.length).toBe(SUMMARY_ROW_CAP);
  });

  it('handles an empty list and a null/empty summary', () => {
    expect(boundSummaries([])).toEqual([]);
    const out = boundSummaries([{ id: 'WI-1', summary: null as string | null }]);
    // full='' ≤ cap → row untouched, no flags
    expect(out[0]).toEqual({ id: 'WI-1', summary: null });
  });

  it('preserves all non-summary fields when excerpting', () => {
    const row = {
      id: 'WI-9',
      title: 'a title',
      state: 'open',
      severity: 'minor',
      assignee: 'su-x',
      summary: 'w'.repeat(SUMMARY_ROW_CAP + 1),
    };
    const out = boundSummaries([row]);
    const r = out[0] as typeof row & { summary_truncated?: true };
    expect(r.id).toBe('WI-9');
    expect(r.title).toBe('a title');
    expect(r.state).toBe('open');
    expect(r.severity).toBe('minor');
    expect(r.assignee).toBe('su-x');
    expect(r.summary_truncated).toBe(true);
  });
});
