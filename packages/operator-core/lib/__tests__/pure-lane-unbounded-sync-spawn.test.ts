/**
 * pure-lane-unbounded-sync-spawn.test.ts — WI-41180.
 *
 * THE DEFECT THIS RATCHETS DOWN. A synchronous child-process call blocks the worker's event
 * loop inside libuv's `uv_spawn_sync`, which polls the child's stdout/stderr pipes. While that
 * loop is blocked NO JS TIMER CAN FIRE — so vitest's `testTimeout` and `hookTimeout` cannot
 * interrupt it, because both are implemented as timers. It is the one shape of test hang the
 * test framework is structurally unable to bound.
 *
 * WHY THE PURE LANE SPECIFICALLY. The pure lane runs `isolate: false` — ~2,740 operator-core
 * files SHARE a fork (libs/test-config/src/vitest-config.ts). A block in one file therefore
 * stalls every co-resident file in that fork, not just itself. MEASURED 2026-08-24 on run
 * `3882365-cd0504e1`: `lib/js-syntax-guard.test.ts` ran the full-tree `check-js-syntax` guard
 * through an unbounded sync spawn; captured output froze at 522,385 bytes between elapsed 120s
 * and 180s and never moved again, and `@papercusp/operator-core :: test:lane-pure` was SIGKILLed
 * by the batch watchdog at its 2700s floor with 2,731 of 2,740 files done. 45 minutes per
 * whole-radius affected run, with lane-pure coverage silently unmeasured. Nothing in the stack
 * could report it: the runner's own heartbeat rose identically for "working" and "wedged".
 *
 * WHAT THIS GUARD DOES, AND DELIBERATELY DOES NOT DO. It is a SHRINK-ONLY RATCHET, not a
 * clean-tree assertion. 92 pure-lane files carried an unbounded sync spawn when this was
 * written, and bounding all of them at once is a change nobody could review. So the baseline
 * below grandfathers the ones that already existed and the guard fails on:
 *   (a) any NEW pure-lane file that introduces an unbounded sync spawn, and
 *   (b) any baseline entry that has since been FIXED but not removed from the list —
 *       without (b) the list rots into a permanent allowlist and the ratchet stops turning.
 *
 * THE BOUND IS A `timeout:` OPTION on the call. That is the only thing that makes a sync spawn
 * interruptible; a `try/catch`, an `AbortSignal`, or a wrapper's own timer cannot help, because
 * none of them get to run while the loop is blocked.
 *
 * KNOWN LIMIT (documented, not defended — same posture as lane-split.ts's own matcher). The scan
 * does NOT strip comments or string literals, so a commented-out or quoted call still counts as an
 * offender. That is the deliberate direction to err in: a false positive costs one developer one
 * confusing failure with a message naming the file and the fix, while a false negative costs the
 * whole fleet a silent 45-minute wedge per affected run. If a legitimate mention ever trips it,
 * bound the call or reword the mention — do NOT add the file to BASELINE.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLaneInclude } from '@papercusp/test-config/lane-split';
import { describe, expect, it } from 'vitest';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Built with `new RegExp` from a source string in which each name is followed by `|` or `)`,
 * never by an open paren, so this file's own detector source cannot match itself. The scan
 * additionally skips this file by path (see SELF) — belt and braces, since a future edit could
 * easily reintroduce the literal call shape in a comment.
 */
const SYNC_SPAWN = String.raw`\b(execFileSync|spawnSync|execSync)\s*\(`;

const SELF = 'lib/__tests__/pure-lane-unbounded-sync-spawn.test.ts';

/**
 * Count sync-spawn calls in `source` that carry no `timeout:` option.
 *
 * The argument span is found by paren balance from the call's own open paren, so a `timeout:`
 * belonging to a LATER, unrelated call in the same file cannot be miscredited to this one —
 * the failure mode of a naive "is `timeout:` anywhere near it" window.
 */
export function countUnboundedSyncSpawns(source: string): number {
  const re = new RegExp(SYNC_SPAWN, 'g');
  let m: RegExpExecArray | null;
  let unbounded = 0;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    if (!/\btimeout\s*:/.test(source.slice(m.index, i))) unbounded++;
  }
  return unbounded;
}

