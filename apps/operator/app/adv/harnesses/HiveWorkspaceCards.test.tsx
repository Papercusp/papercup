// @vitest-environment jsdom
//
// HiveWorkspaceCards — the all-mode (`?scope=all`, "All Pots") workspace view,
// redesigned as a flat, sortable RichGrid list (WI-3345). Purely presentational
// (props in, DOM out); deps are useLexicon (mocked) + the shared RichGrid. We
// assert the EMPTY state (with/without onCreate), one row per pot (roots +
// members), that a hive HOME is a root row and NOT also a member row, the
// description / shared / live-state affordances, and that clicking a root /
// member row fires onDrill with (hiveRootSlug, rowSlug).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// useLexicon: t('pot') → 'Pot', t('pot',{plural}) → 'Pots',
// t('harness',{plural}) → 'Harnesses'. Enough for the labels this view reads.
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (term: string, opts?: { plural?: boolean }) => {
    const cap = term[0].toUpperCase() + term.slice(1);
    if (!opts?.plural) return cap;
    return term === 'pot' ? 'Pots' : term === 'harness' ? 'Harnesses' : `${cap}s`;
  },
}));

import HiveWorkspaceCards, {
  flattenPotRows,
  type HiveWorkspaceCardsProps,
  type PotProject,
} from './HiveWorkspaceCards';
import type { HiveGroup } from './harness-hive-groups';

afterEach(() => cleanup());

function proj(slug: string, over: Partial<PotProject> = {}): HiveGroup['root'] {
  return { slug, ...over } as HiveGroup['root'];
}
function group(rootSlug: string, members: HiveGroup['members'], rootOver: Partial<PotProject> = {}): HiveGroup {
  return { root: proj(rootSlug, rootOver), members };
}

describe('flattenPotRows', () => {
  it('emits one row per distinct pot: root first, then non-root members', () => {
    const rows = flattenPotRows([
      group('alpha', [proj('alpha'), proj('alpha-web')]),
      group('beta', [proj('beta')]),
    ]);
    expect(rows.map((r) => r.slug)).toEqual(['alpha', 'alpha-web', 'beta']);
    // root carries the sub-harness count (non-root members); members carry null
    expect(rows[0]).toMatchObject({ slug: 'alpha', isRoot: true, memberCount: 1, hiveRootSlug: 'alpha' });
    expect(rows[1]).toMatchObject({ slug: 'alpha-web', isRoot: false, memberCount: null, hiveRootSlug: 'alpha', hiveLabel: 'alpha' });
    expect(rows[2]).toMatchObject({ slug: 'beta', isRoot: true, memberCount: 0 });
  });

  it('never emits the hive HOME as a member row', () => {
    const rows = flattenPotRows([
      group('demo-hive', [proj('demo-hive', { harness_kind: 'hive' }), proj('demo')], { harness_kind: 'hive' }),
    ]);
    expect(rows.map((r) => r.slug)).toEqual(['demo-hive', 'demo']);
    expect(rows[0]).toMatchObject({ slug: 'demo-hive', isRoot: true, kind: 'hive', memberCount: 1 });
    expect(rows[1]).toMatchObject({ slug: 'demo', isRoot: false, hiveRootSlug: 'demo-hive' });
  });
});

describe('<HiveWorkspaceCards /> empty state', () => {
  it('renders the no-pots hint (pluralized, lowercased) with no grid rows', () => {
    render(<HiveWorkspaceCards groups={[]} onDrill={vi.fn()} />);
    expect(screen.getByText(/no pots yet\./i)).toBeTruthy();
    expect(screen.queryByTestId('hive-card-alpha')).toBeNull();
  });

  it('omits the Create button when no onCreate is supplied', () => {
    render(<HiveWorkspaceCards groups={[]} onDrill={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /create new pot/i })).toBeNull();
  });

  it('shows the Create button and fires onCreate when supplied', () => {
    const onCreate = vi.fn();
    render(<HiveWorkspaceCards groups={[]} onDrill={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /create new pot/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

describe('<HiveWorkspaceCards /> list', () => {
  // The root's own metadata (hasState/description/is_shared) lives on the ROOT
  // override — mirroring groupByHive, where the root and its lite entry are the
  // same object; the flat root row reads from `g.root`, not a member copy.
  const groups: HiveWorkspaceCardsProps['groups'] = [
    group(
      'alpha',
      [proj('alpha-web', { harness_kind: 'sub', hasState: false })],
      { hasState: true, is_shared: true, description: 'The alpha pot.' },
    ),
    group('beta', [proj('beta')]),
  ];

  it('renders the workspace-cards container and a row per pot', () => {
    render(<HiveWorkspaceCards groups={groups} onDrill={vi.fn()} />);
    expect(screen.getByTestId('hive-workspace-cards')).toBeTruthy();
    expect(screen.getByTestId('hive-card-alpha')).toBeTruthy();
    expect(screen.getByTestId('hive-member-alpha-web')).toBeTruthy();
    expect(screen.getByTestId('hive-card-beta')).toBeTruthy();
  });

  it('does NOT list the hive HOME (harness_kind:hive) as a member row', () => {
    const grps: HiveWorkspaceCardsProps['groups'] = [
      group('demo-hive', [proj('demo-hive', { harness_kind: 'hive' }), proj('demo', { hasState: true })], {
        harness_kind: 'hive',
      }),
    ];
    render(<HiveWorkspaceCards groups={grps} onDrill={vi.fn()} />);
    expect(screen.getByTestId('hive-card-demo-hive')).toBeTruthy();
    expect(screen.queryByTestId('hive-member-demo-hive')).toBeNull();
    expect(screen.getByTestId('hive-member-demo')).toBeTruthy();
  });

  it('shows the shared affordance only on a shared root', () => {
    render(<HiveWorkspaceCards groups={groups} onDrill={vi.fn()} />);
    expect(screen.getByTestId('hive-card-alpha').querySelector('.pc-pot-shared')).toBeTruthy();
    expect(screen.getByTestId('hive-card-beta').querySelector('.pc-pot-shared')).toBeNull();
  });

  it('marks a pot with state via the is-live dot and shows the description', () => {
    render(<HiveWorkspaceCards groups={groups} onDrill={vi.fn()} />);
    const alpha = screen.getByTestId('hive-card-alpha');
    expect(alpha.querySelector('.pc-pot-dot.is-live')).toBeTruthy();
    expect(alpha.textContent).toContain('The alpha pot.');
    // a pot without state → no live dot
    expect(screen.getByTestId('hive-member-alpha-web').querySelector('.pc-pot-dot.is-live')).toBeNull();
  });

  it('drills into the root when its row is clicked (hive===member===root)', () => {
    const onDrill = vi.fn();
    render(<HiveWorkspaceCards groups={groups} onDrill={onDrill} />);
    fireEvent.click(screen.getByTestId('hive-card-alpha'));
    expect(onDrill).toHaveBeenCalledWith('alpha', 'alpha');
  });

  it('drills into a member with (hiveRoot, memberSlug)', () => {
    const onDrill = vi.fn();
    render(<HiveWorkspaceCards groups={groups} onDrill={onDrill} />);
    fireEvent.click(screen.getByTestId('hive-member-alpha-web'));
    expect(onDrill).toHaveBeenCalledWith('alpha', 'alpha-web');
  });
});
