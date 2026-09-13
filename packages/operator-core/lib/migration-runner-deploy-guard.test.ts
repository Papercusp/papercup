import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const dirs: string[] = [];

function fixtureDir(sql = 'SELECT 1;') {
  const dir = mkdtempSync(join(tmpdir(), 'migration-runner-guard-'));
  dirs.push(dir);
  writeFileSync(join(dir, '001-guard.sql'), sql, 'utf8');
  return dir;
}

function fakeClient(applied: string[] = []) {
  return {
    unsafe: vi.fn(async (sql: string) =>
      sql.includes('SELECT filename') ? applied.map((filename) => ({ filename })) : undefined,
    ),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migration runner beforeApply guard', () => {
  it('runs before SQL and leaves a blocked file unrecorded', async () => {
    const client = fakeClient();
    const result = await applyPendingMigrations({
      client,
      sqlDir: fixtureDir(),
      continueOnError: true,
      beforeApply: () => {
        throw new Error('deployed companion is absent');
      },
    });

    expect(result).toMatchObject({
      appliedCount: 0,
      totalKnown: 1,
      // The runner wraps the guard's error with per-file context ("Migration
      // 001-guard.sql FAILED: …"), so pin the guard's own message by containment.
      failed: [{ file: '001-guard.sql', error: expect.stringContaining('deployed companion is absent') }],
    });
    expect(client.unsafe.mock.calls.some(([sql]) => sql.includes('BEGIN;'))).toBe(false);
  });

  it('allows an approved file through the normal transaction and ledger write', async () => {
    const client = fakeClient();
    const result = await applyPendingMigrations({
      client,
      sqlDir: fixtureDir(),
      beforeApply: () => undefined,
    });

    expect(result).toMatchObject({ appliedCount: 1, totalKnown: 1, failed: [] });
    expect(client.unsafe.mock.calls.some(([sql]) => sql.includes('BEGIN;'))).toBe(true);
  });

  it('commits statement-breakpoint chunks separately and records only the final chunk', async () => {
    const client = fakeClient();
    const result = await applyPendingMigrations({
      client,
      sqlDir: fixtureDir('SELECT 1;\n--> statement-breakpoint\nSELECT 2;'),
    });

    expect(result).toMatchObject({ appliedCount: 1, totalKnown: 1, failed: [] });
    const transactions = client.unsafe.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes('BEGIN;'));
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toContain('SELECT 1;');
    expect(transactions[0]).not.toContain('INSERT INTO harness_shared.schema_migrations');
    expect(transactions[1]).toContain('SELECT 2;');
    expect(transactions[1]).toContain('INSERT INTO harness_shared.schema_migrations');
  });

  it('does not call the guard again for a file already recorded in schema_migrations', async () => {
    const client = fakeClient(['001-guard.sql']);
    const beforeApply = vi.fn(() => {
      throw new Error('must not run for applied files');
    });
    const result = await applyPendingMigrations({ client, sqlDir: fixtureDir(), beforeApply });

    expect(result).toMatchObject({ appliedCount: 0, totalKnown: 1, failed: [] });
    expect(beforeApply).not.toHaveBeenCalled();
  });

  it.each(['restore', 'flush', 'missing-row'] as const)('refuses bulk completion when the durability barrier fails: %s', async (failure) => {
    const dir = fixtureDir();
    for (let i = 2; i <= 20; i += 1) writeFileSync(join(dir, `${String(i).padStart(3, '0')}-bulk.sql`), 'SELECT 1;');
    const client = {
      unsafe: vi.fn(async (query: string) => {
        if (query.includes('SELECT filename')) return [];
        if (query === 'SET synchronous_commit = on' && failure === 'restore') throw new Error('restore failed');
        if (query.startsWith('UPDATE harness_shared.schema_migrations SET sha256')) {
          if (failure === 'flush') throw new Error('flush failed');
          return [];
        }
        return undefined;
      }),
    };
    await expect(applyPendingMigrations({ client, sqlDir: dir })).rejects.toThrow(
      failure === 'missing-row' ? /durability barrier.*recorded file/ : `${failure} failed`,
    );
  });
});
