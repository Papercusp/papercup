/**
 * P-006 — the host↔plugin bridge under the ACTUAL operator runtime.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (D-017).
 *
 * `design-phase-plugin-bridge.test.ts` proves the rendezvous works under
 * vitest, whose `createRequire` is a native node require. The operator does not
 * run under vitest — it runs `tsx bin/hono-host.ts`, and tsx maintains a
 * CommonJS preflight beside the ESM loader, which is exactly the seam that
 * produces two module records for one file. `pinModuleState` is supposed to
 * survive that; this test is what makes "supposed to" into a measurement.
 *
 * The failure it guards is SILENT. If the pin did not cross that seam, the host
 * would install into one slot and the plugin would read another, so every verb
 * would answer `engine-unavailable` — a legitimate answer for a standalone
 * install, so nothing would look broken in the operator either.
 *
 * D-017 rejected a direct `require()` of design-compare partly BECAUSE it only
 * worked under tsx. A bridge chosen for runtime-independence has to be shown to
 * have it, under the runtime it was not tested in.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const PLUGIN = resolve(REPO_ROOT, 'libs/papercusp/plugins/design-phase/index.cjs');
const HOST_REGISTRY = resolve(REPO_ROOT, 'packages/operator-core/lib/design-compare/host-registry.ts');

/**
 * Installs a stub surface as the ESM host would, then reads it back through the
 * plugin's CommonJS require. The stub is enough because what is under test is
 * the rendezvous, not the verbs — those have their own suite.
 *
 * `missing` is the negative control: without it, a `readDesignCompareVerbs`
 * that returned a truthy value for every harness would pass this test while
 * proving nothing about whether the install was ever seen.
 */
const SCRIPT = `
import { createRequire } from 'node:module';
import { installDesignCompareVerbs } from ${JSON.stringify(HOST_REGISTRY)};

const noop = async () => ({ ok: true });
installDesignCompareVerbs('tsx-harness', {
  ratifyReference: noop, compareRender: noop, getDesignEvidence: noop,
});

const require_ = createRequire(${JSON.stringify(PLUGIN)});
const plugin = require_(${JSON.stringify(PLUGIN)});
const found = plugin._internal.readDesignCompareVerbs('tsx-harness');
const missing = plugin._internal.readDesignCompareVerbs('never-installed');

console.log('BRIDGE_RESULT ' + JSON.stringify({
  found: found !== null && typeof found.compareRender === 'function',
  missing: missing === null,
  key: plugin._internal.DESIGN_COMPARE_HOST_SLOT,
}));
`;

describe('design-compare host↔plugin bridge under tsx', () => {
  it('carries the pinned slot across tsx\'s CommonJS/ESM seam', async () => {
    expect(existsSync(TSX), `tsx not installed at ${TSX}`).toBe(true);

    const { stdout } = await execFileAsync(TSX, ['-e', SCRIPT], {
      cwd: REPO_ROOT,
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });

    const line = stdout.split('\n').find((l) => l.startsWith('BRIDGE_RESULT '));
    expect(line, `no BRIDGE_RESULT in output:\n${stdout}`).toBeDefined();
    const result = JSON.parse(line!.slice('BRIDGE_RESULT '.length)) as {
      found: boolean;
      missing: boolean;
      key: string;
    };

    expect(result.found).toBe(true);
    expect(result.missing).toBe(true);
    expect(result.key).toBe('@papercusp/design-compare.host');
  }, 120_000);
});
