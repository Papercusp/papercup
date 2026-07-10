// @vitest-environment jsdom
/**
 * HiveSteeringTree render coverage (steering-nested-hive-plan-tree-2026-06-17
 * P-002) — the nested hive→plan steering picker. Purely presentational over a
 * prebuilt SteeringTree; this pins the render branches and the pure toggle
 * intents:
 *   • the loading / empty / populated states;
 *   • the compact "all work" vs focused-count header state (anyHiveChecked);
 *   • the illegal-plan alert (illegalCount > 0);
 *   • a HiveNode's meta (all-plans / some / count) + the expanded plan rows;
 *   • the per-hive all/none + the global all/clear chips → callbacks;
 *   • the unassigned (no-hive) plans section.
 * Radix Collapsible/Checkbox render natively in jsdom; the @/app/harness/Checkbox
 * alias resolves to the operator component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import HiveSteeringTree, { type HiveSteeringTreeProps } from './HiveSteeringTree';
import type { SteeringTree, TreeHive, TreePlan } from './hive-steering-tree';

// Lexicon resolver mocked to ECHO its key (t('brain') → 'brain', t('pot') → 'pot')
// — isolates from the THE_HIVE flag hook; classic pack renders 'Brain'/'Pot(s)' at
// runtime (restore-pot-lexicon P-005).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

function plan(over: Partial<TreePlan> = {}): TreePlan {
  return {
    slug: 'p-1',
    title: 'Plan One',
    status: 'active',
    startStatus: 'started',
    inActive: true,
    checked: false,
    ...over,
  };
}

function hive(over: Partial<TreeHive> = {}): TreeHive {
  return {
    slug: 'hive-a',
    label: 'Hive A',
    checked: false,
    planMode: 'none',
    plans: [],
    ...over,
  };
}

function tree(over: Partial<SteeringTree> = {}): SteeringTree {
  return { hives: [], unassigned: [], ...over };
}

function makeProps(over: Partial<HiveSteeringTreeProps> = {}): HiveSteeringTreeProps {
  return {
    tree: tree(),
    illegalCount: 0,
    busy: false,
    loading: false,
    onToggleHive: vi.fn(),
    onTogglePlan: vi.fn(),
    onSetHivePlans: vi.fn(),
    onSetAllHives: vi.fn(),
    ...over,
  };
}

afterEach(cleanup);

describe('<HiveSteeringTree> states', () => {
  it('renders the loading placeholder', () => {
    render(<HiveSteeringTree {...makeProps({ loading: true })} />);
    expect(screen.getByText(/Loading pot \+ plans/)).toBeTruthy();
  });

  it('renders the empty placeholder when there are no hives', () => {
    render(<HiveSteeringTree {...makeProps()} />);
    expect(screen.getByText('No pot with plans.')).toBeTruthy();
  });

  it('shows the compact all-work state when nothing is checked', () => {
    render(<HiveSteeringTree {...makeProps({ tree: tree({ hives: [hive()] }) })} />);
    expect(screen.getByText('all work')).toBeTruthy();
    expect(screen.queryByText(/brain may work ANY pot\/plan/)).toBeNull();
  });

  it('shows the focused pot count without an instructional paragraph when a pot is checked', () => {
    render(
      <HiveSteeringTree
        {...makeProps({ tree: tree({ hives: [hive({ checked: true, planMode: 'all' })] }) })}
      />,
    );
    expect(screen.getByText('1 pot focused')).toBeTruthy();
    expect(screen.queryByText(/brain works ONLY the checked pot/)).toBeNull();
  });

  it('renders the illegal-plan alert when illegalCount > 0', () => {
    render(<HiveSteeringTree {...makeProps({ tree: tree({ hives: [hive()] }), illegalCount: 2 })} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('2 eligible plans');
    expect(alert.textContent).toContain('excluded pot');
  });
});

describe('<HiveSteeringTree> hive nodes', () => {
  it('renders an unchecked hive with its plan count meta', () => {
    render(
      <HiveSteeringTree
        {...makeProps({ tree: tree({ hives: [hive({ plans: [plan(), plan({ slug: 'p-2' })] })] }) })}
      />,
    );
    expect(screen.getByText('Hive A')).toBeTruthy();
    // unchecked → "N plans" meta
    expect(screen.getByText('2 plans')).toBeTruthy();
  });

  it('renders a checked hive in all-plans mode with the "all plans" meta', () => {
    render(
      <HiveSteeringTree
        {...makeProps({
          tree: tree({ hives: [hive({ checked: true, planMode: 'all', plans: [plan({ checked: true })] })] }),
        })}
      />,
    );
    expect(screen.getByText('all plans')).toBeTruthy();
  });

  it('renders the eligible/total meta in some-mode and shows the plan rows when expanded', () => {
    render(
      <HiveSteeringTree
        {...makeProps({
          tree: tree({
            hives: [
              hive({
                checked: true,
                planMode: 'some',
                plans: [plan({ slug: 'p-1', title: 'Plan One', checked: true }), plan({ slug: 'p-2', title: 'Plan Two', checked: false })],
              }),
            ],
          }),
        })}
      />,
    );
    // some-mode → "1/2"
    expect(screen.getByText('1/2')).toBeTruthy();
    // a checked hive defaults to expanded → plan rows render
    expect(screen.getByText('Plan One')).toBeTruthy();
    expect(screen.getByText('Plan Two')).toBeTruthy();
  });

  it('fires onToggleHive when the hive checkbox is clicked', () => {
    const onToggleHive = vi.fn();
    render(
      <HiveSteeringTree
        {...makeProps({ tree: tree({ hives: [hive({ plans: [plan()] })] }), onToggleHive })}
      />,
    );
    fireEvent.click(screen.getByLabelText('Toggle pot hive-a'));
    expect(onToggleHive).toHaveBeenCalledWith('hive-a');
  });

  it('fires onSetHivePlans(slug, false) from the per-hive Remove action', () => {
    const onSetHivePlans = vi.fn();
    render(
      <HiveSteeringTree
        {...makeProps({
          tree: tree({ hives: [hive({ checked: true, planMode: 'some', plans: [plan()] })] }),
          onSetHivePlans,
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText('Remove hive-a from scope'));
    expect(onSetHivePlans).toHaveBeenCalledWith('hive-a', false);
  });
});

describe('<HiveSteeringTree> header chips + unassigned', () => {
  it('offers one All work escape hatch when focus is active', () => {
    const onSetAllHives = vi.fn();
    render(
      <HiveSteeringTree {...makeProps({ tree: tree({ hives: [hive({ checked: true, planMode: 'all' })] }), onSetAllHives })} />,
    );
    fireEvent.click(screen.getByLabelText('Clear work focus'));
    expect(onSetAllHives).toHaveBeenCalledWith(false);
  });

  it('hides the reset action when all work is already available', () => {
    render(<HiveSteeringTree {...makeProps({ tree: tree({ hives: [hive()] }) })} />);
    expect(screen.queryByLabelText('Clear work focus')).toBeNull();
  });

  it('renders the unassigned (no-hive) plans section', () => {
    render(
      <HiveSteeringTree
        {...makeProps({
          tree: tree({ hives: [hive()], unassigned: [plan({ slug: 'orphan', title: 'Orphan Plan' })] }),
        })}
      />,
    );
    expect(screen.getByText(/No pot — not steerable/)).toBeTruthy();
    expect(screen.getByText('Orphan Plan')).toBeTruthy();
    expect(screen.getByText('no pot')).toBeTruthy();
  });
});
