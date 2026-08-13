/**
 * `scripts/mutation-probe.sh` — the sweep-race gate on `--in-tree`.
 *
 * WHY THIS FILE EXISTS (EI-18701398718982653): the probe script is the repo's
 * sanctioned way to prove a guard is falsifiable, and `--in-tree` is its one
 * mode that leaves a deliberately-wrong state in the SHARED tracked tree.
 * git-sync commits that tree on a short cadence, so a probe outliving one tick
 * gets its mutant committed — a committed RED test freezes every agent's
 * deploys. The script cannot take the lock itself (it lives in Postgres behind
 * an authed door), so the next best thing is that it refuses to proceed until
 * the caller has DECIDED what to do about the sweep. Before this gate the same
 * information was a log line printed while the mutation was already under way.
 *
 * Every case below drives the REAL script against a throwaway git repo under
 * os.tmpdir(), never against this checkout — the same copy-out discipline the
 * script itself prescribes (CLAUDE.md § "Proving a guard is falsifiable").
 *
 * FALSIFIABILITY: the subject path is overridable via MUTATION_PROBE_SCRIPT, so
 * this suite can be pointed at a mutated COPY of the script:
 *
 *   scripts/mutation-probe.sh \
 *     --file scripts/mutation-probe.sh \
 *     --mutate 's/^if \[ "\$IN_TREE" -eq 1 \] && \[ -z "\$SWEEP_ACK" \]; then/if false; then/' \
 *     --test 'MUTATION_PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/mutation-probe-sweep-gate.test.ts'
 *
 * That run mutates a copy in a scratch dir; the tracked script is never dirty.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Walk up from this file to the checkout root (the dir holding `scripts/`). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'scripts', 'mutation-probe.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the checkout root from ' + import.meta.url);
}

const PROBE = process.env.MUTATION_PROBE_SCRIPT
  ? resolve(process.env.MUTATION_PROBE_SCRIPT)
  : join(repoRoot(), 'scripts', 'mutation-probe.sh');

let scratch: string;
let subject: string;

/**
 * Run the probe inside the scratch repo. `cwd` matters: the script resolves the
 * git-sync lock resource from the repo root it is standing in, so running here
 * also proves that name is DERIVED rather than hardcoded to this checkout.
 */
function runProbe(args: string[]) {
  const r = spawnSync('bash', [PROBE, ...args], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TMPDIR: scratch },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const GOOD = 'value = GOOD\n';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mutation-probe-gate-'));
  subject = join(scratch, 'subject.txt');
  writeFileSync(subject, GOOD);
  // `git hash-object` / `rev-parse --show-toplevel` need a real repo.
  const init = spawnSync('git', ['init', '-q'], { cwd: scratch, encoding: 'utf8' });
  expect(init.status, `git init failed: ${init.stderr}`).toBe(0);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('mutation-probe.sh --in-tree sweep-race gate', () => {
  it('REFUSES --in-tree with no acknowledgement, and hands over the exact lock incantation', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
    ]);

    // Exit 2 is the script's documented "misuse / could not run soundly" code.
    expect(status).toBe(2);
    expect(out).toContain('SWEEP race');
    // The refusal must be ACTIONABLE: the resource name is resolved from the
    // repo it is standing in, not copied from a doc that can drift.
    expect(out).toContain(`git-sync:${basename(scratch)}`);
    expect(out).toContain('locks:acquire_resource');
    expect(out).toContain("mode: 'exclusive'");
    // Both escapes must be named, or the gate is a dead end rather than a fork.
    expect(out).toContain('--sweep-lock-held');
    expect(out).toContain('--accept-sweep-race');

    // A refusal must refuse: the file is untouched and no probe ran. Assert on
    // the RESULT LINE and the mutation log, not on the bare token
    // "MUTATION_PROBE_RESULT" — the refusal text names it while explaining that
    // an accepted race gets recorded there, so the token alone cannot tell a
    // refusal apart from a completed run.
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=');
    expect(out).not.toContain('mutant applied:');
  });

  it('runs under --accept-sweep-race, records the accepted race, and restores the file', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--accept-sweep-race',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    // The acceptance is auditable in the machine-readable line, not just in a
    // log the operator may never read back.
    expect(out).toContain('target=in-tree:race-accepted');
    expect(out).toContain('tree integrity: VERIFIED');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('runs under --sweep-lock-held and records THAT choice distinctly', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('target=in-tree:lock-held');
    // The script cannot verify the lock from a shell, and must say so rather
    // than let a declared lock read as a confirmed one.
    expect(out).toContain('NOT verified from here');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('leaves copy-out mode ungated and never dirties the tracked file', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('target=copy-out');
    expect(out).not.toContain('SWEEP race');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('rejects a sweep acknowledgement passed WITHOUT --in-tree', () => {
    // A stray ack means the caller believes they are mutating the tree when
    // they are not — accepting it silently teaches a wrong mental model.
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--sweep-lock-held',
    ]);

    expect(status).toBe(2);
    expect(out).toContain('only mean something with --in-tree');
  });
});
