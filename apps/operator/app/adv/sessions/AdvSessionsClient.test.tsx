// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterCountLabel } from '@/app/harness/filters';
import type { CompanionListSummary } from '@papercusp/facets';
import type { AdvSessionFacetMeta } from '@papercusp/operator-core/lib/sync-resolver/adv-sessions-list-query';
import {
  mergeAdvSessionPage,
  sessionHarnessOptions,
  sessionHistoryEvidence,
  sessionPlanStats,
} from './sessions-history-model';

const summary: CompanionListSummary<AdvSessionFacetMeta> = {
  total: 15_050,
  matched: 314,
  facets: [
    {
      key: 'plan',
      label: 'Plan',
      values: [
        { value: 'bulk-plan', count: 300, meta: { active: 23 } },
        { value: '__no_plan__', count: 14, meta: { active: 0 } },
      ],
      hiddenValueCount: 0,
      distinctCount: 2,
    },
    {
      key: 'harness',
      label: 'Harness',
      values: [
        { value: 'papercusp', count: 314 },
        { value: 'another-pot', count: 14_736 },
        { value: '__no_harness__', count: 0 },
      ],
      hiddenValueCount: 0,
      distinctCount: 3,
    },
  ],
};

describe('Sessions history view model', () => {
  it('keeps loaded, matched, and workspace populations explicit', () => {
    const evidence = sessionHistoryEvidence({
      error: false,
      updating: false,
      loadedCount: 100,
      summary,
    });
    expect(filterCountLabel(evidence.loaded, 'session').summary).toBe(
      'Showing 100 of 314 sessions',
    );
    expect(filterCountLabel(evidence.matched, 'session')).toMatchObject({
      summary: '314 of 15,050 match',
      evidence: 'corpus',
    });
  });

  it('suppresses both numbers during a paired refetch and preserves an exact zero', () => {
    const updating = sessionHistoryEvidence({
      error: false,
      updating: true,
      loadedCount: 100,
      summary,
    });
    expect(updating).toEqual({
      loaded: { kind: 'unknown', reason: 'updating' },
      matched: { kind: 'unknown', reason: 'updating' },
    });

    const zero = sessionHistoryEvidence({
      error: false,
      updating: false,
      loadedCount: 0,
      summary: { ...summary, matched: 0 },
    });
    expect(filterCountLabel(zero.loaded, 'session').summary).toBe(
      'Showing 0 of 0 sessions',
    );
    expect(filterCountLabel(zero.matched, 'session').summary).toBe(
      '0 of 15,050 match',
    );
  });

  it('builds exact harness option and plan-group counts independently of loaded pages', () => {
    expect(sessionHarnessOptions(summary, false)).toEqual([
      { value: 'another-pot', label: 'another-pot · 14,736 sessions' },
      { value: 'papercusp', label: 'papercusp · 314 sessions' },
    ]);
    expect(sessionHarnessOptions(summary, true)).toEqual([
      { value: 'another-pot', label: 'another-pot' },
      { value: 'papercusp', label: 'papercusp' },
    ]);
    expect(sessionPlanStats(summary)).toEqual(
      new Map([
        ['bulk-plan', { count: 300, active: 23 }],
        ['_', { count: 14, active: 0 }],
      ]),
    );
  });

  it('replaces page one and appends cursor pages without duplicate ledger ids', () => {
    const first = [{ id: 3, label: 'three' }, { id: 2, label: 'two' }];
    expect(mergeAdvSessionPage([], first, null)).toEqual(first);
    const merged = mergeAdvSessionPage(
      first,
      [{ id: 2, label: 'updated' }, { id: 1, label: 'one' }],
      'cursor-2',
    );
    expect(merged).toEqual([
      { id: 3, label: 'three' },
      { id: 2, label: 'updated' },
      { id: 1, label: 'one' },
    ]);
  });
});

describe('AdvSessionsClient wiring guard', () => {
  const source = readFileSync(join(__dirname, 'AdvSessionsClient.tsx'), 'utf8');

  it('pairs the cursor feed with its independent exact summary and server harness predicate', () => {
    expect(source).toContain("queryName: 'advSessions.list'");
    expect(source).toContain("queryName: 'advSessions.summary'");
    expect(source).toContain("{ harnessSlugs: [sessionHarnessFilter] }");
    expect(source).toContain("{ cursor: sessionCursor }");
    expect(source).not.toContain('args: { limit: 200 }');
  });

  it('keeps the zero-match reset and explicit cursor continuation visible', () => {
    expect(source).toContain('No sessions match ${sessionHarnessFilter}.');
    expect(source).toContain('Show all sessions');
    expect(source).toContain('Load older sessions');
    expect(source).toContain('data-testid="sessions-history-count"');
  });

  it('never falls through to the Server window manager without content-origin desktop proof', () => {
    const proof = source.indexOf('await canUseContentOriginDesktopActions()');
    const focusPost = source.indexOf('/api/adv/sessions/focus');
    expect(proof).toBeGreaterThan(-1);
    expect(focusPost).toBeGreaterThan(proof);
    expect(source).toContain('Window focus is available only in the desktop GUI connected to its local Server.');
  });
});
