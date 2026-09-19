/**
 * Recurrence guard for EI-19450431506682666 — a mutation probe must never
 * leave the SHARED tree mutated.
 *
 * The incident: the hand-rolled idiom `cp bak; mutate; test; cp back` was run
 * as one foreground Bash call, hit the 2-min deadline partway through, and the
 * trailing restore never ran. git-sync then committed the mutant
 * (db6d7b02b1) — a version of scripts/verify-tauri-headless.sh in which the
 * fix's function was DEFINED but never CALLED. Inert, `bash -n`-clean, and
 * shaped exactly like a finished change.
 *
 * These tests pin the two properties that make `scripts/mutation-probe.sh`
 * safe, and they are written so that neither can pass on dead code:
 *
 *   - COPY-OUT never touches the tracked file (asserted by content identity,
 *     never by `git status` — on a swept tree a clean status means the sweep
 *     ran, not that the file is unmodified).
 *   - IN-TREE restores PROMPTLY on SIGTERM. The timing is the whole assertion:
 *     the pre-fix foreground form also restored eventually, just deferred
 *     until its child exited (measured: 23s), which is indistinguishable from
 *     "works" unless the deadline is pinned. Bash will not run a trap while
 *     waiting on a FOREGROUND child, and the harness follows SIGTERM with
 *     SIGKILL — so a deferred handler is frequently never a handler at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The subject under test, overridable by path. This is the tier-2 pattern the
 * script itself exists to enable: a guard that reads its subject from a
 * REDIRECTABLE path can be falsified against a mutated COPY, so proving this
 * suite is falsifiable never requires dirtying the tracked file. Without the
 * override the only way to falsify it would be an in-tree mutation — i.e. the
 * exact hazard EI-19450431506682666 was filed for.
 */
const SCRIPT = process.env.MUTATION_PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/mutation-probe.sh');
const ORIGINAL = 'alpha\nbeta\ngamma\n';

let dir: string;
let subject: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mutation-probe-test-'));
  subject = join(dir, 'subject.txt');
  writeFileSync(subject, ORIGINAL);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the probe to completion and return its exit code. */
function runProbe(args: string[]): number {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
  return r.status ?? -1;
}

/** Run the probe and return its exit code AND combined output (for asserting guidance text). */
function runProbeIO(args: string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000, env });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const read = () => readFileSync(subject, 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

/** A tiny real Git history lets historical-mode tests exercise git show/rev-list, not mocks. */
function makeHistoricalRepo(): { repo: string; file: string; oldSha: string } {
  const repo = join(dir, 'historical-repo');
  mkdirSync(repo);
  const file = join(repo, 'subject.txt');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(repo, ['config', 'user.name', 'mutation-probe-test']);
  writeFileSync(file, 'stable-control\nlegacy-path\n');
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'historical source']);
  const oldSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(file, 'stable-control\nNEW_GUARD\n');
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'fix source']);
  // Leave the current source uncommitted: the probe must freeze it before any
  // guard command runs, just as git-sync can commit a real working tree mid-run.
  writeFileSync(file, 'stable-control\nNEW_GUARD\ncurrent-edit\n');
  return { repo, file, oldSha };
}

/**
 * Like makeHistoricalRepo, but the subject is a TYPESCRIPT file — the shape
 * EI-23362664002917898 broke. The bodies carry `as const` so the content only
 * parses once types are stripped, which is decided purely by file EXTENSION.
 */
function makeHistoricalTsRepo(): { repo: string; file: string; oldSha: string } {
  const repo = join(dir, 'historical-ts-repo');
  mkdirSync(repo);
  const file = join(repo, 'subject.ts');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(repo, ['config', 'user.name', 'mutation-probe-test']);
  writeFileSync(file, '// stable-control\nexport const V = 1 as const;\n');
  git(repo, ['add', 'subject.ts']);
  git(repo, ['commit', '-qm', 'historical ts source']);
  const oldSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(file, '// stable-control\nexport const V = 1 as const;\nexport const NEW_GUARD = 2 as const;\n');
  git(repo, ['add', 'subject.ts']);
  git(repo, ['commit', '-qm', 'fix ts source']);
  return { repo, file, oldSha };
}

