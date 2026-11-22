import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');
const source = readFileSync(SCRIPT, 'utf8');

function watchdogSource(): string {
  const match = source.match(/run_bounded_watched\(\) \{[\s\S]*?\n\}/);
  expect(match, 'run_bounded_watched must be extractable').toBeTruthy();
  // Server-priority policy has its own focused tests. Watchdog fixtures must
  // neither query the workstation's database nor depend on an absent helper.
  return 'prioritize_backup_backends() { :; }\nlog_backup_diagnostics() { :; }\n' + (match?.[0] ?? '');
}

function functionBody(name: string): string {
  // Anchor the declaration so dump_one cannot match guarded_dump_one.
  const start = source.indexOf(`\n${name}() {\n`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
  return source.slice(start + 1, end + 3);
}

describe('papercusp database-backup progress watchdog', () => {
  it('publishes a PID-bound host writer marker and removes it on EXIT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-host-progress-marker-'));
    try {
      const dump = join(root, 'dump');
      const ready = join(root, 'ready');
      const release = join(root, 'release');
      const harness = join(root, 'marker-harness.sh');
      const markerWriter = functionBody('write_host_backup_progress_marker');
      const markerCleanup = functionBody('cleanup_host_backup_progress_marker');
      writeFileSync(harness, [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        'DUMP="$TEST_DUMP"',
        'mkdir -p "$DUMP"',
        'HOST_BACKUP_PROGRESS_PATH="$DUMP/IN_PROGRESS.$$.json"',
        markerWriter,
        markerCleanup,
        'trap cleanup_host_backup_progress_marker EXIT',
        'write_host_backup_progress_marker',
        'touch "$READY_PATH"',
        'while [ ! -e "$RELEASE_PATH" ]; do sleep 0.01; done',
        '',
      ].join('\n'));
      chmodSync(harness, 0o755);

      const child = spawn('bash', [harness], {
        env: { ...process.env, TEST_DUMP: dump, READY_PATH: ready, RELEASE_PATH: release },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
      try {
        const deadline = Date.now() + 5_000;
        while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(ready), `marker child exit=${child.exitCode}; stderr=${stderr}`).toBe(true);

        const markerPath = join(dump, `IN_PROGRESS.${child.pid}.json`);
        const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
        expect(marker).toMatchObject({ pid: child.pid, phase: 'host-backup' });
        expect(marker.processStartTicks).toMatch(/^\d+$/);
        expect(marker.startedAtEpoch).toBeTypeOf('number');

        writeFileSync(release, 'finish');
        expect(await closed, stderr).toBe(0);
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        // Failed readiness/assertions must not strand the fixture's live shell.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await closed;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a finite stall floor and a 150-minute absolute ceiling', () => {
    expect(source).toContain('TIMEOUT_SEC="${PC_BACKUP_TIMEOUT_SEC:-2700}"');
    expect(source).toContain('TIMEOUT_MAX_SEC="${PC_BACKUP_TIMEOUT_MAX_SEC:-9000}"');
    expect(source).toContain('PROGRESS_STALE_SEC="${PC_BACKUP_PROGRESS_STALE_SEC:-300}"');
    expect(source).toContain('KILL_GRACE_SEC="${PC_BACKUP_KILL_GRACE_SEC:-5}"');
    expect(source).toContain('[ "$TIMEOUT_MAX_SEC" -lt "$TIMEOUT_SEC" ]');
  });

  it('lets archive growth extend the floor but never the absolute ceiling', () => {
    const body = functionBody('run_bounded_watched');
    expect(body).toContain('measurement_output=$(timeout --kill-after=1s 4s sudo -n -u postgres sh -c');
    expect(body).toContain('exec du -sb -- "$1"');
    expect(body).not.toContain('current_bytes=$(du -sb "$progress_path"');
    expect(body).not.toContain('current_bytes=${current_bytes:-0}');
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

  it.each([
    ['growing', 9, 'absolute watchdog ceiling', 1],
    ['stalled-after-floor', 6, 'killing stalled producer', 1],
    ['stalled-from-start', 4, 'killing stalled producer', 1],
    ['growing-sparse', 9, 'absolute watchdog ceiling', 100],
  ] as const)('observes liveness before and termination at the %s boundary', (mode, due, reason, step) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-watchdog-boundary-'));
    try {
      const clock = join(root, 'clock');
      const observations = join(root, 'observations');
      const progress = join(root, 'archive.tmp');
      const harness = join(root, 'boundary.sh');
      writeFileSync(clock, '0');
      // The injected clock and growth schedule drive the real watchdog. Its
      // privileged du still measures an actual directory and compressed-named
      // member. Only the fixture's wait/clock are synthetic (D-005).
      writeFileSync(harness, `#!/usr/bin/env bash
set -uo pipefail
PC_BACKUP_WATCH_SEC=1
PC_BACKUP_MIN_FREE_GB=0
PROGRESS_STALE_SEC=$(( 2 * TICK_STEP ))
KILL_GRACE_SEC=0
mkdir -p "$PROGRESS_PATH"
: > "$PROGRESS_PATH/1.dat.zst"
fs_avail_gb() { echo 999999; }
log() { printf '%s\\n' "$*" >&2; }
reap_own_stragglers() { :; }
sudo() { shift 3; command "$@"; }
timeout() { shift 2; "$@"; }
date() {
  local now
  now=$(cat "$CLOCK")
  if [[ -v dump_pid ]] && builtin kill -0 "$dump_pid" 2>/dev/null; then
    printf 'alive %s\\n' "$now" >> "$OBSERVATIONS"
  fi
  printf '%s\\n' "$now"
}
sleep() {
  [ "$1" != 0 ] || return 0
  local tick
  tick=$(( $(cat "$CLOCK") + TICK_STEP ))
  printf '%s\\n' "$tick" > "$CLOCK.next"
  mv -- "$CLOCK.next" "$CLOCK"
  if [[ "$MODE" = growing* ]] || { [ "$MODE" = stalled-after-floor ] && [ "$tick" -le 4 ]; }; then
    printf x >> "$PROGRESS_PATH/1.dat.zst"
  fi
}
kill() {
  if [ "$1" = -TERM ]; then
    printf 'terminate %s\\n' "$(cat "$CLOCK")" >> "$OBSERVATIONS"
  fi
  builtin kill "$@"
}
${watchdogSource()}
log_backup_diagnostics() {
  printf 'diagnose %s\\n' "$(cat "$CLOCK")" >> "$OBSERVATIONS"
}
run_bounded_watched "$(( 4 * TICK_STEP ))" "$(( 9 * TICK_STEP ))" "$PROGRESS_PATH" /bin/sleep 30
`);
      const run = spawnSync('bash', [harness], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, MODE: mode, CLOCK: clock, OBSERVATIONS: observations, PROGRESS_PATH: progress, TICK_STEP: String(step) },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect([137, 143], run.stderr).toContain(run.status);
      expect(run.stderr).toContain(reason);
      const observed = readFileSync(observations, 'utf8').trim().split('\n');
      expect(observed).toEqual([
        ...Array.from({ length: due }, (_, i) => (i + 1) * step).flatMap((time) =>
          time === 300 || time === 600 ? [`alive ${time}`, `diagnose ${time}`] : [`alive ${time}`]),
        `diagnose ${due * step}`,
        `terminate ${due * step}`,
      ]);
      // The complete ordered trace falsifies an early kill even when a later
      // "dead by ceiling" assertion would pass. Production defaults are pinned
      // separately above; this fixture preserves the same predicate ordering.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['success', 'failure', 'timeout', 'killed-timeout', 'signal-kill'])('retains bounded COPY diagnostics through probe %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-copy-diagnostics-'));
    try {
      const sudo = join(root, 'sudo');
      const args = join(root, 'args');
      writeFileSync(sudo, `#!/bin/bash
printf '%s\\n' "$@" > "$PROBE_ARGS"
[ "$PROBE_MODE" != timeout ] || exec /bin/sleep 30
[ "$PROBE_MODE" != killed-timeout ] || { trap '' TERM; exec /bin/sleep 30; }
[ "$PROBE_MODE" != signal-kill ] || kill -KILL $$
[ "$PROBE_MODE" != failure ] || { echo 'database unavailable' >&2; exit 13; }
printf '%s\\n' '[{"pid":42,"wait":"DataFileRead","copyBytes":8192}]'
`);
      chmodSync(sudo, 0o755);
      const run = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        'HOST_BACKUP_APPLICATION_NAME=pcbackup',
        'log() { printf "%s\\n" "$*"; }',
        functionBody('log_backup_diagnostics'),
        'log_backup_diagnostics /archive/state.tmp 9000 43862092935 ceiling',
        'printf "producer continues\\n"',
      ].join('\n')], {
        encoding: 'utf8', timeout: 7_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PROBE_ARGS: args, PROBE_MODE: mode },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('elapsed=9000 archive_bytes=43862092935 reason=ceiling');
      const outcomes = {
        success: [0, 'ok'],
        failure: [13, 'failed'],
        timeout: [124, 'wall-timeout'],
        'killed-timeout': [137, 'wall-timeout-kill'],
        'signal-kill': [137, 'signal-kill'],
      } as const;
      const [status, outcome] = outcomes[mode as keyof typeof outcomes];
      expect(run.stdout).toContain(`probe_status=${status} probe_outcome=${outcome}`);
      expect(run.stdout).toContain(mode === 'success'
        ? 'snapshot_source=current snapshot_elapsed=9000 snapshot=[{"pid":42'
        : 'snapshot_source=unavailable snapshot_elapsed=unknown snapshot=[]');
      if (mode === 'failure') expect(run.stdout).toContain('probe_detail=database unavailable');
      if (mode === 'killed-timeout') expect(run.stdout).toContain('sending signal KILL');
      expect(run.stdout).toContain('producer continues');
      const probe = readFileSync(args, 'utf8');
      expect(probe).toContain('PGOPTIONS=-c statement_timeout=2000 -c lock_timeout=1000');
      expect(probe).toContain("application_name = 'pcbackup'");
      expect(probe).toContain('pg_stat_progress_copy');
      // Non-COPY SQL may include application data and must never enter logs.
      expect(probe).toContain("CASE WHEN a.query LIKE 'COPY %'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 8_000);

  it('retains the last successful COPY sample on failure without attributing it to another artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-copy-diagnostics-history-'));
    try {
      const sudo = join(root, 'sudo');
      writeFileSync(sudo, `#!/bin/bash
[ "$PROBE_MODE" != failure ] || { echo 'database unavailable' >&2; exit 13; }
printf '%s\\n' '[{"pid":42,"copy_bytes":8192}]'
`);
      chmodSync(sudo, 0o755);
      const run = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        'HOST_BACKUP_APPLICATION_NAME=pcbackup',
        'log() { printf "%s\\n" "$*"; }',
        functionBody('log_backup_diagnostics'),
        'export PROBE_MODE=success',
        'log_backup_diagnostics /archive/state.tmp 300 1024 progress',
        'export PROBE_MODE=failure',
        'log_backup_diagnostics /archive/state.tmp 9000 2048 abort',
        'log_backup_diagnostics /archive/transcript.tmp 300 4096 progress',
      ].join('\n')], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      const lines = run.stdout.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('snapshot_source=current snapshot_elapsed=300 snapshot=[{"pid":42');
      expect(lines[1]).toContain('probe_status=13 probe_outcome=failed');
      expect(lines[1]).toContain('snapshot_source=previous snapshot_elapsed=300 snapshot=[{"pid":42');
      expect(lines[1]).toContain('elapsed=9000 archive_bytes=2048 reason=abort');
      expect(lines[1]).toContain('probe_detail=database unavailable');
      expect(lines[2]).toContain('snapshot_source=unavailable snapshot_elapsed=unknown snapshot=[]');
      expect(lines[2]).not.toContain('"pid":42');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['success', 'zero', 'failure-with-output', 'malformed', 'hang', 'hang-ignore-term', 'signal-kill'])('distinguishes valid zero from an unavailable space measurement: %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-space-deadline-'));
    try {
      const stat = join(root, 'stat');
      writeFileSync(stat, [
        '#!/bin/bash',
        '[ "$MEASURE_MODE" != zero ] || { printf "0 4096\\n"; exit 0; }',
        '[ "$MEASURE_MODE" != malformed ] || { printf "not-a-number\\n"; exit 0; }',
        'printf "524288 4096\\n"',
        '[ "$MEASURE_MODE" != failure-with-output ] || exit 1',
        '[ "$MEASURE_MODE" != signal-kill ] || kill -KILL $$',
        '[ "$MEASURE_MODE" != hang-ignore-term ] || trap "" TERM',
        '[[ "$MEASURE_MODE" != hang* ]] || exec /bin/sleep 30',
      ].join('\n'));
      chmodSync(stat, 0o755);
      // A direct statfs observation must remain usable when df cannot read
      // unrelated mount metadata. The old df implementation fails this fixture.
      writeFileSync(join(root, 'df'), '#!/bin/bash\nexec /bin/sleep 30\n');
      chmodSync(join(root, 'df'), 0o755);
      const run = spawnSync('timeout', ['--kill-after=1s', '8s', 'bash', '-c', [
        'set -uo pipefail',
        'PGOUT=/fixture/backup-volume',
        'log() { printf "%s\\n" "$*" >&2; }',
        'timeout() {',
        '  [ "$1" = --verbose ] && [ "$2" = --kill-after=1s ] && [ "$3" = 4s ] || return 98',
        '  shift 3',
        // Exercise the actual observer deadline: a compressed 100ms wall also
        // measured supervisor startup, so an external SIGKILL could be
        // misclassified as a deadline before the observer was even reaped.
        '  command timeout --verbose --kill-after=1s 4s "$@"',
        '}',
        functionBody('fs_avail_gb'),
        'fs_avail_gb',
      ].join('\n')], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, MEASURE_MODE: mode },
      });
      expect(run.error, run.stderr).toBeUndefined();
      const valid = mode === 'success' || mode === 'zero';
      expect(run.status, run.stderr).toBe(valid ? 0 : 1);
      expect(run.stdout.trim()).toBe(valid ? (mode === 'success' ? '2' : '0') : '');
      if (valid) {
        expect(run.stderr).toContain('stage=stat-reaped');
        expect(run.stderr).not.toContain('SPACE MEASUREMENT FAILED:');
      } else {
        expect(run.stderr).toContain('SPACE MEASUREMENT FAILED:');
        expect(run.stderr).toContain(`stat_status=${mode === 'malformed' ? 0 : mode === 'hang' ? 124 : mode === 'hang-ignore-term' || mode === 'signal-kill' ? 137 : 1}`);
        expect(run.stderr).toContain(`probe_outcome=${mode === 'malformed' ? 'invalid-output' : mode === 'hang' ? 'wall-timeout' : mode === 'hang-ignore-term' ? 'wall-timeout-kill' : mode === 'signal-kill' ? 'signal-kill' : 'failed'}`);
        expect(run.stderr).toMatch(/probe_started_epoch=\d+\.\d+ probe_finished_epoch=\d+\.\d+/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('keeps a valid space observation independent of blocked diagnostic storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-space-log-blocked-'));
    try {
      const trace = join(root, 'blocked.log');
      const statSeen = join(root, 'stat-seen');
      const fifo = spawnSync('mkfifo', [trace], { encoding: 'utf8' });
      expect(fifo.status, fifo.stderr).toBe(0);
      writeFileSync(join(root, 'stat'), [
        '#!/bin/bash',
        'touch "$STAT_SEEN"',
        'printf "524288 4096\\n"',
      ].join('\n'));
      chmodSync(join(root, 'stat'), 0o755);
      const run = spawnSync('/bin/bash', ['-c', [
        'set -uo pipefail',
        'PGOUT=/fixture/backup-volume',
        'log() { printf "%s\\n" "$*" >&2; }',
        functionBody('fs_avail_gb'),
        'fs_avail_gb',
      ].join('\n')], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, LOG: trace, STAT_SEEN: statSeen },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(existsSync(statSeen), run.stderr).toBe(true);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe('2\n');
      expect(run.stderr).toContain('stage=child-started');
      expect(run.stderr).toContain('stage=stat-reaped');
      expect(run.stderr).not.toContain('SPACE MEASUREMENT FAILED:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it.each(['before-child', 'stat-wait', 'stat-ignores-term', 'success'] as const)(
    'retains separate space-observer stages without changing the measurement: %s', (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'backup-space-stages-'));
      const pidPath = join(root, 'stat-pid');
      try {
        const trace = join(root, 'backup.log');
        writeFileSync(trace, '');
        writeFileSync(join(root, 'python3'), [
          '#!/bin/bash',
          '[ "$PROBE_MODE" != before-child ] || exec /bin/sleep 30',
          'exec /usr/bin/python3 "$@"',
        ].join('\n'));
        writeFileSync(join(root, 'stat'), [
          '#!/bin/bash',
          'printf "%s\\n" "$$" > "$STAT_PID_PATH"',
          '[ "$PROBE_MODE" != success ] || { printf "524288 4096\\n"; exit 0; }',
          '[ "$PROBE_MODE" != stat-ignores-term ] || trap "" TERM',
          'exec /bin/sleep 30',
        ].join('\n'));
        for (const executable of ['python3', 'stat']) chmodSync(join(root, executable), 0o755);
        const run = spawnSync('/bin/bash', ['-c', [
          'set -uo pipefail',
          'PGOUT=/fixture/backup-volume',
          'log() { printf "%s\\n" "$*" >&2; }',
          functionBody('fs_avail_gb'),
          'fs_avail_gb',
        ].join('\n')], {
          encoding: 'utf8', timeout: 10_000,
          env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PROBE_MODE: mode, LOG: trace, STAT_PID_PATH: pidPath },
        });
        expect(run.error, run.stderr).toBeUndefined();
        expect(run.status, run.stderr).toBe(mode === 'success' ? 0 : 1);
        expect(run.stdout).toBe(mode === 'success' ? '2\n' : '');
        // The service journal receives complete stages after the measured
        // operation; the backup volume is never opened for diagnostics in it.
        const stages = run.stderr.split('\n').filter(line => line.startsWith('SPACE PROBE: ')).join('\n');
        expect(readFileSync(trace, 'utf8')).toBe('');
        if (mode === 'before-child') {
          expect(stages).toBe('');
          expect(existsSync(pidPath)).toBe(false);
        } else {
          expect(stages).toMatch(/stage=child-started monotonic_sec=\d+\.\d+ epoch=\d+\.\d+ supervisor_pid=\d+/);
          expect(stages).toContain(`stage=stat-spawned`);
          const pid = readFileSync(pidPath, 'utf8').trim();
          expect(stages).toContain(`stat_pid=${pid}`);
          if (mode === 'success') {
            expect(stages).toContain(`stage=stat-reaped`);
            expect(stages).toContain('stat_status=0');
            expect(stages).not.toContain('stage=pre-deadline');
            expect(run.stderr).not.toContain('SPACE MEASUREMENT FAILED:');
          } else {
            expect(stages).toMatch(/stage=pre-deadline .*stat_pid=\d+ stat=.+ wchan=.+ schedstat=.+ syscall=.+/);
            expect(stages).not.toContain('stat_status=0');
          }
        }
        if (mode !== 'success') {
          const id = run.stderr.match(/probe_id=(\d+:\d+\.\d+)/)?.[1];
          expect(id, run.stderr).toBeTruthy();
          if (mode !== 'before-child') expect(stages).toContain(`id=${id} `);
          expect(run.stderr).toContain(`probe_outcome=${mode === 'stat-ignores-term' ? 'wall-timeout-kill' : 'wall-timeout'}`);
        }
      } finally {
        if (existsSync(pidPath)) {
          try { process.kill(Number(readFileSync(pidPath, 'utf8').trim()), 'SIGKILL'); } catch { /* already reaped */ }
        }
        rmSync(root, { recursive: true, force: true });
      }
    }, 10_000,
  );

  it.each([
    ['1073741823 1', '0', null],
    ['1073741824 1', '1', null],
    ['1073741825 1', '1', null],
    ['9223372036854775806 1', '8589934591', null],
    ['9223372036854775807 1', '8589934591', null],
    ['9223372036854775808 1', '', 'arithmetic-overflow'],
    ['4611686018427387904 2', '', 'arithmetic-overflow'],
    ['1 9223372036854775808', '', 'arithmetic-overflow'],
    ['1 0', '', 'invalid-output'],
    ['1 4096 extra', '', 'invalid-output'],
    ['1 4096\n2 4096', '', 'invalid-output'],
    ['\n1 4096', '', 'invalid-output'],
    ['1 4096\n\n2 4096', '', 'invalid-output'],
    ['01 4096', '', 'invalid-output'],
  ] as const)('converts a complete filesystem observation or rejects it intact: %s', (measurement, expected, failure) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-space-arithmetic-'));
    try {
      writeFileSync(join(root, 'stat'), '#!/bin/bash\nprintf "%s\\n" "$MEASUREMENT"\n');
      chmodSync(join(root, 'stat'), 0o755);
      const run = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        'PGOUT=/fixture/backup-volume',
        'log() { printf "%s\\n" "$*" >&2; }',
        functionBody('fs_avail_gb'),
        'fs_avail_gb',
      ].join('\n')], {
        encoding: 'utf8', timeout: 4_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, MEASUREMENT: measurement },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(failure ? 1 : 0);
      expect(run.stdout.trim()).toBe(expected);
      if (failure) expect(run.stderr).toContain(`stat_status=0 probe_outcome=${failure}`);
      else expect(run.stderr).not.toContain('SPACE MEASUREMENT FAILED:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['unavailable', 'zero', 'low'])('aborts safely with the correct space diagnosis: %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-space-diagnosis-'));
    try {
      const stat = join(root, 'stat');
      writeFileSync(stat, [
        '#!/bin/bash',
        '[ "$MEASURE_MODE" != unavailable ] || { printf "fixture stat unavailable\\n" >&2; exit 1; }',
        'if [ "$MEASURE_MODE" = zero ]; then printf "0 4096\\n"; else printf "262144 4096\\n"; fi',
      ].join('\n'));
      chmodSync(stat, 0o755);
      const run = spawnSync('timeout', ['--kill-after=1s', '2s', 'bash', '-c', [
        'set -uo pipefail',
        'PGOUT=/fixture/backup-volume',
        'PC_BACKUP_WATCH_SEC=0.01',
        'PC_BACKUP_MIN_FREE_GB=120',
        'PROGRESS_STALE_SEC=1',
        'KILL_GRACE_SEC=0',
        'log() { printf "%s\\n" "$*" >&2; }',
        'reap_own_stragglers() { :; }',
        'sleep() { [ "$1" != 5 ] || return 0; command sleep "$@"; }',
        functionBody('fs_avail_gb'),
        watchdogSource(),
        'log_backup_diagnostics() { printf "diagnostic reason=%s\\n" "$4" >&2; }',
        'run_bounded_watched 1 8 /fixture/archive.tmp /bin/sleep 30',
        'rc=$?',
        'printf "watchdog returned:%s\\n" "$rc"',
        'test "$rc" -ne 0',
      ].join('\n')], {
        encoding: 'utf8', timeout: 4_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, MEASURE_MODE: mode },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('watchdog returned:');
      if (mode === 'unavailable') {
        expect(run.stderr).toContain('stat_status=1 probe_outcome=failed');
        expect(run.stderr).toContain('unable to measure free space');
        expect(run.stderr).toContain('diagnostic reason=space-unreadable');
        expect(run.stderr).not.toContain('free space fell to');
      } else {
        expect(run.stderr).toContain(`free space fell to ${mode === 'zero' ? 0 : 1} GiB`);
        expect(run.stderr).toContain('diagnostic reason=space-floor');
        expect(run.stderr).not.toContain('unable to measure free space');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['preflight', 'per-artifact'])('refuses %s admission when free space cannot be measured', (boundary) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-space-admission-'));
    try {
      const stat = join(root, 'stat');
      writeFileSync(stat, '#!/bin/bash\nprintf "fixture stat unavailable\\n" >&2\nexit 1\n');
      chmodSync(stat, 0o755);
      const preflight = source.match(/^(?:if ! )?PC_FREE_GB=\$\(fs_avail_gb\)[\s\S]*?^log "headroom ok:.*$/m)?.[0];
      expect(preflight).toBeTruthy();
      const run = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        'PGOUT=/fixture/backup-volume',
        'PC_BACKUP_MIN_FREE_GB=120',
        'PC_BACKUP_SPACE_SAFETY=140',
        'log() { printf "%s\\n" "$*" >&2; }',
        'rm_tmp() { :; }',
        'unexpected_producer() { printf "UNEXPECTED DATABASE ACCESS\\n" >&2; return 99; }',
        'PSQL=unexpected_producer',
        'run_bounded_watched() { unexpected_producer; }',
        functionBody('fs_avail_gb'),
        boundary === 'preflight' ? preflight! : functionBody('dump_one'),
        boundary === 'per-artifact' ? 'dump_one fixture fixture' : '',
      ].join('\n')], {
        encoding: 'utf8', timeout: 4_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(1);
      expect(run.stderr).toContain('stat_status=1 probe_outcome=failed');
      expect(run.stderr).toContain('unable to measure free space');
      expect(run.stderr).not.toContain('UNEXPECTED DATABASE ACCESS');
      expect(run.stderr).not.toContain('only 0 GiB free');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['success', null, null],
    ['before-failure', 'post-sudo-unobserved', 13],
    ['before-timeout', 'post-sudo-unobserved', 124],
    ['after-failure', 'post-sudo-entered', 13],
    ['after-timeout', 'post-sudo-entered', 124],
    ['after-killed-timeout', 'post-sudo-entered', 137],
    ['after-malformed', 'post-sudo-entered', 0],
  ] as const)('records archive observer execution stage without mistaking unknown progress for failure: %s', (mode, stage, status) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-size-stage-'));
    try {
      const progress = join(root, 'archive with spaces.tmp');
      writeFileSync(progress, 'x');
      writeFileSync(join(root, 'sudo'), [
        '#!/bin/bash',
        '[ "$1" = -n ] && [ "$2" = -u ] && [ "$3" = postgres ] || exit 97',
        'shift 3',
        '[ "$MEASURE_MODE" != before-failure ] || { echo "sudo startup failed" >&2; exit 13; }',
        '[ "$MEASURE_MODE" != before-timeout ] || exec /bin/sleep 30',
        'exec "$@"',
      ].join('\n'));
      writeFileSync(join(root, 'du'), [
        '#!/bin/bash',
        'if [ "$#" = 3 ]; then [ "$1" = -sb ] && [ "$2" = -- ] && [ "$3" = "$PROGRESS_PATH" ] || exit 96;',
        'else [ "$#" = 2 ] && [ "$1" = -sb ] && [ "$2" = "$PROGRESS_PATH" ] || exit 96; fi',
        '[ "$MEASURE_MODE" != after-failure ] || { echo "du failed" >&2; exit 13; }',
        '[ "$MEASURE_MODE" != after-timeout ] || exec /bin/sleep 30',
        '[ "$MEASURE_MODE" != after-killed-timeout ] || { trap "" TERM; exec /bin/sleep 30; }',
        '[ "$MEASURE_MODE" != after-malformed ] || { echo "invalid size"; exit 0; }',
        'printf "123\\t%s\\n" "$PROGRESS_PATH"',
      ].join('\n'));
      chmodSync(join(root, 'sudo'), 0o755);
      chmodSync(join(root, 'du'), 0o755);
      const run = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        'PC_BACKUP_WATCH_SEC=0.01',
        'PC_BACKUP_MIN_FREE_GB=1',
        'PROGRESS_STALE_SEC=99',
        'KILL_GRACE_SEC=0',
        'fs_avail_gb() { echo 999; }',
        'log() { printf "%s\\n" "$*" >&2; }',
        'reap_own_stragglers() { echo "reaped" >&2; }',
        'timeout() {',
        '  [ "$1" = --kill-after=1s ] && [ "$2" = 4s ] || return 98',
        '  shift 2',
        '  command timeout --kill-after=0.1s 0.1s "$@"',
        '}',
        watchdogSource(),
        'run_bounded_watched 99 100 "$PROGRESS_PATH" /bin/sleep "$PRODUCER_DURATION"',
      ].join('\n')], {
        encoding: 'utf8', timeout: 4_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PROGRESS_PATH: progress, MEASURE_MODE: mode, PRODUCER_DURATION: '0.5' },
      });
      expect(run.error, run.stderr).toBeUndefined();
      if (mode === 'success') {
        expect(run.status, run.stderr).toBe(0);
        expect(run.stderr).not.toContain('ABORTING DUMP');
      } else {
        expect(run.status, run.stderr).toBe(0);
        expect(run.stderr).toContain('unable to measure archive progress');
        expect(run.stderr).toContain(`du_status=${status} probe_stage=${stage}`);
        expect(run.stderr).toMatch(/probe_started_epoch=\d+\.\d+ probe_finished_epoch=\d+\.\d+/);
        expect(run.stderr).toContain('progress unknown');
        expect(run.stderr).not.toContain('ABORTING DUMP');
        expect(run.stderr).not.toContain('killing stalled producer');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['hang', 'hang-ignore-term'])('retains the absolute ceiling when the archive-size observer %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-size-deadline-'));
    try {
      const sudo = join(root, 'sudo');
      const progress = join(root, 'archive.tmp');
      writeFileSync(progress, 'x');
      writeFileSync(sudo, [
        '#!/bin/bash',
        '[ "$1" = -n ] && [ "$2" = -u ] && [ "$3" = postgres ] && [ "$4" = sh ] || exit 97',
        '[ "$MEASURE_MODE" != hang-ignore-term ] || trap "" TERM',
        'exec /bin/sleep 30',
      ].join('\n'));
      chmodSync(sudo, 0o755);
      const run = spawnSync('timeout', ['--kill-after=1s', '2s', 'bash', '-c', [
        'set -uo pipefail',
        'PC_BACKUP_WATCH_SEC=0.01',
        'PC_BACKUP_MIN_FREE_GB=1',
        'PROGRESS_STALE_SEC=1',
        'KILL_GRACE_SEC=0',
        'printf "0\\n" > "$CLOCK"',
        'date() { cat "$CLOCK"; }',
        'sleep() { if [ "$1" = "$PC_BACKUP_WATCH_SEC" ]; then tick=$(cat "$CLOCK"); printf "%s\\n" "$((tick + 1))" > "$CLOCK.next"; mv -- "$CLOCK.next" "$CLOCK"; fi; command sleep "$1"; }',
        'fs_avail_gb() { echo 999; }',
        'log() { printf "%s\\n" "$*" >&2; }',
        'reap_own_stragglers() { :; }',
        'timeout() {',
        '  [ "$1" = --kill-after=1s ] && [ "$2" = 4s ] || return 98',
        '  shift 2',
        '  command timeout --kill-after=0.1s 0.1s "$@"',
        '}',
        watchdogSource(),
        'run_bounded_watched 1 3 "$PROGRESS_PATH" /bin/sleep 30',
        'rc=$?',
        'printf "watchdog returned:%s\\n" "$rc"',
        'test "$rc" -ne 0',
      ].join('\n')], {
        encoding: 'utf8', timeout: 4_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PROGRESS_PATH: progress, MEASURE_MODE: mode, CLOCK: join(root, 'clock') },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('watchdog returned:');
      expect(run.stderr).toContain('unable to measure archive progress');
      expect(run.stderr).toContain(mode === 'hang' ? 'du_status=124' : 'du_status=137');
      expect(run.stderr).toContain('probe_stage=post-sudo-unobserved');
      expect(run.stderr).toContain('absolute watchdog ceiling 3s reached');
      expect(run.stderr).not.toContain('killing stalled producer');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['growing', 'stalled'])('requires fresh stall evidence after an observer gap: %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-observer-recovery-'));
    try {
      const progress = join(root, 'archive.tmp');
      writeFileSync(progress, 'x');
      const run = spawnSync('bash', ['-c', [
        'set -uo pipefail',
        'PC_BACKUP_WATCH_SEC=0.03',
        'PC_BACKUP_MIN_FREE_GB=1',
        'PROGRESS_STALE_SEC=2',
        'KILL_GRACE_SEC=0',
        'printf "0\\n" > "$CLOCK"',
        'date() { cat "$CLOCK"; }',
        // The producer reads this clock concurrently; publish whole records so
        // a truncation window cannot manufacture an early producer exit.
        'sleep() { if [ "$1" = "$PC_BACKUP_WATCH_SEC" ]; then tick=$(cat "$CLOCK"); printf "%s\\n" "$((tick + 1))" > "$CLOCK.next"; mv -- "$CLOCK.next" "$CLOCK"; fi; command sleep "$1"; }',
        'fs_avail_gb() { echo 999; }',
        'log() { printf "tick=%s %s\\n" "$(cat "$CLOCK")" "$*" >&2; }',
        'reap_own_stragglers() { :; }',
        'timeout() { shift 2; "$@"; }',
        'sudo() { tick=$(cat "$CLOCK"); if [ "$tick" -eq 2 ] || [ "$tick" -eq 3 ]; then echo "observer unavailable" >&2; return 13; fi; bytes=1; [ "$MODE" != growing ] || bytes="$tick"; printf "%s\\t%s\\n" "$bytes" "$PROGRESS_PATH"; }',
        watchdogSource(),
        'run_bounded_watched 1 9 "$PROGRESS_PATH" bash -c \'while [ "$(cat "$CLOCK")" -lt 7 ]; do /bin/sleep 0.005; done\'',
      ].join('\n')], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, CLOCK: join(root, 'clock'), PROGRESS_PATH: progress, MODE: mode },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.stderr).toContain('progress unknown');
      if (mode === 'growing') {
        expect(run.status, run.stderr).toBe(0);
        expect(run.stderr).not.toContain('ABORTING DUMP');
      } else {
        expect([137, 143], run.stderr).toContain(run.status);
        expect(run.stderr).toMatch(/tick=6 ABORTING DUMP:.*killing stalled producer/);
        expect(run.stderr).not.toMatch(/tick=[2345] ABORTING DUMP/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
PC_BACKUP_WATCH_SEC=0.25
PC_BACKUP_MIN_FREE_GB=0
PROGRESS_STALE_SEC=2
KILL_GRACE_SEC=0
fs_avail_gb() { echo 999999; }
log() { printf '%s\\n' "$*" >&2; }
reap_own_stragglers() { :; }
sudo() {
  printf '%s\\n' "$*" >>"$SUDO_LOG"
  [ "$1" = "-n" ] && [ "$2" = "-u" ] && [ "$3" = "postgres" ] || return 125
  shift 3
  if [ "\${FAIL_PROGRESS_MEASURE:-0}" = "1" ]; then
    printf '%s\\n' 'du: Permission denied' >&2
    return 1
  fi
  command "$@"
}
timeout() { shift 2; "$@"; }
${watchdogSource()}
case "$1" in
  growing)
    run_bounded_watched 2 12 "$PROGRESS_PATH" bash -c 'for i in 1 2 3 4 5 6 7 8; do printf x >> "$PROGRESS_PATH"; sleep 0.5; done'
    ;;
  startup)
    run_bounded_watched 2 12 "$PROGRESS_PATH" bash -c 'sleep 1; for i in 1 2 3 4; do printf x >> "$PROGRESS_PATH"; sleep 0.25; done'
    ;;
  stalled)
    : > "$PROGRESS_PATH"
    run_bounded_watched 2 8 "$PROGRESS_PATH" bash -c 'sleep 20'
    ;;
  ceiling)
    : > "$PROGRESS_PATH"
    run_bounded_watched 2 4 "$PROGRESS_PATH" bash -c 'for i in $(seq 1 20); do printf x >> "$PROGRESS_PATH"; sleep 1; done'
    ;;
  unmeasurable)
    : > "$PROGRESS_PATH"
    run_bounded_watched 2 8 "$PROGRESS_PATH" bash -c 'sleep 1'
    ;;
