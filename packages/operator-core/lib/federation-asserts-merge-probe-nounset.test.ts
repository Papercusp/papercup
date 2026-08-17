/**
 * federation-asserts-merge-probe-nounset.test.ts — WI-5472 guard for the two post-JOIN merge
 * probes in papercusp-desktop/bin/lib/federation-asserts.sh.
 *
 * WHAT WENT WRONG (the defect this pins shut, re-measured 2026-08-17).
 *
 * `fed_hive_merge_probe()` and `fed_coord_merge_probe()` each declared `ws` in their `local`
 * line WITHOUT an initializer, then assigned it only inside `if [ -n "${RIG_HIVE_ID:-}" ]`.
 * The very next line reads it bare:
 *
 *     [ -n "$ws" ] || ws="$(drv_psql ... )"      # federation-asserts.sh:1148 / :1193
 *
 * Callers that run under `set -u` WITHOUT RIG_HIVE_ID in scope (two-instance-hive-from-repo-smoke.sh,
 * two-instance-content-matrix-smoke.sh — the deb-hetzner-rig.sh family DOES set it and was never
 * affected) therefore hit `$ws` genuinely UNBOUND and the function DIED mid-execution instead of
 * ever echoing its 0/1 verdict.
 *
 * ⚠ `local x` (no `=`) does NOT satisfy nounset. That is the whole bug, and it is the assumption
 * most readers get wrong on first look — `local x=""` is bound-and-empty, `local x` is unbound.
 * Measured both ways; the control below re-proves it on every run rather than asserting it.
 *
 * WHY IT WAS INVISIBLE — and why it is worse than a plain crash. Every caller captures stdout as
 * `probe="$(fed_hive_merge_probe ... || true)"`. The `|| true` swallows the nonzero exit and the
 * command substitution contains the death, so the caller silently reads an EMPTY string where it
 * expected "0" or "1 <slug>". Downstream string matching (`${ab%% *}`) treats empty as FAIL. Net
 * effect: on those callers the federate-A→B, federate-B→A, federate-continuous and coord-plane
 * merge assertions read FAIL **regardless of whether federation actually worked** — a harness
 * artifact indistinguishable, in the witness output, from a real product defect. That is the
 * expensive part: a false FAIL sends the next agent debugging transport that is fine.
 *
 * WHAT THIS FILE GUARDS.
 *   1. Both probes REACH A VERDICT under `set -u` with RIG_HIVE_ID unset — and reach the
 *      INTENDED one. Asserting only "did not crash" would pass on a function that silently
 *      returned nothing, so the assertions pin the deliberate D-050/WI-5399 fatal message on
 *      stderr and the "0" on stdout. An accidental death and a designed refusal both "fail";
 *      only one of them is correct behaviour, and they must never be conflated again.
 *   2. The happy path still echoes "1 <slug>" / "1" — so a future "fix" that hard-codes the
 *      refusal branch cannot pass this file.
 *   3. THE CONTROL (test 4) — a copy of the real script with ONLY the `ws=""` initializers
 *      stripped MUST die with "unbound variable". This is what makes tests 1–3 meaningful: a
 *      guard that has never failed is a guard nobody has tested. The control also refuses a
 *      NO-OP mutation (it asserts both substitutions actually landed), because a mutation that
 *      changed nothing makes any guard look strong while proving nothing.
 *
 * ⚠ THE CONTROL NEVER MUTATES THE SHARED TREE. It copies to an OS tmpdir and mutates the copy
 * (mutation-probe.sh tier 2). An in-tree mutate/restore would be committable by the git-sync
 * sweep during the run even if nothing goes wrong and no handler fails — a trap cannot fix that,
 * only not-mutating-the-tree can.
 *
 * Set PROBE_FEDERATION_ASSERTS=<path> to point tests 1–3 at a copy (tier-2 external probing).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT =
  process.env.PROBE_FEDERATION_ASSERTS ??
  resolve(__dirname, '../../../papercusp-desktop/bin/lib/federation-asserts.sh');

/** Stub drv_psql so the probes exercise their real control flow with no PG and no sleeps. */
const STUB_RESOLVES = `
drv_psql() {
  case "$2" in
    *"FROM harness_shared.pot_members"*)                 echo "ws-real" ;;
    *"FROM harness_shared.harness_features_consolidated"*) echo "landed-slug" ;;
    *"FROM harness_shared.coord_event_log"*)             echo "COMM-1" ;;
    *) : ;;
  esac
}`;

/** Stub that resolves NOTHING — every query is empty, so `ws` stays empty (the WI-5472 path). */
const STUB_EMPTY = `drv_psql() { : ; }`;

type Run = { stdout: string; stderr: string; reachedEnd: boolean };

/**
 * Source `script` under `set -uo pipefail`, install `stub`, and call one probe.
 * Streams go to files so a shell that DIES mid-run is distinguishable from one that ran and
 * printed nothing — the two are identical on a plain capture, and conflating them is how the
 * mutant first read as a pass during development of this file.
 */
