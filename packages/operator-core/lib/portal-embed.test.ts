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
  it('recognises focused Plans/Inbox operator documents with an explicit embed flag', () => {
    expect(isPortalEmbedLocation('/adv', '?portalEmbed=1')).toBe(true);
    expect(isPortalEmbedLocation('/adv/', '?portalEmbed=true')).toBe(true);
    expect(isPortalEmbedLocation('/adv?tab=workflows&portalEmbed=yes')).toBe(true);
    expect(isPortalEmbedLocation('/adv', '')).toBe(false);
    expect(isPortalEmbedLocation('/settings', '?portalEmbed=1')).toBe(false);
    expect(isPortalEmbedLocation('/tasks-roster', '?portalEmbed=1')).toBe(true);
    expect(isPortalEmbedLocation('/plans', '?portalEmbed=1')).toBe(true);
    expect(isPortalEmbedLocation('/inbox', '?portalEmbed=true')).toBe(true);
    expect(isPortalEmbedLocation('/plans', '')).toBe(false);
    // The pane-only documents the portal frames as its OWN sidebars (owner ask
    // 2026-09-01) follow the same contract, so the theme bridge tracks them.
    expect(isPortalEmbedLocation('/portal-panes/steering', '?portalEmbed=1')).toBe(true);
    expect(isPortalEmbedLocation('/portal-panes/chat', '?portalEmbed=1&portalTheme=dark')).toBe(true);
    expect(isPortalEmbedLocation('/portal-panes/chat', '')).toBe(false);
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
    expect(portalEmbedHref('/plans', 'light', 'http://127.0.0.1:3081'))
      .toBe('/plans?portalEmbed=1&portalTheme=light&portalOrigin=http%3A%2F%2F127.0.0.1%3A3081');
    expect(portalEmbedThemeFromSearch('?portalTheme=light')).toBe('light');
    expect(portalEmbedThemeFromSearch('?portalTheme=unknown')).toBe('system');
  });

  it('forwards extra deep-link params into the framed document (portal-work-two-pane-2026-09-01 D-001)', () => {
    expect(portalEmbedHref('/plans', 'dark', 'http://127.0.0.1:3081', { pdash: 'papercusp::my-plan' }))
      .toBe('/plans?portalEmbed=1&portalTheme=dark&portalOrigin=http%3A%2F%2F127.0.0.1%3A3081&pdash=papercusp%3A%3Amy-plan');
    // Empty / null values are skipped; a deep link overrides a stale value
    // already in the href (the key keeps its position, URLSearchParams.set).
    expect(portalEmbedHref('/inbox?opcis=old', 'light', null, { opcis: 'coord-escalation:m9', pdash: null, x: '' }))
      .toBe('/inbox?opcis=coord-escalation%3Am9&portalEmbed=1&portalTheme=light');
    // No extra ⇒ byte-identical to the three-argument form.
    expect(portalEmbedHref('/plans', 'light', null, {})).toBe(portalEmbedHref('/plans', 'light', null));
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
