/**
 * Coverage for `buildLaunchPlanOptions` — the grouped + sorted option
 * tree feeding the "Start from plan context" picker.
 *
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` P-026/P-028
 * and D-011 (client-side grouping over a flat payload).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanListRow } from '@/app/admin/plans/plans-api';
import { buildLaunchPlanOptions } from '../AdvSessionsClient';

function plan(over: Partial<PlanListRow> & { slug: string; harness: string }): PlanListRow {
  return {
    slug: over.slug,
    title: over.title ?? `Title for ${over.slug}`,
    status: over.status ?? 'active',
    updated: over.updated ?? null,
    owner: null,
    archived: false,
    isLegacy: false,
    itemCounts: null,
    nextAction: null,
    harness: over.harness,
  } as PlanListRow;
}

describe('buildLaunchPlanOptions', () => {
  const FIXED_NOW = Date.parse('2026-05-25T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns just the placeholder when no plans', () => {
    const opts = buildLaunchPlanOptions([], null, false);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ value: '__select_plan__', label: 'Select plan…' });
  });

  it('uses "Loading plans…" when loading and no plans yet', () => {
    const opts = buildLaunchPlanOptions([], null, true);
    expect(opts[0]).toMatchObject({ label: 'Loading plans…' });
  });

  it('groups by harness slug', () => {
    const plans = [
      plan({ slug: 'a-foo', harness: 'papercup' }),
      plan({ slug: 'b-foo', harness: 'sheets' }),
      plan({ slug: 'c-foo', harness: 'papercup' }),
    ];
    const opts = buildLaunchPlanOptions(plans, null, false);
    // [placeholder, group, group]
    expect(opts).toHaveLength(3);
    const groups = opts.slice(1) as Array<{ kind: 'group'; label: string; options: Array<{ value: string }> }>;
    const papercupGroup = groups.find((g) => g.label === 'papercup')!;
    const sheetsGroup = groups.find((g) => g.label === 'sheets')!;
    expect(papercupGroup.options.map((o) => o.value)).toEqual(['a-foo', 'c-foo']);
    expect(sheetsGroup.options.map((o) => o.value)).toEqual(['b-foo']);
  });

  it('sorts plans within a group by updated DESC (newest first)', () => {
    const plans = [
      plan({ slug: 'old', harness: 'papercup', updated: '2026-05-01T00:00:00Z' }),
      plan({ slug: 'newest', harness: 'papercup', updated: '2026-05-24T00:00:00Z' }),
      plan({ slug: 'middle', harness: 'papercup', updated: '2026-05-20T00:00:00Z' }),
    ];
    const opts = buildLaunchPlanOptions(plans, null, false);
    const group = opts[1] as { options: Array<{ value: string }> };
    expect(group.options.map((o) => o.value)).toEqual(['newest', 'middle', 'old']);
  });

  it('appends "updated Nd ago" to each option label', () => {
    const plans = [
      plan({ slug: 'recent', harness: 'papercup', title: 'Recent plan', updated: '2026-05-24T08:00:00Z' }),
    ];
    const opts = buildLaunchPlanOptions(plans, null, false);
    const group = opts[1] as { options: Array<{ label: string }> };
    expect(group.options[0].label).toBe('Recent plan · updated yesterday');
  });

  it('puts the active harness group first, others alphabetical, no-harness last', () => {
    const plans = [
      plan({ slug: 'z', harness: 'zeta' }),
      plan({ slug: 'a', harness: 'alpha' }),
      plan({ slug: 'p', harness: 'papercup' }),
      plan({ slug: 'no', harness: '' }),
    ];
    const opts = buildLaunchPlanOptions(plans, 'papercup', false, '(no hive)');
    const labels = (opts.slice(1) as Array<{ label: string }>).map((g) => g.label);
    expect(labels).toEqual(['papercup', 'alpha', 'zeta', '(no hive)']);
  });

  it('omits the active-first slot when the active harness has no plans', () => {
    const plans = [plan({ slug: 'a', harness: 'alpha' })];
    const opts = buildLaunchPlanOptions(plans, 'papercup', false);
    const labels = (opts.slice(1) as Array<{ label: string }>).map((g) => g.label);
    expect(labels).toEqual(['alpha']);
  });

  it('omits "updated …" when the plan has no updated field', () => {
    const plans = [plan({ slug: 's', harness: 'papercup', title: 'No date', updated: null })];
    const opts = buildLaunchPlanOptions(plans, null, false);
    const group = opts[1] as { options: Array<{ label: string }> };
    expect(group.options[0].label).toBe('No date');
  });
});
