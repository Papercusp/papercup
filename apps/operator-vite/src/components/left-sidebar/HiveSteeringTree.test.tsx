// @vitest-environment jsdom
/**
 * HiveSteeringTree render coverage (steering-nested-hive-plan-tree-2026-06-17
 * P-002) — the nested hive→plan steering picker. Purely presentational over a
 * prebuilt SteeringTree; this pins the render branches and the pure toggle
 * intents:
 *   • the loading / empty / populated states;
 *   • the "no restriction" vs "N hives" header + scope copy (anyHiveChecked);
 *   • the illegal-plan alert (illegalCount > 0);
 *   • a HiveNode's meta (all-plans / some / count) + the expanded plan rows;
 *   • the per-hive all/none + the global all/none chips → callbacks;
 *   • the unassigned (no-hive) plans section.
 * Radix Collapsible/Checkbox render natively in jsdom; the @/app/harness/Checkbox
 * alias resolves to the operator component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import HiveSteeringTree, { type HiveSteeringTreeProps } from './HiveSteeringTree';
import type { SteeringTree, TreeHive, TreePlan } from './hive-steering-tree';

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
    expect(screen.getByText(/Loading hives \+ plans/)).toBeTruthy();
  });

  it('renders the empty placeholder when there are no hives', () => {
    render(<HiveSteeringTree {...makeProps()} />);
    expect(screen.getByText('No hives with plans.')).toBeTruthy();
  });

  it('shows "no restriction" + the open scope copy when nothing is checked', () => {
    render(<HiveSteeringTree {...makeProps({ tree: tree({ hives: [hive()] }) })} />);
    expect(screen.getByText('no restriction')).toBeTruthy();
    expect(screen.getByText(/Queen may work ANY hive\/plan/)).toBeTruthy();
  });

  it('shows the restricted hive count + restricted scope copy when a hive is checked', () => {
    render(
      <HiveSteeringTree
        {...makeProps({ tree: tree({ hives: [hive({ checked: true, planMode: 'all' })] }) })}
      />,
    );
    expect(screen.getByText('1 hive')).toBeTruthy();
    expect(screen.getByText(/Queen works ONLY the checked hives/)).toBeTruthy();
  });

  it('renders the illegal-plan alert when illegalCount > 0', () => {
    render(<HiveSteeringTree {...makeProps({ tree: tree({ hives: [hive()] }), illegalCount: 2 })} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('2 eligible plans');
    expect(alert.textContent).toContain('excluded hive');
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
    fireEvent.click(screen.getByLabelText('Toggle hive hive-a'));
    expect(onToggleHive).toHaveBeenCalledWith('hive-a');
  });

  it('fires onSetHivePlans(slug, false) from the per-hive "none" chip', () => {
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
  it('fires onSetAllHives(true) from the header "all" chip', () => {
    const onSetAllHives = vi.fn();
    render(
      <HiveSteeringTree {...makeProps({ tree: tree({ hives: [hive()] }), onSetAllHives })} />,
    );
    fireEvent.click(screen.getByLabelText('Select every hive'));
    expect(onSetAllHives).toHaveBeenCalledWith(true);
  });

  it('disables the header "none" chip when nothing is restricted', () => {
    render(<HiveSteeringTree {...makeProps({ tree: tree({ hives: [hive()] }) })} />);
    const noneChip = screen.getByLabelText('Clear the scope') as HTMLButtonElement;
    expect(noneChip.disabled).toBe(true);
  });

  it('renders the unassigned (no-hive) plans section', () => {
    render(
      <HiveSteeringTree
        {...makeProps({
          tree: tree({ hives: [hive()], unassigned: [plan({ slug: 'orphan', title: 'Orphan Plan' })] }),
        })}
      />,
    );
    expect(screen.getByText(/No hive — not steerable/)).toBeTruthy();
    expect(screen.getByText('Orphan Plan')).toBeTruthy();
    expect(screen.getByText('no hive')).toBeTruthy();
  });
});
