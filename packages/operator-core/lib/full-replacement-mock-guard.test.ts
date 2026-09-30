/**
 * Guard for WI-7187 — a bare `vi.mock('<mod>', () => ({ ... }))` factory enumerates only the
 * exports its subject imports TODAY, so adding any export to a heavily-mocked module silently
 * strands every such factory. Vitest 4 validates the mock against the importer's named-import
 * surface at LINK time, so the failure surfaces at the fleet green-checkpoint hours later,
 * in files the author never touched. Third occurrence of this class here (WI-7185, and an
 * earlier `resolveSpawnBackendModel` round).
 *
 * The fix is structural, not a patch: spread the real module via importOriginal and override
 * only what the test controls. That form is immune to new exports BY CONSTRUCTION, and 6
 * factories in this tree already used it before WI-7187 converted the other 27.
 *
 * This file is also the GATING mechanism for `npm run lint:full-replacement-mocks`: the checker
 * is a root script, and root scripts route to @papercusp/operator-core for affected-test
 * selection (EI-19346163916263067), so running it here is what puts it in front of the gate.
 *
 * Two layers on purpose:
 *   1. the pure analyzer against SYNTHETIC fixtures — proves the guard has TEETH. A guard whose
 *      only evidence is "0 violations on a tree with 0 violations" proves nothing; it would pass
 *      just as happily with its condition inverted.
 *   2. the live tree — the actual invariant we are protecting.
 *
 * ⚠ The fixtures deliberately live in the CHECKER, not here. A fixture is mock source text, so
 * holding one in a `.test.ts` makes this file a test file containing a bare `vi.mock` of a
 * protected module — the live scan below then flags its own guard test. That happened while
 * building this. Import them; do not inline new ones.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeMockCalls,
  checkFile,
  checkOrgPgSqlDoubles,
  analyzeOrgPgSqlDoubles,
  collectCandidateFiles,
  exposureCensus,
  printExposureNote,
  readAllFiles,
  resolveSpec,
  selectCandidates,
  PROTECTED_MODULES,
  FIXTURE_PROTECTED,
  EXPOSURE_FIXTURES,
  SELF_TESTS,
  ORG_PG_MODULE,
  ORG_PG_SQL_SELF_TESTS,
} from '../../../scripts/check-full-replacement-mocks.mjs';

const ROOT = join(import.meta.dirname, '../../..');
type Fixture = { name: string; path: string; text: string; expect: number };
type OrgFixture = Fixture;

describe('full-replacement mock guard: the analyzer has teeth (WI-7187)', () => {
  it.each(SELF_TESTS as Fixture[])('$name', (t: Fixture) => {
    expect(
      checkFile({ path: t.path, text: t.text, protectedModules: FIXTURE_PROTECTED }),
    ).toHaveLength(t.expect);
  });

  it('covers both directions — at least one fixture FIRES and one stays SILENT', () => {
    // Without this, deleting every firing fixture would leave the suite green while proving
    // nothing. The silent cases are equally load-bearing: measured 2026-08-03, 1,007 internal
    // modules have >=1 full-replacement mocker and a blanket rule would flag 2,827 files, so a
    // guard that shouted at all of them would be ignored — and would then miss the real one.
    const fixtures = SELF_TESTS as Fixture[];
    expect(fixtures.filter((t) => t.expect > 0).length).toBeGreaterThan(0);
    expect(fixtures.filter((t) => t.expect === 0).length).toBeGreaterThan(0);
  });

  it('classifies each factory form and resolves specifiers to module identities', () => {
    const forms = analyzeMockCalls(SELF_TESTS.map((t: Fixture) => t.text).join('\n')).map(
      (c: { form: string }) => c.form,
    );
    expect(new Set(forms)).toEqual(new Set(['automock', 'full-replacement', 'import-actual']));
    // A relative specifier means a different module from each directory, so it is
    // resolved against the mocking file (extensionless, repo-relative).
    expect(resolveSpec('a/b/x.test.ts', './y')).toBe('a/b/y');
    expect(resolveSpec('a/b/x.test.ts', '../y.ts')).toBe('a/y');
    // A bare package specifier is ALREADY a global identity and is returned verbatim
    // (WI-39707): returning null here made every package-mocking factory invisible to
    // the guard — the population where every measured incident actually happened.
    expect(resolveSpec('a/b/x.test.ts', 'vitest')).toBe('vitest');
    // Sub-path exports stay distinct identities — never collapsed onto the package root.
    expect(resolveSpec('a/b/x.test.ts', '@papercusp/flags/server')).toBe('@papercusp/flags/server');
  });
});

describe('db-org SQL-shape guard: the analyzer has teeth (WI-40234)', () => {
  it.each(ORG_PG_SQL_SELF_TESTS as OrgFixture[])('$name', (t: OrgFixture) => {
    expect(checkOrgPgSqlDoubles(t)).toHaveLength(t.expect);
  });

  it('covers both directions — at least one fixture FIRES and one stays SILENT', () => {
    const fixtures = ORG_PG_SQL_SELF_TESTS as OrgFixture[];
    expect(fixtures.filter((t) => t.expect > 0).length).toBeGreaterThan(0);
    expect(fixtures.filter((t) => t.expect === 0).length).toBeGreaterThan(0);
  });

  it('runs both guard families through the executable --self-test path', () => {
    const out = execFileSync('node', ['scripts/check-full-replacement-mocks.mjs', '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(out).toMatch(/full-replacement mock self-tests passed/);
    expect(out).toMatch(/org-pg sql self-tests passed/);
  });
});

describe('full-replacement mock guard: the verdict states its own scope (EI-20836231573383362)', () => {
  const F = EXPOSURE_FIXTURES as Record<string, { path: string; text: string }>;

  it('counts a bare factory on an UNPROTECTED module as exposure the check did not cover', () => {
    const exposure = exposureCensus({
      files: [F.bareOnUnprotected],
      protectedModules: FIXTURE_PROTECTED,
    });
    expect(exposure.modules).toBe(1);
    expect(exposure.pairs).toBe(1);
    expect(exposure.top[0].module).toBe('@papercusp/db-org');
    // It is exposure precisely BECAUSE checkFile stays silent on it — the two must agree.
    expect(
      checkFile({ ...F.bareOnUnprotected, protectedModules: FIXTURE_PROTECTED }),
    ).toHaveLength(0);
  });

  it('does NOT count a PROTECTED module as exposure — that half is genuinely checked', () => {
    const exposure = exposureCensus({
      files: [F.bareOnProtected],
      protectedModules: FIXTURE_PROTECTED,
    });
    expect(exposure.modules).toBe(0);
    expect(checkFile({ ...F.bareOnProtected, protectedModules: FIXTURE_PROTECTED })).toHaveLength(1);
  });

  it('does NOT count the safe import-actual spread — it cannot strand, so it is not exposure', () => {
    expect(
      exposureCensus({ files: [F.safeSpreadOnUnprotected], protectedModules: FIXTURE_PROTECTED })
        .modules,
    ).toBe(0);
  });

  it('renders a non-zero exposure as an explicit NON-all-clear', () => {
    const note = printExposureNote(
      exposureCensus({ files: [F.bareOnUnprotected], protectedModules: FIXTURE_PROTECTED }),
    );
    expect(note).toContain('NOT a tree-wide all-clear');
    expect(note).toContain('@papercusp/db-org');
  });

  it('CALIBRATION: a genuinely-zero exposure renders as an all-clear, not the warning', () => {
    // Without this the test above passes even if printExposureNote returned the warning
    // unconditionally — i.e. if the scope note were boilerplate rather than a measurement.
    // This is the control that makes the assertion above mean something.
    const note = printExposureNote(
      exposureCensus({ files: [F.safeSpreadOnUnprotected], protectedModules: FIXTURE_PROTECTED }),
    );
    expect(note).toContain('IS a tree-wide all-clear');
    expect(note).not.toContain('NOT a tree-wide all-clear');
  });
});

describe('full-replacement mock guard: the live tree', () => {
  // Mirrors main(): ONE read of the corpus feeds BOTH the violation scan and the exposure
  // census. Deriving them from different walks is what would let a scope note drift from
  // the verdict it qualifies.
  const io = {
    listFiles: () =>
      execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx', '*.spec.ts', '*.spec.tsx'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
        .split('\n')
        .filter(Boolean)
        // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
        .filter((f) => existsSync(join(ROOT, f))),
    read: (f: string) => {
      try {
        return readFileSync(join(ROOT, f), 'utf8');
      } catch {
        return null;
      }
    },
  };
  const allFiles = readAllFiles(io);
  const candidates = selectCandidates({ files: allFiles, protectedModules: PROTECTED_MODULES });
  const orgSqlCandidates = candidates.filter((c: { path: string; text: string }) =>
    c.text.includes(ORG_PG_MODULE),
  );

  it('has no bare vi.mock factory on any protected module', () => {
    const violations = candidates.flatMap((c: { path: string; text: string }) =>
      checkFile({ path: c.path, text: c.text, protectedModules: PROTECTED_MODULES }),
    );
    expect(violations.map((v: { path: string; line: number }) => `${v.path}:${v.line}`)).toEqual([]);
  });

  it('its own PASS verdict is scope-qualified on the real tree (EI-20836231573383362)', () => {
    // The founding incident: this guard printed a clean verdict while a bare
    // `@papercusp/db-org` factory had been breaking collection of a real file for ~3 weeks.
    // db-org is now protected, but the remaining unprotected population still means the
    // verdict is not tree-wide positive evidence. On a tree with ANY unprotected exposure,
    // the pass must say so.
    const exposure = exposureCensus({ files: allFiles, protectedModules: PROTECTED_MODULES });
    expect(exposure.modules).toBeGreaterThan(0);
    expect(printExposureNote(exposure)).toContain('NOT a tree-wide all-clear');
    // Pin the incident module's new status: it is registered and therefore absent from the
    // unprotected exposure census that qualifies this run.
    expect(PROTECTED_MODULES.some((p: { module: string }) => p.module === '@papercusp/db-org')).toBe(true);
    expect(exposure.top.some((r: { module: string }) => r.module === '@papercusp/db-org')).toBe(false);
  });

  it('the CLI pass path actually prints the scope note — not just the helper that builds it', () => {
    // Everything above tests exposureCensus/printExposureNote in isolation, so deleting the
    // one `console.log(printExposureNote(...))` line from main() would leave them all green
    // while restoring the exact defect this item was filed for. Only running the real binary
    // pins the verdict a human/agent actually reads.
    const out = execFileSync('node', ['scripts/check-full-replacement-mocks.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(out).toContain('PROTECTED module(s)');
    expect(out).toContain('org-pg sql doubles: no incomplete tagged-template');
    expect(out).toContain('NOT a tree-wide all-clear');
    expect(out).toMatch(/unprotected module\(s\).*carry \d+ bare/s);

    // CONTROL — the VERBATIM verdict this guard printed at 20:24Z on 2026-08-18, while a
    // collection-breaking bare `@papercusp/db-org` factory sat in the tree. Kept here as a
    // permanent known-bad sample so the assertions above cannot be vacuous: if main() is
    // ever reverted to an unqualified all-clear, this is exactly what it would print, and
    // the assertions must reject it.
    const preFixVerdict =
      '✓ full-replacement-mocks: 2 protected module(s), 327 candidate test file(s) scanned — no bare vi.mock factories.';
    expect(preFixVerdict).not.toContain('NOT a tree-wide all-clear');
    expect(preFixVerdict).not.toMatch(/unprotected module\(s\).*carry \d+ bare/s);
  }, 120_000);

  it('keeps collectCandidateFiles equivalent to selectCandidates(readAllFiles(...))', () => {
    // The two-walk split is a refactor, not a behaviour change; this pins the exported API
    // other guards import so it cannot quietly diverge from what main() actually scans.
    const viaLegacy = collectCandidateFiles({ ...io, protectedModules: PROTECTED_MODULES });
    expect(viaLegacy.map((c: { path: string }) => c.path)).toEqual(
      candidates.map((c: { path: string }) => c.path),
    );
  });

  it('actually scanned the files it claims to protect — a silent empty scan is not a pass', () => {
    // Without this, deleting the protected entry (or breaking the pre-filter) would leave the
    // test above trivially green while protecting nothing.
    expect(PROTECTED_MODULES.length).toBeGreaterThan(0);
    expect(candidates.length).toBeGreaterThan(10);
    // Pass the path: it selects the ScriptKind (.ts vs .tsx) exactly as checkFile does above,
    // so this census masks each file under the SAME key and reuses that one mask instead of
    // re-parsing the whole candidate corpus a second time (P-007). Verified 2026-08-31 to be a
    // behavioural no-op — 0 of 3,059 candidates analyze differently with the path than without.
    const advMockers = candidates.filter((c: { path: string; text: string }) =>
      analyzeMockCalls(c.text, c.path).some(
        (call: { spec: string }) =>
          resolveSpec(c.path, call.spec) === 'packages/operator-core/lib/adv-sessions',
      ),
    );
    expect(advMockers.length).toBeGreaterThanOrEqual(30);
  });

  it('has no incomplete tagged-template getOrgPg().sql fake in the live tree (WI-40234)', () => {
    const findings = orgSqlCandidates.flatMap((c: { path: string; text: string }) =>
      checkOrgPgSqlDoubles(c),
    );
    expect(findings.map((v: { path: string; line: number }) => `${v.path}:${v.line}`)).toEqual([]);
  });

  it('actually scanned db-org mock files and observed the tagged-template shape', () => {
    expect(orgSqlCandidates.length).toBeGreaterThan(0);
    const analyzed = orgSqlCandidates.flatMap((c: { path: string; text: string }) =>
      analyzeOrgPgSqlDoubles(c.text, c.path),
    );
    expect(analyzed.length).toBeGreaterThan(0);
    expect(analyzed.some((finding: { begin: string }) => finding.begin === 'present')).toBe(true);
  });
});
