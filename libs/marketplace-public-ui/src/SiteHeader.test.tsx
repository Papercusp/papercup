// @vitest-environment jsdom
/**
 * SiteHeader.test.tsx — whole-app-coverage P-008.
 *
 * Covers the nav defaults, external-link hardening (target=_blank +
 * rel=noopener), and the three CTA states: default Mission Control,
 * suppressed (cta=null), and a custom CTA. Plus custom nav/quote/extras.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SiteHeader } from './SiteHeader';

afterEach(cleanup);

describe('SiteHeader', () => {
  it('renders the default nav with GitHub hardened as an external link', () => {
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: 'Marketplace' }).getAttribute('href')).toBe('/marketplace/');
    expect(screen.getByRole('link', { name: 'Docs' })).toBeTruthy();
    const gh = screen.getByRole('link', { name: 'GitHub' });
    expect(gh.getAttribute('target')).toBe('_blank');
    expect(gh.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows the default Mission Control CTA when cta is undefined', () => {
    render(<SiteHeader />);
    expect(
      screen.getByRole('link', { name: 'Mission Control' }).getAttribute('href'),
    ).toBe('http://localhost:3055/harness');
  });

  it('suppresses the CTA when cta is null', () => {
    render(<SiteHeader cta={null} />);
    expect(screen.queryByRole('link', { name: 'Mission Control' })).toBeNull();
  });

  it('renders a custom cta, quote, nav, and extras', () => {
    render(
      <SiteHeader
        cta={{ href: '/go', label: 'Launch' }}
        quote="a custom quote"
        extras={<span>extra-node</span>}
        navLinks={[{ href: '/x', label: 'OnlyLink' }]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Launch' }).getAttribute('href')).toBe('/go');
    expect(screen.getByText('a custom quote')).toBeTruthy();
    expect(screen.getByText('extra-node')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'OnlyLink' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Docs' })).toBeNull();
  });
});
