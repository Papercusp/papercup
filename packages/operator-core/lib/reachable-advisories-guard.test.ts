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
import {
  analyze,
  attributeAdvisories,
  collectInstalledVersions,
  deriveFixFeasibility,
  isNonShipping,
  measureJson,
} from '../../../scripts/check-reachable-advisories.mjs';

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

/**
 * `range` is LOAD-BEARING on evil-shipped, not decoration — do not drop it.
 *
 * A real `npm audit` record always carries the vulnerable range, and `deriveFixFeasibility`
 * now reads it: `^1.0.0` is NOT a subset of `<=1.0.0`, so a semver-compatible escape exists
 * and the single-lens reading stays patch-compatible. Strip the range and the derivation
 * degrades to UNDETERMINED, which fails closed to patchCompatible:false — turning the
 * "is not vacuous" control below into a control that cannot fail, since both halves of its
 * discrimination would then read false for entirely unrelated reasons.
 */
const AUDIT_FIXTURE = {
  vulnerabilities: {
    'evil-shipped': { severity: 'high', fixAvailable: true, range: '<=1.0.0' },
    'evil-testonly': { severity: 'high', fixAvailable: true, range: '<=1.0.0' },
    'evil-orphan': { severity: 'critical', fixAvailable: false, range: '<=1.0.0' },
    'noisy-moderate': { severity: 'moderate', fixAvailable: true, range: '<=1.0.0' },
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

/**
 * WI-2144851 — fix feasibility DERIVED from the advisory range, not read off `fixAvailable`.
 *
 * WHY THIS BLOCK EXISTS. The two-lens reconciliation above only bites when npm returns
 * `fixAvailable` as an OBJECT carrying `isSemVerMajor`; when npm returns the BARE BOOLEAN
 * `true`, there is no version to compare and BOTH lenses read "patch-compatible". That is
 * not hypothetical: on 2026-09-05 style-dictionary's npm record moved from
 * `{version:5.5.2, isSemVerMajor:true}` to the range `4.3.0 - 5.4.3` plus a bare `true`
 * within hours, and an entry that had just been hand-CORRECTED silently reverted to reading
 * patch-compatible with nothing failing anywhere. Keying a fix on the SHAPE of a third
 * party's payload gives it an expiry date; `deriveFixFeasibility` keys on the invariant the
 * advisory itself owns — is `^installed` a semver SUBSET of the vulnerable range?
 *
 * The three ground-truth rows below were verified against the published registry the same
 * day, so they are measurements, not illustrations.
 */
describe('reachable-advisory gate: derived fix feasibility', () => {
  it('the derivation is actually running — semver is resolvable from the gate script', () => {
    // Calibration. `deriveFixFeasibility` degrades to UNDETERMINED when `semver` cannot be
    // required (it is a hoisted transitive, not a declared dependency). Without this control
    // a hoist reshuffle would turn EVERY case below into a vacuous "undetermined" pass, and
    // the suite would stay green while the derivation measured nothing at all.
    const probe = deriveFixFeasibility('<=1.0.0', ['1.0.0']);
    expect(probe.verdict, `semver unavailable to the gate: ${probe.reason}`).not.toBe('undetermined');
  });

  it('^installed INSIDE the vulnerable range requires a major bump (style-dictionary 4.4.0)', () => {
    const r = deriveFixFeasibility('4.3.0 - 5.4.3', ['4.4.0']);
    expect(r.verdict).toBe('requires-major');
    expect(r.reason).toContain('^4.4.0');
    expect(r.vulnerableCopies).toEqual(['4.4.0']);
  });

  it('^installed reaching PAST the vulnerable range is escapable (lodash-es 4.17.21)', () => {
    // ^4.17.21 admits 4.18.1, which is outside `<=4.17.23` — a compatible escape exists.
    const r = deriveFixFeasibility('<=4.17.23', ['4.17.21']);
    expect(r.verdict).toBe('escapable');
  });

  it('is not vacuous: the same installed version flips verdict on the range alone', () => {
    // The discrimination that makes the two cases above meaningful. Identical input except
    // the range; a derivation that ignored the range could not produce both answers.
    expect(deriveFixFeasibility('<=4.17.23', ['4.17.21']).verdict).toBe('escapable');
    // `<5.0.0` swallows the WHOLE of `^4.17.21` (= `>=4.17.21 <5.0.0`), so only a major
    // bump escapes. Note `<=4.99.0` would NOT do this — 4.99.1 is compatible and outside
    // it — which is exactly why the derivation has to ask semver instead of eyeballing
    // whether the range "looks like it covers" the installed version.
    expect(deriveFixFeasibility('<5.0.0', ['4.17.21']).verdict).toBe('requires-major');
  });

  it('traps the 0.x case, where a MINOR bump is already breaking (langsmith 0.3.87)', () => {
    // `^0.3.87` collapses to `>=0.3.87 <0.4.0` under semver's 0.x rule, so it cannot reach
    // past `<=0.5.26`. A naive "the range ends below some newer version, so patch it"
    // reading calls this escapable; it is not.
    expect(deriveFixFeasibility('<=0.5.26', ['0.3.87']).verdict).toBe('requires-major');
  });

  it('only copies actually IN the range vote — a clean sibling cannot excuse a trapped one', () => {
    // Both copies installed; only 4.4.0 is vulnerable. The clean 5.9.0 must not make the
    // trapped copy look escapable just by existing in the tree.
    const r = deriveFixFeasibility('4.3.0 - 5.4.3', ['4.4.0', '5.9.0']);
    expect(r.verdict).toBe('requires-major');
    expect(r.vulnerableCopies).toEqual(['4.4.0']);
  });

  describe('unmeasurable inputs are UNDETERMINED, never the optimistic reading', () => {
    it('an advisory with no range', () => {
      expect(deriveFixFeasibility('', ['1.0.0']).verdict).toBe('undetermined');
    });

    it('a range semver cannot parse', () => {
      expect(deriveFixFeasibility('not-a-range', ['1.0.0']).verdict).toBe('undetermined');
    });

    it('a package absent from the installed tree', () => {
      expect(deriveFixFeasibility('<=1.0.0', []).verdict).toBe('undetermined');
    });

    it('an advisory whose range no installed copy satisfies', () => {
      // npm says vulnerable, the tree says otherwise. That contradiction is a measurement
      // gap, not a clean bill of health.
      expect(deriveFixFeasibility('<=1.0.0', ['9.9.9']).verdict).toBe('undetermined');
    });
  });

  describe('collectInstalledVersions', () => {
    it('finds a NESTED vulnerable copy the hoisted clean one would hide', () => {
      // The measured langsmith shape: 0.8.7 hoisted (clean), 0.3.87 nested under a
      // dependency (vulnerable). Reading only the hoisted copy answers about the wrong
      // object — and in the fail-OPEN direction.
      const ls = {
        dependencies: {
          '@papercusp/web': {
            resolved: 'file:apps/web',
            dependencies: {
              langsmith: { version: '0.8.7' },
              stagehand: { version: '3.4.0', dependencies: { langsmith: { version: '0.3.87' } } },
            },
          },
        },
      };
      const got = collectInstalledVersions(ls, ['langsmith']);
      expect(got.get('langsmith')).toEqual(['0.3.87', '0.8.7']);
    });

    it('walks a workspace that npm ls ALSO emits as a bare dedupe stub elsewhere', () => {
      // MEASURED IN THIS REPO 2026-09-05. `npm ls --omit=dev --all --json` emits a
      // workspace in TWO forms: a bare dedupe STUB ({ version } only — no `resolved`,
      // no `dependencies`) under every workspace that depends on it, and ONCE in full
      // ({ version, resolved, dependencies }). Object key order decides which is met
      // first, and here the stub is.
      //
      // A cycle guard keyed on name@version therefore marks `@papercusp/testing-shell
      // @0.0.1` seen on a stub that contributes NOTHING, then skips the POPULATED
      // occurrence and drops that workspace's whole production subtree. That is not a
      // pathological cycle — it is the ordinary shape of a monorepo whose workspaces
      // depend on each other.
      //
      // It fails OPEN: langsmith 0.3.87 (vulnerable, nested under stagehand) lived in
      // exactly that dropped subtree, so the gate collected only the hoisted 0.8.7 and
      // reported "no installed copy satisfies the vulnerable range" — which reads as
      // reassurance. The pre-existing nested-copy test above does NOT catch this,
      // because its nested copy sits on a path with no previously-seen ancestor.
      const ls = {
        dependencies: {
          '@papercusp/operator-vite': {
            version: '0.0.1',
            resolved: 'file:apps/operator-vite',
            // The dedupe stub — met first, carries no dependencies of its own.
            dependencies: { '@papercusp/testing-shell': { version: '0.0.1' } },
          },
          '@papercusp/testing-shell': {
            version: '0.0.1',
            resolved: 'file:libs/testing-shell',
            dependencies: {
              stagehand: { version: '3.4.0', dependencies: { langsmith: { version: '0.3.87' } } },
            },
          },
          '@papercusp/web': {
            version: '0.0.1',
            resolved: 'file:apps/web',
            dependencies: { langsmith: { version: '0.8.7' } },
          },
        },
      };
      expect(collectInstalledVersions(ls, ['langsmith']).get('langsmith')).toEqual([
        '0.3.87',
        '0.8.7',
      ]);
    });

    it('still collects from a stub-shadowed subtree when the stub is met LAST', () => {
      // Calibration control for the case above: same graph, opposite key order, so the
      // populated node is met first. This one passes even with the defective guard —
      // it is here so a future reader can tell that the failing case above is about
      // ENCOUNTER ORDER, not about stubs existing at all.
      const ls = {
        dependencies: {
          '@papercusp/testing-shell': {
            version: '0.0.1',
            resolved: 'file:libs/testing-shell',
            dependencies: {
              stagehand: { version: '3.4.0', dependencies: { langsmith: { version: '0.3.87' } } },
            },
          },
          '@papercusp/operator-vite': {
            version: '0.0.1',
            resolved: 'file:apps/operator-vite',
            dependencies: { '@papercusp/testing-shell': { version: '0.0.1' } },
          },
        },
      };
      expect(collectInstalledVersions(ls, ['langsmith']).get('langsmith')).toEqual(['0.3.87']);
    });

    it('terminates on a cyclic dependency graph', () => {
      const a: Record<string, unknown> = { version: '1.0.0' };
      const b = { version: '2.0.0', dependencies: { a } };
      a.dependencies = { b };
      expect(() => collectInstalledVersions({ dependencies: { a } }, ['a', 'b'])).not.toThrow();
    });

    it('ignores packages nobody filed an advisory for', () => {
      expect(collectInstalledVersions(LS_FIXTURE, ['evil-shipped']).has('evil-testonly')).toBe(false);
    });
  });

  describe('the derivation overrides a bare-boolean fixAvailable inside analyze()', () => {
    // The exact shape the two-lens reconciliation is structurally blind to: a bare `true`
    // from BOTH lenses, so nothing to compare, while the range traps every compatible
    // version. This is the regression that silently reverted a corrected classification.
    const trappedLs = {
      dependencies: {
        '@papercusp/web': {
          resolved: 'file:apps/web',
          dependencies: { 'trapped-major': { version: '4.4.0' } },
        },
      },
    };
    const trappedAudit = {
      vulnerabilities: {
        'trapped-major': { severity: 'high', fixAvailable: true, range: '4.3.0 - 5.4.3' },
      },
    };

    it('refuses to call a trapped advisory patch-compatible', () => {
      const f = findingFor(analyze(trappedAudit, trappedLs, { accepted: [] }, trappedAudit), 'trapped-major');
      expect(f.patchCompatible).toBe(false);
      expect(f.disposition).toBe('deferred-semver-major');
      expect(f.fixFeasibility.verdict).toBe('requires-major');
    });

    it('is not vacuous: widening the range alone makes the SAME finding patch-eligible', () => {
      // Identical fixture but for the range, and both lenses still say a bare `true`. If
      // the derivation were inert, these two cases could not disagree.
      const escapableAudit = {
        vulnerabilities: {
          'trapped-major': { severity: 'high', fixAvailable: true, range: '<=4.4.0' },
        },
      };
      const f = findingFor(analyze(escapableAudit, trappedLs, { accepted: [] }, escapableAudit), 'trapped-major');
      expect(f.patchCompatible).toBe(true);
      expect(f.disposition).toBe('patch-eligible');
    });

    it('names the contradiction instead of quietly downgrading it', () => {
      const f = findingFor(analyze(trappedAudit, trappedLs, { accepted: [] }, trappedAudit), 'trapped-major');
      expect(f.fixDisagreement).toEqual(expect.stringContaining('fixAvailable:true'));
    });

    it('ESCAPABLE alone is not a fix — a lens reporting a MAJOR still defers (the d3 shape)', () => {
      // The asymmetry, pinned. `requires-major` is a proof; `escapable` is only the absence
      // of that proof and says nothing about what the registry PUBLISHED. Measured
      // 2026-09-05: ^6.7.0 is not a subset of d3's range, yet the only real fix is 7.x. If
      // `escapable` were ever allowed to imply patch-eligible on its own, this defers-
      // correctly case would flip to "just patch it" and the advice would be unfollowable.
      const escapableRangeMajorFix = {
        vulnerabilities: {
          'trapped-major': {
            severity: 'high',
            range: '<=4.4.0',
            fixAvailable: { name: 'trapped-major', version: '7.9.0', isSemVerMajor: true },
          },
        },
      };
      const f = findingFor(
        analyze(escapableRangeMajorFix, trappedLs, { accepted: [] }, escapableRangeMajorFix),
        'trapped-major',
      );
      expect(f.fixFeasibility.verdict).toBe('escapable');
      expect(f.patchCompatible).toBe(false);
      expect(f.disposition).toBe('deferred-semver-major');
    });

    describe('the derivation POLICES the curated baseline disposition rather than replacing it', () => {
      // Rung 2 of the derived-truth ladder. The stored disposition stays curated because
      // the derivation can be blind (a dev-only-reachable vulnerable copy is invisible to
      // the prod `npm ls` tree — the measured langsmith case), so a blind re-seed would
      // downgrade a correct human judgment to "unknown". Instead it must POLICE it, and
      // the two failure kinds must stay distinguishable.
      const baselineSaying = (disposition: string) => ({
        accepted: ['trapped-major'],
        entries: { 'trapped-major': { disposition } },
      });

      it('CONTRADICTED when the derivation measured something and disagrees', () => {
        const r = analyze(trappedAudit, trappedLs, baselineSaying('patch-eligible'), trappedAudit);
        expect(r.dispositionDrift).toHaveLength(1);
        expect(r.dispositionDrift[0]).toMatchObject({
          name: 'trapped-major',
          stored: 'patch-eligible',
          derived: 'deferred-semver-major',
          kind: 'contradicted',
        });
      });

      it('UNCORROBORATED — not contradicted — when the derivation could not measure at all', () => {
        // The distinction this whole block exists for: "I cannot tell" must never be
        // rendered as "the entry is wrong", or an instrument gap becomes pressure to
        // rewrite a correct entry.
        const unmeasurable = {
          vulnerabilities: { 'trapped-major': { severity: 'high', fixAvailable: true, range: 'sometime-after-4' } },
        };
        const r = analyze(unmeasurable, trappedLs, baselineSaying('deferred-semver-major'), unmeasurable);
        expect(r.dispositionDrift[0].kind).toBe('uncorroborated');
      });

      it('is silent when the derivation and the curated entry agree', () => {
        const r = analyze(trappedAudit, trappedLs, baselineSaying('deferred-semver-major'), trappedAudit);
        expect(r.dispositionDrift).toEqual([]);
      });

      it('never invents drift for an entry that states no disposition', () => {
        const r = analyze(trappedAudit, trappedLs, { accepted: ['trapped-major'], entries: {} }, trappedAudit);
        expect(r.dispositionDrift).toEqual([]);
      });
    });

    it('an UNDETERMINED derivation fails closed rather than inheriting the lens verdict', () => {
      // npm says patch-compatible; the range is unparseable so nothing can confirm it. The
      // gate must not take npm's word for it — that is the whole point of the third verdict.
      const unparseable = {
        vulnerabilities: {
          'trapped-major': { severity: 'high', fixAvailable: true, range: 'sometime-after-4' },
        },
      };
      const f = findingFor(analyze(unparseable, trappedLs, { accepted: [] }, unparseable), 'trapped-major');
      expect(f.fixFeasibility.verdict).toBe('undetermined');
      expect(f.patchCompatible).toBe(false);
      expect(f.disposition).toBe('undetermined');
    });
  });
});

/**
 * WI-2144851 — the THIRD verdict: UNDETERMINED.
 *
 * `npm audit` is the one input to this gate that needs the network, and once the gate is
 * wired into the fleet green-checkpoint a registry blip has two wrong readings, both of
 * which look like a well-formed answer:
 *
 *   - read as CLEAN — an empty result from a bounded instrument taken as a negative
 *     finding, the failure this repo names everywhere; or
 *   - read as an ordinary RED — which red-pins `main` for the whole fleet and reads to the
 *     triager exactly like "a new shipping high/critical advisory landed". The response to
 *     that is "patch a dependency"; the response to a blip is "re-run". Indistinguishable
 *     inputs producing opposite correct actions is the defect.
 *
 * So measureJson() retries the transient case and, if it still cannot measure, fails CLOSED
 * with a message leading `ADVISORY_GATE_UNDETERMINED`. The controls below are a matched
 * set: without the empty-output case, a `{}` default would satisfy every other assertion
 * here while silently restoring the "blank reads as no advisories" behaviour.
 */
describe('reachable-advisory gate: undetermined vs clean vs red', () => {
  const noSleep = () => {};

  it('parses a first-attempt success without retrying', () => {
    let calls = 0;
    const r = measureJson(
      'probe',
      () => {
        calls++;
        return '{"ok":1}';
      },
      { sleep: noSleep },
    );
    expect(r).toEqual({ ok: 1 });
    expect(calls).toBe(1);
  });

  it('reads stdout from a NON-ZERO npm exit — advisories present is the expected case', () => {
    const r = measureJson(
      'probe',
      () => {
        const err = new Error('npm exited 1') as Error & { stdout?: string };
        err.stdout = '{"vulnerabilities":{}}';
        throw err;
      },
      { sleep: noSleep },
    );
    expect(r).toEqual({ vulnerabilities: {} });
  });

  it('RETRIES a transient failure and succeeds — not vacuous: the first attempt really failed', () => {
    let calls = 0;
    const slept: number[] = [];
    const r = measureJson(
      'probe',
      () => {
        calls++;
        if (calls < 3) throw new Error('ETIMEDOUT');
        return '{"recovered":true}';
      },
      { sleep: (ms: number) => slept.push(ms), delaysMs: [7, 11] },
    );
    expect(r).toEqual({ recovered: true });
    expect(calls).toBe(3);
    expect(slept).toEqual([7, 11]);
  });

  it('an unmeasurable input is UNDETERMINED, never an empty/clean reading', () => {
    expect(() => measureJson('npm audit', () => '', { sleep: noSleep, attempts: 2 })).toThrow(
      /ADVISORY_GATE_UNDETERMINED/,
    );
    expect(() => measureJson('npm audit', () => 'not json at all', { sleep: noSleep, attempts: 2 })).toThrow(
      /ADVISORY_GATE_UNDETERMINED/,
    );
  });

  it('says WHICH measurement failed and that re-running is the fix, not patching a dependency', () => {
    let message = '';
    try {
      measureJson('npm audit (full tree)', () => '', { sleep: noSleep, attempts: 2 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('npm audit (full tree)');
    expect(message).toContain('2 attempt(s)');
    expect(message).toContain('MEASUREMENT failure, not an advisory finding');
    expect(message).toContain('Re-run the gate');
  });

  it('stops after the configured attempt budget instead of retrying forever', () => {
    let calls = 0;
    expect(() =>
      measureJson(
        'probe',
        () => {
          calls++;
          return '';
        },
        { sleep: noSleep, attempts: 4 },
      ),
    ).toThrow(/ADVISORY_GATE_UNDETERMINED/);
    expect(calls).toBe(4);
  });
});
