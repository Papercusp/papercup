// @vitest-environment jsdom
/**
 * Tests for <StepPlaceholder> — the "not implemented yet" fallback for wizard
 * steps without a real panel. Renders the step id and tags it required vs
 * optional based on findStep(id) (unknown id → optional).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StepPlaceholder } from './StepPlaceholder';

afterEach(() => cleanup());

describe('StepPlaceholder', () => {
  it('renders the step id and the not-implemented copy', () => {
    render(<StepPlaceholder id="embedded-pg" />);
    expect(screen.getByText('This step is not implemented yet.')).toBeTruthy();
    expect(screen.getByText('embedded-pg')).toBeTruthy();
  });

  it('marks a required step as (required)', () => {
    const { container } = render(<StepPlaceholder id="embedded-pg" />);
    expect(container.textContent).toContain('(required)');
  });

  it('marks an optional step as (optional)', () => {
    const { container } = render(<StepPlaceholder id="os-permissions" />);
    expect(container.textContent).toContain('(optional)');
  });

  it('treats an unknown step id as optional', () => {
    const { container } = render(<StepPlaceholder id="does-not-exist" />);
    expect(container.textContent).toContain('(optional)');
    expect(screen.getByText('does-not-exist')).toBeTruthy();
  });
});
