/**
 * affected-tests-repo-wide-invariant-guards.test.ts — EI-19388389386110890 regression guard.
 *
 * ## The gap this covers
 *
 * `scripts/affected-tests.mjs` selects suites by WORKSPACE. That is right for a
 * test that covers its own workspace, and wrong for a check whose SCOPE is the
 * whole repository but which happens to live in one workspace's suite: the check
 * then runs only when its host workspace is independently affected.
 *
 * `child-output-guard.test.ts` is that shape. It enumerates via
 * `git ls-files --recurse-submodules` — ~20k TypeScript paths across 39
 * submodules — but it is a vitest file inside @papercusp/operator-core. So a
 * chunk-unsafe `stdout += String(chunk)` introduced anywhere ELSE produced no
 * local signal at all (test:affected green; lint:tsc is type-only and green) and
 * first surfaced hours later as a red FLEET gate blocking every agent. That is
 * the entire reported history of the class: five separate CORRECT fixes
 * (EI-19298378364087215, EI-19356631236774183, WI-6776, WI-6666/WI-6667), each
 * caught at the most expensive possible moment, each looking like fresh breakage
 * because each offender genuinely was new.
 *
 * `REPO_WIDE_INVARIANT_GUARDS` closes it by attaching a NARROW, cheap task
 * (~1s, 14 assertions) whenever a matching path changes anywhere.
 *
 * ## What this guard asserts, and what it does not
 *
 * It asserts BEHAVIOR through the real CLI's `--dry` probe (builds the task list,
 * runs nothing), never source text. It covers the four independent ways the
 * wiring silently reopens:
 *
 *   1. the guard stops being attached for changes outside its host workspace —
 *      the original bug, and the one that reads as "green" rather than as broken;
 *   2. it starts double-running when the host workspace IS affected (the whole
 *      suite already contains it) — cheap to miss, since duplicated work still
 *      passes;
 *   3. it fires for changes that cannot possibly violate the invariant;
 *   4. the `lint:chunk-safe` script disappears from operator-core's package.json,
 *      which would make the attachment a silent no-op — the same failure shape as
 *      WI-6077's missing `test` script;
 *   5. the vimock strand guard receives the runner's authoritative diff base, so
 *      git-sync cannot turn a selected guard run into a HEAD-vs-HEAD no-op.
 *
 * It does NOT assert that the guard itself is correct; that is
 * child-output-guard.test.ts's job.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The REAL exports of the lint, so the roots below cannot drift from the roots it scans.
import {
  SOURCE_ROOTS as PARTIAL_INDEX_SOURCE_ROOTS,
  SCHEMA_FILE_REL as PARTIAL_INDEX_SCHEMA_FILE,
} from '../../../../scripts/check-partial-index-alignment.mjs';
// Likewise the REAL scanned dir of the forward-compat lint, so the guard's routing
// prefix cannot drift from the directory the lint actually reads.
import {
  SQL_DIR_REL as MIGRATION_SQL_DIR,
  SOURCE_ROOTS as MIGRATION_SOURCE_ROOTS,
} from '../../../../scripts/check-migration-forward-compat.mjs';
// And the REAL scan roots + routing predicate of the OKF conformance lint. The router
// MIRRORS these as literals on purpose (a static import there would let a load error in
// this lint hard-fail every agent's test:affected), so importing the originals HERE is
// what keeps the mirror honest.
import { OKF_SCAN_ROOTS, isOkfScannedFile } from '../../../../scripts/check-okf-conformance.mjs';
// WI-37605 — same reason as the import above: the router MIRRORS this list rather than importing
// it, so importing the ORIGINAL here is what keeps the mirror honest.
import { GC_TAG_SOURCE_ROOTS } from '../../../../scripts/check-green-checkpoint-tag.mjs';
// WI-37826 — same mirror-honesty reason: the router hardcodes this number rather than importing
// it, so importing the ORIGINAL here is what stops the two from drifting apart.
import { EXIT_NOT_CHECKED } from '../../../../scripts/lib/not-checked.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const HOST_WORKSPACE = '@papercusp/operator-core';
const DEPENDENCY_INTEGRITY_SCRIPT = 'lint:dependency-integrity';
const DEPENDENCY_INTEGRITY_TASK = `${HOST_WORKSPACE} :: ${DEPENDENCY_INTEGRITY_SCRIPT}`;
const TEST_RUNNABILITY_SCRIPT = 'lint:tests';
const TEST_RUNNABILITY_TASK = `@papercusp/web :: ${TEST_RUNNABILITY_SCRIPT}`;
const GUARD_SCRIPT = 'lint:chunk-safe';
const GUARD_TASK = `${HOST_WORKSPACE} :: ${GUARD_SCRIPT}`;

/**
 * A TS path OUTSIDE the guard's host workspace. `apps/operator` is the measured
 * case from the filing: it routes to @papercusp/web, never to operator-core.
 */
const OUTSIDE_TS_PATH = 'apps/operator/lib/release/deploy-cli.ts';
const OUTSIDE_TS_BASENAME = basename(OUTSIDE_TS_PATH);
/** A test-only TS path the vimock export guard deliberately refuses to inspect. */
const OUTSIDE_TEST_PATH = 'apps/operator/lib/verify-tauri-headless-quoting.test.ts';
/** A TS path INSIDE the host workspace, whose full `test` task already covers the guard. */
const INSIDE_TS_PATH = 'packages/operator-core/lib/terminal-spawn.ts';
/** A non-source path that cannot introduce a stream accumulator. */
const NON_SOURCE_PATH = 'apps/operator/docs/nuqs-audit-2026-05-11.md';
const VIMOCK_GUARD_SCRIPT = 'lint:vimock-export-strands';
const VIMOCK_GUARD_TASK = `${HOST_WORKSPACE} :: ${VIMOCK_GUARD_SCRIPT}`;

const AUTHORED_DOC_SCRIPT = 'gen:authored-docs:check';
const AUTHORED_DOC_TASK = `${HOST_WORKSPACE} :: ${AUTHORED_DOC_SCRIPT}`;
const DOCS_ROOT = 'apps/operator-docs/src/content/docs';
const AUTHORED_DOC_PATH = `${DOCS_ROOT}/agent-insights/a-cheap-repeating-beat-must-not-inherit-a-restart-sized-retry-budget.mdx`;
const AUTHORED_DOC_ID = AUTHORED_DOC_PATH.slice(`${DOCS_ROOT}/`.length);
const GENERATOR_OWNED_DOC_PATH = `${DOCS_ROOT}/reference/agent-insights-index.md`;
const PROJECTOR_PATH = 'scripts/project-authored-docs.ts';
const DOCS_CONFIG_PATH = '.papercusp/docs.json';

/**
 * Run the real CLI in --dry mode: it resolves the affected set and BUILDS the task
 * list, then exits without executing a suite. Deliberately the same probe shape the
 * standalone-packages guard uses — asserting on behavior keeps this test honest if
 * the mechanism is ever reimplemented differently.
 */
function dryTasks(changedPaths: string, base?: string, probeEnv?: NodeJS.ProcessEnv): string {
  const baseArgs = base ? ['--base', base] : [];
  const res = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', changedPaths, ...baseArgs, '--dry'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    // `probeEnv` exists ONLY so the abort path above can be exercised by its own guard
    // without breaking a tracked file. Every production call leaves it undefined.
    ...(probeEnv ? { env: probeEnv } : {}),
  });
  // Fail loudly rather than letting a crashed probe read as "guard absent" — a
  // non-zero exit with empty stdout would otherwise satisfy every `not.toContain`.
  expect(res.error, `CLI failed to spawn: ${res.error?.message}`).toBeUndefined();
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  expect(out, 'probe produced no output — cannot conclude anything about task selection').not.toBe('');
  // A NON-ZERO exit means the CLI aborted BEFORE it routed anything, so this run says
  // nothing about task selection either way. Checking it is what stops the abort from
  // being misattributed: without it the next assertion is the one that fails, as
  // `expected 'file:///…' to contain 'AFFECTED_TESTS_RESULT'` — a message that names the
  // routing contract while the actual cause is a crash, and that truncates to the stack's
  // first line so the real error is not even visible. On this shared tree the usual cause
  // is a PEER's half-written file in the runner's import graph (measured 2026-08-30T15:07Z:
  // `constEMPTY_MARKER_DEBRIS_MS` — a missing space in scripts/lib/preempt-markers.mjs —
  // reddened this suite as if its routing had regressed). `--dry` builds the task list and
  // exits 0 on every path class, so a non-zero status here is never a legitimate verdict.
  expect(res.status, dryAbortDiagnostic(changedPaths, res.status, out)).toBe(0);
  expect(out, `CLI exited 0 but emitted no ${RESULT_MARKER} verdict line:\n${outputTail(out)}`).toContain(
    RESULT_MARKER,
  );
  return out;
}

const RESULT_MARKER = 'AFFECTED_TESTS_RESULT';

/** Last `limit` lines of a probe's combined output — the part that carries the real error. */
function outputTail(out: string, limit = 12): string {
  return out.trimEnd().split('\n').slice(-limit).join('\n');
}

/**
 * The message a reader gets when the probe CLI aborts. It must name the abort as the
 * subject and surface the underlying stack, because the failure it replaces pointed at
 * the routing contract instead and hid the cause.
 */
function dryAbortDiagnostic(changedPaths: string, status: number | null, out: string): string {
  return [
    `affected-tests CLI ABORTED (exit ${status ?? 'null'}) before producing a ${RESULT_MARKER} verdict.`,
    'This is NOT a routing regression in the guard under test — the runner never got far enough',
    'to route anything. The usual cause is a syntax/module-load error in the runner\'s import',
    'graph, often a peer\'s in-flight edit on this shared tree; re-run once the tree is clean.',
    `  probed --changed-paths: ${changedPaths}`,
    '  CLI output (tail):',
    outputTail(out),
  ].join('\n');
}

function commitSha(ref: string): string {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(res.status, `could not resolve ${ref}: ${res.stderr ?? ''}`).toBe(0);
  const sha = (res.stdout ?? '').trim();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  return sha;
}

/**
 * Resolve a MOVING ref once and hand the probe a stable spelling of that same commit.
 *
 * WI-10005544: passing `HEAD^` itself to the router let git-sync race the two resolutions.
 * The test resolved HEAD^ to 6b8aa9e5, git-sync committed twice, and the router then
 * resolved HEAD^ to d888157d, so the forwarded-base assertion failed although the guard
 * was attached correctly. The abbreviated sha cannot move, but it is still a ref the router
 * must expand to the full 40-char sha, so the ref-to-sha resolution stays exercised.
 */
function pinnedBase(ref: string): { base: string; probeRef: string } {
  const base = commitSha(ref);
  return { base, probeRef: base.slice(0, 12) };
}

function dryTaskLine(out: string, task: string): string {
  const line = out.split('\n').find((candidate) => candidate.includes(`:: ${task.split(' :: ')[1]}`));
  expect(line, `dry probe did not list ${task}:\n${out}`).toBeDefined();
  return line ?? '';
}

/**
 * Run the print-only probe through the real CLI. This must stay separate from
 * `dryTasks`: `--dry` prints human task descriptions, while `--print-affected`
 * is the machine-readable surface used by release-prefix tooling.
 */
function printAffected(changedPaths: string, probeEnv?: NodeJS.ProcessEnv): string {
  const res = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', changedPaths, '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    ...(probeEnv ? { env: probeEnv } : {}),
  });
  expect(res.error, `CLI failed to spawn: ${res.error?.message}`).toBeUndefined();
  expect(res.status, `print-only probe failed:\n${res.stderr ?? ''}`).toBe(0);
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
}

describe('affected-tests: Phone media source recurrence', () => {
  it.each(['infra/phone-app/deploy.sh', 'infra/phone-app/media-config.mjs',
    'infra/phone-app/livekit-server.yaml.tmpl', 'infra/phone-app/livekit-sip.yaml.tmpl',
    'infra/phone-app/verify-media-plane.sh', 'apps/operator/e2e/phone-media-probe.spec.ts',
    'apps/operator/package.json'])
  ('selects all registered media layers for %s', path => {
    expect(printAffected(path)).toContain('test:phone-media');
  });

  it('keeps media integration coverage when the web unit suite is also selected', () => {
    expect(printAffected('infra/phone-app/deploy.sh,apps/operator/lib/use-workspace.ts')).toContain('test:phone-media');
  });

  it('does not select media tests for unrelated infrastructure', () => {
    expect(printAffected('infra/defguard/Caddyfile')).not.toContain('test:phone-media');
  });

  it('names real unit, integration and isolated e2e commands in its host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'apps/operator/package.json'), 'utf8'));
    const command = pkg.scripts['test:phone-media'];
    expect(command).toContain('phone-app-hosted-config.test.ts --config vitest.config.ts');
    expect(command).toContain('phone-app-hosted-config.integration.test.ts --config vitest.integration.config.ts');
    expect(command).toContain('OPERATOR_E2E_REUSE_SERVER=1 playwright test e2e/phone-media-probe.spec.ts --workers=1');
  });
});

/**
 * EI-21943909516081455 — the probe must distinguish "the runner ABORTED" from "the runner
 * ran and routed wrongly".
 *
 * `dryTasks` spawns the runner out of the LIVE working tree, which on this shared checkout
 * is mutated continuously by other agents. When a peer's in-flight edit leaves a syntax
 * error anywhere in the runner's import graph, the spawn SUCCEEDS, the process exits
 * non-zero, and stderr carries a stack — so `res.error` is undefined and the output is
 * non-empty, and both pre-existing checks pass. The failure then landed on the marker
 * assertion and read as `expected 'file:///…' to contain 'AFFECTED_TESTS_RESULT'`: it named
 * the routing contract rather than the crash, and truncated to the stack's first line so the
 * actual error never appeared. Measured live on 2026-08-30T15:07:31Z.
 *
 * The crash is injected via NODE_OPTIONS into a throwaway module, never by mutating a
 * tracked file — a probe that edits the shared tree can be committed by the git-sync sweep
 * even when nothing goes wrong (see CLAUDE.md, "Proving a guard is falsifiable").
 */
