/**
 * Guard test for `scripts/check-sidecar-fallback-reported.mjs`
 * (EI-20281745253229841).
 *
 * The guard blocks the build, so the only thing that makes it trustworthy is
 * proof that it BOTH fires on a real offender and stays quiet on a compliant
 * site. A guard that has never failed is a guard nobody has tested — and a
 * guard that fires on compliant code gets disabled, which is worse than not
 * having one.
 *
 * These cases run against the guard's exported predicate on SYNTHETIC source
 * strings, so nothing in the shared tree is ever mutated (CLAUDE.md's tier-2
 * discipline: the subject is reachable as a pure function, so there is no
 * reason to touch a tracked file to prove falsifiability).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// @ts-ignore — pure JS guard script, no .d.ts (same treatment as the sibling live-tree guards).
import {
  findUnreportedFallbacks,
  scanTree,
} from '../../../../scripts/check-sidecar-fallback-reported.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const GUARD = path.join(REPO_ROOT, 'scripts/check-sidecar-fallback-reported.mjs');

/**
 * Measured 2026-08-12: the guard reads several thousand tracked .ts files. The floor
 * sits well under that on purpose — it catches a COLLAPSE of the scan (wrong root,
 * broken `git ls-files`, a submodule boundary), not ordinary census movement.
 */
const MIN_SCANNED = 3_000;

const compliant = `
  if (gitSidecarEnabled('PAPERCUSP_X_SPAWN_SIDECAR')) {
    try {
      return await runGitViaSpawnerSidecar(args, cwd, 1000, process.env);
    } catch (e) {
      noteSidecarFallback('x', e);
    }
  }
  return runGitLocal(args, cwd);
`;

describe('check-sidecar-fallback-reported guard', () => {
  it('is QUIET on a compliant site (no false positive)', () => {
    expect(findUnreportedFallbacks(compliant)).toHaveLength(0);
  });

  it('FIRES on a bare `catch {}` that swallows the fallback entirely', () => {
    const bad = `
      if (gitSidecarEnabled('X')) {
        try {
          const r = await runGitViaSpawnerSidecar(args, root, 5000, process.env);
          return r.code === 0 ? r.stdout : null;
        } catch {
          // silently fall through
        }
      }
      return localFallback();
    `;
    expect(findUnreportedFallbacks(bad).length).toBeGreaterThan(0);
  });

  it('FIRES on a hand-rolled console.warn that does not route through the reporter', () => {
    const bad = compliant.replace("noteSidecarFallback('x', e);", "console.warn('sidecar down: ' + e);");
    expect(findUnreportedFallbacks(bad).length).toBeGreaterThan(0);
  });

  it('FIRES on a private warn-once helper — the idiom that hid the outage', () => {
    const bad = compliant.replace("noteSidecarFallback('x', e);", 'warnSidecarFallbackOnce(e);');
    expect(findUnreportedFallbacks(bad).length).toBeGreaterThan(0);
  });

  it('covers the stdin variant too, not just runGitViaSpawnerSidecar', () => {
    const bad = `
      try {
        return await runGitStdinViaSpawnerSidecar(args, cwd, stdin, 1000, process.env);
      } catch (e) {
        console.warn(e);
      }
    `;
    const good = bad.replace('console.warn(e);', "noteSidecarFallback('x', e);");
    expect(findUnreportedFallbacks(bad).length).toBeGreaterThan(0);
    expect(findUnreportedFallbacks(good)).toHaveLength(0);
  });

  it('does not fire on import lines that merely NAME the sidecar entrypoints', () => {
    const importOnly = `
      import { gitSidecarEnabled, noteSidecarFallback, runGitViaSpawnerSidecar } from './fleet/git-via-sidecar';
    `;
    expect(findUnreportedFallbacks(importOnly)).toHaveLength(0);
  });

  it('reports a line number so the failure is actionable', () => {
    const bad = compliant.replace("noteSidecarFallback('x', e);", 'console.warn(e);');
    const [first] = findUnreportedFallbacks(bad);
    expect(first?.line).toBeGreaterThan(0);
    expect(first?.call).toBe('runGitViaSpawnerSidecar');
  });
});

/**
 * The cases above prove the PREDICATE works; they run it over fixtures. That is
 * classified ADVISORY (`logic-test`) by check-lint-guard-reachability.mjs, and
 * deliberately so: a green logic test and a rotting guard are perfectly
 * compatible states — the predicate can be flawless while nothing ever points it
 * at the repository.
 *
 * These cases are what put the guard on a BLOCKING path (WI-38312). Without them
 * the guard shipped enforcing nothing, and the reachability check went red for
 * every agent whose change mapped into @papercusp/operator-core.
 */
describe('sidecar-fallback-reported guard — live verdict over the real tree', () => {
  it('REACHED the tree: the scan examined a plausible number of files', () => {
    const { scanned } = scanTree() as { scanned: number };
    // Asserted BEFORE the silence below, so a collapsed scan cannot masquerade as
    // a compliant repository.
    expect(scanned).toBeGreaterThan(MIN_SCANNED);
  });

  it('found the call sites it exists to police — the scan is not silently filtering them all out', () => {
    const { considered } = scanTree() as { considered: number };
    expect(considered).toBeGreaterThan(0);
  });

  it('every sidecar-git fallback in the repository reports via noteSidecarFallback()', () => {
    // Executes the guard exactly as the gate does. This invocation is what the
    // reachability taxonomy counts as enforcement, and it is also the honest test:
    // it asserts the SHIPPED entrypoint's verdict, not a re-implementation of it.
    const out = execFileSync('node', [GUARD], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(out).toMatch(/✓ every sidecar-git fallback reports via noteSidecarFallback\(\)/);
  });
});
