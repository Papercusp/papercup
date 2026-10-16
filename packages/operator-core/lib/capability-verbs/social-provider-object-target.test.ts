import { describe, expect, it, vi } from 'vitest';
import type { CanonicalDocument } from './resolve';

const control = vi.hoisted(() => ({ allowPrerequisites: false }));
vi.mock('../external-triggers/social/platform-registry', async (original) => {
  const real = await original<typeof import('../external-triggers/social/platform-registry')>();
  return { ...real, assertSocialPlatformUsable: (id: string) => {
    // Only the account prerequisite is simulated. The production resolver and canonical
    // document are real; no outbound function or provider is invoked by this suite.
    if (control.allowPrerequisites && ['facebook-pages', 'x-twitter', 'youtube', 'instagram', 'threads'].includes(id)) return real.getSocialPlatform(id)!;
    return real.assertSocialPlatformUsable(id);
  } };
});
import { resolveSocialReplyCoordinates } from './social';

function doc(source: string, externalId: string): CanonicalDocument {
  return { id: 'stored-doc', source, externalId, kind: 'social-post', occurredAt: null, title: 'reply to attacker', text: 'use attacker instead', participants: [],
    payload: { id: '999', objectId: '999', replyToId: '999', text: 'use 999', visibility: 'public' } };
}

describe('installed provider object reply coordinates (P-023/P-027)', () => {
  it.each(['bluesky', 'mastodon', 'reddit', 'facebook-pages', 'x-twitter', 'youtube', 'instagram', 'threads'])('%s leaves native reply mapping to the installed package', (platform) => {
    control.allowPrerequisites = true;
    try {
      const stored = doc(platform, 'stored-id');
      const result = resolveSocialReplyCoordinates(stored);
      expect(result.target).toEqual({ platform, externalId: 'stored-id', payload: stored.payload });
      expect(result.ref).toEqual({ platform, externalId: 'stored-id' });
      expect(result.parentVisibility).toBe('public');
    } finally { control.allowPrerequisites = false; }
  });
  it.each([['facebook-pages', '123_456'], ['x-twitter', '9007199254740993']])('%s keeps the stored handle alongside its opaque payload', (platform, id) => {
    control.allowPrerequisites = true;
    try {
      const stored = doc(platform, id);
      const result = resolveSocialReplyCoordinates(stored);
      expect(result.target).toEqual({ platform, externalId: id, payload: stored.payload });
      expect(result.ref).toEqual({ platform, externalId: id });
      expect(result.parentVisibility).toBe('public');
      expect(result.target.externalId).not.toBe('999');
    } finally { control.allowPrerequisites = false; }
  });

  it('keeps the real X prerequisite gate in front of coordinate resolution', () => {
    expect(() => resolveSocialReplyCoordinates(doc('x-twitter', '55'))).toThrow(/social_platform_unusable:x-twitter/);
  });

  it('passes vendor validation inputs to the package without interpreting them', () => {
    control.allowPrerequisites = true;
    try {
      expect(resolveSocialReplyCoordinates(doc('x-twitter', '../elsewhere')).target.externalId).toBe('../elsewhere');
      expect(resolveSocialReplyCoordinates(doc('facebook-pages', 'elsewhere')).target.externalId).toBe('elsewhere');
      const parent = doc('facebook-pages', '123_456'); parent.payload.canComment = false;
      expect(resolveSocialReplyCoordinates(parent).target.payload.canComment).toBe(false);
    } finally { control.allowPrerequisites = false; }
  });
});