describe('affected-tests: probe abort attribution (EI-21943909516081455)', () => {
  let crashDir = '';
  let crashModule = '';

  beforeAll(() => {
    crashDir = mkdtempSync(resolve(tmpdir(), 'affected-tests-abort-'));
    crashModule = resolve(crashDir, 'boom.mjs');
    writeFileSync(crashModule, "throw new ReferenceError('constEMPTY_MARKER_DEBRIS_MS is not defined');\n");
  });

  afterAll(() => {
    if (crashDir) rmSync(crashDir, { recursive: true, force: true });
  });

  function crashEnv(): NodeJS.ProcessEnv {
    return { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(crashModule).href}` };
  }

  function abortedProbe(): { status: number | null; out: string } {
    const res = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', OUTSIDE_TS_PATH, '--dry'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: crashEnv(),
    });
    return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  }

  it('an import-graph crash produces exactly the shape both pre-existing checks let through', () => {
    const { status, out } = abortedProbe();
    // The precondition that made the misattribution possible: not a spawn error, not empty
    // output — so only the exit status can tell an abort from a routing answer.
    expect(status, 'expected the injected crash to abort the runner').not.toBe(0);
    expect(out, 'a crashed runner still writes its stack, so the empty-output check cannot catch this').not.toBe(
      '',
    );
    expect(out).not.toContain(RESULT_MARKER);
  });

  it('reports the abort as the subject, and surfaces the underlying error instead of hiding it', () => {
    // The REAL helper, on the REAL abort path — not a re-derivation of it. Removing the
    // status check makes this throw the marker assertion instead, and every match below fails.
    let message = '';
    try {
      dryTasks(OUTSIDE_TS_PATH, undefined, crashEnv());
      expect.unreachable('the probe aborted, so dryTasks must not return a task list');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('ABORTED');
    expect(message).toContain('NOT a routing regression');
    // The cause has to reach the reader; the assertion this replaces truncated it away.
    expect(message).toContain('ReferenceError');
    expect(message).toContain('constEMPTY_MARKER_DEBRIS_MS');
    // And it must NOT read as the routing-contract failure it used to be mistaken for.
    expect(message).not.toMatch(/expected .* to contain/);
  });

  it('a healthy run still exits 0 with a verdict, so the status check cannot red a clean tree', () => {
    const res = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', OUTSIDE_TS_PATH, '--dry'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(res.status).toBe(0);
    expect(`${res.stdout ?? ''}${res.stderr ?? ''}`).toContain(RESULT_MARKER);
  });
});

describe('affected-tests: dependency-integrity preflight (EI-20863794002653922)', () => {
  it('attaches for an ordinary change outside the host workspace', () => {
    expect(dryTasks(OUTSIDE_TS_PATH)).toContain(DEPENDENCY_INTEGRITY_TASK);
  });

  it('still attaches when the host suite is selected because that suite cannot inspect its own runner before startup', () => {
    const out = dryTasks(INSIDE_TS_PATH);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(out).toContain(DEPENDENCY_INTEGRITY_TASK);
  });

  it('keeps the host script pointed at the reused detector and guarded by the install mutex', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[DEPENDENCY_INTEGRITY_SCRIPT];

    expect(command).toBeTruthy();
    expect(command).toContain('npm-install-safe.mjs');
    expect(command).toContain('--exec-under-lock');
    expect(command).toContain('check-declared-deps-extracted.mjs');
    expect(command).not.toContain('vitest');
  });
});

describe('affected-tests: registry-test runnability invariant (EI-15951)', () => {
  it.each([
    'tools/perf-test/wdio/specs/smoke.spec.ts',
    'apps/operator/playwright.config.ts',
    'libs/test-config/src/vitest-config.ts',
    '.papercusp/testing-domains.json',
  ])('attaches lint:tests when %s can change executor coverage', (changedPath) => {
    expect(dryTasks(changedPath)).toContain(TEST_RUNNABILITY_TASK);
  });

  it('does not attach the executor audit for an unrelated prose-only change', () => {
    expect(dryTasks(NON_SOURCE_PATH)).not.toContain(TEST_RUNNABILITY_TASK);
  });

  it('keeps the selected lint task defined on its host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'apps/operator/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[TEST_RUNNABILITY_SCRIPT]).toBe('tsx scripts/lint-tests.ts');
  });
});

describe('affected-tests: repo-wide invariant guards (EI-19388389386110890)', () => {
  it('attaches the chunk-safe guard for a TS change OUTSIDE its host workspace', () => {
    const out = dryTasks(OUTSIDE_TS_PATH);
    // The regression: before this wiring, operator-core was simply absent here.
    expect(
      out,
      `a TS change at ${OUTSIDE_TS_PATH} must still run the repo-wide chunk-safe guard; ` +
        'without it, a chunk-unsafe accumulator introduced outside operator-core gets ' +
        'ZERO local signal and first reds the shared gate hours later',
    ).toContain(GUARD_TASK);
  });

  it('expands a file-level basename before selecting workspaces or forwarding guard files', () => {
    const { base, probeRef: baseRef } = pinnedBase('HEAD^');
    const out = dryTasks(OUTSIDE_TS_BASENAME, baseRef);
    expect(
      out,
      `a file runner may report only ${OUTSIDE_TS_BASENAME}; affected-tests must resolve it ` +
        `to ${OUTSIDE_TS_PATH} before computing the workspace closure`,
    ).toContain('@papercusp/web :: test');
    expect(
      out,
      'repo-wide guards must receive the resolved repository-relative path, not an unresolvable basename',
    ).toContain(`${VIMOCK_GUARD_TASK} (guard base: ${base}) (guard args: --files=${OUTSIDE_TS_PATH})`);
  });

  it('does NOT double-run it when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_TS_PATH);
    expect(out, 'the host workspace should run its own suite here').toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      `${HOST_WORKSPACE}'s full test suite already contains child-output-guard.test.ts, so ` +
        'attaching the narrow task as well would run the same assertions twice',
    ).not.toContain(GUARD_TASK);
  });

  it('does NOT attach it for a change that cannot violate the invariant', () => {
    const out = dryTasks(NON_SOURCE_PATH);
    expect(
      out,
      'the guard is paid for by every agent on every edit; attaching it to non-source ' +
        'changes spends that budget for no possible finding',
    ).not.toContain(GUARD_TASK);
  });

  it('keeps the guard script defined, so the attachment cannot silently no-op', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[GUARD_SCRIPT],
      `${HOST_WORKSPACE} must define "${GUARD_SCRIPT}". The router only builds a task when ` +
        'the script exists, so removing it re-opens the gap silently — the run stays green ' +
        'and simply stops checking (the WI-6077 missing-`test`-script failure shape).',
    ).toBeTruthy();
    expect(pkg.scripts?.[GUARD_SCRIPT]).toContain('child-output-guard.test.ts');
  });

  it('forwards the runner base and exact triggering paths to the vimock strand guard', () => {
    const { base, probeRef: baseRef } = pinnedBase('HEAD^');
    const out = dryTasks(OUTSIDE_TS_PATH, baseRef);
    expect(
      out,
      `${VIMOCK_GUARD_TASK} must receive the same base that affected-tests used for its ` +
        'authoritative changed-path derivation AND the exact triggering paths; otherwise ' +
        'git-sync leaves the guard comparing HEAD with itself or widens attribution to peers',
    ).toContain(`${VIMOCK_GUARD_TASK} (guard base: ${base}) ` + `(guard args: --files=${OUTSIDE_TS_PATH})`);
  });

  it('does NOT attach the vimock strand guard for a test-only change it cannot inspect', () => {
    const out = dryTasks(OUTSIDE_TEST_PATH);
    expect(out).toContain('@papercusp/web :: test');
    expect(
      out,
      'the guard deliberately skips test/spec files because their own exports are not mocked ' +
        'production surfaces; scheduling it here guarantees EXIT_NOT_CHECKED and falsely makes ' +
        'an otherwise-green test-only affected run non-green',
    ).not.toContain(VIMOCK_GUARD_TASK);
  });

  it('attaches and forwards a SUBMODULE ROOT — the only superproject path for internal edits', () => {
    const { base, probeRef: baseRef } = pinnedBase('HEAD^');
    const submodule = someSubmodulePath();
    expect(
      dryTasks(submodule, baseRef),
      `a runtime export added inside ${submodule} reaches affected-tests only as the bare ` +
        'gitlink path; a TS-extension-only predicate silently omits the guard for the whole submodule',
    ).toContain(`${VIMOCK_GUARD_TASK} (guard base: ${base}) ` + `(guard args: --files=${submodule})`);
  });
});

/**
 * WI-2144309 / design-to-code-coverage-seam P-027 — the persistent venue is
 * deliberately expensive enough that it must be selected by a narrow guard,
 * not folded into every operator-core run. The integration test proves the
 * writer; these assertions prove the runner actually reaches it, and only for
 * inputs capable of breaking attribution.
 */
const COVERAGE_ATTRIBUTION_VENUE_SCRIPT = 'test:coverage-attribution-venue';
const COVERAGE_ATTRIBUTION_VENUE_TASK = `${HOST_WORKSPACE} :: ${COVERAGE_ATTRIBUTION_VENUE_SCRIPT}`;
const COVERAGE_ATTRIBUTION_VENUE_PATH =
  'packages/operator-core/lib/coverage-census/attribution/persistence-venue.integration.test.ts';
const COVERAGE_ATTRIBUTION_UNRELATED_PATH = 'packages/operator-core/lib/why-chain.ts';

describe('affected-tests: persistent coverage-attribution venue guard (WI-2144309)', () => {
  it.each([COVERAGE_ATTRIBUTION_VENUE_PATH, 'scripts/affected-tests.mjs'])(
    'attaches the venue for an owned input: %s',
    (changedPath) => {
      expect(
        dryTasks(changedPath),
        `${changedPath} can break the persistence venue or its selection; the dedicated ` +
          'integration task must be present even when operator-core is already affected',
      ).toContain(COVERAGE_ATTRIBUTION_VENUE_TASK);
    },
  );

  it('does NOT attach the database venue to unrelated operator-core source', () => {
    expect(
      dryTasks(COVERAGE_ATTRIBUTION_UNRELATED_PATH),
      'the venue has a measured database cost and must not become an all-operator-core tax',
    ).not.toContain(COVERAGE_ATTRIBUTION_VENUE_TASK);
  });

  it('keeps the venue script defined, so selection cannot silently no-op', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.[COVERAGE_ATTRIBUTION_VENUE_SCRIPT];
    expect(script, 'affected-tests only queues guards whose workspace script exists').toBeTruthy();
    expect(script).toContain('PAPERCUSP_TEST_ATTRIBUTION=1');
    expect(script).toContain('persistence-venue.integration.test.ts');
  });
});

/**
 * EI-21618443971639284 — committed generated su.md projections must not silently
 * fall behind the canonical base persona. The guard is deliberately registered
 * without a hostSuiteRatchet: this exact-byte check is a repo-root artifact
 * comparison, not something operator-core's ordinary Vitest suite executes.
 */
const PROMPT_PROJECTION_SCRIPT = 'lint:prompt-projections';
const PROMPT_PROJECTION_TASK = HOST_WORKSPACE + ' :: ' + PROMPT_PROJECTION_SCRIPT;
const PROMPT_CANONICAL_PATH = 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md';
const PROMPT_DESKTOP_PROJECTION_PATH =
  'papercusp-desktop/src-tauri/env-sidecars/staging/harness/blueprints/base/prompts/su.md';
const PROMPT_UNRELATED_PATH = 'apps/operator/docs/nuqs-audit-2026-05-11.md';

describe('affected-tests: generated su.md projection guard (EI-21618443971639284)', () => {
  it.each([PROMPT_CANONICAL_PATH, PROMPT_DESKTOP_PROJECTION_PATH])(
    'attaches for a changed projection input: %s',
    (changedPath) => {
      expect(
        dryTasks(changedPath),
        changedPath + ' can change the bytes served by a generated su.md consumer, so ' +
          'the exact-byte projection guard must run even when no ordinary workspace test ' +
          'would inspect the generated artifact',
      ).toContain(PROMPT_PROJECTION_TASK);
    },
  );

  it('does not attach for an unrelated prose path', () => {
    expect(
      dryTasks(PROMPT_UNRELATED_PATH),
      'a documentation edit outside the canonical prompt and generated projections cannot ' +
        'change this byte-equality invariant',
    ).not.toContain(PROMPT_PROJECTION_TASK);
  });

  it('keeps the guard script defined on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[PROMPT_PROJECTION_SCRIPT]).toContain('check-prompt-projections.mjs');
  });
});

/** identities-v1 P-024 — a marker rename/miss must reach the exact-once guard
 * from every authored/projection tree, including bare submodule gitlinks. */
const SU_SPLICE_MARKER_SCRIPT = 'lint:su-splice-markers';
const SU_SPLICE_MARKER_TASK = HOST_WORKSPACE + ' :: ' + SU_SPLICE_MARKER_SCRIPT;

describe('affected-tests: SU splice-marker exact-once guard (identities-v1 P-024)', () => {
  it.each([
    'libs/papercusp',
    'libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
    'apps/operator/prompts/papercusp-su-engineer.tools.md',
    'packages/operator-core/lib/desktop-install/splice-tooling-overlay.ts',
    'packages/operator-core/lib/desktop-install/__fixtures__/su-render-baseline/su.base.md',
    'papercusp-desktop',
    'papercusp-desktop/src-tauri/env-sidecars/staging/harness/blueprints/base/prompts/su.md',
    'scripts/check-su-splice-markers.ts',
  ])('attaches for a splice-contract input: %s', (changedPath) => {
    expect(dryTasks(changedPath)).toContain(SU_SPLICE_MARKER_TASK);
  });

  it('does not attach for an unrelated prose path', () => {
    expect(dryTasks(PROMPT_UNRELATED_PATH)).not.toContain(SU_SPLICE_MARKER_TASK);
  });

  it('keeps the guard script defined on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SU_SPLICE_MARKER_SCRIPT]).toContain('check-su-splice-markers.ts');
  });
});

/**
 * agent-launch-context-cost-2026-09-18 P-004 — the shrink-only ceilings on the PROSE half
 * of a launch payload.
 *
 * ROUTING IS THE WHOLE RISK HERE, which is why it is pinned rather than trusted. The
 * largest governed surface is the repo-ROOT CLAUDE.md, which belongs to no workspace, and
 * the rest straddle apps/operator/prompts and operator-core — so the ONE change that grows
 * these surfaces (a prose edit) is precisely the change ordinary workspace selection
 * cannot route to the gate. A guard that is registered but never attached is exactly the
 * state the reachable-advisories entry above was written to describe: falsifiable, and
 * never run.
 */
const LAUNCH_PROSE_BUDGET_SCRIPT = 'lint:launch-prose-budget';
const LAUNCH_PROSE_BUDGET_TASK = HOST_WORKSPACE + ' :: ' + LAUNCH_PROSE_BUDGET_SCRIPT;

describe('affected-tests: launch prose byte-budget guard (agent-launch-context-cost-2026-09-18 P-004)', () => {
  it.each([
    // The project guide — repo root, owned by no workspace suite.
    'CLAUDE.md',
    // The authored playbook bases and a client overlay.
    'apps/operator/prompts/papercusp-su-engineer.tools.md',
    'apps/operator/prompts/papercusp-su-power.tools.md',
    'apps/operator/prompts/papercusp-su.codex.md',
    // The compaction protocol sources.
    'apps/operator/prompts/papercusp-compaction.base.md',
    // The renderer — a splice change moves every measured number at once.
    'packages/operator-core/lib/desktop-install/papercusp-files.ts',
    // The gate, its comparison module and its baseline each decide what "clean" means.
    'scripts/check-launch-prose-budget.ts',
    'scripts/launch-prose-budget-baseline.json',
    'packages/operator-core/lib/launch-prose-budget.ts',
  ])('attaches for a governed prose surface or its instrument: %s', (changedPath) => {
    expect(dryTasks(changedPath)).toContain(LAUNCH_PROSE_BUDGET_TASK);
  });

  it('does not attach for an unrelated prose path', () => {
    expect(dryTasks(PROMPT_UNRELATED_PATH)).not.toContain(LAUNCH_PROSE_BUDGET_TASK);
  });

  it('does not attach for ordinary source that cannot change a prose surface', () => {
    expect(dryTasks(OUTSIDE_TS_PATH)).not.toContain(LAUNCH_PROSE_BUDGET_TASK);
  });

  it('STILL attaches when operator-core is affected — its suite never renders the real tree', () => {
    // No hostSuiteRatchet by design: the unit tests drive the comparison against fixtures,
    // but only this task renders the actual playbook and measures the actual files. If a
    // ratchet were ever added, this assertion is what would catch the resulting blind spot.
    expect(dryTasks('packages/operator-core/lib/launch-prose-budget.ts')).toContain(LAUNCH_PROSE_BUDGET_TASK);
  });

  it('keeps the guard script defined on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[LAUNCH_PROSE_BUDGET_SCRIPT]).toContain('check-launch-prose-budget.ts');
  });

  it('keeps every declared surface in the baseline paired with a stated reason', () => {
    // A ceiling with an empty `note` is a number nobody can evaluate later: the next agent
    // to hit a red has to guess whether the surface may grow. The note is the only place
    // that answer lives.
    const baseline = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'scripts/launch-prose-budget-baseline.json'), 'utf8'),
    ) as { ceilings: Array<{ surface: string; ceilingBytes: number; floorBytes: number; note: string }> };
    expect(baseline.ceilings.length).toBeGreaterThan(0);
    for (const c of baseline.ceilings) {
      expect(c.note.trim().length, `${c.surface} needs a stated reason`).toBeGreaterThan(40);
      expect(c.floorBytes, `${c.surface} floor must sit below its ceiling`).toBeLessThan(c.ceilingBytes);
      expect(c.floorBytes, `${c.surface} needs a real plausibility floor`).toBeGreaterThan(0);
    }
  });
});

describe('affected-tests: authored-doc guard candidate scope (EI-21079330201572062)', () => {
  it('passes the exact changed authored doc to the guard', () => {
    const line = dryTaskLine(dryTasks(AUTHORED_DOC_PATH), AUTHORED_DOC_TASK);
    expect(line).toContain(`(guard args: --files=${AUTHORED_DOC_ID})`);
  });

  it('excludes unrelated changed paths from the authored-doc allowlist', () => {
    const line = dryTaskLine(dryTasks(`${AUTHORED_DOC_PATH},${OUTSIDE_TS_PATH}`), AUTHORED_DOC_TASK);
    expect(line).toContain(`(guard args: --files=${AUTHORED_DOC_ID})`);
    expect(line).not.toContain(OUTSIDE_TS_PATH);
  });

  it('filters generator-owned docs when an authored doc changes alongside one', () => {
    const line = dryTaskLine(dryTasks(`${AUTHORED_DOC_PATH},${GENERATOR_OWNED_DOC_PATH}`), AUTHORED_DOC_TASK);
    expect(line).toContain(`(guard args: --files=${AUTHORED_DOC_ID})`);
    expect(line).not.toContain('reference/agent-insights-index.md');
  });

  it.each([PROJECTOR_PATH, DOCS_CONFIG_PATH])(
    'keeps the guard full-corpus for projector/config changes: %s',
    (changedPath) => {
      const line = dryTaskLine(dryTasks(changedPath), AUTHORED_DOC_TASK);
      expect(line).not.toContain('(guard args:');
      expect(line).not.toContain('--files=');
    },
  );
});

