/**
 * live-federation-gate-verdict-bank.test.ts — regression guard for WI-38285.
 *
 * THE BUG: the gate decided a verdict and then emitted it with a bare `echo "GATE: …"`. That
 * echo WAS the entire record, and it survives nowhere:
 *   • a bare `./live-federation-gate.sh` never touches journald, so there is NO journal entry;
 *     a manual `systemctl --user start` of the SERVICE leaves service entries and no timer
 *     ones — so the journal answers about the TIMER and lies by omission about the GATE;
 *   • `$WORK=/tmp/live-fed-gate-$STAMP` is pruned to GATE_KEEP_RUNS and reaped from /tmp;
 *   • the `$STATE_DIR` markers (last-run/last-green/last-red/last-downgrade) are bare epoch
 *     INTEGERS — they record THAT a window happened, never WHAT it decided.
 *
 * MEASURED 2026-08-12 (the filing evidence): `~/.papercusp/live-fed-gate/last-green` held
 * 1786533170 = 2026-08-12T11:12:50Z, and last-green is written on the GREEN path ONLY — so a
 * GREEN verdict on the release-BLOCKING gate provably existed while its content was already
 * unrecoverable (run dir reaped, newest triage/ bank from the previous day's RED, no journal
 * entry). That green therefore could not answer the one question a green is asked: did the
 * containerized local-matrix restart class actually run this window, or did the cheap
 * content-matrix leg carry the green alone? Since the timer was owner-stopped on 2026-08-07
 * EVERY run is a hand-run, which is what made this the normal case rather than an edge case.
 *
 * THE FIX: every terminal path emits through `verdict()`, which banks a structured JSONL
 * record to `$STATE_DIR/verdicts.jsonl` and THEN echoes the byte-identical line.
 *
 * STATIC leg: pins the property that actually matters and that a future edit would break —
 * that NO terminal path emits a bare `echo "GATE: …"`. A new verdict site added later without
 * verdict() fails here, which is the whole point: the population is guarded, not a sample.
 * BEHAVIORAL leg: drives the REAL shipping script through its fresh-exit verdicts against a
 * scratch state dir, and evals the REAL banking helpers out of the script to prove the JSON
 * survives hostile input and the bank stays bounded.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-verdict-bank.test.ts
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'live-federation-gate.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the repo root (no papercusp-desktop/bin/live-federation-gate.sh above this test)');
}

const ROOT = repoRoot();
// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY outside the
// tree (tier 2), so proving the guard falsifiable never dirties the shared checkout.
// Resolved against ROOT when relative: the probe substitutes a repo-relative path, while this
// suite runs with cwd=packages/operator-core, so taking it verbatim yields an ENOENT that the
// probe can only report as a harness-error baseline failure.
const GATE_PATH = process.env.PROBE_SCRIPT
  ? isAbsolute(process.env.PROBE_SCRIPT)
    ? process.env.PROBE_SCRIPT
    : join(ROOT, process.env.PROBE_SCRIPT)
  : join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const gate = readFileSync(GATE_PATH, 'utf8');
const gateSystemdUnit = readFileSync(
  join(ROOT, 'apps', 'operator', 'scripts', 'systemd', 'papercup-live-federation-gate.service'),
  'utf8',
);

/**
 * Running the REAL gate prunes /tmp/live-fed-gate-* down to GATE_KEEP_RUNS on startup. A test
 * that let that run would EVICT other runs' banked artifacts — precisely the evidence-loss this
 * suite exists to prevent — so every spawn below pins the retention absurdly high, making the
 * prune a no-op instead of a side effect on a shared directory.
 */
const NO_PRUNE = { GATE_KEEP_RUNS: '100000' };

