// @vitest-environment jsdom
/**
 * Chip / ChipBar render coverage (operator-vite-ui-consolidation U2-5). The
 * shared toggle/action chip + its bar container — every prop branch: the
 * default-off vs `active` class, native button-prop forwarding (onClick,
 * disabled, title), the `type` default + override, and the ChipBar role/class.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Chip, ChipBar } from './Chip';

afterEach(cleanup);

describe('<Chip>', () => {
  it('renders children with the base class and no is-on by default', () => {
    render(<Chip>hello</Chip>);
    const btn = screen.getByText('hello').closest('button')!;
    expect(btn).toBeTruthy();
    expect(btn.className).toContain('pclsb-chipbtn');
    expect(btn.className).not.toContain('is-on');
  });

  it('adds is-on when active', () => {
    render(<Chip active>on</Chip>);
    const btn = screen.getByText('on').closest('button')!;
    expect(btn.className).toContain('is-on');
  });

  it('defaults type to "button" so it never submits a form', () => {
    render(<Chip>x</Chip>);
    expect(screen.getByText('x').closest('button')!.getAttribute('type')).toBe('button');
  });

  it('honors an explicit type override', () => {
    render(<Chip type="submit">go</Chip>);
    expect(screen.getByText('go').closest('button')!.getAttribute('type')).toBe('submit');
  });

  it('forwards native button props (onClick, disabled, title, className)', () => {
    const onClick = vi.fn();
    render(
      <Chip onClick={onClick} disabled title="tip" className="extra">
        c
      </Chip>,
    );
    const btn = screen.getByText('c').closest('button')!;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toBe('tip');
    expect(btn.className).toContain('extra');
    // disabled buttons swallow clicks
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires onClick when enabled', () => {
    const onClick = vi.fn();
    render(<Chip onClick={onClick}>c</Chip>);
    fireEvent.click(screen.getByText('c'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('<ChipBar>', () => {
  it('renders a role=group container with the base class', () => {
    render(
      <ChipBar>
        <Chip>a</Chip>
      </ChipBar>,
    );
    const bar = screen.getByRole('group');
    expect(bar.className).toContain('pclsb-chipbar');
    expect(bar.querySelector('button')).toBeTruthy();
  });

  it('merges a custom className and style override', () => {
    render(<ChipBar className="my-bar" style={{ gap: 99 }} />);
    const bar = screen.getByRole('group');
    expect(bar.className).toContain('my-bar');
    expect(bar.style.gap).toBe('99px');
  });
});
