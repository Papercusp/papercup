/**
 * green-checkpoint REAL-path wiring (hive-run-evaluation gap #10).
 *
 * The sibling green-checkpoint.test.ts covers the ORCHESTRATION (advance-only-
 * when-green, FF-only) with STUB deps. This covers the REAL deps
 * (realCheckpointDeps) the stub replaces — the heavy ops are shelled through an
 * injected `exec` seam (default = the spawn-backed runCmd), so the WIRING is
 * asserted WITHOUT running the suite, the SPA build, or a git push:
 *   - runGreen passes the stripped checkpoint env (GREEN_CHECKPOINT + AFFECTED_BASE)
 *     to the green command, in the checkpoint tree;
 *   - P-005: the SPA build is PART of green — a green suite + a FAILED build is
 *     NOT green, and the build break folds into the failure signature;
 *   - a red suite short-circuits (no build attempt);
 *   - setupTree invokes setup-release-checkout.sh with the right flags;
 *   - push rides the PAPERCUSP_MAIN_PUSH_OK guard (the one writer allowed past
 *     the main pre-push hook).
 * The actual FF-of-main (advance → advanceReady) is the orchestration test's
 * real-git temp-repo path; here we never touch a real branch.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realCheckpointDeps, type CheckpointExec } from './green-checkpoint';
import { releaseConfig, type ReleaseConfig } from './release-config';

interface ExecResp { code: number; stdout?: string; stderr?: string }

/** A fake exec returning programmed results in call order, recording every call. */
function makeExec(responses: ExecResp[]) {
  const calls: Array<{ cmd: string; args: string[]; opts?: { cwd?: string; env?: NodeJS.ProcessEnv; allowNonZero?: boolean } }> = [];
  let i = 0;
  const exec: CheckpointExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const r = responses[i++] ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { exec, calls };
}

// Redirect the per-run checkpoint suite-log dir to a throwaway temp dir so this
// real-deps test (which exercises runGreen's writeFileSync log-persist) NEVER
// pollutes the real ~/.papercusp/checkpoint-logs/ — fixture logs landing there
// masquerade as real checkpoint failures + mislead freeze diagnosis (2026-06-20).
const tmpLogDir = mkdtempSync(join(tmpdir(), 'green-cp-log-'));
afterAll(() => rmSync(tmpLogDir, { recursive: true, force: true }));

const cfg: ReleaseConfig = releaseConfig({
  integrationRoot: '/int',
  releaseRoot: '/int',
  checkpointRoot: '/cp',
  releaseRef: 'ready',
  integrationBranch: 'main',
  checkpointLogDir: tmpLogDir,
});
const [GREEN_CMD0, ...GREEN_ARGS] = cfg.greenCmd.split(' ');

