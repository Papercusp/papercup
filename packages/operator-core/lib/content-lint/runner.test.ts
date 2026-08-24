import { describe, expect, it } from 'vitest';
import { childExitCode, RESULT_BANNER } from '../../../../scripts/content-lint-runner.mjs';

describe('content-lint boundary launcher', () => {
  it('maps a loader/startup exit 1 with no probe result to MISUSE', () => {
    expect(
      childExitCode({
        status: 1,
        stdout: '',
        stderr: 'Error: listen EPERM: operation not permitted /tmp/tsx.pipe\n',
      }),
    ).toBe(2);
  });

  it('preserves FLAGGED only when the human probe banner is present', () => {
    expect(
      childExitCode({
        status: 1,
        stdout: `${RESULT_BANNER} packages/operator-core/lib/probe.ts\n  ✗ sql FLAGGED\n`,
        stderr: '',
      }),
    ).toBe(1);
  });

  it('preserves a reported JSON result and ordinary help success', () => {
    expect(
      childExitCode({
        status: 2,
        stdout: JSON.stringify({ verdicts: [], ranCount: 0, exitCode: 2 }),
        stderr: '',
      }),
    ).toBe(2);
    expect(childExitCode({ status: 0, stdout: 'usage\n', stderr: '' })).toBe(0);
  });

  it('treats a signalled child as MISUSE even if it emitted no result', () => {
    expect(childExitCode({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' })).toBe(2);
  });

  it('does not treat a runtime stack trace as a probe result', () => {
    expect(childExitCode({ status: 1, stdout: '', stderr: 'TypeError: startup failed\n' })).toBe(2);
  });
});
