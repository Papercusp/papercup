// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  FeatureFilterChips,
  FEATURE_FILTERS,
  type FeatureFilter,
} from '../FeatureFilterChips';

afterEach(() => cleanup());

describe('FeatureFilterChips', () => {
  it('renders all 4 filter chips by default', () => {
    render(<FeatureFilterChips value={null} onChange={() => {}} />);
    for (const f of FEATURE_FILTERS) {
      expect(screen.getByTestId(`feature-filter-${f}`)).toBeTruthy();
    }
  });

  it('marks the selected chip as active via aria-checked + data-active', () => {
    render(<FeatureFilterChips value="working" onChange={() => {}} />);
    const working = screen.getByTestId('feature-filter-working');
    expect(working.getAttribute('aria-checked')).toBe('true');
    expect(working.getAttribute('data-active')).toBe('1');
    const mine = screen.getByTestId('feature-filter-mine');
    expect(mine.getAttribute('aria-checked')).toBe('false');
    expect(mine.getAttribute('data-active')).toBe('0');
  });

  it('clicks an inactive chip → onChange fires with that filter', () => {
    const onChange = vi.fn();
    render(<FeatureFilterChips value={null} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('feature-filter-available'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('available');
  });

  it('clicks the active chip → onChange fires with null (toggle off)', () => {
    const onChange = vi.fn();
    render(<FeatureFilterChips value="mine" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('feature-filter-mine'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders a counts pill when counts are provided', () => {
    render(
      <FeatureFilterChips
        value={null}
        onChange={() => {}}
        counts={{ mine: 3, available: 12 }}
      />,
    );
    expect(screen.getByTestId('feature-filter-mine-count').textContent).toBe('3');
    expect(screen.getByTestId('feature-filter-available-count').textContent).toBe('12');
  });

  it('omits the pill when the count is missing', () => {
    render(
      <FeatureFilterChips
        value={null}
        onChange={() => {}}
        counts={{ mine: 5 }}
      />,
    );
    expect(screen.queryByTestId('feature-filter-mine-count')).toBeTruthy();
    expect(screen.queryByTestId('feature-filter-working-count')).toBeFalsy();
  });

  it('renders a count of 0 with reduced opacity', () => {
    render(
      <FeatureFilterChips
        value={null}
        onChange={() => {}}
        counts={{ working: 0 }}
      />,
    );
    const pill = screen.getByTestId('feature-filter-working-count');
    expect(pill.textContent).toBe('0');
    expect(pill.getAttribute('style') ?? '').toContain('opacity: 0.5');
  });

  it('hides chips passed in the `hide` prop', () => {
    render(
      <FeatureFilterChips
        value={null}
        onChange={() => {}}
        hide={['shipped', 'available']}
      />,
    );
    expect(screen.queryByTestId('feature-filter-mine')).toBeTruthy();
    expect(screen.queryByTestId('feature-filter-working')).toBeTruthy();
    expect(screen.queryByTestId('feature-filter-available')).toBeFalsy();
    expect(screen.queryByTestId('feature-filter-shipped')).toBeFalsy();
  });

  it('shows a "Clear" button only when a filter is active', () => {
    const { rerender } = render(<FeatureFilterChips value={null} onChange={() => {}} />);
    expect(screen.queryByTestId('feature-filter-clear')).toBeFalsy();
    rerender(<FeatureFilterChips value="mine" onChange={() => {}} />);
    expect(screen.queryByTestId('feature-filter-clear')).toBeTruthy();
  });

  it('Clear button fires onChange(null)', () => {
    const onChange = vi.fn();
    render(<FeatureFilterChips value="mine" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('feature-filter-clear'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('group has role="radiogroup" for a11y', () => {
    render(<FeatureFilterChips value={null} onChange={() => {}} />);
    expect(screen.getByTestId('feature-filter-chips').getAttribute('role')).toBe('radiogroup');
  });

  it('each chip has role="radio"', () => {
    render(<FeatureFilterChips value={null} onChange={() => {}} />);
    for (const f of FEATURE_FILTERS as readonly FeatureFilter[]) {
      expect(
        screen.getByTestId(`feature-filter-${f}`).getAttribute('role'),
      ).toBe('radio');
    }
  });

  it('renders a tooltip describing each filter', () => {
    render(<FeatureFilterChips value={null} onChange={() => {}} />);
    expect(screen.getByTestId('feature-filter-mine').title).toMatch(/your queue/i);
    expect(screen.getByTestId('feature-filter-working').title).toMatch(/working/i);
  });
});
