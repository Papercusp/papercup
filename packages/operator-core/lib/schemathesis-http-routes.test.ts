// schemathesis-http-routes.test.ts — P-024, plan design-to-code-coverage-seam-2026-09-02.
//
// The load-bearing suite here is "the two decoration guards", not the happy
// path. This gate's whole justification is that it REFUSES rather than
// silently skipping (D-008), so the tests that matter are the ones that would
// fail if someone later "fixed" an inconvenient refusal by letting it through.
//
// Two deliberately-wrong implementations are kept as permanent controls at the
// bottom of this file. They are the falsifiability proof: the same properties
// that pass against the real module FAIL against them, so a green run here is
// evidence the assertions can discriminate — not merely that they executed.
// (Per CLAUDE.md's mutation-probe guidance: a module you `import` is proven
// falsifiable with an in-test control, never by mutating the shared tree.)

import { describe, expect, it } from 'vitest';

import {
  SCHEMATHESIS_PIN,
  buildSchemathesisArgv,
  describeSchemathesisVerdict,
  judgeSchemathesisRun,
  parseSchemathesisReport,
  resolveSchemathesisToolchain,
  schemathesisExitCode,
  summarizeOpenApiSurface,
  type JudgeSchemathesisInput,
  type OpenApiSurfaceSummary,
  type SchemathesisRunObservation,
  type SchemathesisToolchain,
  type SchemathesisToolchainProbe,
} from './schemathesis-http-routes.ts';

const AVAILABLE: SchemathesisToolchain = {
  available: true,
  runner: 'module',
  version: '4.25.2',
  reason: 'importable',
  remedy: null,
};

const UNAVAILABLE: SchemathesisToolchain = {
  available: false,
  runner: null,
  version: null,
  reason: 'schemathesis is not importable and pipx is not on PATH to acquire it',
  remedy: `pipx install schemathesis==${SCHEMATHESIS_PIN}`,
};

const SURFACE: OpenApiSurfaceSummary = {
  paths: 1611,
  operations: 1761,
  operationsWithSchema: 1220,
  componentSchemas: 3568,
};

const CLEAN_RUN: SchemathesisRunObservation = {
  exitCode: 0,
  operationsTested: 1761,
  checksFailed: 0,
};

describe('resolveSchemathesisToolchain', () => {
  const probe = (over: Partial<SchemathesisToolchainProbe>): SchemathesisToolchainProbe => ({
    pythonPresent: true,
    moduleVersion: null,
    pipxPresent: false,
    ...over,
  });

  it('prefers an already-importable module and reports the version it actually found', () => {
    const resolved = resolveSchemathesisToolchain(probe({ moduleVersion: '4.20.0' }));
    expect(resolved.available).toBe(true);
    expect(resolved.runner).toBe('module');
    // Reported, not silently normalised to the pin: a drift must stay visible.
    expect(resolved.version).toBe('4.20.0');
    expect(resolved.remedy).toBeNull();
  });

  it('falls back to pipx, which acquires the PINNED version', () => {
    const resolved = resolveSchemathesisToolchain(probe({ pipxPresent: true }));
    expect(resolved.available).toBe(true);
    expect(resolved.runner).toBe('pipx');
    expect(resolved.version).toBe(SCHEMATHESIS_PIN);
  });

  it('refuses when neither the module nor pipx can supply it, and names the remedy', () => {
    const resolved = resolveSchemathesisToolchain(probe({}));
    expect(resolved.available).toBe(false);
    expect(resolved.runner).toBeNull();
    // A refusal that does not say how to clear itself reads as a broken gate.
    expect(resolved.remedy).toContain(SCHEMATHESIS_PIN);
  });

  it('refuses with a python-specific remedy when there is no interpreter', () => {
    const resolved = resolveSchemathesisToolchain(probe({ pythonPresent: false }));
    expect(resolved.available).toBe(false);
    expect(resolved.reason).toMatch(/python3/);
    expect(resolved.remedy).toMatch(/python3/);
  });

  it('honours an explicit pin override', () => {
    const resolved = resolveSchemathesisToolchain(probe({ pipxPresent: true }), '4.9.9');
    expect(resolved.version).toBe('4.9.9');
  });
});

