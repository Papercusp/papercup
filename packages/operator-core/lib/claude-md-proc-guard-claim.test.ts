import { describe, expect, it } from 'vitest';
import { readRepoFile } from '@papercusp/test-config';

/**
 * Guard: root CLAUDE.md's process-liveness advice must keep pointing at a tool
 * that actually exists.
 *
 * EI-19444215495255056 (2026-08-03). A peer filed that "pc-heavy's admission
 * gate refuses a READ-ONLY pgrep by matching command TEXT". It does not —
 * `scripts/pc-heavy.sh` contains ZERO occurrences of "pgrep" and refuses only
 * `*affected-tests.mjs*`, and the bash→tool routing pair `process.ps-pgrep`
 * documents itself as "evidence, never [a gate]" with an explicit
 * "`dev:processes` must NEVER gate `ps`/`pgrep`". The real gap was that the
 * repo's purpose-built, self-match-proof liveness checker —
 * `scripts/proc-guard.mjs` — was mentioned in CLAUDE.md ZERO times, so agents
 * hand-rolled `pgrep -f` (self-matching their own argv) or `pgrep -q` (which
 * does not exist here, and whose usage error takes the `|| echo gone` branch
 * while the process is alive), then blamed whatever refused them.
 *
 * So CLAUDE.md now prescribes proc-guard. This pins the two halves of that
 * claim together: the doc must name it, and the named script must still exist
 * and still expose the `check` subcommand the doc tells agents to run. Without
 * this, a rename/removal leaves CLAUDE.md confidently directing every agent at
 * a tool that isn't there — the exact failure mode the transport-claim guard
 * (claude-md-sync-transport-claim.test.ts) exists to prevent, in a different
 * section.
 */
describe('EI-19444215495255056 — CLAUDE.md process-liveness advice stays true', () => {
  const claudeMd = readRepoFile(__dirname, 'CLAUDE.md');
  const procGuard = readRepoFile(__dirname, 'scripts/proc-guard.mjs');

  it('CLAUDE.md points at proc-guard as the primary liveness check', () => {
    expect(claudeMd).toContain('scripts/proc-guard.mjs');
    // It must be given as a runnable command, not merely name-dropped.
    expect(claudeMd).toMatch(/node scripts\/proc-guard\.mjs check/);
  });

  it('proc-guard.mjs exists and implements the `check` subcommand the doc names', () => {
    expect(procGuard).toContain('check');
    // The whole point is that it cannot self-match: it excludes the caller's
    // own ancestor chain. If that goes away the advice is actively harmful,
    // because it would then be just another self-matching pgrep.
    expect(procGuard).toContain('getAncestryChain');
    expect(procGuard).toContain('matchExternalProcesses');
  });

  it('CLAUDE.md records the `pgrep -q` trap (it fails via EXIT CODE, so bracketing cannot help)', () => {
    // Bracketing the first char is the documented cure for the self-match
    // trap; it does nothing for an unsupported flag, so the two must be
    // documented as DISTINCT failures or a reader applies the wrong fix.
    expect(claudeMd).toContain('`pgrep -q` DOES NOT EXIST');
    expect(claudeMd).toMatch(/pgrep -cf|pgrep -x/);
  });

});

/*
 * DELIBERATELY NOT ASSERTED: that `scripts/pc-heavy.sh` contains no "pgrep".
 * That was true when EI-19444215495255056 was investigated (and is the evidence
 * that its filed root cause was wrong), but it pins an UNRELATED file's
 * implementation: a future maintainer adding a perfectly benign pgrep to
 * pc-heavy would trip a test whose name talks about a documentation claim, and
 * the confusing red would be indistinguishable from a real regression. A test
 * should pin a live invariant, not a past investigation — that finding belongs
 * in the work-item's thread, where it is recorded in full.
 */