/** Pure-lane files (workspace-relative, no leading `./`) that currently have >=1 unbounded call. */
function scanPureLane(): { roster: string[]; offenders: string[] } {
  // `.include` is `string[] | null` — null means the lane resolved to nothing. Coerce to [] rather
  // than throwing, so that case surfaces as the DENOMINATOR test failing (a scan of nothing is not
  // a pass) instead of as an opaque TypeError from a helper.
  const selected = resolveLaneInclude(WORKSPACE_ROOT, 'pure').include ?? [];
  const roster = selected.map((f) => f.replace(/^\.\//, ''));
  const offenders: string[] = [];
  for (const rel of roster) {
    if (rel === SELF) continue;
    let src: string;
    try {
      src = readFileSync(path.join(WORKSPACE_ROOT, rel), 'utf8');
    } catch {
      continue; // raced with a concurrent edit on this shared tree; not this guard's subject
    }
    if (countUnboundedSyncSpawns(src) > 0) offenders.push(rel);
  }
  return { roster, offenders };
}

/**
 * Grandfathered offenders, measured 2026-08-24 (WI-41180). SHRINK-ONLY: never add an entry to
 * make a new test pass — bound the call instead. Removing one is always correct.
 */
const BASELINE: readonly string[] = [
  'lib/__tests__/affected-tests-changed-path-provenance.test.ts',
  'lib/__tests__/affected-tests-non-workspace-routes.test.ts',
  'lib/__tests__/affected-tests-repo-wide-invariant-guards.test.ts',
  'lib/__tests__/affected-tests-standalone-packages.test.ts',
  'lib/__tests__/affected-tests-stdout-ordering.test.ts',
  'lib/__tests__/agent-env-contract-tracked-entries.test.ts',
  'lib/__tests__/blueprint-deps-catalog.test.ts',
  'lib/__tests__/blueprint-prompt-dark-tools.test.ts',
  'lib/__tests__/check-explicit-presence.test.ts',
  'lib/__tests__/check-file-verdict-scope.test.ts',
  'lib/__tests__/check-lint-guard-reachability.test.ts',
  'lib/__tests__/check-peer-dep-conflicts.test.ts',
  'lib/__tests__/check-required-field-strands.test.ts',
  'lib/__tests__/finding-context-sync.test.ts',
  'lib/__tests__/prompt-blueprint-verb-catalog.test.ts',
  'lib/__tests__/report-cargo-tests.test.ts',
  'lib/__tests__/strand-guard-not-checked-contract.test.ts',
  'lib/agent-tools/computer/desktop-sandbox-live.test.ts',
  'lib/attestation-leg-diagnostic-attribution-guard.test.ts',
  'lib/backend-bin-resolve.test.ts',
  'lib/bash-substitution/replay.test.ts',
  'lib/blueprint/__tests__/commit-reproject-real.test.ts',
  'lib/blueprint/detect-from-repo.test.ts',
  'lib/bundle-host-fallback.test.ts',
  'lib/check-transitive-boundary.test.ts',
  'lib/child-output-guard.test.ts',
  'lib/coord/gate-ownership-verdicts-wired.test.ts',
  'lib/deployment/frame-bootstrap.test.ts',
  'lib/deployment/runtime-pack.test.ts',
  'lib/desktop/desktop-gl-live.test.ts',
  'lib/desktop/gl-strategy.test.ts',
  'lib/doc-claims/git-log-utc-timestamp.test.ts',
  'lib/doc-claims/retired-surfaces.test.ts',
  'lib/embedded-pg-declarations.test.ts',
  'lib/embedded-pg-seed.test.ts',
  'lib/event-loop-sentinel-host.test.ts',
  'lib/fleet/sidecar-fallback-reported-guard.test.ts',
  'lib/gen-tool-catalog-worktree-locality.test.ts',
  'lib/generated-declarations.test.ts',
  'lib/git-store-ref-integrity.test.ts',
  'lib/goals/kill-criterion-doors.test.ts',
  'lib/gym/__tests__/fake-agent.test.ts',
  'lib/harness/docs/authored-doc-projection.test.ts',
  'lib/harness/docs/drift.test.ts',
  'lib/harness/docs/freshness-sweep.test.ts',
  'lib/harness/git-stats.test.ts',
  'lib/harness/git-sync/code-plane-fork-pr-live.test.ts',
  'lib/harness/git-sync/pre-push-hook.test.ts',
  'lib/harness/git-sync/run-git-sync.test.ts',
  'lib/harness/hive-repo-init.test.ts',
  'lib/harness/improvements/insight-staleness.test.ts',
  'lib/hive-git-drill-migration-freshness-guard.test.ts',
  'lib/hive-git-drill-zero-skip-guard.test.ts',
  'lib/kopia-backup-guard.test.ts',
  'lib/lint-as-committed.test.ts',
  'lib/lint-tsc-operator-help.test.ts',
  'lib/live-federation-gate-attestation-preflight.test.ts',
  'lib/live-federation-gate-fromrepo-default.test.ts',
  'lib/live-federation-gate-k3-cut-verdict.test.ts',
  'lib/live-federation-gate-matrix-leg-skip-reason.test.ts',
  'lib/live-federation-gate-matrix-leg-staleness.test.ts',
  'lib/live-federation-gate-singleton-lock-fd-inheritance.test.ts',
  'lib/llm-testing/__tests__/telemetry-tagging-audit.test.ts',
  'lib/migration-applied-text.test.ts',
  'lib/mug-kettle-census-comment-blindness.test.ts',
  'lib/mug-kettle-census-dangling-key.test.ts',
  'lib/mutation-probe-script.test.ts',
  'lib/no-bespoke-state-read-guard.test.ts',
  'lib/no-bespoke-state-read-live.test.ts',
  'lib/no-cdn-egress-guard.test.ts',
  'lib/no-retired-imports-guard.test.ts',
  'lib/no-unhosted-remote-core-guard.test.ts',
  'lib/p2p/work-distribution-drill-probe-symbols.test.ts',
  'lib/partial-index-alignment-guard.test.ts',
  'lib/release-deploy-launch.test.ts',
  'lib/release-submodule-freshness-fail-closed.test.ts',
  'lib/release/identity-gate-archive-expansion.test.ts',
  'lib/release/identity-gate-artifact-scan.test.ts',
  'lib/release/identity-gate-authorised-product-strings.test.ts',
  'lib/release/identity-gate-symlink-targets.test.ts',
  'lib/scripts-pg-url.test.ts',
  'lib/sync/pot-git/fetch-transport-idle-ceiling.test.ts',
  'lib/sync/pot-git/physical-drill-phase-a.test.ts',
  'lib/sync/pot-git/physical-drill-phase-b.test.ts',
  'lib/sync/pot-git/secrets-guard-hook-parity.test.ts',
  'lib/task-manager/no-unenrolled-spawn-guard.test.ts',
  'lib/templates-mirror-sync-cli.test.ts',
  'lib/testing-guard-script.test.ts',
  'lib/tracked-node-modules-guard.test.ts',
  'lib/turn-provenance/envelope-grammar-cross-language.test.ts',
  'lib/typescript-toolchain-contract.test.ts',
];

describe('pure lane — unbounded synchronous spawns (WI-41180 ratchet)', () => {
  it('CALIBRATION: the detector flags an unbounded call and stays silent on a bounded one', () => {
    // Inline fixtures, never a tree mutation: git-sync sweeps this shared checkout every few
    // minutes, so a probe holding a tracked file mutated can have the mutant COMMITTED with
    // nothing going wrong (CLAUDE.md, "Proving a guard is falsifiable").
    const unbounded = `execFileSync(process.execPath, [X], { encoding: 'utf8', cwd: ROOT })`;
    const bounded = `execFileSync(process.execPath, [X], { encoding: 'utf8', timeout: 120_000 })`;
    expect(countUnboundedSyncSpawns(unbounded)).toBe(1);
    expect(countUnboundedSyncSpawns(bounded)).toBe(0);

    // A `timeout:` on a LATER call must not launder an EARLIER unbounded one.
    expect(countUnboundedSyncSpawns(`${unbounded};\n${bounded};`)).toBe(1);

    // And a file with no sync spawn at all is silent — otherwise every negative below is vacuous.
    expect(countUnboundedSyncSpawns(`await execFile('git', ['status']);`)).toBe(0);
  });

  it('DENOMINATOR: the pure-lane roster actually resolved (a scan of nothing is not a pass)', () => {
    const { roster } = scanPureLane();
    // The whole class this guard belongs to fails silently toward "clean": a roster that
    // resolves to nothing prints a green that is indistinguishable from a real one.
    expect(roster.length).toBeGreaterThan(1000);
  });

  it('no NEW pure-lane file introduces an unbounded synchronous spawn', () => {
    const { offenders } = scanPureLane();
    const added = offenders.filter((f) => !BASELINE.includes(f));
    expect(
      added,
      `\nThese pure-lane test files make a synchronous child-process call with no \`timeout:\`.\n` +
        `A sync spawn blocks the worker's event loop, so vitest CANNOT time it out, and the pure\n` +
        `lane shares one fork across ~2,740 files — a block here wedges all of them until the\n` +
        `batch watchdog kills the task 45 minutes later (WI-41180).\n\n` +
        `FIX: pass \`timeout:\` (and \`killSignal: 'SIGKILL'\`) to the call.\n` +
        `Do NOT add the file to BASELINE — that list only ever shrinks.\n`,
    ).toEqual([]);
  });

  it('BASELINE is shrink-only: every grandfathered entry still has an unbounded call', () => {
    const { roster, offenders } = scanPureLane();
    const inRoster = new Set(roster);
    const stale = BASELINE.filter((f) => inRoster.has(f) && !offenders.includes(f));
    expect(
      stale,
      `\nThese files were fixed (or their calls bounded) but are still listed in BASELINE.\n` +
        `Delete them from the list so the ratchet keeps turning — a baseline that outlives its\n` +
        `offenders decays into a permanent allowlist.\n`,
    ).toEqual([]);
  });
});
