/**
 * Guard test for scripts/check-rust-advisories.mjs — the P-007 Rust/native advisory gate
 * (plan security-boundary-remediation-and-usability-2026-09-04, WI-2144851).
 *
 * WHY THESE CONTROLS EXIST
 * A guard that has never failed is a guard nobody has tested. This gate's value is a
 * DISCRIMINATION between two populations that arrive on the same wire and look alike:
 * 17 "unmaintained" maintenance notices and 3 real vulnerabilities, measured over the 615
 * crates of the shipped desktop app. Over-gate and 17 unmaintained gtk-rs crates red-pin
 * the fleet; under-gate and the whole thing is a rubber stamp. Both look green from
 * outside.
 *
 * THE CENTRAL CASE IS `gates a vulnerability that carries NO severity at all`.
 * The obvious implementation copies the npm sibling and gates on high/critical CVSS. That
 * produces a gate which selects ZERO rows against real RustSec data — every RustSec
 * advisory measured on 2026-09-05 carried `severity: []` and `cvss: null` — and prints a
 * confident "0 gating". These tests pin the decision that avoids it, so a later
 * "simplification" toward the npm model fails here instead of silently disarming the gate.
 *
 * The analyzer is pure over OSV documents, so every case runs on inline fixtures: no
 * network, no npm/cargo invocation, no shared-tree mutation (the fixture tier from
 * CLAUDE.md's falsifiability table).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Enrolled in tsconfig.declarations.json, so this import is TYPED (generated sibling
// scripts/check-rust-advisories.d.mts) rather than an implicit `any` module.
import {
  analyze,
  classifyVuln,
  clusterAliases,
  countPackageHeaders,
  cvss31BaseScore,
  parseCargoLock,
  parseCargoLockStrict,
  severityLabelForScore,
  SHIPPED_LOCKFILES,
} from '../../../scripts/check-rust-advisories.mjs';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'rust-advisories-baseline.json');

const PKGS = [{ name: 'somecrate', version: '1.0.0' }];

/** A real vulnerability: no `informational` marker anywhere in affected[]. */
const VULN = {
  id: 'RUSTSEC-2026-0194',
  summary: 'Quadratic run time when checking a start tag for duplicate attribute names',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }],
  affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '0.41.0' }] }] }],
};

/**
 * A maintenance notice. IDENTICAL to VULN except for the informational marker — that is
 * what makes the pair a control rather than two unrelated fixtures.
 */
const INFORMATIONAL = {
  id: 'RUSTSEC-2024-0413',
  summary: 'gtk-rs GTK3 bindings - no longer maintained',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }],
  affected: [
    {
      database_specific: { informational: 'unmaintained' },
      ranges: [{ events: [{ introduced: '0' }, { fixed: '0.41.0' }] }],
    },
  ],
};

const run = (vulns: unknown[], accepted: string[] = [], shipped = true) =>
  analyze({
    packages: PKGS,
    vulns,
    matches: Object.fromEntries(vulns.map((v: any) => [v.id, ['somecrate@1.0.0']])),
    baseline: { accepted },
    shipped,
  });

describe('rust advisory gate: discrimination', () => {
  it('GATES a real vulnerability in a shipped crate', () => {
    const r = run([VULN]);
    expect(r.offenders.map((o: any) => o.id)).toEqual(['RUSTSEC-2026-0194']);
  });

  it('does NOT gate an "unmaintained" maintenance notice', () => {
    const r = run([INFORMATIONAL]);
    expect(r.offenders).toHaveLength(0);
    // Reported, not silently dropped — unmaintained shipped crates are real debt.
    expect(r.informationalCount).toBe(1);
  });

  it('is not vacuous: the two controls differ ONLY in the informational marker', () => {
    // If this ever fails, the two cases above stopped being a controlled comparison and
    // each could pass for reasons unrelated to the property being tested.
    const stripped = (v: any) => ({
      ...v,
      id: 'X',
      summary: '',
      affected: v.affected.map(({ database_specific: _d, ...rest }: any) => rest),
    });
    expect(stripped(VULN)).toEqual(stripped(INFORMATIONAL));
    expect(run([VULN]).offenders).toHaveLength(1);
    expect(run([INFORMATIONAL]).offenders).toHaveLength(0);
  });
});