describe('summarizeOpenApiSurface', () => {
  const doc = {
    openapi: '3.1.0',
    paths: {
      '/api/a': {
        get: { responses: {} },
        post: {
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        },
        // Not an operation — a path-level key that must not be counted.
        parameters: [{ name: 'x', in: 'query', schema: { type: 'string' } }],
        summary: 'ignored',
      },
      '/api/b': {
        delete: { parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }] },
      },
    },
    components: { schemas: { A: {}, B: {}, C: {} } },
  };

  it('counts operations, not path-item keys', () => {
    const summary = summarizeOpenApiSurface(doc);
    expect(summary).not.toBeNull();
    expect(summary!.paths).toBe(2);
    // get + post + delete === 3. `parameters` and `summary` are not methods.
    expect(summary!.operations).toBe(3);
  });

  it('counts operations carrying a requestBody or parameter schema', () => {
    const summary = summarizeOpenApiSurface(doc)!;
    expect(summary.operationsWithSchema).toBe(2);
    expect(summary.componentSchemas).toBe(3);
  });

  it('returns null — absent, not empty — for anything that is not an OpenAPI document', () => {
    // Each of these would otherwise be indistinguishable from "an API with no
    // operations", which is a statement about the API rather than the parse.
    expect(summarizeOpenApiSurface(null)).toBeNull();
    expect(summarizeOpenApiSurface('not a document')).toBeNull();
    expect(summarizeOpenApiSurface([])).toBeNull();
    expect(summarizeOpenApiSurface({ paths: {} })).toBeNull();
    expect(summarizeOpenApiSurface({ openapi: '3.1.0' })).toBeNull();
  });

  it('accepts a swagger 2.0 document', () => {
    const summary = summarizeOpenApiSurface({ swagger: '2.0', paths: { '/x': { get: {} } } });
    expect(summary?.operations).toBe(1);
  });

  it('reports a genuinely empty API as zero operations, not as null', () => {
    const summary = summarizeOpenApiSurface({ openapi: '3.1.0', paths: {} });
    expect(summary).not.toBeNull();
    expect(summary!.operations).toBe(0);
  });
});

describe('judgeSchemathesisRun — the happy path', () => {
  it('passes when the toolchain ran over real operations and found nothing', () => {
    const verdict = judgeSchemathesisRun({
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: CLEAN_RUN,
    });
    expect(verdict.decision).toBe('pass');
    expect(verdict.conclusive).toBe(true);
    expect(schemathesisExitCode(verdict)).toBe(0);
    expect(verdict.notes.join(' ')).toContain('1761 of 1761');
  });

  it('reports violations when checks failed', () => {
    const verdict = judgeSchemathesisRun({
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: { exitCode: 1, operationsTested: 1761, checksFailed: 12 },
    });
    expect(verdict.decision).toBe('violations');
    expect(verdict.conclusive).toBe(true);
    expect(verdict.checksFailed).toBe(12);
    expect(schemathesisExitCode(verdict)).toBe(1);
  });

  it('reports violations on a non-zero exit even when the failure count is unrecoverable', () => {
    const verdict = judgeSchemathesisRun({
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: { exitCode: 3, operationsTested: 10, checksFailed: null },
    });
    expect(verdict.decision).toBe('violations');
    expect(schemathesisExitCode(verdict)).toBe(1);
  });
});

