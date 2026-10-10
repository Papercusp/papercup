/**
 * Guards the build disk-reservation ledger reader (EI-21951384112327922).
 *
 * THE BUG: disk-admission preflights only READ free space and reserve nothing, so
 * concurrent multi-GB builds each pass on the same bytes and collectively exhaust
 * the disk. Measured before the fix: two callers each demanding 75% of free space
 * were BOTH admitted, promising 606GB against 404GB free.
 *
 * The shell half is guarded by papercusp-desktop/bin/lib/disk-preflight.selftest.sh.
 * This file guards the Node half, and — the property neither side can check alone —
 * that the two agree on WHERE the ledger is. A divergence there does not throw: it
 * silently splits the ledger so each language reads an empty one, which is
 * indistinguishable from "no other builds are running". That is the failure mode
 * worth a test, because it disables the guard while every test still passes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assessCargoDiskAdmission,
  // @ts-ignore -- runtime reporter module intentionally tested from TypeScript.
} from '../../../../scripts/lib/cargo-result.mjs';
import {
  mountKeyForPath,
  readReservedGb,
  reservationDir,
  // @ts-ignore -- runtime reporter module intentionally tested from TypeScript.
} from '../../../../scripts/lib/disk-reservations.mjs';

const GIB = 1024 * 1024 * 1024;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..', '..', '..');
const SHELL_LIB = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'lib', 'disk-preflight.sh');

const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'pc-resv-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function seedReservation(
  ledger: string,
  key: string,
  name: string,
  fields: Record<string, string | number>,
): void {
  mkdirSync(join(ledger, key), { recursive: true });
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(join(ledger, key, name), `${body}\n`);
}

describe('disk reservation ledger — Node reader', () => {
  it('counts live legacy claims across mount aliases before admitting another build', () => {
    const ledger = scratch();
    const a = scratch();
    const b = scratch();
    const fakeBin = scratch();
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(fakeBin, 'df'), '#!/bin/sh\nprintf "%s\\n" ' + [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      `same-device 209715200 104857600 104857600 50% ${a}`,
      `same-device 209715200 104857600 104857600 50% ${b}`,
    ].map(quote).join(' ') + '\nexit 1 # an unrelated inaccessible mount must not hide readable mount rows\n');
    chmodSync(join(fakeBin, 'df'), 0o755);
    const fields = { pid: process.pid, start: currentStart(process.pid), expires: Math.floor(Date.now() / 1000) + 3600 };
    seedReservation(ledger, a.replace(/[^A-Za-z0-9]/g, '_'), 'a.res', { ...fields, gb: 60 });
    seedReservation(ledger, b.replace(/[^A-Za-z0-9]/g, '_'), 'b.res', { ...fields, gb: 35 });
    seedReservation(ledger, 'dev-0', 'other.res', { ...fields, gb: 500 });
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PAPERCUSP_DISK_RESERVATION_DIR: ledger };
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = env.PATH;
      expect(mountKeyForPath(a)).toBe(mountKeyForPath(b));
      expect(readReservedGb(a, { env })).toBe(95);
      expect(readReservedGb(b, { env })).toBe(95);
    } finally { process.env.PATH = originalPath; }
    const refusal = execFileSync('bash', ['-c', 'source "$1"; papercusp_require_free_gb "$2" 10 alias >/dev/null 2>&1; printf "%s" "$?"', '--', SHELL_LIB, a], { env, encoding: 'utf8', timeout: 30_000 });
    expect(refusal).toBe('28'); // 100 free - 95 reserved cannot admit ten.
  });

  it('a new shell claim is visible to the Node reader through a filesystem alias', () => {
    const ledger = scratch();
    const a = scratch();
    const b = scratch();
    const reader = join(REPO_ROOT, 'scripts/lib/disk-reservations.mjs');
    const script = 'source "$1"; papercusp_free_gb() { printf 100; }; papercusp_require_free_gb "$2" 12 alias >/dev/null || exit $?; ' +
      '"$4" --input-type=module -e \'import(process.argv[2]).then(m=>process.stdout.write(String(m.readReservedGb(process.argv[1]))))\' "$3" "$5"';
    expect(execFileSync('bash', ['-c', script, '--', SHELL_LIB, a, b, process.execPath, reader], {
      env: { ...process.env, PAPERCUSP_DISK_RESERVATION_DIR: ledger }, encoding: 'utf8', timeout: 30_000,
    })).toBe('12');
  });

  it('agrees with the shell writer on the ledger key for the same path', () => {
    // The load-bearing cross-language property. Executes BOTH derivations rather
    // than asserting a hardcoded string, so a change to either side is caught.
    const path = scratch();
    const fromShell = execFileSync(
      'bash',
      ['-c', `source ${JSON.stringify(SHELL_LIB)} && papercusp_mount_key ${JSON.stringify(path)}`],
      { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
    ).trim();
    const fromNode = mountKeyForPath(path);

    expect(fromNode).not.toBe('');
    expect(fromNode).toBe(fromShell);
  });

  it('sums a live reservation written in the shell format', () => {
    const ledger = scratch();
    const key = mountKeyForPath(ledger);
    // process.pid is live and its /proc start time is genuine, so this survives
    // both the liveness and the pid-recycling check.
    seedReservation(ledger, key, 'a.res', {
      pid: process.pid,
      start: currentStart(process.pid),
      gb: 12,
      expires: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: ledger } })).toBe(12);
  });

  it('ignores a reservation whose owner is gone', () => {
    const ledger = scratch();
    const key = mountKeyForPath(ledger);
    // A pid that cannot be running: exceeds any pid_max on this platform.
    seedReservation(ledger, key, 'dead.res', {
      pid: 4_294_967_000,
      gb: 500,
      expires: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: ledger } })).toBe(0);
  });

  it('ignores a reservation whose pid was recycled (start time differs)', () => {
    const ledger = scratch();
    const key = mountKeyForPath(ledger);
    // Live pid, wrong start time — the exact shape of a wrapped pid, which happens
    // ~daily here under fleet load, so trusting the pid alone is a false positive.
    seedReservation(ledger, key, 'recycled.res', {
      pid: process.pid,
      start: '999999999',
      gb: 500,
      expires: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: ledger } })).toBe(0);
  });

  it('ignores an expired reservation even when its owner is alive', () => {
    const ledger = scratch();
    const key = mountKeyForPath(ledger);
    seedReservation(ledger, key, 'expired.res', {
      pid: process.pid,
      start: currentStart(process.pid),
      gb: 500,
      expires: Math.floor(Date.now() / 1000) - 1,
    });
    expect(readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: ledger } })).toBe(0);
  });

  it('fails open to 0 when the ledger does not exist', () => {
    const ledger = scratch();
    expect(
      readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: join(ledger, 'nope') } }),
    ).toBe(0);
  });

  it('reservationDir honours the same env var the shell writer uses', () => {
    expect(reservationDir({ PAPERCUSP_DISK_RESERVATION_DIR: '/x/y' })).toBe('/x/y');
    expect(reservationDir({ TMPDIR: '/t' })).toBe('/t/papercusp-disk-reservations');
  });
});

describe('assessCargoDiskAdmission — reservation awareness', () => {
  const roomy = { totalBytes: 2_000 * GIB, freeBytes: 300 * GIB };

  it('admits when nothing is reserved', () => {
    expect(assessCargoDiskAdmission(roomy).allowed).toBe(true);
  });

  it('omitting reservedBytes reproduces the previous decision exactly', () => {
    // The additive-change guarantee: every existing caller is unaffected.
    const without = assessCargoDiskAdmission(roomy);
    const withZero = assessCargoDiskAdmission({ ...roomy, reservedBytes: 0 });
    expect(withZero.allowed).toBe(without.allowed);
    expect(withZero.reasons).toEqual(without.reasons);
    expect(withZero.freeGiB).toBe(without.freeGiB);
  });

  it('REFUSES when other live builds have reserved the headroom', () => {
    // The defect, at this writer: 300 GiB free looks admissible, but 298 GiB of it
    // is already promised. Admitting here is how the disk gets collectively drained.
    const admission = assessCargoDiskAdmission({ ...roomy, reservedBytes: 298 * GIB });
    expect(admission.allowed).toBe(false);
    expect(admission.reasons).toContain('reserved-by-other-builds');
    expect(admission.effectiveFreeGiB).toBe(2);
  });

  it('keeps freeBytes as the RAW measurement while deciding on the effective one', () => {
    // A caller reporting disk pressure still wants the true figure; only the
    // decision uses free-minus-reserved.
    const admission = assessCargoDiskAdmission({ ...roomy, reservedBytes: 298 * GIB });
    expect(admission.freeGiB).toBe(300);
    expect(admission.reservedGiB).toBe(298);
  });

  it('never lets a nonsense reservation invert the measurement', () => {
    const admission = assessCargoDiskAdmission({ ...roomy, reservedBytes: 5_000 * GIB });
    expect(admission.effectiveFreeBytes).toBe(0);
    expect(admission.allowed).toBe(false);
  });

  it('ignores a negative or non-finite reservedBytes rather than adding space', () => {
    for (const bad of [-100 * GIB, Number.NaN, Number.POSITIVE_INFINITY]) {
      const admission = assessCargoDiskAdmission({ ...roomy, reservedBytes: bad });
      expect(admission.reservedBytes).toBe(0);
      expect(admission.allowed).toBe(true);
    }
  });
});

/** Read this process's own /proc start time, the way the reader does. */
function currentStart(pid: number): string {
  try {
    const stat = execFileSync('cat', [`/proc/${pid}/stat`], {
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    const rest = stat.slice(stat.lastIndexOf(') ') + 2);
    return rest.split(/\s+/)[19] || '';
  } catch {
    return '';
  }
}
