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

// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { findUnreportedFallbacks } from '../../../../scripts/check-sidecar-fallback-reported.mjs';

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
