/**
 * EI-22353142436290538 / P-307 — regression coverage for the rootful Podman
 * build-health detector and its bake-script integration.
 *
 * `kill -0` reports success for a zombie, and a process can also exit during
 * the detector's sampling sleep. Before the fix both cases were reported as
 * STALLED even though there was no live build left to diagnose. These tests
 * run the shipped shell, rather than a copied model of it, against real
 * exited, zombie, and live-idle processes.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const P307_SCRIPT = resolve(REPO_ROOT, 'infra/images/bootc/p307-build-health.sh');
const BAKE_SCRIPT = resolve(REPO_ROOT, 'infra/images/bootc/bake-cloud-images.sh');

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function shellHarness(source: string, root: string, timeout = 10_000) {
  return spawnSync('bash', ['-c', source], {
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      P307_SCRIPT,
      TMP: root,
    },
  });
}

function outputOf(result: ReturnType<typeof shellHarness>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function expectSuccessfulHarness(result: ReturnType<typeof shellHarness>): string {
  const output = outputOf(result);
  expect(result.status, output).toBe(0);
  return output;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe('P-307 build-health process liveness', () => {
  it('does not report STALLED after the monitored process exits during sleep', () => {
    const root = tempRoot('p307-exited-');
    const result = shellHarness(
      String.raw`set -u
: >"$TMP/build.log"
(sleep 0.2) &
pid=$!
bash "$P307_SCRIPT" --pid "$pid" --log "$TMP/build.log" \
  --interval-sec 1 --stalled-after-sec 1 >"$TMP/monitor.out" 2>&1
rc=$?
wait "$pid" 2>/dev/null || true
test "$rc" -eq 0
! grep -q 'status=STALLED' "$TMP/monitor.out"
`,
      root,
    );

    expectSuccessfulHarness(result);
  });

  it('does not treat a live zombie root as a stalled build', () => {
    const root = tempRoot('p307-zombie-');
    const result = shellHarness(
      String.raw`set -u
: >"$TMP/build.log"
python3 - "$TMP/child.pid" <<'PY' &
import os
import pathlib
import sys
import time

child = os.fork()
if child == 0:
    time.sleep(0.2)
    os._exit(0)
pathlib.Path(sys.argv[1]).write_text(str(child))
time.sleep(5)
PY
parent=$!
for _ in $(seq 1 100); do
  [ -s "$TMP/child.pid" ] && break
  sleep 0.01
done
test -s "$TMP/child.pid"
pid=$(cat "$TMP/child.pid")
sleep 0.5
state=$(awk '{print $3}' "/proc/$pid/stat")
test "$state" = Z
bash "$P307_SCRIPT" --pid "$pid" --log "$TMP/build.log" \
  --interval-sec 1 --stalled-after-sec 1 >"$TMP/monitor.out" 2>&1
rc=$?
kill "$parent" 2>/dev/null || true
wait "$parent" 2>/dev/null || true
test "$rc" -eq 0
! grep -q 'status=STALLED' "$TMP/monitor.out"
`,
      root,
    );

    expectSuccessfulHarness(result);
  });

  it('still reports a live idle process after the configured quiet interval', () => {
    const root = tempRoot('p307-live-idle-');
    const result = shellHarness(
      String.raw`set -u
: >"$TMP/build.log"
(sleep 30) &
pid=$!
bash "$P307_SCRIPT" --pid "$pid" --log "$TMP/build.log" \
  --interval-sec 1 --stalled-after-sec 1 >"$TMP/monitor.out" 2>&1 &
monitor=$!
for _ in $(seq 1 80); do
  grep -q 'status=STALLED' "$TMP/monitor.out" && break
  sleep 0.05
done
grep -q 'status=STALLED' "$TMP/monitor.out"
kill "$monitor" 2>/dev/null || true
wait "$monitor" 2>/dev/null || true
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
`,
      root,
    );

    expectSuccessfulHarness(result);
  });

  it('downgrades a rootful wrapper with incomplete process I/O to UNKNOWN', () => {
    const root = tempRoot('p307-rootful-unknown-');
    const result = shellHarness(
      String.raw`set -u
: >"$TMP/build.log"
(sleep 30) &
pid=$!
proc="$TMP/proc"
mkdir -p "$proc/$pid/task/$pid" "$proc/$((pid + 1))/task/$((pid + 1))"
printf '%s (sudo) S 0 0 0\n' "$pid" >"$proc/$pid/stat"
printf 'sudo\n' >"$proc/$pid/comm"
printf 'sudo\0-n\0podman\0run\0' >"$proc/$pid/cmdline"
printf 'rchar: 1\nwchar: 1\nread_bytes: 1\nwrite_bytes: 1\n' >"$proc/$pid/io"
printf '%s (podman) S 0 0 0\n' "$((pid + 1))" >"$proc/$((pid + 1))/stat"
printf 'podman\n' >"$proc/$((pid + 1))/comm"
printf 'rchar: 1\nwchar: 1\nread_bytes: 1\nwrite_bytes: 1\n' >"$proc/$((pid + 1))/io"
(
  for n in $(seq 2 80); do
    printf 'rchar: %s\nwchar: %s\nread_bytes: %s\nwrite_bytes: %s\n' \
      "$n" "$n" "$n" "$n" >"$proc/$((pid + 1))/io"
    sleep 0.05
  done
) &
advancer=$!
# The privileged descendant's counters advance, but an unprivileged monitor
# cannot traverse it from the sudo wrapper's process tree.
bash "$P307_SCRIPT" --pid "$pid" --log "$TMP/build.log" \
  --proc-root "$proc" --interval-sec 1 --stalled-after-sec 1 >"$TMP/monitor.out" 2>&1 &
monitor=$!
for _ in $(seq 1 80); do
  grep -q 'status=UNKNOWN' "$TMP/monitor.out" && break
  sleep 0.05
done
grep -q 'status=UNKNOWN' "$TMP/monitor.out"
kill "$monitor" 2>/dev/null || true
wait "$monitor" 2>/dev/null || true
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
wait "$advancer" 2>/dev/null || true
test "$(awk '$1 == "rchar:" {print $2}' "$proc/$((pid + 1))/io")" -gt 1
grep -q 'reason=process_io_unavailable' "$TMP/monitor.out"
! grep -q 'status=STALLED' "$TMP/monitor.out"
`,
      root,
    );

    expectSuccessfulHarness(result);
  });
});

describe('P-307 diagnostic mount ownership (EI-22359882088161242)', () => {
  it('scans process owners once and does not infer ownership from a shared mount namespace', () => {
    const root = tempRoot('p307-mount-owners-');
    const proc = join(root, 'proc');
    const bin = join(root, 'bin');
    const reads = join(root, 'comm-reads');
    mkdirSync(bin);
    writeFileSync(reads, '');
    writeFileSync(join(bin, 'cat'), `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in "$PROC_FIXTURE"/*/comm) printf 'read\\n' >> "$COMM_READS";; esac