describe('judgeSchemathesisRun — GUARD 1: an absent toolchain refuses, it does not skip', () => {
  it('is unavailable when the toolchain is missing', () => {
    const verdict = judgeSchemathesisRun({
      toolchain: UNAVAILABLE,
      surface: SURFACE,
      run: null,
    });
    expect(verdict.decision).toBe('unavailable');
    expect(verdict.conclusive).toBe(false);
    expect(schemathesisExitCode(verdict)).toBe(2);
  });

  it('stays unavailable even when a clean run is somehow reported alongside it', () => {
    // The shape that would make this gate decoration: a missing dependency plus
    // a green-looking result, resolved in favour of the green.
    const verdict = judgeSchemathesisRun({
      toolchain: UNAVAILABLE,
      surface: SURFACE,
      run: CLEAN_RUN,
    });
    expect(verdict.decision).toBe('unavailable');
    expect(schemathesisExitCode(verdict)).not.toBe(0);
  });

  it('surfaces the toolchain reason on the verdict so the refusal is actionable', () => {
    const verdict = judgeSchemathesisRun({ toolchain: UNAVAILABLE, surface: SURFACE, run: null });
    expect(verdict.notes.join(' ')).toContain(UNAVAILABLE.reason);
    expect(describeSchemathesisVerdict(verdict)).toMatch(/^UNAVAILABLE/);
  });
});

describe('judgeSchemathesisRun — GUARD 2: a clean run over nothing is not a pass', () => {
  it('refuses when schemathesis exercised zero operations despite exiting 0', () => {
    const verdict = judgeSchemathesisRun({
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: { exitCode: 0, operationsTested: 0, checksFailed: 0 },
    });
    expect(verdict.decision).toBe('unavailable');
    expect(schemathesisExitCode(verdict)).toBe(2);
    expect(verdict.notes.join(' ')).toContain('0 of 1761');
  });

  it('refuses when the operation count could not be recovered — unknown is not zero', () => {
    const verdict = judgeSchemathesisRun({
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: { exitCode: 0, operationsTested: null, checksFailed: 0 },
    });
    expect(verdict.decision).toBe('unavailable');
    expect(schemathesisExitCode(verdict)).toBe(2);
  });

  it('refuses when the schema itself describes zero operations', () => {
    const verdict = judgeSchemathesisRun({
      toolchain: AVAILABLE,
      surface: { paths: 0, operations: 0, operationsWithSchema: 0, componentSchemas: 0 },
      run: CLEAN_RUN,
    });
    expect(verdict.decision).toBe('unavailable');
    expect(schemathesisExitCode(verdict)).toBe(2);
  });

  it('refuses when the document could not be parsed at all', () => {
    const verdict = judgeSchemathesisRun({ toolchain: AVAILABLE, surface: null, run: CLEAN_RUN });
    expect(verdict.decision).toBe('unavailable');
    expect(schemathesisExitCode(verdict)).toBe(2);
  });

  it('refuses when the process never ran, carrying its detail through', () => {
    const verdict = judgeSchemathesisRun({
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: { exitCode: null, operationsTested: null, checksFailed: null, detail: 'spawn ENOENT' },
    });
    expect(verdict.decision).toBe('unavailable');
    expect(verdict.notes.join(' ')).toContain('spawn ENOENT');
  });
});

// ── The exhaustive property, and the controls that prove it discriminates ────

/**
 * Every input combination worth enumerating, paired with whether a `pass` is
 * legitimate. Anything with a broken precondition must never reach exit 0.
 */
const CASES: ReadonlyArray<{ name: string; input: JudgeSchemathesisInput; mayPass: boolean }> = [
  {
    name: 'everything present',
    input: { toolchain: AVAILABLE, surface: SURFACE, run: CLEAN_RUN },
    mayPass: true,
  },
  {
    name: 'toolchain absent',
    input: { toolchain: UNAVAILABLE, surface: SURFACE, run: CLEAN_RUN },
    mayPass: false,
  },
  {
    name: 'schema unparseable',
    input: { toolchain: AVAILABLE, surface: null, run: CLEAN_RUN },
    mayPass: false,
  },
  {
    name: 'schema empty',
    input: {
      toolchain: AVAILABLE,
      surface: { paths: 0, operations: 0, operationsWithSchema: 0, componentSchemas: 0 },
      run: CLEAN_RUN,
    },
    mayPass: false,
  },
  {
    name: 'run absent',
    input: { toolchain: AVAILABLE, surface: SURFACE, run: null },
    mayPass: false,
  },
  {
    name: 'run exercised nothing',
    input: {
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: { exitCode: 0, operationsTested: 0, checksFailed: 0 },
    },
    mayPass: false,
  },
  {
    name: 'run extent unknown',
    input: {
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: { exitCode: 0, operationsTested: null, checksFailed: 0 },
    },
    mayPass: false,
  },
  {
    name: 'toolchain absent AND nothing exercised',
    input: {
      toolchain: UNAVAILABLE,
      surface: null,
      run: { exitCode: 0, operationsTested: 0, checksFailed: 0 },
    },
    mayPass: false,
  },
];

