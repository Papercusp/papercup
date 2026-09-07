/**
 * EI-21852949719867845 — `exit_code` describing a trailing `echo`'s status
 * (always 0) instead of the real command's, when the log itself captured the
 * real one, must never read as a silent green.
 */

import { describe, it, expect } from 'vitest';
import { capturedExitMismatch } from './captured-exit-verdict';

describe('capturedExitMismatch (EI-21852949719867845 / EI-22335721041071018)', () => {
  it('flags the exact repro: `false; echo "EXIT=$?"` reports exit_code 0 but the log captured 1', () => {
    const verdict = capturedExitMismatch({
      status: 'completed',
      exitCode: 0,
      log: 'EXIT=1\n',
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.headline).toContain('exit_code (0)');
    expect(verdict?.headline).toContain('(1)');
    expect(verdict?.advice).toContain('EXIT=1');
    expect(verdict?.advice).toContain('exit_code');
  });

  it.each(['D_EXIT=1', 'AFFECTED_EXIT=1'])('ignores namespaced per-step marker `%s`', (marker) => {
    expect(
      capturedExitMismatch({
        status: 'completed',
        exitCode: 0,
        log: `33 failing\n12 files\n${marker}\n`,
      }),
    ).toBeNull();
  });

  it('is silent when the captured marker AGREES with exit_code', () => {
    expect(
      capturedExitMismatch({
        status: 'completed',
        exitCode: 1,
        log: 'EXIT=1\n',
      }),
    ).toBeNull();
  });

  it('is silent (control) when the log carries no captured-exit marker at all', () => {
    expect(
      capturedExitMismatch({
        status: 'completed',
        exitCode: 0,
        log: 'ordinary test output with no marker line\nall good\n',
      }),
    ).toBeNull();
  });

  it('is silent while the job is still running, even with a mismatching marker present', () => {
    expect(
      capturedExitMismatch({
        status: 'running',
        exitCode: null,
        log: 'EXIT=1\n',
      }),
    ).toBeNull();
  });

  it('is silent when exit_code is unknown (null)', () => {
    expect(
      capturedExitMismatch({
        status: 'completed',
        exitCode: null,
        log: 'EXIT=1\n',
      }),
    ).toBeNull();
  });

  it('does not false-alarm on an unrelated line merely containing the substring EXIT', () => {
    // Not a whole-line `KEY=NUMBER` marker — must not be mistaken for one.
    expect(
      capturedExitMismatch({
        status: 'completed',
        exitCode: 0,
        log: 'process will EXIT=soon when done\n',
      }),
    ).toBeNull();
  });

  it('uses the LAST captured marker when a log contains more than one (a retried command)', () => {
    const verdict = capturedExitMismatch({
      status: 'completed',
      exitCode: 0,
      log: 'EXIT=1\nretrying...\nEXIT=0\n',
    });
    // Last marker agrees with exit_code 0 -> no mismatch to report.
    expect(verdict).toBeNull();
  });

  it('ignores an unprefixed marker that is mid-log rather than near the tail', () => {
    expect(
      capturedExitMismatch({
        status: 'completed',
        exitCode: 0,
        log: ['EXIT=1', 'step output 1', 'step output 2', 'step output 3', 'step output 4', 'step output 5'].join(
          '\n',
        ),
      }),
    ).toBeNull();
  });

  it('still detects an unprefixed mismatch within the final five non-empty lines', () => {
    const verdict = capturedExitMismatch({
      status: 'completed',
      exitCode: 0,
      log: ['test output', 'EXIT=1', 'cleanup output', '', 'final status'].join('\n'),
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.headline).toContain('(1)');
  });

  it('ignores leading/trailing whitespace around a captured marker line', () => {
    const verdict = capturedExitMismatch({
      status: 'completed',
      exitCode: 0,
      log: '  EXIT=1  \n',
    });
    expect(verdict).not.toBeNull();
  });
});
