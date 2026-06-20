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
});
