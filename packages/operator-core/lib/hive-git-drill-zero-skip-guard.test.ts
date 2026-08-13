/**
 * D-002 / P-505 — the canonical hive-git drill has two legitimate verdicts:
 *
 *  - its default single-box scaffold may pass while explicitly inventorying
 *    rig-gated legs as SKIP; and
 *  - release acceptance must refuse every remaining skip.
 *
 * Extract the real summary block from the shipping bash script so this test
 * fails if its exit semantics drift without running the heavyweight drill.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'hive-git-drill.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate papercusp-desktop/bin/hive-git-drill.sh');
}

const drill = readFileSync(
  join(repoRoot(), 'papercusp-desktop', 'bin', 'hive-git-drill.sh'),
  'utf8',
);
const gateMatch = drill.match(
  /# ZERO-SKIP-RELEASE-GATE-BEGIN[^\n]*\n([\s\S]*?)# ZERO-SKIP-RELEASE-GATE-END/,
);

function runGate(input: {
  fail: number;
  skipped: number;
  requireZeroSkips?: boolean;
}): { status: number | null; output: string } {
  expect(gateMatch, 'zero-skip release gate markers must remain in the drill').toBeTruthy();
  const script = [
    'set -uo pipefail',
    'PASS=7',
    `FAIL=${input.fail}`,
    `SKIPPED=${input.skipped}`,
    `REQUIRE_ZERO_SKIPS=${input.requireZeroSkips ? 1 : 0}`,
    gateMatch![1],
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('D-002 hive-git zero-skip release acceptance', () => {
  it('pins the current explicit skip inventory to E/P-306 and G/P-308', () => {
    const inventory = [...drill.matchAll(/^skipp "LEG ([A-G]) \(P-(\d+)\)/gm)].map(
      ([, leg, item]) => `${leg}/P-${item}`,
    );
    expect(inventory).toEqual(['E/P-306', 'G/P-308']);
  });

  it('preserves the default scaffold pass while reporting unproven legs', () => {
    const result = runGate({ fail: 0, skipped: 2 });
    expect(result.status).toBe(0);
    expect(result.output).toContain('OVERALL: PASS — scaffold + mode round-trip green');
    expect(result.output).toContain('2 Phase-3 legs unproven');
  });

  it('fails release acceptance while any explicit skip remains', () => {
    const result = runGate({ fail: 0, skipped: 2, requireZeroSkips: true });
    expect(result.status).toBe(1);
    expect(result.output).toContain('OVERALL: FAIL — release acceptance requires zero skips');
    expect(result.output).toContain('2 Phase-3 legs remain unproven');
  });

  it('passes release acceptance only when failures and skips are both zero', () => {
    const result = runGate({ fail: 0, skipped: 0, requireZeroSkips: true });
    expect(result.status).toBe(0);
    expect(result.output).toContain('OVERALL: PASS — release acceptance green');
    expect(result.output).toContain('all Phase-3 legs ran with zero skips');
  });

  it('never lets zero skips hide a failed assertion', () => {
    const result = runGate({ fail: 1, skipped: 0, requireZeroSkips: true });
    expect(result.status).toBe(1);
    expect(result.output).toContain('OVERALL: FAIL');
    expect(result.output).not.toContain('release acceptance green');
  });
});
