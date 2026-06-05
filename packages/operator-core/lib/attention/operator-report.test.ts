/**
 * operator-report.test.ts — the operator `<report>` attention source
 * (report-cards-inbox-reconciliation-2026-06-05, P-002/P-003).
 *
 * Covers: the worst-of `reportTier` mapping (D-003), the
 * `operatorReportToAttention` adapter (title fallbacks, single-plan slug
 * adoption, actions, tier→importance, plain-text body), and the pure
 * `reportTurnsToAttention` transform (invalid payloads skipped, order
 * preserved). The I/O half (window/cap/workspace scoping) is covered by
 * operator-report-source.integration.test.ts against real PG.
 */
import { describe, it, expect } from 'vitest';
import type { ReportBlock } from '@papercusp/chat-protocol';
import { applyTriage, needsHumanForTier, reportTier } from './types';
import { operatorReportToAttention } from './adapters';
import { reportTurnsToAttention } from './sources';

const plan = (over: Partial<ReportBlock['plans'][number]> = {}) => ({
  title: 'Rate-limit layer v2',
  ...over,
});

describe('reportTier — worst-of statuses (D-003)', () => {
  it('plain status snapshot → activity', () => {
    expect(
      reportTier({ plans: [plan({ status: 'active', items: [{ text: 'a', status: 'done' }] })] }),
    ).toBe('activity');
  });

  it('any needs-human item → decision (review ask)', () => {
    expect(
      reportTier({
        plans: [
          plan({ status: 'active', items: [{ text: 'a', status: 'done' }] }),
          plan({ title: 'Other', items: [{ text: 'b', status: 'needs-human' }] }),
        ],
      }),
    ).toBe('decision');
  });

  it('review / needs_human variants count as decision; case-insensitive', () => {
    expect(reportTier({ plans: [plan({ status: 'Review' })] })).toBe('decision');
    expect(reportTier({ plans: [plan({ items: [{ text: 'x', status: 'NEEDS_HUMAN' }] })] })).toBe(
      'decision',
    );
  });

  it('blocked/failing without any decision token → alert', () => {
    expect(reportTier({ plans: [plan({ status: 'blocked' })] })).toBe('alert');
    expect(reportTier({ plans: [plan({ items: [{ text: 'x', status: 'failing' }] })] })).toBe(
      'alert',
    );
  });

  it('decision wins over alert (worst-of)', () => {
    expect(
      reportTier({
        plans: [
          plan({ status: 'blocked' }),
          plan({ title: 'B', items: [{ text: 'y', status: 'review' }] }),
        ],
      }),
    ).toBe('decision');
  });

  it('unknown / missing statuses → activity (loose pre-sort)', () => {
    expect(reportTier({ plans: [plan(), plan({ title: 'B', status: 'cruising' })] })).toBe(
      'activity',
    );
  });
});