describe('mutation-probe.sh — copy-out mode (the default)', () => {
  it('propagates available legacy scope aliases to canonical test-run variables', () => {
    const env = { ...process.env };
    delete env.PAPERCUSP_TEST_RUN_HARNESS;
    delete env.PAPERCUSP_HARNESS_SLUG;
    delete env.PAPERCUSP_WORKSPACE_ID;
    env.HARNESS_SLUG = 'probe-harness';
    env.PAPERCUSP_WORKSPACE = 'probe-workspace';
    const { code, out } = runProbeIO(
      [
        '--file',
        subject,
        '--mutate',
        's/beta/BETA/',
        '--test',
        'test "$PAPERCUSP_TEST_RUN_HARNESS" = probe-harness && test "$PAPERCUSP_WORKSPACE_ID" = probe-workspace && test -f {} && if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then exit 1; fi',
      ],
      env,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('does not invent scope for an explicitly unscoped caller', () => {
    const env = { ...process.env };
    for (const key of [
      'PAPERCUSP_TEST_RUN_HARNESS',
      'HARNESS_SLUG',
      'PAPERCUSP_HARNESS_SLUG',
      'PAPERCUSP_WORKSPACE_ID',
      'PAPERCUSP_WORKSPACE',
    ] as const) {
      delete env[key];
    }
    const { code, out } = runProbeIO(
      [
        '--file',
        subject,
        '--mutate',
        's/beta/BETA/',
        '--test',
        'test -z "${PAPERCUSP_TEST_RUN_HARNESS:-}" && test -z "${PAPERCUSP_WORKSPACE_ID:-}" && test -f {} && if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then exit 1; fi',
      ],
      env,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('leaves the subject file byte-identical while still exercising the guard', () => {
    const code = runProbe(['--file', subject, '--mutate', 's/beta/BETA/', '--test', 'grep -q "^beta$" {}']);
    // The guard fails on the mutant => the mutant was CAUGHT => probe exits 0.
    expect(code).toBe(0);
    expect(read()).toBe(ORIGINAL);
  });

  it('reports a WEAK guard (exit 1) when the mutant survives, rather than passing quietly', () => {
    // The guard only checks "beta", so mutating "gamma" must slip past it.
    const code = runProbe(['--file', subject, '--mutate', 's/gamma/GAMMA/', '--test', 'grep -q "^beta$" {}']);
    expect(code).toBe(1);
    expect(read()).toBe(ORIGINAL);
  });

  it('reports a baseline harness failure as an error, never as a caught mutant', () => {
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      "bash -c 'exit 2' {}",
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/BASELINE FAILED/i);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('reports a mutant harness crash as an error, not as falsifiability evidence', () => {
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      "bash -c 'if [ \"$PAPERCUSP_MUTATION_PHASE\" = mutant ]; then exit 2; fi' _ {}",
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/HARNESS ERROR/i);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('marks every supervised guard phase (baseline, copy-baseline, mutant) so deliberate results stay out of health evidence', () => {
    const markerLog = join(dir, 'marker.log');
    const { code } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      `printf '%s=%s\\n' "$PAPERCUSP_MUTATION_PHASE" "$PAPERCUSP_MUTATION_PROBE" >> "${markerLog}"; if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then exit 1; fi; test -f {}`,
    ]);
    expect(code).toBe(0);
    expect(readFileSync(markerLog, 'utf8').trim().split('\n').sort()).toEqual([
      'baseline=1',
      'copy-baseline=1',
      'mutant=1',
    ]);
    expect(read()).toBe(ORIGINAL);
  });

  it('retries ONCE on a transient pc-heavy after-ready-marker EEXIST, then still reaches a genuine verdict (EI-22133917471532652)', () => {
    // Simulates the observed harness noise: a --test wrapping `npm run
    // test:file` can rarely fail with TEST_FILE_ROUTE_ERROR (EEXIST on the
    // pc-heavy after-ready marker) before a single test runs, because pc-heavy
    // allocates that marker with a fresh `mktemp` path per invocation and a
    // rare clash on the shared /tmp marker directory is harness noise, not a
    // test result. A fresh invocation gets a brand-new random marker path, so
    // the probe's own bounded retry should absorb exactly one such failure per
    // guard phase (baseline, copy-baseline, mutant) and still reach the
    // correct MUTANT CAUGHT verdict — never mis-scoring it as a harness error.
    const attemptDir = join(dir, 'attempts');
    mkdirSync(attemptDir);
    const cmd = [
      `f="${attemptDir}/$PAPERCUSP_MUTATION_PHASE"`,
      `n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 ))`,
      `echo "$n" > "$f"`,
      `if [ "$n" -eq 1 ]; then echo "TEST_FILE_ROUTE_ERROR refusing execution phase: could not publish the pc-heavy after-ready marker: EEXIST: file already exists, open '/tmp/pc-heavy-ready/ready.FAKE01'" >&2; exit 75; fi`,
      `grep -q "^beta$" {}`,
    ].join('; ');
    const { code, out } = runProbeIO(['--file', subject, '--mutate', 's/beta/BETA/', '--test', cmd]);
    expect(code).toBe(0);
    expect(out).toMatch(/retrying once with a fresh marker path/);
    expect(out).not.toMatch(/verdict=harness-error/);
    expect(read()).toBe(ORIGINAL);
  });

  it('REFUSES a mutation that changed nothing (exit 2) instead of reporting a false weakness', () => {
    // A no-op mutation is the quiet killer of this technique: the "mutant" is
    // identical to the original, so any guard passes and the probe would
    // otherwise report "your guard did not catch it" — a false verdict from a
    // probe that never mutated anything.
    const code = runProbe(['--file', subject, '--mutate', 's/nosuchtext/x/', '--test', 'grep -q "^beta$" {}']);
    expect(code).toBe(2);
    expect(read()).toBe(ORIGINAL);
  });

  it('REFUSES a mutation that changes only whitespace and does not run the mutant guard', () => {
    const phases = join(dir, 'phases.log');
    const { code, out } = runProbeIO([
      '--file',
      subject,
      // This applies, but only adds indentation; the non-whitespace content
      // is identical and the subject's behavior is unchanged.
      '--mutate',
      's/^/ /',
      '--test',
      `printf '%s\\n' "$PAPERCUSP_MUTATION_PHASE" >> "${phases}"; grep -q beta {}`,
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/mutation diff/i);
    expect(out).toMatch(/ONLY WHITESPACE/i);
    // The baseline establishes the harness, and copy-baseline proves the
    // relocation is sound; the semantic-no-op refusal must happen before the
    // mutant guard is launched (mutation is applied only after both).
    expect(readFileSync(phases, 'utf8')).toBe('baseline\ncopy-baseline\n');
    expect(read()).toBe(ORIGINAL);
  });

  it('explains the PERL-metacharacter cause when an unescaped source mutation matches nothing', () => {
    // EI-19460105590596381. --mutate is applied with `perl -pi -e`, so on the PATTERN side
    // ( ) { } are regex metacharacters. That bites hardest on this script's normal use —
    // mutating source code — because the natural mutation of a conditional reads as correct
    // and matches NOTHING: `if (x > 0) {` parses as a capture group plus a quantifier, so it
    // searches for `if x > 0 ` and misses. The refusal was already correct (exit 2, never a
    // false weakness verdict), but it named only the symptom, leaving the reader to guess at
    // their own pattern rather than at their metacharacters.
    writeFileSync(subject, 'if (x > 0) {\n');
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's|if (x > 0) {|if (false) {|',
      '--test',
      'test -s {}',
    ]);
    expect(code).toBe(2);
    // The cause, not just "changed NOTHING".
    expect(out).toMatch(/PERL/i);
    // And the fix, spelled out — the escaped pattern form.
    expect(out).toContain('\\(x > 0\\)');
    expect(read()).toBe('if (x > 0) {\n');
  });

  it('the ESCAPED form of that same mutation does apply — so the guidance is correct, not folklore', () => {
    // Calibration for the test above: without this, "unescaped matches nothing" could equally
    // mean the probe is broken for this subject entirely, and the advice would be untested.
    writeFileSync(subject, 'if (x > 0) {\n');
    // The guard asserts the ORIGINAL line is present. If the mutation applied, that line is
    // gone, the guard FAILS on the mutant, and the probe reports CAUGHT (exit 0). Reaching
    // exit 0 here is therefore proof the escaped pattern matched — the exact thing the
    // unescaped form above failed to do.
    const code = runProbe([
      '--file',
      subject,
      '--mutate',
      's|if \\(x > 0\\) \\{|if (false) {|',
      '--test',
      'grep -q "^if (x > 0) {$" {}',
    ]);
    expect(code).toBe(0);
    expect(read()).toBe('if (x > 0) {\n');
  });

  it('refuses a --test with no {} placeholder, so the probe cannot silently target the wrong file', () => {
    const code = runProbe(['--file', subject, '--mutate', 's/beta/BETA/', '--test', 'true']);
    expect(code).toBe(2);
  });

  /**
   * EI-21882388979504012 — a test runner that cannot COLLECT its subject exits
   * nonzero for MISUSE (vitest's "No test files found, exiting with code 1" is
   * the reproduced case: copy-out mode moves the mutant under a scratch dir a
   * project's include globs cannot reach), and that nonzero was previously
   * indistinguishable by exit code alone from a genuine assertion failure —
   * the probe scored it "MUTANT CAUGHT" while nothing was ever tested.
   */
  it('reports a RUNNER-MISUSE guard exit (e.g. "no test files found") as harness-error, never as a caught mutant', () => {
    // Baseline (PAPERCUSP_MUTATION_PHASE=baseline) runs against the ORIGINAL
    // file path directly (not {}), so the genuine grep succeeds there. Only
    // the mutant phase hits the simulated runner-misuse branch — this is the
    // exact shape of a runner that can collect the tracked path but not the
    // scratch-dir copy.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then echo "No test files found, exiting with code 1"; exit 1; fi; grep -q "^beta$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/RUNNER-MISUSE/i);
    expect(out).toMatch(/No test files found/);
    expect(out).toMatch(/verdict=harness-error/);
    // The MUTATION_PROBE_RESULT line joins multi-token hits with commas
    // (spaces would break its key=value parsing).
    expect(out).toMatch(/runner_misuse=No,test,files,found/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('calibration: a GENUINE mutant-phase assertion failure (no misuse marker in the output) is still scored CAUGHT', () => {
    // Same shape as the misuse test above but the mutant branch fails via a
    // real assertion, not a misuse string — proving the new detector does not
    // over-trigger and swallow a legitimate catch.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then grep -q "^beta$" {}; else true; fi',
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/MUTANT CAUGHT/);
    expect(out).not.toMatch(/RUNNER-MISUSE/i);
  });
});

/**
 * EI-21884666893062196 (2026-08-30) — copy-out mode relocates ONLY the named
 * `--file`, never its sibling directory. A subject that imports a relative
 * sibling (the `./lib/...` house pattern under scripts/*.mjs) is broken by
 * that relocation alone: it dies on ERR_MODULE_NOT_FOUND before the guard
 * runs a single assertion. That failure is exit 1 — the SAME code the mutant
 * phase reads as "caught" — so a broken relocation used to silently report
 * "the guard is falsifiable" without the guard ever having run. These pin the
 * fix from both sides: the refusal fires (before any mutation is applied),
 * and a relocation-safe subject (one whose --test command carries its own
 * sibling along, exactly as the incident's caller-side workaround did) still
 * reaches a genuine verdict.
 */
describe('mutation-probe.sh — copy-out relocation is proven sound before scoring the mutant', () => {
  it('REFUSES (exit 2, harness-error) when the guard fails against an UNMUTATED relocated copy — never a false MUTANT CAUGHT', () => {
    const relocSubject = join(dir, 'reloc-subject.mjs');
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'helper.mjs'), 'export const helperValue = 1;\n');
    const ORIGINAL_RELOC = "import { helperValue } from './lib/helper.mjs';\nexport const value = helperValue;\n";
    writeFileSync(relocSubject, ORIGINAL_RELOC);

    const { code, out } = runProbeIO([
      '--file',
      relocSubject,
      // Any non-no-op mutation: copy-baseline runs BEFORE this is applied, so
      // the exact mutation text is irrelevant to what this test proves — the
      // refusal must fire before the mutant guard, let alone the mutation
      // itself, is ever reached.
      '--mutate',
      's/helperValue;/helperValue; \\/\\/ mutated/',
      '--test',
      // The guard REPORTS the module error rather than swallowing it. Until
      // 2026-08-31 this read `.catch(()=>process.exit(1))`, which prints
      // nothing (measured: 0 bytes, exit 1) — so the ERR_MODULE_NOT_FOUND
      // assertion below was matching the probe SCRIPT's own refusal prose,
      // where the literal appeared twice, while its comment claimed the text
      // came from Node. That made it a wording pin dressed as evidence: it
      // broke the moment the refusal was reworded, and would have passed on a
      // probe that captured nothing at all.
      'node -e "import(process.argv[1]).then(()=>process.exit(0)).catch((e)=>{console.error(e.code||e.message);process.exit(1)})" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/COPY-BASELINE FAILED/i);
    expect(out).toMatch(/RELOCATION/i);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).toMatch(/copy_baseline_exit=1/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    // The mutant guard never even ran — the subject is untouched, and this
    // ERR_MODULE_NOT_FOUND is Node's, echoed by run_guard's `cat "$output"`.
    expect(out).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    expect(readFileSync(relocSubject, 'utf8')).toBe(ORIGINAL_RELOC);
  });

  it('still reaches a genuine CAUGHT verdict when --test carries the sibling along (the sanctioned workaround)', () => {
    // Calibration for the refusal above: a --test command that makes the
    // relocated copy self-sufficient (mirroring the incident's caller-side
    // symlink workaround) must sail through copy-baseline and reach a real
    // mutant verdict — proving the new check does not merely refuse
    // everything, only genuinely-broken relocations.
    const relocSubject = join(dir, 'reloc-subject-ok.mjs');
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'helper.mjs'), 'export const helperValue = 1;\n');
    writeFileSync(relocSubject, "import { helperValue } from './lib/helper.mjs';\nexport const value = helperValue;\n");
    const wrapper = join(dir, 'import-with-sidecar.mjs');
    writeFileSync(
      wrapper,
      [
        "import { existsSync, symlinkSync } from 'node:fs';",
        "import { dirname, join } from 'node:path';",
        'const target = process.argv[2];',
        "const sidecar = join(dirname(target), 'lib');",
        `if (!existsSync(sidecar)) symlinkSync(${JSON.stringify(join(dir, 'lib'))}, sidecar, 'dir');`,
        'const mod = await import(target);',
        'process.exit(mod.value === 1 ? 0 : 1);',
      ].join('\n'),
    );

    const code = runProbe([
      '--file',
      relocSubject,
      '--mutate',
      's/helperValue;/helperValue + 1;/',
      '--test',
      `node ${JSON.stringify(wrapper)} {}`,
    ]);
    // Baseline (value===1, exit 0) and copy-baseline (same, via the sidecar
    // symlink) both pass; the mutation then makes value===2, the guard's
    // `mod.value === 1` check fails => exit 1 => the mutant is CAUGHT => the
    // probe itself exits 0.
    expect(code).toBe(0);
  });
});

/**
 * EI-21986396214443568 — copy-out must relocate into a MIRROR of the subject's
 * worktree, not into a flat scratch dir.
 *
 * The flat relocation broke TWO couplings and the refusal text only ever named
 * one. Sibling imports (`./lib/foo.mjs`) were named; LOCATIONAL IDENTITY — a
 * subject that derives the repo root from its own path, the shape
 * scripts/affected-tests.mjs uses — was not. Measured 2026-08-31: doing exactly
 * what the refusal prescribed (carry the sibling directory alongside the copy)
 * left an UNMUTATED copy failing 13 of 23 tests, i.e. a large failure count
 * that reads as a spectacularly falsifiable guard. That is a false verdict in
 * the dangerous direction, produced by following the tool's own advice.
 *
 * The fixture below couples to its location BOTH ways at once, so neither half
 * of the repair can pass this on its own:
 *   - it imports `./lib/sib.mjs` (siblings), and
 *   - it reads a repo-root marker via `resolve(__dirname, '../..')` (location).
 */
function makeLocationalRepo(): { repo: string; subject: string } {
  const repo = join(dir, 'locational-repo');
  mkdirSync(join(repo, 'pkg', 'tools', 'lib'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(repo, ['config', 'user.name', 'mutation-probe-test']);
  writeFileSync(join(repo, 'ROOT-MARKER.txt'), 'ROOT-MARKER\n');
  writeFileSync(join(repo, 'pkg', 'tools', 'lib', 'sib.mjs'), "export const SIB = 'SIB';\n");
  const subject = join(repo, 'pkg', 'tools', 'subject.mjs');
  writeFileSync(
    subject,
    [
      "import { readFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "import { dirname, resolve } from 'node:path';",
      "import { SIB } from './lib/sib.mjs';",
      '',
      'const here = dirname(fileURLToPath(import.meta.url));',
      "const marker = readFileSync(resolve(here, '../..', 'ROOT-MARKER.txt'), 'utf8').trim();",
      "const VERDICT = 'OK';",
      'console.log(`${VERDICT} sib=${SIB} root=${marker}`);',
      '',
    ].join('\n'),
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'locational subject']);
  return { repo, subject };
}

describe('mutation-probe.sh — copy-out relocates into a mirror of the subject worktree', () => {
  it('reaches a genuine CAUGHT verdict for a subject coupled to BOTH its siblings and its repo-root location', () => {
    const { subject } = makeLocationalRepo();
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      "s/const VERDICT = 'OK'/const VERDICT = 'MUTATED'/",
      '--test',
      "node {} | grep -qx 'OK sib=SIB root=ROOT-MARKER'",
    ]);
    // Both relocation-sensitive phases had to survive before a verdict was
    // reachable at all: the in-tree baseline AND the unmutated relocated copy.
    // A flat relocation dies in copy-baseline (ERR_MODULE_NOT_FOUND) and this
    // is exit 2 / harness-error instead.
    expect(out).toMatch(/relocating into a repo mirror/);
    expect(out).not.toMatch(/COPY-BASELINE FAILED/);
    expect(out).toMatch(/verdict=caught/);
    expect(code).toBe(0);
  });

  it('mirrors the worktree WITHOUT .git, so a git-consulting subject fails loudly instead of reading a wholly dirty tree', () => {
    // A symlinked .git would make every tracked path look to Git like a
    // symlink where a blob belongs — the mirror would report the entire repo
    // as modified. That is a silent wrong answer, which is exactly the class
    // this whole relocation fix exists to remove, so .git is left out and the
    // copy-baseline gate turns it into a refusal.
    const { repo } = makeLocationalRepo();
    const gitSubject = join(repo, 'pkg', 'tools', 'git-subject.sh');
    writeFileSync(
      gitSubject,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        // Fails outright outside a worktree — the point is that the mirror
        // makes this LOUD, not that it answers wrongly.
        'root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"',
        '[ -n "$root" ] || exit 1',
        'echo MARK',
        '',
      ].join('\n'),
    );
    const { code, out } = runProbeIO([
      '--file',
      gitSubject,
      '--mutate',
      's/echo MARK/echo MUTATED/',
      '--test',
      'bash {} >/dev/null 2>&1',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/COPY-BASELINE FAILED/);
    // The refusal must now say WHY, naming the deliberate .git exclusion —
    // the old text only ever named sibling imports and prescribed a repair
    // that cannot fix this case.
    expect(out).toMatch(/\.git.*not mirrored|not mirrored.*\.git/is);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
  });

  it('still relocates FLAT (and still refuses a broken relocation) when the subject is not inside a worktree', () => {
    // Calibration in the other direction: the mirror is keyed off
    // `git rev-parse --show-toplevel`, so a subject outside any worktree keeps
    // the original flat behaviour rather than silently mirroring something
    // else. `dir` is a bare mkdtemp, deliberately not a repo.
    const orphan = join(dir, 'orphan-subject.mjs');
    mkdirSync(join(dir, 'orphan-lib'));
    writeFileSync(join(dir, 'orphan-lib', 'helper.mjs'), 'export const v = 1;\n');
    writeFileSync(orphan, "import { v } from './orphan-lib/helper.mjs';\nexport const value = v;\n");
    const { code, out } = runProbeIO([
      '--file',
      orphan,
      '--mutate',
      's/export const value = v;/export const value = v + 1;/',
      '--test',
      'node -e "import(process.argv[1]).then(()=>process.exit(0)).catch(()=>process.exit(1))" {}',
    ]);
    expect(out).not.toMatch(/relocating into a repo mirror/);
    expect(out).toMatch(/COPY-BASELINE FAILED/);
    expect(code).toBe(2);
  });
});

describe('mutation-probe.sh — historical source mode', () => {
  it('uses an explicit commit, requires controls/calibration, and keeps both snapshots frozen', () => {
    const history = makeHistoricalRepo();
    const savedSubject = JSON.stringify(history.file);
    // The command deliberately rewrites the working file between phases and
    // restores it. A live-file implementation fails the current assertion;
    // only a frozen current snapshot passes it.
    const guard =
      `printf 'stable-control\\nlegacy-path\\n' > ${savedSubject}; ` +
      `grep -q '^NEW_GUARD$' {}; rc=$?; printf 'stable-control\\nNEW_GUARD\\ncurrent-edit\\n' > ${savedSubject}; exit "$rc"`;
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-commit',
      history.oldSha,
      '--must-be-absent',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--test',
      guard,
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/mode=historical/);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);
    expect(out).toMatch(/calibration_current=0 calibration_historical=0/);
    expect(out).toMatch(/absence_control=NEW_GUARD/);
    expect(readFileSync(history.file, 'utf8')).toBe('stable-control\nNEW_GUARD\ncurrent-edit\n');
  });

  it('finds the newest reachable commit whose source lacks --against-last-without', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--test',
      'grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/mode=historical/);
    expect(out).toMatch(/absence_control=NEW_GUARD/);
    expect(out).toMatch(/positive_controls=1/);
    expect(out).toMatch(new RegExp(`against_commit=${history.oldSha}`));
  });

  /**
   * EI-23362664002917898 — historical mode relocated every snapshot to an
   * EXTENSIONLESS path (`$SCRATCH/snapshot-run-N`). tsx and node decide whether
   * to STRIP TYPES by extension, so a TypeScript subject was handed to the
   * plain-JS loader and died at PARSE on BOTH legs; historical mode can only
   * score that as verdict=harness-error, so the probe could never reach a
   * verdict for ANY TypeScript subject. Copy-out mode was always sound (it
   * relocates to the repo-relative path, or the basename when the subject is
   * not in a worktree — both carry the extension), so this guard is specific to
   * historical mode's run_snapshot_command.
   */
  it('preserves the subject file extension on every relocated historical snapshot path', () => {
    const history = makeHistoricalTsRepo();
    const seen = join(dir, 'relocated-paths.txt');
    const record = `printf '%s\\n' {} >> ${JSON.stringify(seen)}; `;
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      `${record}grep -q 'stable-control' {}`,
      '--test',
      `${record}grep -q 'NEW_GUARD' {}`,
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/mode=historical/);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);

    // Both legs of calibration + both legs of the guard each get their own
    // relocated copy, so the probe must have handed out at least four paths.
    const paths = readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean);
    expect(paths.length).toBeGreaterThanOrEqual(4);
    // The discriminator: pre-fix every one of these was a bare
    // `snapshot-run-N` with no extension at all.
    expect(paths.filter((p) => p.endsWith('.ts'))).toEqual(paths);
  });

  /**
   * EI-21882388979504012 — the same runner-MISUSE shape is exposed on the
   * historical guard run, which also executes against a frozen SNAPSHOT path
   * a project-relative runner cannot always collect. PAPERCUSP_MUTATION_PHASE
   * is set to "historical" for exactly that one run (run_snapshot_command
   * historical ...), so this keys off the same marker the script observes.
   */
  it('reports a RUNNER-MISUSE historical guard exit as harness-error, never as HISTORICAL SOURCE CAUGHT', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--test',
      'if [ "$PAPERCUSP_MUTATION_PHASE" = historical ]; then echo "No test files found, exiting with code 1"; exit 1; fi; grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/mode=historical/);
    expect(out).toMatch(/RUNNER-MISUSE/i);
    expect(out).toMatch(/No test files found/);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).toMatch(/runner_misuse=No,test,files,found/);
    expect(out).not.toMatch(/HISTORICAL SOURCE CAUGHT/);
  });

  it('refuses historical mode without a positive control or calibration before running the guard', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-commit',
      history.oldSha,
      '--must-be-absent',
      'NEW_GUARD',
      '--test',
      'printf ran > "' + join(dir, 'historical-ran') + '"; grep -q NEW_GUARD {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/requires at least one --positive-control/i);
    expect(readFileSync(history.file, 'utf8')).toContain('NEW_GUARD');
  });

  /**
   * EI-21902332137059032 — historical mode never ran --test against the
   * literal in-tree --file path, so it had no way to notice that RELOCATING a
   * snapshot (which every phase does) can itself change a subject's
   * behaviour, independent of the fixed-vs-broken content being compared.
   * --subject-must-behave is the opt-in fix: run a smoke command once
   * in-tree, once relocated, and refuse if they disagree. This fixture models
   * a subject that resolves a SIBLING file relative to its own directory (the
   * $0-relative-resolution class named in the bug report) — present next to
   * the real in-tree file, absent next to any relocated copy under scratch.
   */
  it('--subject-must-behave catches a subject whose behaviour depends on a sibling relative to its own path', () => {
    const history = makeHistoricalRepo();
    writeFileSync(join(history.repo, 'sibling-marker'), 'present');
    const subjectMustBehave = 'd=$(dirname "{}"); [ -f "$d/sibling-marker" ] && exit 1 || exit 0';
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--subject-must-behave',
      subjectMustBehave,
      '--test',
      'grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/SUBJECT-MUST-BEHAVE MISMATCH/);
    expect(out).toMatch(/subject_must_behave=mismatch/);
    expect(out).toMatch(/verdict=harness-error/);
    // Never reaches (and never falsely reports) a historical-source verdict.
    expect(out).not.toMatch(/HISTORICAL SOURCE/);
  });

  it('--subject-must-behave is a no-op (zero behaviour change) when relocation does not change the subject', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--subject-must-behave',
      'grep -q "^stable-control$" {}',
      '--test',
      'grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/subject-must-behave: relocation-consistent/);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);
  });

  it('rejects --subject-must-behave outside historical mode', () => {
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      'grep -q "^beta$" {}',
      '--subject-must-behave',
      'true {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/--subject-must-behave only applies to historical mode/);
  });

  it('rejects --subject-must-behave without a {} placeholder', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--subject-must-behave',
      'true',
      '--test',
      'grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/--subject-must-behave must contain \{\}/);
  });
});

