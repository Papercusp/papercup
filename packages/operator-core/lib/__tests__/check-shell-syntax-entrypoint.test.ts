import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-shell-syntax.mjs');

describe('check-shell-syntax.mjs plain Node entrypoint', () => {
  it('resolves its TypeScript detector import under the pinned Node runtime', () => {
    // One explicit file: this test proves the entrypoint resolves its .ts import and
    // runs the detector. A whole-tree scan crossed the 30s timeout under gate load
    // (WI-10004913). `lint:shell-syntax` still covers the whole tree.
    const result = spawnSync(process.execPath, [SCRIPT, 'scripts/pc-heavy.sh'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('every tracked .sh script parses cleanly');
  }, 30_000);
});
