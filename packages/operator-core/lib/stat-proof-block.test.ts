/**
 * stat-proof-block.test.ts — the guard, not the arithmetic.
 *
 * The arithmetic tests here are cheap insurance. The tests that matter are the
 * ones reproducing the ACTUAL published error (WI-35490): a cumulative
 * "COORDINATION EVENTS / ALL TIME" tile over `harness_shared.coord_event_log`,
 * which is retention-swept and therefore re-measures LOWER than the slide claims.
 * If someone deletes the guard, `refuses the exact shape of the published error`
 * is the test that fails.
 */
import { describe, it, expect } from 'vitest';
import {
  UnqualifiedCumulativeError,
  abbreviate,
  daysSince,
  formatRatio,
  groupDigits,
  renderStatBlock,
  toPublishable,
  weeksSince,
  type LedgerFigure,
  type StatBlockInput,
} from './stat-proof-block';

/** The real retention horizons sweeping coord_event_log (notify/federated/escalation/message GCs). */
const COORD_HORIZONS = [3, 7, 14, 30];

/** The figure exactly as slide 11 published it. */
const PUBLISHED_BAD_TILE: LedgerFigure = {
  id: 'coord-events',
  label: 'COORDINATION EVENTS',
  value: 108_086,
  window: {
    kind: 'since-observed',
    oldestRow: new Date('2026-05-30T00:00:00Z'),
    reachesProjectStart: false,
  },
  sourceTable: 'harness_shared.coord_event_log',
  retentionHorizonsDays: COORD_HORIZONS,
};

