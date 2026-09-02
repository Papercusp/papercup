/**
 * Unit tests for the P-010 bakeoff runner.
 *
 * These deliberately need NO language server. What they guard is the
 * measuring instrument itself: that a probe still points at the symbol it
 * claims, that grading can actually FAIL, and that the read-plane audit
 * catches a real backend's real disk-writing tools.
 *
 * The last one exists because the pre-existing mutation test asserted only
 * over INVENTED names (`applyEdit`, `write_file`, …) and therefore passed
 * while both of `mcp-language-server`'s disk-writing tools slipped through
 * undetected. A guard tested only against names you made up measures your
 * imagination, not your defence.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProjectRoot } from './lsp-adapter.ts';

import {
  BENCH_PROBES,
  CORPUS_GROUND_TRUTH_INTENTS,
  KNOWN_DIVERGENCES,
  KNOWN_RSS_EXCEEDANCES,
  MCP_LANGUAGE_SERVER_SERVED_INTENTS,
  MCP_LANGUAGE_SERVER_TOOL_SURFACE,
  auditToolSurface,
  classifyColdStarts,
  classifyDivergence,
  gradeSites,
  probeLanguage,
  KNOWN_COLD_START_EXCEEDANCES,
  median,
  resolveProbeCursor,
  type BenchMeasurement,
  probeBudget,
  pollStopDecision,
  emptyAnswerBanner,
  lspClientIdentity,
  startedNewClient,
} from './code-intel-bench.ts';
import { corpusCase } from './acceptance-corpus.ts';
import {
  DEFAULT_RESOURCE_BUDGET,
  isMutatingToolName,
  type SymbolSite,
} from './contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const site = (path: string, line1: number | null): SymbolSite => ({
  path,
  line1,
  kind: null,
});

describe('bench probes point at real code', () => {
  it('every probe names a gradeable ground-truth corpus case', () => {
    for (const probe of BENCH_PROBES) {
      const kase = corpusCase(probe.caseId);
      expect(kase, `probe references unknown corpus case '${probe.caseId}'`).toBeDefined();
      // A property case has no site set to grade against, so a cursor probe
      // for one would produce a number that means nothing.
      expect(kase!.gradeMode, `probe '${probe.caseId}' is a property case`).not.toBe('property');
      expect(kase!.expectedSites.length).toBeGreaterThan(0);
    }
  });

  it('resolves each probe against the working tree, cursor inside the symbol', () => {
    for (const probe of BENCH_PROBES) {
      const cursor = resolveProbeCursor(probe, REPO_ROOT);
      const at = cursor.lineText.indexOf(probe.symbol);
      expect(at, `${probe.file}:${probe.line1} lost '${probe.symbol}'`).toBeGreaterThanOrEqual(0);
      // Strictly inside the token — a boundary cursor is ambiguous to some servers.
      expect(cursor.character).toBeGreaterThanOrEqual(at);
      expect(cursor.character).toBeLessThan(at + probe.symbol.length);
      expect(cursor.line1).toBe(probe.line1);
    }
  });

  it('THROWS on probe drift rather than scoring the backend wrong', () => {
    const drifted = { ...BENCH_PROBES[0], symbol: 'aSymbolThatIsNotOnThatLine' };
    expect(() => resolveProbeCursor(drifted, REPO_ROOT)).toThrow(/probe drift/);

    const offEnd = { ...BENCH_PROBES[0], line1: 10_000_000 };
    expect(() => resolveProbeCursor(offEnd, REPO_ROOT)).toThrow(/probe drift/);
  });
});

describe('grading can fail (falsifiability controls)', () => {
  const mustContain = corpusCase('definition-cross-package-bare-specifier')!;
  const exactSet = corpusCase('shadowed-symbol-no-cross-contamination')!;

  it('passes the true site set', () => {
    const truth = mustContain.expectedSites.map((s) => site(s.path, s.line1));
    expect(gradeSites(mustContain, truth).correct).toBe(true);
  });

  it('fails an empty answer', () => {
    const g = gradeSites(mustContain, []);
    expect(g.correct).toBe(false);
    expect(g.missing.length).toBeGreaterThan(0);
  });

  it('fails an off-by-one line — the whole point of the one-indexing guard', () => {
    const off = mustContain.expectedSites.map((s) => site(s.path, (s.line1 ?? 1) - 1));
    expect(gradeSites(mustContain, off).correct).toBe(false);
  });

  it('fails a right-line/wrong-file answer', () => {
    const wrong = mustContain.expectedSites.map((s) => site('some/other/file.ts', s.line1));
    expect(gradeSites(mustContain, wrong).correct).toBe(false);
  });

  it('must-contain TOLERATES an extra site; exact-set REJECTS it', () => {
    const withExtra = [
      ...mustContain.expectedSites.map((s) => site(s.path, s.line1)),
      site('libs/generic/other/src/index.ts', 12),
    ];
    expect(gradeSites(mustContain, withExtra).correct).toBe(true);

    const exactWithExtra = [
      ...exactSet.expectedSites.map((s) => site(s.path, s.line1)),
      // The shadowing vi.mock factory: returning it is the failure this case exists to catch.
      site('packages/operator-core/lib/predicate-watch.integration.test.ts', 40),
    ];
    const g = gradeSites(exactSet, exactWithExtra);
    expect(g.correct).toBe(false);
    expect(g.extra.length).toBe(1);
  });

  it('refuses to grade a property case rather than reporting a misleading pass', () => {
    const property = corpusCase('read-only-no-mutation');
    if (!property) return; // corpus renamed the case; the other guards still hold
    const g = gradeSites(property, []);
    expect(g.correct).toBe(false);
    expect(g.reason).toMatch(/property/);
  });
});

describe('project rooting — the false-empty class (P-010 defect 1)', () => {
  it('roots a Rust file at its own crate, NOT the repo root', () => {
    // MEASURED: this repo has no Cargo.toml at its root, so rooting
    // rust-analyzer there gave it no crate graph — it answered EMPTY for every
    // query while reporting itself healthy, and isTrustworthyEmpty blessed it.
    const rustFile = resolve(REPO_ROOT, 'papercusp-desktop/src-tauri/src/endpoint_ipc.rs');
    const { root, error } = resolveProjectRoot('rust', rustFile, REPO_ROOT);
    expect(error).toBeNull();
    expect(root).toBe(resolve(REPO_ROOT, 'papercusp-desktop/src-tauri'));
    expect(existsSync(join(root, 'Cargo.toml'))).toBe(true);
    // The precise regression: the repo root must NOT be chosen, and the reason
    // is checkable rather than asserted.
    expect(root).not.toBe(REPO_ROOT);
    expect(existsSync(join(REPO_ROOT, 'Cargo.toml'))).toBe(false);
  });

  it('REFUSES rather than returning a false-empty when no crate root exists', () => {
    // A .rs file with no Cargo.toml above it: the honest answer is a loud
    // error, because a healthy-looking empty reads as "nothing implements it".
    const orphan = resolve(REPO_ROOT, 'libs/generic/search/src/not-a-real-crate.rs');
    const { error } = resolveProjectRoot('rust', orphan, REPO_ROOT);
    expect(error).toMatch(/no Cargo\.toml/);
    expect(error).toMatch(/false-empty|EMPTY/);
  });

  it('leaves TypeScript rooted at the monorepo root, which is correct for it', () => {
    const tsFile = resolve(REPO_ROOT, 'libs/generic/search/src/leg-health.ts');
    const { root, error } = resolveProjectRoot('typescript', tsFile, REPO_ROOT);
    expect(error).toBeNull();
    expect(root).toBe(REPO_ROOT);
  });

  it('every Rust bench probe resolves to a real crate root', () => {
    for (const probe of BENCH_PROBES.filter((p) => p.file.endsWith('.rs'))) {
      const { root, error } = resolveProjectRoot(
        'rust',
        resolve(REPO_ROOT, probe.file),
        REPO_ROOT,
      );
      expect(error, `${probe.caseId} has no crate root`).toBeNull();
      expect(existsSync(join(root, 'Cargo.toml'))).toBe(true);
    }
  });
});

describe('read-plane audit of the mcp-language-server comparator', () => {
  const audit = auditToolSurface(
    MCP_LANGUAGE_SERVER_TOOL_SURFACE,
    MCP_LANGUAGE_SERVER_SERVED_INTENTS,
  );

  it('finds the two tools that write to disk', () => {
    expect(audit.mutatingTools).toEqual(['edit_file', 'rename_symbol']);
    expect(audit.readPlaneSafe).toBe(false);
  });

  it('REGRESSION: our name guard flags every one of them', () => {
    // This is the assertion that fails if the FORBIDDEN_MUTATING_TOOL_PATTERNS
    // widening is reverted. Before it, both slipped through silently.
    expect(audit.mutatingButUnflagged).toEqual([]);
    expect(isMutatingToolName('edit_file')).toBe(true);
    expect(isMutatingToolName('rename_symbol')).toBe(true);
  });

  it('CONTROL: the pre-fix pattern set really did miss both', () => {
    // A deliberately-wrong implementation kept permanently beside the real one,
    // so the assertion above is provably discriminating rather than vacuous.
    // (The repo's mutation-probe discipline for an imported MODULE — no tree
    // mutation, so no sweep race and no restore to forget.)
    const PRE_FIX_PATTERNS = [
      /^rename$/i,
      /^apply[_-]?edit$/i,
      /^workspace[_-]?edit$/i,
      /write/i,
      /delete/i,
      /^format/i,
      /^fix/i,
    ];
    const preFixFlags = (n: string): boolean => PRE_FIX_PATTERNS.some((re) => re.test(n));

    // The bug, reproduced: both disk-writers waved through.
    expect(preFixFlags('edit_file')).toBe(false);
    expect(preFixFlags('rename_symbol')).toBe(false);

    // Calibration — the old set was not simply broken, so a test that merely
    // asserts "the old thing fails" would pass even if the property itself
    // were meaningless. These it always caught, and so must the new set.
    for (const n of ['applyEdit', 'workspace_edit', 'write_file', 'formatDocument']) {
      expect(preFixFlags(n), `control miscalibrated on ${n}`).toBe(true);
      expect(isMutatingToolName(n)).toBe(true);
    }
  });

  it('keeps the read-only tools — and our own facade ops — unflagged', () => {
    for (const t of MCP_LANGUAGE_SERVER_TOOL_SURFACE.filter((t) => !t.writesToDisk)) {
      expect(isMutatingToolName(t.name), `${t.name} wrongly flagged`).toBe(false);
    }
    for (const op of [
      'symbol',
      'references',
      'implementations',
      'diagnostics',
      'workspace_symbols',
      'refactor_preview',
      'health',
      'query',
      'context',
      'impact',
      'route_map',
      'rename', // gitnexus preview — allowlisted, verified by the no-mutation case
    ]) {
      expect(isMutatingToolName(op), `${op} wrongly flagged`).toBe(false);
    }
  });

  it('cannot express the implementations intent the Rust case needs', () => {
    expect(CORPUS_GROUND_TRUTH_INTENTS).toContain('implementations');
    expect(audit.unservableIntents).toContain('implementations');
  });

  it('records the disk-write mechanism, not merely the name', () => {
    for (const t of MCP_LANGUAGE_SERVER_TOOL_SURFACE.filter((t) => t.writesToDisk)) {
      expect(t.evidence).toMatch(/ApplyWorkspaceEdit/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('warm-query statistic (P-010: one sample is not a steady state)', () => {
  it('reduces to the median, not the mean — one stall must not BE the number', () => {
    // The measured case: four fast samples and one post-indexing stall. A mean
    // reports 442ms and fails a 1500ms budget the backend actually meets at
    // steady state; the median reports the behaviour.
    const samples = [2, 3, 2, 2183, 2];
    expect(median(samples)).toBe(2);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(400); // control: the mean really is distorted
  });

  it('does NOT flatter the backend by reporting its best case', () => {
    // Falsifiability control for the opposite error: had this been a min, a
    // genuinely slow backend would report 2ms.
    expect(median([2, 1800, 1900, 2000, 2100])).toBe(1900);
    expect(median([2, 1800, 1900, 2000, 2100])).not.toBe(2);
  });

  it('averages the middle pair on an even sample count', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('returns null for no samples rather than a fabricated zero', () => {
    // A 0ms warm query would read as the fastest possible backend.
    expect(median([])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('accounted corpus divergences (P-010: frozen corpus vs LSP semantics)', () => {
  const BARREL = 'references-through-barrel-reexport';
  const DECL = 'libs/generic/dock-workbench/src/panel-registry.ts:30';
  const INDEX = 'libs/generic/dock-workbench/src/index.ts:4';
  const CONSUMER = 'apps/operator/components/DockWorkspace.tsx:45';

  function measurement(over: Partial<BenchMeasurement> = {}): BenchMeasurement {
    return {
      caseId: BARREL,
      intent: 'references',
      backend: 'lsp-adapter',
      serverWasCold: false,
      timeToCorrectMs: null,
      warmQueryMs: null,
      warmQuerySamplesMs: [],
      warmQueryMaxMs: null,
      attempts: 1,
      correct: false,
      trustworthyEmpty: true,
      grade: { correct: false, missing: [INDEX], extra: [], reason: `missing ${INDEX}` },
      // The measured shape of this probe (WI-2142253): degraded, non-empty, and
      // settled — which is why it now stops on 'converged' instead of burning
      // its whole deadline.
      answerHealth: 'degraded',
      siteSetChanges: 0,
      sitesStableForMs: 5_000,
      pollStoppedOn: 'converged',
      error: null,
      returnedSites: [DECL, CONSUMER],
      emptyThenFilledMs: null,
      notAttempted: false,
      ...over,
    };
  }

  it('accounts the barrel wildcard re-export, which names no symbol', () => {
    const v = classifyDivergence(measurement());
    expect(v.accounted).toBe(true);
    expect(v.reason).toMatch(/WILDCARD/);
  });

  it('REFUSES to account a case that is missing some OTHER site', () => {
    // The guard that stops this becoming "3 of 4 pass": a newly-missing site
    // must never be absorbed by an existing accounting entry.
    const v = classifyDivergence(
      measurement({
        grade: {
          correct: false,
          missing: [INDEX, DECL],
          extra: [],
          reason: 'missing two',
        },
        returnedSites: [CONSUMER],
      }),
    );
    expect(v.accounted).toBe(false);
    expect(v.reason).toMatch(/NOT covered/);
    expect(v.reason).toContain(DECL);
  });

  it("REFUSES to account a case whose OWN property has broken", () => {
    // A false-empty reference set is exactly what corpus case 2 exists to
    // catch. It must fail even though its missing-set is the accounted one.
    const v = classifyDivergence(measurement({ returnedSites: [] }));
    expect(v.accounted).toBe(false);
    expect(v.reason).toMatch(/NO LONGER HOLDS/);
  });

  it('REFUSES to account a set that stops at the declaring package', () => {
    // Reaches the declaration and the barrel, but no consumer THROUGH it —
    // the precise failure shape the case describes.
    const v = classifyDivergence(measurement({ returnedSites: [DECL, INDEX] }));
    expect(v.accounted).toBe(false);
    expect(v.reason).toMatch(/NO LONGER HOLDS/);
  });

  it('REFUSES to account a backend error', () => {
    const v = classifyDivergence(measurement({ error: 'connection closed' }));
    expect(v.accounted).toBe(false);
    expect(v.reason).toMatch(/errored/);
  });

  it('REFUSES to account an unsanctioned extra site', () => {
    const v = classifyDivergence(
      measurement({
        grade: { correct: false, missing: [INDEX], extra: ['some/other.ts:1'], reason: 'x' },
      }),
    );
    expect(v.accounted).toBe(false);
    expect(v.reason).toMatch(/unsanctioned extra/);
  });

  it('accounts NOTHING for a case with no accounting entry', () => {
    const v = classifyDivergence(measurement({ caseId: 'shadowed-symbol-no-cross-contamination' }));
    expect(v.accounted).toBe(false);
    expect(v.reason).toMatch(/no accounted divergence/);
  });

  it('never labels a CORRECT measurement a divergence', () => {
    expect(classifyDivergence(measurement({ correct: true })).accounted).toBe(false);
  });

  it('the barrel property is satisfied by a same-package sibling consumer', () => {
    // Regression guard for a real test bug: a first draft of the integration
    // assertion restated this property as "any site outside
    // libs/generic/dock-workbench/src/" and failed a PASSING run, because the
    // consumers live inside that package in a sibling file. What matters is
    // reaching beyond the declaring MODULE and the barrel, not the package.
    const known = KNOWN_DIVERGENCES.find((d) => d.caseId === BARREL);
    expect(
      known?.propertyHolds(
        measurement({
          returnedSites: [DECL, 'libs/generic/dock-workbench/src/DockWorkspace.tsx:45'],
        }),
      ),
    ).toBe(true);
  });

  it('every accounting entry names a real corpus case and real expected sites', () => {
    // Stops the accounting list rotting into prose about cases that no longer
    // exist, or "unreachable" sites the corpus never actually expected.
    for (const d of KNOWN_DIVERGENCES) {
      const kase = corpusCase(d.caseId);
      expect(kase, `accounted divergence names unknown case '${d.caseId}'`).toBeDefined();
      const expected = (kase?.expectedSites ?? []).map((s) => `${s.path}:${s.line1}`);
      for (const site of d.unreachableSites) {
        expect(expected, `'${site}' is not an expected site of '${d.caseId}'`).toContain(site);
      }
      expect(d.why.length).toBeGreaterThan(40);
      expect(d.property.length).toBeGreaterThan(40);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('accounted RSS exceedances (P-010: a real breach, bounded not silenced)', () => {
  it('does NOT raise the frozen budget to make a breach pass', () => {
    // The whole point: a budget edited to match the backend it judges stops
    // being a budget. P-002 froze this at 1024MB and it stays there.
    expect(DEFAULT_RESOURCE_BUDGET.rssMbMax).toBe(1_024);
  });

  it('every accounted exceedance actually EXCEEDS the budget it excepts', () => {
    // Stops the list accumulating entries for servers that are fine — which
    // would quietly widen the exception surface for nothing.
    for (const k of KNOWN_RSS_EXCEEDANCES) {
      expect(
        k.observedMb,
        `${k.language} is listed as an exceedance but measured under budget`,
      ).toBeGreaterThan(DEFAULT_RESOURCE_BUDGET.rssMbMax);
    }
  });

  it('bounds every accounted exceedance above its observed size', () => {
    // "Accounted" must not become "unwatched": the ceiling has to leave
    // headroom over what was measured, and has to be a real limit.
    for (const k of KNOWN_RSS_EXCEEDANCES) {
      expect(k.observedCeilingMb).toBeGreaterThan(k.observedMb);
      expect(k.observedCeilingMb).toBeLessThan(16_384);
      expect(k.why.length).toBeGreaterThan(80);
    }
  });

  it('names rust-analyzer specifically, with its measured size', () => {
    // The finding this exists to carry into backend selection (P-011).
    const rust = KNOWN_RSS_EXCEEDANCES.find((k) => k.language === 'rust');
    expect(rust, 'the measured rust-analyzer exceedance is not recorded').toBeDefined();
    expect(rust?.observedMb).toBeGreaterThan(2_000);
  });
});

describe('cold-start budget grading (P-018: coldStartMsMax was a dead field)', () => {
  // WHY THIS SUITE EXISTS. `coldStartMsMax` shipped in ResourceBudget and was
  // read by NOTHING — grep found exactly two references, both parts of its own
  // declaration — while the measured rust cold start (10,760ms) already
  // breached it. A budget nothing grades cannot fail, so a cold-start
  // regression had no way to surface. These tests guard the grader itself and
  // deliberately need no language server.
  //
  // Every case pairs the real subject with a CONTROL that must grade the other
  // way. A guard only ever exercised on inputs it passes measures nothing —
  // which is precisely how the dead field survived this long.

  function cold(over: Partial<BenchMeasurement> = {}): BenchMeasurement {
    return {
      caseId: 'rust-trait-implementations',
      intent: 'implementations',
      backend: 'lsp-adapter',
      serverWasCold: true,
      timeToCorrectMs: 10_760,
      warmQueryMs: 30,
      warmQuerySamplesMs: [30],
      warmQueryMaxMs: 54,
      attempts: 1,
      correct: true,
      trustworthyEmpty: true,
      grade: { correct: true, missing: [], extra: [], reason: 'ok' },
      answerHealth: 'healthy',
      siteSetChanges: 0,
      sitesStableForMs: 0,
      pollStoppedOn: 'correct',
      error: null,
      returnedSites: [],
      emptyThenFilledMs: null,
      notAttempted: false,
      ...over,
    };
  }

  it('resolves a probe to the language that actually answered it', () => {
    expect(probeLanguage('rust-trait-implementations')).toBe('rust');
    expect(probeLanguage('definition-cross-package-bare-specifier')).toBe('typescript');
    // CONTROL: an unknown case must not resolve to some default language.
    expect(probeLanguage('no-such-case')).toBeNull();
  });

  it('grades the measured rust cold start as over budget but ACCOUNTED', () => {
    const [v] = classifyColdStarts([cold()]);
    expect(v?.language).toBe('rust');
    expect(v?.timeToCorrectMs).toBeGreaterThan(DEFAULT_RESOURCE_BUDGET.coldStartMsMax);
    expect(v?.overBudget).toBe(true);
    expect(v?.accounted).toBe(true);
  });

  it('grades the measured typescript cold start as over budget but ACCOUNTED', () => {
    // The second half of the real table, added in WI-2142287. Uses the DEFAULT
    // accounting argument on purpose: with the control below injecting its own
    // table, this is what still pins production behaviour to real data.
    const [v] = classifyColdStarts([
      cold({ caseId: 'definition-cross-package-bare-specifier', timeToCorrectMs: 10_665 }),
    ]);
    expect(v?.language).toBe('typescript');
    expect(v?.overBudget).toBe(true);
    expect(v?.accounted).toBe(true);
  });

  it('FAILS an over-budget language with no accounting entry', () => {
    // The control that proves the guard can fail at all. If this ever grades
    // `accounted`, the assertion in the integration test is decorative.
    //
    // It INJECTS an empty accounting table rather than naming a language
    // absent from the real one, because there is no longer such a language to
    // name: `LspLanguage` is exactly 'typescript' | 'rust' and WI-2142287
    // accounted the second of them. Written the old way, this control did not
    // survive its own table being completed — it flipped to `accounted: true`
    // and failed, and the tempting repair (assert the new truth) would have
    // deleted the only proof that the unaccounted path can be reached at all.
    //
    // Injecting the data keeps the control about the GUARD's logic instead of
    // about the table's current contents, so completing the table can never
    // silently disarm it again.
    const [v] = classifyColdStarts(
      [cold({ caseId: 'definition-cross-package-bare-specifier', timeToCorrectMs: 45_000 })],
      [],
    );
    expect(v?.language).toBe('typescript');
    expect(v?.overBudget).toBe(true);
    expect(v?.accounted).toBe(false);
  });

  it('does not flag a cold start that meets the budget', () => {
    // The real measured TypeScript cold start.
    const [v] = classifyColdStarts([
      cold({ caseId: 'definition-cross-package-bare-specifier', timeToCorrectMs: 3_917 }),
    ]);
    expect(v?.overBudget).toBe(false);
    expect(v?.accounted).toBe(false);
  });

  it('ignores probes that never paid a cold start or never graded correct', () => {
    // A never-correct probe is a CORRECTNESS failure and is reported as one
    // elsewhere. Folding it in here would report the same defect twice, the
    // second time as a latency breach it is not.
    expect(classifyColdStarts([cold({ serverWasCold: false })])).toEqual([]);
    expect(classifyColdStarts([cold({ timeToCorrectMs: null })])).toEqual([]);
    expect(classifyColdStarts([cold({ notAttempted: true })])).toEqual([]);
  });

  it('keeps every accounting entry bounded and explained', () => {
    expect(KNOWN_COLD_START_EXCEEDANCES.length).toBeGreaterThan(0);
    for (const k of KNOWN_COLD_START_EXCEEDANCES) {
      // A ceiling at or below the budget would make the entry meaningless;
      // an unbounded one would make "accounted" mean "unwatched".
      expect(k.observedCeilingMs).toBeGreaterThan(DEFAULT_RESOURCE_BUDGET.coldStartMsMax);
      expect(k.observedCeilingMs).toBeGreaterThan(k.observedMs);
      expect(k.observedCeilingMs).toBeLessThanOrEqual(300_000);
      expect(k.why.length).toBeGreaterThan(80);
    }
  });
});

/**
 * The leg budget must not be first-come-first-served.
 *
 * Before EI-22174876232438025 it was, and the consequence was not a slow run but
 * a SILENT COVERAGE HOLE: `rust-trait-implementations` — the corpus's only
 * non-TypeScript case, covering one of exactly two pinned backends — reported
 * `attempts=0 (not attempted)` on every run, while the suite still read 10/12
 * green. The arithmetic was exact rather than unlucky: the integration leg runs
 * `deadlineMs` 300_000 against `legBudgetMs` 600_000, so any TWO
 * never-converging TypeScript probes consumed the whole leg before rust was
 * reached.
 */