/**
 * WI-9434 — the SECOND instance of the class, wired the same way.
 *
 * `lint:partial-index-alignment` scans four roots but its ratchet ("the tree is
 * currently aligned") is a vitest file in @papercusp/operator-core, so three of
 * those four roots had no enforcement outside an operator-core-affecting change.
 *
 * The difference from chunk-safe, and why these tests are not a copy-paste: that
 * guard's enumeration is genuinely repo-wide, so its `appliesTo` is every TS file.
 * This one's scan is BOUNDED, so over-firing spends every agent's edit budget for a
 * finding that is impossible by construction — precision is part of the contract
 * here, and `does NOT attach for a TS file outside every scanned root` pins it.
 */
const PI_SCRIPT = 'lint:partial-index-alignment';
const PI_TASK = `${HOST_WORKSPACE} :: ${PI_SCRIPT}`;

/** A TS path under a scanned root that does NOT route to the host workspace. */
const PI_OUTSIDE_PATH = 'apps/operator/lib/release/green-checkpoint.ts';
/** A TS path under NO scanned root — the lint could never read it. */
const PI_UNSCANNED_PATH = 'apps/operator/app/adv/create/PreviewPanel.tsx';

describe('affected-tests: partial-index-alignment guard (WI-9434)', () => {
  it('attaches for a TS change outside the host workspace but inside a scanned root', () => {
    const out = dryTasks(PI_OUTSIDE_PATH);
    expect(
      out,
      `${PI_OUTSIDE_PATH} is inside the lint's scanned roots but routes to @papercusp/web, ` +
        'so without this attachment a misaligned `->>` query there gets ZERO local signal ' +
        'and first reds the shared fleet gate',
    ).toContain(PI_TASK);
  });

  /**
   * A REAL tracked TS file under `root`, or null.
   *
   * Must be a real path, not a synthesized one: the router maps a path to a workspace by
   * PACKAGE DIRECTORY, so an invented `<root>/__probe__.ts` sitting directly under
   * `libs/papercusp/packages` matches no package and selects nothing — which reads as
   * "the guard is not wired" when the wiring is fine. That false negative is what the
   * first version of this test reported.
   *
   * `--recurse-submodules` because two roots live in submodules. Gate-shaped checkouts
   * carry 0/39 submodules (WI-6776), so this returns null there and the case SKIPS rather
   * than failing — a guard test must not red the fleet gate over a checkout shape.
   */
  function realTsFileUnder(root: string): string | null {
    const res = spawnSync('git', ['ls-files', '--recurse-submodules', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) return null;
    // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
    return (res.stdout ?? '').split('\n').filter((f) => existsSync(resolve(REPO_ROOT, f))).find((f) => /\.[cm]?tsx?$/.test(f)) ?? null;
  }

  it.each(PARTIAL_INDEX_SOURCE_ROOTS.map((root) => [root]))(
    'enforces the lint for a change under scanned root %s',
    (root: string) => {
      const probe = realTsFileUnder(root);
      if (!probe) {
        // Nothing tracked under this root in THIS checkout (submodule-less gate tree).
        expect(true).toBe(true);
        return;
      }
      const out = dryTasks(probe);
      // Either form means the ratchet is reached: the narrow guard task, or the host
      // workspace's full suite (which already contains the ratchet, so attaching the
      // narrow task as well would just run it twice).
      const reached = out.includes(PI_TASK) || out.includes(`${HOST_WORKSPACE} :: test`);
      expect(
        reached,
        `the lint SCANS ${root} (probe: ${probe}), so a change there must reach its ratchet — ` +
          `via "${PI_TASK}" or via "${HOST_WORKSPACE} :: test". This case is GENERATED from the ` +
          "lint's own exported SOURCE_ROOTS: if you added a root there and did not mirror it into " +
          'PARTIAL_INDEX_SOURCE_ROOTS in scripts/affected-tests.mjs, the guard silently stopped ' +
          `enforcing that root. Task list was:\n${out}`,
      ).toBe(true);
    },
  );

  it('reaches the ratchet when the GENERATED SCHEMA changes, not just when source changes', () => {
    // The subtle case chunk-safe does not have: the schema is an INPUT to the lint, so a
    // new partial index can retroactively misalign an existing, untouched query.
    //
    // Asserted as COVERAGE, not as one mechanism — the same shape as the generated
    // per-root case above. This guard DECLARES `hostSuiteRatchet`
    // (partial-index-alignment-guard.test.ts, whose `the tree is currently aligned` case
    // execs the identical script over REPO_ROOT), so when the schema path also pulls
    // operator-core into the affected set the ratchet is reached through the host suite
    // and the narrow task is correctly skipped. Pinning `toContain(PI_TASK)` pinned the
    // MECHANISM while meaning the COVERAGE, and broke the moment an unrelated
    // dependency-graph change made operator-core affected for libs/papercusp/** paths
    // (EI-20026978310669562) — while the invariant itself never stopped being enforced.
    const out = dryTasks(PARTIAL_INDEX_SCHEMA_FILE);
    const reached = out.includes(PI_TASK) || out.includes(`${HOST_WORKSPACE} :: test`);
    expect(
      reached,
      `${PARTIAL_INDEX_SCHEMA_FILE} defines the partial indexes the lint aligns queries ` +
        'against; adding one can misalign a query nobody touched, so a schema-only change ' +
        `must still reach the ratchet — via "${PI_TASK}" or via "${HOST_WORKSPACE} :: test". ` +
        `Task list was:\n${out}`,
    ).toBe(true);
  });

  it('does NOT double-run it when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_TS_PATH);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      "operator-core's suite already contains partial-index-alignment-guard.test.ts, whose " +
        'ratchet execs the same lint — attaching the narrow task too would run it twice',
    ).not.toContain(PI_TASK);
  });

  it('does NOT attach for a TS file outside every scanned root', () => {
    const out = dryTasks(PI_UNSCANNED_PATH);
    expect(
      out,
      `${PI_UNSCANNED_PATH} is outside every SOURCE_ROOT, so the lint cannot read it and ` +
        'cannot produce a finding. Unlike chunk-safe (whose enumeration IS repo-wide), ' +
        "firing here would spend every agent's edit budget for nothing.",
    ).not.toContain(PI_TASK);
  });

  it('keeps the guard script defined, and pointed at the SCRIPT rather than the vitest file', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[PI_SCRIPT],
      `${HOST_WORKSPACE} must define "${PI_SCRIPT}" — the router only builds a task when the ` +
        'script exists, so removing it re-opens the gap silently (green, and simply no longer checking)',
    ).toBeTruthy();
    // MEASURED: the standalone script is 0.57-0.60s; running the 20-test vitest file instead
    // costs 7.66s because vitest startup dominates. Every agent pays this on every matching
    // edit, so the narrow form is load-bearing, not a style preference.
    expect(
      pkg.scripts?.[PI_SCRIPT],
      'must invoke the standalone lint script; switching it to `vitest run …` would make the ' +
        'narrow task ~12x more expensive for the same ratchet',
    ).toContain('check-partial-index-alignment.mjs');
    expect(pkg.scripts?.[PI_SCRIPT]).not.toContain('vitest');
  });
});

/**
 * WI-9573 — the THIRD instance of the class, and the most expensive so far.
 *
 * Unlike the two guards above, `lint:migration-forward-compat` had NO local
 * enforcement point at all. It was invoked only by green-checkpoint
 * (apps/operator/lib/release/green-checkpoint.ts), and a `.sql` migration maps to no
 * workspace test suite — so there was no partial coverage to widen, the signal was
 * entirely absent, and a violation first surfaced as a red FLEET gate hours later,
 * blocking every agent. MEASURED 2026-08-03: it red-pinned the gate for 4 consecutive
 * runs on migrations 750/751/752/754/755, and three other sessions independently hit
 * the same wall the same day (EI-19409083906144989, EI-19407054630567497).
 *
 * The fourth test below is not ceremony — it pins the exact trap the author of this
 * guard fell into. The router silently `continue`s when the host workspace does not
 * define the script, so registering the guard while operator-core lacked
 * `lint:migration-forward-compat` produced a registry entry that attached NOTHING and
 * looked, from every output, exactly like success.
 */
describe('affected-tests: migration forward-compat guard (WI-9573)', () => {
  const FC_SCRIPT = 'lint:migration-forward-compat';
  const FC_TASK = `${HOST_WORKSPACE} :: ${FC_SCRIPT}`;
  /** A real migration, under the directory the lint itself reports scanning. */
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/750-drop-dead-hfc-partial-indexes.sql`;
  const DRAFT_MIGRATION_PATH = `${MIGRATION_SQL_DIR}/800-adv-sessions-ended-by-signal.sql.DRAFT`;
  const SOURCE_CONSUMER_PATH = 'apps/operator/lib/release/deploy-cli.ts';

  it('attaches for a migration .sql change, which routes to no operator-core suite', () => {
    const out = dryTasks(MIGRATION_PATH);
    expect(
      out,
      `a migration at ${MIGRATION_PATH} must run the forward-compat guard. Before this ` +
        'wiring it ran ONLY inside green-checkpoint, so destructive DDL with no ' +
        'FORWARD-COMPAT acknowledgment got zero local signal and red-pinned the shared ' +
        'gate for every agent hours later.',
    ).toContain(FC_TASK);
  });

  it('attaches for a parked .DRAFT migration change, which the authoring guard must inspect', () => {
    const out = dryTasks(DRAFT_MIGRATION_PATH);
    expect(
      out,
      `a parked migration at ${DRAFT_MIGRATION_PATH} must run the forward-compat guard; ` +
        'the runner ignores it by design, but source consumers must be rejected before it is armed',
    ).toContain(FC_TASK);
  });

  it('attaches for a source consumer change in the detector source domain', () => {
    expect(MIGRATION_SOURCE_ROOTS).toContain('apps');
    const out = dryTasks(SOURCE_CONSUMER_PATH);
    expect(
      out,
      `${SOURCE_CONSUMER_PATH} is inside the detector's source domain; a source edit while a ` +
        'DRAFT migration exists must still reach the dependency guard',
    ).toContain(FC_TASK);
  });

  it('STILL attaches when the host workspace is affected, because nothing in that suite re-runs it', () => {
    // This case asserted the OPPOSITE until EI-20026978310669562, on the premise that
    // "operator-core's full suite already covers this ratchet". That premise was never
    // true for THIS guard: operator-core's suite contains
    // migration-forward-compat-authoring.test.ts, which exercises the DETECTOR against
    // synthetic `/repo/...` fixture strings and never scans the real SQL directory — so
    // deferring to the host suite ran nothing at all. The sibling guards that DO defer
    // each name a real in-suite ratchet via `hostSuiteRatchet`; this one names none, so
    // it must attach unconditionally.
    //
    // How it surfaced: declaring @papercusp/db-org et al. on operator-core made every
    // libs/papercusp/** path pull the host workspace in, which silently disabled the
    // guard for migration .sql changes — re-opening WI-9573's class from three files away.
    // The probe must satisfy BOTH halves at once, which is what makes this a real test of
    // the skip: a path that (a) MATCHES this guard's predicate — .sql under the scanned
    // migrations dir — and (b) pulls the host workspace into the affected set. A .ts path
    // (the old case's probe) satisfies only (b): the predicate cannot match it, so it
    // would pass for a reason having nothing to do with the skip branch. MIGRATION_PATH
    // satisfies both, because libs/papercusp/** now reaches operator-core through the
    // dependency graph — the very change that exposed this bug.
    const out = dryTasks(MIGRATION_PATH);
    expect(out, 'the host workspace should run its own suite here').toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'lint:migration-forward-compat declares no hostSuiteRatchet, so the host suite ' +
        'running is NOT a substitute for it — skipping here is silent coverage loss, not ' +
        `a saved duplicate scan. Task list was:\n${out}`,
    ).toContain(FC_TASK);
  });

  it('does NOT attach for a migration-looking .sql OUTSIDE the scanned migrations directory', () => {
    // The discriminating case: same extension, different directory. A prefix-free
    // `endsWith('.sql')` rule would attach here and spend every agent's edit budget
    // on a scan that cannot produce a finding.
    const out = dryTasks('apps/operator/docs/examples/999-not-a-migration.sql');
    expect(
      out,
      `only files under ${MIGRATION_SQL_DIR}/ are scanned by the lint, so a .sql ` +
        'elsewhere cannot violate the invariant',
    ).not.toContain(FC_TASK);
  });

  it('does NOT attach for a parked .DRAFT OUTSIDE the scanned migrations directory', () => {
    const out = dryTasks('apps/operator/docs/examples/999-not-a-migration.sql.DRAFT');
    expect(out).not.toContain(FC_TASK);
  });

  it('keeps the guard script defined, so the attachment cannot silently no-op', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[FC_SCRIPT],
      `${HOST_WORKSPACE} must define "${FC_SCRIPT}". The router only builds a task when ` +
        'the script exists on the HOST workspace — defining it only in the ROOT ' +
        'package.json is not enough, and that exact mistake made this guard attach ' +
        'nothing while every probe still looked healthy.',
    ).toBeTruthy();
    expect(pkg.scripts?.[FC_SCRIPT]).toContain('check-migration-forward-compat.mjs');
  });
});

/**
 * EI-20820551755839769 — migration edits must run the LIVE-SCHEMA half of the
 * prose-vector width contract. The detector already enumerates every vector column in
 * harness_shared and rejects an unaccounted surface; this block proves the affected-test
 * router actually places that detector where a new column enters the schema.
 */
describe('affected-tests: prose-vector live-schema guard (EI-20820551755839769)', () => {
  const SCRIPT = 'test:integration:prose-vector-dims';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/999-add-vector-surface.sql`;

  it('attaches the focused live-schema guard for a migration SQL change', () => {
    const out = dryTasks(MIGRATION_PATH);
    expect(
      out,
      'a migration can add an unenumerated or stale-width vector column while every unit ' +
        'test stays green; the focused integration contract must inspect the migrated catalog',
    ).toContain(TASK);
  });

  it('STILL attaches when operator-core unit tests are selected', () => {
    const out = dryTasks(MIGRATION_PATH);
    expect(out, 'the host workspace should be independently affected by this path').toContain(
      `${HOST_WORKSPACE} :: test`,
    );
    expect(
      out,
      'operator-core test excludes *.integration.test.ts, so its unit suite cannot replace ' +
        'the focused live-schema task',
    ).toContain(TASK);
  });

  it('does NOT attach for a migration-looking SQL file outside the migration directory', () => {
    expect(dryTasks('apps/operator/docs/examples/999-add-vector-surface.sql')).not.toContain(TASK);
  });

  it('keeps the focused script declared with the integration config and exact contract file', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/search/prose-vector-dims.integration.test.ts');
  });
});

/**
 * WI-10003236 — applyMigrationsForTest catches a stale fixture list only when the
 * real-Postgres fixture runs. The ordinary operator-core task excludes integration
 * tests, so route these fixtures from migration changes and the inputs that can detach
 * their guard.
 */
describe('affected-tests: work-item migration fixture guard (WI-10003236)', () => {
  const SCRIPT = 'test:integration:work-items-migration-fixtures';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/999-work-items-fixture-probe.sql`;
  const TRIGGER_PATHS = [
    MIGRATION_PATH,
    'libs/papercusp',
    'packages/operator-core/lib/work-items-closed-ts.integration.test.ts',
    'packages/operator-core/lib/work-items-terminal-attribution-preserve.integration.test.ts',
    'packages/operator-core/test/_pg-helpers.ts',
    'packages/operator-core/test/_work-items-schema.ts',
    'packages/operator-core/vitest.integration.config.ts',
    'packages/operator-core/package.json',
    'scripts/affected-tests.mjs',
  ];

  it.each(TRIGGER_PATHS)('attaches the fixture integration task for a contract input: %s', (changedPath) => {
    expect(
      dryTasks(changedPath),
      `${changedPath} can stale or detach the work-item migration fixtures; the focused real-Postgres task must run`,
    ).toContain(TASK);
  });

  it('does NOT attach for an unrelated operator-core source file', () => {
    expect(dryTasks('packages/operator-core/lib/rubrics.ts')).not.toContain(TASK);
  });

  it('keeps the focused script scoped to both fixture tests and the integration config', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('PAPERCUSP_TEST_RUN_HARNESS=papercusp');
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/work-items-closed-ts.integration.test.ts');
    expect(command).toContain('lib/work-items-terminal-attribution-preserve.integration.test.ts');
    expect(command).not.toContain('--passWithNoTests');
  });
});

