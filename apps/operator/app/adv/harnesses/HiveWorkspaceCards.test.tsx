// @vitest-environment jsdom
//
// HiveWorkspaceCards — the all-mode (`?scope=all`) hive-grouped workspace view.
// Purely presentational (props in, DOM out); the only dependency is useLexicon
// for the hive/member labels, mocked to an identity-ish resolver. We assert the
// EMPTY state (with/without onCreate), one card per group, the member list, the
// root/shared/kind/liveness affordances, and that clicking a card head / member
// fires onDrill with (hiveSlug, memberSlug).

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

import HiveWorkspaceCards, { type HiveWorkspaceCardsProps } from './HiveWorkspaceCards';
import type { HiveGroup } from './harness-hive-groups';

afterEach(() => cleanup());

function proj(slug: string, over: Partial<HiveGroup['root']> = {}): HiveGroup['root'] {
  return { slug, ...over };
}
function group(rootSlug: string, members: HiveGroup['members'], rootOver: Partial<HiveGroup['root']> = {}): HiveGroup {
  return { root: proj(rootSlug, rootOver), members };
}

describe('<HiveWorkspaceCards /> empty state', () => {
  it('renders the no-hives hint (pluralized, lowercased) with no grid', () => {
    const { container } = render(<HiveWorkspaceCards groups={[]} onDrill={vi.fn()} />);
    expect(screen.getByText(/no pots yet\./i)).toBeTruthy();
    expect(container.querySelector('.pc-hive-cards__grid')).toBeNull();
  });

  it('omits the Create button when no onCreate is supplied', () => {
    render(<HiveWorkspaceCards groups={[]} onDrill={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /create new pot/i })).toBeNull();
  });

  it('shows the Create button and fires onCreate when supplied', () => {
    const onCreate = vi.fn();
    render(<HiveWorkspaceCards groups={[]} onDrill={vi.fn()} onCreate={onCreate} />);
    const btn = screen.getByRole('button', { name: /create new pot/i });
    fireEvent.click(btn);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

describe('<HiveWorkspaceCards /> grid', () => {
  const groups: HiveWorkspaceCardsProps['groups'] = [
    group('alpha', [
      proj('alpha', { hasState: true }),
      proj('alpha-web', { harness_kind: 'sub', hasState: false }),
    ], { is_shared: true }),
    group('beta', [proj('beta')]),
  ];

  it('renders one card per group with the member count', () => {
    const { container } = render(<HiveWorkspaceCards groups={groups} onDrill={vi.fn()} />);
    expect(container.querySelectorAll('.pc-hive-cards__card')).toHaveLength(2);
    expect(screen.getByTestId('hive-card-alpha')).toBeTruthy();
    expect(screen.getByTestId('hive-card-beta')).toBeTruthy();
    // alpha has 2 members → count badge "2"
    const alpha = screen.getByTestId('hive-card-alpha');
    expect(alpha.querySelector('.pc-hive-cards__card-count')?.textContent).toBe('2');
  });

  it('shows the shared icon only on a shared root', () => {
    render(<HiveWorkspaceCards groups={groups} onDrill={vi.fn()} />);
    const alpha = screen.getByTestId('hive-card-alpha');
    const beta = screen.getByTestId('hive-card-beta');
    expect(alpha.querySelector('.pc-hive-cards__shared')).toBeTruthy();
    expect(beta.querySelector('.pc-hive-cards__shared')).toBeNull();
  });

  it('marks the live member with the is-live dot and a non-root kind badge', () => {
    render(<HiveWorkspaceCards groups={groups} onDrill={vi.fn()} />);
    const rootMember = screen.getByTestId('hive-member-alpha');
    const subMember = screen.getByTestId('hive-member-alpha-web');
    // alpha has hasState → live dot; the root member shows the Home marker
    expect(rootMember.querySelector('.pc-hive-cards__dot.is-live')).toBeTruthy();
    expect(rootMember.querySelector('.pc-hive-cards__root')).toBeTruthy();
    // the sub member is not live and carries its non-default harness_kind
    expect(subMember.querySelector('.pc-hive-cards__dot.is-live')).toBeNull();
    expect(subMember.querySelector('.pc-hive-cards__kind')?.textContent).toBe('sub');
    // the sub member is not the root → no Home marker
    expect(subMember.querySelector('.pc-hive-cards__root')).toBeNull();
  });

  it('drills into the root when the card head is clicked (hive===member===root)', () => {
    const onDrill = vi.fn();
    render(<HiveWorkspaceCards groups={groups} onDrill={onDrill} />);
    const head = screen.getByTestId('hive-card-alpha').querySelector('.pc-hive-cards__card-head') as HTMLButtonElement;
    fireEvent.click(head);
    expect(onDrill).toHaveBeenCalledWith('alpha', 'alpha');
  });

  it('drills into a member with (hiveRoot, memberSlug)', () => {
    const onDrill = vi.fn();
    render(<HiveWorkspaceCards groups={groups} onDrill={onDrill} />);
    fireEvent.click(screen.getByTestId('hive-member-alpha-web'));
    expect(onDrill).toHaveBeenCalledWith('alpha', 'alpha-web');
  });
});
