/**
 * Audit P-076 — the design-phase plugin resolves its PG DSN like every
 * other consumer: env → embedded-pg discovery file → native-:5432 dev
 * fallback. Before this, three inline `env || localhost:5432` chains
 * silently pointed a desktop run (embedded PG, random port) at a
 * wrong/absent native :5432.
 *
 * The plugin is hand-written CJS with an `_internal` test seam; node's
 * os.homedir() honors $HOME on linux, which is how the discovery-file
 * tier is steered at a temp dir here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const plugin = require_(
  '../../../libs/papercusp/plugins/design-phase/index.cjs',
) as { _internal: { resolveAdminPgUrl: () => string } };
const { resolveAdminPgUrl } = plugin._internal;

const SAVED = ['HOME', 'HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'PAPERCUSP_SKIP_PG_DISCOVERY'] as const;
let saved: Record<string, string | undefined> = {};
let tmpHome = '';

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), 'design-phase-dsn-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('design-phase plugin — resolveAdminPgUrl (P-076)', () => {
  it('explicit env wins', () => {
    process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://a:b@envhost:7777/papercusp';
    expect(resolveAdminPgUrl()).toBe('postgresql://a:b@envhost:7777/papercusp');
  });

  it('falls through to the embedded-pg discovery file', () => {
    mkdirSync(join(tmpHome, '.papercusp'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.papercusp', 'embedded-pg.json'),
      JSON.stringify({ host: '127.0.0.1', port: 39171, user: 'harness_admin', password: 'pw' }),
    );
    expect(resolveAdminPgUrl()).toBe('postgresql://harness_admin:pw@127.0.0.1:39171/papercusp');
  });

  it('PAPERCUSP_SKIP_PG_DISCOVERY=1 skips the file tier', () => {
    mkdirSync(join(tmpHome, '.papercusp'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.papercusp', 'embedded-pg.json'),
      JSON.stringify({ host: '127.0.0.1', port: 39171, user: 'u', password: 'p' }),
    );
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    expect(resolveAdminPgUrl()).toBe(
      'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp',
    );
  });

  it('no env + no discovery file → native dev fallback', () => {
    expect(resolveAdminPgUrl()).toBe(
      'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp',
    );
  });
});
