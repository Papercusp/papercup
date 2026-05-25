/**
 * @vitest-environment jsdom
 *
 * SubstrateHealthPill tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SubstrateHealthPill } from '../SubstrateHealthPill';

afterEach(() => {
  cleanup();
});

describe('SubstrateHealthPill', () => {
  const verdicts = [
    'disabled',
    'booting',
    'healthy',
    'degraded',
    'unhealthy',
  ] as const;

  for (const v of verdicts) {
    it(`renders ${v} pill with right label`, () => {
      render(<SubstrateHealthPill verdict={v} />);
      const el = screen.getByTestId('substrate-health-pill');
      expect(el.getAttribute('data-verdict')).toBe(v);
      const expected = v.charAt(0).toUpperCase() + v.slice(1);
      expect(el.textContent).toBe(expected);
    });
  }

  it('uses reasons as tooltip when provided', () => {
    render(
      <SubstrateHealthPill
        verdict="unhealthy"
        reasons={['claim error rate 30% ≥ 25%', 'bootstrap stalled']}
      />,
    );
    expect(
      screen.getByTestId('substrate-health-pill').getAttribute('title'),
    ).toContain('claim error rate 30%');
  });

  it('falls back to label tooltip when no reasons', () => {
    render(<SubstrateHealthPill verdict="healthy" />);
    expect(
      screen.getByTestId('substrate-health-pill').getAttribute('title'),
    ).toBe('Healthy');
  });

  it('empty reasons array also falls back', () => {
    render(<SubstrateHealthPill verdict="booting" reasons={[]} />);
    expect(
      screen.getByTestId('substrate-health-pill').getAttribute('title'),
    ).toBe('Booting');
  });
});
