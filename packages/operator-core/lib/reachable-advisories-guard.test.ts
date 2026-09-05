/**
 * Guard test for scripts/check-reachable-advisories.mjs — the P-007 reachable-advisory gate
 * (plan security-boundary-remediation-and-usability-2026-09-04).
 *
 * WHY THESE CONTROLS EXIST
 * A guard that has never failed is a guard nobody has tested, and this one's whole value is
 * a DISCRIMINATION: it must gate a shipping high advisory and must NOT gate one that only
 * enters through a non-shipping workspace. Either half failing silently turns the gate into
 * noise (over-gates) or into a rubber stamp (under-gates), and both look green from outside.
 *
 * The analyzer is a pure function over parsed `npm audit` / `npm ls` JSON, so every case
 * below runs on inline fixtures — no npm invocation, no shared-tree mutation (the
 * copy-out/fixture tier from CLAUDE.md's falsifiability table).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Enrolled in tsconfig.declarations.json, so this import is TYPED (generated sibling
// scripts/check-reachable-advisories.d.mts). That is deliberate: it pins `analyze()`'s
// arity at the call site, so a call that silently dropped the 4th argument — quietly
// restoring the optimistic single-lens fix reading this file exists to prevent — fails
// to compile instead of passing.
import { analyze, attributeAdvisories, isNonShipping } from '../../../scripts/check-reachable-advisories.mjs';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'reachable-advisories-baseline.json');

/** A shipping workspace and a non-shipping one, each pulling in its own high advisory. */
const LS_FIXTURE = {
  dependencies: {
    '@papercusp/web': {
      resolved: 'file:apps/web',
      dependencies: { 'evil-shipped': { version: '1.0.0' } },
    },
    '@papercusp/testing-shell': {
      resolved: 'file:libs/testing-shell',
      dependencies: { 'evil-testonly': { version: '1.0.0' } },
    },
  },
};

const AUDIT_FIXTURE = {
  vulnerabilities: {
    'evil-shipped': { severity: 'high', fixAvailable: true },
    'evil-testonly': { severity: 'high', fixAvailable: true },
    'evil-orphan': { severity: 'critical', fixAvailable: false },
    'noisy-moderate': { severity: 'moderate', fixAvailable: true },
  },
};

/**
 * Locate a finding by name, throwing when the analyzer did not produce it.
 *
 * Not sugar: `.find()` returns `T | undefined`, and reading `.gating` off an absent
 * finding would make the assertion pass vacuously on `undefined` — a control that cannot
 * fail, in the one file whose entire purpose is proving this gate discriminates.
 */
function findingFor(result: ReturnType<typeof analyze>, name: string) {
  const f = result.findings.find((x) => x.name === name);
  if (!f) throw new Error(`analyzer produced no finding for "${name}"`);
  return f;
}

describe('reachable-advisory gate: discrimination', () => {
  it('GATES a high advisory reachable from a shipping workspace', () => {
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] });
    expect(r.offenders.map((o: { name: string }) => o.name)).toContain('evil-shipped');
  });

  it('does NOT gate a high advisory that only enters through a non-shipping workspace', () => {
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] });
    expect(r.offenders.map((o: { name: string }) => o.name)).not.toContain('evil-testonly');
    // ...but it is still MEASURED. Dropping it entirely would hide real debt.
    expect(r.findings.map((f: { name: string }) => f.name)).toContain('evil-testonly');
  });

  it('is not vacuous: the two controls above differ only in shipping-ness', () => {
    // Both are `high` with a fix available; only the owning workspace differs. If this
    // ever collapses to "both gate" or "neither gates", the discrimination is broken.
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] });
    const shipped = findingFor(r, 'evil-shipped');
    const testonly = findingFor(r, 'evil-testonly');
    expect(shipped.severity).toBe(testonly.severity);
    expect(shipped.gating).toBe(true);
    expect(testonly.gating).toBe(false);
  });

  it('does not gate below the severity threshold', () => {
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] });
    expect(r.offenders.map((o: { name: string }) => o.name)).not.toContain('noisy-moderate');
  });
});