/**
 * WI-10004160 — the federated-column drift guard went unrun for a month (2026-08-29 →
 * 2026-09-30) because it is an integration test and nothing in the local gate selected it;
 * 16 columns on 4 federated tables landed neither carried nor declared machine-local. Both
 * sides of its contract (a migration adds the column; the mapper/projections carry it) must
 * place the focused guard.
 */
describe('affected-tests: federated-column drift guard (WI-10004160)', () => {
  const SCRIPT = 'test:integration:federated-column-completeness';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;

  it('attaches for a migration SQL change (the side that adds a column)', () => {
    expect(dryTasks(`${MIGRATION_SQL_DIR}/999-add-federated-column.sql`)).toContain(TASK);
  });

  it('attaches for the federation value mapper and a projection (the side that carries it)', () => {
    expect(dryTasks('packages/operator-core/lib/sync/hyperbee/feature-issue-op-keys.ts')).toContain(TASK);
    expect(dryTasks('packages/operator-core/lib/sync/hyperbee/projections/harness-plans.ts')).toContain(TASK);
  });

  it('does NOT attach for an unrelated operator-core source file', () => {
    expect(dryTasks('packages/operator-core/lib/rubrics.ts')).not.toContain(TASK);
  });

  it('keeps the focused script declared with the integration config and exact contract file', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/sync/hyperbee/__tests__/federated-column-completeness.integration.test.ts');
  });
});

/**
 * WI-2141163 — the real-Postgres resource-governor queue recurrence suite must be
 * selected by the local affected-tests path. The ordinary operator-core task is
 * unit-layer and excludes `*.integration.test.ts`; the broad integration flag is
 * opt-in and has no local green-checkpoint caller. This focused route is the
 * recurrence guard, and its config assertions keep the later agent-mcp cleanup
 * from moving the only recurring integration file back to zero coverage.
 */
describe('affected-tests: resource-governor queue integration guard (WI-2141163)', () => {
  const SCRIPT = 'test:integration:resource-governor-queue';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const QUEUE_TEST_PATH = 'packages/operator-core/lib/resource-governor/queue.integration.test.ts';
  const QUEUE_SOURCE_PATH = 'packages/operator-core/lib/resource-governor/queue.ts';
  const ADMISSION_SOURCE_PATH = 'packages/operator-core/lib/resource-governor/admission.ts';
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/986-resource-governor-work-item-queue-identity.sql`;
  const UNRELATED_RESOURCE_PATH = 'packages/operator-core/lib/resource-governor/controller.ts';

  it.each([QUEUE_TEST_PATH, QUEUE_SOURCE_PATH, ADMISSION_SOURCE_PATH, MIGRATION_PATH, 'libs/papercusp'])(
    'attaches the focused queue integration task for a contract input: %s',
    (changedPath) => {
      const out = dryTasks(changedPath);
      expect(out, 'the operator-core unit task should still be selected for the changed contract input').toContain(
        `${HOST_WORKSPACE} :: test`,
      );
      expect(
        out,
        `${changedPath} can change durable queue behavior or its schema; the focused real-Postgres ` +
          'recurrence suite must run without requiring the broad --integration sweep',
      ).toContain(TASK);
    },
  );

  it('does NOT attach for an unrelated resource-governor source file', () => {
    expect(
      dryTasks(UNRELATED_RESOURCE_PATH),
      'the focused queue venue must not become an all-resource-governor integration tax',
    ).not.toContain(TASK);
  });

  it('keeps the focused script declared with the integration config and exact queue test', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/resource-governor/queue.integration.test.ts');
    expect(command).not.toContain('--passWithNoTests');
  });

  it('keeps agent-mcp unit and integration configs disjoint after the caller is wired', () => {
    const unitConfig = readFileSync(resolve(REPO_ROOT, 'packages/agent-mcp/vitest.config.ts'), 'utf8');
    const integrationConfig = readFileSync(resolve(REPO_ROOT, 'packages/agent-mcp/vitest.integration.config.ts'), 'utf8');
    expect(unitConfig).toContain("include: ['src/**/*.test.ts']");
    expect(unitConfig).toContain("exclude: ['src/**/*.integration.test.ts']");
    expect(integrationConfig).toContain("layer: 'integration'");
    expect(integrationConfig).toContain("include: ['src/**/*.integration.test.ts']");
  });
});

/**
 * EI-23210600888560844 — the private-Postgres sessions:read regression suite must
 * be selected by the ordinary affected-tests path. The operator-core unit task
 * excludes `*.integration.test.ts`, and the broad integration task is opt-in, so
 * this focused route is the only local promotion signal for the real SQL contract.
 */
describe('affected-tests: sessions/read private-PG integration guard (EI-23210600888560844)', () => {
  const SCRIPT = 'test:integration:sessions-read';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const TRIGGER_PATHS = [
    'package.json',
    'packages/operator-core/package.json',
    'packages/operator-core/vitest.integration.config.ts',
    'scripts/affected-tests.mjs',
    'packages/operator-core/lib/agent-tools/sessions/read.ts',
    'packages/operator-core/lib/agent-tools/sessions/read.integration.test.ts',
    'packages/operator-core/lib/agent-tools/sessions/_shared.ts',
    'packages/operator-core/lib/agent-tools/sessions/search.ts',
    'packages/operator-core/lib/agent-tools/search/filters.ts',
    'packages/operator-core/test/_pg-helpers.ts',
  ];
  const UNRELATED_SESSION_TOOL_PATH = 'packages/operator-core/lib/agent-tools/sessions/list.ts';

  it.each(TRIGGER_PATHS)('attaches the focused sessions/read task for a contract input: %s', (changedPath) => {
    const out = dryTasks(changedPath);
    expect(out, 'the operator-core unit task should still be selected for the changed contract input').toContain(
      `${HOST_WORKSPACE} :: test`,
    );
    expect(
      out,
      `${changedPath} can change the sessions:read SQL contract or its private-PG test venue; ` +
        'the focused integration task must run without requiring the broad --integration sweep',
    ).toContain(TASK);
  });

  it('does NOT attach for an unrelated sessions tool', () => {
    expect(
      dryTasks(UNRELATED_SESSION_TOOL_PATH),
      'the focused sessions/read venue must not become an all-sessions private-Postgres tax',
    ).not.toContain(TASK);
  });

  it('keeps the focused script declared with the integration config and exact reader test', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/agent-tools/sessions/read.integration.test.ts');
    expect(command).not.toContain('--passWithNoTests');
  });
});

/**
 * WI-38351 — the SAME class as the forward-compat guard above, on the SAME corpus, found
 * the same way: `lint:migrations` was a gate-only lint, so the author of a bad migration
 * saw a green `npm run test:affected` and the fleet learned about it hours later as a red
 * green-checkpoint that blocked every agent's deploy.
 *
 * It had already happened three times when this was wired (WI-38348 / migration 815,
 * EI-20224121418388370, EI-10999 — each an NNN-*.sql committed with no reservation row),
 * and the last occurrence was expensive out of proportion to the defect: the 1.1s detector
 * existed the whole time, four different agents raced to write the same one-line backfill,
 * and three of those raced files landed. Nothing about that cost was caused by the missing
 * row; all of it was caused by finding out late.
 *
 * The two directions are tested because a registration that attaches to EVERYTHING is as
 * wrong as one that attaches to nothing — it just fails by spending every agent's edit
 * budget instead of by staying silent.
 */
describe('affected-tests: migration lint guard (WI-38351)', () => {
  const LM_SCRIPT = 'lint:migrations';
  const LM_TASK = `${HOST_WORKSPACE} :: ${LM_SCRIPT}`;
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/750-drop-dead-hfc-partial-indexes.sql`;

  it('attaches for a migration .sql change — the moment the number is still cheap to fix', () => {
    const out = dryTasks(MIGRATION_PATH);
    expect(
      out,
      `a migration at ${MIGRATION_PATH} must run lint:migrations locally. Before this ` +
        'wiring it ran ONLY inside green-checkpoint, so an unreserved NNN (or a raw ' +
        'BEGIN/COMMIT, or a duplicate number) got zero local signal and red-pinned the ' +
        'shared gate for the whole fleet hours later.',
    ).toContain(LM_TASK);
  });

  it('attaches for the bare libs/papercusp gitlink path used for nested edits', () => {
    const submodule = someSubmodulePath();
    expect(submodule).toBe('libs/papercusp');
    expect(
      dryTasks(submodule),
      'a nested migration edit is reported as the bare submodule gitlink; omitting this ' +
        'root trigger lets the migration lint skip the exact change that introduced it',
    ).toContain(LM_TASK);
  });

  it('attaches when the LINTER itself changes, which can invalidate the whole corpus at once', () => {
    expect(dryTasks('scripts/lint-migrations.mjs')).toContain(LM_TASK);
  });

  it('attaches when the ALLOCATOR changes, since it hands out the numbers this lint checks', () => {
    expect(dryTasks('scripts/next-migration.mjs')).toContain(LM_TASK);
  });

  it('STILL attaches when the host workspace is affected, because nothing in that suite re-runs it', () => {
    // The same skip-branch trap the forward-compat sibling documents above, and the reason
    // this guard deliberately declares NO hostSuiteRatchet: libs/papercusp/** reaches
    // operator-core through the dependency graph, so a migration .sql pulls the host
    // workspace into the affected set. Declaring a ratchet would therefore disable the
    // guard on exactly the changesets it exists for. operator-core's suite does contain
    // lint-migrations.test.ts, but that exercises the helpers against fixtures and never
    // scans the real SQL directory or reads the reservations table — so deferring to it
    // would run nothing at all while looking, from every output, like success.
    const out = dryTasks(MIGRATION_PATH);
    expect(out, 'the host workspace should run its own suite here').toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'lint:migrations declares no hostSuiteRatchet, so the host suite running is NOT a ' +
        `substitute for it. Task list was:\n${out}`,
    ).toContain(LM_TASK);
  });

  it('does NOT attach for a migration-looking .sql OUTSIDE the scanned migrations directory', () => {
    expect(
      dryTasks('apps/operator/docs/examples/999-not-a-migration.sql'),
      'only files under the scanned migrations dir can violate the invariant',
    ).not.toContain(LM_TASK);
  });

  it('does NOT attach for an unrelated source change', () => {
    expect(
      dryTasks('packages/operator-core/lib/agent-tools/index.ts'),
      'a TS edit cannot change a migration number, so paying the scan here is pure waste',
    ).not.toContain(LM_TASK);
  });

  it('keeps the guard script defined ON THE HOST WORKSPACE, so the attachment cannot silently no-op', () => {
    // Step two of the two-step registration. The router `continue`s when the host
    // workspace does not define the script, and `lint:migrations` lived ONLY in the root
    // package.json — so the registry entry alone would have attached nothing and looked
    // exactly like success from every probe.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[LM_SCRIPT],
      `${HOST_WORKSPACE} must define "${LM_SCRIPT}" — defining it only in the ROOT ` + 'package.json is not enough.',
    ).toBeTruthy();
    expect(pkg.scripts?.[LM_SCRIPT]).toContain('lint-migrations.mjs');
  });
});

/**
 * WI-35930 (okf-frontmatter-adoption-2026-08-08 P-006) — the FOURTH instance, and the
 * first whose corpus is written by CODE as well as by hand.
 *
 * `lint:okf-conformance` judges two corpora — the agent-insights docs and the
 * knowledge-packs (docs + `manifest.yaml`). Neither routes to a suite that covers it:
 * an insight doc selects `@papercupai/operator-docs`, which runs nothing over the
 * corpus, and a pack doc selects the pack workspace, likewise. So a doc that drops
 * `type:`, or writes a `stale_after:` no date parser accepts, produced ZERO local
 * signal before this wiring.
 *
 * Why the in-suite ratchet (`lib/okf-conformance-guard.test.ts`) is NOT sufficient on
 * its own, and why this narrow task exists: a standalone SCRIPT registered in
 * REPO_WIDE_INVARIANT_GUARDS is deliberately skipped when its host workspace is
 * independently affected, on the assumption the workspace suite already contains the
 * check. That assumption holds for `lint:chunk-safe` (a vitest file) and is FALSE for a
 * script — hence the ratchet. The two cover different halves and both are load-bearing.
 *
 * The pack half is the one that can regress with no author involved at all (plan D-003:
 * three code write paths mint that frontmatter), so the first notice of a regression
 * would otherwise be a red on files nobody edited.
 */
const OKF_SCRIPT = 'lint:okf-conformance';
const OKF_TASK = `${HOST_WORKSPACE} :: ${OKF_SCRIPT}`;

/**
 * A REAL tracked file under `root` that the lint would actually OPEN.
 *
 * Filtered through the lint's own `isOkfScannedFile`, not a hand-written extension
 * test, so the probe cannot select a file the lint declines to judge (which would
 * assert the guard fires for something it should not).
 *
 * `--recurse-submodules` because the packs root lives in `libs/papercusp`. Gate-shaped
 * checkouts carry 0/39 submodules (WI-6776), so this returns null there and the case
 * SKIPS — a guard test must not red the fleet gate over a checkout shape.
 */
function realOkfFileUnder(root: string): string | null {
  const res = spawnSync('git', ['ls-files', '--recurse-submodules', root], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
  return (res.stdout ?? '').split('\n').filter((f) => existsSync(resolve(REPO_ROOT, f))).find((f) => f && isOkfScannedFile(f)) ?? null;
}

describe('affected-tests: OKF frontmatter conformance guard (WI-35930)', () => {
  it.each((OKF_SCAN_ROOTS as string[]).map((root) => [root]))(
    'enforces the lint for a change under scanned root %s',
    (root: string) => {
      const probe = realOkfFileUnder(root);
      if (!probe) {
        // Nothing tracked under this root in THIS checkout (submodule-less gate tree).
        expect(true).toBe(true);
        return;
      }
      const out = dryTasks(probe);
      const reached = out.includes(OKF_TASK) || out.includes(`${HOST_WORKSPACE} :: test`);
      expect(
        reached,
        `the lint SCANS ${root} (probe: ${probe}), so a change there must reach it — via ` +
          `"${OKF_TASK}" or via "${HOST_WORKSPACE} :: test". This case is GENERATED from the ` +
          "lint's own exported OKF_SCAN_ROOTS: if you widened the scan there and did not " +
          'mirror it into OKF_SCAN_ROOTS in scripts/affected-tests.mjs, the guard silently ' +
          `stopped enforcing that root. Task list was:\n${out}`,
      ).toBe(true);
    },
  );

  it('does NOT attach for a DOT-PATH inside a scanned root', () => {
    // The discrimination that shaped the whole lint (plan D-001): this file IS
    // git-tracked and `isInsightDoc()` accepts it, but Astro's content loader never
    // sees it, so the lint deliberately excludes it. Routing on it would spend every
    // agent's edit budget on a file the lint refuses to judge.
    const dotPath = `${OKF_SCAN_ROOTS[0]}.papercusp/memory/raw.md`;
    expect(
      isOkfScannedFile(dotPath),
      'precondition: the lint itself must decline this path, or this case is testing ' + 'the wrong thing',
    ).toBe(false);
    expect(
      dryTasks(dotPath),
      `${dotPath} is excluded from the SCAN, so attaching the guard for it could never ` + 'produce a finding',
    ).not.toContain(OKF_TASK);
  });

  it('does NOT attach for a file outside every scanned root', () => {
    // Same extension family, different tree — a prefix-free `endsWith('.mjs'/'.md')`
    // rule would over-fire here.
    const out = dryTasks('astro.config.mjs');
    expect(
      out,
      'only the two corpus roots are scanned, so a file elsewhere cannot violate the ' + 'invariant',
    ).not.toContain(OKF_TASK);
  });

  it('keeps the guard script defined on the HOST workspace, so it cannot silently no-op', () => {
    // The exact trap WI-9573 fell into: the router `continue`s when the host workspace
    // does not define the script, producing a registry entry that attaches NOTHING and
    // looks, from every output, like success. Defining it only in the ROOT
    // package.json is not enough.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[OKF_SCRIPT],
      `${HOST_WORKSPACE} must define "${OKF_SCRIPT}" — the router only builds a task ` +
        'when the script exists on the HOST workspace.',
    ).toBeTruthy();
    expect(pkg.scripts?.[OKF_SCRIPT]).toContain('check-okf-conformance.mjs');
  });

  it('keeps the in-suite ratchet, which covers the half this attachment deliberately skips', () => {
    // When operator-core is itself affected the router skips the narrow task, on the
    // assumption the workspace suite contains the check. For a standalone SCRIPT that
    // assumption is false, so the coverage of an operator-core-affecting change rests
    // entirely on this file. Deleting it would remove that half silently — nothing
    // would fail, the guard would just stop covering the code-written pack corpus.
    expect(
      readFileSync(resolve(REPO_ROOT, 'packages/operator-core/lib/okf-conformance-guard.test.ts'), 'utf8'),
      'the in-suite OKF ratchet must exist; the narrow task above does not run when ' +
        'operator-core is independently affected',
    ).toContain('check-okf-conformance.mjs');
  });
});

