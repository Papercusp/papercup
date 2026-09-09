import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let directory: string;
let config: string;

describe('tsx inline program with explicit tsconfig — EI-22753761838033436', () => {
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'tsx-inline-config-'));
    config = join(directory, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ compilerOptions: { target: 'ES2022' } }));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  // The secondary eval/print parser must recognize tsx's own flags too.
  // Otherwise a split tsconfig value looks like a script positional argument:
  // parsing stops before -e, but the next pass removes -e and its program.
  // Node then receives no program and exits zero on closed stdin.
  it.each(['split', 'equals', 'implicit'] as const)('executes the inline program with %s config arguments', (form) => {
    const args = form === 'split' ? ['--tsconfig', config] : form === 'equals' ? ['--tsconfig=' + config] : [];
    const output = execFileSync(process.execPath, [
      join(root, 'node_modules/tsx/dist/cli.mjs'), ...args, '-e', 'const n: number = 17; console.log("TSX_EXECUTED=" + n)',
    ], { cwd: root, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(output.trim()).toBe('TSX_EXECUTED=17');
  }, 20_000);

  it('preserves print mode and the program exit status with split config arguments', () => {
    const cli = join(root, 'node_modules/tsx/dist/cli.mjs');
    expect(execFileSync(process.execPath, [cli, '--tsconfig', config, '-p', '6 * 7'], {
      cwd: root, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()).toBe('42');
    expect(() => execFileSync(process.execPath, [cli, '--tsconfig', config, '-e', 'process.exit(17)'], {
      cwd: root, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();
  }, 35_000);
});
