/** Regression coverage for EI-20041922041407287.
 *
 * Cargo already reports the distinction between a compiler diagnostic and an
 * externally killed rustc process. The native reporter must preserve it as a
 * machine-readable result instead of collapsing both cases into "error".
 */
import { describe, expect, it } from 'vitest';

import {
  classifyCargoRun,
  detectCargoTermination,
  formatCargoResultLine,
} from '../../../../scripts/lib/cargo-result.mjs';

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
