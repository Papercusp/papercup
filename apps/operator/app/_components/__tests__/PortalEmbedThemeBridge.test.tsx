// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const locationState = { pathname: '/adv', search: '?portalEmbed=1&portalTheme=light&portalOrigin=https%3A%2F%2Fportal.example' };
vi.mock('@/lib/router-compat/navigation', () => ({
  usePathname: () => locationState.pathname,
  useSearchParams: () => new URLSearchParams(locationState.search),
}));
vi.mock('@/lib/theme', () => ({ applyTheme: (id: string) => { document.documentElement.dataset.theme = id; } }));

import { PortalEmbedThemeBridge } from '../PortalEmbedThemeBridge';

beforeEach(() => {
  locationState.pathname = '/adv';
  locationState.search = '?portalEmbed=1&portalTheme=light&portalOrigin=https%3A%2F%2Fportal.example';
  document.documentElement.removeAttribute('data-theme');
  delete document.documentElement.dataset.portalEmbed;
  delete document.documentElement.dataset.portalEmbedTheme;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PortalEmbedThemeBridge', () => {
  it('applies the URL fallback and marks the document as portal-embedded', () => {
    render(<PortalEmbedThemeBridge />);
    expect(document.documentElement.dataset.portalEmbed).toBe('true');
    expect(document.documentElement.dataset.portalEmbedTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('portal-light');
  });

  it('accepts live theme messages only from the framing parent origin', () => {
    render(<PortalEmbedThemeBridge />);
    const accepted = new MessageEvent('message', {
      origin: 'https://portal.example',
      source: window,
      data: { type: 'papercusp:portal-embed', version: 1, theme: 'dark' },
    });
    // jsdom's window.parent is the same window; this still exercises the
    // source/origin guard and mirrors the browser event shape.
    act(() => window.dispatchEvent(accepted));
    expect(document.documentElement.dataset.theme).toBe('portal-dark');

    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://evil.example',
      source: window,
      data: { type: 'papercusp:portal-embed', version: 1, theme: 'light' },
    })));
    expect(document.documentElement.dataset.theme).toBe('portal-dark');
  });

  it('clears embed attributes when the route leaves /adv', () => {
    const { rerender } = render(<PortalEmbedThemeBridge />);
    locationState.pathname = '/settings/operator';
    locationState.search = '';
    rerender(<PortalEmbedThemeBridge />);
    expect(document.documentElement.dataset.portalEmbed).toBeUndefined();
    expect(document.documentElement.dataset.portalEmbedTheme).toBeUndefined();
  });
});