describe('reachable-advisory gate: fails closed on a measurement gap', () => {
  it('treats an unattributable advisory as SHIPPING rather than skipping it', () => {
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] });
    // 'evil-orphan' appears in no workspace subtree — npm hoisting can produce exactly this.
    expect(r.offenders.map((o: { name: string }) => o.name)).toContain('evil-orphan');
    expect(r.unattributed).toContain('evil-orphan');
  });

  it('an EMPTY dependency tree gates every advisory instead of reporting all-clear', () => {
    // The failure this prevents: `npm ls` returning nothing (wrong cwd, install mid-flight)
    // would attribute nothing, and a naive gate would then report a clean bill of health.
    const r = analyze(AUDIT_FIXTURE, {}, { accepted: [] });
    expect(r.offenders.length).toBeGreaterThan(0);
    expect(r.unattributed.length).toBe(Object.keys(AUDIT_FIXTURE.vulnerabilities).length);
  });
});

describe('reachable-advisory gate: baseline semantics', () => {
  it('a baselined advisory stops gating', () => {
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: ['evil-shipped', 'evil-orphan'] });
    expect(r.offenders.map((o: { name: string }) => o.name)).not.toContain('evil-shipped');
  });

  it('reports a baseline entry whose advisory is gone as STALE (shrink-only pressure)', () => {
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: ['already-fixed'] });
    expect(r.stale).toContain('already-fixed');
  });
});

describe('reachable-advisory gate: attribution', () => {
  it('attributes a package to the workspace whose subtree reaches it', () => {
    const reach = attributeAdvisories(LS_FIXTURE, ['evil-shipped', 'evil-testonly']);
    expect([...reach.get('evil-shipped')]).toEqual(['@papercusp/web']);
    expect([...reach.get('evil-testonly')]).toEqual(['@papercusp/testing-shell']);
  });

  it('attributes a shared dependency to EVERY workspace that reaches it', () => {
    const shared = {
      dependencies: {
        '@papercusp/web': { resolved: 'file:apps/web', dependencies: { dup: {} } },
        '@papercusp/operator-core': { resolved: 'file:packages/operator-core', dependencies: { dup: {} } },
      },
    };
    const reach = attributeAdvisories(shared, ['dup']);
    expect([...reach.get('dup')].sort()).toEqual(['@papercusp/operator-core', '@papercusp/web']);
  });

  it('terminates on a cyclic dependency graph', () => {
    const cyclic: Record<string, unknown> = {
      dependencies: { '@papercusp/web': { resolved: 'file:apps/web', dependencies: {} } },
    };
    const web = (cyclic.dependencies as Record<string, { dependencies: Record<string, unknown> }>)['@papercusp/web'];
    web.dependencies = { loop: { dependencies: web.dependencies } };
    // Would hang or blow the stack without cycle handling.
    expect(() => attributeAdvisories(cyclic, ['loop'])).not.toThrow();
  });
});

describe('reachable-advisory baseline file integrity', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  it('every accepted advisory carries a stated reason', () => {
    // The whole point of the baseline is that a suppression is JUSTIFIED. An accepted
    // name with no entry is a silent suppression, which is what a parking lot looks like.
    for (const name of baseline.accepted) {
      expect(baseline.entries[name], `no entry/reason for accepted advisory ${name}`).toBeTruthy();
      expect(String(baseline.entries[name].reason).length).toBeGreaterThan(20);
    }
  });

  it('has no orphan entries (entry present but not accepted)', () => {
    const accepted = new Set(baseline.accepted);
    for (const name of Object.keys(baseline.entries)) {
      expect(accepted.has(name), `entry ${name} is not in accepted[]`).toBe(true);
    }
  });

  it('every entry declares a known disposition', () => {
    const known = new Set(['patch-eligible', 'deferred-semver-major']);
    for (const [name, e] of Object.entries<{ disposition: string }>(baseline.entries)) {
      expect(known.has(e.disposition), `${name} has unknown disposition ${e.disposition}`).toBe(true);
    }
  });

  it('a deferred-semver-major entry names the major upgrade it is deferring', () => {
    for (const [name, e] of Object.entries<{ disposition: string; reason: string }>(baseline.entries)) {
      if (e.disposition !== 'deferred-semver-major') continue;
      expect(/semver-major|@\d+\.\d+/.test(e.reason), `${name} does not name the major upgrade`).toBe(true);
    }
  });
});

