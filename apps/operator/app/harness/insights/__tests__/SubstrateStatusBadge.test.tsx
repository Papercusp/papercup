/**
 * @vitest-environment jsdom
 *
 * SubstrateStatusBadge tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SubstrateStatusBadge } from '../SubstrateStatusBadge';

afterEach(() => {
  cleanup();
});

describe('SubstrateStatusBadge', () => {
  it('disabled mode shows "Substrate off"', () => {
    render(<SubstrateStatusBadge status="disabled" />);
    const el = screen.getByTestId('substrate-status-badge');
    expect(el.getAttribute('data-status')).toBe('disabled');
    expect(el.textContent).toContain('Substrate off');
  });

  it('booting mode shows "Booting…"', () => {
    render(<SubstrateStatusBadge status="booting" />);
    const el = screen.getByTestId('substrate-status-badge');
    expect(el.getAttribute('data-status')).toBe('booting');
    expect(el.textContent).toContain('Booting');
  });

  it('booted mode shows "Substrate live"', () => {
    render(<SubstrateStatusBadge status="booted" />);
    const el = screen.getByTestId('substrate-status-badge');
    expect(el.getAttribute('data-status')).toBe('booted');
    expect(el.textContent).toContain('Substrate live');
  });

  it('renders hint when provided', () => {
    render(
      <SubstrateStatusBadge status="booted" hint="3 harnesses" />,
    );
    expect(screen.getByTestId('substrate-status-hint').textContent).toBe(
      '3 harnesses',
    );
  });

  it('omits hint when not provided', () => {
    render(<SubstrateStatusBadge status="disabled" />);
    expect(screen.queryByTestId('substrate-status-hint')).toBeNull();
  });

  it('tooltip merges label + hint', () => {
    render(
      <SubstrateStatusBadge status="booted" hint="3 harnesses" />,
    );
    expect(
      screen.getByTestId('substrate-status-badge').getAttribute('title'),
    ).toBe('Substrate live (3 harnesses)');
  });

  it('tooltip is just the label when no hint', () => {
    render(<SubstrateStatusBadge status="booting" />);
    expect(
      screen.getByTestId('substrate-status-badge').getAttribute('title'),
    ).toBe('Booting…');
  });
});
