// @vitest-environment jsdom
/**
 * Tests for the harness <Checkbox> primitive (Radix-backed). Covers the
 * controlled checked state, the boolean coercion of onChange (Radix's
 * tri-state onCheckedChange → onChange(v === true)), the indeterminate
 * 'mixed' state native checkboxes can't express, disabled, and ariaLabel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Checkbox } from './Checkbox';

afterEach(() => cleanup());

describe('Checkbox', () => {
  it('reflects the checked prop via aria-checked', () => {
    const { rerender } = render(<Checkbox checked onChange={() => {}} ariaLabel="Accept" />);
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    rerender(<Checkbox checked={false} onChange={() => {}} ariaLabel="Accept" />);
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
  });

  it('toggles to false when a checked box is clicked', () => {
    const onChange = vi.fn();
    render(<Checkbox checked onChange={onChange} ariaLabel="x" />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('toggles to true when an unchecked box is clicked', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} ariaLabel="x" />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('renders the indeterminate state as aria-checked="mixed"', () => {
    render(<Checkbox checked={false} indeterminate onChange={() => {}} ariaLabel="x" />);
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('mixed');
  });

  it('does not fire onChange when disabled', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} disabled onChange={onChange} ariaLabel="x" />);
    const box = screen.getByRole('checkbox') as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('exposes ariaLabel as the accessible name', () => {
    render(<Checkbox checked onChange={() => {}} ariaLabel="Enable telemetry" />);
    expect(screen.getByRole('checkbox', { name: 'Enable telemetry' })).toBeTruthy();
  });

  it('forwards dataTestId onto the toggle element itself — clicking getByTestId toggles (EI-9468)', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} ariaLabel="x" dataTestId="pick-me" />);
    const box = screen.getByTestId('pick-me');
    expect(box).toBe(screen.getByRole('checkbox'));
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