/**
 * The RUNNER's environment must never decide the verdict under test. systemd exports
 * INVOCATION_ID into every process of a unit, and that variable is the exact signal the gate
 * reads to classify `invoker: hand | systemd` — so a suite launched by a systemd unit or scope
 * (the green-checkpoint gate itself, or any agent's `systemd-run --scope` shell) leaks it into
 * every spawn below and silently turns each "hand" fixture into a systemd one. That made this
 * file pass for a human at a terminal and fail in the pipeline, which is the worst possible
 * split: invisible to whoever checks it, blocking to everyone else.
 *
 * So the child env carries INVOCATION_ID only when the CALLER declares it. `undefined` is not
 * enough — spawnSync stringifies it to "undefined", which is a NON-EMPTY value and reads as
 * present — so the key is deleted outright.
 *
 * PC_HEAVY_* is the SAME class, and it cost a green-checkpoint candidate the same way
 * (dfe7bd9f). The gate self-re-execs through `scripts/pc-heavy.sh` unless PC_HEAVY_BYPASS=1,
 * and pc-heavy exports exactly that into every child it runs — deliberately, so "nested
 * build/test wrappers do not reacquire a slot". The green-checkpoint suite runs UNDER
 * pc-heavy, so every spawn below silently inherited PC_HEAVY_BYPASS=1, skipped the wrapper,
 * and never received the after-ready marker path the wrapper allocates. Green by hand, red in
 * the pipeline — the identical split described above.
 *
 * The cure is NOT to force the wrapper on: re-acquiring a nested pc-heavy slot from inside a
 * pc-heavy-wrapped suite is the exact thing that BYPASS export exists to prevent, and under
 * the release-gate slot clamp the child would queue behind the parent that is waiting for it.
 * So the whole family is scrubbed and the gate is driven DIRECTLY by default, with any
 * pc-heavy-side input supplied explicitly by the test that wants it (the same shape
 * `affected-tests-preempt-ready.test.ts` uses for the other side of this barrier).
 */
