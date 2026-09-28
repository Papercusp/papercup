/**
 * embedded-pg-host-credentials.test.ts — WI-10003627 unit coverage.
 *
 * On a multi-account host (a hosted workspace VM) the customer account shares
 * loopback with the operator's service user, and loopback TCP is not a uid
 * boundary: with the repo-public default role passwords the customer logged in to
 * the operator's embedded Postgres as a SUPERUSER. The embedded server now keys
 * every role to a per-host generated secret held in a 0600 file and refuses to boot
 * while a default still authenticates or a planted privileged role exists.
 *
 * These tests exercise the pure/injectable pieces without a postmaster; the
 * real-PG round trip (fresh boot, upgrade re-key, planted role refusal) lives in
 * embedded-pg-host-credentials.integration.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ROLE_PASSWORDS,
  EXPECTED_PRIVILEGED_ROLES,
  ROLE_NAMES,
  assertNoDefaultRoleCredentials,
  assertNoRogueRoles,
  isValidRoleCredentials,
  loadOrCreateRoleCredentials,
  roleBootstrapSql,
} from '@papercusp/embedded-postgres-server';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'epg-host-creds-'));
  dirs.push(dir);
  return dir;
}

/** Deterministic, obviously-synthetic 43-char values (base64url-shaped). */
function counterGenerator(): () => string {
  let n = 0;
  return () => `synthetic${(n += 1)}`.padEnd(43, 'x');
}

describe('loadOrCreateRoleCredentials', () => {
  it('generates four distinct strong values on first use and writes them 0600', async () => {
    const file = join(tempDir(), 'state', 'embedded-pg-credentials.json');
    const creds = await loadOrCreateRoleCredentials(file);
    expect(isValidRoleCredentials(creds)).toBe(true);
    expect(new Set(Object.values(creds)).size).toBe(4);
    for (const slot of ['owner', 'admin', 'app', 'zero'] as const) {
      expect(creds[slot]).not.toBe(DEFAULT_ROLE_PASSWORDS[slot]);
      expect(creds[slot]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    }
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.admin).toBe(creds.admin);
  });

  it('reuses the stored values on every later boot and re-tightens a loosened mode', async () => {
    const file = join(tempDir(), 'embedded-pg-credentials.json');
    const first = await loadOrCreateRoleCredentials(file, { generate: counterGenerator() });
    if (process.platform !== 'win32') chmodSync(file, 0o644);
    const second = await loadOrCreateRoleCredentials(file);
    expect(second).toEqual(first);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses to regenerate over an existing invalid file (the cluster is keyed to it)', async () => {
    const file = join(tempDir(), 'embedded-pg-credentials.json');
    writeFileSync(file, '{"owner":"short"}');
    await expect(loadOrCreateRoleCredentials(file)).rejects.toThrow(/invalid; refusing to regenerate/);
    expect(readFileSync(file, 'utf8')).toBe('{"owner":"short"}');
  });

  it('refuses a stored file that carries a repo-public default', async () => {
    const file = join(tempDir(), 'embedded-pg-credentials.json');
    const gen = counterGenerator();
    writeFileSync(
      file,
      JSON.stringify({ owner: gen(), admin: DEFAULT_ROLE_PASSWORDS.admin, app: gen(), zero: gen() }),
    );
    await expect(loadOrCreateRoleCredentials(file)).rejects.toThrow(/invalid/);
  });

  it('refuses a generator that produces a weak value instead of writing it', async () => {
    const file = join(tempDir(), 'embedded-pg-credentials.json');
    await expect(loadOrCreateRoleCredentials(file, { generate: () => 'weak' })).rejects.toThrow(
      /failed validation/,
    );
  });
});

