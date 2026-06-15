// @vitest-environment jsdom
//
// HiveMemberRail — the in-tab member selector for the Harnesses tab. Pure
// presentational logic worth testing: a solo hive (≤1 member) renders nothing;
// a multi-member hive renders the rail, open (full list) or collapsed (the
// expand button), with the open/closed state in nuqs (?rail). We assert the
// solo-null case, the open list (active / root / kind / shared / liveness
// affordances), onSelect wiring, and the collapsed ↔ open toggle through the
// mocked nuqs boolean.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// nuqs: ?rail boolean backed by a real useState seeded with the parser default
// (parseAsBoolean.withDefault(true)). Setter flips it so the collapse/expand
// toggle actually re-renders.
vi.mock('nuqs', () => ({
  useQueryState: (_key: string, opts?: { defaultValue?: unknown }) => {
    const [v, setV] = React.useState(opts?.defaultValue ?? null);
    return [v, async (x: unknown) => setV(x)];
  },
  parseAsBoolean: { withDefault: (d: unknown) => ({ defaultValue: d }) },
}));

vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (term: string, opts?: { plural?: boolean }) => {
    const cap = term[0].toUpperCase() + term.slice(1);
    if (!opts?.plural) return cap;
    return term === 'harness' ? 'Harnesses' : `${cap}s`;
  },
}));

// Tooltip wraps its child in a Radix portal that needs a provider; the label is
// not load-bearing here, so a passthrough keeps the trigger button in the DOM.
vi.mock('../../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import HiveMemberRail from './HiveMemberRail';
import type { HiveMember } from './harness-axis';

afterEach(() => cleanup());

function member(slug: string, over: Partial<HiveMember> = {}): HiveMember {
  return { slug, harness_kind: null, is_shared: false, isRoot: false, ...over };
}

const MEMBERS: HiveMember[] = [
  member('root-h', { isRoot: true }),
  member('child-a', { harness_kind: 'sub', is_shared: true }),
  member('child-b'),
];

describe('<HiveMemberRail /> solo hive', () => {
  it('renders nothing for an empty member list', () => {
    const { container } = render(
      <HiveMemberRail members={[]} activeSlug={null} onSelect={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a single-member hive (no choice to make)', () => {
    const { container } = render(
      <HiveMemberRail members={[member('only')]} activeSlug="only" onSelect={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('<HiveMemberRail /> open (default)', () => {
  it('lists every member with the count in the header', () => {
    render(<HiveMemberRail members={MEMBERS} activeSlug="child-a" onSelect={vi.fn()} />);
    const rail = screen.getByTestId('hive-member-rail');
    expect(rail.getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByTestId('hive-member-root-h')).toBeTruthy();
    expect(screen.getByTestId('hive-member-child-a')).toBeTruthy();
    expect(screen.getByTestId('hive-member-child-b')).toBeTruthy();
    expect(rail.querySelector('.pc-hive-rail__title-count')?.textContent).toBe('3');
  });

  it('marks the active member (is-active + aria-current) and only that one', () => {
    render(<HiveMemberRail members={MEMBERS} activeSlug="child-a" onSelect={vi.fn()} />);
    const active = screen.getByTestId('hive-member-child-a');
    expect(active.className).toContain('is-active');
    expect(active.getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('hive-member-root-h').className).not.toContain('is-active');
  });

  it('renders the root Home marker, kind badge, shared icon, and liveness dot', () => {
    render(
      <HiveMemberRail
        members={MEMBERS}
        activeSlug={null}
        onSelect={vi.fn()}
        livenessBySlug={{ 'child-a': true }}
      />,
    );
    expect(screen.getByTestId('hive-member-root-h').querySelector('.pc-hive-rail__root')).toBeTruthy();
    const childA = screen.getByTestId('hive-member-child-a');
    expect(childA.querySelector('.pc-hive-rail__kind')?.textContent).toBe('sub');
    expect(childA.querySelector('.pc-hive-rail__shared')).toBeTruthy();
    expect(childA.querySelector('.pc-hive-rail__dot.is-live')).toBeTruthy();
    // child-b: no liveness hint → not live
    expect(screen.getByTestId('hive-member-child-b').querySelector('.pc-hive-rail__dot.is-live')).toBeNull();
  });

  it('fires onSelect with the member slug on click', () => {
    const onSelect = vi.fn();
    render(<HiveMemberRail members={MEMBERS} activeSlug={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('hive-member-child-b'));
    expect(onSelect).toHaveBeenCalledWith('child-b');
  });
});

describe('<HiveMemberRail /> collapse toggle', () => {
  it('collapses to the expand button on Hide, then re-opens on the expand click', () => {
    render(<HiveMemberRail members={MEMBERS} activeSlug={null} onSelect={vi.fn()} />);
    // open → click Hide
    fireEvent.click(screen.getByRole('button', { name: /hide harnesses/i }));
    const collapsed = screen.getByTestId('hive-member-rail');
    expect(collapsed.getAttribute('data-collapsed')).toBe('true');
    // the member list is gone; the count badge shows the member total
    expect(screen.queryByTestId('hive-member-root-h')).toBeNull();
    expect(collapsed.querySelector('.pc-hive-rail__count')?.textContent).toBe('3');
    // expand again → the list is back
    fireEvent.click(collapsed.querySelector('.pc-hive-rail__expand') as HTMLButtonElement);
    expect(screen.getByTestId('hive-member-rail').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByTestId('hive-member-root-h')).toBeTruthy();
  });
});
