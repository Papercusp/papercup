import { describe, expect, it } from 'vitest';
import {
  isPortalEmbedLocation,
  isTrustedPortalEmbedMessage,
  operatorThemeForPortalTheme,
  portalEmbedHref,
  portalEmbedThemeFromSearch,
  portalEmbedThemeMessage,
  safeOrigin,
} from './portal-embed';

describe('portalEmbed protocol', () => {
  it('recognises only /adv operator documents with an explicit embed flag', () => {
    expect(isPortalEmbedLocation('/adv', '?portalEmbed=1')).toBe(true);
    expect(isPortalEmbedLocation('/adv/', '?portalEmbed=true')).toBe(true);
    expect(isPortalEmbedLocation('/adv', '')).toBe(false);
    expect(isPortalEmbedLocation('/settings', '?portalEmbed=1')).toBe(false);
  });

  it('maps portal themes to the operator semantic themes', () => {
    expect(operatorThemeForPortalTheme('light')).toBe('portal-light');
    expect(operatorThemeForPortalTheme('dark')).toBe('portal-dark');
    expect(operatorThemeForPortalTheme('system', false)).toBe('portal-light');
    expect(operatorThemeForPortalTheme('system', true)).toBe('portal-dark');
  });

  it('preserves an existing tab query while adding the fallback contract', () => {
    expect(portalEmbedHref('/adv?tab=workflows', 'dark', 'http://127.0.0.1:3081'))
      .toBe('/adv?tab=workflows&portalEmbed=1&portalTheme=dark&portalOrigin=http%3A%2F%2F127.0.0.1%3A3081');
    expect(portalEmbedThemeFromSearch('?portalTheme=light')).toBe('light');
    expect(portalEmbedThemeFromSearch('?portalTheme=unknown')).toBe('system');
  });

  it('accepts only versioned messages from the known parent origin', () => {
    const message = portalEmbedThemeMessage('dark');
    expect(isTrustedPortalEmbedMessage(message, 'http://127.0.0.1:3081', 'http://127.0.0.1:3081')).toBe(true);
    expect(isTrustedPortalEmbedMessage(message, 'https://evil.example', 'http://127.0.0.1:3081')).toBe(false);
    expect(isTrustedPortalEmbedMessage({ ...message, version: 2 }, 'http://127.0.0.1:3081', 'http://127.0.0.1:3081')).toBe(false);
    expect(safeOrigin('http://127.0.0.1:3081/portal')).toBe('http://127.0.0.1:3081');
    expect(safeOrigin('not a url')).toBeNull();
  });
});