describe('the published-error regression', () => {
  it('refuses the exact shape of the published error', () => {
    expect(() => toPublishable(PUBLISHED_BAD_TILE)).toThrow(UnqualifiedCumulativeError);
  });

  it('names the decrease in the refusal, so the reason is actionable', () => {
    let message = '';
    try {
      toPublishable(PUBLISHED_BAD_TILE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('retention-swept');
    expect(message).toContain('DECREASE');
    // Points at the concrete remedy rather than just refusing.
    expect(message).toContain("kind: 'trailing'");
  });

  it('refuses even when the table appears to reach project start, if it is swept', () => {
    // A swept table can transiently look complete; sweeping still makes a total unsafe.
    expect(() =>
      toPublishable({
        ...PUBLISHED_BAD_TILE,
        window: {
          kind: 'since-observed',
          oldestRow: new Date('2026-04-06T00:00:00Z'),
          reachesProjectStart: true,
        },
      }),
    ).toThrow(UnqualifiedCumulativeError);
  });

  it('fails the whole command rather than letting a bad figure reach a slide', () => {
    expect(() => renderStatBlock(baseInput([PUBLISHED_BAD_TILE]))).toThrow(
      UnqualifiedCumulativeError,
    );
  });
});

describe('trailing windows and the floor rule', () => {
  it('reports a window wider than the shortest sweep horizon as a floor', () => {
    const out = toPublishable({
      ...PUBLISHED_BAD_TILE,
      value: 25_711,
      window: { kind: 'trailing', days: 7 },
    });
    expect(out.isFloor).toBe(true);
    expect(out.rendered).toBe('≥ 25,711');
    expect(out.qualifier).toBe('LAST 7 DAYS (FLOOR)');
    expect(out.note).toContain('omits already-swept rows');
  });

  it('reports a window inside every sweep horizon as exact', () => {
    const out = toPublishable({
      ...PUBLISHED_BAD_TILE,
      value: 9_100,
      window: { kind: 'trailing', days: 3 },
    });
    expect(out.isFloor).toBe(false);
    expect(out.rendered).toBe('9,100');
    expect(out.qualifier).toBe('LAST 3 DAYS');
    expect(out.note).toBeUndefined();
  });

  it('treats an unswept table as exact at any window width', () => {
    const out = toPublishable({
      id: 'tool-calls',
      label: 'AGENT TOOL CALLS',
      value: 593_991,
      window: { kind: 'trailing', days: 7 },
      sourceTable: 'harness_shared.tool_invocations',
      retentionHorizonsDays: [],
    });
    expect(out.isFloor).toBe(false);
    expect(out.rendered).toBe('593,991');
  });

  it('singularises a one-day window', () => {
    const out = toPublishable({
      id: 'x',
      label: 'X',
      value: 1,
      window: { kind: 'trailing', days: 1 },
      sourceTable: 't',
    });
    expect(out.qualifier).toBe('LAST 1 DAY');
  });

  it('surfaces every floor as a warning on the rendered block', () => {
    const out = renderStatBlock(
      baseInput([
        { ...PUBLISHED_BAD_TILE, value: 25_711, window: { kind: 'trailing', days: 7 } },
      ]),
    );
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('FLOOR');
  });
});

describe('unswept cumulative totals', () => {
  it('permits an all-time label only when the table is unswept AND reaches first commit', () => {
    const out = toPublishable({
      id: 'work-items',
      label: 'WORK ITEMS',
      value: 33_769,
      window: {
        kind: 'since-observed',
        oldestRow: new Date('2026-04-06T00:00:00Z'),
        reachesProjectStart: true,
      },
      sourceTable: 'harness_shared.work_items',
      retentionHorizonsDays: [],
    });
    expect(out.qualifier).toBe('ALL TIME (TABLE REACHES FIRST COMMIT)');
    expect(out.isFloor).toBe(false);
  });

  it('downgrades to "since <date>" when an unswept table starts after first commit', () => {
    const out = toPublishable({
      id: 'late-table',
      label: 'LATE THING',
      value: 42,
      window: {
        kind: 'since-observed',
        oldestRow: new Date('2026-06-01T00:00:00Z'),
        reachesProjectStart: false,
      },
      sourceTable: 'harness_shared.late_thing',
      retentionHorizonsDays: [],
    });
    expect(out.qualifier).toBe('SINCE 2026-06-01');
    expect(out.note).toContain('after the first commit');
  });
});

describe('derived figures cannot go stale', () => {
  it('derives elapsed weeks from the first-commit date', () => {
    // 6 April → 8 August 2026 is 124 days = 17 whole weeks + 5 days.
    expect(weeksSince(new Date('2026-04-06'), new Date('2026-08-08'))).toBe(17);
    expect(daysSince(new Date('2026-04-06'), new Date('2026-08-08'))).toBe(124);
  });

  it('advances on its own as time passes, so "sixteen weeks" cannot persist', () => {
    const first = new Date('2026-04-06');
    const a = weeksSince(first, new Date('2026-08-08'));
    const b = weeksSince(first, new Date('2026-09-08'));
    expect(b).toBeGreaterThan(a);
  });
});

describe('ratio and number formatting', () => {
  it('reproduces the deck’s historical 0.72:1 on the same basis', () => {
    // 993K test lines against 2.37M total → 1.377M non-test.
    expect(formatRatio(993_000, 2_370_000 - 993_000)).toBe('0.72:1');
  });

  it('reproduces the current 0.90:1', () => {
    expect(formatRatio(1_138_909, 2_405_004 - 1_138_909)).toBe('0.90:1');
  });

  it('does not divide by zero', () => {
    expect(formatRatio(10, 0)).toBe('n/a');
  });

  it('abbreviates and groups', () => {
    expect(abbreviate(2_405_004)).toBe('2.41 M');
    expect(abbreviate(1_138_909)).toBe('1.14 M');
    expect(abbreviate(11_495)).toBe('11 K');
    expect(abbreviate(691)).toBe('691');
    expect(groupDigits(593_991)).toBe('593,991');
  });
});

describe('rendered block', () => {
  it('states its basis and how to reproduce itself', () => {
    const out = renderStatBlock(
      baseInput([
        {
          id: 'tool-calls',
          label: 'AGENT TOOL CALLS',
          value: 593_991,
          window: { kind: 'trailing', days: 7 },
          sourceTable: 'harness_shared.tool_invocations',
          retentionHorizonsDays: [],
        },
      ]),
    );
    expect(out.text).toContain('npm run stats:proof');
    expect(out.text).toContain('git-tracked');
    expect(out.text).toContain('0.90:1');
    expect(out.text).toContain('593,991');
    // Every ledger figure carries its qualifier in the output, never a bare number.
    expect(out.text).toContain('LAST 7 DAYS');
  });

  it('pairs every ledger figure with a qualifier line', () => {
    const out = renderStatBlock(
      baseInput([
        {
          id: 'a',
          label: 'A',
          value: 1,
          window: { kind: 'trailing', days: 7 },
          sourceTable: 't',
          retentionHorizonsDays: [],
        },
        {
          id: 'b',
          label: 'B',
          value: 2,
          window: { kind: 'trailing', days: 7 },
          sourceTable: 't',
          retentionHorizonsDays: [],
        },
      ]),
    );
    expect(out.figures).toHaveLength(2);
    for (const f of out.figures) {
      expect(f.qualifier.length).toBeGreaterThan(0);
    }
  });
});

function baseInput(ledger: LedgerFigure[]): StatBlockInput {
  return {
    measuredAt: new Date('2026-08-08T00:00:00Z'),
    firstCommit: new Date('2026-04-06T00:00:00Z'),
    repo: {
      totalLines: 2_405_004,
      totalFiles: 11_495,
      testLines: 1_138_909,
      testFiles: 5_692,
      rustLines: 46_182,
      migrations: 630,
      tools: 691,
      toolGroups: 139,
      blueprints: 48,
      basis: 'git-tracked TypeScript, excluding retired code (git ls-files)',
    },
    ledger,
  };
}
