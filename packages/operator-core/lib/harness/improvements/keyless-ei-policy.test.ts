import { describe, expect, it } from 'vitest';
import {
  keylessAgeBandOf,
  summarizeKeylessBacklog,
  planKeylessReview,
  KEYLESS_AGING_MS,
  KEYLESS_STALE_MS,
  type KeylessIssueRow,
} from './keyless-ei-policy';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-18T00:00:00Z');

function row(over: Partial<KeylessIssueRow> & { id: string; ageDays: number }): KeylessIssueRow {
  return {
    id: over.id,
    title: over.title ?? `issue ${over.id}`,
    severity: over.severity ?? 'minor',
    source: over.source ?? 'manual',
    scope: over.scope ?? 'operator',
    assignee: over.assignee ?? null,
    createdAtMs: NOW - over.ageDays * DAY,
    updatedAtMs: NOW - over.ageDays * DAY,
  };
}

describe('keylessAgeBandOf (P-014)', () => {
  it('bands by age with inclusive thresholds', () => {
    expect(keylessAgeBandOf(0)).toBe('fresh');
    expect(keylessAgeBandOf(KEYLESS_AGING_MS - 1)).toBe('fresh');
    expect(keylessAgeBandOf(KEYLESS_AGING_MS)).toBe('aging'); // 7d boundary is aging
    expect(keylessAgeBandOf(KEYLESS_STALE_MS - 1)).toBe('aging');
    expect(keylessAgeBandOf(KEYLESS_STALE_MS)).toBe('stale'); // 30d boundary is stale
    expect(keylessAgeBandOf(90 * DAY)).toBe('stale');
  });

  it('honors injected thresholds', () => {
    expect(keylessAgeBandOf(2 * DAY, { agingMs: 1 * DAY, staleMs: 5 * DAY })).toBe('aging');
    expect(keylessAgeBandOf(5 * DAY, { agingMs: 1 * DAY, staleMs: 5 * DAY })).toBe('stale');
  });
});

describe('summarizeKeylessBacklog (P-014)', () => {
  it('rolls a sample into band counts + headline split, with the exact total preserved', () => {
    const rows = [
      row({ id: 'EI-1', ageDays: 1 }), // fresh
      row({ id: 'EI-2', ageDays: 10 }), // aging
      row({ id: 'EI-3', ageDays: 40, severity: 'major', source: 'capture' }), // stale, unassigned
      row({ id: 'EI-4', ageDays: 50, assignee: 's-bob' }), // stale, assigned
    ];
    // total (821) is reported independently of the 4-row sample (the cap case).
    const s = summarizeKeylessBacklog(rows, 821, NOW);
    expect(s.total).toBe(821);
    expect(s.sampled).toBe(4);
    expect(s.fresh).toBe(1);
    expect(s.aging).toBe(1);
    expect(s.stale).toBe(2);
    expect(s.staleUnassigned).toBe(1); // EI-3 only — EI-4 has an owner
    expect(s.oldestDays).toBe(50);
    expect(s.bySeverity).toEqual({ minor: 3, major: 1 });
    expect(s.bySource).toEqual({ manual: 3, capture: 1 });
  });

  it('is empty-safe', () => {
    const s = summarizeKeylessBacklog([], 0, NOW);
    expect(s).toMatchObject({ total: 0, sampled: 0, fresh: 0, aging: 0, stale: 0, staleUnassigned: 0, oldestDays: 0 });
  });
});

describe('planKeylessReview (P-014)', () => {
  it('returns only STALE items, oldest-first, with a disposition per ownership', () => {
    const rows = [
      row({ id: 'EI-fresh', ageDays: 2 }),
      row({ id: 'EI-aging', ageDays: 14 }),
      row({ id: 'EI-stale-unowned', ageDays: 40 }),
      row({ id: 'EI-stale-owned', ageDays: 60, assignee: 's-bob' }),
    ];
    const review = planKeylessReview(rows, NOW);
    expect(review.map((r) => r.id)).toEqual(['EI-stale-owned', 'EI-stale-unowned']); // oldest-first, stale only
    expect(review.find((r) => r.id === 'EI-stale-unowned')!.disposition).toBe('claim-or-close');
    expect(review.find((r) => r.id === 'EI-stale-owned')!.disposition).toBe('follow-up-owner');
    expect(review.every((r) => r.band === 'stale')).toBe(true);
  });

  it('caps the queue', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row({ id: `EI-${i}`, ageDays: 40 + i }));
    expect(planKeylessReview(rows, NOW, { limit: 10 })).toHaveLength(10);
  });

  it('returns nothing when no item is stale', () => {
    expect(planKeylessReview([row({ id: 'EI-1', ageDays: 5 }), row({ id: 'EI-2', ageDays: 20 })], NOW)).toEqual([]);
  });
});