done
exec /bin/cat "$@"
`, { mode: 0o755 });
    for (let pid = 100; pid < 140; pid++) {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(join(proc, String(pid), 'comm'), 'unrelated\n');
    }
    writeFileSync(join(proc, '100', 'stat'), '100 (podman) S 0 0 0\n');
    const targets = Array.from({ length: 8 }, (_, i) => `/var/lib/containers/storage/overlay/layer${i}/merged`);
    const missing = '/var/lib/containers/storage/overlay/missing/merged';
    const mountinfo = [...targets, missing].map((target, i) =>
      `${i + 1} 0 0:1 / ${target} rw - fuse.fuse-overlayfs fuse-overlayfs rw`,
    ).join('\n') + '\n';
    writeFileSync(join(proc, '100', 'mountinfo'), mountinfo);
    targets.forEach((target, i) => {
      const dir = join(proc, String(900 + i));
      mkdirSync(dir);
      writeFileSync(join(dir, 'comm'), 'fuse-overlayfs\n');
      writeFileSync(join(dir, 'cmdline'), ['fuse-overlayfs', '-o', 'lowerdir=/base', target, ''].join('\0'));
      // All processes see all mounts; visibility alone is not proof of ownership.
      writeFileSync(join(dir, 'mountinfo'), mountinfo);
    });
    const result = spawnSync('bash', [P307_SCRIPT, '--pid', '100', '--snapshot'], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROC_FIXTURE: proc,
        P307_BUILD_HEALTH_PROC_ROOT: proc, COMM_READS: reads },
    });
    const output = expectSuccessfulHarness(result);
    targets.forEach((target, i) => {
      const line = output.split('\n').find((entry) => entry.includes(`target=${target} `));
      expect(line).toContain(`owner_pid=${900 + i} `);
    });
    expect(output.split('\n').find((entry) => entry.includes(`target=${missing} `))).toContain('owner_pid=unknown');
    const externalReads = readFileSync(reads, 'utf8').split('\n').filter(Boolean).length;
    expect(externalReads).toBeLessThanOrEqual(48);
  });
});

describe('P-307 bake integration', () => {
  it('routes monitored command completion through the shipped detector without masking its exit code', () => {
    const source = readFileSync(BAKE_SCRIPT, 'utf8');
    const start = source.indexOf('run_monitored() {');
    const end = source.indexOf('\n\n# Requested clouds', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const root = tempRoot('p307-bake-integration-');
    const result = shellHarness(
      [
        'set -uo pipefail',
        `BUILD_HEALTH=${JSON.stringify(P307_SCRIPT)}`,
        source.slice(start, end),
        String.raw`run_monitored "$TMP/integration.log" bash -c 'sleep 0.2'`,
        'rc=$?',
        'printf "RUN_MONITORED_RC=%s\\n" "$rc"',
        'exit "$rc"',
      ].join('\n'),
      root,
    );

    const output = expectSuccessfulHarness(result);
    expect(output).toContain('RUN_MONITORED_RC=0');
    expect(output).not.toContain('status=STALLED');
  });
});
