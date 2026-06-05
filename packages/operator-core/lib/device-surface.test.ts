import { describe, expect, it } from 'vitest';

import { detectSurface, surfaceToElSource } from './device-surface';

describe('detectSurface — explicit query wins', () => {
  it('returns the query value when valid', () => {
    expect(detectSurface({ query: 'mobile-android', userAgent: 'whatever' })).toBe('mobile-android');
    expect(detectSurface({ query: 'mobile-ios', userAgent: 'Mozilla' })).toBe('mobile-ios');
    expect(detectSurface({ query: 'mobile-unknown' })).toBe('mobile-unknown');
  });
  it('falls through to UA when query is invalid', () => {
    expect(detectSurface({ query: 'garbage', userAgent: 'Android 13' })).toBe('mobile-android');
    expect(detectSurface({ query: 'Android', userAgent: 'iPhone' })).toBe('mobile-ios');
  });
});

describe('detectSurface — UA sniffing', () => {
  it('android UA → mobile-android', () => {
    expect(detectSurface({ userAgent: 'okhttp/4.10.0 Android-13' })).toBe('mobile-android');
    expect(detectSurface({ userAgent: 'PapercupApp/0.1 Android-Fold5' })).toBe('mobile-android');
  });
  it('iPhone UA → mobile-ios', () => {
    expect(detectSurface({ userAgent: 'iPhone Simulator/iOS-18.5' })).toBe('mobile-ios');
  });
  it('Darwin UA → mobile-ios (catches Swift URLSession default)', () => {
    expect(detectSurface({ userAgent: 'Papercup/1.0 (Darwin; iOS 18.5)' })).toBe('mobile-ios');
  });
  it('android wins when UA contains both substrings (unlikely but determinism)', () => {
    // 'Android' appears first in the cascade.
    expect(detectSurface({ userAgent: 'Android iPhone' })).toBe('mobile-android');
  });
  it('falls back to mobile-unknown when UA is empty/missing', () => {
    expect(detectSurface({})).toBe('mobile-unknown');
    expect(detectSurface({ userAgent: '' })).toBe('mobile-unknown');
  });
  it('falls back to mobile-unknown for non-mobile UA', () => {
    expect(detectSurface({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe('mobile-unknown');
  });
});

describe('surfaceToElSource', () => {
  it('maps each surface to the EL-accepted source value', () => {
    expect(surfaceToElSource('mobile-android')).toBe('android_sdk');
    expect(surfaceToElSource('mobile-ios')).toBe('swift_sdk');
    expect(surfaceToElSource('mobile-unknown')).toBe('unknown');
  });
});
