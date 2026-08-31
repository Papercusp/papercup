import { describe, expect, it } from 'vitest';
import { isChromelessPath, isPortalEmbedLocation } from './chromeless-routes';

describe('route presentation predicates', () => {
  it('keeps ordinary iframe routes chromeless', () => {
    expect(isChromelessPath('/pi')).toBe(true);
    expect(isChromelessPath('/project-docs/reference')).toBe(true);
    expect(isChromelessPath('/adv')).toBe(false);
  });

  it('recognises the portal embed query only on operator /adv routes', () => {
    expect(isPortalEmbedLocation('/adv', '?portalEmbed=1')).toBe(true);
    expect(isPortalEmbedLocation('/adv?tab=workflows', '?portalEmbed=true')).toBe(true);
    expect(isPortalEmbedLocation('/adv', '?portalEmbed=0')).toBe(false);
    expect(isPortalEmbedLocation('/settings', '?portalEmbed=1')).toBe(false);
  });
});
