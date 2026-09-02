/**
 * pipefail-sigpipe-guard.test.ts — EI-22176104184812266
 *
 * Proves `scripts/check-pipefail-sigpipe.mjs` DISCRIMINATES. A lint nobody has watched
 * fail is not a guard, it is a script that has only ever agreed with the tree, so every
 * case below asserts a DIFFERENCE — vulnerable flagged, fixed clean — rather than
 * asserting that today's tree happens to pass.
 *
 * ── THE DEFECT BEING GUARDED ────────────────────────────────────────────────
 * Under `set -o pipefail` a pipeline's status includes a stage killed by a signal. An
 * early-exiting consumer (`grep -q`, `grep -m N`, `head`) closes the pipe as soon as it
 * has what it needs; a producer still writing takes SIGPIPE and exits 141, and pipefail
 * reports THAT as the pipeline's status. So the pipeline says "not found" exactly when
 * the needle WAS found and the producer was big enough to still be writing.
 *
 * §1 re-runs that inversion as a LIVE control, so the premise of the whole guard is
 * measured here rather than quoted from the filing. It also measures the discriminator
 * the guard gates on — a SMALL producer never SIGPIPEs — which is what makes
 * "unbounded producer" the gating condition instead of the shape alone.
 *
 * The 1MiB producer is deliberately far larger than any pipe buffer this box hands out.
 * The original incident was found at 8192-byte pipes (`fs.pipe-user-pages-soft` was
 * exhausted by fleet load, so the kernel was issuing 4KB pipes); the sysctl has since
 * been raised to hand out the full 64KB again. That mitigation moved the THRESHOLD and
 * changed nothing about the shape, so this control must not depend on the current
 * buffer size — hence 1MiB, which fails at every size.
 *
 * ── WHY FIXTURES AND NOT TREE MUTATION ──────────────────────────────────────
 * Proving falsifiability by mutating a tracked file is unsafe here: git-sync commits the
 * whole working tree on a schedule, so a probe holding a file mutated for the length of
 * a suite can have the mutant COMMITTED even when nothing fails and no handler is
 * skipped (CLAUDE.md, "Proving a guard is falsifiable"). §2 feeds the detector in
 * memory instead — no tracked file is ever modified.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs guard script with no type declarations; the pure detector is
// exported precisely so this test can drive it without spawning a process per case.
import { enablesPipefail, findSites } from '../../../scripts/check-pipefail-sigpipe.mjs';
import { runGuardScript } from './testing-guard-script';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Site {
  file: string;
  line: number;
  code: string;
  producer: string;
  consumer: string | null;
  unbounded: string | null;
  neutralised: boolean;
}

/** Sites the guard would FAIL on: unbounded producer, status not neutralised. */
const gated = (script: string): Site[] =>
  (findSites(`set -euo pipefail\n${script}\n`, 'fixture.sh') as Site[]).filter(
    (s) => s.unbounded && !s.neutralised,
  );

/** Every shape match, gated or not — used to tell "not flagged" from "not detected". */
const allSites = (script: string): Site[] =>
  findSites(`set -euo pipefail\n${script}\n`, 'fixture.sh') as Site[];