describe('probeBudget — per-probe reservation', () => {
  const FOUR = 4;

  it('withholds a floor from the first probe while later ones have not run', () => {
    const b = probeBudget({
      legBudgetMs: 600_000,
      elapsedMs: 0,
      probesAfterThis: 3,
      legProbeCount: FOUR,
    });
    // The regression control: the ORIGINAL implementation returned the whole
    // 600_000 here, which is precisely what let the first probes spend the
    // whole leg.
    expect(b.remainingMs).toBe(150_000);
    expect(b.remainingMs).not.toBe(600_000);
    expect(b.reservedForOthersMs).toBe(450_000);
    expect(b.perProbeFloorMs).toBe(150_000);
  });

  it('still reaches the last probe after the earlier ones exhausted their share', () => {
    // THE bug, stated as an assertion: the earlier probes have burned 590s of a
    // 600s leg. The last probe must still be measurable — under the original
    // code it got nothing at all.
    const b = probeBudget({
      legBudgetMs: 600_000,
      elapsedMs: 590_000,
      probesAfterThis: 0,
      legProbeCount: FOUR,
    });
    expect(b.reservedForOthersMs).toBe(0);
    expect(b.remainingMs).toBeGreaterThan(0);
  });

  it('treats the floor as a reservation, not a cap', () => {
    // Everything before finished fast. Nothing is owed to anyone, so this probe
    // may use the ENTIRE remainder — well past its own 150_000 floor. A cap
    // would have clamped this to 150_000 and thrown away real measuring time.
    const b = probeBudget({
      legBudgetMs: 600_000,
      elapsedMs: 10_000,
      probesAfterThis: 0,
      legProbeCount: FOUR,
    });
    expect(b.remainingMs).toBe(590_000);
  });

  it('withholds nothing on a single-probe leg', () => {
    const b = probeBudget({
      legBudgetMs: 600_000,
      elapsedMs: 0,
      probesAfterThis: 0,
      legProbeCount: 1,
    });
    expect(b.reservedForOthersMs).toBe(0);
    expect(b.remainingMs).toBe(600_000);
  });

  it('scales the floor to the number of probes', () => {
    const b = probeBudget({
      legBudgetMs: 600_000,
      elapsedMs: 0,
      probesAfterThis: 2,
      legProbeCount: 3,
    });
    expect(b.perProbeFloorMs).toBe(200_000);
    expect(b.reservedForOthersMs).toBe(400_000);
    expect(b.remainingMs).toBe(200_000);
  });

  it('reports a spent share as non-positive so the caller records not-attempted', () => {
    const b = probeBudget({
      legBudgetMs: 600_000,
      elapsedMs: 300_000,
      probesAfterThis: 2,
      legProbeCount: FOUR,
    });
    expect(b.remainingMs).toBeLessThanOrEqual(0);
    // reservedForOthersMs > 0 is what makes the caller report this as a spent
    // SHARE rather than an exhausted BUDGET — the distinction matters because
    // "exhausted" sends a reader to raise legBudgetMs, the one change that
    // cannot help.
    expect(b.reservedForOthersMs).toBeGreaterThan(0);
  });
});