/**
 * WI-37605 — the D-034 shape straddling the boundary in BOTH directions.
 *
 * The invariant is "no executable line hardcodes the green-checkpoint production tag", and it was
 * violated in operator-core (release-actions.ts, 24 sites) AND in apps/operator
 * (green-checkpoint.ts, 13 sites). Its host workspace can only be one of the two, so whichever it
 * is, the other side's offender escapes selection — and apps/operator is the side that produced
 * the original report.
 *
 * Why it is worth every agent's edit budget: the violation changes no behaviour and breaks no
 * test, so it is invisible locally. It surfaces as a TRIAGER misreading a verdict log mid-incident,
 * because a captured suite line is byte-identical to a real gate decision.
 */
const GC_TAG_SCRIPT = 'lint:green-checkpoint-tag';
const GC_TAG_TASK = `${HOST_WORKSPACE} :: ${GC_TAG_SCRIPT}`;

/** Under a scanned root, routes to @papercusp/web — the measured escape case. */
const GC_TAG_OUTSIDE_PATH = 'apps/operator/lib/release/green-checkpoint.ts';
/** Under NO scanned root: the guard could never read it, so attaching would be pure cost. */
const GC_TAG_UNSCANNED_PATH = 'libs/flags/src/types.ts';

describe('affected-tests: green-checkpoint tag guard (WI-37605)', () => {
  /** A REAL tracked TS file under `root`, or null. See the MIRROR test for why it must be real. */
  function realTsFileUnder(root: string): string | null {
    const res = spawnSync('git', ['ls-files', '--recurse-submodules', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) return null;
    // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
    return (res.stdout ?? '').split('\n').filter((f) => existsSync(resolve(REPO_ROOT, f))).find((f) => /\.[cm]?tsx?$/.test(f)) ?? null;
  }

  it('attaches for a TS change outside the host workspace but inside a scanned root', () => {
    expect(
      dryTasks(GC_TAG_OUTSIDE_PATH),
      `${GC_TAG_OUTSIDE_PATH} is inside the guard's scanned roots but routes to @papercusp/web, ` +
        'so without this attachment a hardcoded production tag there gets ZERO local signal and ' +
        'first appears as an impostor line in a verdict log someone is triaging under pressure',
    ).toContain(GC_TAG_TASK);
  });

  it('does NOT double-run it when the host workspace is already affected', () => {
    expect(dryTasks('packages/operator-core/lib/harness/routines/release-actions.ts')).not.toContain(GC_TAG_TASK);
  });

  it('does NOT attach for a TS file outside every scanned root', () => {
    expect(
      dryTasks(GC_TAG_UNSCANNED_PATH),
      'precision is part of the contract — over-firing spends every agent edit for a finding ' +
        'that is impossible by construction',
    ).not.toContain(GC_TAG_TASK);
  });

  it('MIRROR: every scanned root the real guard declares is actually COVERED', () => {
    // The router hardcodes its own copy of GC_TAG_SOURCE_ROOTS. Asserting BEHAVIOUR per root
    // (rather than list equality) also catches a root that is mirrored correctly but whose files
    // route somewhere the attachment never fires from.
    //
    // ⚠ TWO TRAPS, both of which the first version of this test fell into:
    //  1. The probe must be a REAL TRACKED FILE. The router maps a path to a workspace by PACKAGE
    //     DIRECTORY, so a synthesized `<root>/__probe__.ts` matches no package, selects nothing,
    //     and exits BEFORE the guard loop (WI-7013) — reading as "not wired" when the wiring is
    //     fine. The partial-index block above documents this exact false negative; this test
    //     reproduced it anyway, which is the argument for keeping the warning where it is.
    //  2. "Covered" is a DISJUNCTION, not "attaches". For the root that IS inside the host
    //     workspace, the attachment is deliberately SKIPPED to avoid double-running — that root
    //     is covered by operator-core's own suite instead. Asserting `toContain` for every root
    //     would therefore contradict the no-double-run rule the sibling tests pin.
    for (const root of GC_TAG_SOURCE_ROOTS) {
      const probe = realTsFileUnder(root);
      if (!probe) continue; // gate-shaped checkouts carry 0/39 submodules (WI-6776) — skip, never red
      const out = dryTasks(probe);
      expect(
        out.includes(GC_TAG_TASK) || out.includes(HOST_WORKSPACE),
        `root "${root}" is declared by the guard but a real file there (${probe}) neither ` +
          'attaches the guard task nor selects the host workspace whose suite runs it — so edits ' +
          'under that root get no enforcement at all',
      ).toBe(true);
    }
  });

  it('keeps the guard script DEFINED, so the registration cannot be silently inert', () => {
    // The specific false green this catches (WI-37454/WI-37445): affected-tests.mjs skips a
    // registered-but-undeclared guard with a bare `continue`, so the guard runs NOWHERE while
    // lint:guard-reachability still credits it as fully enforced.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[GC_TAG_SCRIPT],
      `${HOST_WORKSPACE} must define "${GC_TAG_SCRIPT}" or the attachment is inert`,
    ).toBeTruthy();
    // Pointed at the SCRIPT, not the vitest file: the narrow task only needs the ratchet.
    expect(pkg.scripts?.[GC_TAG_SCRIPT]).toContain('check-green-checkpoint-tag.mjs');
  });
});

/**
 * EI-20032324229208320 — the mug/kettle retirement's recurrence guard
 * (retire-mug-kettle-su-only-2026-08-09 P-016).
 *
 * WHY THIS BLOCK EXISTS, and it is NOT the usual "route it to the offending workspace" reason.
 * The guard was registered in REPO_WIDE_INVARIANT_GUARDS *and* declared in the host workspace —
 * both steps done correctly — and it STILL held `main` red, because those two steps buy
 * COVERAGE, never ENFORCEMENT. `check-lint-guard-reachability.mjs`'s `buildCorpora()` reads
 * exactly four enforcement corpora: green-checkpoint.ts, .github/workflows/*, ENFORCING
 * *.test.ts, and hooks. `scripts/affected-tests.mjs` is not among them, so a repo-wide
 * registration can never make a guard "reachable" by itself — the guard landed in the
 * UNREACHABLE tier, past the shrink-only acknowledged set, and red-pinned the fleet's gate on
 * three cases at once (the unenforced-guard assertion plus both fail-open/PASS-output cases,
 * which only fail because the census exits nonzero).
 *
 * So the durable lesson this block pins is: EVERY repo-wide invariant guard needs a SECOND
 * wiring into an enforcement corpus. Measured at the time of writing — lint:no-retired -> 2
 * test files; lint:green-checkpoint-tag -> this file; lint:workspace-deps-complete -> CI
 * test.yml. This block is that second wiring for the mug/kettle guard, and it earns its place
 * by asserting the routing behaviour rather than merely naming the script.
 *
 * `npm run lint:no-ungated-mug-kettle` was verified exit 0 on the tree before wiring, so this
 * cannot red anyone's loop on pre-existing debt (same precaution the GC_TAG entry records).
 */
const MUG_KETTLE_SCRIPT = 'lint:no-ungated-mug-kettle';
const MUG_KETTLE_TASK = `${HOST_WORKSPACE} :: ${MUG_KETTLE_SCRIPT}`;

/** A TS path that routes to @papercusp/web, never pulling in the host workspace. */
const MK_OUTSIDE_TS_PATH = 'apps/operator/lib/release/green-checkpoint.ts';
/** Markdown inside a package dir — blueprint PROMPTS are a census category, so `.md` counts. */
const MK_MARKDOWN_PATH = 'apps/operator/docs/nuqs-audit-2026-05-11.md';
/** Active agentic template manifest — P-005's current-guidance family scans YAML too. */
const MK_TEMPLATE_YAML_PATH = 'templates/papercusp-ops-pots/blueprints/app-agent/blueprint.yaml';
/** Matches the predicate NOWHERE: not TS/JS-family, not `.md`. */
const MK_UNMATCHED_PATH = 'apps/operator/app/_brand-primitives.css';

describe('affected-tests: ungated mug/kettle guard (EI-20032324229208320)', () => {
  it('attaches for a TS change outside the host workspace', () => {
    expect(
      dryTasks(MK_OUTSIDE_TS_PATH),
      `${MK_OUTSIDE_TS_PATH} routes to @papercusp/web, so without this attachment a NEW ` +
        'mug/kettle entry point added there gets ZERO local signal — which is the whole ' +
        'point of a repo-wide guard: nobody knows in advance which file grows the next door',
    ).toContain(MUG_KETTLE_TASK);
  });

  // NOTE — deliberately NO "does not double-run when the host workspace is affected" case here,
  // unlike the sibling blocks above. That behaviour is MID-CHANGE in the working tree
  // (EI-20026978310669562): the host-suite skip is moving from assumed to DECLARED via
  // `hostSuiteRatchet`, so a guard that names no in-suite ratchet will attach
  // unconditionally — the fail-safe direction. This guard names none (operator-core's suite
  // contains nothing that re-runs the mug/kettle census), so under the new rule it SHOULD
  // attach even inside the host workspace, which is the opposite of what the siblings assert.
  // Pinning either polarity here would encode a semantic that is actively being inverted, so
  // this block asserts only what is TRUE UNDER BOTH: the predicate and the wiring.

  it('attaches for a MARKDOWN change — a new mug role prompt is a real re-introduction path', () => {
    // The `.md` half of the predicate is the easiest to drop in a refactor and the hardest to
    // miss the consequences of: blueprint prompts are a census category, so a quiet new mug
    // role prompt is exactly the shape this guard exists to catch.
    expect(dryTasks(MK_MARKDOWN_PATH)).toContain(MUG_KETTLE_TASK);
  });

  it('attaches for YAML agentic-template guidance, not only code and Markdown', () => {
    expect(dryTasks(MK_TEMPLATE_YAML_PATH)).toContain(MUG_KETTLE_TASK);
  });

  it('does NOT attach for a change the predicate cannot match', () => {
    const out = dryTasks(MK_UNMATCHED_PATH);
    // ⚠ This assertion is only about the PREDICATE if the double-run branch cannot have fired
    // first. The guard loop tests, in order: inert -> excludes -> already-queued -> appliesTo.
    // Pinning that the host workspace is absent is what makes this a predicate test rather
    // than a test that passes for an unrelated reason. A `.ts` under libs/flags looks like a
    // negative case but is NOT one — it pulls operator-core in through the dep graph and is
    // skipped as a double-run, with the predicate never consulted.
    expect(
      out,
      'must not be excluded via the already-queued branch, or this proves nothing about appliesTo',
    ).not.toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'every agent pays for this guard on every edit; attaching it to a stylesheet spends ' +
        'that budget for a finding that is impossible by construction',
    ).not.toContain(MUG_KETTLE_TASK);
  });

  it('keeps the guard script DEFINED, so the registration cannot be silently inert', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[MUG_KETTLE_SCRIPT],
      `${HOST_WORKSPACE} must define "${MUG_KETTLE_SCRIPT}" or the attachment is inert — ` +
        'affected-tests.mjs skips a registered-but-undeclared guard with a bare `continue`',
    ).toBeTruthy();
    expect(pkg.scripts?.[MUG_KETTLE_SCRIPT]).toContain('check-ungated-mug-kettle.mjs');
  });
});

/*
 * ── required-field-strands guard (WI-38401 / EI-20020054576584970) ────────────────────
 *
 * The guard existed, was tested, was documented in CLAUDE.md — and ran on NO automated
 * path, so the class it was built for froze `main` ~14h on 2026-08-12 with
 * `npm run test:affected` green throughout. Its only automated reach was a PostToolUse
 * nudge that fires solely inside Claude Code Edit|Write|MultiEdit sessions that have it
 * registered.
 *
 * Two halves of the registration can silently reopen that hole, and each fails GREEN:
 *
 *   1. the SUBMODULE half of `appliesTo`. A change inside a submodule reaches
 *      affected-tests.mjs ONLY as the submodule ROOT path (`libs/papercusp`) — the diffs
 *      run `--ignore-submodules=dirty` and `submoduleDirtyPaths()` reports the root — so a
 *      TS-family-only predicate cannot attach for 39 submodules' worth of source. The
 *      measured incident lives inside one, which is what makes this a correctness case and
 *      not a completeness nicety;
 *   2. the ENFORCED form. The registered `:typecheck` alias first performs the cheap AST
 *      trigger scan and only invokes `lint:tsc --files=...` when a changed exported shape
 *      actually adds a required field. That keeps ordinary edits at the ~1.7s parser cost
 *      while making the existing attributed typecheck fail on a real stranded site.
 */
const RFS_SCRIPT = 'lint:required-field-strands:typecheck';
const RFS_TASK = `${HOST_WORKSPACE} :: ${RFS_SCRIPT}`;
/** A TS path outside the host workspace (routes to @papercusp/web, never operator-core). */
const RFS_OUTSIDE_TS_PATH = 'apps/operator/lib/release/deploy-cli.ts';
/** A non-source, non-submodule path: the negative half of the submodule differential. */
const RFS_UNMATCHED_PATH = 'apps/operator/docs/nuqs-audit-2026-05-11.md';

/**
 * A REAL submodule root, read from `.gitmodules` rather than hardcoded, so retiring one
 * cannot leave this test asserting against a path that is no longer a submodule (which
 * would fail as a predicate regression while the predicate was fine).
 */
function someSubmodulePath(): string {
  const res = spawnSync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  expect(res.status, `could not read .gitmodules: ${res.stderr ?? ''}`).toBe(0);
  const paths = (res.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(l.indexOf(' ') + 1).trim())
    .filter(Boolean);
  expect(paths.length, 'no submodules declared — the differential below proves nothing').toBeGreaterThan(0);
  // Prefer the submodule the measured incident came from; any real one exercises the clause.
  return paths.find((p) => p === 'libs/papercusp') ?? paths[0];
}

