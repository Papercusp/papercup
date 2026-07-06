/**
 * cargo-test-action.test.ts — WI-3206 (production-test-readiness-2026-07-06 P-009):
 * wiring the Rust/cargo native suite into a routine so it records framework='cargo'
 * rows into harness_shared.test_runs on the same cadence as vitest/playwright.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { shouldSkipForHive, runCargoTestReporter } from './cargo-test-action';

describe('shouldSkipForHive', () => {
  it('runs for the operator-home installSlug', () => {
    expect(shouldSkipForHive('papercusp', 'papercusp')).toEqual({ skip: false });
  });

  it('runs for a blank/undefined installSlug (manual/legacy fire convention)', () => {
    expect(shouldSkipForHive(null, 'papercusp')).toEqual({ skip: false });
    expect(shouldSkipForHive(undefined, 'papercusp')).toEqual({ skip: false });
    expect(shouldSkipForHive('', 'papercusp')).toEqual({ skip: false });
  });

  it('skips a per-hive coding repo — the desktop shell only exists in operator-home', () => {
    const r = shouldSkipForHive('some-other-hive', 'papercusp');
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toContain('some-other-hive');
  });
});

describe('runCargoTestReporter', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('spawns node against scripts/report-cargo-tests.mjs under root with --manifest-path, and surfaces a clean exit', async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'cargo-test-action-'));
    mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, 'scripts/report-cargo-tests.mjs'),
      `
      const manifestIdx = process.argv.indexOf('--manifest-path');
      console.log('manifest=' + process.argv[manifestIdx + 1]);
      process.exit(0);
      `,
    );
    const r = await runCargoTestReporter(tmpRoot, 'fake/Cargo.toml', 10_000);
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain('manifest=fake/Cargo.toml');
  });

  it('surfaces a non-zero exit code (a real cargo test failure) without throwing', async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'cargo-test-action-'));
    mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, 'scripts/report-cargo-tests.mjs'),
      `process.stderr.write('boom'); process.exit(1);`,
    );
    const r = await runCargoTestReporter(tmpRoot, 'fake/Cargo.toml', 10_000);
    expect(r.code).toBe(1);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toContain('boom');
  });

  it('kills a wedged run at the timeout and reports timedOut', async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'cargo-test-action-'));
    mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, 'scripts/report-cargo-tests.mjs'),
      `setInterval(() => {}, 1000);`, // never exits on its own
    );
    const r = await runCargoTestReporter(tmpRoot, 'fake/Cargo.toml', 200);
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  }, 15_000);
});