/** The property under test, applied to any judge-shaped function. */
function violatesRefusalContract(judge: (input: JudgeSchemathesisInput) => {
  decision: SchemathesisDecisionLike;
}): string[] {
  const violations: string[] = [];
  for (const c of CASES) {
    const decision = judge(c.input).decision;
    const passed = decision === 'pass';
    if (passed && !c.mayPass) violations.push(`${c.name}: reported pass on a broken precondition`);
    if (!passed && c.mayPass) violations.push(`${c.name}: refused a legitimate pass`);
  }
  return violations;
}

type SchemathesisDecisionLike = 'pass' | 'violations' | 'unavailable';

describe('the refusal contract holds across every precondition combination', () => {
  it('never reports pass on a broken precondition, and never refuses a real one', () => {
    expect(violatesRefusalContract(judgeSchemathesisRun)).toEqual([]);
  });

  it('never maps a non-pass verdict to exit 0', () => {
    for (const c of CASES) {
      const verdict = judgeSchemathesisRun(c.input);
      if (verdict.decision !== 'pass') {
        expect(schemathesisExitCode(verdict), `${c.name} must not exit 0`).not.toBe(0);
      }
      // conclusive and pass/violations must agree — an unavailable verdict
      // claiming conclusiveness would let a caller gate on it.
      expect(verdict.conclusive).toBe(verdict.decision !== 'unavailable');
    }
  });

  // ── CONTROLS ──────────────────────────────────────────────────────────────
  // Deliberately-wrong judges kept permanently in the suite. If the property
  // above passed against these too, it would be measuring nothing.

  it('CONTROL: a judge that skips-on-missing-toolchain is CAUGHT', () => {
    const skipOnMissing = (input: JudgeSchemathesisInput) => ({
      // The classic decoration: absent dependency treated as "nothing to do".
      decision: (input.toolchain.available
        ? judgeSchemathesisRun(input).decision
        : 'pass') as SchemathesisDecisionLike,
    });
    const found = violatesRefusalContract(skipOnMissing);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join(' ')).toContain('toolchain absent');
  });

  it('CONTROL: a judge that trusts the exit code alone is CAUGHT', () => {
    const trustExitCode = (input: JudgeSchemathesisInput) => ({
      decision: (input.run?.exitCode === 0 ? 'pass' : 'violations') as SchemathesisDecisionLike,
    });
    const found = violatesRefusalContract(trustExitCode);
    expect(found.length).toBeGreaterThan(0);
    // It waves through the vacuous run, which is exactly GUARD 2.
    expect(found.join(' ')).toContain('run exercised nothing');
  });

  it('CALIBRATION: the real judge passes the case both controls also pass', () => {
    // Without this, the controls could be "caught" by a property that rejects
    // everything, which would prove nothing about discrimination.
    const legit = CASES.find((c) => c.mayPass)!;
    expect(judgeSchemathesisRun(legit.input).decision).toBe('pass');
  });
});