describe('roleBootstrapSql', () => {
  it('keeps the DEV path create-only (never re-keys a developer cluster)', () => {
    const sql = roleBootstrapSql(DEFAULT_ROLE_PASSWORDS);
    expect(sql).toContain("CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'");
    expect(sql).not.toMatch(/ALTER ROLE harness_admin WITH LOGIN PASSWORD/);
  });

  it('re-keys every framework role on the host-credentials path', () => {
    const gen = counterGenerator();
    const secrets = { owner: gen(), admin: gen(), app: gen(), zero: gen() };
    const sql = roleBootstrapSql(secrets, { rekey: true });
    expect(sql).toContain(`ALTER ROLE harness_admin WITH LOGIN PASSWORD '${secrets.admin}'`);
    expect(sql).toContain(`ALTER ROLE harness_app WITH LOGIN PASSWORD '${secrets.app}'`);
    expect(sql).toContain(`ALTER ROLE harness_zero WITH LOGIN PASSWORD '${secrets.zero}'`);
    expect(sql).not.toContain('harness_admin_pwd');
  });

  it('refuses a value that could break out of the SQL literal', () => {
    const gen = counterGenerator();
    expect(() =>
      roleBootstrapSql({ owner: gen(), admin: "x'; DROP ROLE postgres; --", app: gen(), zero: gen() }),
    ).toThrow(/not SQL-safe/);
  });
});

type FakeClient = ((strings: TemplateStringsArray) => Promise<unknown>) & { end: () => Promise<void> };

function fakeConnect(outcome: (user: string, probe: string) => 'accept' | 'refuse' | 'unreachable') {
  const attempts: string[] = [];
  const connect = ({ user, password }: { user: string; password: string }): FakeClient => {
    attempts.push(user);
    const client = (async () => {
      const verdict = outcome(user, password);
      if (verdict === 'accept') return [{ '?column?': 1 }];
      const error = new Error(verdict) as Error & { code?: string };
      error.code = verdict === 'refuse' ? '28P01' : 'ECONNREFUSED';
      throw error;
    }) as FakeClient;
    client.end = async () => {};
    return client;
  };
  return { connect, attempts };
}

describe('assertNoDefaultRoleCredentials', () => {
  it('passes only when every role refuses its default with an auth failure', async () => {
    const { connect, attempts } = fakeConnect(() => 'refuse');
    await expect(
      assertNoDefaultRoleCredentials({ port: 5532, database: 'papercusp', connect: connect as never }),
    ).resolves.toBeUndefined();
    expect(attempts.sort()).toEqual([...EXPECTED_PRIVILEGED_ROLES].sort());
  });

  it('refuses to serve when any role still accepts its default (the measured exposure)', async () => {
    const { connect } = fakeConnect((user) => (user === ROLE_NAMES.admin ? 'accept' : 'refuse'));
    await expect(
      assertNoDefaultRoleCredentials({ port: 5532, database: 'papercusp', connect: connect as never }),
    ).rejects.toThrow(/still accepts the repo-public default password for harness_admin/);
  });

  it('fails closed when a probe is unverifiable rather than treating it as refused', async () => {
    const { connect } = fakeConnect((user) => (user === ROLE_NAMES.app ? 'unreachable' : 'refuse'));
    await expect(
      assertNoDefaultRoleCredentials({ port: 5532, database: 'papercusp', connect: connect as never }),
    ).rejects.toThrow(/could not verify .*harness_app/);
  });
});

function fakeRoleSql(rows: Array<{ rolname: string; rolsuper: boolean }>) {
  return (async () => rows) as never;
}

describe('assertNoRogueRoles', () => {
  const framework = [
    { rolname: 'postgres', rolsuper: true },
    { rolname: 'harness_admin', rolsuper: true },
    { rolname: 'harness_zero', rolsuper: true },
    { rolname: 'harness_app', rolsuper: false },
  ];

  it('accepts exactly the framework roles', async () => {
    await expect(assertNoRogueRoles(fakeRoleSql(framework))).resolves.toBeUndefined();
  });

  it('refuses a planted login/elevated role', async () => {
    await expect(
      assertNoRogueRoles(fakeRoleSql([...framework, { rolname: 'intruder', rolsuper: true }])),
    ).rejects.toThrow(/unexpected privileged role\(s\) intruder/);
  });

  it('refuses a harness_app that gained SUPERUSER', async () => {
    const elevated = framework.map((r) => (r.rolname === 'harness_app' ? { ...r, rolsuper: true } : r));
    await expect(assertNoRogueRoles(fakeRoleSql(elevated))).rejects.toThrow(/harness_app holds SUPERUSER/);
  });
});
