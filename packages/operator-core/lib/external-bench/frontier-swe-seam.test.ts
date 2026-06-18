import { describe, it, expect } from 'vitest';
import type { BenchTask } from './types';
import type { ProcExec } from './grader/swe-bench-pro';
import { makeFrontierSweCloneGradeSeam, type FrontierSweEnvHandle } from './frontier-swe-seam';

function task(over: Record<string, unknown> = {}): BenchTask {
  return {
    benchmark: 'frontier-swe',
    instanceId: 'cranelift-codegen-opt',
    problemStatement: 'x',
    graderMeta: {
      dockerImage: 'ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6',
      gpus: 0,
      verifierCmd: 'bash /tests/test.sh',
      rewardPath: '/logs/verifier/reward.txt',
      rewardJsonPath: '/logs/verifier/reward.json',
      ...over,
    },
  };
}

/**
 * Fake docker. `run` → emits a container id; `exec … cat <path>` → the file at that path; `exec … bash` (the
 * verifier) → code 0; `rm` → per `rmFails`. Records every invocation for assertions.
 */
function fakeDocker(files: Record<string, string>, opts: { runCode?: number; rmFails?: boolean } = {}) {
  const calls: string[][] = [];
  const exec: ProcExec = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'run') return { stdout: opts.runCode ? '' : 'deadbeefcafe\n', stderr: opts.runCode ? 'boom' : '', code: opts.runCode ?? 0 };
    if (args[0] === 'rm') {
      if (opts.rmFails) throw new Error('docker rm failed');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'exec') {
      const isCat = args.includes('cat');
      if (isCat) {
        const path = args[args.length - 1];
        return path in files ? { stdout: files[path], stderr: '', code: 0 } : { stdout: '', stderr: 'no file', code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 }; // the verifier run
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  return { exec, calls };
}

describe('makeFrontierSweCloneGradeSeam', () => {
  it('is an in-container seam', () => {
    const { exec } = fakeDocker({});
    expect(makeFrontierSweCloneGradeSeam({ version: 'v', exec }).modality).toBe('in-container');
  });

  it('clone runs the image detached and returns the container handle', async () => {
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    const h = await seam.clone(task());
    expect(h.containerId).toBe('deadbeefcafe');
    expect(h.image).toContain('cranelift-codegen-opt');
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toContain('sleep');
    expect(run).not.toContain('--gpus'); // CPU task
  });

  it('clone adds --gpus all for GPU tasks', async () => {
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    await seam.clone(task({ gpus: 1, gpuTypes: ['H100'] }));
    expect(calls.find((c) => c[0] === 'run')).toContain('--gpus');
  });

  it('clone throws on a missing image or a failed docker run', async () => {
    const { exec } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    await expect(seam.clone(task({ dockerImage: undefined }))).rejects.toThrow(/no dockerImage/);
    const failing = fakeDocker({}, { runCode: 1 });
    await expect(makeFrontierSweCloneGradeSeam({ version: 'v', exec: failing.exec }).clone(task())).rejects.toThrow(/docker run failed/);
  });

  it('grade runs the task verifier and reads the [0,1] reward → continuous score', async () => {
    const { exec } = fakeDocker({ '/logs/verifier/reward.txt': '0.62\n' });
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    const h: FrontierSweEnvHandle = { containerId: 'cid', image: 'img', instanceId: 'cranelift-codegen-opt' };
    const g = await seam.grade(task(), h);
    expect(g.score).toBe(0.62);
    expect(g.resolved).toBe(false);
    expect(g.graderStatus).toBe('failed');
  });

  it('grade maps a full score to resolved/passed', async () => {
    const { exec } = fakeDocker({ '/logs/verifier/reward.txt': '1.0' });
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    const g = await seam.grade(task(), { containerId: 'cid', image: 'i', instanceId: 'cranelift-codegen-opt' });
    expect(g.resolved).toBe(true);
    expect(g.graderStatus).toBe('passed');
  });

  it('grade surfaces an absent reward as an infra error (graderStatus=error, score null) — never a silent 0', async () => {
    const { exec } = fakeDocker({}); // no reward files
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    const g = await seam.grade(task(), { containerId: 'cid', image: 'i', instanceId: 'cranelift-codegen-opt' });
    expect(g.score).toBeNull();
    expect(g.resolved).toBeNull();
    expect(g.graderStatus).toBe('error');
  });

  it('grade stages tests/ into the container at GRADE time (anti-cheat: the agent never saw /tests)', async () => {
    const { exec, calls } = fakeDocker({ '/logs/verifier/reward.txt': '0.4' });
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, repoDir: '/vendor/frontier-swe' });
    await seam.grade(task(), { containerId: 'cid', image: 'i', instanceId: 'cranelift-codegen-opt' });
    expect(calls.find((c) => c[0] === 'cp')).toEqual(['cp', '/vendor/frontier-swe/tasks/cranelift-codegen-opt/tests', 'cid:/tests']);
  });

  it('oracle mode also stages solution/ (the gold positive control)', async () => {
    const { exec, calls } = fakeDocker({ '/logs/verifier/reward.txt': '1.0' });
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, repoDir: '/vendor/frontier-swe', oracle: true });
    await seam.grade(task(), { containerId: 'cid', image: 'i', instanceId: 'cranelift-codegen-opt' });
    expect(calls.some((c) => c[0] === 'cp' && c[2] === 'cid:/solution')).toBe(true);
  });

  it('clone does NOT stage tests/ (they must be hidden from the agent until grade time)', async () => {
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, repoDir: '/vendor/frontier-swe' });
    await seam.clone(task());
    expect(calls.find((c) => c[0] === 'cp')).toBeUndefined();
  });

  it('teardown removes the container and never throws', async () => {
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    await seam.teardown({ containerId: 'cid', image: 'i', instanceId: 't' });
    expect(calls.find((c) => c[0] === 'rm')).toEqual(['rm', '-f', 'cid']);
    // a failing rm is swallowed
    const failing = fakeDocker({}, { rmFails: true });
    await expect(
      makeFrontierSweCloneGradeSeam({ version: 'v', exec: failing.exec }).teardown({ containerId: 'cid', image: 'i', instanceId: 't' }),
    ).resolves.toBeUndefined();
  });
});
