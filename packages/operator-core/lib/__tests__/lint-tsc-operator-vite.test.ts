import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const source = readFileSync(join(root, 'scripts/lint-tsc-operator-vite.mjs'), 'utf8');
const command = /preTscCommand:\s*'([^']+)'/.exec(source)?.[1];
const fixtures: string[] = [];

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(body: string) {
  const path = mkdtempSync(join(tmpdir(), 'vite-typecheck-preflight-'));
  fixtures.push(path);
  const scripts = join(path, 'apps/operator-vite/scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'generate-route-tree.mjs'), body);
  return path;
}

describe('direct Vite typecheck refreshes cold-checkout routing types', () => {
  it('wires the existing route generator into the fail-closed baseline preflight', () => {
    expect(command).toBe('node apps/operator-vite/scripts/generate-route-tree.mjs');
    expect(source).toMatch(/runTscBaselineGate\(\{[^}]*preTscCommand:/s);
  });

  it('runs the configured generator before a compiler can read the route tree', () => {
    expect(command).toBeDefined();
    const cwd = fixture("import { writeFileSync } from 'node:fs'; writeFileSync('routes-ready', 'generated');");
    execSync(command!, { cwd, stdio: 'pipe', timeout: 120_000, killSignal: 'SIGKILL' });
    expect(readFileSync(join(cwd, 'routes-ready'), 'utf8')).toBe('generated');
  });

  it('propagates a generator failure instead of accepting a stale route tree', () => {
    expect(command).toBeDefined();
    const cwd = fixture("throw new Error('route generation failed');");
    expect(() => execSync(command!, { cwd, stdio: 'pipe', timeout: 120_000, killSignal: 'SIGKILL' })).toThrow();
  });
});