describe('realCheckpointDeps.runGreen — real-path wiring (gap #10)', () => {
  it('green suite + clean tree + green build → green, with the stripped checkpoint env on the green command', async () => {
    // suite green → EI-1836 conflict-marker grep (code 1 = clean) → SPA build (code 0).
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen('/cp', 'base-sha');

    expect(r.green).toBe(true);
    expect(r.failingTests).toEqual([]);
    // (1) the green command ran in the checkpoint tree with the gate env wired.
    expect(calls[0].cmd).toBe(GREEN_CMD0);
    expect(calls[0].args).toEqual(GREEN_ARGS);
    expect(calls[0].opts?.cwd).toBe('/cp');
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe('1');
    expect(calls[0].opts?.env?.AFFECTED_BASE).toBe('base-sha');
    // (2) EI-1836: the conflict-marker grep ran second, in the same tree, before the build.
    expect(calls).toHaveLength(3);
    expect(calls[1].cmd).toBe('git');
    expect(calls[1].args).toContain('grep');
    expect(calls[1].opts?.cwd).toBe('/cp');
    // (3) the SPA build ran third, in the same tree (P-005 — build is part of green).
    expect(calls[2].cmd).toBe('npm');
    expect(calls[2].args).toContain('@papercusp/operator-vite');
    expect(calls[2].args).toContain('build');
    expect(calls[2].opts?.cwd).toBe('/cp');
  });

  it('P-005: green suite but FAILED SPA build → NOT green, build break in the failure signature', async () => {
    // suite green → marker grep clean (code 1) → SPA build fails (code 1).
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 1, stdout: 'vite: bundle failed' }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen('/cp', null);

    expect(r.green).toBe(false); // the key wiring: a passing suite does NOT make a broken build green
    expect(calls).toHaveLength(3); // marker grep + build WAS attempted (suite was green, tree clean)
    expect(calls[2].cmd).toBe('npm'); // the build ran (grep was clean)
    expect(r.failingTests).toContain('@papercusp/operator-vite'); // dedup signature folds the build break in
    expect(r.summary).toContain('vite: bundle failed');
  });

  it('EI-1836: green suite but COMMITTED conflict markers → NOT green, build SKIPPED, marker NAMED in the signature', async () => {
    // suite green → marker grep FINDS one (code 0 + named stdout) → the cryptic SPA
    // build is SKIPPED, the marker folds into the @papercusp/operator-vite signature.
    const markerHit = `app/globals.css:26492:${'<'.repeat(7)} Updated upstream`;
    const { exec, calls } = makeExec([{ code: 0 }, { code: 0, stdout: markerHit }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen('/cp', null);

    expect(r.green).toBe(false);
    expect(calls).toHaveLength(2); // suite + grep only — the build was NOT attempted
    expect(calls[1].cmd).toBe('git');
    expect(calls[1].args).toContain('grep');
    expect(r.failingTests).toContain('@papercusp/operator-vite'); // held + dedup like a build break
    expect(r.summary).toContain('globals.css'); // the root is NAMED, not a cryptic CssSyntaxError
  });

  it('red suite short-circuits — no SPA build attempted, suite failures in the signature', async () => {
    const { exec, calls } = makeExec([{ code: 1, stdout: 'FAIL lib/foo.test.ts\n' }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen('/cp', null);

    expect(r.green).toBe(false);
    expect(calls).toHaveLength(1); // build NOT attempted on a red suite
    expect(r.failingTests).toContain('lib/foo.test.ts');
  });

  it('no AFFECTED_BASE when base is null (full affected run)', async () => {
    // suite green → marker grep clean (code 1) → build (code 0).
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    await realCheckpointDeps(cfg, exec).runGreen('/cp', null);
    expect(calls[0].opts?.env?.AFFECTED_BASE).toBeUndefined();
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe('1');
  });

  // load-flake-isolation-2026-06-23: the real-path wiring of the isolation re-run —
  // a red suite whose failing FILES (parsed from the affected-runner output) re-run
  // GREEN at single concurrency is a load-flake, so runGreen reports green + the suspects.
  const RED_OUTPUT =
    '>>> @papercusp/operator-core :: npm run test\n' +
    ' FAIL  lib/llm-testing/__tests__/runner-aggregate.test.ts > aggregates\n' +
    ' ❯ lib/scout/scheduler-workspace-scope.test.ts (12 tests | 1 failed) 21034ms\n' +
    '2 non-quarantined task(s) failed.';

  it('load-flake: red suite, both failing files PASS in isolation → green + flakeSuspects, single-fork env', async () => {
    // call 0: green command (red suite). call 1: isolation re-run of file #1 (pass).
    // call 2: isolation re-run of file #2 (pass). No build runs (it only runs on a
    // suite that was green from the start: r.code === 0).
    const { exec, calls } = makeExec([{ code: 1, stdout: RED_OUTPUT }, { code: 0 }, { code: 0 }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen('/cp', 'base-sha');

    expect(r.green).toBe(true); // absorbed: both files passed in isolation
    expect(r.flakeSuspects).toEqual([
      '@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts',
      '@papercusp/operator-core::lib/scout/scheduler-workspace-scope.test.ts',
    ]);
    // exactly the suite + 2 isolation re-runs — no SPA build (the suite started red).
    expect(calls).toHaveLength(3);
    // the isolation re-runs are `npm run test --workspace <ws> -- --no-file-parallelism <file>`
    // at SINGLE concurrency, in the checkpoint tree, with the stripped gate env.
    for (const c of calls.slice(1)) {
      expect(c.cmd).toBe('npm');
      expect(c.args.slice(0, 4)).toEqual(['run', 'test', '--workspace', '@papercusp/operator-core']);
      expect(c.args).toContain('--no-file-parallelism');
      expect(c.opts?.cwd).toBe('/cp');
      expect(c.opts?.env?.VITEST_MAX_FORKS).toBe('1');
      expect(c.opts?.env?.VITEST_MAX_THREADS).toBe('1');
      expect(c.opts?.env?.GREEN_CHECKPOINT).toBe('1');
    }
    expect(calls[1].args).toContain('lib/llm-testing/__tests__/runner-aggregate.test.ts');
    expect(calls[2].args).toContain('lib/scout/scheduler-workspace-scope.test.ts');
  });

  it('real break: red suite where ONE file still fails in isolation → stays NOT green', async () => {
    // call 0: red suite. call 1: file #1 re-run PASSES. call 2: file #2 re-run FAILS.
    const { exec } = makeExec([{ code: 1, stdout: RED_OUTPUT }, { code: 0 }, { code: 1 }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen('/cp', null);

    expect(r.green).toBe(false); // a real deterministic break is NEVER hidden
    expect(r.flakeSuspects).toBeUndefined();
    // the suite signature still names the failing files (from the FAIL row) for the
    // release-fixer dedup — extractFailingTests reads `FAIL <file>` + `>>> <ws> FAILED`.
    expect(r.failingTests).toContain('lib/llm-testing/__tests__/runner-aggregate.test.ts');
  });

  it('fail-safe: an isolation re-run that THROWS leaves the gate red (no false green)', async () => {
    // A red suite with one parseable failing file; the isolation exec throws.
    let i = 0;
    const throwingExec: CheckpointExec = async (cmd, _args, _opts) => {
      i++;
      if (i === 1) return { code: 1, stdout: '>>> @papercusp/x :: npm run test\n FAIL  lib/a.test.ts > c', stderr: '' };
      throw new Error('vitest spawn ENOMEM'); // the isolation re-run itself errors
    };
    const r = await realCheckpointDeps(cfg, throwingExec).runGreen('/cp', null);
    expect(r.green).toBe(false);
    expect(r.flakeSuspects).toBeUndefined();
  });
});

describe('realCheckpointDeps.setupTree / push — real-path wiring (gap #10)', () => {
  it('setupTree shells setup-release-checkout.sh with the integration/checkpoint/ref flags', async () => {
    const { exec, calls } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).setupTree('cand123');
    expect(calls[0].cmd).toBe('bash');
    expect(calls[0].args[0].endsWith('apps/operator/bin/release/setup-release-checkout.sh')).toBe(true);
    expect(calls[0].args).toEqual(
      // `force` (not `auto`): the checkpoint tree must always re-copy node_modules — the
      // `auto` heuristic is blind to nested-dep drift and spuriously red the gate (EI-2699).
      expect.arrayContaining(['--ref', 'cand123', '--integration', '/int', '--release', '/cp', '--node-modules', 'force']),
    );
  });

  it('push rides the PAPERCUSP_MAIN_PUSH_OK guard (the one writer allowed past the main pre-push hook)', async () => {
    const { exec, calls } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).push('ready');
    expect(calls[0].cmd).toBe('git');
    expect(calls[0].args).toEqual(['-C', '/int', 'push', 'origin', 'ready:ready']);
    expect(calls[0].opts?.env?.PAPERCUSP_MAIN_PUSH_OK).toBe('1');
  });
});
