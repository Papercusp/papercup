/**
 * P-013 recurrence guard — falsifiability proof for `scripts/check-no-capacity-maxima.mjs`.
 *
 * The guard currently measures ZERO sites in the real tree, which is the correct
 * post-capless state but also the state in which a broken guard is indistinguishable
 * from a working one. So this file proves the guard can actually FAIL.
 *
 * It does that WITHOUT touching the shared tree. The repo's mutation-probe rules
 * forbid the obvious approach (mutate a real file, run, restore): git-sync sweeps the
 * whole tree on a schedule, so a probe legitimately holding a file mutated can have
 * its mutant COMMITTED even when nothing goes wrong and no handler fails. The guard
 * therefore takes `--root`, and every case below builds a throwaway tree in the OS
 * temp dir — tier 2 of the repo's falsifiability table, zero window, no lock, no trap.
 *
 * Cases 1-3 are positive controls (the guard MUST fail). Case 4 is the calibration
 * case (it MUST pass) — without it, a guard that failed on literally everything would
 * satisfy the positive controls and look rigorous. Case 5 pins the three false-positive
 * classes that the first measured run actually produced.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const GUARD = resolve(__dirname, '../../../../scripts/check-no-capacity-maxima.mjs');
const SCAN_REL = 'packages/operator-core/lib/inference-gateway';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Build a throwaway tree containing one source file, and run the guard over it. */
function runGuard(source: string): { code: number; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'capacity-guard-'));
  roots.push(root);
  const dir = join(root, SCAN_REL);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'subject.ts'), source, 'utf8');
  try {
    // `timeout` + `killSignal` are REQUIRED here, not defensive padding (WI-41180): a
    // synchronous spawn blocks the worker's event loop, so vitest cannot time it out, and
    // the pure lane shares ONE fork across ~2,740 files — an unbounded hang here wedges
    // every one of them until the batch watchdog kills the task 45 minutes later.
    const output = execFileSync('node', [GUARD, '--root', root], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('check-no-capacity-maxima is falsifiable', () => {
  it('CATCHES a hard-coded productive-capacity maximum', () => {
    // The exact regression the capless plan exists to prevent coming back.
    const { code, output } = runGuard('export const maxConcurrent = 4;\n');
    expect(code).toBe(1);
    expect(output).toContain('undeclared productive-capacity maximum/maxima');
    expect(output).toContain('no @capacity-disposition marker');
  });

  it('CATCHES a cap declared with a non-binding disposition', () => {
    // 'observed' describes a measurement. If it could license a cap, the marker would
    // be a rubber stamp — a developer would reach for the vaguest word that passes.
    const { code, output } = runGuard(
      '// @capacity-disposition: observed — we measured it at 4\nexport const maxConcurrent = 4;\n',
    );
    expect(code).toBe(1);
    expect(output).toContain("disposition 'observed' may not bind capacity");
  });

  it('CATCHES a binding disposition declared with no reason', () => {
    const { code, output } = runGuard(
      '// @capacity-disposition: physical-contract\nexport const maxConcurrent = 4;\n',
    );
    expect(code).toBe(1);
    expect(output).toContain('declared with no reason');
  });

  it('ACCEPTS a properly declared external physical contract (calibration)', () => {
    // Without this case, a guard that rejected everything would pass all three
    // positive controls above and still be worthless.
    const { code, output } = runGuard(
      '// @capacity-disposition: physical-contract — provider 429 budget, not our choice\nexport const maxConcurrent = 4;\n',
    );
    expect(code).toBe(0);
    expect(output).toContain('no undeclared productive-capacity maxima');
  });

  it('IGNORES the three false-positive classes the first measured run produced', () => {
    // Each line below tripped the guard's first draft. A guard this noisy trains
    // people to baseline everything, which is how a guard stops guarding.
    const source = [
      '/**',
      ' * Historical note: production used { maxConcurrent: 3, rpm: 45 } before P-007.',
      ' */',
      "export const census = { currentValue: '{ anthropic: { maxConcurrent: 3 } }' };",
      'export function readQueue(s: { maxQueued?: number }) {',
      "  return typeof s.maxQueued === 'number' ? s.maxQueued : 0;",
      '}',
      'export function validate(input: { maxConcurrent?: number }) {',
      '  return input.maxConcurrent !== undefined && input.maxConcurrent <= 0;',
      '}',
      '',
    ].join('\n');
    const { code, output } = runGuard(source);
    expect(code, `guard fired on prose/strings/ternaries:\n${output}`).toBe(0);
  });

  it('still catches a real cap hiding among the false-positive shapes', () => {
    // Proves the noise-suppression above narrowed the guard without blinding it.
    const source = [
      '/**',
      ' * Historical note: production used { maxConcurrent: 3, rpm: 45 } before P-007.',
      ' */',
      "export const census = { currentValue: '{ anthropic: { maxConcurrent: 3 } }' };",
      'export const admission = { maxQueued: 128 };',
      '',
    ].join('\n');
    const { code, output } = runGuard(source);
    expect(code).toBe(1);
    expect(output).toContain('maxQueued: 128');
  });
});
