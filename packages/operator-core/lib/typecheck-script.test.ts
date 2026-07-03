/**
 * EI-6479 regression guard — the `npm run typecheck --if-present` idiom must
 * NOT silently no-op.
 *
 * The fleet-brief verification idiom is `npm run typecheck --if-present`.
 * npm's `--if-present` exits 0 WITHOUT running anything when no `typecheck`
 * script exists — so an agent honestly-but-wrongly reports "tsc clean" while
 * nothing ran. The durable fix aliases `typecheck` onto the EXISTING
 * baseline-aware gate (`scripts/lint-tsc.mjs`, a.k.a. `lint:tsc`), which
 * reports the operator-core error count vs its committed baseline and fails
 * only on NEW errors (ratchet-only-down). This test fails if the alias is
 * removed — i.e. if the repo regresses back to the silent-no-op state.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

function scripts(pkgRelPath: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, pkgRelPath), 'utf-8'));
  return pkg.scripts ?? {};
}

describe('EI-6479 — typecheck script exists and runs the real baseline gate', () => {
  it('root package.json defines a non-empty `typecheck` script (so --if-present never no-ops)', () => {
    const s = scripts('package.json');
    expect(s.typecheck, 'root package.json must define a `typecheck` script').toBeTruthy();
    // Must invoke the shared baseline gate, not a placeholder that no-ops.
    expect(s.typecheck).toMatch(/lint-tsc\.mjs|lint:tsc/);
  });

  it('operator-core package.json defines a `typecheck` script wired to the baseline gate', () => {
    const s = scripts('packages/operator-core/package.json');
    expect(
      s.typecheck,
      'operator-core package.json must define a `typecheck` script',
    ).toBeTruthy();
    expect(s.typecheck).toMatch(/lint-tsc\.mjs/);
  });
});