describe('probeBudget REGRESSION — reserving per LANGUAGE only moved the starvation', () => {
  // The measured leg, twice, on 2026-09-02 (EI-22174876232438025):
  //   v1 (no reservation)       — rust probe `attempts=0`, never measured.
  //   v2 (per-LANGUAGE floor)   — rust measured (PASS, 15,635ms cold-to-correct)
  //                               and the THIRD TypeScript probe took its place
  //                               at `attempts=0`.
  // Exactly one probe was lost either way, so this fixture replays that leg
  // against both rules. The per-language rule is kept here as a deliberately
  // wrong CONTROL: without it, a per-probe implementation that silently
  // regressed would look identical to one that works.
  const LEG_BUDGET_MS = 600_000;
  const PROBE_DEADLINE_MS = 300_000;

  /** The four probes in leg order; Infinity = polls to its deadline, never converges. */
  const LEG = [
    { caseId: 'definition-cross-package-bare-specifier', ext: '.ts', spendMs: 10_306 },
    { caseId: 'references-through-barrel-reexport', ext: '.ts', spendMs: Infinity },
    { caseId: 'shadowed-symbol-no-cross-contamination', ext: '.ts', spendMs: Infinity },
    { caseId: 'rust-trait-implementations', ext: '.rs', spendMs: 15_635 },
  ];

  /** Replay the leg, returning the caseIds that never got a turn. */
  const starvedUnder = (remainingFor: (i: number, elapsedMs: number) => number): string[] => {
    const starved: string[] = [];
    let elapsedMs = 0;
    LEG.forEach((probe, i) => {
      const remaining = remainingFor(i, elapsedMs);
      if (remaining <= 0) {
        starved.push(probe.caseId);
        return;
      }
      elapsedMs += Math.min(probe.spendMs, PROBE_DEADLINE_MS, remaining);
    });
    return starved;
  };

  it('CONTROL: the per-language rule starves the third TypeScript probe', () => {
    const languagesStarted = new Set<string>();
    const legLanguages = new Set(LEG.map((p) => p.ext));
    const perLanguageFloorMs = LEG_BUDGET_MS / legLanguages.size;

    const starved = starvedUnder((i, elapsedMs) => {
      const ext = LEG[i].ext;
      const unstartedOthers = [...legLanguages].filter(
        (l) => l !== ext && !languagesStarted.has(l),
      ).length;
      const remaining = LEG_BUDGET_MS - elapsedMs - unstartedOthers * perLanguageFloorMs;
      if (remaining > 0) languagesStarted.add(ext);
      return remaining;
    });

    // Not a hypothetical: this is what leg v2 actually reported.
    expect(starved).toEqual(['shadowed-symbol-no-cross-contamination']);
  });

  it('every probe gets a turn under the per-probe reservation', () => {
    const starved = starvedUnder(
      (i, elapsedMs) =>
        probeBudget({
          legBudgetMs: LEG_BUDGET_MS,
          elapsedMs,
          probesAfterThis: LEG.length - 1 - i,
          legProbeCount: LEG.length,
        }).remainingMs,
    );
    expect(starved).toEqual([]);
  });

  it('leaves the last probe enough for a real rust cold start', () => {
    // A floor is only worth having if it clears the cold start it must pay, and
    // the floor SHRINKS as probes are added. rust-analyzer measured 15,635ms
    // cold-to-correct in leg v2 (it must run `cargo metadata` and build proc
    // macros first), so this fails once the probe set outgrows the leg budget —
    // which is the moment to raise `legBudgetMs`, not to discover another
    // `attempts=0`.
    const MEASURED_RUST_COLD_START_MS = 15_635;
    const floorMs = LEG_BUDGET_MS / LEG.length;
    expect(floorMs).toBeGreaterThan(MEASURED_RUST_COLD_START_MS * 2);
  });
});