function runProbe(script: string, fn: string, stub: string, ...args: string[]): Run {
  const dir = mkdtempSync(join(tmpdir(), 'wi5472-'));
  const out = join(dir, 'o');
  const err = join(dir, 'e');
  const done = join(dir, 'done');
  const argv = args.map((a) => JSON.stringify(a)).join(' ');
  const program = `
set -uo pipefail
source ${JSON.stringify(script)} >/dev/null 2>&1
${stub}
unset RIG_HIVE_ID
${fn} ${argv} >${JSON.stringify(out)} 2>${JSON.stringify(err)} || true
echo reached > ${JSON.stringify(done)}
`;
  try {
    execFileSync('bash', ['-c', program], { encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
  } catch {
    /* a nounset death exits the outer shell nonzero — that IS the signal; read the files. */
  }
  return {
    stdout: existsSync(out) ? readFileSync(out, 'utf8').trim() : '',
    stderr: existsSync(err) ? readFileSync(err, 'utf8') : '',
    reachedEnd: existsSync(done),
  };
}

describe('WI-5472 — merge probes reach a verdict under `set -u` without RIG_HIVE_ID', () => {
  it('is the right script and still defines both probes (guards a vacuous suite)', () => {
    expect(existsSync(SCRIPT), `federation-asserts.sh not found at ${SCRIPT}`).toBe(true);
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/^fed_hive_merge_probe\(\)\s*\{/m);
    expect(src).toMatch(/^fed_coord_merge_probe\(\)\s*\{/m);
    // The bug was a bare `ws` in these two `local` lines. Pin the initializer explicitly so a
    // reviewer reading a future diff sees WHY the `=""` is load-bearing rather than noise.
    const locals = src
      .split('\n')
      .filter((l) => /^\s*local src=.*\btries=/.test(l) && /\bws\b/.test(l));
    expect(locals.length).toBeGreaterThanOrEqual(2);
    for (const line of locals) expect(line, `bare \`ws\` local: ${line.trim()}`).toMatch(/\bws=""/);
  });

  for (const [fn, fatal] of [
    ['fed_hive_merge_probe', 'FATAL fed_hive_merge_probe'],
    ['fed_coord_merge_probe', 'FATAL fed_coord_merge_probe'],
  ] as const) {
    it(`${fn}: unresolvable workspace refuses DELIBERATELY (echoes 0), never dies on \`ws\``, () => {
      const r = runProbe(SCRIPT, fn, STUB_EMPTY, 'a', 'b', 'slug', 'XX', '1');
      expect(r.stderr).not.toMatch(/unbound variable/);
      expect(r.reachedEnd, 'the shell died mid-run — that is the WI-5472 crash').toBe(true);
      // Reached the INTENDED refusal, not an accidental one.
      expect(r.stderr).toContain(fatal);
      expect(r.stderr).toContain('could not resolve a real workspace_id');
      expect(r.stdout).toBe('0');
    });
  }

  it('fed_hive_merge_probe: happy path still echoes "1 <landed_slug>"', () => {
    const r = runProbe(SCRIPT, 'fed_hive_merge_probe', STUB_RESOLVES, 'a', 'b', 'slug', 'FID-1', '1');
    expect(r.stderr).not.toMatch(/unbound variable/);
    expect(r.stdout).toBe('1 landed-slug');
  });

  it('fed_coord_merge_probe: happy path still echoes "1"', () => {
    const r = runProbe(SCRIPT, 'fed_coord_merge_probe', STUB_RESOLVES, 'a', 'b', 'slug', 'TAG', '1');
    expect(r.stderr).not.toMatch(/unbound variable/);
    expect(r.stdout).toBe('1');
  });

  // ── THE CONTROL ─────────────────────────────────────────────────────────────
  // Proves the three tests above CAN fail. Mutates a COPY in an OS tmpdir, never the tree.
  it('CONTROL: stripping the `ws=""` initializers reinstates the crash (guard is falsifiable)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi5472-mutant-'));
    const mutant = join(dir, 'federation-asserts.sh');
    copyFileSync(SCRIPT, mutant);

    const original = readFileSync(mutant, 'utf8');
    // Strip ONLY the initializer on `local ... ws=""` lines that declare a probe's locals.
    const mutated = original.replace(
      /^(\s*local src=.*\btries="\$\{\d+:-30\}".*?)\bws=""/gm,
      '$1ws',
    );
    const changed = original.split('\n').filter((l, i) => l !== mutated.split('\n')[i]).length;
    // A no-op mutation would make this control vacuous — refuse it loudly (mutation-probe.sh
    // exits 2 on exactly this case).
    expect(changed, 'mutation changed nothing — the control proves nothing').toBeGreaterThanOrEqual(2);
    writeFileSync(mutant, mutated);

    for (const fn of ['fed_hive_merge_probe', 'fed_coord_merge_probe']) {
      const r = runProbe(mutant, fn, STUB_EMPTY, 'a', 'b', 'slug', 'XX', '1');
      expect(r.stderr, `${fn} mutant should die on unbound \`ws\``).toMatch(/ws: unbound variable/);
      expect(r.stdout, `${fn} mutant should print no verdict at all`).toBe('');
      expect(r.reachedEnd, `${fn} mutant should NOT reach the end of the shell`).toBe(false);
    }
  });
});
