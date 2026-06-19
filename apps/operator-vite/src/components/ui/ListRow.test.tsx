// @vitest-environment jsdom
/**
 * ListRow render coverage — the shared sidebar row. Each optional slot
 * (indicator/sub/meta/action) is conditional, and the class string is composed
 * from isClickable/isSelected/className; this pins every branch plus the onClick
 * handler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ListRow } from './ListRow';

afterEach(cleanup);

describe('<ListRow>', () => {
  it('renders just the title with the base class, no optional slots', () => {
    const { container } = render(<ListRow title="Title only" />);
    expect(screen.getByText('Title only')).toBeTruthy();
    const row = container.querySelector('.pclsb-row')!;
    expect(row).toBeTruthy();
    expect(row.className).not.toContain('is-clickable');
    expect(row.className).not.toContain('is-selected');
    // optional slots absent
    expect(container.querySelector('.pclsb-dot')).toBeNull();
    expect(container.querySelector('.pclsb-row__sub')).toBeNull();
    expect(container.querySelector('.pclsb-row__meta')).toBeNull();
    expect(container.querySelector('.pclsb-pill')).toBeNull();
  });

  it('renders all optional slots when provided', () => {
    const { container } = render(
      <ListRow
        indicator={<i>dot</i>}
        title="T"
        sub="subtext"
        meta="metatext"
        action={<b>act</b>}
      />,
    );
    expect(container.querySelector('.pclsb-dot')!.textContent).toContain('dot');
    expect(screen.getByText('subtext')).toBeTruthy();
    expect(screen.getByText('metatext')).toBeTruthy();
    expect(container.querySelector('.pclsb-pill')!.textContent).toContain('act');
  });

  it('adds is-clickable / is-selected / custom class', () => {
    const { container } = render(
      <ListRow title="T" isClickable isSelected className="mine" />,
    );
    const row = container.querySelector('.pclsb-row')!;
    expect(row.className).toContain('is-clickable');
    expect(row.className).toContain('is-selected');
    expect(row.className).toContain('mine');
  });

  it('invokes onClick when the row is clicked', () => {
    const onClick = vi.fn();
    const { container } = render(<ListRow title="Clickme" isClickable onClick={onClick} />);
    fireEvent.click(container.querySelector('.pclsb-row')!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
