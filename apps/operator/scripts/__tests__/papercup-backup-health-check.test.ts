import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'papercup-backup-health-check.sh');
const PRODUCER = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');

describe('papercup-backup-health-check.sh', () => {
  // NOTE (WI-2145430): `bash -n` is a SYNTAX check and is structurally blind to
  // an unescaped double quote inside a multi-line double-quoted body — that is
  // valid syntax which merely closes the string early. This case passed
  // unchanged for the whole time the disk-headroom alarm body was truncated.
  // The self-test's shell-runtime-error block below is what covers that class.
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
    expect(output).toContain('stale stats do not create a false TOAST-bloat alarm');
    expect(output).toContain('persisted row estimate still flags genuine TOAST bloat');
    // WI-2145430: the self-test asserts that no probe path it exercised made
    // the SHELL itself complain. Anchored here so deleting that block from the
    // script fails this test instead of silently removing the only coverage of
    // a defect class `bash -n` cannot see.
    expect(output).toContain('post shell-runtime-error block');
    expect(output).toContain('no bash runtime error on any exercised probe path');
    expect(output).not.toMatch(/FAIL/);
  }, 150_000);

  it("keeps the health probe's producer-fit policy synchronized with db-backup.sh", () => {
    const health = readFileSync(SCRIPT, 'utf8');
    const producer = readFileSync(PRODUCER, 'utf8');

    // The probe intentionally mirrors the producer's env/default seam because
    // systemd snapshots each script independently. If either default changes,
    // this guard fails before the two thresholds can drift silently again.
    expect(health).toMatch(/PC_BACKUP_MIN_FREE_GB="\$\{PC_BACKUP_MIN_FREE_GB:-120\}"/);
    expect(health).toMatch(/PC_BACKUP_SPACE_SAFETY="\$\{PC_BACKUP_SPACE_SAFETY:-140\}"/);
    expect(producer).toMatch(/PC_BACKUP_MIN_FREE_GB="\$\{PC_BACKUP_MIN_FREE_GB:-120\}"/);
    expect(producer).toMatch(/PC_BACKUP_SPACE_SAFETY="\$\{PC_BACKUP_SPACE_SAFETY:-140\}"/);
  });
});
