import { describe, expect, it } from 'vitest';
import { ADMIN_PG_ENV_KEYS, assertNoAdminPgAccess, buildForeignProcessEnv } from './pg-credential-isolation';

describe('assertNoAdminPgAccess', () => {
  it('passes a clean env', () => {
    expect(assertNoAdminPgAccess({ PATH: '/usr/bin', HOME: '/home/x' })).toEqual({ ok: true });
  });

  it('flags DATABASE_URL as a violation', () => {
    const v = assertNoAdminPgAccess({ DATABASE_URL: 'postgres://x' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.offendingKeys).toEqual(['DATABASE_URL']);
  });

  it('flags EVERY offending key, not just the first', () => {
    const v = assertNoAdminPgAccess({ DATABASE_URL: 'x', PGPASSWORD: 'y', PATH: '/z' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.offendingKeys.sort()).toEqual(['DATABASE_URL', 'PGPASSWORD']);
  });

  it('fails closed on an empty-string value (a blank var can still satisfy a truthy resolver bug)', () => {
    const v = assertNoAdminPgAccess({ PGHOST: '' });
    expect(v.ok).toBe(false);
  });
});

describe('buildForeignProcessEnv', () => {
  it('strips every ADMIN_PG_ENV_KEYS entry and leaves everything else untouched', () => {
    const hostEnv = { PATH: '/usr/bin', DATABASE_URL: 'postgres://x', PGUSER: 'admin', HOME: '/home/x' };
    const out = buildForeignProcessEnv(hostEnv);
    for (const k of ADMIN_PG_ENV_KEYS) expect(out[k]).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/x');
  });

  it('does not mutate the input env', () => {
    const hostEnv = { DATABASE_URL: 'postgres://x' };
    buildForeignProcessEnv(hostEnv);
    expect(hostEnv.DATABASE_URL).toBe('postgres://x');
  });

  it('round-trips clean through assertNoAdminPgAccess', () => {
    const hostEnv = { DATABASE_URL: 'postgres://x', PGPASSWORD: 'y', PATH: '/usr/bin' };
    expect(assertNoAdminPgAccess(buildForeignProcessEnv(hostEnv))).toEqual({ ok: true });
  });
});
