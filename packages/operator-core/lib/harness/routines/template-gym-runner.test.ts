import { describe, expect, it } from 'vitest';
import {
  capabilitySetsDiffer,
  diffManifestSet,
  MOBILE_TEMPLATE_IDS,
  validateMobileCheckUnion,
} from './template-gym-runner';

describe('mobile template-gym policy', () => {
  it('pins the official five-template closure', () => {
    expect(MOBILE_TEMPLATE_IDS).toEqual([
      'papercusp-mobile-base',
      'papercusp-android-shell',
      'papercusp-android-app',
      'papercusp-iphone-shell',
      'papercusp-iphone-app',
    ]);
  });

  it('requires the complete Android and iPhone check unions', () => {
    expect(validateMobileCheckUnion('android')).toEqual([]);
    expect(validateMobileCheckUnion('iphone')).toEqual([]);
  });

  it('detects missing, changed, and extra consumer manifest copies', () => {
    const canonical = new Map([
      ['base', 'base-v1'],
      ['shell', 'shell-v1'],
      ['app', 'app-v1'],
    ]);
    const consumer = new Map([
      ['base', 'base-v1'],
      ['shell', 'shell-edited'],
      ['extra', 'unexpected'],
    ]);
    expect(diffManifestSet(canonical, consumer)).toEqual({
      missing: ['app'],
      changed: ['shell'],
      extra: ['extra'],
    });
  });

  it('treats optional-capability diversity as set diversity, not ordering', () => {
    expect(capabilitySetsDiffer(['push', 'camera'], ['camera', 'push'])).toBe(false);
    expect(capabilitySetsDiffer(['push', 'camera'], ['media-playback'])).toBe(true);
  });
});