function runGate(env: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...NO_PRUNE, GATE_NO_FILE: '1' };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('PC_HEAVY_')) delete childEnv[key];
  }
  childEnv.PC_HEAVY_BYPASS = '1';
  Object.assign(childEnv, env);
  if (!('INVOCATION_ID' in env)) delete childEnv.INVOCATION_ID;

  const r = spawnSync('bash', [GATE_PATH], {
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function freshStateDir(marker: 'last-red' | 'last-green' | 'last-downgrade'): string {
  const dir = mkdtempSync(join(tmpdir(), 'lfg-verdict-bank-'));
  writeFileSync(join(dir, marker), `${Math.floor(Date.now() / 1000)}\n`);
  return dir;
}

function readBank(stateDir: string): Array<Record<string, any>> {
  const p = join(stateDir, 'verdicts.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}

describe('live-federation gate: every verdict is banked durably, not just echoed', () => {
  // ── STATIC leg ──────────────────────────────────────────────────────────────
  it('emits NO verdict through a bare echo — every terminal path goes through verdict()', () => {
    // THE guard. A new terminal path added later that echoes its own verdict is invisible to
    // the bank and reintroduces the whole bug, so the population is asserted, never a sample.
    const bareEchoes = gate
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^\s*echo\s+"GATE:/.test(line));
    expect(
      bareEchoes.map(({ n, line }) => `${n}: ${line.trim()}`),
      'a terminal path emits its verdict with a bare echo — it will not be banked',
    ).toEqual([]);
  });

  it('routes every GATE: verdict site through verdict(), and there is more than one', () => {
    const sites = gate.match(/^\s*verdict\s+"GATE:/gm) ?? [];
    // Guards against the degenerate pass where a refactor deletes the sites entirely and the
    // assertion above is trivially satisfied by an empty population.
    expect(sites.length).toBeGreaterThan(10);
  });

  it('banks BEFORE it echoes, and echoes the line byte-identically', () => {
    const fn = gate.match(/^verdict\(\) \{.*\}$/m)?.[0];
    expect(fn, 'could not extract the one-line verdict() from the gate source').toBeTruthy();
    // Ordering is load-bearing: a caller that pipes/drops stdout, or a TERM arriving mid-emit,
    // must not be able to cost the durable record.
    expect(fn!.indexOf('bank_verdict')).toBeLessThan(fn!.indexOf('echo'));
    // The echoed value must be the untouched argument — every existing verdict-greping caller
    // (and the gate-artifact "verdict is the last line" contract) depends on it.
    expect(fn).toMatch(/echo "\$1"/);
  });

  it('protects the run only until its first federation leg is decided', () => {
    // EI-21412456902012315 / D-084: five consecutive pc-heavy preemptions killed the gate and
    // banked content-matrix/from-repo/local-matrix all as '?'. The first repair published the
    // after-ready marker at gate entry, so a materializer spent 7m21s of the 600s lease waiting
    // for build/repack and killed the retry before content-matrix decided. Keep preparation
    // ordinarily preemptible + exactly retryable; publish only around the first real leg.
    const wrapper = gate.split('\n').find((line) => line.includes('PC_HEAVY_PREEMPT_AFTER_READY='));
    expect(wrapper, 'the gate wrapper no longer opts into pc-heavy after-ready protection').toBeTruthy();
    expect(wrapper).toContain('${PC_HEAVY_PREEMPT_AFTER_READY:-1}');

    const retry = gate.split('\n').find((line) => line.includes('PC_HEAVY_RETRY_PREEMPTIONS='));
    expect(retry, 'the gate wrapper no longer retries an exact typed preemption').toBeTruthy();
    expect(retry).toContain('${PC_HEAVY_RETRY_PREEMPTIONS:-1}');

    // systemd wraps the script in pc-heavy before the script can execute the
    // self-enrol block above.  Pin that second entrypoint too: the live failure
    // this test originally missed had all helper code present but no marker
    // because the unit supplied only PC_HEAVY_PREEMPTIBLE=1.
    expect(gateSystemdUnit).toContain('Environment=PC_HEAVY_PREEMPT_AFTER_READY=1');
    expect(gateSystemdUnit).toContain('Environment=PC_HEAVY_RETRY_PREEMPTIONS=1');
    expect(gateSystemdUnit).toMatch(/^ExecStart=.*\/scripts\/pc-heavy\.sh -- .*live-federation-gate\.sh$/m);

    const protectCalls = [...gate.matchAll(/^[\t ]*gate_preempt_protect_until_first_verdict[\t ]*$/gm)];
    const releaseCalls = [...gate.matchAll(/^[\t ]*gate_preempt_release_after_first_verdict[\t ]*$/gm)];
    expect(protectCalls, 'the protection helper must be called exactly once').toHaveLength(1);
    expect(releaseCalls, 'the release helper must be called exactly once').toHaveLength(1);

    const firstFreshExit = gate.indexOf('# ── fresh-exit:');
    const postRepackBoundary = gate.indexOf('memory_phase_guard "post-repack/pre-smokes"');
    const matrixInit = gate.indexOf('MATRIX_RES="${ATTESTATION_WALL_TOKEN:-SKIPPED}"');
    const matrixBranch = gate.indexOf('if [ "$SKIP_MATRIX" != 1 ]; then', matrixInit);
    const protectAt = protectCalls[0].index!;
    const matrixRun = gate.indexOf('MATRIX_RES="$(run_smoke content-matrix', protectAt);
    const releaseAt = releaseCalls[0].index!;
    const fromRepoInit = gate.indexOf('FROMREPO_RES="${ATTESTATION_WALL_TOKEN:-SKIPPED}"');
    expect(firstFreshExit).toBeLessThan(postRepackBoundary);
    expect(postRepackBoundary).toBeLessThan(matrixInit);
    expect(matrixInit).toBeLessThan(matrixBranch);
    expect(matrixBranch).toBeLessThan(protectAt);
    expect(protectAt).toBeLessThan(matrixRun);
    expect(matrixRun).toBeLessThan(releaseAt);
    expect(releaseAt).toBeLessThan(fromRepoInit);
    expect(gate.slice(matrixInit, releaseAt)).toContain('log "content-matrix → $MATRIX_RES"');

    const publishFn = gate.match(/^gate_preempt_protect_until_first_verdict\(\) \{[\s\S]*?^\}$/m)?.[0];
    const releaseFn = gate.match(/^gate_preempt_release_after_first_verdict\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(publishFn).toContain('set -C');
    expect(publishFn).toContain('exit 75');
    expect(releaseFn).toContain('rm -f -- "$marker"');
    // Permanent negative control: disabling preemption outright would satisfy the no-'?'
    // symptom by starving every exclusive materializer behind a potentially multi-hour run.
    const executableDisable = gate
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => line.includes('PC_HEAVY_PREEMPTIBLE=0'));
    expect(executableDisable).toEqual([]);
  });

  it('keeps the bank a FILE under $STATE_DIR, for the same reason the markers are', () => {
    // The gate must keep recording when the operator/PG is down.
    const decl = gate.match(/^GATE_VERDICT_LOG="\$\{GATE_VERDICT_LOG:-[^"]*\}"$/m)?.[0];
    expect(decl, 'could not find the GATE_VERDICT_LOG declaration').toBeTruthy();
    expect(decl).toContain('$STATE_DIR/');
  });

  it('retains stamped run evidence without counting immutable self-snapshots as runs', () => {
    const retentionLine = gate.split('\n').find((line) => line.includes('GATE_KEEP_RUNS + 1'));
    expect(retentionLine, 'could not find the run-retention command').toBeTruthy();

    // Permanent pre-fix control: the former broad glob matches BOTH populations. Enough
    // hourly snapshot re-execs therefore rotated a still-current RED run out of /tmp even
    // while the verdict bank pointed at it and fresh-red deliberately deferred reproduction.
    expect('live-fed-gate-snapshot.ABC123').toMatch(/^live-fed-gate-/);
    expect('live-fed-gate-20260819-174217').toMatch(/^live-fed-gate-/);

    // The shipped retention selector must name the stamped-run population only. Pin both the
    // exclusion and the positive case so replacing it with a pattern that matches nothing
    // cannot satisfy the guard vacuously.
    expect(retentionLine).toContain('/tmp/live-fed-gate-[0-9]*');
    expect(retentionLine).not.toContain('/tmp/live-fed-gate-*');
    expect('live-fed-gate-snapshot.ABC123').not.toMatch(/^live-fed-gate-[0-9]/);
    expect('live-fed-gate-20260819-174217').toMatch(/^live-fed-gate-[0-9]/);
  });

  it('never lets host load mask a build or preflight RED as SKIPPED-STORM', () => {
    const eligibility = gate.match(/^storm_downgrade_eligible\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(eligibility, 'could not extract storm_downgrade_eligible()').toBeTruthy();

    const evaluate = (opts: { build?: boolean; local?: string; content?: string }): string => {
      const dir = mkdtempSync(join(tmpdir(), 'lfg-storm-eligibility-'));
      if (opts.local !== undefined) writeFileSync(join(dir, 'local-matrix.out'), opts.local);
      if (opts.content !== undefined) writeFileSync(join(dir, 'content-matrix.out'), opts.content);
      const script = [
        'set -euo pipefail',
        `WORK=${JSON.stringify(dir)}`,
        `FAIL_BUILD=${opts.build ? 1 : 0}`,
        `MATRIX_RES=${opts.content === undefined ? 'SKIPPED' : 'FAIL'}`,
        'FROMREPO_RES=SKIPPED',
        'WITNESS_RES=SKIPPED',
        `MATRIXFULL_RES=${opts.local === undefined ? 'SKIPPED' : 'FAIL'}`,
        eligibility!,
        'if storm_downgrade_eligible; then echo ELIGIBLE; else echo "BLOCKED:$STORM_DOWNGRADE_BLOCKER"; fi',
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      return result.stdout.trim();
    };

    // Permanent pre-fix controls: a high shared-host load is compatible with all three
    // fixtures. The old branch inspected ONLY that number, so it downgraded each one.
    expect(192.88).toBeGreaterThan(115);
    expect(evaluate({ build: true })).toBe('BLOCKED:sidecar-build failed before smoke execution');
    expect(evaluate({ local: "FATAL(preflight): no gh token for 'aviynw'\n" })).toBe(
      'BLOCKED:local-matrix failed preflight before workload execution',
    );
    expect(evaluate({ content: 'ERROR: credential preflight rejected this run\n' })).toBe(
      'BLOCKED:content-matrix failed preflight before workload execution',
    );

    // Positive control: keep the intended legacy storm path reachable for an execution-stage
    // failure. This test narrows the downgrade; it does not vacuously disable it.
    expect(evaluate({ local: '  FAIL  concurrent_lww  ✗ did not converge\n' })).toBe('ELIGIBLE');
  });

  it('never lets a banking failure fail the gate', () => {
    const fn = gate.match(/^bank_verdict\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(fn, 'could not extract bank_verdict()').toBeTruthy();
    // The append is guarded and the failure arm returns success — the verdict still reaches
    // stdout. A gate that went red because it could not write a log file would be a worse bug
    // than the one this fixes.
    expect(fn).toMatch(/if ! printf/);
    expect(fn).toMatch(/return 0/);
  });

  // ── BEHAVIORAL leg ──────────────────────────────────────────────────────────
  it('banks a parseable record for a FRESH-RED window, and leaves stdout unchanged', () => {
    const dir = freshStateDir('last-red');
    const { stdout } = runGate({ GATE_STATE_DIR: dir });

    expect(stdout).toMatch(/^GATE: FRESH-RED /m);
    const rows = readBank(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('FRESH-RED');
    // The banked line is the verdict the caller saw — not a paraphrase of it.
    expect(stdout.trim().split('\n').pop()).toBe(rows[0].line);
    expect(typeof rows[0].epoch).toBe('number');
    expect(rows[0].head).toBeTruthy();
    expect(rows[0].legs).toBeTruthy();
    expect(rows[0]).toMatchObject({
      schema_version: 2,
      source_mode: 'unmeasured',
      source_head: 'unknown',
      source_dirty_files: -1,
    });
    expect(typeof rows[0].terminal_dirty_files).toBe('number');
    expect(typeof rows[0].certification_expires_epoch).toBe('number');
  }, 60_000);

  it('banks the FRESH (green-TTL) window too — not only the interesting verdicts', () => {
    const dir = freshStateDir('last-green');
    const { stdout } = runGate({ GATE_STATE_DIR: dir });

    expect(stdout).toMatch(/^GATE: FRESH /m);
    const rows = readBank(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('FRESH');
  }, 60_000);

  it('does not spend the after-ready lease on FRESH exit, while the real helper still publishes', () => {
    const stateDir = freshStateDir('last-green');
    const readyDir = mkdtempSync(join(tmpdir(), 'lfg-preempt-ready-'));
    // A FRESH window exits before build/repack/content-matrix. D-084 requires that it never
    // publish the marker or consume any of the bounded lease merely because pc-heavy handed
    // it a unique path.
    const marker = join(readyDir, 'ready.probe');
    const { stdout, stderr, status } = runGate({
      GATE_STATE_DIR: stateDir,
      PC_HEAVY_PREEMPT_READY_FILE: marker,
    });

    expect(status, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toMatch(/^GATE: FRESH /m);
    expect(stderr).not.toContain('pc-heavy protection ACTIVE');
    expect(existsSync(marker)).toBe(false);

    // Positive control: invoke the exact shipping helper in isolation at the point the static
    // ordering guard places it. This proves delayed publication did not become no publication,
    // and asserts the actual path bytes rather than accepting a log-only imitation.
    const publishFn = gate.match(/^gate_preempt_protect_until_first_verdict\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(publishFn, 'could not extract the real protection helper').toBeTruthy();
    const publishProbe = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -uo pipefail',
          `PC_HEAVY_PREEMPT_READY_FILE=${JSON.stringify(marker)}`,
          'GATE_PC_HEAVY_PROTECTED=0',
          `log() { printf '%s\\n' "$*" >&2; }`,
          `verdict() { printf '%s\\n' "$*"; }`,
          publishFn!,
          'gate_preempt_protect_until_first_verdict',
          `printf 'protected=%s\\n' "$GATE_PC_HEAVY_PROTECTED"`,
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    expect(publishProbe.status, `${publishProbe.stdout}\n${publishProbe.stderr}`).toBe(0);
    expect(publishProbe.stdout).toContain('protected=1');
    expect(publishProbe.stderr).toContain(
      `pc-heavy protection ACTIVE until content-matrix has a concrete state (marker=${marker})`,
    );
    expect(existsSync(marker)).toBe(true);
  }, 60_000);

  it('CONTROL: publishes nothing when the wrapper handed it no marker path', () => {
    // Makes the assertion above falsifiable. This is also the real PC_HEAVY_PREEMPT_AFTER_READY=0
    // escape hatch: pc-heavy unsets PC_HEAVY_PREEMPT_READY_FILE, and the gate must then run
    // unprotected rather than inventing a path of its own — a path it invented would be one
    // pc-heavy's monitor never cleans up.
    const stateDir = freshStateDir('last-green');
    const readyDir = mkdtempSync(join(tmpdir(), 'lfg-preempt-noready-'));
    const { stdout, stderr, status } = runGate({
      GATE_STATE_DIR: stateDir,
      PC_HEAVY_PREEMPT_READY_DIR: readyDir,
    });

    expect(status, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toMatch(/^GATE: FRESH /m);
    expect(stderr).not.toContain('pc-heavy protection ACTIVE');
    expect(readdirSync(readyDir)).toEqual([]);
  }, 60_000);

  it('records WHETHER the run was journald-observable — the distinction that lost the 08-12 green', () => {
    const hand = freshStateDir('last-red');
    runGate({ GATE_STATE_DIR: hand });
    expect(readBank(hand)[0].invoker).toBe('hand');

    // systemd exports INVOCATION_ID into a unit's processes and nothing else does.
    const unit = freshStateDir('last-red');
    runGate({ GATE_STATE_DIR: unit, INVOCATION_ID: 'deadbeefcafe' });
    expect(readBank(unit)[0].invoker).toBe('systemd');
  }, 60_000);

  it('CONTROL: classifies a hand run as "hand" even when the SUITE itself runs under systemd', () => {
    // The regression this pins (EI-20281218869378447): runGate used to spread process.env
    // wholesale, so a suite launched by a systemd unit or scope inherited INVOCATION_ID and the
    // "hand" case above silently measured its own PARENT instead of the gate. It passed by hand
    // and failed in the pipeline — green for whoever checked it, red for everyone else.
    //
    // Simulating the parent is what makes this falsifiable: delete the scrub in runGate and this
    // test fails, on any machine, without needing to be run from a real unit.
    const previous = process.env.INVOCATION_ID;
    process.env.INVOCATION_ID = 'deadbeefcafe';
    try {
      const dir = freshStateDir('last-red');
      runGate({ GATE_STATE_DIR: dir });
      expect(readBank(dir)[0].invoker).toBe('hand');
    } finally {
      if (previous === undefined) delete process.env.INVOCATION_ID;
      else process.env.INVOCATION_ID = previous;
    }
  }, 60_000);

  it('CONTROL: banks nothing when banking is disabled, so a pass here is not vacuous', () => {
    // Falsifiability. Without this, every assertion above would also pass against a build that
    // wrote the file for some unrelated reason.
    const dir = freshStateDir('last-red');
    const { stdout } = runGate({ GATE_STATE_DIR: dir, GATE_NO_VERDICT_LOG: '1' });
    expect(stdout).toMatch(/^GATE: FRESH-RED /m);
    expect(existsSync(join(dir, 'verdicts.jsonl'))).toBe(false);
  }, 60_000);

  it('stays valid JSON under hostile leg text, and stays bounded', () => {
    // Evals the REAL helpers out of the shipping script, so this cannot drift from what ships.
    const helpers = gate.match(/^__json_str\(\) \{[\s\S]*?^verdict\(\) \{.*\}$/m)?.[0];
    expect(helpers, 'could not extract the banking helpers from the gate source').toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'lfg-verdict-esc-'));
    const KEEP = 5;
    const harness = [
      'set -uo pipefail',
      'log() { :; }',
      'now_s() { date +%s; }',
      `STATE_DIR=${JSON.stringify(dir)}`,
      `DESKTOP_DIR=${JSON.stringify(join(ROOT, 'papercusp-desktop'))}`,
      'WORK=/tmp/fake-work',
      'GATE_VERDICT_LOG="$STATE_DIR/verdicts.jsonl"',
      `GATE_VERDICT_KEEP=${KEEP}`,
      'GATE_VERDICT_SCHEMA_VERSION=2',
      'GATE_SUCCESS_TTL_H=22',
      'GATE_SOURCE_MODE=rebuilt',
      'GATE_SOURCE_HEAD=0123456789ab',
      'GATE_SOURCE_DESKTOP_HEAD=abcdef012345',
      'GATE_SOURCE_DIRTY_FILES=0',
      'GATE_TERMINAL_HEAD=0123456789ab',
      'GATE_TERMINAL_DESKTOP_HEAD=abcdef012345',
      'GATE_TERMINAL_DIRTY_FILES=0',
      'GATE_CERTIFICATION_TARGET_SHA=0123456789abcdef0123456789abcdef01234567',
      helpers!,
      // A double quote, a backslash and a literal TAB — the tab is the one that bites, because
      // it is the only control character that survives a naive "strip the control chars" range,
      // and one un-escaped tab in SUMMARY invalidates EVERY subsequent line (SUMMARY persists
      // for the rest of the run), not just the line carrying it.
      'SUMMARY="content-matrix=\\"FAIL\\" path=C:\\\\tmp\\\\x\ttabbed"',
      'verdict "GATE: RED (leg \\"a\\" — backslash \\\\) — $SUMMARY" >/dev/null',
      `for i in $(seq 1 ${KEEP * 3}); do verdict "GATE: GREEN — run $i" >/dev/null; done`,
    ].join('\n');
    const harnessPath = join(dir, 'harness.sh');
    writeFileSync(harnessPath, harness);

    const r = spawnSync('bash', [harnessPath], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);

    const raw = readFileSync(join(dir, 'verdicts.jsonl'), 'utf8').trim().split('\n');
    // Bounded: an append-only file on a box that runs the gate for months cannot grow forever.
    expect(raw).toHaveLength(KEEP);
    for (const line of raw) expect(() => JSON.parse(line)).not.toThrow();
    const last = JSON.parse(raw.at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({
      schema_version: 2,
      verdict: 'GREEN',
      source_mode: 'rebuilt',
      source_head: '0123456789ab',
      source_desktop_head: 'abcdef012345',
      source_dirty_files: 0,
      terminal_dirty_files: 0,
      certification_target_sha: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(last.certification_expires_epoch).toEqual(expect.any(Number));
  }, 60_000);
});
