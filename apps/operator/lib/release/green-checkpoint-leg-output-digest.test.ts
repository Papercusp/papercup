import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * WI-10002081 — the follow-up, and the more instructive half. The first version of both
 * the pattern AND this fixture spelled the per-file row `file.ts: 12 > 11 (+1)`, which the
 * producer NEVER emits: `formatRow` renders `12 → 11` with U+2192. The suite passed 7/7
 * against a broken matcher because the fixture was built from the same invention as the
 * code. A fixture the author made up can only ever confirm the author's assumption, so the
 * rendering below is now PINNED to the producer by `renderProducerRow` — if the real
 * template changes, the pin fails here rather than silently emptying the digest in the gate.
 */
const LEGACY_WINDOW = 300;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BASELINE_GATE_SRC = resolve(REPO_ROOT, 'scripts/lib/tsc-baseline-gate.mjs');

/**
 * Render a per-file row the way the PRODUCER does, read from the producer's own source.
 *
 * Deliberately not a copy of the template: it extracts `formatRow`'s body and asserts the
 * separator it actually uses, so this fixture cannot drift away from the gate it models.
 */
function producerSeparator(): string {
  const src = readFileSync(BASELINE_GATE_SRC, 'utf8');
  const fn = /function formatRow\(r\)\s*\{([\s\S]*?)\n\}/.exec(src);
  // A missing/renamed producer must FAIL, never skip: a vacuous pass here is exactly the
  // false-clean this whole file exists to prevent.
  expect(fn, `formatRow not found in ${BASELINE_GATE_SRC} — update this pin`).not.toBeNull();
  const body = fn![1];
  const sep = /\$\{r\.baseline\}\s*(\S+)\s*\$\{r\.current\}/.exec(body);
  expect(sep, `could not read formatRow's separator from: ${body.trim()}`).not.toBeNull();
  return sep![1];
}

const SEP = producerSeparator();

/** Exactly `formatRow`'s shape: 3-space indent, `base SEP current`, two spaces, signed delta. */
const renderProducerRow = (file: string, baseline: number, current: number): string =>
  `   ${file}: ${baseline} ${SEP} ${current}  (${current - baseline > 0 ? '+' : ''}${current - baseline})`;

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
const SECOND_FILE = 'packages/operator-core/lib/session-port/render.ts';

const BASELINE_GATE_OUTPUT = [
  'lint:tsc: regressed',
  renderProducerRow(REGRESSED_FILE, 11, 12),
  "     L257: checkM.mockResolvedValue({ decision: 'allow' })",
  renderProducerRow(SECOND_FILE, 0, 3),
  "     error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  'LINT_TSC_RESULT label=operator-core exit=1 status=regressed',
  TRAILER,
].join('\n');

describe('summarizeLegOutput (WI-10002075, WI-10002081)', () => {
  it('PIN: the producer really does separate the counts with U+2192, not ASCII `>`', () => {
    // The assumption that broke WI-10002075's matcher. Pinned so it cannot silently change.
    expect(SEP).toBe('→');
    expect(renderProducerRow('a/b.ts', 0, 1)).toBe('   a/b.ts: 0 → 1  (+1)');
  });

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
    expect(summary).toContain(`11 ${SEP} 12`);
    expect(summary).toContain(SECOND_FILE);
    expect(summary).toContain('error TS2345');
    expect(summary).toContain('LINT_TSC_RESULT');
  });

  it('accepts the ASCII spellings too, so a re-render cannot drop the row again', () => {
    for (const sep of ['→', '->', '>']) {
      const row = `   packages/operator-core/lib/x.ts: 0 ${sep} 4  (+4)`;
      expect(summarizeLegOutput(`${row}\n${TRAILER}`), `separator ${sep}`).toContain(
        'packages/operator-core/lib/x.ts',
      );
    }
    // NEGATIVE CONTROL: a line of the same shape with no count pair is not a regression row,
    // so a pattern loose enough to match anything would fail here.
    const notARow = `   packages/operator-core/lib/x.ts: rebuilt in 4s\n${'filler\n'.repeat(200)}`;
    expect(summarizeLegOutput(notARow)).not.toContain('--- tail ---');
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
    const huge = Array.from({ length: 500 }, (_, i) =>
      renderProducerRow(`packages/operator-core/lib/f${i}.ts`, i, i + 2),
    ).join('\n');
    expect(summarizeLegOutput(huge, 1200).length).toBeLessThanOrEqual(1200);
  });

  it('drops npm boilerplate that used to crowd out the real diagnostic', () => {
    const withNpmNoise = [
      'npm error workspace @papercusp/web@0.0.1',
      'npm error command failed',
      renderProducerRow(REGRESSED_FILE, 11, 12),
    ].join('\n');
    const summary = summarizeLegOutput(withNpmNoise);
    expect(summary).toContain(REGRESSED_FILE);
    expect(summary).not.toContain('npm error');
  });
});