describe('pollStopDecision — when the loop has learned all it is going to', () => {
  const STABLE_MS = 5_000;
  // The measured shape of the defect (leg v2, WI-2142253): a DEGRADED answer
  // holding eight real sites, graded incorrect against the frozen corpus.
  const BARREL_REEXPORT = {
    correct: false,
    errorText: null,
    health: 'degraded',
    siteCount: 8,
    stableForMs: STABLE_MS,
  } as const;

  it('stops on a correct answer before anything else is considered', () => {
    expect(
      pollStopDecision({ ...BARREL_REEXPORT, correct: true, siteSetUnchangedForMs: 0 }),
    ).toBe('correct');
  });

  it('stops on an unserved intent — waiting cannot make it served', () => {
    expect(
      pollStopDecision({
        ...BARREL_REEXPORT,
        errorText: 'intent references is not served by this backend',
        siteSetUnchangedForMs: 0,
      }),
    ).toBe('not-served');
  });

  it('stops immediately on a healthy non-empty answer, however fresh', () => {
    expect(
      pollStopDecision({ ...BARREL_REEXPORT, health: 'healthy', siteSetUnchangedForMs: 0 }),
    ).toBe('healthy-final');
  });

  it('keeps polling a degraded non-empty answer that is still moving', () => {
    // Sites DO arrive late — the measured cold-open failure returned two real
    // sites while hundreds were still missing. A cutoff that fired while the
    // set was still growing would manufacture divergences.
    expect(
      pollStopDecision({ ...BARREL_REEXPORT, siteSetUnchangedForMs: STABLE_MS - 1 }),
    ).toBeNull();
  });

  it('stops a degraded non-empty answer once its site set has settled', () => {
    expect(
      pollStopDecision({ ...BARREL_REEXPORT, siteSetUnchangedForMs: STABLE_MS }),
    ).toBe('converged');
  });

  it('NEVER converges an EMPTY answer, however long it has sat still', () => {
    // The load-bearing exclusion. A stalled empty and a still-loading empty are
    // the same bytes, so an empty is never entitled to be called settled — that
    // is precisely the false-empty the acceptance corpus exists to catch. If
    // this ever returns a stop reason, the corpus has been quietly defeated.
    for (const health of ['healthy', 'degraded', 'unhealthy', 'unknown']) {
      expect(
        pollStopDecision({
          ...BARREL_REEXPORT,
          health,
          siteCount: 0,
          siteSetUnchangedForMs: STABLE_MS * 1_000,
        }),
      ).toBeNull();
    }
  });

  it('CONTROL: the pre-fix rule set never stops the measured barrel probe', () => {
    // The three break conditions exactly as they stood before WI-2142253, kept
    // permanently so the regression cannot return unnoticed. A degraded
    // non-empty answer matched NONE of them, so the loop's only remaining exit
    // was the deadline: 569 attempts over ~290s to re-learn what it already held
    // on attempt 1. This control must keep FAILING to stop, or it has stopped
    // reproducing the bug and is no longer evidence of anything.
    const preFix = (a: {
      correct: boolean;
      errorText: string | null;
      health: string;
      siteCount: number;
    }): string | null => {
      if (a.correct) return 'correct';
      if (a.errorText && /not served/.test(a.errorText)) return 'not-served';
      if (a.health === 'healthy' && a.siteCount > 0) return 'healthy-final';
      return null;
    };

    // Calibration: the pre-fix rule was not broken in general — it stops the
    // cases it WAS written for. Without this, a control that returned null for
    // every input would look like a faithful reproduction of the defect.
    expect(preFix({ ...BARREL_REEXPORT, correct: true })).toBe('correct');
    expect(preFix({ ...BARREL_REEXPORT, health: 'healthy' })).toBe('healthy-final');

    // The defect: settled or not, the pre-fix rule polls on forever.
    expect(preFix(BARREL_REEXPORT)).toBeNull();
    expect(
      pollStopDecision({ ...BARREL_REEXPORT, siteSetUnchangedForMs: STABLE_MS }),
    ).toBe('converged');
  });

  it('CONTROL: a cutoff that ignored siteCount would defeat the corpus', () => {
    // The most likely wrong simplification — dropping the `siteCount > 0` guard
    // because "settled is settled". It reads as a tidy-up and silently converts
    // every false-empty into a fast, confident, WRONG absence.
    const withoutEmptyGuard = (a: { siteSetUnchangedForMs: number }): string | null =>
      a.siteSetUnchangedForMs >= STABLE_MS ? 'converged' : null;

    const stalledEmpty = { siteSetUnchangedForMs: STABLE_MS * 10 };
    expect(withoutEmptyGuard(stalledEmpty)).toBe('converged');
    expect(
      pollStopDecision({ ...BARREL_REEXPORT, siteCount: 0, ...stalledEmpty }),
    ).toBeNull();
  });
});

