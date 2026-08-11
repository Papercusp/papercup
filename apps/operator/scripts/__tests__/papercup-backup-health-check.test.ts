import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'papercup-backup-health-check.sh');

describe('papercup-backup-health-check.sh', () => {
  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toBe('');
  });

  it('passes the shipped self-test, including disk-headroom discrimination', () => {
    const output = execFileSync('bash', [SCRIPT, '--self-test'], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    expect(output).toContain('post disk-headroom block');
    expect(output).not.toMatch(/FAIL/);
  });
});