describe('affected-tests: required-field-strands guard (WI-38401)', () => {
  it('attaches for a TS change outside the host workspace', () => {
    expect(
      dryTasks(RFS_OUTSIDE_TS_PATH),
      `${RFS_OUTSIDE_TS_PATH} routes to @papercusp/web. A required field added to an ` +
        'exported interface strands its DEPENDENTS, which no workspace selection and no ' +
        'scoped typecheck can reach — so the guard must attach on the changed path itself',
    ).toContain(RFS_TASK);
  });

  it('forwards the authoritative base and exact triggering paths so git-sync cannot make it vacuous', () => {
    const { base, probeRef: baseRef } = pinnedBase('HEAD^');
    const out = dryTasks(RFS_OUTSIDE_TS_PATH, baseRef);
    expect(
      out,
      'a post-git-sync run needs the before-image and exact scope; --files alone still ' +
        'compares byte-identical HEAD content and exits NOT_CHECKED',
    ).toContain(`${RFS_TASK} (guard base: ${base}) ` + `(guard args: --files=${RFS_OUTSIDE_TS_PATH})`);
  });

  it('moves an E2BIG-class triggering set into a cleaned JSON response file', () => {
    // Large enough to cross affected-tests' conservative 32 KiB inline ceiling while
    // remaining below Linux's own single-argument ceiling for THIS probe's
    // --changed-paths input. The 2026-08-25 gate incident carried 5,976 distinct paths
    // and exceeded the kernel ceiling before the guard process could start.
    // Explicit changed paths are normalized and de-duplicated before forwarding. Use
    // distinct TS-shaped paths here so the fixture still models a genuinely large
    // triggering population instead of collapsing to one inline argument.
    const changedPaths = Array.from(
      { length: 1_000 },
      (_, index) => `${RFS_OUTSIDE_TS_PATH.replace(/\.ts$/, '')}-${index}.ts`,
    ).join(',');
    expect(Buffer.byteLength(changedPaths, 'utf8')).toBeGreaterThan(32 * 1024);

    const out = dryTasks(changedPaths, 'HEAD^');
    const line = dryTaskLine(out, RFS_TASK);
    const responseMatch = line.match(/\(guard args: --files-from=([^\s)]+)\)/);
    expect(
      responseMatch,
      'large scopes must keep the file population out of argv; one --files=<thousands> ' +
        'entry reproduces spawn E2BIG and aborts the whole checkpoint without a verdict',
    ).not.toBeNull();
    expect(line).not.toContain('(guard args: --files=');
    expect(existsSync(responseMatch?.[1] ?? '')).toBe(false);

    // The sibling vimock guard consumes the same exact path population. It must use the
    // same response-file transport and parser; otherwise enabling its forwarded scope
    // merely moves the historical E2BIG gate abort from one guard to the other.
    const vimockLine = dryTaskLine(out, VIMOCK_GUARD_TASK);
    const vimockResponse = vimockLine.match(/\(guard args: --files-from=([^\s)]+)\)/);
    expect(vimockResponse).not.toBeNull();
    expect(vimockLine).not.toContain('(guard args: --files=');
    expect(existsSync(vimockResponse?.[1] ?? '')).toBe(false);
  }, 120_000);

  it('attaches for a SUBMODULE ROOT path — the shape the 2026-08-12 main freeze arrived as', () => {
    const submodule = someSubmodulePath();
    expect(
      dryTasks(submodule),
      `a change inside ${submodule} reaches affected-tests.mjs only as the bare submodule ` +
        'root, so a TS-family-only appliesTo leaves every submodule-internal required-field ' +
        'addition unattached while the registration LOOKS complete',
    ).toContain(RFS_TASK);
  });

  it('does NOT attach for a non-source path outside every submodule', () => {
    // The DIFFERENTIAL that makes the case above a real test of the submodule clause: both
    // paths are non-TS, and only the submodule root attaches. Nothing but
    // `gitmodulePaths().has(f)` can tell them apart.
    const out = dryTasks(RFS_UNMATCHED_PATH);
    expect(
      out,
      'must not be skipped via the already-queued branch, or this proves nothing about appliesTo',
    ).not.toContain(`${HOST_WORKSPACE} :: ${RFS_SCRIPT}`);
    expect(out).not.toContain(RFS_TASK);
  });

  it('registers the ATTRIBUTED typecheck form for the affected-path enforcement rung', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const cmd = pkg.scripts?.[RFS_SCRIPT];
    expect(
      cmd,
      `${HOST_WORKSPACE} must define "${RFS_SCRIPT}" or the attachment is inert — ` +
        'affected-tests.mjs skips a registered-but-undeclared guard with a bare `continue`',
    ).toBeTruthy();
    expect(cmd).toContain('check-required-field-strands.mjs');
    expect(cmd).toContain('check-required-field-strands.mjs --typecheck');
  });
});

/*
 * EI-20026978310669562 — the RECURRENCE GUARD for the class the whole registry above exists
 * to prevent, one level up.
 *
 * The router may skip a guard in favour of its host workspace's full suite ONLY when that
 * suite genuinely re-runs the invariant. That used to be an ASSUMPTION baked into a single
 * `t.script === 'test'` comparison, held for every guard uniformly, and true for only 5 of
 * 12 — so a guard could stop firing with no failing test anywhere, triggered by something as
 * unrelated as a dependency-graph edit three files away (declaring @papercusp/db-org on
 * operator-core made libs/papercusp/** reach the host workspace, silently disabling
 * lint:migration-forward-compat for migration .sql changes).
 *
 * The premise is now DECLARED per guard via `hostSuiteRatchet`. That fixes the mechanism but
 * moves the risk rather than removing it: a DECLARATION is just a new place to write an
 * unverified claim, and a phantom ratchet — a path that does not exist, or a file that never
 * runs the invariant — buys back the identical silent hole while LOOKING rigorous. So the
 * declaration is checked here, not trusted.
 *
 * Deliberately NOT asserted: that guards without a ratchet attach unconditionally. That is a
 * BEHAVIOURAL claim and is pinned behaviourally by the forward-compat block above, which
 * probes a path satisfying both halves at once (matches the predicate AND pulls the host
 * workspace in). A source-shape assertion here would duplicate it in a weaker form.
 */
describe('affected-tests: the host-suite skip is DECLARED and verified, never assumed', () => {
  type Guard = { script: string; hostSuiteRatchet: string | null; notCheckedIsNonGating: boolean };

  // The registry SOURCE is overridable so this block's falsifiability can be proven against a
  // mutated COPY outside the tree (scripts/mutation-probe.sh tier 2). The shared checkout is
  // edited by the whole fleet and swept into commits every few minutes, so mutating
  // affected-tests.mjs in place to test these assertions would risk committing the mutant —
  // this one line is what makes the safe probe available. Defaults to the real file.
  const REGISTRY_FILE = process.env.PROBE_AFFECTED_TESTS ?? AFFECTED_TESTS;

  const registrySource = (() => {
    const src = readFileSync(REGISTRY_FILE, 'utf8').replaceAll('"', "'");
    const start = src.indexOf('const REPO_WIDE_INVARIANT_GUARDS');
    return src.slice(start, src.indexOf('\n];', start));
  })();

  const guards: Guard[] = registrySource
    .split(/\n {2}\{\n/)
    .slice(1)
    .map((chunk) => {
      const script = /script: '([^']+)'/.exec(chunk)?.[1];
      const ratchet = /hostSuiteRatchet: '([^']+)'/.exec(chunk)?.[1] ?? null;
      const nonGating = /notCheckedIsNonGating: true/.test(chunk);
      return script ? { script, hostSuiteRatchet: ratchet, notCheckedIsNonGating: nonGating } : null;
    })
    .filter((g): g is Guard => g !== null);

  it('CALIBRATION — the registry parse actually found the guards', () => {
    // Without this, a parse that silently yielded [] would make every it.each below vacuous:
    // zero cases, green suite, zero protection. The declared count is cross-checked against
    // the raw `script:` occurrences so a new entry shape cannot quietly fall out of the scan.
    const rawCount = (registrySource.match(/\n\s*script: '/g) ?? []).length;
    expect(guards.length, `parsed ${guards.length} guard(s) from a registry with ${rawCount}`).toBe(rawCount);
    expect(guards.length).toBeGreaterThanOrEqual(10);
    // Shape, not namespace. This asserted `startsWith('lint:')` until the registry took its
    // first non-lint entry (`gen:authored-docs:check` — a projected-doc drift check, which is
    // a repo-wide invariant like any other and belongs here). That made a CALIBRATION fail for
    // a correct registration, which is the worst failure mode a calibration has: it reads as
    // "the parse broke" while the parse is fine, and the cheap way out is to weaken it to
    // nothing. What the calibration actually needs to prove is that the parse yielded real npm
    // script names rather than garbage or [], so pin THAT — a namespaced `<group>:<name>` — and
    // let the registry grow a new namespace without a false red.
    expect(guards.every((g) => /^[a-z][\w-]*:[\w:-]+$/.test(g.script))).toBe(true);
  });

  /**
   * WI-37826 — "I could not look" must never gate, and the registry is where that is declared.
   *
   * The strand-guard family answers THREE things: 0 checked-and-clean, 1 checked-and-found,
   * 2 could-not-look (EXIT_NOT_CHECKED). The router gates on `status !== 0`, so registering
   * one of these guards without `notCheckedIsNonGating` turns its third answer into a red.
   * And it reds EVERY time rather than intermittently: a gate checkout is clean by
   * construction, so a guard whose subject is the working diff examines zero files on every
   * candidate.
   *
   * MEASURED 2026-08-10: `lint:vimock-export-strands` was registered under the comment "it
   * always exits 0, so it can never red the gate". WI-37806 then made it exit 2 when it
   * examined nothing — correct in itself, and a fleet-wide gate red the moment the gate's
   * checkout picked it up. Nothing connected the two changes, because the guard's exit
   * contract lived in the guard and its consequences lived here.
   */
  it('every registered guard that CAN exit "not checked" declares it non-gating', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    let checked = 0;
    for (const g of guards) {
      const cmd = pkg.scripts?.[g.script];
      if (!cmd) continue;
      // The guard's own source is the authority on whether exit 2 is reachable — asking the
      // file rather than maintaining a second list of "the strand guards" here, which would
      // be one more thing to forget to update.
      const file = /scripts\/[\w.-]+\.mjs/.exec(cmd)?.[0];
      if (!file) continue;
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      } catch {
        continue;
      }
      if (!/from '\.\/lib\/not-checked\.mjs'/.test(src)) continue;
      checked++;
      expect(
        g.notCheckedIsNonGating,
        `${g.script} runs ${file}, which imports not-checked.mjs and so can exit ${EXIT_NOT_CHECKED} ` +
          `("examined nothing"). Registered without notCheckedIsNonGating, that answer reds the gate ` +
          `on every candidate, since a gate checkout's working diff is empty by construction.`,
      ).toBe(true);
    }
    // Without this the loop is vacuous the moment the import pattern changes — the same
    // zero-cases-green-suite failure the CALIBRATION test above exists to prevent.
    expect(checked, 'no registered guard was recognised as strand-family — parse is stale').toBeGreaterThan(0);
  });

  it('the RUNNER actually honours notCheckedIsNonGating — the not-checked branch must not touch the gating counter', () => {
    // The declaration test above asserts every strand-family guard IS registered
    // notCheckedIsNonGating, and its own failure message states the reason: registered without
    // it, "that answer reds the gate on every candidate". That belief was FALSE for as long as
    // the consumer ignored the flag. classifyTaskExit correctly separated 'not-checked' from
    // 'undetermined', and then BOTH branches did `undeterminedTasks++` — the one counter that
    // decides the verdict (`hasFailures: Boolean(failed || undeterminedTasks)`). So a guard that
    // had declared it has no opinion red-pinned every candidate anyway, and the declaration test
    // stayed green throughout because it only ever read the REGISTRATION side.
    //
    // Measured on candidate 57483d0491 (2026-08-30): the gate's own log read
    //   "lint:required-field-strands:typecheck NOT CHECKED (exit 2) — verdict is UNDETERMINED;
    //    not retrying and keeping the affected-tests run non-green."
    // This test pins the CONSUMER half so the pair cannot drift apart again.
    const src = readFileSync(REGISTRY_FILE, 'utf8');
    const branch = /exitClass === "not-checked"\)\s*\{([\s\S]*?)\}\s*else if/.exec(src)?.[1];
    expect(branch, 'the not-checked branch is no longer recognisable in affected-tests.mjs — parse is stale').toBeDefined();
    expect(
      /undeterminedTasks\+\+/.test(branch as string),
      'the not-checked branch increments undeterminedTasks, which is what the verdict gates on. ' +
        'A guard registered notCheckedIsNonGating declared that "I could not look" is its EXPECTED ' +
        'answer here (a gate checkout has an empty working diff by construction), so gating on it ' +
        'reds EVERY candidate unconditionally.',
    ).toBe(false);
    expect(
      /notCheckedNonGating\+\+/.test(branch as string),
      'the not-checked branch must still COUNT the skipped guard on a non-gating counter, so the ' +
        'coverage gap stays visible rather than being silently swallowed',
    ).toBe(true);
  });

  it("the router's mirrored EXIT_NOT_CHECKED equals the real one", () => {
    const src = readFileSync(REGISTRY_FILE, 'utf8');
    const mirrored = /const EXIT_NOT_CHECKED = (\d+);/.exec(src)?.[1];
    expect(mirrored, 'affected-tests.mjs no longer declares EXIT_NOT_CHECKED').toBeDefined();
    expect(Number(mirrored)).toBe(EXIT_NOT_CHECKED);
  });

  it('every declared hostSuiteRatchet names a file that EXISTS', () => {
    // A typo'd or moved path is indistinguishable from a real ratchet at the point of the
    // skip — the router never opens the file. This is the cheapest phantom to create.
    for (const g of guards.filter((x) => x.hostSuiteRatchet)) {
      expect(
        () => readFileSync(resolve(REPO_ROOT, g.hostSuiteRatchet as string), 'utf8'),
        `${g.script} declares hostSuiteRatchet '${g.hostSuiteRatchet}', which does not exist`,
      ).not.toThrow();
    }
  });

  it('every declared hostSuiteRatchet lives in the host workspace, so its `test` task really runs it', () => {
    // Deferring to `@papercusp/operator-core :: test` is only sound if the ratchet is INSIDE
    // that suite. A ratchet in another workspace is never executed by the task being deferred
    // to, which is the same hole wearing a declaration.
    for (const g of guards.filter((x) => x.hostSuiteRatchet)) {
      expect(
        g.hostSuiteRatchet,
        `${g.script}'s ratchet must sit inside packages/operator-core so operator-core's ` +
          'own `test` task executes it',
      ).toMatch(/^packages\/operator-core\//);
    }
  });

  it('every declared hostSuiteRatchet actually RE-RUNS the invariant it vouches for', () => {
    // The substantive check: the named file must reference the guard's own detector, either
    // by being the vitest file the guard script targets, or by exercising the .mjs it runs.
    // A file that merely sits in the suite vouches for nothing.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    for (const g of guards.filter((x) => x.hostSuiteRatchet)) {
      const command = pkg.scripts?.[g.script] ?? '';
      const ratchetPath = g.hostSuiteRatchet as string;
      const body = readFileSync(resolve(REPO_ROOT, ratchetPath), 'utf8');
      // WI-38089: match a `.ts`/`.mts`/`.cjs` detector too, not just `.mjs`. The narrower regex
      // failed CLOSED (a legitimate ratchet over a tsx detector could not be declared at all, and
      // the only way past it was to DROP the ratchet and pay the guard on every edit) — but
      // failing closed here pushes toward the wasteful direction for an expensive guard, so the
      // extension list, not the assertion, is what widens. The requirement is unchanged: the
      // ratchet file must still reference the same detector by name.
      const detector = /([\w-]+\.(?:mjs|cjs|mts|ts))/.exec(command)?.[1] ?? null;

      // Case 1: the guard script IS this vitest file, so the host suite runs it by construction.
      const isOwnVitestTarget =
        /vitest/.test(command) && ratchetPath.endsWith(command.trim().split(/\s+/).pop() ?? '\0');
      // Case 2: a standalone detector — the ratchet must exercise that same .mjs.
      const exercisesDetector = detector !== null && body.includes(detector);

      expect(
        isOwnVitestTarget || exercisesDetector,
        `${g.script} defers to the host suite on the strength of ${ratchetPath}, but that file ` +
          `neither is the vitest target of \`${command}\` nor references ` +
          `${detector ?? '(no .mjs detector found in the command)'}. Either point it at a file ` +
          'that really re-runs the invariant, or DROP the hostSuiteRatchet declaration so the ' +
          'guard attaches unconditionally (the fail-safe direction).',
      ).toBe(true);
    }
  });
});

