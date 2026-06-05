import { describe, expect, it } from 'vitest';
import { isStaticDesktopHost, isStaticPreviewHost, shouldEnableSupportWidget, shouldFallbackToSupportRoute, shouldSuppressStaticDesktopReload } from '../ui/desktop-static-host';

describe('static desktop host detection', () => {
  it('matches the static desktop hosts', () => {
    expect(isStaticDesktopHost('http://localhost:3070')).toBe(true);
    expect(isStaticDesktopHost('http://127.0.0.1:3070')).toBe(true);
    expect(isStaticDesktopHost('http://localhost:4173')).toBe(true);
    expect(isStaticDesktopHost('http://127.0.0.1:4173')).toBe(true);
  });

  it('does not match the live HMR/web host', () => {
    expect(isStaticDesktopHost('http://localhost:3055')).toBe(false);
  });

  it('isStaticPreviewHost matches ONLY the backend-less preview host (:4173, not :3070)', () => {
    expect(isStaticPreviewHost('http://localhost:4173')).toBe(true);
    expect(isStaticPreviewHost('http://127.0.0.1:4173')).toBe(true);
    expect(isStaticPreviewHost('http://localhost:4173/')).toBe(true);
    expect(isStaticPreviewHost('http://127.0.0.1:4173/')).toBe(true);
    // :3070 has a live backend — NOT a backend-less preview.
    expect(isStaticPreviewHost('http://localhost:3070')).toBe(false);
    expect(isStaticPreviewHost('http://127.0.0.1:3070')).toBe(false);
    expect(isStaticPreviewHost('http://localhost:3055')).toBe(false);
  });

  it('enables support widget only on non-static support routes', () => {
    expect(shouldEnableSupportWidget('/support', 'http://localhost:3055')).toBe(true);
    expect(shouldEnableSupportWidget('/support/faq', 'http://localhost:3055')).toBe(true);
    expect(shouldEnableSupportWidget('/support', 'http://localhost:3070')).toBe(false);
    expect(shouldEnableSupportWidget('/harness', 'http://localhost:3055')).toBe(false);
    expect(shouldEnableSupportWidget('/support', 'http://localhost:4173')).toBe(false);
    expect(shouldEnableSupportWidget('/support', 'http://127.0.0.1:4173')).toBe(false);
    expect(shouldEnableSupportWidget('/', 'http://localhost:3055')).toBe(false);
    expect(shouldEnableSupportWidget('/harness', 'http://localhost:3070')).toBe(false);
    expect(shouldEnableSupportWidget('/support', 'http://localhost:3070/')).toBe(false);
    expect(shouldEnableSupportWidget('/support', 'http://localhost:4173/')).toBe(false);
    expect(shouldEnableSupportWidget('/support', 'http://127.0.0.1:3070/')).toBe(false);
    expect(shouldEnableSupportWidget('/support', 'http://127.0.0.1:4173/')).toBe(false);
  });
  it('reuses the same host list for reload suppression', () => {
    expect(shouldSuppressStaticDesktopReload('http://localhost:3070')).toBe(true);
    expect(shouldSuppressStaticDesktopReload('http://localhost:4173')).toBe(true);
    expect(shouldSuppressStaticDesktopReload('http://localhost:3055')).toBe(false);
    expect(shouldSuppressStaticDesktopReload('http://localhost:3070/')).toBe(true);
    expect(shouldSuppressStaticDesktopReload('http://localhost:4173/')).toBe(true);
    expect(shouldSuppressStaticDesktopReload('http://127.0.0.1:3070/')).toBe(true);
    expect(shouldSuppressStaticDesktopReload('http://127.0.0.1:4173/')).toBe(true);
  });
  it('falls back to the support route only when the oracle dock is absent', () => {
    expect(shouldFallbackToSupportRoute(false)).toBe(true);
    expect(shouldFallbackToSupportRoute(true)).toBe(false);
  });
});
