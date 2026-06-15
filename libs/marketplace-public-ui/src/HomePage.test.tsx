// @vitest-environment jsdom
/**
 * HomePage.test.tsx — whole-app-coverage P-008.
 *
 * The public landing page is pure/presentational (props only). Verifies the
 * hero, the value pillars, and that the two CTAs default sensibly and honour
 * the desktopReleaseUrl / marketplaceHref props.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HomePage } from './HomePage';

afterEach(cleanup);

describe('HomePage', () => {
  it('renders the hero tagline and the three value pillars', () => {
    render(<HomePage />);
    expect(screen.getByText(/Run AI workflows on your own machine/i)).toBeTruthy();
    expect(screen.getByText('Runs on your machine')).toBeTruthy();
    expect(screen.getByText('Starts from a template')).toBeTruthy();
    expect(screen.getByText('Shows its work')).toBeTruthy();
  });

  it('defaults the download CTA to "#" and the marketplace link to /marketplace', () => {
    render(<HomePage />);
    expect(
      screen.getByRole('link', { name: /download desktop app/i }).getAttribute('href'),
    ).toBe('#');
    expect(
      screen.getByRole('link', { name: /browse marketplace/i }).getAttribute('href'),
    ).toBe('/marketplace');
  });

  it('uses the provided desktopReleaseUrl and marketplaceHref', () => {
    render(<HomePage desktopReleaseUrl="https://dl.example/app.dmg" marketplaceHref="/m" />);
    expect(
      screen.getByRole('link', { name: /download desktop app/i }).getAttribute('href'),
    ).toBe('https://dl.example/app.dmg');
    expect(
      screen.getByRole('link', { name: /browse marketplace/i }).getAttribute('href'),
    ).toBe('/m');
  });
});
