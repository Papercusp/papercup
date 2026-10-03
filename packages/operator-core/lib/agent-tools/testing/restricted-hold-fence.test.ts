/**
 * WI-10005634 — the restricted-write fence's REACH logic, against a real temporary checkout and
 * the real import-closure worker. The census half (git-sync's restricted readers) is injected
 * here; restricted-hold-fence.integration.test.ts drives it from real Postgres.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RestrictedEditHolding } from '../../personal-vault/git-sync-hold';
import { restrictedHoldBundleRefusal, restrictedHoldRefusal, TEST_ROUTER_PATH } from './restricted-hold-fence';

let root: string;

function put(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const hold = (...paths: string[]) => async (): Promise<RestrictedEditHolding[]> =>
  paths.map((path) => ({ path, owner: 'su-restricted', intent: 'restricted-disclosure hold (D-006/P-014): fixture', coordinationDomain: root }));

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'restricted-hold-fence-')));
  put('src/held.ts', 'export const held = 1;\n');
  put('src/clean.ts', 'export const clean = 2;\n');
  // Production code that can spawn a process whose path it assembles at runtime.
  put('src/runner.ts', "import { spawn } from 'node:child_process';\nexport const run = () => spawn('bash', [process.env.SCRIPT ?? '']);\n");
  put('tests/imports-held.test.ts', "import { held } from '../src/held';\nexport const value = held;\n");
  put('tests/clean.test.ts', "import { clean } from '../src/clean';\nexport const value = clean;\n");
  put('tests/uses-runner.test.ts', "import { run } from '../src/runner';\nexport const value = run;\n");
  put('scripts/deploy.sh', '#!/bin/sh\necho deploy\n');
  put('vitest.config.ts', 'export default {};\n');
  put('scripts/lib/router-lib.mjs', 'export const lib = 1;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('restrictedHoldRefusal — no held writes', () => {
  it('admits every run and builds no closure when nothing is held', async () => {
    const closures = vi.fn();
    expect(await restrictedHoldRefusal(root, ['tests/imports-held.test.ts'], { holdings: hold(), closures })).toBeNull();
    expect(closures).not.toHaveBeenCalled();
  });

  it('ignores holds in a different checkout', async () => {
    const elsewhere = async (): Promise<RestrictedEditHolding[]> => [
      { path: 'src/held.ts', owner: 'su-restricted', intent: 'restricted-disclosure hold (D-006/P-014): fixture', coordinationDomain: '/some/other/repo' },
    ];
    expect(await restrictedHoldRefusal(root, ['tests/imports-held.test.ts'], { holdings: elsewhere })).toBeNull();
  });
});

describe('restrictedHoldRefusal — reach', () => {
  it('refuses a test file that is itself a held restricted write', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('tests/clean.test.ts') });
    expect(refusal).toMatchObject({ error: 'restricted_write_held' });
    expect(refusal?.hint).toContain('tests/clean.test.ts is itself a held restricted write');
  });

  it('refuses a test whose import closure reaches a held source', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/imports-held.test.ts'], { holdings: hold('src/held.ts') });
    expect(refusal).toMatchObject({ error: 'restricted_write_held' });
    expect(refusal?.hint).toMatch(/imports-held\.test\.ts may execute a held restricted write: imports .*src\/held\.ts/);
  });

  it('admits a test whose closure provably cannot reach the held source (calibration)', async () => {
    expect(await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('src/held.ts') })).toBeNull();
  });

  it('refuses every run while a runner-loaded file is held, whatever the test imports', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('vitest.config.ts') });
    expect(refusal?.hint).toContain('vitest.config.ts is loaded by the test runner itself');
  });

  it('refuses when a held script exists and the test closure can spawn a process', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/uses-runner.test.ts'], { holdings: hold('scripts/deploy.sh') });
    expect(refusal?.hint).toMatch(/src\/runner\.ts can spawn a process and scripts\/deploy\.sh is a held restricted script/);
    // ...but a closure that cannot spawn anything cannot execute the script.
    expect(await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('scripts/deploy.sh') })).toBeNull();
  });

  it('refuses when the test-files router itself imports a held write', async () => {
    put(TEST_ROUTER_PATH, "import { lib } from './lib/router-lib.mjs';\nexport default lib;\n");
    try {
      const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('scripts/lib/router-lib.mjs') });
      expect(refusal?.hint).toContain('the test runner imports scripts/lib/router-lib.mjs');
    } finally {
      rmSync(join(root, TEST_ROUTER_PATH), { force: true });
    }
  });
});

describe('restrictedHoldRefusal — fail closed', () => {
  it('refuses with state_unknown when the restricted census cannot be read', async () => {
    const broken = async (): Promise<RestrictedEditHolding[]> => { throw new Error('disclosure_ledger_unavailable: fixture'); };
    const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: broken });
    expect(refusal).toMatchObject({ error: 'restricted_hold_state_unknown' });
    expect(refusal?.hint).toContain('disclosure_ledger_unavailable: fixture');
  });

  it('refuses when the import closure cannot be established while writes are held', async () => {
    const closures = vi.fn(async () => ({ status: 'incomplete' as const, reason: 'fixture budget' }));
    const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('src/held.ts'), closures });
    expect(refusal?.hint).toContain('the import closure could not be established (fixture budget)');
  });

  it('refuses a requested test that cannot be resolved while writes are held', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/missing.test.ts'], { holdings: hold('src/held.ts') });
    expect(refusal?.hint).toContain('tests/missing.test.ts could not be resolved');
  });
});

// WI-10005745 — the host bundle door: an exact intersection with what the bundle consumed.
describe('restrictedHoldBundleRefusal', () => {
  const abs = (rel: string) => join(root, rel);

  it('admits when nothing is held, or when the held write is not a bundle input (calibration)', async () => {
    const inputs = { files: [abs('src/clean.ts'), abs('src/runner.ts')], dirs: [] };
    expect(await restrictedHoldBundleRefusal(root, inputs, { holdings: hold() })).toBeNull();
    expect(await restrictedHoldBundleRefusal(root, inputs, { holdings: hold('src/held.ts') })).toBeNull();
  });

  it('refuses a held write that esbuild recorded as a bundle input', async () => {
    const refusal = await restrictedHoldBundleRefusal(root, { files: [abs('src/clean.ts'), abs('src/held.ts')], dirs: [] }, { holdings: hold('src/held.ts') });
    expect(refusal?.error).toBe('restricted_write_held');
    expect(refusal?.hint).toContain('src/held.ts is a bundle input and a held restricted write');
    expect(refusal?.hint).toContain('last-known-good');
  });

  it('refuses a held file inside a directory the bundler copies verbatim', async () => {
    const refusal = await restrictedHoldBundleRefusal(root, { files: [], dirs: [abs('scripts')] }, { holdings: hold('scripts/deploy.sh') });
    expect(refusal?.hint).toContain('scripts/deploy.sh is a bundle input');
    // A sibling directory that merely shares the prefix is not the copied directory.
    expect(await restrictedHoldBundleRefusal(root, { files: [], dirs: [abs('scr')] }, { holdings: hold('scripts/deploy.sh') })).toBeNull();
  });

  it('ignores holds in a different checkout', async () => {
    const elsewhere = async (): Promise<RestrictedEditHolding[]> => [
      { path: 'src/held.ts', owner: 'su-restricted', intent: 'restricted-disclosure hold (D-006/P-014): fixture', coordinationDomain: '/some/other/repo' },
    ];
    expect(await restrictedHoldBundleRefusal(root, { files: [abs('src/held.ts')], dirs: [] }, { holdings: elsewhere })).toBeNull();
  });

  it('fails closed when the census cannot be read', async () => {
    const broken = async (): Promise<RestrictedEditHolding[]> => {
      throw new Error('census offline');
    };
    const refusal = await restrictedHoldBundleRefusal(root, { files: [abs('src/clean.ts')], dirs: [] }, { holdings: broken });
    expect(refusal?.error).toBe('restricted_hold_state_unknown');
    expect(refusal?.hint).toContain('census offline');
  });
});
