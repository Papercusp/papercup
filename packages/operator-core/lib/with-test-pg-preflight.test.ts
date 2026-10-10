import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('isolated PostgreSQL durable evidence preflight', () => {
  it.each(['--isolated-runtime', '--isolated-runtime=operator-api'])('refuses ledger receipts without an explicit sink before allocating PostgreSQL (%s)', mode => {
    for (const receiptKey of ['PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PC_EXECUTED_SOURCE_MAP_RESULT']) {
      const env = { ...process.env, [receiptKey]: '/tmp/unwritten-private-ledger-receipt' };
      delete env.PAPERCUSP_TEST_RUNS_DB_URL;
      let failure: { status: number; stdout: string; stderr: string } | undefined;
      try {
        execFileSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), mode, '--', process.execPath, '-e', 'process.exit(91)'], {
          cwd: root, env, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
        });
      } catch (error) { failure = error as typeof failure; }
      expect(failure).toBeDefined();
      expect(failure!.status).toBe(1);
      expect(failure!.stderr).toContain('PAPERCUSP_TEST_RUNS_DB_URL is required for durable isolated test receipts');
      expect(failure!.stdout).not.toContain('booting throwaway PG');
    }
  });
});

describe('private PostgreSQL child executable preflight', () => {
  it.each(['missing-name', 'missing-relative', 'directory', 'non-executable'])('refuses %s before allocating PostgreSQL', kind => {
    const directory = mkdtempSync(join(tmpdir(), 'pg-child-preflight-'));
    const file = join(directory, 'not-executable');
    writeFileSync(file, 'not a command', { mode: 0o600 });
    const command = kind === 'missing-name' ? 'papercusp-missing-child-executable-0f38' :
      kind === 'missing-relative' ? './papercusp-missing-relative-executable-0f38' :
        kind === 'directory' ? directory : file;
    try {
      let failure: { status: number; stdout: string; stderr: string } | undefined;
      try {
        execFileSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--', command], {
          cwd: join(root, 'packages/operator-core'), encoding: 'utf8', timeout: 5000, stdio: 'pipe',
        });
      } catch (error) { failure = error as typeof failure; }
      expect(failure).toBeDefined();
      expect(failure!.status).toBe(1);
      expect(failure!.stderr).toContain('child preflight failed');
      expect(failure!.stdout).not.toContain('booting throwaway PG');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
