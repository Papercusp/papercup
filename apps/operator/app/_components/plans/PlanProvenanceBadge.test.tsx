import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PlanProvenanceBadge from './PlanProvenanceBadge';

describe('PlanProvenanceBadge', () => {
  it('renders the Blender class with the literal appliance glyph and text', () => {
    render(<PlanProvenanceBadge origin="scout" testId="source" />);
    const badge = screen.getByTestId('source');
    expect(badge.textContent).toBe('Blender');
    expect(badge.getAttribute('data-plan-provenance')).toBe('blender');
    expect(badge.getAttribute('aria-label')).toBe('Plan source: Blender');
    expect(badge.querySelectorAll('path')).toHaveLength(4);
  });

  it.each([undefined, null] as const)('labels an unattested plan only as Outside Blender (%s)', (origin) => {
    render(<PlanProvenanceBadge origin={origin} testId="source" />);
    const badge = screen.getByTestId('source');
    expect(badge.textContent).toBe('Outside Blender');
    expect(badge.getAttribute('data-plan-provenance')).toBe('outside-blender');
    expect(badge.textContent).not.toMatch(/user|agent/i);
  });
});
