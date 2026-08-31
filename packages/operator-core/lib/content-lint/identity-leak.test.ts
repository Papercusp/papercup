/**
 * Tests for the identity-leak content detector (EI-19381677675617429).
 *
 * The load-bearing assertions here are the SCOPE ones, not the matching ones. Matching
 * is already covered by the shared matcher's own tests — this detector deliberately owns
 * no patterns. What is new, and what would cause a fleet-wide incident if wrong, is:
 *   1. the detector is registered at all (the whole point — the route-independent
 *      chokepoint the edit-time hook cannot be), and
 *   2. it NEVER runs inside a submodule, where 45 files carry identity literals by
 *      design and would be quarantined from every commit.
 */
import { describe, it, expect } from 'vitest';

import { findIdentityLeakError, identityLeakScopeMatches } from './identity-leak';
import { DEFAULT_CONTENT_DETECTORS, identityLeakDetector } from './registry';
import { detectContentOffenders } from '../harness/git-sync/content-guard';

/** A `runGit` stub: answers the repo-kind probe, and reports one dirty file. */
function makeRunGit(superprojectProbe: { code: number; stdout: string }, dirty = 'a.sh') {
  const calls: string[][] = [];
  const runGit = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-parse') {
      return { code: superprojectProbe.code, stdout: superprojectProbe.stdout, stderr: '' };
    }
    if (args[0] === 'status') return { code: 0, stdout: `?? ${dirty}\0`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runGit: runGit as never, calls };
}

const LEAKY = 'ExecStart=/home/somedev/.local/bin/thing\n';

describe('findIdentityLeakError', () => {
  it('flags a hardcoded home path and names the fix', () => {
    const err = findIdentityLeakError('svc.service', LEAKY);
    expect(err).toBeTruthy();
    expect(err).toContain('hardcoded home path');
    // The fix hint must travel WITH the error: it is fed verbatim to the content-fixer,
    // which has no other source for "use %h here, $HOME there".
    expect(err).toMatch(/%h|HOME|homedir/);
  });

  it('returns null for clean text — the overwhelmingly common case', () => {
    expect(findIdentityLeakError('svc.service', 'ExecStart=%h/.local/bin/thing\n')).toBeNull();
  });

  it('does not throw on empty or binary input', () => {
    // Escaped, never raw: a literal control byte here would red lint:no-control-bytes,
    // a green-checkpoint leg. The runtime string is byte-identical either way.
    expect(() => findIdentityLeakError('x.txt', '')).not.toThrow();
    expect(() => findIdentityLeakError('x.bin', '\x00\xff/home/')).not.toThrow();
  });
});

describe('identityLeakScopeMatches', () => {
  it('mirrors the CI lint: source in, generated/vendored out', () => {
    expect(identityLeakScopeMatches('apps/operator/scripts/systemd/x.service')).toBe(true);
    expect(identityLeakScopeMatches('node_modules/pkg/index.js')).toBe(false);
    expect(identityLeakScopeMatches('dist/bundle.js')).toBe(false);
  });

  it('excludes the dot-prefixed tool caches that made the lint report 412 for 2 real leaks', () => {
    expect(identityLeakScopeMatches('.tsx-tmp/node-compile-cache/v25/abc')).toBe(false);
    expect(identityLeakScopeMatches('.content-fixer-tmp/tsx/abc')).toBe(false);
  });
});

describe('registration', () => {
  it('is in the default registry — otherwise git-sync never runs it', () => {
    expect(DEFAULT_CONTENT_DETECTORS.map((d) => d.key)).toContain('identity-leak');
  });

  it('declares superproject-only scope', () => {
    expect(identityLeakDetector.repoScope).toBe('superproject-only');
  });

  it('declares NO autoFix — the correct substitution is context-dependent', () => {
    expect(identityLeakDetector.autoFix).toBeUndefined();
  });
});

describe('content guard honours repoScope', () => {
  const deps = (probe: { code: number; stdout: string }) => {
    const { runGit, calls } = makeRunGit(probe);
    return {
      calls,
      args: {
        runGit,
        repoPath: '/repo',
        readText: async () => LEAKY,
        detectors: [identityLeakDetector],
        log: () => {},
      } as never,
    };
  };

  it('RUNS the detector in the superproject (probe prints nothing)', async () => {
    const { args } = deps({ code: 0, stdout: '' });
    const offenders = await detectContentOffenders(args);
    expect(offenders.map((o) => o.detectorKey)).toEqual(['identity-leak']);
  });

  it('SKIPS the detector inside a submodule — the 45 by-design files must commit', async () => {
    const { args } = deps({ code: 0, stdout: '/home/x/superproject\n' });
    expect(await detectContentOffenders(args)).toEqual([]);
  });

  it('SKIPS it when the repo kind cannot be determined (fail-safe direction)', async () => {
    // Unknown must behave like "submodule", never like "superproject": wrongly running
    // here quarantines by-design files fleet-wide, while wrongly skipping only forfeits
    // one tick of a guard that is itself a backstop.
    const { args } = deps({ code: 128, stdout: '' });
    expect(await detectContentOffenders(args)).toEqual([]);
  });

  it('does not pay the repo-kind probe when no detector asks for scoping', async () => {
    const { runGit, calls } = makeRunGit({ code: 0, stdout: '' });
    await detectContentOffenders({
      runGit,
      repoPath: '/repo',
      readText: async () => LEAKY,
      detectors: [{ ...identityLeakDetector, repoScope: undefined }],
      log: () => {},
    } as never);
    expect(calls.some((c) => c[0] === 'rev-parse')).toBe(false);
  });
});
