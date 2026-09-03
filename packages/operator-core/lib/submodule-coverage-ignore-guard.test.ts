/**
 * Falsifiability tests for scripts/check-submodule-coverage-ignore.mjs (EI-22201289307647151).
 *
 * The guard exists because a superproject .gitignore does NOT govern inside a
 * submodule — `git check-ignore` run from the repo root answers "is in submodule <p>"
 * and declines — so the root .gitignore's `coverage/` rule set (added for
 * EI-22195215129102176, after a non-ignored coverage dir swept 74 files / +54,104
 * lines into the tree) silently stops at every submodule boundary. Measured
 * 2026-09-03: 22 of 38 coverage-capable submodules had no local copy of the rule, and
 * one of them (libs/papercusp) already had 10 raw V8 coverage JSON files TRACKED in
 * its index from an earlier accidental sweep.
 *
 * A guard that has only ever been run against a clean tree is not a verified guard.
 * These tests pin the property that matters: the predicate FLAGS a coverage-capable
 * repo that does not ignore the probe path, and does not merely return empty for
 * everything.
 */
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs guard script, no type declarations by design (as with sibling guards)
import { ALLOWLIST, findOffenders } from '../../../scripts/check-submodule-coverage-ignore.mjs';

/** A capability/ignore check backed by plain maps, so no real repo is needed. */
const capabilityFor =
  (capable: Set<string>) =>
  (repo: string): boolean =>
    capable.has(repo);

const ignoredFor =
  (ignored: Set<string>) =>
  (repo: string): boolean =>
    ignored.has(repo);

describe('check-submodule-coverage-ignore findOffenders', () => {
  it('CALIBRATION: flags a coverage-capable repo that does not ignore the probe path', () => {
    const offenders: string[] = findOffenders({
      repos: ['libs/papercusp', 'libs/generic/sse'],
      isCoverageCapable: capabilityFor(new Set(['libs/papercusp', 'libs/generic/sse'])),
      isIgnored: ignoredFor(new Set(['libs/generic/sse'])),
      allowlist: new Set<string>(),
    });

    expect(offenders).toEqual(['libs/papercusp']);
  });

  it('passes a tree where every coverage-capable repo ignores the probe path', () => {
    const repos = ['libs/papercusp', 'libs/generic/sse', 'libs/testing-shell'];
    const offenders: string[] = findOffenders({
      repos,
      isCoverageCapable: capabilityFor(new Set(repos)),
      isIgnored: ignoredFor(new Set(repos)),
      allowlist: new Set<string>(),
    });

    expect(offenders).toEqual([]);
  });

  it('never flags a repo with no coverage-capable surface, ignored or not', () => {
    const offenders: string[] = findOffenders({
      repos: ['libs/zero-harness'],
      isCoverageCapable: capabilityFor(new Set()),
      isIgnored: ignoredFor(new Set()),
      allowlist: new Set<string>(),
    });

    expect(offenders).toEqual([]);
  });

  it('reports EVERY offending repo, not just the first — the real incident was 22 at once', () => {
    const repos = Array.from({ length: 22 }, (_, i) => `libs/generic/pkg-${i}`);

    const offenders: string[] = findOffenders({
      repos,
      isCoverageCapable: capabilityFor(new Set(repos)),
      isIgnored: ignoredFor(new Set()),
      allowlist: new Set<string>(),
    });

    expect(offenders).toHaveLength(22);
  });

  it('honors the allowlist', () => {
    const offenders: string[] = findOffenders({
      repos: ['libs/generic/exempted'],
      isCoverageCapable: capabilityFor(new Set(['libs/generic/exempted'])),
      isIgnored: ignoredFor(new Set()),
      allowlist: new Set(['libs/generic/exempted']),
    });

    expect(offenders).toEqual([]);
  });

  it('ships with an EMPTY allowlist — every coverage-capable repo can produce a report', () => {
    expect([...(ALLOWLIST as Set<string>)]).toEqual([]);
  });
});
