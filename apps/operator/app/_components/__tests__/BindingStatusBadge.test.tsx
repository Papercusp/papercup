/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BindingStatusBadge } from '../BindingStatusBadge';

afterEach(() => cleanup());

describe('BindingStatusBadge', () => {
  it('renders verified with ✓', () => {
    render(<BindingStatusBadge status="verified" />);
    const b = screen.getByTestId('binding-status-badge-verified');
    expect(b.textContent).toContain('✓');
    expect(b.textContent).toContain('verified');
  });

  it('renders pending with ⏳', () => {
    render(<BindingStatusBadge status="pending" />);
    const b = screen.getByTestId('binding-status-badge-pending');
    expect(b.textContent).toContain('⏳');
    expect(b.textContent).toContain('pending');
  });

  it('renders pending with age text inline', () => {
    render(<BindingStatusBadge status="pending" pendingAgeText="3h ago" />);
    const b = screen.getByTestId('binding-status-badge-pending');
    expect(b.textContent).toContain('3h ago');
  });

  it('renders unverified with ⚠', () => {
    render(<BindingStatusBadge status="unverified" />);
    const b = screen.getByTestId('binding-status-badge-unverified');
    expect(b.textContent).toContain('⚠');
    expect(b.textContent).toContain('unverified');
  });

  it('unverified tooltip includes failure reason when provided', () => {
    render(<BindingStatusBadge status="unverified" unverifiedReason="channel 2 file missing" />);
    const b = screen.getByTestId('binding-status-badge-unverified');
    expect(b.getAttribute('title')).toContain('channel 2 file missing');
  });

  it('each status has distinct tooltip', () => {
    const { container } = render(
      <>
        <BindingStatusBadge status="verified" />
        <BindingStatusBadge status="pending" />
        <BindingStatusBadge status="unverified" />
      </>,
    );
    const titles = Array.from(container.querySelectorAll('[data-binding-status]'))
      .map((el) => el.getAttribute('title'));
    expect(new Set(titles).size).toBe(3);
  });
});
