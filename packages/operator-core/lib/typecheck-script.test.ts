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

  it('root exposes the canonical npm workspace name for focused operator-core typechecks', () => {
    const root = scripts('package.json');
    expect(root['typecheck:operator-core']).toBe(
      'npm --workspace @papercusp/operator-core run typecheck --',
    );
    const operatorCore = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf-8'),
    ) as { name?: string };
    expect(operatorCore.name).toBe('@papercusp/operator-core');
  });

  // EI-847: operator-vite's `typecheck` used to be a raw `tsc --noEmit`, which floods with
  // hundreds of pre-existing errors (native-module ambient-type gaps transitively reachable
  // through operator-core) and gives an agent editing one component no clean per-file signal.
  // It must stay aliased onto the same per-file baseline gate as operator-core (via
  // scripts/lint-tsc-operator-vite.mjs, built on the shared scripts/lib/tsc-baseline-gate.mjs
  // policy) — this test fails if it regresses back to a bare `tsc --noEmit`.
  it('operator-vite package.json defines a `typecheck` script wired to the baseline gate, not a raw tsc flood', () => {
    const s = scripts('apps/operator-vite/package.json');
    expect(
      s.typecheck,
      'apps/operator-vite/package.json must define a `typecheck` script',
    ).toBeTruthy();
    expect(s.typecheck).toMatch(/lint-tsc-operator-vite\.mjs/);
    expect(s.typecheck).not.toMatch(/^tsc\b/);
  });

  it('apps/operator-vite/.tsc-baseline.json exists with a per-file `files` map', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'apps/operator-vite/.tsc-baseline.json'), 'utf-8'),
    );
    expect(baseline.files, 'baseline must have a files map').toBeTypeOf('object');
    expect(Object.keys(baseline.files).length).toBeGreaterThan(0);
  });

  it('agent-mcp package declares the baseline-gated typecheck used by workspace promotion', () => {
    const s = scripts('packages/agent-mcp/package.json');
    expect(s.typecheck, 'packages/agent-mcp must expose a real typecheck script').toBeTruthy();
    expect(s.typecheck).toMatch(/lint-tsc-agent-mcp\.mjs/);
    expect(s.typecheck).not.toMatch(/^tsc\b/);
  });

  it('agent-mcp baseline exists and is ready for per-file diagnostics', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/agent-mcp/.tsc-baseline.json'), 'utf-8'),
    );
    expect(baseline.files, 'agent-mcp baseline must have a files map').toBeTypeOf('object');
  });
});
