import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExportBundle } from './export-bundle';

let baseDir: string;

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'bench-export-'));
  const dir = join(baseDir, 'run-x');
  mkdirSync(join(dir, 'diffs-hive-realqueen'), { recursive: true });
  writeFileSync(
    join(dir, 'hive-realqueen.json'),
    JSON.stringify({
      arm: 'hive-realqueen',
      runId: 'run-x',
      startedAt: '2026-06-16T04:00:00Z',
      perTask: [
        { instanceId: 'instance_a', diffBytes: 50 },
        { instanceId: 'instance_b', diffBytes: 0 },
      ],
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'diffs-hive-realqueen', 'instance_a.diff'), 'diff --git a/x b/x\n+patch', 'utf8');
  writeFileSync(join(dir, 'diffs-hive-realqueen', 'instance_b.diff'), '', 'utf8');
});
afterAll(() => rmSync(baseDir, { recursive: true, force: true }));

describe('buildExportBundle', () => {
  it('assembles predictions + task ids + the official re-grade command + a README', () => {
    const b = buildExportBundle('run-x', { baseDir })!;
    expect(b).not.toBeNull();
    expect(b.arm).toBe('hive-realqueen');
    expect(b.taskCount).toBe(2);
    expect(b.nonEmptyPatches).toBe(1);
    expect(b.taskIds).toEqual(['instance_a', 'instance_b']);
    expect(b.predictions).toHaveLength(2);
    const a = b.predictions.find((p) => p.instance_id === 'instance_a')!;
    expect(a.patch).toContain('diff --git');
    expect(a.prefix).toBe('arm-hive-realqueen');
    // The exact public re-grade command + the caveats are in the bundle.
    expect(b.regradeCommand).toContain('swe_bench_pro_eval.py');
    expect(b.regradeCommand).toContain('--use_local_docker');
    expect(b.readme).toMatch(/Caveats/);
    expect(b.readme).toMatch(/Empty diffs/);
  });

  it('returns null when the run has no on-disk snapshot', () => {
    expect(buildExportBundle('missing', { baseDir })).toBeNull();
  });
});
