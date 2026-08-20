import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const REPORT = join(ROOT, 'packages/operator-core/lib/external-bench/_xbench_report.ts');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

function runFixture(arm: string, coordEvents: unknown, omitCoordEvents: boolean): string {
  const outDir = mkdtempSync(join(tmpdir(), 'xbench-report-'));
  try {
    for (const currentArm of [arm, 'ablated']) {
      const run: Record<string, unknown> = {
        arm: currentArm,
        runId: `run-${currentArm}`,
        runError: null,
        wallMs: 1000,
        peakConcurrentBees: 1,
        taskCount: 1,
        nonEmptyDiffs: 0,
        totals: { costUsd: 0, tokensIn: 0, tokensOut: 0 },
        perTask: [
          {
            instanceId: 'task-1',
            costUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            turns: 0,
            diffBytes: 0,
            stopReason: 'no-diff',
            generationError: null,
          },
        ],
      };
      if (!(currentArm === arm && omitCoordEvents)) run.coordEvents = coordEvents;
      writeFileSync(join(outDir, `${currentArm}.json`), JSON.stringify(run), 'utf8');
    }
    const result = spawnSync(TSX, [REPORT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        XBENCH_OUT_DIR: outDir,
        XBENCH_POT_ARM: arm,
        XBENCH_ABL_ARM: 'ablated',
      },
    });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe('_xbench_report coordEvents completeness', () => {
  it('fails closed when a parsed arm JSON omits the coordination trace', () => {
    const out = runFixture('hive', [], true);
    expect(out).toMatch(/missing coordEvents/);
    expect(out).toMatch(/absent coordination trace/);
  });

  it('accepts an explicitly empty coordination trace', () => {
    const out = runFixture('hive', [], false);
    expect(out).toMatch(/\[report\] wrote HEADLINE\.json \+ HEADLINE\.txt/);
  });
});
