/**
 * Regression test for endpoint-route-progress.mjs (EI-6884).
 *
 * The script counts migrated defineRoute modules by reading the route
 * registry barrel. The barrel moved to packages/operator-core/lib/... in the
 * operator-core extraction, but the script kept reading the stale
 * apps/operator/lib/... path. The readFileSync threw ENOENT, a bare `catch`
 * swallowed it, and `defineRoute modules` silently reported 0 forever even
 * though 400+ modules are migrated.
 *
 * This drives the real script and asserts the count is a positive number and
 * no barrel-read warning is emitted — which fails against the stale path and
 * passes once the path resolves to the real (existing) barrel.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../endpoint-route-progress.mjs',
);

function runScript(): string {
  return execFileSync('node', [SCRIPT], { encoding: 'utf8' });
}

describe('endpoint-route-progress', () => {
  it('resolves the defineRoute barrel and reports a non-zero migrated count', () => {
    const out = runScript();

    // The barrel-read must not silently fall through to the swallow-catch.
    expect(out).not.toMatch(/could not read defineRoute barrel/);

    const match = out.match(/defineRoute modules\s*:\s*(\d+)/);
    expect(match, `no "defineRoute modules" line in output:\n${out}`).toBeTruthy();

    const migratedCount = Number(match![1]);
    // The real repo has hundreds of migrated modules; the bug reported 0.
    expect(migratedCount).toBeGreaterThan(0);
  });

  it('points at a barrel file that exists on disk', () => {
    // Guards the specific failure mode: a stale barrel path. If the barrel
    // moves again, this fails loudly instead of the count silently going to 0.
    // REPO comes from this file's location, not `git rev-parse` — the release
    // source bundle ships without a .git dir.
    const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
    const BARREL = resolve(
      REPO,
      'packages/operator-core/lib/endpoint-route/routes/index.ts',
    );
    expect(existsSync(BARREL), `expected route barrel at ${BARREL}`).toBe(true);
  });
});
