import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const dirs: string[] = [];

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'migration-runner-guard-'));
  dirs.push(dir);
  writeFileSync(join(dir, '001-guard.sql'), 'SELECT 1;', 'utf8');
  return dir;
}

function fakeClient() {
  return {
    unsafe: vi.fn(async (sql: string) => (sql.includes('SELECT filename') ? [] : undefined)),
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
      failed: [{ file: '001-guard.sql', error: 'deployed companion is absent' }],
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
});