/**
 * `--in-tree` REFUSES to run until the caller says what it did about the git-sync sweep race
 * (`--sweep-lock-held` or `--accept-sweep-race`). Every in-tree probe below passes
 * `--accept-sweep-race`, which is the honest answer HERE and not a way around the gate: the
 * subject is a fresh file under `mkdtempSync(tmpdir())`, so it is not in the swept tree at all
 * and there is no window for a sweep tick to commit. The refusal itself is pinned separately,
 * in apps/operator/lib/mutation-probe-sweep-gate.test.ts — do not weaken it here.
 */
const ACCEPT_SWEEP = '--accept-sweep-race';

describe('mutation-probe.sh — in-tree mode restores the tracked file', () => {
  it('restores after a normal exit', () => {
    // Assert the exit code, not just the restore: without this the probe REFUSING outright
    // (exit 2, tracked file never touched) also leaves the file byte-identical, so the restore
    // assertion alone passes vacuously. That is exactly how the missing sweep-ack went unseen.
    expect(
      runProbe([
        '--in-tree',
        ACCEPT_SWEEP,
        '--file',
        subject,
        '--mutate',
        's/beta/BETA/',
        '--test',
        'grep -q "^beta$" {}',
      ]),
    ).toBe(0);
    expect(read()).toBe(ORIGINAL);
  });

  /**
   * EI-19455888914364007 — the `{}` requirement is MODE-SPECIFIC, and this pins the asymmetry
   * from BOTH sides with the SAME --test command, so neither half can be "tidied" away:
   *
   *  · in-tree  → ACCEPTED. The tracked file itself is the mutant, so the substitution is a
   *    no-op. This is the normal shape here, because in-tree mode exists precisely for subjects
   *    a suite imports by a FIXED path — such a test has nowhere to put a {} at all. Requiring
   *    it anyway forced callers to thread a dummy `PROBE_FILE={}` env var that nothing reads.
   *  · copy-out → still REFUSED (exit 2). There {} is the only thing pointing the test at the
   *    mutated copy; without it the test runs against the untouched original, every mutant
   *    "survives", and the probe reports a sound guard as weak.
   */
  it('accepts a --test with no {} placeholder, which copy-out mode must still refuse', () => {
    const testCmd = `grep -q "^beta$" ${subject}`;

    // in-tree: the mutation lands in the tracked file the command names, so the guard fails on
    // the mutant => CAUGHT => exit 0. And the file is still restored afterwards.
    expect(
      runProbe(['--in-tree', ACCEPT_SWEEP, '--file', subject, '--mutate', 's/beta/BETA/', '--test', testCmd]),
    ).toBe(0);
    expect(read()).toBe(ORIGINAL);

    // Non-vacuousness: the very same command is still rejected without --in-tree, so this is a
    // mode-specific relaxation and not a removed check.
    expect(runProbe(['--file', subject, '--mutate', 's/beta/BETA/', '--test', testCmd])).toBe(2);
    expect(read()).toBe(ORIGINAL);
  });

  it('does NOT run the extra copy-baseline phase — --in-tree never relocates the subject, so there is nothing to prove sound', () => {
    // EI-21884666893062196's fix is copy-out-specific: --in-tree mutates the
    // TRACKED file in place, so $TARGET is $FILE and a copy-baseline run
    // would just repeat the baseline verbatim. Pin the asymmetry so it can't
    // regress into an accidental extra guard invocation here too.
    const markerLog = join(dir, 'marker.log');
    const code = runProbe([
      '--in-tree',
      ACCEPT_SWEEP,
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      // The guard must FAIL once "beta" is gone (mutant phase) to be scored
      // CAUGHT — asserting the ORIGINAL text is present, not the mutated one.
      `printf '%s\\n' "$PAPERCUSP_MUTATION_PHASE" >> "${markerLog}"; grep -q "^beta$" {}`,
    ]);
    expect(code).toBe(0);
    expect(readFileSync(markerLog, 'utf8').trim().split('\n').sort()).toEqual(['baseline', 'mutant']);
    expect(read()).toBe(ORIGINAL);
  });

  it('keeps the post-mutation dirty window free of signal-unsafe command substitutions', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const mutationAt = source.indexOf('perl -pi -e "$MUTATE" "$TARGET"');
    const supervisedGuardAt = source.indexOf('run_guard mutant "mutant guard"', mutationAt);
    expect(mutationAt).toBeGreaterThan(-1);
    expect(supervisedGuardAt).toBeGreaterThan(mutationAt);

    // EI-20320511174710484 / WI-38375: SIGTERM landed inside a nested
    // post-mutation hash substitution and Bash reported an unmatched closing
    // parenthesis while entering the trap. finish() never ran, leaving BETA in
    // the subject. The dirty interval may use parameter expansion and builtins,
    // but it must contain neither modern nor legacy command substitution.
    const dirtyWindow = source.slice(mutationAt, supervisedGuardAt);
    expect(dirtyWindow).not.toContain('$(');
    expect(dirtyWindow).not.toContain(String.fromCharCode(96));
  });

  it('restores PROMPTLY on SIGTERM mid-probe — not merely eventually', async () => {
    // Make the cleanup-order hardening deterministic. finish() reaps
    // descendants by walking ps --ppid; on the shared host (~10k processes)
    // one scan can be slow enough that cleanup-before-restore consumes the
    // whole 5s integrity budget. Delay the FIRST scan past that budget. A
    // correct trap restores before invoking ps, so the delay affects only child
    // cleanup, never the tracked-file invariant. The separate source guard
    // above pins the observed command-substitution parse-abort root cause.
    const slowBin = join(dir, 'slow-bin');
    const slowPs = join(slowBin, 'ps');
    const slowPsMarker = join(dir, 'slow-ps-ran');
    const realPs = spawnSync('sh', ['-c', 'command -v ps'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    }).stdout.trim();
    expect(realPs).not.toBe('');
    mkdirSync(slowBin);
    writeFileSync(
      slowPs,
      `#!/usr/bin/env bash
if [ ! -e "$MUTATION_PROBE_SLOW_PS_MARKER" ]; then
  : > "$MUTATION_PROBE_SLOW_PS_MARKER"
  sleep 6
fi
exec "$MUTATION_PROBE_REAL_PS" "$@"
`,
      { mode: 0o755 },
    );

    const child = spawn(
      'bash',
      [
        SCRIPT,
        '--in-tree',
        ACCEPT_SWEEP,
        '--file',
        subject,
        '--mutate',
        's/beta/BETA/',
        '--test',
        'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then sleep 20; fi; test -f {}',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${slowBin}:${process.env.PATH ?? ''}`,
          MUTATION_PROBE_SLOW_PS_MARKER: slowPsMarker,
          MUTATION_PROBE_REAL_PS: realPs,
        },
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    try {
      // Wait until the probe has actually applied the mutant, so we are
      // measuring the restore path and not a race against startup. Without
      // this the test could pass having never mutated anything at all.
      const deadline = Date.now() + 15_000;
      while (read() === ORIGINAL && Date.now() < deadline) await sleep(100);
      expect(read()).not.toBe(ORIGINAL); // the tree really is dirty right now

      expect(child.kill('SIGTERM')).toBe(true);

      // 5s is deliberately far below the child's 20s runtime: the pre-fix
      // foreground form restored only when the child exited (~20s), so this
      // bound FAILS on a revert while passing comfortably on the fix.
      const restoreBy = Date.now() + 5_000;
      while (read() !== ORIGINAL && Date.now() < restoreBy) await sleep(50);
      expect(read(), `probe output before restore deadline:\n${output}`).toBe(ORIGINAL);

      // Signal delivery is part of the evidence: wait through the injected ps
      // delay and prove the trap completed normally rather than passing only
      // because an unrelated actor happened to rewrite the subject.
      const outcome = await Promise.race([exited, sleep(15_000).then(() => null)]);
      expect(outcome, `probe did not exit after SIGTERM:\n${output}`).not.toBeNull();
      expect(outcome?.code === 143 || outcome?.signal === 'SIGTERM').toBe(true);
      expect(output).toMatch(/tree integrity: VERIFIED/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 40_000);
});

/**
 * Recurrence guards for EI-20566003853444873 — the 2026-08-15 incident, in which
 * a probe of a wine-prefix reaper EXECUTED a mutant whose delete loop had been
 * widened (via silent perl replacement-half interpolation of an undefined
 * $parent) to `for d in /*`, destroying ~370GB. Two independent defenses are
 * pinned here, each from both sides (refusal fires; the sanctioned path works):
 *
 *   1. The DESTRUCTIVE-SUBJECT GATE — a subject file or --test command containing
 *      destructive primitives is REFUSED before anything executes in mutation
 *      modes, unless the caller picks --fake-destructive (PATH shims, nothing
 *      deletes) or --i-know-this-deletes --sandbox-root <dir> (bwrap, / read-only).
 *      Historical mode executes an unmutated source, so it warns instead of
 *      refusing; otherwise a real before-fix comparison is impossible for a
 *      subject that cleans up its own scratch file.
 *   2. The STRICT PRE-FLIGHT — a --mutate whose replacement references an
 *      undeclared perl variable is a hard refusal, never a silent empty.
 */
describe('mutation-probe.sh — destructive subjects are never executed unprotected', () => {
  const DESTRUCTIVE_SUBJECT = '#!/usr/bin/env bash\nrm -rf "$1"\necho cleaned\n';

  it('REFUSES (exit 2) an rm-containing subject before ANY execution, naming both sanctioned paths', () => {
    const ranMarker = join(dir, 'guard-ran');
    writeFileSync(subject, DESTRUCTIVE_SUBJECT);
    const { code, out } = runProbeIO([
      '--file', subject,
      '--mutate', 's/cleaned/CLEANED/',
      '--test', `: > ${ranMarker}; bash {} /nonexistent-victim`,
    ]);
    expect(code).toBe(2);
    // The refusal names both ways forward — the message is the interface.
    expect(out).toMatch(/--fake-destructive/);
    expect(out).toMatch(/--i-know-this-deletes/);
    expect(out).toMatch(/--sandbox-root/);
    // NOTHING executed: neither the baseline nor the mutant guard ever ran.
    expect(spawnSync('test', ['-e', ranMarker], { timeout: 5_000, killSignal: 'SIGKILL' }).status).not.toBe(0);
    expect(read()).toBe(DESTRUCTIVE_SUBJECT);
  });

  it('REFUSES a destructive --test command even when the subject itself is clean', () => {
    const { code, out } = runProbeIO([
      '--file', subject, // alpha/beta/gamma — clean
      '--mutate', 's/beta/BETA/',
      '--test', `grep -q "^beta$" {} && rm -rf ${join(dir, 'x')}`,
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/--fake-destructive/);
  });

  it('warns but allows an unmutated historical source containing rm', () => {
    const repo = join(dir, 'historical-destructive-repo');
    mkdirSync(repo);
    const file = join(repo, 'subject.sh');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
    git(repo, ['config', 'user.name', 'mutation-probe-test']);
    writeFileSync(file, '#!/usr/bin/env bash\nrm -f "$1"\necho stable-control\n');
    git(repo, ['add', 'subject.sh']);
    git(repo, ['commit', '-qm', 'historical source']);
    writeFileSync(
      file,
      '#!/usr/bin/env bash\nrm -f "$1"\necho stable-control\necho NEW_GUARD\n',
    );

    const { code, out } = runProbeIO([
      '--file', file,
      '--against-last-without', 'NEW_GUARD',
      '--positive-control', 'stable-control',
      '--calibration', 'bash -n {}',
      '--test', 'grep -q "echo NEW_GUARD" {}',
    ]);

    expect(code).toBe(0);
    expect(out).toMatch(/historical mode: destructive primitives detected/i);
    expect(out).toMatch(/no mutant is produced/i);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);
    expect(out).toMatch(/destructive_primitives=rm/);
  });

  it('--fake-destructive runs the probe with shimmed deleters: the mutant is caught and the victim SURVIVES', () => {
    writeFileSync(subject, DESTRUCTIVE_SUBJECT);
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'precious\n');
    // The guard asserts BOTH halves of the tier-0 contract: the subject's
    // output is intact AND the victim it "deleted" still exists (the shim
    // logged instead of deleting). On the mutant, the output changes => the
    // guard fails => CAUGHT (exit 0).
    const { code, out } = runProbeIO([
      '--fake-destructive',
      '--file', subject,
      '--mutate', 's/cleaned/CLEANED/',
      '--test', `[ "$(bash {} "${victim}" | tail -1)" = cleaned ] && [ -e "${victim}" ]`,
    ]);
    expect(out).toMatch(/fake-destructive: shims installed/);
    expect(code).toBe(0);
    // The real rm never ran, in either phase.
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
  });

  it('--i-know-this-deletes WITHOUT --sandbox-root is refused — acknowledgement alone saves no bytes', () => {
    writeFileSync(subject, DESTRUCTIVE_SUBJECT);
    const { code, out } = runProbeIO([
      '--i-know-this-deletes',
      '--file', subject,
      '--mutate', 's/cleaned/CLEANED/',
      '--test', 'bash {} /nonexistent-victim',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/--sandbox-root/);
  });

  it('refuses to COMBINE --fake-destructive with --i-know-this-deletes', () => {
    writeFileSync(subject, DESTRUCTIVE_SUBJECT);
    const sb = join(dir, 'sb');
    mkdirSync(sb);
    const { code, out } = runProbeIO([
      '--fake-destructive', '--i-know-this-deletes', '--sandbox-root', sb,
      '--file', subject,
      '--mutate', 's/cleaned/CLEANED/',
      '--test', 'bash {} /nonexistent-victim',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/pick ONE/i);
  });

  const bwrapWorks =
    spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', 'true'], {
      timeout: 10_000,
    }).status === 0;

  it.skipIf(!bwrapWorks)(
    '--i-know-this-deletes --sandbox-root really walls the filesystem: a delete OUTSIDE the root fails',
    () => {
      writeFileSync(subject, '#!/usr/bin/env bash\nrm -f "$1" 2>/dev/null\necho ok\n');
      const sb = join(dir, 'sb');
      mkdirSync(sb);
      const outside = join(dir, 'outside-the-sandbox');
      writeFileSync(outside, 'still here\n');
      const { code, out } = runProbeIO([
        '--i-know-this-deletes', '--sandbox-root', sb,
        '--file', subject,
        '--mutate', 's/ok/OK/',
        '--test', `[ "$(bash {} "${outside}" | tail -1)" = ok ]`,
      ]);
      expect(out).toMatch(/sandbox: guard runs will execute under bwrap/);
      expect(code, out).toBe(0); // the probe itself still works end-to-end
      // The subject really ran `rm -f` on this path in BOTH phases — and the
      // read-only bind meant it could not remove it. Without the sandbox this
      // assertion is the one that fails.
      expect(readFileSync(outside, 'utf8')).toBe('still here\n');
    },
  );

  it('a replacement referencing an UNDECLARED perl variable is a hard refusal, never a silent empty', () => {
    // The incident's exact trap shape: match side escaped (shell literal),
    // replacement side bare => an undefined perl var => silently "" pre-fix.
    const { code, out } = runProbeIO([
      '--file', subject,
      '--mutate', 's/beta/$undefined_thing/',
      '--test', 'grep -q "^beta$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/use strict/i);
    expect(out).toMatch(/INTERPOLATES/);
    expect(read()).toBe(ORIGINAL);
  });

  it('calibration: an ESCAPED literal \\$name in the replacement still works — the strict gate blocks only the trap', () => {
    const code = runProbe([
      '--file', subject,
      '--mutate', 's/beta/\\$literal/',
      '--test', 'grep -q "^beta$" {}',
    ]);
    // The mutation applied (beta -> $literal), the guard failed on the mutant,
    // the probe reports CAUGHT. Reaching exit 0 proves strict did not refuse it.
    expect(code).toBe(0);
    expect(read()).toBe(ORIGINAL);
  });
});

/**
 * Recurrence guard for EI-20451290782193791 — a baseline that ran ZERO tests
 * must never be scored, because scoring it produces a FALSE `MUTANT SURVIVED`.
 *
 * The trap: the probe infers CAUGHT vs SURVIVED from the guard's EXIT CODE
 * alone. That inference is sound only while a passing exit means assertions
 * actually ran. A test filter that selects nothing breaks it — vitest reports
 * zero-selection as a PASS (`Tests  2 skipped (2)`, exit 0), so the baseline
 * looks healthy, the mutant run also exits 0, and the probe declares SURVIVED
 * about a mutation no assertion ever examined. Wrong in the expensive
 * direction: it says a guard you just wrote is worthless.
 *
 * The discriminator is the runner's own count summary, NOT the exit code: a
 * healthy baseline must report at least one PASSED test. These cases are a
 * CONTROL SET so that none can pass on dead code — the first two differ only
 * in the word "passed", so a detector that merely refused every exit-0
 * baseline would fail the second, and one that never fired would fail the
 * first. The third pins the deliberate BASELINE-ONLY scoping: a fully caught
 * mutant also prints no "passed" (`Tests  2 failed (2)`, measured), so reusing
 * this detector on the mutant log would false-flag every real catch.
 */
describe('mutation-probe.sh — a baseline that ran zero tests is never scored', () => {
  /** Write a guard whose output/exit may differ by phase; returns the --test command. */
  function phaseGuard(body: string): string {
    const guard = join(dir, 'guard.sh');
    writeFileSync(guard, `#!/usr/bin/env bash\n${body}\n`);
    return `bash ${guard} {}`;
  }

  it('REFUSES (exit 2, harness-error) when the baseline summary reports no PASSED test', () => {
    // The measured shape of a vitest run whose -t filter matched nothing.
    // Pre-fix this reached `VERDICT: MUTANT SURVIVED` and exit 1.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      phaseGuard(`printf '  Tests  2 skipped (2)\\n'; exit 0`),
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/BASELINE RAN ZERO TESTS/);
    expect(out).toMatch(/verdict=harness-error/);
    // The refusal quotes the runner's own summary, so a reader sees WHY rather
    // than just being told the harness is broken.
    expect(out).toMatch(/zero_selection=Tests__2_skipped_\(2\)/);
    expect(out).not.toMatch(/MUTANT SURVIVED/);
    expect(read()).toBe(ORIGINAL);
  });

  it('CALIBRATION: the same exit-0 baseline still reaches a genuine SURVIVED once the summary says "passed"', () => {
    // Differs from the case above by ONE WORD. If the detector were "refuse any
    // baseline that exits 0", this would refuse too — and the probe could no
    // longer report a real weakness at all, which is its whole job.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      phaseGuard(`printf '  Tests  1 passed | 1 skipped (2)\\n'; exit 0`),
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/MUTANT SURVIVED/);
    expect(out).not.toMatch(/ZERO TESTS/);
    expect(out).not.toMatch(/verdict=harness-error/);
    expect(read()).toBe(ORIGINAL);
  });

  it('is BASELINE-ONLY: a caught mutant printing "Tests 2 failed (2)" is still CAUGHT, never a harness error', () => {
    // A fully-caught mutant's summary also contains no "passed" (measured).
    // Reusing the detector on the mutant log would therefore convert every
    // successful catch into a harness error — the regression this pins.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      phaseGuard(
        `if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then printf '  Tests  2 failed (2)\\n'; exit 1; fi\n` +
          `printf '  Tests  1 passed | 1 skipped (2)\\n'; exit 0`,
      ),
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/MUTANT CAUGHT/);
    expect(out).not.toMatch(/ZERO TESTS/);
    expect(out).not.toMatch(/verdict=harness-error/);
    expect(read()).toBe(ORIGINAL);
  });

  it('sees through ANSI colour — vitest colourises the summary, and a naive line anchor would miss it', () => {
    // Not cosmetic: the detector anchors on `^\s*Tests`, and vitest wraps that
    // line in escapes. Without the strip the anchor never matches, the detector
    // emits nothing, and the false SURVIVED returns silently — a failure mode
    // that looks exactly like "no bug here".
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      phaseGuard(`printf '\\033[2m  Tests\\033[22m  \\033[33m2 skipped\\033[39m (2)\\n'; exit 0`),
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/BASELINE RAN ZERO TESTS/);
    expect(out).not.toMatch(/MUTANT SURVIVED/);
    expect(read()).toBe(ORIGINAL);
  });
});