describe('reachable-advisory gate: non-shipping classification', () => {
  it('classifies the docs and test-only workspaces as non-shipping', () => {
    expect(isNonShipping('@papercusp/testing-shell')).toBe(true);
    expect(isNonShipping('@papercupai/operator-docs')).toBe(true);
  });

  it('does NOT classify a product workspace as non-shipping', () => {
    // The dangerous direction: mislabeling a shipping workspace silently disables the gate
    // for everything it pulls in.
    expect(isNonShipping('@papercusp/web')).toBe(false);
    expect(isNonShipping('@papercusp/operator-core')).toBe(false);
  });
});

/**
 * REGRESSION: the two audit lenses disagree, and the prod-only one is OPTIMISTIC.
 *
 * Measured 2026-09-05 against the real tree — style-dictionary installed 4.4.0, root
 * declaring "^4.4.0":
 *   npm audit --omit=dev  ->  fixAvailable: true                      ("patch-compatible")
 *   npm audit             ->  fixAvailable: 5.5.2, isSemVerMajor: true
 * 4.4.0 -> 5.5.2 is major and "^4.4.0" cannot reach it, so the prod-only lens is wrong.
 * Reporting it as patch-compatible sends an agent to attempt a fix that cannot work — the
 * gate's advice, not just its verdict, has to be trustworthy.
 *
 * `--omit=dev` is not even a subset of the full tree: it reported 99 advisories to the
 * full tree's 91, which is why this is reconciled rather than simply preferring one.
 */
describe('reachable-advisory gate: two-lens fix feasibility', () => {
  const FULL_AUDIT_FIXTURE = {
    vulnerabilities: {
      'evil-shipped': {
        severity: 'high',
        fixAvailable: { name: 'evil-shipped', version: '5.5.2', isSemVerMajor: true },
      },
      'noisy-moderate': { severity: 'critical', fixAvailable: true },
    },
  };

  it('a MAJOR fix in the installed tree overrides a compatible prod-only fix', () => {
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] }, FULL_AUDIT_FIXTURE);
    const f = findingFor(r, 'evil-shipped');
    expect(f.patchCompatible).toBe(false);
    expect(f.fix).toContain('5.5.2');
    expect(f.fix).toContain('SEMVER-MAJOR');
  });

  it('is not vacuous: WITHOUT the second lens the same fixture reads patch-compatible', () => {
    // The calibration that makes the assertion above meaningful — if analyze() ignored the
    // second lens entirely, this control and the one above could not both hold.
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] });
    const f = findingFor(r, 'evil-shipped');
    expect(f.patchCompatible).toBe(true);
    expect(f.fix).toBe('patch-compatible');
  });

  it('surfaces the disagreement rather than silently taking the pessimistic side', () => {
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] }, FULL_AUDIT_FIXTURE);
    const f = findingFor(r, 'evil-shipped');
    expect(f.fixDisagreement).toEqual(expect.stringContaining('MAJOR'));
  });

  it('takes the WORSE severity of the two lenses, promoting into the gate', () => {
    // moderate (prod-only) vs critical (installed tree): the gate must not under-report.
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] }, FULL_AUDIT_FIXTURE);
    const f = findingFor(r, 'noisy-moderate');
    expect(f.severity).toBe('critical');
    expect(r.offenders.some((o: { name: string }) => o.name === 'noisy-moderate')).toBe(true);
  });

  it('keeps a finding the full-tree lens cannot see, instead of dropping it', () => {
    // evil-orphan is absent from FULL_AUDIT_FIXTURE. Absence from one lens must never
    // delete a finding — that would be the fail-OPEN direction.
    const r = analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] }, FULL_AUDIT_FIXTURE);
    const f = findingFor(r, 'evil-orphan');
    expect(f).toBeTruthy();
    expect(r.offenders.some((o: { name: string }) => o.name === 'evil-orphan')).toBe(true);
  });

  it('a missing second lens degrades to the single-lens reading without throwing', () => {
    expect(() => analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] }, null)).not.toThrow();
    expect(() => analyze(AUDIT_FIXTURE, LS_FIXTURE, { accepted: [] }, {})).not.toThrow();
  });
});
