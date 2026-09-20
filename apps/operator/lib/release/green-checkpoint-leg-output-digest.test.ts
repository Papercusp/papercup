import { describe, expect, it } from 'vitest';

import { summarizeLegOutput } from './green-checkpoint';

/**
 * WI-10002075 — a failing LINT leg must persist the FILES it named, not the advice.
 *
 * The defect this guards: `outputTail` was `(stderr || stdout).slice(-300)`. A per-file
 * tsc BASELINE gate always ENDS with a fixed generic trailer, so the blind tail kept the
 * words "the named file(s)" and discarded every name. Three `lint:tsc*` legs then held
 * the frozen repair queue red for a day with no artifact naming a single offending file.
 *
 * The fixture is built from that real output shape. `LEGACY_WINDOW` reproduces the old
 * behaviour in-test as a permanent CONTROL, so this suite cannot pass vacuously: if the
 * trailer ever shrinks below the window the calibration assertion fails loudly rather
 * than letting the real assertions succeed for the wrong reason.
 */
const LEGACY_WINDOW = 300;

/** The invariant trailer the baseline gate prints AFTER every named file. */
const TRAILER = [
  "      (this file's baseline is 0 — every error above is new.)",
  '   Fix the new errors in the named file(s). The baseline only ratchets DOWN (raising a file',
  // Deliberately NOT a real checkout path: the gate prints an absolute one here, but a
  // hardcoded home path in shipped source reds the identity-lint leg (EI-18759401203875869).
  // Only this trailer's LENGTH and trailing position matter to the calibration below.
  `   is a hand-edit of ${'<checkout>'}/papercusp-checkpoint/packages/`,
  '   operator-core/.tsc-baseline.json with justification).',
].join('\n');

const REGRESSED_FILE = 'packages/operator-core/lib/agent-tools/locks/check_command.test.ts';

const BASELINE_GATE_OUTPUT = [
  'lint:tsc: regressed',
  `   ${REGRESSED_FILE}: 12 > 11 (+1)`,
  "     L257: checkM.mockResolvedValue({ decision: 'allow' })",
  '   packages/operator-core/lib/session-port/render.ts: 3 > 0 (+3)',
  "     error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  'LINT_TSC_RESULT label=operator-core exit=1 status=regressed',
  TRAILER,
].join('\n');

describe('summarizeLegOutput (WI-10002075)', () => {
  it('CALIBRATION: the legacy blind tail really did lose the file names', () => {
    // Not decoration — this is what proves the fixture still exercises the bug.
    const legacy = BASELINE_GATE_OUTPUT.slice(-LEGACY_WINDOW);
    expect(legacy).toContain('the named file(s)');
    expect(legacy).not.toContain(REGRESSED_FILE);
    expect(legacy).not.toContain('error TS2345');
  });

  it('preserves the per-file regression rows a fixer actually needs', () => {
    const summary = summarizeLegOutput(BASELINE_GATE_OUTPUT);
    expect(summary).toContain(REGRESSED_FILE);
    expect(summary).toContain('12 > 11');
    expect(summary).toContain('packages/operator-core/lib/session-port/render.ts');
    expect(summary).toContain('error TS2345');
    expect(summary).toContain('LINT_TSC_RESULT');
  });

  it('leads with the digest so a FRONT truncation still keeps the names', () => {
    // The joined-legs consumer slices from the front; the names must survive that too.
    const summary = summarizeLegOutput(BASELINE_GATE_OUTPUT);
    expect(summary.indexOf(REGRESSED_FILE)).toBeLessThan(summary.indexOf('--- tail ---'));
    expect(summary.slice(0, LEGACY_WINDOW)).toContain(REGRESSED_FILE);
  });

  it('still keeps the raw tail underneath, where a wedge or crash surfaces', () => {
    const summary = summarizeLegOutput(BASELINE_GATE_OUTPUT);
    expect(summary).toContain('--- tail ---');
  });

  it('falls back to the whole budget when there is no recognizable diagnostic', () => {
    // A wedge/crash prints no per-file row and no TS code: the tail is the only evidence.
    const wedge = `${'noise\n'.repeat(400)}Killed after 3600s waiting for the runner`;
    const summary = summarizeLegOutput(wedge);
    expect(summary).not.toContain('--- tail ---');
    expect(summary).toContain('Killed after 3600s');
  });

  it('respects its budget', () => {
    const huge = Array.from(
      { length: 500 },
      (_, i) => `   packages/operator-core/lib/f${i}.ts: ${i + 2} > ${i} (+2)`,
    ).join('\n');
    expect(summarizeLegOutput(huge, 1200).length).toBeLessThanOrEqual(1200);
  });

  it('drops npm boilerplate that used to crowd out the real diagnostic', () => {
    const withNpmNoise = [
      'npm error workspace @papercusp/web@0.0.1',
      'npm error command failed',
      `   ${REGRESSED_FILE}: 12 > 11 (+1)`,
    ].join('\n');
    const summary = summarizeLegOutput(withNpmNoise);
    expect(summary).toContain(REGRESSED_FILE);
    expect(summary).not.toContain('npm error');
  });
});
