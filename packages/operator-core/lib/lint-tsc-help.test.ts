import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = resolve(ROOT, 'scripts/lint-tsc.mjs');

describe('lint-tsc help (EI-21351855618678926)', () => {
  it.each(['--help', '-h'])('prints usage without starting the heavy typecheck for %s', (flag) => {
    const result = spawnSync(process.execPath, [SCRIPT, flag], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('npm run lint:tsc');
    expect(result.stdout).not.toContain('[pc-heavy]');
    expect(result.stdout).not.toContain('LINT_TSC_RESULT');
  });
});
