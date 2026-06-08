/**
 * @vitest-environment jsdom
 *
 * RTL render tests for SubmitButton — pending/disabled state + variant styling.
 * Run with: cd apps/operator && npx vitest run lib/forms/SubmitButton.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SubmitButton } from './SubmitButton';

afterEach(cleanup);

const btn = (): HTMLButtonElement => screen.getByRole('button') as HTMLButtonElement;

describe('SubmitButton', () => {
  it('renders children, type=submit, enabled when not pending', () => {
    render(<SubmitButton pending={false}>Save</SubmitButton>);
    expect(btn().textContent).toBe('Save');
    expect(btn().disabled).toBe(false);
    expect(btn().getAttribute('type')).toBe('submit');
  });

  it('disables and shows the pending label while pending', () => {
    render(<SubmitButton pending pendingLabel="Working…">Save</SubmitButton>);
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toBe('Working…');
  });

  it('defaults the pending label to "Saving…"', () => {
    render(<SubmitButton pending>Save</SubmitButton>);
    expect(btn().textContent).toBe('Saving…');
  });

  it('applies pc-btn-primary for the primary variant only', () => {
    const { rerender } = render(<SubmitButton pending={false} variant="primary">X</SubmitButton>);
    expect(btn().className).toContain('pc-btn-primary');
    rerender(<SubmitButton pending={false} variant="ghost">X</SubmitButton>);
    expect(btn().className).not.toContain('pc-btn-primary');
  });

  it('treats aria-disabled="true" as disabled even when not pending', () => {
    render(<SubmitButton pending={false} aria-disabled="true">X</SubmitButton>);
    expect(btn().disabled).toBe(true);
  });

  it('forwards extra props (e.g. onClick)', () => {
    const onClick = vi.fn();
    render(<SubmitButton pending={false} onClick={onClick}>X</SubmitButton>);
    btn().click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
