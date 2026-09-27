import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const AUTOTUNE = join(ROOT, 'scripts/pg-autotune.ts');

describe('pg-autotune host-backup exclusion', () => {
  it('refuses --apply before touching PostgreSQL while the host dump owns its lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-pg-autotune-lock-'));
    const lock = join(dir, 'db-backup.lock');
    const holder = spawn('flock', ['-x', lock, 'sleep', '3'], { stdio: 'ignore' });
    try {
      let held = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (existsSync(lock) && spawnSync('flock', ['-n', lock, 'true']).status === 1) {
          held = true;
          break;
        }
        await delay(20);
      }
      expect(held).toBe(true);

      const result = spawnSync('npx', ['tsx', AUTOTUNE, '--apply'], {
        cwd: ROOT,
        env: { ...process.env, PC_BACKUP_LOCK: lock },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(75);
      expect(result.stderr).toContain('PostgreSQL apply deferred: host backup holds');
      expect(result.stdout).not.toContain('writing /etc/postgresql');
    } finally {
      holder.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
