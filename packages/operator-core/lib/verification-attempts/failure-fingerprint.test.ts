/**
 * WI-10004032 — the attempt fingerprint must read what harnesses actually print.
 *
 * The loop gate (loop-gate.ts) compares fingerprints across a work item's slow attempts:
 * two failures with DIFFERENT fingerprints, or three with the SAME one, trip it. That only
 * works if the same failure fingerprints the same on every run. The fingerprinter used to
 * look for a `VERIFY_RESULT` line that no harness emits, so every verification-harness
 * adopter fell through to "last error-shaped line" — the HARNESS_RESULT line itself, whose
 * run id and evidence path change per run. Two runs of one failure never compared equal.
 *
 * The strongest check here runs the REAL shell half of the contract (bin/vh.sh) twice and
 * fingerprints its real output, so a format change on either side fails this file instead
 * of silently degrading the gate. The calibration cases keep the "distinct" half honest:
 * a fingerprinter that collapsed everything to one key would pass the equality checks.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSummaryLine, type HarnessRunResult } from '@papercusp/verification-harness';

// The subject is overridable so falsifiability is proved against a frozen COPY (historical
// mode of scripts/mutation-probe.sh), never by mutating the shared tree.
const { failureFingerprint } = (await import(
  process.env.FAILURE_FINGERPRINT_SUBJECT ?? './failure-fingerprint'
)) as typeof import('./failure-fingerprint');

// lib/verification-attempts → lib → operator-core → packages → <repo root>
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const VH = path.join(ROOT, 'libs/generic/verification-harness/bin/vh.sh');

/** Run a two-phase shell harness through vh.sh; `failWith` picks the failing phase/reason. */
function runVh(failWith: { phase: 'build' | 'ship'; reason: string }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'fp-vh-'));
  const file = path.join(root, 'h.sh');
  writeFileSync(
    file,
    `set -u
source ${JSON.stringify(VH)}
vh_phase build ""
vh_phase ship build
phase_build() { vh_step compile; ${failWith.phase === 'build' ? `vh_fail ${failWith.reason} "boom"; return 1` : ':'}; }
phase_ship() { vh_step upload; ${failWith.phase === 'ship' ? `vh_fail ${failWith.reason} "boom"; return 1` : ':'}; }
vh_init fp-drill ${JSON.stringify(path.join(root, 'ev'))} || exit 2
vh_run build phase_build
vh_run ship phase_ship
vh_finish
`,
  );
  try {
    return execFileSync('bash', [file], { encoding: 'utf8' });
  } catch (err) {
    return (err as { stdout: string }).stdout;
  }
}

describe('failureFingerprint reads the verification-harness contract line', () => {
  it('two real vh.sh runs of the same failure get the same structured fingerprint', () => {
    const a = runVh({ phase: 'ship', reason: 'upload-timeout' });
    const b = runVh({ phase: 'ship', reason: 'upload-timeout' });
    // Precondition: the runs really differ in their volatile tokens (run id, evidence dir).
    const runIdOf = (out: string) => /HARNESS_RESULT .*\brun=(\S+)/.exec(out)?.[1];
    expect(runIdOf(a)).toBeTruthy();
    expect(a).not.toBe(b);

    const fa = failureFingerprint({ exitCode: 1, logTail: a });
    const fb = failureFingerprint({ exitCode: 1, logTail: b });
    expect(fa.source).toBe('structured');
    expect(fa.structured).toEqual({ phase: 'ship', step: 'upload', reasonCode: 'upload-timeout' });
    expect(fa.fingerprint).toBe(fb.fingerprint);
  });

  it('calibration: a different phase or reason is a different fingerprint', () => {
    const ship = failureFingerprint({ exitCode: 1, logTail: runVh({ phase: 'ship', reason: 'upload-timeout' }) });
    const build = failureFingerprint({ exitCode: 1, logTail: runVh({ phase: 'build', reason: 'upload-timeout' }) });
    const reason = failureFingerprint({ exitCode: 1, logTail: runVh({ phase: 'ship', reason: 'auth-refused' }) });
    expect(new Set([ship.fingerprint, build.fingerprint, reason.fingerprint]).size).toBe(3);
  });

  it('reads the TS runner line too, and ignores a passing verdict', () => {
    const result = (runId: string, verdict: 'fail' | 'pass'): HarnessRunResult =>
      ({
        schemaVersion: 1,
        harness: 'ts-drill',
        runId,
        verdict,
        evidenceDir: `/home/x/ev/${runId}`,
        firstFailure: verdict === 'fail' ? { phase: 'leg-a', step: 'clone', reasonCode: 'clone-timeout' } : null,
        phases: [],
      }) as unknown as HarnessRunResult;
    const one = failureFingerprint({ exitCode: 1, logTail: formatSummaryLine(result('20260930T000001Z-11', 'fail')) });
    const two = failureFingerprint({ exitCode: 1, logTail: formatSummaryLine(result('20260930T010203Z-99', 'fail')) });
    expect(one.source).toBe('structured');
    expect(one.fingerprint).toBe(two.fingerprint);

    // A pass line is the run's verdict and names no failure: the fingerprint comes from the log.
    const passed = failureFingerprint({
      exitCode: 1,
      logTail: `Error: upload refused\n${formatSummaryLine(result('20260930T000001Z-11', 'pass'))}`,
    });
    expect(passed.source).toBe('log');
    expect(passed.label).toMatch(/upload refused/);
  });
});

describe('failureFingerprint reads the hive-git drill summary where the drill prints it', () => {
  const drillLine = (runDir: string) =>
    `  ✗ physical E/G adapter failed (exit 1) in phase D (phase_d): observe did not converge — evidence kept in ${runDir}`;

  it('the embedded drill summary fingerprints the same across runs with different evidence dirs', () => {
    const a = failureFingerprint({
      exitCode: 1,
      logTail: drillLine('/home/u/.papercusp-drill-physical-runs/20260929T233636Z-152216-rc1'),
    });
    const b = failureFingerprint({
      exitCode: 1,
      logTail: drillLine('/home/u/.papercusp-drill-physical-runs/20260930T011502Z-7781-rc1'),
    });
    expect(a.source).toBe('log');
    expect(a.label).toBe('phase D (phase_d): observe did not converge');
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('calibration: a different drill phase is a different fingerprint; the bare summary line still reads', () => {
    const d = failureFingerprint({ exitCode: 1, logTail: drillLine('/r/1') });
    const e = failureFingerprint({
      exitCode: 1,
      logTail: '  ✗ physical E/G adapter failed (exit 1) in phase E (phase_e): observe did not converge — evidence kept in /r/1',
    });
    expect(d.fingerprint).not.toBe(e.fingerprint);
    const bare = failureFingerprint({ exitCode: 1, logTail: 'phase D (phase_d): observe did not converge' });
    expect(bare.fingerprint).toBe(d.fingerprint);
  });
});