describe('operatorReportToAttention (P-003)', () => {
  const base = {
    turnId: 't-1',
    conversationId: 'c-1',
  };

  it('maps a decision report: id, tier, needsHuman, importance, ref, payload', () => {
    const report: ReportBlock = {
      title: 'Needs your review',
      plans: [plan({ slug: 'rate-limit-layer-v2', status: 'needs-human' })],
    };
    const item = operatorReportToAttention({ ...base, report });
    expect(item.id).toBe('operator-report:t-1');
    expect(item.kind).toBe('operator-report');
    expect(item.source).toBe('operator');
    expect(item.tier).toBe('decision');
    expect(item.needsHuman).toBe(needsHumanForTier('decision'));
    expect(item.importance).toBe('high');
    expect(item.title).toBe('Needs your review');
    expect(item.ref).toEqual({ kind: 'operator-report', turnId: 't-1', conversationId: 'c-1' });
    expect(item.report).toBe(report);
    expect(item.ownerLabel).toBe('Operator');
    expect(item.triageState).toBe('untriaged');
  });

  it('tier → importance: alert→normal, activity→low', () => {
    expect(
      operatorReportToAttention({ ...base, report: { plans: [plan({ status: 'blocked' })] } })
        .importance,
    ).toBe('normal');
    expect(
      operatorReportToAttention({ ...base, report: { plans: [plan({ status: 'active' })] } })
        .importance,
    ).toBe('low');
  });

  it('title falls back: report.title ?? say text ?? "Operator report"', () => {
    const report: ReportBlock = { plans: [plan()] };
    expect(operatorReportToAttention({ ...base, report, sayText: 'Fleet update' }).title).toBe(
      'Fleet update',
    );
    expect(operatorReportToAttention({ ...base, report, sayText: '  ' }).title).toBe(
      'Operator report',
    );
    expect(operatorReportToAttention({ ...base, report }).title).toBe('Operator report');
  });

  it('single-plan report adopts the plan slug (groups with the plan); multi-plan stays unattached', () => {
    const single = operatorReportToAttention({
      ...base,
      report: { plans: [plan({ slug: 'rate-limit-layer-v2' })] },
    });
    expect(single.planSlug).toBe('rate-limit-layer-v2');
    expect(single.actions.map((a) => a.id)).toEqual(['resolve', 'open']);

    const multi = operatorReportToAttention({
      ...base,
      report: { plans: [plan({ slug: 'a' }), plan({ title: 'B', slug: 'b' })] },
    });
    expect(multi.planSlug).toBeNull();
    expect(multi.actions.map((a) => a.id)).toEqual(['resolve']);
  });

  it('body is a plain-text two-tier rendition (text-only surfaces)', () => {
    const item = operatorReportToAttention({
      ...base,
      report: {
        plans: [
          plan({
            status: 'active',
            summary: 'top half',
            items: [{ id: 'P-001', text: 'Error classifier', status: 'done' }],
          }),
        ],
      },
    });
    expect(item.body).toContain('[active] Rate-limit layer v2 — top half');
    expect(item.body).toContain('  [done] P-001 Error classifier');
  });

  it('triage resolve moves the item to handled (rides the standard machinery)', () => {
    const item = operatorReportToAttention({
      ...base,
      report: { plans: [plan({ status: 'needs-human' })] },
    });
    const handled = applyTriage(item, {
      action: 'resolve',
      note: 'reviewed in the inbox',
      triagedBy: 'human',
      triagedAt: '2026-06-05T15:00:00.000Z',
    });
    expect(handled.tier).toBe('handled');
    expect(handled.needsHuman).toBe(false);
    expect(handled.triageNote).toBe('reviewed in the inbox');
  });
});

describe('reportTurnsToAttention (pure transform)', () => {
  it('maps valid rows newest-first, skips invalid payloads', () => {
    const rows = [
      {
        turnId: 't-2',
        conversationId: 'c-1',
        report: { plans: [{ title: 'B', status: 'blocked' }] },
        text: 'newer',
        createdAt: 2000,
      },
      {
        turnId: 't-bad',
        conversationId: 'c-1',
        report: { nope: true },
        text: null,
        createdAt: 1500,
      },
      {
        turnId: 't-1',
        conversationId: 'c-1',
        report: { plans: [{ title: 'A', status: 'active' }] },
        text: 'older',
        createdAt: 1000,
      },
    ];
    const items = reportTurnsToAttention(rows);
    expect(items.map((i) => i.id)).toEqual(['operator-report:t-2', 'operator-report:t-1']);
    expect(items[0]?.tier).toBe('alert');
    expect(items[1]?.tier).toBe('activity');
  });

  it('non-object / null payloads are skipped, never throw', () => {
    const items = reportTurnsToAttention([
      { turnId: 't', conversationId: 'c', report: 'garbage', text: null, createdAt: 1 },
      { turnId: 't2', conversationId: 'c', report: null, text: null, createdAt: 2 },
    ]);
    expect(items).toEqual([]);
  });
});