describe('§1 the mechanism this guard exists for (live control)', () => {
  const runStatus = (script: string): number => {
    const out = execFileSync('bash', ['-c', `${script}; echo "status=$?"`], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return Number(/status=(\d+)/.exec(out)?.[1] ?? NaN);
  };

  // A producer that emits one matching line and then ~1MiB more, so it is guaranteed to
  // still be writing when an early-exiting consumer closes the pipe.
  const bigProducer = '( printf "NEEDLE\\n"; dd if=/dev/zero bs=1M count=1 2>/dev/null | tr "\\0" "x" )';

  it('reports FAILURE from a pipeline whose needle was actually FOUND', () => {
    // The inversion itself. grep -q finds NEEDLE on line 1 and exits 0; the pipeline
    // still reports non-zero because pipefail propagates the producer's SIGPIPE.
    expect(
      runStatus(`set -o pipefail; ${bigProducer} | grep -q NEEDLE`),
      'the whole premise of this guard: a match reported as a failure',
    ).not.toBe(0);
  });

  it('does not invert when the consumer DRAINS its input (the documented fix)', () => {
    expect(
      runStatus(`set -o pipefail; ${bigProducer} | grep -c NEEDLE >/dev/null`),
      '`grep -c` reads to EOF, so the producer is never SIGPIPEd',
    ).toBe(0);
  });

  it('does not invert when the producer is SMALL (why the gate needs an unbounded producer)', () => {
    // This is the discriminator that keeps the guard blocking rather than advisory:
    // the same shape over a producer that fits in the pipe buffer cannot fail, which is
    // why ~70 `printf|grep -q` sites in this tree are censused and not gated.
    expect(runStatus('set -o pipefail; printf "NEEDLE\\n" | grep -q NEEDLE')).toBe(0);
  });
});

describe('§2 the detector discriminates (in-memory fixtures)', () => {
  it('flags the incident shape: git show piped into grep -q', () => {
    const hits = gated('git show "$SHA:$F" | grep -q NEEDLE || fail "missing"');
    expect(hits.map((h) => h.unbounded)).toEqual(['git show output is unbounded']);
  });

  it.each([
    ['strings on a binary', 'strings "$EXE" | grep -q HOST'],
    ['a tree walk', 'find . -type f | head -1'],
    ['a recursive grep', 'grep -rn NEEDLE lib | head -5'],
    ['an unbounded fetch', 'curl -sS "$URL" | grep -m1 version'],
    ['a whole-file read', 'cat "$BIGFILE" | head -1'],
    ['journal output', 'journalctl -u thing | grep -q started'],
  ])('flags %s', (_label, script) => {
    expect(gated(script)).toHaveLength(1);
  });

  it.each([
    // Each of these is a DIFFERENT reason to be safe — a detector that passed them all
    // by being blind to the shape would fail the "detected but not gated" assertion below.
    ['a bounded shell builtin', 'printf "%s" "$x" | grep -q y'],
    ['a drained intermediate stage', 'find . -type f | sort -rn | head -1'],
    ['a filter with no file to open', 'head -c 24 /dev/urandom | base64 | head -c 32'],
    ['a single-path find', 'find "$sock" -maxdepth 0 -mmin +5 2>/dev/null | grep -q .'],
    ['a pseudo-file read', 'cat /proc/$$/cmdline | head -c 160'],
    ['an explicitly discarded status', 'git show "$SHA:$F" | grep -q NEEDLE || true'],
    ['a discarded status inside a substitution', 'v=$(git show "$S:$F" | head -1 || true)'],
  ])('does NOT flag %s', (_label, script) => {
    expect(gated(script)).toHaveLength(0);
  });

  it('sees the shape it declines to gate, rather than being blind to it', () => {
    // The negative cases above must pass because the detector JUDGED them safe, not
    // because it failed to parse them. Without this, a regex that matched nothing at all
    // would satisfy every "does NOT flag" case above.
    for (const script of [
      'printf "%s" "$x" | grep -q y',
      'find . -type f | sort -rn | head -1',
      'git show "$SHA:$F" | grep -q NEEDLE || true',
    ]) {
      expect(allSites(script), script).toHaveLength(1);
    }
  });

  it('does not flag a consumer that reads to EOF', () => {
    expect(allSites('git show "$SHA:$F" | grep -c NEEDLE')).toHaveLength(0);
  });

  it('ignores comments and `#` inside quoted strings', () => {
    expect(allSites('# git show "$S:$F" | grep -q X')).toHaveLength(0);
    // The `#` here is data. A naive comment-stripper truncates this into a different
    // pipeline and loses the consumer entirely.
    expect(gated(`git show "$S:$F" | grep -q '#define NEEDLE'`)).toHaveLength(1);
  });

  it('only scans scripts that actually enable pipefail', () => {
    // Without pipefail a pipeline's status is the LAST stage's, so a SIGPIPEd producer
    // is invisible and there is nothing to guard. That filter is the file-walk's
    // predicate, not findSites' — so assert the predicate itself rather than inferring
    // it from a shape scan that never applies it.
    expect(enablesPipefail('set -euo pipefail\n')).toBe(true);
    expect(enablesPipefail('set -eo pipefail\n')).toBe(true);
    expect(enablesPipefail('set -o pipefail\n')).toBe(true);
    expect(enablesPipefail('set -eu\n')).toBe(false);
    expect(enablesPipefail('# set -o pipefail (a comment about it)\n')).toBe(false);
  });
});

describe('§3 the guard is clean over the real tree', () => {
  it('reports no unbounded-producer sites', () => {
    const guard = runGuardScript('node', ['scripts/check-pipefail-sigpipe.mjs', '--json'], {
      cwd: REPO_ROOT,
      timeoutMs: 180_000,
    });

    let report: {
      filesScanned: number;
      sites: number;
      offenders: { file: string; line: number; producer: string; consumer: string; unbounded: string }[];
      staleAllowlist: { file: string; match: string }[];
    };
    try {
      report = JSON.parse(guard.stdout);
    } catch {
      // A crash, a timeout or a truncated buffer lands here, all of which would
      // otherwise surface as an opaque JSON parse error about position 0.
      throw new Error(`the guard produced no parseable --json report:\n${guard.output}`);
    }

    // A scan that measured nothing would pass vacuously — assert it really walked the tree.
    expect(report.filesScanned).toBeGreaterThan(50);
    expect(report.sites).toBeGreaterThan(20);

    // Rendered as strings so the vitest diff itself names the offender and the fix,
    // rather than printing an object nobody reads out of a captured failure tail.
    expect(
      report.offenders.map((o) => `${o.file}:${o.line} — ${o.producer} | ${o.consumer}: ${o.unbounded}`),
      'Fix with a shape that cannot invert: capture-then-match into a variable, a ' +
        'consumer that reads to EOF (`grep -c`), reading the file directly (`grep -aqF ' +
        'needle "$file"`), or `|| true` when the status genuinely does not matter.',
    ).toEqual([]);

    expect(
      report.staleAllowlist.map((a) => `${a.file} — ${a.match}`),
      'These ALLOWLIST entries no longer match a site; delete them so the allowlist ' +
        'cannot silently cover a future one.',
    ).toEqual([]);
  });
});
