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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  it('agrees with the shell writer on the ledger key for the same path', () => {
    // The load-bearing cross-language property. Executes BOTH derivations rather
    // than asserting a hardcoded string, so a change to either side is caught.
    const path = scratch();
    const fromShell = execFileSync(
      'bash',
      ['-c', `source ${JSON.stringify(SHELL_LIB)} && papercusp_mount_key ${JSON.stringify(path)}`],
      { encoding: 'utf8' },
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
    const stat = execFileSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf8' });
    const rest = stat.slice(stat.lastIndexOf(') ') + 2);
    return rest.split(/\s+/)[19] || '';
  } catch {
    return '';
  }
}