describe('rust advisory gate: severity is not the discriminator', () => {
  it('gates a vulnerability that carries NO severity at all', () => {
    // THE regression this file exists for. MEASURED 2026-09-05: every RustSec advisory
    // over the shipped lockfile had `severity: []` / `cvss: null`. A high/critical filter
    // selects zero of them and reports a clean tree. Reachability of the bug being
    // guarded is therefore total, not hypothetical.
    const unscored = { id: 'RUSTSEC-9999-0001', affected: [{ ranges: [] }] };
    const r = run([unscored]);
    expect(r.offenders.map((o: any) => o.id)).toEqual(['RUSTSEC-9999-0001']);
    expect(r.offenders[0].severity).toBe('unknown');
  });

  it('gates a MODERATE vulnerability (no high/critical threshold is applied)', () => {
    const moderate = {
      id: 'GHSA-moderate',
      database_specific: { severity: 'MODERATE' },
      affected: [{ ranges: [] }],
    };
    expect(run([moderate]).offenders).toHaveLength(1);
  });
});

describe('rust advisory gate: alias clustering fails closed', () => {
  // MEASURED: glib@0.18.5 arrives as GHSA-wrw7-89jp-8q8g (a vulnerability, MODERATE) AND
  // RUSTSEC-2024-0429 (informational "unsound") — one defect, two databases, two verdicts.
  const GHSA = {
    id: 'GHSA-wrw7-89jp-8q8g',
    aliases: ['RUSTSEC-2024-0429'],
    database_specific: { severity: 'MODERATE' },
    affected: [{ ranges: [{ events: [{ fixed: '0.20.0' }] }] }],
  };
  const RUSTSEC = {
    id: 'RUSTSEC-2024-0429',
    aliases: ['GHSA-wrw7-89jp-8q8g'],
    affected: [{ database_specific: { informational: 'unsound' }, ranges: [] }],
  };

  it('collapses mutual aliases into ONE advisory rather than double-reporting', () => {
    expect(run([GHSA, RUSTSEC]).total).toBe(1);
  });

  it('treats the cluster as a VULNERABILITY when the databases disagree', () => {
    expect(run([GHSA, RUSTSEC]).offenders).toHaveLength(1);
  });

  it('reaches the same verdict regardless of OSV response order', () => {
    // Without union-find this flips with arrival order — a verdict that depends on a
    // third party's ordering is not a verdict.
    expect(run([GHSA, RUSTSEC]).offenders).toHaveLength(1);
    expect(run([RUSTSEC, GHSA]).offenders).toHaveLength(1);
  });

  it('unions the affected crates across every id the cluster absorbed', () => {
    const r = analyze({
      packages: PKGS,
      vulns: [GHSA, RUSTSEC],
      matches: { 'GHSA-wrw7-89jp-8q8g': ['glib@0.18.5'], 'RUSTSEC-2024-0429': ['glib@0.18.5'] },
      baseline: { accepted: [] },
    });
    expect(r.offenders[0].where).toEqual(['glib@0.18.5']);
  });

  it('a cluster of only-informational members stays informational', () => {
    const onlyInfo = { ...RUSTSEC, aliases: [] };
    expect(run([onlyInfo]).offenders).toHaveLength(0);
  });
});

