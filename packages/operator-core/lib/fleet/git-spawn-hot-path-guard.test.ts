import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * RECURRENCE GUARD for EI-18808838427010743 — the fork tax.
 *
 * ## The bug class
 *
 * `fork()` copies the calling process's page tables, so `child_process.spawn`
 * costs the CALLER ~40ms per GB of its OWN RSS, charged as synchronous system
 * time on the main thread. The bg-host runs at ~4GB, so every `git` forked from
 * it blocked the event loop ~165ms for a command git finishes in ~4ms. That
 * dead loop is what killed p2p peer sockets mid-transfer
 * (EI-18808621019872598): UDX keepalives and timers cannot fire while the loop
 * is blocked, so a multi-GB pot repo could never converge.
 *
 * ## Why a guard, and why THIS guard
 *
 * Nothing FAILS when a git seam forks locally — it just silently gets slow, and
 * the damage lands in a different subsystem (p2p transfers) than the code that
 * caused it. Silent performance regressions do not announce themselves, and
 * this one was invisible to every JS-level metric because the cost is kernel
 * time inside one synchronous call.
 *
 * The repo has ~80 `spawn('git')` sites, but the overwhelming majority are
 * one-shot CLI/gym/bootstrap paths where a single fork's cost is irrelevant. A
 * blanket ban would be pure noise and would rot into a suppressed lint. What
 * actually matters is narrow and stable: modules that run INSIDE the
 * long-lived host on a REPEATING path. Those are enumerated below, each one
 * confirmed by CPU-profile attribution on the live bg-host, and each must route
 * through the shared `fleet/git-via-sidecar` helper.
 *
 * Adding a git call to one of these modules without routing it is the exact
 * regression this catches. If a module genuinely stops being hot, remove it
 * here with a note — don't silently weaken the assertion.
 */

const LIB = join(import.meta.dirname, '..');

/** Modules that run in the long-lived host on a repeating path. */
const HOT_GIT_MODULES: { file: string; why: string }[] = [
  {
    file: 'sync/pot-git/storage.ts',
    why: 'pot-git reads refs one git-process-per-ref; callers loop over them (was 51.8% of the main thread)',
  },
  {
    file: 'harness/docs/git-runner.ts',
    why: 'the shared harness-docs GitRunner — drift `git log --name-only` per (baseline, submodule) group per doc',
  },
  {
    file: 'dev-deploy-state.ts',
    why: 'sits behind a UI-POLLED sync query and fans out to ~6 git execs per poll (2.24% of the main thread)',
  },
  {
    file: 'git-pipeline-hives.ts',
    why: 'revListCount runs per hive row inside the pipeline snapshot (0.62% of the main thread)',
  },
];

describe('hot-path git seams route through the spawner sidecar', () => {
  for (const { file, why } of HOT_GIT_MODULES) {
    it(`${file} imports the shared git-via-sidecar helper — ${why}`, () => {
      const src = readFileSync(join(LIB, file), 'utf8');
      expect(
        /from\s+['"][^'"]*fleet\/git-via-sidecar['"]/.test(src),
        `${file} runs in the long-lived host but does not import fleet/git-via-sidecar. ` +
          `Forking git from the ~4GB bg-host blocks the event loop ~165ms per call and ` +
          `kills p2p transfers. Route it through runGitViaSpawnerSidecar with a local fallback.`,
      ).toBe(true);
    });

    it(`${file} keeps a LOCAL fallback so a sidecar fault degrades perf, not correctness`, () => {
      const src = readFileSync(join(LIB, file), 'utf8');
      // Each of these modules must still contain a direct spawn/execFile path:
      // the sidecar is an optimisation, and a sidecar outage must never turn a
      // git result into a wrong answer (an absent ref, an empty drift log).
      expect(
        /spawn\(\s*['"]git['"]|execFile\(\s*['"]git['"]|pexec\(\s*['"]git['"]/.test(src),
        `${file} routes git through the sidecar but has no local fallback path. ` +
          `A sidecar outage would then change RESULTS, not just latency.`,
      ).toBe(true);
    });
  }

  it('the shared helper never caches a FAILED module load', () => {
    // A cached rejected promise would pin every future call onto the local
    // fallback for the process's whole life after one transient hiccup —
    // reintroducing the full fork tax silently and permanently.
    const src = readFileSync(join(LIB, 'fleet/git-via-sidecar.ts'), 'utf8');
    expect(src).toMatch(/sidecarModulesPromise\s*=\s*null/);
  });

  it('the shared helper memoises its dynamic imports', () => {
    // Under tsx every dynamic import() blocks on a SYNCHRONOUS ESM
    // loader-thread round-trip (makeSyncRequest). Re-importing per git call
    // would hand back a slice of the very stall this module removes.
    const src = readFileSync(join(LIB, 'fleet/git-via-sidecar.ts'), 'utf8');
    expect(src).toMatch(/if\s*\(!sidecarModulesPromise\)/);
  });
});
