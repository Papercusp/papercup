import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');
const source = readFileSync(SCRIPT, 'utf8');

function watchdogSource(): string {
  const match = source.match(/run_bounded_watched\(\) \{[\s\S]*?\n\}/);
  expect(match, 'run_bounded_watched must be extractable').toBeTruthy();
  return match?.[0] ?? '';
}

function functionBody(name: string): string {
  const start = source.indexOf(`${name}() {`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

describe('papercusp database-backup progress watchdog', () => {
  it('keeps a finite floor and a larger absolute ceiling', () => {
    expect(source).toContain('TIMEOUT_SEC="${PC_BACKUP_TIMEOUT_SEC:-2700}"');
    expect(source).toContain('TIMEOUT_MAX_SEC="${PC_BACKUP_TIMEOUT_MAX_SEC:-5400}"');
    expect(source).toContain('PROGRESS_STALE_SEC="${PC_BACKUP_PROGRESS_STALE_SEC:-300}"');
    expect(source).toContain('KILL_GRACE_SEC="${PC_BACKUP_KILL_GRACE_SEC:-5}"');
    expect(source).toContain('[ "$TIMEOUT_MAX_SEC" -lt "$TIMEOUT_SEC" ]');
  });

  it('lets archive growth extend the floor but never the absolute ceiling', () => {
    const body = functionBody('run_bounded_watched');
    expect(body).toContain('current_bytes=$(du -sb "$progress_path"');
    expect(body).toContain('[ "$current_bytes" -gt "$last_bytes" ]');
    expect(body).toContain('last_progress_epoch="$now_epoch"');
    expect(body).toContain('[ "$elapsed" -ge "$max_secs" ]');
    expect(body).toContain('[ "$elapsed" -ge "$floor_secs" ]');
    expect(body).toContain('[ $(( now_epoch - last_progress_epoch )) -ge "$PROGRESS_STALE_SEC" ]');
  });

  it('wires the live temporary directory into the watchdog and removes the blind timeout wrapper', () => {
    expect(source).toContain(
      'run_bounded_watched "$TIMEOUT_SEC" "$TIMEOUT_MAX_SEC" "$out.tmp"',
    );
    expect(source).not.toContain(
      'run_bounded_watched "$TIMEOUT_SEC" timeout --kill-after=20s "$TIMEOUT_SEC"',
    );
  });

  it('extends a growing archive past the floor but stops a stalled producer and a forever-growing one', () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-progress-watchdog-'));
    try {
      const harness = join(root, 'watchdog.sh');
      const progress = join(root, 'archive.tmp');
      writeFileSync(
        harness,
        `#!/usr/bin/env bash
set -uo pipefail
PC_BACKUP_WATCH_SEC=1
PC_BACKUP_MIN_FREE_GB=0
PROGRESS_STALE_SEC=2
KILL_GRACE_SEC=0
fs_avail_gb() { echo 999999; }
log() { printf '%s\\n' "$*" >&2; }
reap_own_stragglers() { :; }
${watchdogSource()}
case "$1" in
  growing)
    run_bounded_watched 2 8 "$PROGRESS_PATH" bash -c 'for i in 1 2 3 4; do printf x >> "$PROGRESS_PATH"; sleep 1; done'
    ;;
  stalled)
    run_bounded_watched 2 8 "$PROGRESS_PATH" bash -c 'sleep 20'
    ;;
  ceiling)
    run_bounded_watched 2 4 "$PROGRESS_PATH" bash -c 'for i in $(seq 1 20); do printf x >> "$PROGRESS_PATH"; sleep 1; done'
    ;;
esac
`,
      );
      chmodSync(harness, 0o755);
      const run = (mode: string) => spawnSync('bash', [harness, mode], {
        encoding: 'utf8',
        env: { ...process.env, PROGRESS_PATH: progress },
        timeout: 15_000,
      });

      const growing = run('growing');
      expect(growing.status, growing.stderr).toBe(0);
      expect(readFileSync(progress, 'utf8')).toHaveLength(4);

      rmSync(progress, { force: true });
      const stalled = run('stalled');
      expect(stalled.status, stalled.stderr).not.toBe(0);
      expect(stalled.stderr).toContain('killing stalled producer');

      rmSync(progress, { force: true });
      const ceiling = run('ceiling');
      expect(ceiling.status, ceiling.stderr).not.toBe(0);
      expect(ceiling.stderr).toContain('absolute watchdog ceiling 4s reached');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