describe('rust advisory gate: baseline semantics', () => {
  it('a baselined vulnerability stops gating', () => {
    expect(run([VULN], ['RUSTSEC-2026-0194']).offenders).toHaveLength(0);
  });

  it('suppresses a cluster baselined under EITHER of its alias ids', () => {
    // An entry seeded under the GHSA id must keep working after OSV starts returning the
    // RUSTSEC alias first — otherwise the baseline silently stops suppressing and the
    // gate reds on debt someone already adjudicated.
    const a = { id: 'GHSA-1', aliases: ['RUSTSEC-1'], affected: [{ ranges: [] }] };
    const b = { id: 'RUSTSEC-1', aliases: ['GHSA-1'], affected: [{ ranges: [] }] };
    expect(run([a, b], ['GHSA-1']).offenders).toHaveLength(0);
    expect(run([a, b], ['RUSTSEC-1']).offenders).toHaveLength(0);
  });

  it('reports a baseline entry whose advisory is gone as STALE (shrink-only pressure)', () => {
    expect(run([VULN], ['RUSTSEC-2026-0194', 'RUSTSEC-GONE']).stale).toEqual(['RUSTSEC-GONE']);
  });
});

describe('rust advisory gate: fails closed on a measurement gap', () => {
  it('refuses to report all-clear when zero crates were scanned', () => {
    // The "instrument measured nothing" failure: an empty scan must not render as clean.
    expect(() => analyze({ packages: [], vulns: [], matches: {}, baseline: { accepted: [] } })).toThrow(
      /RUST_ADVISORY_GATE_UNDETERMINED/,
    );
  });

  it('refuses a Cargo.lock whose [[package]] count and parsed count disagree', () => {
    // A partial parse scanned a subset and would report it as the whole graph.
    const truncated = '[[package]]\nname = "a"\nversion = "1"\n\n[[package]]\nname = "b"\n';
    expect(countPackageHeaders(truncated)).toBe(2);
    expect(parseCargoLock(truncated)).toHaveLength(1);
    expect(() => parseCargoLockStrict(truncated, 'fixture')).toThrow(/RUST_ADVISORY_GATE_UNDETERMINED/);
  });

  it('refuses an empty lockfile rather than reporting a clean graph', () => {
    expect(() => parseCargoLockStrict('# no packages here\n', 'fixture')).toThrow(
      /RUST_ADVISORY_GATE_UNDETERMINED/,
    );
  });

  it('does not gate on a lockfile that is not a shipped artifact', () => {
    const r = run([VULN], [], false);
    expect(r.offenders).toHaveLength(0);
    // ...but still reports it, so a vendored/dev lockfile is visible rather than invisible.
    expect(r.vulnerabilities).toHaveLength(1);
  });
});

