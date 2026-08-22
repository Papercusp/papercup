/** Regression coverage for EI-20041922041407287.
 *
 * Cargo already reports the distinction between a compiler diagnostic and an
 * externally killed rustc process. The native reporter must preserve it as a
 * machine-readable result instead of collapsing both cases into "error".
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  assessCargoDiskAdmission,
  CARGO_CACHE_TAG,
  CARGO_DISK_REFUSAL_EXIT_CODE,
  cargoDiskPolicyFromEnv,
  classifyCargoRun,
  detectCargoTermination,
  ensureCargoCacheTag,
  formatCargoDiskRefusal,
  formatCargoResultLine,
  parseCargoTestResultLines,
  stripCargoTerminalControlSequences,
// @ts-ignore -- runtime reporter module intentionally tested from TypeScript.
} from '../../../../scripts/lib/cargo-result.mjs';

const GIB = 1024 ** 3;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPORTER_SOURCE = readFileSync(resolve(TEST_DIR, '../../../../scripts/report-cargo-tests.mjs'), 'utf8');

const SIGTERM_CARGO_OUTPUT = `
error: could not compile \`papercusp-desktop\` (bin "papercusp-desktop" test)

Caused by:
  process didn't exit successfully: \`/usr/bin/rustc --crate-name papercusp_desktop\` (signal: 15, SIGTERM: termination signal)
`;

const SIGKILL_CARGO_OUTPUT = `
error: could not compile \`papercusp-desktop\` (bin "papercusp-desktop" test)
Caused by:
  process didn't exit successfully: \`/usr/bin/rustc --crate-name papercusp_desktop\` (signal: 9, SIGKILL: kill)
`;

describe('cargo result classification (EI-20041922041407287)', () => {
  it('recognizes SIGTERM as an externally killed compiler, not a compile failure', () => {
    const result = classifyCargoRun({ code: 101, output: SIGTERM_CARGO_OUTPUT, resultCount: 0 });

    expect(result).toEqual({
      status: 'killed',
      termination: { signal: 15, signalName: 'SIGTERM' },
    });
    expect(formatCargoResultLine(result)).toBe(
      'CARGO_RESULT status=killed signal=15 signalName=SIGTERM cause=killed-by-signal',
    );
  });

  it('recognizes SIGKILL and preserves the signal number', () => {
    expect(detectCargoTermination(SIGKILL_CARGO_OUTPUT)).toEqual({ signal: 9, signalName: 'SIGKILL' });
  });

  it('keeps a real rustc diagnostic in the failed bucket', () => {
    const output = 'error[E0308]: mismatched types\nerror: could not compile `papercusp-desktop`';

    expect(classifyCargoRun({ code: 101, output, resultCount: 0 })).toEqual({
      status: 'failed',
      termination: null,
    });
  });

  it('does not classify a passing test run as killed even if its output mentions SIGTERM', () => {
    expect(
      classifyCargoRun({
        code: 0,
        output: 'test result: ok. 351 passed; 0 failed\n(note: SIGTERM is handled by the harness)',
        resultCount: 351,
      }),
    ).toEqual({ status: 'passed', termination: null });
  });
});

describe('cargo test result parsing', () => {
  it('keeps result counts and names aligned when terminal control output prefixes lines', () => {
    const output = [
      'running 3 tests',
      'test native_console::tests::plain ... ok',
      '\u001b]0;cargo test\u0007\u001b[2Ktest native_console::tests::oneliner_keeps_quoted_greeting_parseable ... ok',
      '\u001b[32mtest native_console::tests::ignored_case ... ignored\u001b[0m',
      'test result: ok. 2 passed; 0 failed; 1 ignored',
    ].join('\n');

    expect(stripCargoTerminalControlSequences(output)).not.toContain('\u001b');
    const results = parseCargoTestResultLines(output) as Array<{
      name: string;
      outcome: 'ok' | 'FAILED' | 'ignored';
    }>;

    expect(results).toHaveLength(3);
    expect(results.map(({ name }) => name)).toEqual([
      'native_console::tests::plain',
      'native_console::tests::oneliner_keeps_quoted_greeting_parseable',
      'native_console::tests::ignored_case',
    ]);
    expect(results.map(({ outcome }) => outcome)).toEqual(['ok', 'ok', 'ignored']);
    expect(REPORTER_SOURCE).toContain('const results = parseCargoTestResultLines(combined);');
  });
});

describe('cargo disk admission (EI-21047688909295463)', () => {
  it('refuses a new native suite below the standing 10% free-space floor', () => {
    const result = assessCargoDiskAdmission({
      totalBytes: 2_000 * GIB,
      freeBytes: 80 * GIB,
    });

    expect(result).toMatchObject({
      allowed: false,
      status: 'blocked',
      reasons: ['free-percent'],
      usedPct: 96,
      freeGiB: 80,
    });
    expect(formatCargoDiskRefusal(result)).toContain('REFUSED before spawning Cargo');
    expect(CARGO_DISK_REFUSAL_EXIT_CODE).toBe(75);
    expect(
      formatCargoResultLine({
        status: 'error',
        cause: 'low-disk-admission-refused',
        disk: { usedPct: result.usedPct!, freeGiB: result.freeGiB! },
      }),
    ).toBe('CARGO_RESULT status=error cause=low-disk-admission-refused diskUsedPct=96 diskFreeGiB=80');
  });

  it('allows a suite above both the percentage and absolute floors', () => {
    expect(
      assessCargoDiskAdmission({ totalBytes: 2_000 * GIB, freeBytes: 240 * GIB }),
    ).toMatchObject({ allowed: true, status: 'ok', reasons: [], usedPct: 88, freeGiB: 240 });
  });

  it('reuses the disk alarm tuning keys and their positive-number fallback', () => {
    expect(
      cargoDiskPolicyFromEnv({
        PAPERCUSP_DISK_ALARM_FREE_PCT: '12.5',
        PAPERCUSP_DISK_ALARM_FREE_GB: '8',
      }),
    ).toEqual({ freePctMin: 0.125, freeBytesMin: 8 * GIB });
    expect(
      cargoDiskPolicyFromEnv({ PAPERCUSP_DISK_ALARM_FREE_PCT: '0', PAPERCUSP_DISK_ALARM_FREE_GB: '-1' }),
    ).toEqual({ freePctMin: 0.1, freeBytesMin: 5 * GIB });
  });

  it('fails open when statfs values are unreadable instead of manufacturing a disk verdict', () => {
    expect(
      assessCargoDiskAdmission({ totalBytes: Number.NaN, freeBytes: Number.NaN }),
    ).toMatchObject({ allowed: true, status: 'unknown', reasons: ['invalid-statfs'], usedPct: null, freeGiB: null });
  });

  it('wires the disk decision and refusal ahead of the executable Cargo spawn', () => {
    const statfsAt = REPORTER_SOURCE.indexOf('statfsSync(manifestAbs)');
    const refusalAt = REPORTER_SOURCE.indexOf('if (!diskAdmission.allowed)');
    const spawnAt = REPORTER_SOURCE.indexOf('spawn(resolveCargoBin()');

    expect(statfsAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(statfsAt);
    expect(spawnAt).toBeGreaterThan(refusalAt);
    expect(REPORTER_SOURCE).toContain("cause: 'low-disk-admission-refused'");
    expect(REPORTER_SOURCE).toContain('code: CARGO_DISK_REFUSAL_EXIT_CODE');
  });
});

describe('isolated Cargo target cleanup (EI-21048920599909117)', () => {
  it('initializes the canonical tag so Cargo clean accepts a producer-created target', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-cache-tag-'));
    const targetDir = resolve(root, 'isolated-target');
    const manifestPath = resolve(TEST_DIR, '../../../../papercusp-desktop/src-tauri/Cargo.toml');

    try {
      ensureCargoCacheTag(targetDir);
      writeFileSync(resolve(targetDir, 'sentinel'), 'safe-to-remove\n');
      expect(readFileSync(resolve(targetDir, 'CACHEDIR.TAG'), 'utf8')).toBe(CARGO_CACHE_TAG);

      const clean = spawnSync(
        'cargo',
        ['clean', '--manifest-path', manifestPath, '--target-dir', targetDir],
        { encoding: 'utf8' },
      );

      expect(clean.status, clean.stderr || clean.stdout).toBe(0);
      expect(clean.stderr).not.toContain('invalid signature in `CACHEDIR.TAG` file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs tag initialization after disk admission and before the Cargo child starts', () => {
    const admissionAt = REPORTER_SOURCE.indexOf('if (!diskAdmission.allowed)');
    const tagAt = REPORTER_SOURCE.indexOf('ensureCargoCacheTag(resolve(REPO_ROOT, configuredTargetDir))');
    const spawnAt = REPORTER_SOURCE.indexOf('spawn(resolveCargoBin()');

    expect(admissionAt).toBeGreaterThan(-1);
    expect(tagAt).toBeGreaterThan(admissionAt);
    expect(spawnAt).toBeGreaterThan(tagAt);
  });
});
