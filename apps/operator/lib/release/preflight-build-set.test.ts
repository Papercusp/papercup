/**
 * preflight-build-set.test.ts — release-readiness-preflight-gate-2026-07-19 P-002.
 * Unit coverage for the pre-flight build-role-set architecture invariant.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseBuildRoles,
  checkReleaseBuildSet,
  runPreflightBuildSetCli,
  RELEASE_DEFAULT_ROLES,
} from './preflight-build-set';

describe('parseBuildRoles', () => {
  it('splits, lower-cases, trims, and de-dupes', () => {
    expect(parseBuildRoles('gui server')).toEqual(['gui', 'server']);
    expect(parseBuildRoles('  GUI   Server ')).toEqual(['gui', 'server']);
    expect(parseBuildRoles('gui,server,gui')).toEqual(['gui', 'server']);
    expect(parseBuildRoles('server')).toEqual(['server']);
  });

  it('treats empty / nullish as no roles', () => {
    expect(parseBuildRoles('')).toEqual([]);
    expect(parseBuildRoles(undefined)).toEqual([]);
    expect(parseBuildRoles(null)).toEqual([]);
    expect(parseBuildRoles('   ')).toEqual([]);
  });
});

describe('checkReleaseBuildSet', () => {
  it('passes when the role set covers gui + server', () => {
    const res = checkReleaseBuildSet(['gui', 'server']);
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
    expect(res.allowedIncomplete).toBe(false);
  });

  it('order-independent and tolerant of extra roles', () => {
    expect(checkReleaseBuildSet(['server', 'gui', 'docs']).ok).toBe(true);
  });

  it('FAILS a gui-only release cut (the 0.0.12 dropped-Server class)', () => {
    const res = checkReleaseBuildSet(['gui']);
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(['server']);
    expect(res.message).toMatch(/INCOMPLETE/);
    expect(res.message).toMatch(/Server/);
  });

  it('FAILS an empty role set', () => {
    const res = checkReleaseBuildSet([]);
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(['gui', 'server']);
  });

  it('allowIncomplete turns a miss into a passing CONSCIOUS warning', () => {
    const res = checkReleaseBuildSet(['gui'], { allowIncomplete: true });
    expect(res.ok).toBe(true);
    expect(res.allowedIncomplete).toBe(true);
    expect(res.missing).toEqual(['server']);
    expect(res.message).toMatch(/CONSCIOUS partial cut/);
  });
});

describe('runPreflightBuildSetCli', () => {
  it('exit 0 when PAPERCUSP_BUILD_ROLES unset (release default = gui server)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(runPreflightBuildSetCli({})).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(RELEASE_DEFAULT_ROLES).toBe('gui server');
  });

  it('exit 1 for an explicit gui-only real cut', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(runPreflightBuildSetCli({ PAPERCUSP_BUILD_ROLES: 'gui' })).toBe(1);
    } finally {
      err.mockRestore();
    }
  });

  it('exit 0 for gui-only WITH the explicit incomplete override', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        runPreflightBuildSetCli({ PAPERCUSP_BUILD_ROLES: 'gui', PAPERCUSP_ALLOW_INCOMPLETE_ROLES: '1' }),
      ).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});
