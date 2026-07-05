/**
 * isDevBuildWatcherShell — the pure decision behind the error-card / reload-toast
 * copy. In a real packaged build (MODE==='production', no dev-wrapper flag) it
 * must be FALSE so we never tell the owner "the dev build watcher rewrote the
 * bundle" / "a newer build is available" — there is no watcher (WI-2902).
 *
 * Run with: npx vitest run apps/operator-vite/src/lib/dev-build-shell.test.ts
 */
import { describe, expect, it } from 'vitest';
import { isDevBuildWatcherShell } from './dev-build-shell';

describe('isDevBuildWatcherShell', () => {
  it('is FALSE for a real packaged build (production mode, no dev-wrapper flag)', () => {
    expect(isDevBuildWatcherShell('production', undefined)).toBe(false);
    expect(isDevBuildWatcherShell('production', false)).toBe(false);
  });

  it('is TRUE in a dev shell (non-production MODE — HMR or nohmr `vite build`)', () => {
    // NB: nohmr is a `vite build`, so this is gated on MODE, not import.meta.env.DEV.
    expect(isDevBuildWatcherShell('development', undefined)).toBe(true);
    expect(isDevBuildWatcherShell('test', undefined)).toBe(true);
  });

  it('is TRUE when the dev-wrapper flag is injected even over a production build', () => {
    // The build-switcher wrapper can show a production bundle but still has a
    // watcher behind it, so the wrapper flag forces the dev copy.
    expect(isDevBuildWatcherShell('production', true)).toBe(true);
  });

  it('treats only the literal `true` flag as the dev-wrapper (not truthy junk)', () => {
    expect(isDevBuildWatcherShell('production', 1)).toBe(false);
    expect(isDevBuildWatcherShell('production', 'true')).toBe(false);
  });
});