describe('buildSchemathesisArgv — zero per-endpoint maintenance', () => {
  const base = {
    schemaLocation: 'http://127.0.0.1:3070/api/openapi.json',
    baseUrl: 'http://127.0.0.1:3070',
    maxExamples: 5,
  };

  it('builds a pipx invocation carrying the pin', () => {
    const built = buildSchemathesisArgv({
      ...base,
      toolchain: { ...AVAILABLE, runner: 'pipx', version: SCHEMATHESIS_PIN },
    });
    expect(built).not.toBeNull();
    expect(built!.command).toBe('pipx');
    expect(built!.args).toContain(`schemathesis==${SCHEMATHESIS_PIN}`);
  });

  it('builds a module invocation when schemathesis is importable', () => {
    const built = buildSchemathesisArgv({ ...base, toolchain: AVAILABLE })!;
    expect(built.command).toBe('python3');
    // MEASURED: the bare `-m schemathesis` form fails with "'schemathesis' is a
    // package and cannot be directly executed" — it ships no __main__. Both
    // console scripts resolve to schemathesis.cli:schemathesis.
    expect(built.args.slice(0, 2)).toEqual(['-m', 'schemathesis.cli']);
    expect(built.args[1]).not.toBe('schemathesis');
  });

  it('returns null rather than a runnable command when the toolchain is unavailable', () => {
    expect(buildSchemathesisArgv({ ...base, toolchain: UNAVAILABLE })).toBeNull();
  });

  it('names the schema and base url and NOTHING about individual endpoints', () => {
    const built = buildSchemathesisArgv({ ...base, toolchain: AVAILABLE })!;
    const argv = built.args.join(' ');
    expect(argv).toContain(base.schemaLocation);
    expect(argv).toContain(base.baseUrl);
    // The property that makes this zero-maintenance: adding an endpoint
    // upstream must not require editing this argv.
    expect(argv).not.toMatch(/\/api\/[a-z-]+\s/);
  });

  it('passes an include filter through only when one is supplied', () => {
    const withFilter = buildSchemathesisArgv({
      ...base,
      toolchain: AVAILABLE,
      includePathRegex: '^/api/health',
    })!;
    expect(withFilter.args).toContain('--include-path-regex');
    const without = buildSchemathesisArgv({ ...base, toolchain: AVAILABLE })!;
    expect(without.args).not.toContain('--include-path-regex');
  });
});

// ── Parser, against the REAL captured report shape ──────────────────────────
// These lines are structurally faithful to a schemathesis 4.25.2 run against
// this operator's own document on 2026-09-04 (5 of 1761 operations selected by
// `--include-path-regex '^/api/health'`; 5 success, 5 failure, 5 skip
// scenarios; 7 failed checks). Fabricating this shape would have been wrong:
// the first draft assumed a `--report=json` document that 4.25.2 rejects.

const REAL_LOADING =
  '{"LoadingFinished":{"id":"865eb2cf","timestamp":1788492740.16,"duration":0.353,' +
  '"specification":{"kind":"openapi","version":"3.1.0"},' +
  '"statistic":{"operations":{"total":1761,"selected":5},' +
  '"transitions":{"total":0,"selected":0},"resource_pool":{"resources":0}}}}';

const REAL_SUCCESS =
  '{"ScenarioFinished":{"id":"75338814","status":"success","phase":"fuzzing",' +
  '"recorder":{"label":"GET /api/health/ready",' +
  '"checks":{"vVHDpl":[{"name":"not_a_server_error","status":"success"}]}}}}';

const REAL_FAILURE =
  '{"ScenarioFinished":{"id":"a1b2c3d4","status":"failure","phase":"fuzzing",' +
  '"recorder":{"label":"POST /api/health:ack","checks":{"Xy9Q":[' +
  '{"name":"status_code_conformance","status":"failure"},' +
  '{"name":"missing_required_header","status":"failure"}]}}}}';

const REAL_SKIP =
  '{"ScenarioFinished":{"id":"deadbeef","status":"skip","phase":"stateful",' +
  '"recorder":{"label":"GET /api/health","checks":{}}}}';

const REAL_ENGINE_END =
  '{"EngineFinished":{"id":"29d1354c","running_time":2.2,"stop_reason":"completed"}}';