describe('rust advisory gate: CVSS v3.1 scoring', () => {
  it('scores the measured quick-xml vector at 7.5 / high', () => {
    const s = cvss31BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H');
    expect(s).toBe(7.5);
    expect(severityLabelForScore(s)).toBe('high');
  });

  it('scores a fully-critical scope-changed vector at 10.0', () => {
    expect(cvss31BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H')).toBe(10);
    expect(severityLabelForScore(10)).toBe('critical');
  });

  it('returns null for a malformed vector instead of a plausible number', () => {
    expect(cvss31BaseScore('CVSS:3.1/AV:N')).toBeNull();
    expect(severityLabelForScore(null)).toBe('unknown');
  });

  it('reads `informational` from affected[], not the document root', () => {
    // Reading only the top level classifies every unmaintained notice as a vulnerability.
    expect(classifyVuln(INFORMATIONAL).informational).toBe('unmaintained');
    expect(classifyVuln(VULN).informational).toBeNull();
  });

  it('surfaces the fixed version a reviewer needs to judge patchability', () => {
    expect(classifyVuln(VULN).fixedVersions).toEqual(['0.41.0']);
  });

  it('drops a WITHDRAWN advisory instead of gating on a retracted claim', () => {
    expect(run([{ ...VULN, withdrawn: '2026-01-01T00:00:00Z' }]).offenders).toHaveLength(0);
  });
});

describe('rust advisory gate: real shipped lockfile', () => {
  const lockPath = join(REPO_ROOT, SHIPPED_LOCKFILES[0]);
  const text = readFileSync(lockPath, 'utf8');

  it('parses every [[package]] table in the real shipped Cargo.lock', () => {
    // A real-file control: the inline fixtures above are all small and regular, so only
    // this case can catch a parser that works on toys and under-reads production input.
    const parsed = parseCargoLockStrict(text, SHIPPED_LOCKFILES[0]);
    expect(parsed.length).toBe(countPackageHeaders(text));
    expect(parsed.length).toBeGreaterThan(500);
    expect(parsed.every((p: any) => p.name && p.version)).toBe(true);
  });

  it('does not mistake a dependency list entry for a package', () => {
    // Cargo.lock dependency entries are ` "name 1.2.3",` lines inside the same block; an
    // unanchored regex swallows them and inflates the graph.
    const parsed = parseCargoLock(text);
    expect(parsed.some((p: any) => p.name.includes(' '))).toBe(false);
  });
});

describe('rust advisory baseline file integrity', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  it('every accepted advisory carries a stated reason', () => {
    for (const id of baseline.accepted) {
      expect(baseline.entries[id], `${id} is accepted with no entry`).toBeTruthy();
      expect(String(baseline.entries[id].reason ?? '').length).toBeGreaterThan(80);
    }
  });

  it('has no orphan entries (entry present but not accepted)', () => {
    for (const id of Object.keys(baseline.entries)) {
      expect(baseline.accepted, `${id} has an entry but is not accepted`).toContain(id);
    }
  });

  it('every entry declares a known disposition', () => {
    const known = new Set(['patch-available-unverified', 'pinned-for-abi']);
    for (const [id, e] of Object.entries<{ disposition: string }>(baseline.entries)) {
      expect(known.has(e.disposition), `${id} has unknown disposition ${e.disposition}`).toBe(true);
    }
  });

  it('a patch-available entry names the fixed version and why it is not yet applied', () => {
    for (const [id, e] of Object.entries<{ disposition: string; reason: string; fixedIn?: string }>(
      baseline.entries,
    )) {
      if (e.disposition !== 'patch-available-unverified') continue;
      expect(e.fixedIn, `${id} does not name a fixed version`).toBeTruthy();
      expect(/verif|build|cold|submodule/i.test(e.reason), `${id} does not say why it is unapplied`).toBe(true);
    }
  });

  it('only non-informational advisories are baselined', () => {
    // The baseline must never accumulate unmaintained notices: they never gate, so an
    // entry for one is pure noise that makes the file look like a parking lot.
    for (const id of baseline.accepted) {
      expect(baseline.entries[id].severity, `${id} has no severity`).toBeTruthy();
    }
  });
});

