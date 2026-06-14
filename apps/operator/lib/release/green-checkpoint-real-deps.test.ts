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
import { describe, it, expect } from 'vitest';
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

const cfg: ReleaseConfig = releaseConfig({
  integrationRoot: '/int',
  releaseRoot: '/int',
  checkpointRoot: '/cp',
  releaseRef: 'ready',
  integrationBranch: 'main',
});
const [GREEN_CMD0, ...GREEN_ARGS] = cfg.greenCmd.split(' ');

describe('realCheckpointDeps.runGreen — real-path wiring (gap #10)', () => {
  it('green suite + green build → green, with the stripped checkpoint env on the green command', async () => {
    const { exec, calls } = makeExec([{ code: 0 }, { code: 0 }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen('/cp', 'base-sha');

    expect(r.green).toBe(true);
    expect(r.failingTests).toEqual([]);
    // (1) the green command ran in the checkpoint tree with the gate env wired.
    expect(calls[0].cmd).toBe(GREEN_CMD0);
    expect(calls[0].args).toEqual(GREEN_ARGS);
    expect(calls[0].opts?.cwd).toBe('/cp');
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe('1');
    expect(calls[0].opts?.env?.AFFECTED_BASE).toBe('base-sha');
    // (2) the SPA build ran second, in the same tree (P-005 — build is part of green).
    expect(calls).toHaveLength(2);
    expect(calls[1].cmd).toBe('npm');
    expect(calls[1].args).toContain('@papercusp/operator-vite');
    expect(calls[1].args).toContain('build');
    expect(calls[1].opts?.cwd).toBe('/cp');
  });

  it('P-005: green suite but FAILED SPA build → NOT green, build break in the failure signature', async () => {
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1, stdout: 'vite: bundle failed' }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen('/cp', null);

    expect(r.green).toBe(false); // the key wiring: a passing suite does NOT make a broken build green
    expect(calls).toHaveLength(2); // build WAS attempted (suite was green)
    expect(r.failingTests).toContain('@papercusp/operator-vite'); // dedup signature folds the build break in
    expect(r.summary).toContain('vite: bundle failed');
  });

  it('red suite short-circuits — no SPA build attempted, suite failures in the signature', async () => {
    const { exec, calls } = makeExec([{ code: 1, stdout: 'FAIL lib/foo.test.ts\n' }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen('/cp', null);

    expect(r.green).toBe(false);
    expect(calls).toHaveLength(1); // build NOT attempted on a red suite
    expect(r.failingTests).toContain('lib/foo.test.ts');
  });

  it('no AFFECTED_BASE when base is null (full affected run)', async () => {
    const { exec, calls } = makeExec([{ code: 0 }, { code: 0 }]);
    await realCheckpointDeps(cfg, exec).runGreen('/cp', null);
    expect(calls[0].opts?.env?.AFFECTED_BASE).toBeUndefined();
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe('1');
  });
});

describe('realCheckpointDeps.setupTree / push — real-path wiring (gap #10)', () => {
  it('setupTree shells setup-release-checkout.sh with the integration/checkpoint/ref flags', async () => {
    const { exec, calls } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).setupTree('cand123');
    expect(calls[0].cmd).toBe('bash');
    expect(calls[0].args[0].endsWith('apps/operator/bin/release/setup-release-checkout.sh')).toBe(true);
    expect(calls[0].args).toEqual(
      expect.arrayContaining(['--ref', 'cand123', '--integration', '/int', '--release', '/cp', '--node-modules', 'auto']),
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
