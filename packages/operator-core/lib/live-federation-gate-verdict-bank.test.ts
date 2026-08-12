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
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/live-federation-gate.sh above this test)',
  );
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
 */
function runGate(env: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...NO_PRUNE, GATE_NO_FILE: '1', ...env };
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

  it('keeps the bank a FILE under $STATE_DIR, for the same reason the markers are', () => {
    // The gate must keep recording when the operator/PG is down.
    const decl = gate.match(/^GATE_VERDICT_LOG="\$\{GATE_VERDICT_LOG:-[^"]*\}"$/m)?.[0];
    expect(decl, 'could not find the GATE_VERDICT_LOG declaration').toBeTruthy();
    expect(decl).toContain('$STATE_DIR/');
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
  }, 60_000);

  it('banks the FRESH (green-TTL) window too — not only the interesting verdicts', () => {
    const dir = freshStateDir('last-green');
    const { stdout } = runGate({ GATE_STATE_DIR: dir });

    expect(stdout).toMatch(/^GATE: FRESH /m);
    const rows = readBank(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('FRESH');
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
  }, 60_000);
});