describe('parseSchemathesisReport', () => {
  const report = [REAL_LOADING, REAL_SUCCESS, REAL_FAILURE, REAL_SKIP, REAL_ENGINE_END].join('\n');

  it('recovers the operation census from LoadingFinished.statistic', () => {
    const parsed = parseSchemathesisReport(report);
    expect(parsed.operationsTotal).toBe(1761);
    expect(parsed.operationsSelected).toBe(5);
    expect(parsed.stopReason).toBe('completed');
  });

  it('counts executed scenarios, excluding skips', () => {
    const parsed = parseSchemathesisReport(report);
    // success + failure executed; the stateful skip did not.
    expect(parsed.scenariosExecuted).toBe(2);
    expect(parsed.operationsTested).toBe(5);
  });

  it('counts every non-success check across all cases', () => {
    expect(parseSchemathesisReport(report).checksFailed).toBe(2);
  });

  it('reports 0 exercised when operations were selected but every scenario skipped', () => {
    // The vacuous-green shape: schemathesis exits 0 having run nothing.
    const parsed = parseSchemathesisReport([REAL_LOADING, REAL_SKIP, REAL_ENGINE_END].join('\n'));
    expect(parsed.operationsSelected).toBe(5);
    expect(parsed.operationsTested).toBe(0);
  });

  it('returns null counts — not zero — for an empty or absent report', () => {
    const parsed = parseSchemathesisReport('');
    expect(parsed.operationsTested).toBeNull();
    expect(parsed.checksFailed).toBeNull();
    expect(parsed.stopReason).toBeNull();
  });

  it('returns a null operation count when a future format drops the census', () => {
    // Degrades to a refusal, never to a false pass.
    const parsed = parseSchemathesisReport([REAL_SUCCESS, REAL_ENGINE_END].join('\n'));
    expect(parsed.operationsTested).toBeNull();
    expect(
      judgeSchemathesisRun({
        toolchain: AVAILABLE,
        surface: SURFACE,
        run: { exitCode: 0, operationsTested: parsed.operationsTested, checksFailed: 0 },
      }).decision,
    ).toBe('unavailable');
  });

  it('survives malformed lines and reports how many it skipped', () => {
    const parsed = parseSchemathesisReport(
      [REAL_LOADING, 'not json at all', '', REAL_FAILURE, '{"truncated":'].join('\n'),
    );
    expect(parsed.operationsTotal).toBe(1761);
    expect(parsed.detail).toContain('2 unparseable line(s)');
  });

  it('end-to-end: the real run shape judges as VIOLATIONS, exit 1', () => {
    const parsed = parseSchemathesisReport(report);
    const verdict = judgeSchemathesisRun({
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: { exitCode: 1, operationsTested: parsed.operationsTested, checksFailed: parsed.checksFailed },
    });
    expect(verdict.decision).toBe('violations');
    expect(schemathesisExitCode(verdict)).toBe(1);
  });
});

describe('the report format is pinned to what the CLI actually accepts', () => {
  it('requests ndjson — 4.25.2 rejects `--report=json` outright', () => {
    const built = buildSchemathesisArgv({
      toolchain: AVAILABLE,
      schemaLocation: 'http://x/openapi.json',
      baseUrl: 'http://x',
      maxExamples: 1,
    })!;
    expect(built.args).toContain('--report=ndjson');
    expect(built.args).not.toContain('--report=json');
  });
});

describe('describeSchemathesisVerdict', () => {
  it('leads with the decision so a log line is scannable', () => {
    const pass = judgeSchemathesisRun({ toolchain: AVAILABLE, surface: SURFACE, run: CLEAN_RUN });
    expect(describeSchemathesisVerdict(pass)).toMatch(/^PASS/);

    const violations = judgeSchemathesisRun({
      toolchain: AVAILABLE,
      surface: SURFACE,
      run: { exitCode: 1, operationsTested: 5, checksFailed: 2 },
    });
    expect(describeSchemathesisVerdict(violations)).toMatch(/^VIOLATIONS/);
  });
});