describe('repo-wide guards survive a change that maps to ZERO workspaces (EI-19454727576364875)', () => {
  /**
   * The regression: an `if (!affected.length) { … process.exit(0) }` used to sit 46 lines ABOVE
   * the REPO_WIDE_INVARIANT_GUARDS loop, so the loop was unreachable whenever the changed paths
   * routed to no workspace. That defeated the mechanism in precisely the case it exists for — a
   * guard is keyed on `appliesTo(changedFile)` so it keeps running when its host workspace is not
   * affected, and a root-level edit (package.json, tsconfig.base.json, the lockfile) is both the
   * likeliest to break something repo-wide and the likeliest to route nowhere.
   *
   * Measured before the fix: `--changed-paths package.json` printed
   * `status=passed tasks=0 reason=no-affected-workspaces` while a guard registered with
   * `appliesTo: (f) => f === 'package.json'` sat there matching and never ran. It presented as
   * GREEN, which is the expensive direction — `tasks=0 … status=passed` is indistinguishable from
   * "nothing needed checking".
   */
  const UNROUTED_PATH = 'package.json';

  it('selects zero workspaces for the probe path (else this test proves nothing)', () => {
    // The vacuity check, first and deliberately. Every assertion below is only meaningful while
    // the probe path really does route nowhere; if package.json is ever wired to a workspace,
    // these would keep passing for an entirely different reason and quietly stop guarding.
    const out = dryTasks(UNROUTED_PATH);
    expect(
      out,
      `${UNROUTED_PATH} now routes to a workspace, so it no longer exercises the zero-workspace ` +
        'path. Point this probe at a path that still routes nowhere — do not delete the test.',
    ).toContain('Affected workspaces (0)');
  });

  it('still attaches and runs repo-wide guards', () => {
    const out = dryTasks(UNROUTED_PATH);

    expect(
      out,
      'A change routing to no workspace exited before the repo-wide invariant guard loop, so ' +
        'every registered guard was skipped. Do NOT reintroduce an early `!affected.length` exit ' +
        'above that loop — let the single `!tasks.length` exit below it handle the empty case.',
    ).toContain('repo-wide invariant guard');

    expect(
      out,
      'The run reported reason=no-affected-workspaces even though guards matched the changed ' +
        'paths — the early-exit regression is back.',
    ).not.toContain('reason=no-affected-workspaces');
  });

  it('reports the genuinely-empty case without claiming guards ran', () => {
    // The other half: when NOTHING matches, the run must still say so honestly rather than
    // inventing work. Asserted on the reason token, not the prose, so wording can change.
    const out = dryTasks(UNROUTED_PATH);
    const tasks = Number(out.match(/AFFECTED_TESTS_RESULT[^\n]*\btasks=(\d+)/)?.[1] ?? '-1');
    expect(
      tasks,
      'Could not read a task count from AFFECTED_TESTS_RESULT — the probe cannot conclude ' +
        'anything about whether guards attached.',
    ).toBeGreaterThan(0);
  });
});

describe('affected-tests: --print-affected includes repo-wide guards (EI-20099180021812549)', () => {
  it('keeps AFFECTED_WS lines and emits machine-readable AFFECTED_GUARD lines', () => {
    // WI-10005544: graph suggestions (P-008) add workspaces from the COMMITTED dependency
    // snapshot, which counts only while it is under 24h old and its importer hashes still
    // match. With suggestions on, this file's closure moved between ['@papercusp/web'] and
    // [web, operator-ui, operator-vite] (via GoalDetailPanel -> HudView -> the vite route and
    // the operator-ui surface) depending on snapshot age alone. This case asserts the
    // print-affected surface and the package-graph baseline, so pin suggestions off.
    // Suggestion behaviour has its own suite: affected-tests-graph-suggestions.test.ts.
    const out = printAffected('apps/operator/app/adv/hud/GoalSessionsRail.tsx', {
      ...process.env,
      PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0',
    });
    const lines = out.split('\n').filter(Boolean);

    expect(lines.filter((line) => line.startsWith('AFFECTED_WS\t'))).toEqual(['AFFECTED_WS\t@papercusp/web']);
    expect(lines.some((line) => line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:chunk-safe\t'))).toBe(true);
    const guardLine = lines.find((line) => line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:chunk-safe\t'));
    expect(guardLine).toBe(
      'AFFECTED_GUARD\t@papercusp/operator-core\tlint:chunk-safe\t' +
        'npm run --silent --workspace @papercusp/operator-core lint:chunk-safe',
    );
    const forwardedGuardLine = lines.find((line) =>
      line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:vimock-export-strands\t'),
    );
    expect(forwardedGuardLine).toContain(
      'npm run --silent --workspace @papercusp/operator-core lint:vimock-export-strands -- ' +
        '--files=apps/operator/app/adv/hud/GoalSessionsRail.tsx --base ',
    );
    expect(out).not.toContain('AFFECTED_TESTS_RESULT');
    expect(out).not.toContain('(repo-wide invariant guard:');
  });

  it('reports guards even when the changed path maps to zero workspaces', () => {
    const out = printAffected('package.json');
    const lines = out.split('\n').filter(Boolean);

    expect(lines.filter((line) => line.startsWith('AFFECTED_WS\t'))).toEqual([]);
    expect(lines.some((line) => line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:guard-reachability\t'))).toBe(true);
    const guardLine = lines.find((line) => line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:guard-reachability\t'));
    expect(guardLine).toBe(
      'AFFECTED_GUARD\t@papercusp/operator-core\tlint:guard-reachability\t' +
        'npm run --silent --workspace @papercusp/operator-core lint:guard-reachability',
    );
    expect(out).not.toContain('AFFECTED_TESTS_RESULT');
  });
});

/**
 * WI-38089 — the declarations freshness guard, wired the same way.
 *
 * `generated-declarations.test.ts` execs `scripts/gen-declarations.ts --check`, comparing the
 * `.mjs` inputs declared in tsconfig.declarations.json against their committed `.d.mts`. It is a
 * vitest file inside operator-core, so it was reachable only when operator-core was otherwise
 * affected. MEASURED 2026-08-12: `--changed-paths apps/operator/scripts/psu-launcher.mjs` selected
 * `@papercusp/web` ONLY, though psu-launcher.mjs IS a declared input. Editing it without re-running
 * `npm run gen:declarations` therefore produced no local signal — test:affected green, and the
 * drift is type-only so lint:tsc is green too — and first surfaced as green-checkpoint red #9
 * (candidate cc56ee43) an hour later, against a candidate its author had long moved past.
 *
 * The `appliesTo` set is DERIVED from tsconfig.declarations.json rather than mirrored, so there is
 * no list here to keep in sync. What needs asserting instead is that the derivation still
 * DISCRIMINATES: 'attaches for a declared input' and 'does NOT attach for an undeclared .mjs' are a
 * matched pair, and the router widens to every `.mjs` if it cannot read the config — so a
 * derivation that silently stopped finding inputs fails the negative test rather than passing both.
 */
describe('affected-tests: declarations freshness guard (WI-38089)', () => {
  const DECL_SCRIPT = 'lint:declarations-fresh';
  const DECL_TASK = `${HOST_WORKSPACE} :: ${DECL_SCRIPT}`;
  /** A declared input OUTSIDE the host workspace — the measured case from the filing. */
  const OUTSIDE_INPUT = 'apps/operator/scripts/psu-launcher.mjs';
  /** A declared input INSIDE the host workspace, whose full `test` task already covers the check. */
  const INSIDE_INPUT = 'packages/operator-core/lib/model-context-budget.mjs';
  /**
   * An `.mjs` that is NOT a declared input, so it cannot cause declaration drift.
   *
   * It must ALSO route to a workspace other than operator-core, or the negative test proves
   * nothing: a root-level `scripts/*.mjs` fans out to operator-core, whose `test` task then
   * satisfies the hostSuiteRatchet and suppresses the guard for that reason instead of because the
   * path is undeclared. (Measured the hard way — `scripts/check-js-syntax.mjs` was the first
   * choice here and is itself one of the 42 declared inputs, so it asserted the opposite of what
   * it appeared to.) `apps/operator-docs` routes only to @papercupai/operator-docs.
   */
  const UNDECLARED_MJS = 'apps/operator-docs/astro.config.mjs';
  const DECL_CONFIG = 'tsconfig.declarations.json';

  function declaredInputs(): string[] {
    const raw = readFileSync(resolve(REPO_ROOT, DECL_CONFIG), 'utf8');
    return [...raw.matchAll(/"([^"\n]+\.mjs)"/g)].map((m) => m[1]);
  }

  it('keeps its premises true: both probe paths are still declared inputs, and the control is not', () => {
    const declared = declaredInputs();
    expect(
      declared.length,
      'no declared .mjs inputs found — the router would then widen to every .mjs, silently ' +
        'turning this guard into a tax on unrelated edits',
    ).toBeGreaterThan(0);
    expect(declared, `${OUTSIDE_INPUT} must remain a declared input or this suite proves nothing`).toContain(
      OUTSIDE_INPUT,
    );
    expect(declared, `${INSIDE_INPUT} must remain a declared input`).toContain(INSIDE_INPUT);
    expect(
      declared,
      `${UNDECLARED_MJS} must NOT be declared — it is the negative control that proves the ` +
        'derivation discriminates rather than matching everything',
    ).not.toContain(UNDECLARED_MJS);
  });

  it('attaches for a declared input OUTSIDE its host workspace', () => {
    const out = dryTasks(OUTSIDE_INPUT);
    expect(
      out,
      `editing ${OUTSIDE_INPUT} must run the declarations check; without it, forgetting ` +
        '`npm run gen:declarations` gets ZERO local signal (test:affected green, lint:tsc green ' +
        'because the drift is type-only) and first reds the shared gate an hour later',
    ).toContain(DECL_TASK);
  });

  it('attaches when the CONFIG itself changes, which is the missing-declaration shape', () => {
    // Adding an input without generating its `.d.mts` is a config edit, not a source edit, and
    // `--check` reports it as `missing` rather than `stale`.
    expect(dryTasks(DECL_CONFIG)).toContain(DECL_TASK);
  });

  it('attaches when a generated .d.mts is hand-edited', () => {
    const dmts = OUTSIDE_INPUT.replace(/\.mjs$/, '.d.mts');
    expect(
      dryTasks(dmts),
      'drift in the opposite direction: the committed declaration no longer matches what the ' + 'generator would emit',
    ).toContain(DECL_TASK);
  });

  it('does NOT attach for an .mjs that is not a declared input', () => {
    // Establish the control is VALID before trusting the negative: if this path selected
    // operator-core, the hostSuiteRatchet would suppress the guard and the assertion below would
    // pass without the derivation having discriminated anything at all.
    expect(
      printAffected(UNDECLARED_MJS),
      `${UNDECLARED_MJS} must not route to ${HOST_WORKSPACE}, or this test passes for the wrong ` +
        'reason (ratchet suppression, not an undeclared path)',
    ).not.toContain(`AFFECTED_WS\t${HOST_WORKSPACE}`);
    expect(
      dryTasks(UNDECLARED_MJS),
      `this is the most expensive entry in the registry (~6.1s: a tsc emit plus a 42-file ` +
        'byte-compare), so attaching it to an .mjs that cannot violate the invariant spends ' +
        "every agent's budget for no possible finding",
    ).not.toContain(DECL_TASK);
  });

  it('does NOT double-run when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_INPUT);
    expect(out, 'the host workspace should run its own suite here').toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'generated-declarations.test.ts execs the SAME --check invocation inside operator-core’s ' +
        'suite, so attaching the narrow task as well would run a 6s check twice',
    ).not.toContain(DECL_TASK);
  });

  it('keeps the guard script defined, and pointed at the CHECK rather than the vitest file', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[DECL_SCRIPT],
      `${HOST_WORKSPACE} must define "${DECL_SCRIPT}". The router only builds a task when the ` +
        'script exists, so removing it re-opens the gap silently — the run stays green and simply ' +
        'stops checking.',
    ).toBeTruthy();
    expect(pkg.scripts?.[DECL_SCRIPT]).toContain('gen-declarations');
    expect(
      pkg.scripts?.[DECL_SCRIPT],
      'must invoke --check; without it the script GENERATES declarations, which would make the ' +
        'guard mutate the tree it is meant to police',
    ).toContain('--check');
    expect(pkg.scripts?.[DECL_SCRIPT]).not.toContain('vitest');
  });
});

/**
 * WI-7025 — the `.mjs` enrollment guard must travel with every TS importer it scans.
 *
 * `check-unenrolled-mjs-imports.test.ts` is a real-tree ratchet, but it lives in
 * operator-core. Without the repo-wide registration, an import added in another workspace
 * stays invisible to `test:affected` until the later fleet typecheck. These probes pin both
 * directions of the routing predicate and the three non-TS inputs that can change its verdict.
 */
describe('affected-tests: detached-spawn tree guard (WI-10002061)', () => {
  const SCRIPT = 'lint:no-unenrolled-spawn';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;

  it('attaches the real-tree scan for source outside its host workspace', () => {
    expect(dryTasks('packages/backup/src/hook.ts')).toContain(TASK);
    expect(dryTasks('apps/operator/lib/release/deploy-cli.ts')).toContain(TASK);
  });

  it('attaches for its own detector and routing configuration', () => {
    expect(dryTasks('scripts/check-no-unenrolled-detached-spawn.mjs')).toContain(TASK);
    expect(dryTasks('scripts/affected-tests.mjs')).toContain(TASK);
  });

  it('does not attach to a file the tree scan excludes', () => {
    expect(dryTasks('apps/operator/docs/nuqs-audit-2026-05-11.md')).not.toContain(TASK);
    expect(dryTasks('packages/backup/src/hook.test.ts')).not.toContain(TASK);
  });

  it('keeps the host script pointed at the real-tree checker', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toContain('check-no-unenrolled-detached-spawn.mjs');
  });
});

/**
 * WI-10005282 — `lint:no-eager-execfile-promisify` scans the whole tracked tree, but its only
 * blocking runner was a GitHub Actions job that failed on every run, so 14 offenders landed
 * unseen. These probes pin the registration that puts it on the gate's affected-suite path,
 * including its `.mjs` half (the guard scans .ts, .mjs and .cjs).
 */
describe('affected-tests: eager execFile promisify guard (WI-10005282)', () => {
  const SCRIPT = 'lint:no-eager-execfile-promisify';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;

  it('attaches the real-tree scan for .ts and .mjs source outside its host workspace', () => {
    expect(dryTasks('libs/test-config/src/dedicated-native-pg.ts')).toContain(TASK);
    expect(dryTasks('apps/operator/lib/mcp-proxy/watchdog.mjs')).toContain(TASK);
  });

  it('attaches for its own detector and routing configuration', () => {
    expect(dryTasks('scripts/check-no-eager-execfile-promisify.mjs')).toContain(TASK);
    expect(dryTasks('scripts/affected-tests.mjs')).toContain(TASK);
  });

  it('does not attach to a file the tree scan excludes', () => {
    expect(dryTasks('apps/operator/docs/nuqs-audit-2026-05-11.md')).not.toContain(TASK);
    expect(dryTasks('packages/backup/src/hook.test.ts')).not.toContain(TASK);
  });

  it('keeps the host script pointed at the real-tree checker', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toContain('check-no-eager-execfile-promisify.mjs');
  });
});

describe('affected-tests: real host bundle guard (EI-24368307678871025)', () => {
  const SCRIPT = 'lint:host-bundle-builds';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;

  it('runs for cross-workspace host imports and operator-core exports', () => {
    expect(dryTasks('apps/operator/lib/release/deploy-cli.ts')).toContain(TASK);
    expect(dryTasks('packages/operator-core/lib/blueprint/package-resource-receipts.ts')).toContain(TASK);
  });

  it('runs when the bundle recipe or routing changes, but skips test-only edits', () => {
    expect(dryTasks('apps/operator/bin/bundle-host.sh')).toContain(TASK);
    expect(dryTasks('scripts/affected-tests.mjs')).toContain(TASK);
    expect(dryTasks('apps/operator/lib/release/deploy.test.ts')).not.toContain(TASK);
  });

  it('resolves the real bundle check from its selected workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toContain('check-host-bundle-builds.mjs');
  });
});

describe('affected-tests: unenrolled .mjs import guard (WI-7025)', () => {
  const SCRIPT = 'lint:no-unenrolled-mjs-imports';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const OUTSIDE_TS = 'apps/operator/lib/release/deploy-cli.ts';
  const INSIDE_TS = 'packages/operator-core/lib/terminal-spawn.ts';
  const NON_SOURCE = 'apps/operator/docs/nuqs-audit-2026-05-11.md';
  const DECLARATIONS_CONFIG = 'tsconfig.declarations.json';

  it('attaches for a TS change OUTSIDE the host workspace', () => {
    expect(dryTasks(OUTSIDE_TS)).toContain(TASK);
  });

  it('does NOT double-run when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_TS);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(out).not.toContain(TASK);
  });

  it('attaches when the declarations config changes', () => {
    expect(dryTasks(DECLARATIONS_CONFIG)).toContain(TASK);
  });

  it('does NOT attach for a non-source path', () => {
    expect(dryTasks(NON_SOURCE)).not.toContain(TASK);
  });

  it('keeps the guard script defined and pointed at the detector', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toBeTruthy();
    expect(pkg.scripts?.[SCRIPT]).toContain('check-unenrolled-mjs-imports.mjs');
    expect(pkg.scripts?.[SCRIPT]).not.toContain('vitest');
  });
});