describe('rust advisory baseline: an ABI-pin deferral is only as good as its premise', () => {
  // WHY THIS EXISTS — THE ONE DEFERRAL NO OTHER CHECK CAN EXPIRE
  //
  // `pinned-for-abi` is the only disposition that defers a REAL vulnerability with no end
  // date, and it does so on a claim about the SHIPPED GRAPH rather than about the advisory:
  // "there is exactly ONE glib in this process, on the 0.18 line tauri/wry already use, so
  // bumping ours alone would split the GTK/glib ABI" (D-009, the embedded native terminal
  // view). That premise is the entire justification — and nothing was checking it.
  //
  // Every other pressure on this file is blind to it. The gate reports a baselined advisory
  // as STALE only once the advisory stops MATCHING, and glib 0.18.5 stays vulnerable whether
  // or not the rest of the graph moves — so the day tauri/wry advance to the glib 0.20 line
  // (the entry's own stated trigger to bump the pin WITH them) the gate says nothing, the
  // baseline keeps asserting a premise that has stopped being true, and the tree looks
  // exactly as it did the day before. A deferral whose expiry condition nobody can observe
  // is indistinguishable from a permanent one.
  //
  // The check is a PREMISE check, not a version pin, and it fails in both directions that
  // mean something:
  //   • the named crate resolves at MORE THAN ONE version — the single-ABI premise is broken
  //     RIGHT NOW, which is the concrete hazard the pin exists to prevent, not a paperwork
  //     problem; and
  //   • the named crate@version is ABSENT — the pin already moved, so the reason recorded in
  //     the baseline describes a tree that no longer exists and the deferral must be re-made.
  // It is derived from the baseline's own entries rather than naming glib, so a future
  // pinned-for-abi entry is covered on the day it is written instead of the day someone
  // remembers to extend this file.
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const shipped = SHIPPED_LOCKFILES.flatMap((rel: string) =>
    parseCargoLock(readFileSync(join(REPO_ROOT, rel), 'utf8')),
  );
  const abiPinned = Object.entries<{ disposition: string; crate?: string }>(
    baseline.entries,
  ).filter(([, e]) => e.disposition === 'pinned-for-abi');

  it('names a concrete crate@version for every ABI-pinned deferral', () => {
    // The premise check below can only run on an entry that says WHICH crate was pinned;
    // without it the deferral is unfalsifiable prose.
    for (const [id, e] of abiPinned) {
      expect(e.crate, `${id} defers on an ABI pin without naming the crate`).toMatch(
        /^[^@\s]+@\d+\.\d+/,
      );
    }
  });

  /**
   * The premise comparison itself, over supplied data — so the real-tree case and the
   * deliberately-broken controls below run the SAME code. A guard that has only ever been
   * run against a passing tree has not been shown to fail; these controls are how that stays
   * true without mutating the shared checkout (CLAUDE.md's fixture tier).
   */
  function abiPinPremise(
    entries: [string, { crate?: string }][],
    packages: { name: string; version: string }[],
  ): { expected: Record<string, string[]>; actual: Record<string, string[]> } {
    const expected: Record<string, string[]> = {};
    const actual: Record<string, string[]> = {};
    for (const [id, e] of entries) {
      const [name, version] = String(e.crate).split('@');
      expected[id] = [version];
      actual[id] = packages
        .filter((p) => p.name === name)
        .map((p) => p.version)
        .sort();
    }
    return { expected, actual };
  }

  const PINNED_FIXTURE: [string, { crate?: string }][] = [['RUSTSEC-0000-0000', { crate: 'lib@1.0.0' }]];

  it('CONTROL: catches the crate resolving at two versions (the ABI split itself)', () => {
    const { expected, actual } = abiPinPremise(PINNED_FIXTURE, [
      { name: 'lib', version: '1.0.0' },
      { name: 'lib', version: '2.0.0' },
    ]);
    expect(actual).not.toEqual(expected);
  });

  it('CONTROL: catches the pinned crate/version disappearing (the pin already moved)', () => {
    const { expected, actual } = abiPinPremise(PINNED_FIXTURE, [{ name: 'lib', version: '2.0.0' }]);
    expect(actual).not.toEqual(expected);
  });

  it('CONTROL: does NOT fire on the single-version tree the deferral describes', () => {
    // Calibration. Without this, both controls above would also "pass" if the comparison
    // were broken in a way that never matches anything.
    const { expected, actual } = abiPinPremise(PINNED_FIXTURE, [
      { name: 'lib', version: '1.0.0' },
      { name: 'unrelated', version: '9.9.9' },
    ]);
    expect(actual).toEqual(expected);
  });

  it('still resolves each ABI-pinned crate at exactly one version — the pin premise holds', () => {
    const { expected, actual } = abiPinPremise(abiPinned, shipped);
    expect(
      actual,
      'an ABI-pinned crate no longer resolves at exactly the pinned version. TWO versions = ' +
        'the single-ABI premise is broken now: re-make the pin decision, do not just update ' +
        'this file. NONE / a different version = the pin already moved, so re-evaluate the ' +
        'deferral in scripts/rust-advisories-baseline.json and drop the entry if the advisory ' +
        'is fixed.',
    ).toEqual(expected);
  });
});