describe('emptyAnswerBanner — the PERMANENT false-empty was the silent one (EI-22179492086218698)', () => {
  // Ranked by harm the old labelling was exactly inverted: the lie that
  // self-corrects got the banner, and the one reported to callers as PROOF of
  // absence rendered as an ordinary FAIL row.
  const base = {
    emptyThenFilledMs: null as number | null,
    answerHealth: 'healthy' as string | null,
    returnedSites: [] as readonly string[],
    sitesStableForMs: 244_626 as number | null,
    pollStoppedOn: 'deadline' as BenchMeasurement['pollStoppedOn'],
  };

  it('fills-later => FALSE-EMPTY only', () => {
    const banner = emptyAnswerBanner({ ...base, emptyThenFilledMs: 1_200 });
    expect(banner).toMatch(/FALSE-EMPTY/);
    expect(banner).not.toMatch(/CERTIFIED-EMPTY/);
  });

  it('never-fills + healthy => CERTIFIED-EMPTY only', () => {
    const banner = emptyAnswerBanner(base);
    expect(banner).toMatch(/CERTIFIED-EMPTY/);
    expect(banner).not.toMatch(/FALSE-EMPTY/);
    // The severity claim must be IN the banner: this is the row whose empty
    // isTrustworthyEmpty() blesses as proven absence.
    expect(banner).toMatch(/PROVEN ABSENCE/);
  });

  it('healthy + NON-empty => neither (the ordinary passing shape)', () => {
    expect(
      emptyAnswerBanner({ ...base, returnedSites: ['libs/generic/x/src/index.ts:1'] }),
    ).toBeNull();
  });

  it('degraded + empty => neither — an honest refusal is not a lie', () => {
    // Post-WI-2142382 this is what the shadowed-symbol probe now looks like.
    // Bannering it would train readers to ignore the banner, which is how a
    // detector dies.
    expect(emptyAnswerBanner({ ...base, answerHealth: 'degraded' })).toBeNull();
  });

  it('a probe the budget NEVER RAN is never called a lie', () => {
    // notAttempted rows carry pollStoppedOn:'never-queried' and a null health.
    // Either alone must be enough to stay silent.
    expect(emptyAnswerBanner({ ...base, pollStoppedOn: 'never-queried' })).toBeNull();
    expect(emptyAnswerBanner({ ...base, answerHealth: null })).toBeNull();
  });

  it('REGRESSION: the exact leg-v5 row that got NO banner now gets one', () => {
    // Measured, /tmp/p018-bakeoff-v5.log, shadowed-symbol-no-cross-contamination:
    //   attempts=486 stoppedOn=deadline health=healthy siteSetChanges=0
    //   sitesStableForMs=244626 returned=[nothing]
    // A reader had to join health=healthy with returned=[nothing] BY HAND to
    // see this was a certified absence rather than a never-ready probe. That
    // hand-join is how WI-2142174 had to be diagnosed.
    const banner = emptyAnswerBanner({
      emptyThenFilledMs: null,
      answerHealth: 'healthy',
      returnedSites: [],
      sitesStableForMs: 244_626,
      pollStoppedOn: 'deadline',
    });
    expect(banner).toMatch(/CERTIFIED-EMPTY/);
    expect(banner).toContain('244626ms');

    // FALSIFIABILITY CONTROL, kept permanently: the OLD rule really was silent
    // on this row. If this stops reproducing, the assertion above proves nothing.
    const oldRule = (m: { emptyThenFilledMs: number | null }) =>
      m.emptyThenFilledMs !== null ? 'banner' : '';
    expect(oldRule({ emptyThenFilledMs: null })).toBe('');
  });
});

