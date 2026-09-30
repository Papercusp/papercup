/**
 * Unit tests for the /api/tui/goals shaper (P-032, pui-agent-context-cockpit-
 * 2026-08-26). Pure-function coverage — the resolver query itself is covered by
 * the sync-resolver integration test beside goals.ts; here we pin the DTO
 * flattening the TUI decodes against (apps/tui/src/models.rs GoalSummary).
 */
import { describe, expect, it } from 'vitest';
import { shapeTuiGoals, type TuiGoalSource } from './goals';

function row(overrides: Partial<TuiGoalSource> = {}): TuiGoalSource {
  return {
    id: 'goal-1',
    title: 'Ship the spine',
    status: 'active',
    effectiveStatus: 'active',
    deactivated: false,
    holderLiveness: 'held',
    parentId: null,
    potCount: 2,
    pots: [
      { harnessSlug: 'papercusp', role: 'owner', servesGoals: 1 },
      { harnessSlug: 'sidestage', role: 'contributing', servesGoals: 3 },
    ],
    openWorkItems: 4,
    needsHuman: 1,
    spendUsd: 12.5,
    budgetCents: 50000,
    lastActivityAt: '2026-08-27T00:00:00Z',
    ...overrides,
  };
}

describe('shapeTuiGoals', () => {
  it('maps resolver rows to the flat TUI DTO verbatim', () => {
    const [dto] = shapeTuiGoals([row()]);
    expect(dto).toEqual({
      id: 'goal-1',
      title: 'Ship the spine',
      status: 'active',
      effectiveStatus: 'active',
      deactivated: false,
      holderLiveness: 'held',
      parentId: null,
      potCount: 2,
      pots: [
        { harnessSlug: 'papercusp', role: 'owner', servesGoals: 1 },
        { harnessSlug: 'sidestage', role: 'contributing', servesGoals: 3 },
      ],
      openWorkItems: 4,
      needsHuman: 1,
      spendUsd: 12.5,
      budgetCents: 50000,
      lastActivityAt: '2026-08-27T00:00:00Z',
    });
  });

  it('carries the dormancy fold and null-shaped fields through untouched', () => {
    const [dto] = shapeTuiGoals([
      row({
        effectiveStatus: 'dormant',
        deactivated: true,
        holderLiveness: 'lost',
        parentId: 'goal-0',
        pots: [],
        budgetCents: null,
        lastActivityAt: null,
      }),
    ]);
    expect(dto.effectiveStatus).toBe('dormant');
    expect(dto.deactivated).toBe(true);
    expect(dto.holderLiveness).toBe('lost');
    expect(dto.parentId).toBe('goal-0');
    expect(dto.pots).toEqual([]);
    expect(dto.budgetCents).toBeNull();
    expect(dto.lastActivityAt).toBeNull();
  });

  it('passes unmeasured spend through as null, never $0 (WI-1074208)', () => {
    const [dto] = shapeTuiGoals([row({ spendUsd: null })]);
    expect(dto.spendUsd).toBeNull();
  });

  it('shapes an empty resolver page to an empty list (no fabricated rows)', () => {
    expect(shapeTuiGoals([])).toEqual([]);
  });
});