esac
`,
      );
      chmodSync(harness, 0o755);
      const sudoLog = join(root, 'sudo.log');
      const run = (mode: string, failMeasurement = false) => spawnSync('bash', [harness, mode], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PROGRESS_PATH: progress,
          SUDO_LOG: sudoLog,
          FAIL_PROGRESS_MEASURE: failMeasurement ? '1' : '0',
        },
        timeout: 15_000,
      });

      const growing = run('growing');
      expect(growing.status, growing.stderr).toBe(0);
      expect(readFileSync(progress, 'utf8')).toHaveLength(8);
      expect(readFileSync(sudoLog, 'utf8')).toContain('-n -u postgres sh -c');

      rmSync(progress, { force: true });
      const startup = run('startup');
      expect(startup.status, startup.stderr).toBe(0);
      expect(readFileSync(progress, 'utf8')).toHaveLength(4);

      rmSync(progress, { force: true });
      const stalled = run('stalled');
      expect(stalled.status, stalled.stderr).not.toBe(0);
      expect(stalled.stderr).toContain('killing stalled producer');

      rmSync(progress, { force: true });
      const ceiling = run('ceiling');
      expect(ceiling.status, ceiling.stderr).not.toBe(0);
      expect(ceiling.stderr).toContain('absolute watchdog ceiling 4s reached');

      rmSync(progress, { force: true });
      rmSync(sudoLog, { force: true });
      const unmeasurable = run('unmeasurable', true);
      expect(unmeasurable.status, unmeasurable.stderr).toBe(0);
      expect(unmeasurable.stderr).toContain('unable to measure archive progress');
      expect(unmeasurable.stderr).toContain('du_status=1 probe_stage=post-sudo-unobserved');
      expect(unmeasurable.stderr).toContain('output=du: Permission denied');
      expect(unmeasurable.stderr).not.toContain('killing stalled producer');
      expect(unmeasurable.stderr).not.toContain('ABORTING DUMP');
      expect(readFileSync(sudoLog, 'utf8')).toContain('-n -u postgres sh -c');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
