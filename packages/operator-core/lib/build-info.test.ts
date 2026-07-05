/**
 * build-info (WI-265) — the running checkout's sha + version for deploy-skew
 * diagnosability on /api/health. Tests the pure resolver via injected seams.
 */
import { describe, it, expect } from 'vitest';
import { resolveBuildInfo } from './build-info';

describe('resolveBuildInfo', () => {
  it('prefers PAPERCUSP_BUILD_SHA and never shells out when it is set', () => {
    let gitCalled = false;
    const r = resolveBuildInfo({
      env: { PAPERCUSP_BUILD_SHA: 'abc1234', npm_package_version: '1.2.3' } as NodeJS.ProcessEnv,
      gitSha: () => { gitCalled = true; return 'should-not-be-used'; },
    });
    expect(r).toEqual({ sha: 'abc1234', version: '1.2.3' });
    expect(gitCalled).toBe(false);
  });

  it('falls back to git rev-parse when no env sha', () => {
    const r = resolveBuildInfo({ env: { npm_package_version: '1.2.3' } as NodeJS.ProcessEnv, gitSha: () => 'deadbee' });
    expect(r).toEqual({ sha: 'deadbee', version: '1.2.3' });
  });

  it('null sha (best-effort) when git resolution throws — never breaks /api/health', () => {
    const r = resolveBuildInfo({ env: {} as NodeJS.ProcessEnv, gitSha: () => { throw new Error('not a git repo'); } });
    expect(r.sha).toBeNull();
    expect(r.version).toBe('0.0.0'); // default when npm_package_version unset
  });

  it('null sha when git returns empty', () => {
    expect(resolveBuildInfo({ env: {} as NodeJS.ProcessEnv, gitSha: () => '' }).sha).toBeNull();
  });

  it('trims a whitespace env sha', () => {
    expect(resolveBuildInfo({ env: { PAPERCUSP_BUILD_SHA: '  feed123  ' } as NodeJS.ProcessEnv }).sha).toBe('feed123');
  });

  // WI-2644: packaged desktop sidecar has no npm_package_version in its env
  // (serve.mjs isn't invoked by npm) — PAPERCUSP_BUILD_VERSION is the fix.
  describe('PAPERCUSP_BUILD_VERSION (WI-2644 — desktop version stamping)', () => {
    it('prefers PAPERCUSP_BUILD_VERSION over npm_package_version when both are set', () => {
      const r = resolveBuildInfo({
        env: { PAPERCUSP_BUILD_VERSION: '0.0.2', npm_package_version: '0.0.1' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
      });
      expect(r.version).toBe('0.0.2');
    });

    it('falls back to npm_package_version when PAPERCUSP_BUILD_VERSION is unset', () => {
      const r = resolveBuildInfo({
        env: { npm_package_version: '1.2.3' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
      });
      expect(r.version).toBe('1.2.3');
    });

    it('falls back to 0.0.0 when neither is set (packaged sidecar, no override)', () => {
      const r = resolveBuildInfo({ env: {} as NodeJS.ProcessEnv, gitSha: () => 'deadbee' });
      expect(r.version).toBe('0.0.0');
    });

    it('trims a whitespace env version', () => {
      const r = resolveBuildInfo({
        env: { PAPERCUSP_BUILD_VERSION: '  0.0.2  ' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
      });
      expect(r.version).toBe('0.0.2');
    });

    it('ignores an empty-string PAPERCUSP_BUILD_VERSION and falls back', () => {
      const r = resolveBuildInfo({
        env: { PAPERCUSP_BUILD_VERSION: '   ', npm_package_version: '1.2.3' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
      });
      expect(r.version).toBe('1.2.3');
    });
  });
});
