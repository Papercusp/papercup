import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rail that keeps the green-checkpoint able to render a verdict at all.
 *
 * A bare `npm install` in the shared tree takes no install mutex, so it mutates node_modules
 * underneath the gate's ~22-minute dependency copy. dependency-generation.sh then correctly
 * refuses the torn snapshot (exit 75) and the whole run is discarded as `green: null` — no
 * verdict, which is NOT a red and which fixing tests cannot clear. Measured 2026-08-30
 * (WI-871887): four consecutive attempts produced no verdict; main had not moved in 11 days.
 *
 * The guard's danger is over-blocking, not under-blocking: it runs from the root `preinstall`, so
 * a false refusal breaks every install in every checkout. Most of the cases below therefore pin
 * what it must let THROUGH.
 */

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim();
const guard = join(repoRoot, 'scripts', 'guard-shared-tree-install.mjs');
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();

const run = (env: Record<string, string>, cwd = repoRoot) =>
  spawnSync(process.execPath, [guard], {
    cwd,
    encoding: 'utf8',
    // A bare env: inheriting the parent's would leak PAPERCUSP_INSTALL_SAFE_ACTIVE from a test run
    // that itself started under install-safe, silently turning every refusal case into a pass.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  });

describe('shared-tree install guard', () => {
  it('exists and is wired into the root preinstall hook', () => {
    expect(existsSync(guard)).toBe(true);
    // Read the WORKING TREE copy: the committed one may lag an in-flight change, and it is the
    // working tree that npm actually executes.
    const live = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const preinstall = live.scripts?.preinstall ?? '';
    expect(preinstall).toContain('guard-shared-tree-install.mjs');
    // The pre-existing package-manager rail must survive alongside it.
    expect(preinstall).toContain('only-allow npm');
  });

  it.runIf(branch === 'staging')('REFUSES a bare install in the shared staging tree', () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REFUSED');
    // The refusal has to teach the fix, not just deny — this text is the whole intervention.
    expect(result.stderr).toContain('npm run install:safe');
  });

  it.runIf(branch === 'staging')('ALLOWS the sanctioned install-safe path', () => {
    // Without this the guard would deadlock the only correct way to install.
    expect(run({ PAPERCUSP_INSTALL_SAFE_ACTIVE: '1' }).status).toBe(0);
  });

  it.runIf(branch === 'staging')('ALLOWS an explicit escape hatch and CI', () => {
    expect(run({ PAPERCUSP_ALLOW_UNSAFE_INSTALL: '1' }).status).toBe(0);
    expect(run({ CI: 'true' }).status).toBe(0);
  });

  it('ALLOWS an install outside a git checkout rather than blocking what it cannot identify', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'install-guard-'));
    try {
      // Fails closed in the SAFE direction: a tree it cannot identify is not its business.
      expect(run({}, scratch).status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