/**
 * EI-20822558150340173 / D-046 — the same class again, on the registry that decides what
 * every agent's PreToolUse gate ENFORCES.
 *
 * `ALL_PAIRS` has two projections. The `CLAUDE.md` routing table has had a `--check` gate
 * since it shipped and stayed correct. The `harness_shared.bash_tool_substitutions` rows had
 * NO automatic caller of any kind — `seedSubstitutionRegistry()` is reachable only from the
 * manual `npm run seed:substitutions` — so a pair edit changed nothing about enforcement,
 * indefinitely, while the unit tests, `gen:tool-routing:check`, typecheck and git-sync all
 * reported success. Measured: `policy-violation:unsafe-dependency-install` was widened in
 * code on 2026-08-14 and the live row still carried the narrower pattern four days later.
 *
 * Both directions are asserted, for the reason the migration-lint block above gives: a
 * registration that attaches to EVERYTHING fails just as surely as one that attaches to
 * nothing — it spends every agent's edit budget on a DB round-trip that cannot find anything.
 */
describe('affected-tests: substitution registry drift guard (D-046)', () => {
  const SEED_SCRIPT = 'seed:substitutions:check';
  const SEED_TASK = `${HOST_WORKSPACE} :: ${SEED_SCRIPT}`;
  const PAIRS_DIR = 'packages/operator-core/lib/bash-substitution/pairs';
  const FIXTURES_DIR = 'packages/operator-core/lib/bash-substitution/fixtures';

  it('attaches for a change to a PAIR — the edit that silently rots the live rows', () => {
    const out = dryTasks(`${PAIRS_DIR}/dependency-install.ts`);
    expect(
      out,
      'a pair edit is the ONLY thing that can put the seeded registry out of date; if this ' +
        `guard is not attached here it is attached nowhere useful. Task list was:\n${out}`,
    ).toContain(SEED_TASK);
  });

  it('attaches for a re-frozen FIXTURE, which moves the recomputed verdict', () => {
    // The verdict stored on each row is recomputed FROM the fixture sample, so re-freezing
    // a sample drifts a seeded field without touching any pair.
    const out = dryTasks(`${FIXTURES_DIR}/deps.unsafe-install.sample.json`);
    expect(out).toContain(SEED_TASK);
  });

  it('STILL attaches when the host workspace is affected, because nothing in that suite re-runs it', () => {
    // A pair lives inside operator-core, so its own suite is always selected too. The guard
    // declares no hostSuiteRatchet, and correctly so: operator-core's vitest run never
    // queries Postgres, so it cannot substitute for a check whose entire subject is the
    // difference between the pairs and the live rows.
    const out = dryTasks(`${PAIRS_DIR}/dependency-install.ts`);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'the host suite does not read the database, so deferring to it would be silent ' +
        'coverage loss rather than a saved duplicate run',
    ).toContain(SEED_TASK);
  });

  it('does NOT attach for a bash-substitution file that cannot drift a row', () => {
    // The discriminating case, and the reason `appliesTo` is not the whole module: the
    // matcher, the report and the census are all downstream of the seeded row rather than
    // inputs to it. Attaching here would put a DB round-trip on edits that provably cannot
    // produce a finding.
    const out = dryTasks('packages/operator-core/lib/bash-substitution/match.ts');
    expect(
      out,
      'only the pairs and their frozen fixtures are seeded from; a change to the matcher ' +
        'cannot make the registry stale',
    ).not.toContain(SEED_TASK);
  });

  it('keeps the guard script defined on the HOST workspace, so the attachment cannot silently no-op', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[SEED_SCRIPT],
      `${HOST_WORKSPACE} must define "${SEED_SCRIPT}". The router only builds a task when the ` +
        'script exists on the HOST workspace, so declaring it only in the ROOT package.json ' +
        'leaves the registration attaching nothing while every probe still looks healthy.',
    ).toBeTruthy();
    expect(pkg.scripts?.[SEED_SCRIPT]).toContain('seed-substitution-registry.ts');
    expect(
      pkg.scripts?.[SEED_SCRIPT],
      'must invoke --check; without it the script SEEDS, which would make the guard write to ' +
        'the live enforcement rows it is meant to merely police',
    ).toContain('--check');
  });
});

/**
 * EI-19453217565223331 — `positions.deployed` is git ancestry, while process
 * liveness requires `serving.startedSinceCodeChange`.  The detector scans the
 * whole production tree, so routing must fire for an edit outside its host
 * workspace and must defer to this in-suite ratchet when operator-core itself
 * is already selected.
 */
describe('affected-tests: deployed-liveness read guard (EI-19453217565223331)', () => {
  const SCRIPT = 'lint:no-deployed-liveness-read';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const OUTSIDE_PATH = 'apps/operator/lib/release/deploy-cli.ts';
  const INSIDE_PATH = 'packages/operator-core/lib/git-pipeline-position.ts';
  const UNMATCHED_PATH = 'apps/operator/app/_brand-primitives.css';

  it('attaches for a production TS change outside operator-core', () => {
    expect(
      dryTasks(OUTSIDE_PATH),
      `${OUTSIDE_PATH} is in the detector scan population but routes to @papercusp/web; ` +
        'without the repo-wide attachment a new ungrounded reader there gets no local signal',
    ).toContain(TASK);
  });

  it('defers to the host suite when operator-core is affected', () => {
    const out = dryTasks(INSIDE_PATH);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'the in-suite ratchet executes findOffenders() over the real tree, so queueing the same ' +
        'detector task would only duplicate work',
    ).not.toContain(TASK);
  });

  it('does not attach for a path outside the detector population', () => {
    const out = dryTasks(UNMATCHED_PATH);
    expect(out).not.toContain(TASK);
    expect(out).not.toContain(`${HOST_WORKSPACE} :: test`);
  });

  it('keeps the guard script declared on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toContain('check-no-deployed-liveness-read.mjs');
  });
});

/**
 * WI-2144851 / P-007 — the reachable-production-advisory gate, wired the same way.
 *
 * `scripts/check-reachable-advisories.mjs` attributes every npm advisory to the workspace(s)
 * that pull it in and gates only on the SHIPPING high/critical set. Its subject is not any
 * workspace's source — it is the dependency GRAPH — so workspace selection cannot reach it:
 * a new shipping advisory enters through a manifest/lockfile edit in a workspace whose own
 * suite has no reason to run a dependency audit. Before this registration the gate existed,
 * was falsifiable, and ran on NO path at all.
 *
 * The pair below is what makes the registration falsifiable rather than merely present:
 * a predicate that stopped matching manifests, and one that widened to all source, are both
 * silent failures in opposite directions — the first turns the gate off, the second bills
 * every source edit ~15s of `npm audit`. Only asserting BOTH catches either.
 *
 * The third case covers the silent-no-op shape the whole file exists for
 * (`if (!ws?.scripts?.[guard.script]) continue`): drop the script from operator-core's
 * package.json and the registration above stays, looks correct, and attaches nothing.
 */
describe('affected-tests: reachable-advisory gate (WI-2144851)', () => {
  const ADVISORY_SCRIPT = 'lint:reachable-advisories';
  const ADVISORY_GUARD_PREFIX = `AFFECTED_GUARD\t@papercusp/operator-core\t${ADVISORY_SCRIPT}\t`;

  it('attaches for a dependency-manifest change in another workspace', () => {
    const out = printAffected('packages/operator-core/package.json');
    const guardLine = out
      .split('\n')
      .filter(Boolean)
      .find((line) => line.startsWith(ADVISORY_GUARD_PREFIX));
    expect(guardLine).toBe(
      `${ADVISORY_GUARD_PREFIX}npm run --silent --workspace @papercusp/operator-core ${ADVISORY_SCRIPT}`,
    );
  });

  it('does NOT attach for an ordinary source change (a source edit cannot add an advisory)', () => {
    const out = printAffected('packages/operator-core/lib/tsc-diagnostics.ts');
    expect(out).not.toContain(ADVISORY_GUARD_PREFIX);
  });

  it('keeps the guard script declared on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[ADVISORY_SCRIPT]).toContain('check-reachable-advisories.mjs');
    // --strict is what makes it GATE rather than report; without it the guard exits 0 on a
    // brand-new shipping high advisory and the whole registration is decoration.
    expect(pkg.scripts?.[ADVISORY_SCRIPT]).toContain('--strict');
  });
});

/**
 * WI-2144851 / P-007 — the RUST half of the same advisory clause, wired the same way.
 *
 * The gate above is npm-only by construction; `scripts/check-rust-advisories.mjs` covers
 * the 615 crates that papercusp-desktop/src-tauri/Cargo.lock pins into the SHIPPED desktop
 * app. Workspace selection can never reach that subject: papercusp-desktop is a SUBMODULE
 * and is deliberately absent from the root npm workspaces, so no workspace suite runs on a
 * Cargo.lock edit.
 *
 * The third case is not ceremony — it is the failure this registration ACTUALLY hit during
 * development. The npm script was added to the ROOT package.json only, so
 * `if (!ws?.scripts?.[guard.script]) continue` skipped the entry SILENTLY: the registry
 * entry was present and correct-looking, the negative controls still "passed" (a guard that
 * never attaches never over-attaches), and the gate ran on no path at all. A green negative
 * control cannot distinguish a correctly-scoped guard from an absent one; only the positive
 * cases below can.
 */
describe('affected-tests: rust advisory gate (WI-2144851)', () => {
  const RUST_SCRIPT = 'lint:rust-advisories';
  const RUST_GUARD_PREFIX = `AFFECTED_GUARD\t@papercusp/operator-core\t${RUST_SCRIPT}\t`;

  it('attaches for a change to the SHIPPED Cargo.lock', () => {
    const out = printAffected('papercusp-desktop/src-tauri/Cargo.lock');
    const guardLine = out
      .split('\n')
      .filter(Boolean)
      .find((line) => line.startsWith(RUST_GUARD_PREFIX));
    expect(guardLine).toBe(
      `${RUST_GUARD_PREFIX}npm run --silent --workspace @papercusp/operator-core ${RUST_SCRIPT}`,
    );
  });

  it('attaches for a change to its own baseline (the shrink-only file)', () => {
    expect(printAffected('scripts/rust-advisories-baseline.json')).toContain(RUST_GUARD_PREFIX);
  });

  it('does NOT attach for an ordinary source change', () => {
    expect(printAffected('packages/operator-core/lib/tsc-diagnostics.ts')).not.toContain(RUST_GUARD_PREFIX);
  });

  it('does NOT attach for a Cargo.lock that does not ship', () => {
    // Six of the seven Cargo.lock files here are dev/vendored surfaces. Widening the
    // predicate to all of them bills every vendored-crate edit a network advisory scan
    // for a graph that never reaches a user.
    expect(printAffected('apps/tui/Cargo.lock')).not.toContain(RUST_GUARD_PREFIX);
  });

  it('keeps the guard script declared on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[RUST_SCRIPT]).toContain('check-rust-advisories.mjs');
    // Without --strict the guard exits 0 on a brand-new shipped Rust vulnerability and the
    // whole registration is decoration.
    expect(pkg.scripts?.[RUST_SCRIPT]).toContain('--strict');
  });
});

/**
 * WI-2144851 / P-007 — the SBOM/INVENTORY half of the same audit clause.
 *
 * The two advisory gates above each scan ONE hand-chosen lockfile. Neither can see a
 * dependency graph outside its own scope, and a graph nobody scans is not reported clean —
 * it is not measured, which reads identically from outside. `scripts/check-lockfile-census.mjs`
 * derives the whole lockfile population from the filesystem and forces every row into an
 * explicit bucket, so a new blind spot fails instead of waiting to be found by hand.
 *
 * TRIGGER SCOPE is the WIDEST of the three on purpose, and that is the point of the first
 * case: the event that matters is a lockfile APPEARING at a path that does not exist yet,
 * which no narrower matcher can enumerate in advance. Both blind spots that motivated the
 * file entered exactly that way.
 */
describe('affected-tests: lockfile census / SBOM gate (WI-2144851)', () => {
  const CENSUS_SCRIPT = 'lint:lockfile-census';
  const CENSUS_GUARD_PREFIX = `AFFECTED_GUARD\t@papercusp/operator-core\t${CENSUS_SCRIPT}\t`;

  it('attaches for a lockfile at a path that does not exist yet', () => {
    const out = printAffected('some/newly/added/package/package-lock.json');
    const guardLine = out
      .split('\n')
      .filter(Boolean)
      .find((line) => line.startsWith(CENSUS_GUARD_PREFIX));
    expect(guardLine).toBe(
      `${CENSUS_GUARD_PREFIX}npm run --silent --workspace @papercusp/operator-core ${CENSUS_SCRIPT}`,
    );
  });

  it('attaches for a new Cargo.lock anywhere in the tree', () => {
    // Deliberately WIDER than the Rust advisory gate, which fires only on the shipped
    // lockfile. Coverage of a graph and the SHIPPING of that graph are different
    // questions, and the census is the one that must see every candidate.
    expect(printAffected('some/rust/crate/Cargo.lock')).toContain(CENSUS_GUARD_PREFIX);
    expect(printAffected('apps/tui/Cargo.lock')).toContain(CENSUS_GUARD_PREFIX);
  });

  it('attaches for a change to the census script itself', () => {
    expect(printAffected('scripts/check-lockfile-census.mjs')).toContain(CENSUS_GUARD_PREFIX);
  });

  it('does NOT attach for an ordinary source change', () => {
    expect(printAffected('packages/operator-core/lib/tsc-diagnostics.ts')).not.toContain(CENSUS_GUARD_PREFIX);
  });

  it('does NOT attach for a lockfile inside node_modules', () => {
    // Vendored lockfiles under node_modules are not this repo's dependency graph, and the
    // walker prunes them; billing a census run for one would be pure noise.
    expect(printAffected('node_modules/some-dep/package-lock.json')).not.toContain(CENSUS_GUARD_PREFIX);
  });

  // The case that is not ceremony: this exact omission silently unattached the Rust guard
  // during its own development. `if (!ws?.scripts?.[guard.script]) continue` skips an entry
  // whose script is missing from the HOST workspace's package.json, with no message. The
  // registry entry looks right, the negative controls still pass — a guard that never
  // attaches also never over-attaches — and the gate runs on no path at all.
  it('keeps the guard script declared on the host workspace, with --strict', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[CENSUS_SCRIPT]).toContain('check-lockfile-census.mjs');
    // Without --strict an UNCLASSIFIED lockfile exits 0 and the registration is decoration.
    expect(pkg.scripts?.[CENSUS_SCRIPT]).toContain('--strict');
  });

  // syft is a dev-box binary, not a pipeline dependency, and emitSbom REFUSES when it is
  // absent rather than skipping quietly. That refusal is correct for an on-demand
  // inventory and would red-pin every host without syft if it sat on the gate path.
  it('keeps SBOM emission OFF the gate path and on its own root entrypoint', () => {
    const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const corePkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(corePkg.scripts?.[CENSUS_SCRIPT]).not.toContain('--sbom');
    expect(rootPkg.scripts?.['lint:lockfile-census:sbom']).toContain('--sbom');

    // `toContain('--sbom')` above is TRUE of a script that emits nothing, and that is not
    // hypothetical: this entrypoint read `--strict --sbom` — flag last, no operand — from
    // the day it was written until 2026-09-05. `--sbom` takes a PATH, so the emit block
    // never ran; the script printed the plain census and exited 0. The assertion one line
    // up passed the whole time, because the flag WAS present. It was measuring the wrong
    // property of the right string.
    //
    // So assert the operand, not the flag. The full parse contract (bare flag and
    // flag-shaped operand both refuse) is pinned in lockfile-census-guard.test.ts against
    // the script's own parser; this keeps the registry-side assertion from going vacuous.
    const sbomArgv = String(rootPkg.scripts?.['lint:lockfile-census:sbom']).split(/\s+/);
    const operand = sbomArgv[sbomArgv.indexOf('--sbom') + 1];
    expect(operand, '--sbom is the last token: the SBOM would be silently skipped').toBeTypeOf('string');
    expect(operand?.startsWith('-'), `--sbom operand is the flag \`${operand}\`, not a path`).toBe(false);
  });
});
