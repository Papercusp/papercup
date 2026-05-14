/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  NavChevrons,
  registerNavForPanel,
  getNavForPanel,
  _resetNavRegistryForTests,
} from './NavChevrons';
import type { NavHistory } from './useNavHistory';

function makeNav(overrides: Partial<NavHistory<{ x: number }>> = {}): NavHistory<{ x: number }> {
  return {
    current: { x: 1 },
    canBack: false,
    canForward: false,
    back: vi.fn(),
    forward: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => _resetNavRegistryForTests());
afterEach(() => cleanup());

describe('NavChevrons', () => {
  it('renders nothing when neither direction is available', () => {
    const { container } = render(<NavChevrons nav={makeNav()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders both buttons when canBack OR canForward', () => {
    render(<NavChevrons nav={makeNav({ canBack: true })} />);
    expect(screen.getByLabelText('Back')).toBeTruthy();
    expect(screen.getByLabelText('Forward')).toBeTruthy();
  });

  it('back button calls nav.back() when enabled', () => {
    const back = vi.fn();
    render(<NavChevrons nav={makeNav({ canBack: true, back })} />);
    fireEvent.click(screen.getByLabelText('Back'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('forward button is disabled when canForward=false', () => {
    render(<NavChevrons nav={makeNav({ canBack: true, canForward: false })} />);
    const fwd = screen.getByLabelText('Forward') as HTMLButtonElement;
    expect(fwd.disabled).toBe(true);
  });

  it('forward calls nav.forward() when canForward', () => {
    const forward = vi.fn();
    render(<NavChevrons nav={makeNav({ canForward: true, forward })} />);
    fireEvent.click(screen.getByLabelText('Forward'));
    expect(forward).toHaveBeenCalledTimes(1);
  });
});

describe('nav-for-panel registry', () => {
  it('register + get round-trip', () => {
    const nav = makeNav({ canBack: true });
    const unregister = registerNavForPanel('p1', nav);
    expect(getNavForPanel('p1')).toBe(nav);
    unregister();
    expect(getNavForPanel('p1')).toBeUndefined();
  });

  it('returns undefined for unknown panel id', () => {
    expect(getNavForPanel('nope')).toBeUndefined();
  });
});