describe('serverWasCold is read from the ADAPTER, not guessed from the extension (WI-2142383)', () => {
  // WHY THESE ASSERT ON A KEY RATHER THAN ON THE LEG:
  //
  // The defect was never in the leg's control flow — it was in the KEY the leg
  // used to answer "has this server already started?". `lsp-adapter` keys
  // clients by `clientKey(language, rootPath)`; the leg keyed a private
  // `languagesStarted` Set by file extension. One bucket per language against
  // one client per project root: the disagreement IS the bug, and it can only
  // be caught by a test that holds both keyings side by side.
  //
  // Each case therefore also evaluates the OLD extension rule where they
  // differ, so a future reader can see that the two genuinely disagree — a
  // regression test that only showed the new rule getting it right would pass
  // just as happily if the new rule were never wired in.
  const ts = (rootPath: string, taskId = 'task-1') =>
    lspClientIdentity({ language: 'typescript', rootPath, taskId });

  const extensionRule = (started: ReadonlySet<string>, ext: string) => !started.has(ext);

  it('calls a SECOND project root for the SAME language a cold start', () => {
    // Exactly the leg v6/v7 case: the anchor probe opened
    // packages/operator-core, then shadowed-symbol cold-opened
    // libs/generic/scheduled-registry and was recorded `warm-start`.
    const before = new Set([ts('/repo/packages/operator-core')]);
    const after = [
      ts('/repo/packages/operator-core'),
      ts('/repo/libs/generic/scheduled-registry'),
    ];

    expect(startedNewClient(before, after)).toBe(true);
    // ...and the rule it replaced gets this exact case backwards.
    expect(extensionRule(new Set(['.ts']), '.ts')).toBe(false);
  });

  it('does NOT call a re-query against an already-running client cold', () => {
    const before = new Set([ts('/repo/packages/operator-core')]);
    expect(startedNewClient(before, [ts('/repo/packages/operator-core')])).toBe(false);
  });

  it('calls a RESTARTED server at the same root a cold start', () => {
    // A crashed server respawned at the same root is a new process that paid a
    // new cold start. Keying on language+root alone would report it warm and
    // hide that cost from coldStartMsMax.
    const before = new Set([ts('/repo/packages/operator-core', 'task-1')]);
    const after = [ts('/repo/packages/operator-core', 'task-2')];
    expect(startedNewClient(before, after)).toBe(true);
  });

  it('reports warm when the probe started nothing at all', () => {
    expect(startedNewClient(new Set<string>(), [])).toBe(false);
  });

  it('distinguishes two LANGUAGES sharing one root', () => {
    // The mirror image of the first case: same root, different servers. The
    // adapter runs one client per (language, root) pair, so a rust probe in a
    // root where TypeScript is already up is still a cold start.
    const before = new Set([ts('/repo')]);
    const after = [
      ts('/repo'),
      lspClientIdentity({ language: 'rust', rootPath: '/repo', taskId: 'task-9' }),
    ];
    expect(startedNewClient(before, after)).toBe(true);
  });
});
