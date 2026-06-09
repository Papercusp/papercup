import { describe, it, expect } from 'vitest';
import { isTerminalPlanHiddenFromCrossPlan } from './items';

/**
 * EI-154 — the fleet-federation-reanchor trap: a `superseded` plan's `todo` item
 * (P-002) still surfaced in `plans:items actionable=true`, so an agent could pick
 * up and BUILD the rejected design. `plans:items` excludes terminal-status plans
 * (shipped/superseded) from cross-plan queries; this asserts the exclusion guard.
 */
describe('isTerminalPlanHiddenFromCrossPlan', () => {
  it('HIDES a superseded plan from a cross-plan actionable/no-status query', () => {
    expect(isTerminalPlanHiddenFromCrossPlan('superseded', {})).toBe(true);
  });

  it('HIDES a shipped plan from a cross-plan actionable/no-status query', () => {
    expect(isTerminalPlanHiddenFromCrossPlan('shipped', {})).toBe(true);
  });

  it('KEEPS a ready plan (the normal pickable case)', () => {
    expect(isTerminalPlanHiddenFromCrossPlan('ready', {})).toBe(false);
  });

  it('KEEPS an active plan', () => {
    expect(isTerminalPlanHiddenFromCrossPlan('active', {})).toBe(false);
  });

  it('KEEPS a draft plan — only the two terminal states are hidden', () => {
    expect(isTerminalPlanHiddenFromCrossPlan('draft', {})).toBe(false);
  });

  it('KEEPS a null-status (un-normalized / legacy-adjacent) row', () => {
    expect(isTerminalPlanHiddenFromCrossPlan(null, {})).toBe(false);
  });

  it('KEEPS a terminal plan when the caller names the plan explicitly (slug escape)', () => {
    expect(
      isTerminalPlanHiddenFromCrossPlan('superseded', { slug: 'fleet-federation-reanchor-2026-06-06' }),
    ).toBe(false);
  });

  it('KEEPS a terminal plan for a deliberate terminal item-status query (done)', () => {
    expect(isTerminalPlanHiddenFromCrossPlan('shipped', { status: 'done' })).toBe(false);
  });

  it('KEEPS a terminal plan for a deliberate terminal item-status query (dropped)', () => {
    expect(isTerminalPlanHiddenFromCrossPlan('superseded', { status: 'dropped' })).toBe(false);
  });

  it('HIDES a terminal plan for a NON-terminal item-status query (todo) — still the trap', () => {
    expect(isTerminalPlanHiddenFromCrossPlan('superseded', { status: 'todo' })).toBe(true);
  });

  it('HIDES a terminal plan for status:wip / status:blocked (non-terminal)', () => {
    expect(isTerminalPlanHiddenFromCrossPlan('shipped', { status: 'wip' })).toBe(true);
    expect(isTerminalPlanHiddenFromCrossPlan('shipped', { status: 'blocked' })).toBe(true);
  });
});
