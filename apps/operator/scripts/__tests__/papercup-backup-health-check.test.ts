import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
    // spawnSync, not execFileSync: a non-zero self-test used to surface only as
    // "Command failed: bash … --self-test", and the self-test's own FAIL lines
    // were dropped. The gate recorded exactly that for repairHead 709766df on
    // 2026-09-30 and it never reproduced, so the red carried no evidence. The
    // exit status, signal and FAIL lines now go into the assertion itself.
    const run = spawnSync('bash', [SCRIPT, '--self-test'], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const output = run.stdout ?? '';
    expect({
      status: run.status,
      signal: run.signal,
      error: run.error?.message ?? null,
      failLines: output.split('\n').filter((line) => line.includes('FAIL')),
      stderrTail: (run.stderr ?? '').slice(-2000),
    }).toEqual({
      status: 0,
      signal: null,
      error: null,
      failLines: [],
      stderrTail: expect.any(String),
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

  it('keeps the degraded workspace-dump filing title stable for work-item dedupe', () => {
    const health = readFileSync(SCRIPT, 'utf8');

    // work_items:create fingerprints the admission title. Age is intentionally
    // measured in the body: including it in TITLE would turn each health-check
    // tick into a new critical item as the artifact gets older.
    expect(health).toContain(
      'TITLE="Workspace DB dump is stale after its latest snapshot hook degraded: $art"',
    );
    expect(health).not.toContain(
      'TITLE="Workspace DB dump is stale after its latest snapshot hook degraded: $art is ${age_hours}h old"',
    );
    expect(health).toContain(
      "BODY=\"The optional per-workspace dump '$f' is ${age_hours} hours old",
    );
  });

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
