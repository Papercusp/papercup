import { describe, it, expect } from 'vitest';
import type { BenchTask } from './types';
import type { ProcExec } from './grader/swe-bench-pro';
import { checkFrontierSweIntegrity, makeFrontierSweCloneGradeSeam, type FrontierSweEnvHandle } from './frontier-swe-seam';

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
      if (args.includes('test')) {
        // `test -e|-d <path>` → exit 0 present / 1 absent (the reader distinguishes absent from empty).
        const path = args[args.length - 1];
        const flag = args[args.length - 2];
        const isDir = Object.keys(files).some((f) => f.startsWith(`${path.replace(/\/+$/, '')}/`));
        const present = flag === '-d' ? isDir : path in files || isDir;
        return { stdout: '', stderr: '', code: present ? 0 : 1 };
      }
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

  it('an oracle clone puts HARBOR_ORACLE_FLAG in the container env at `docker run` so the image entrypoint runs its oracle stage', async () => {
    const { exec, calls } = fakeDocker({});
    await makeFrontierSweCloneGradeSeam({ version: 'v', exec, oracle: true, oracleFlag: 'f00dfeed' }).clone(task());
    const run = calls.find((c) => c[0] === 'run')!;
    const i = run.indexOf('HARBOR_ORACLE_FLAG=f00dfeed');
    expect(i).toBeGreaterThan(0);
    expect(run[i - 1]).toBe('-e');
    expect(i).toBeLessThan(run.indexOf('sleep')); // a `docker run` option, not an argument to the command
  });

  it('a non-oracle clone (agent rollout / empty control) never carries the oracle flag, even if one is configured', async () => {
    for (const cfg of [{}, { oracle: false, oracleFlag: 'f00dfeed' }, { oracle: true }]) {
      const { exec, calls } = fakeDocker({});
      await makeFrontierSweCloneGradeSeam({ version: 'v', exec, ...cfg }).clone(task());
      expect(calls.find((c) => c[0] === 'run')!.join(' ')).not.toContain('HARBOR_ORACLE');
    }
  });

  describe('agent-container network policy (WI-6554700010008591)', () => {
    const runOf = async (over: Record<string, unknown>, cfg: { allowlistNetwork?: string } = {}) => {
      const { exec, calls } = fakeDocker({});
      await makeFrontierSweCloneGradeSeam({ version: 'v', exec, ...cfg }).clone(task(over));
      return calls.find((c) => c[0] === 'run')!;
    };
    /** The value of a `docker run` option, asserting it precedes the image (an option, not a command argument). */
    const optionValue = (run: string[], flag: string, image = 'ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6') => {
      const i = run.indexOf(flag);
      if (i < 0) return undefined;
      expect(i).toBeLessThan(run.indexOf(image));
      return run[i + 1];
    };

    it("a v2 'no-network' task's agent container has no network", async () => {
      const run = await runOf({ networkMode: 'no-network' });
      expect(optionValue(run, '--network')).toBe('none');
      expect(run).toContain('PX_TASK_NETWORK_MODE=no-network');
    });

    it("a v2 'allowlist' task gets NO egress by default — the host-side model loop needs no model host in the container", async () => {
      const run = await runOf({ networkMode: 'allowlist' });
      expect(optionValue(run, '--network')).toBe('none');
      expect(run).toContain('PX_TASK_NETWORK_MODE=allowlist');
    });

    it("an arm that runs its model client in-container attaches the supplied egress-restricted network for 'allowlist'", async () => {
      const run = await runOf({ networkMode: 'allowlist' }, { allowlistNetwork: 'bench-model-egress' });
      expect(optionValue(run, '--network')).toBe('bench-model-egress');
      // ...but never for a 'no-network' task: the allowlist network is still egress.
      const offline = await runOf({ networkMode: 'no-network' }, { allowlistNetwork: 'bench-model-egress' });
      expect(optionValue(offline, '--network')).toBe('none');
    });

    it('a task with no declared mode (v1 history) keeps its historical run: no network flag, no PX_TASK env', async () => {
      for (const over of [{}, { networkMode: null }]) {
        const run = await runOf(over);
        expect(run).not.toContain('--network');
        expect(run.join(' ')).not.toContain('PX_TASK_NETWORK_MODE');
      }
    });

    it('fails CLOSED: an unknown or malformed declared mode throws and never starts an unrestricted container', async () => {
      for (const networkMode of ['public', 'host', '', 7]) {
        const { exec, calls } = fakeDocker({});
        await expect(makeFrontierSweCloneGradeSeam({ version: 'v', exec }).clone(task({ networkMode }))).rejects.toThrow(/network/);
        expect(calls.some((c) => c[0] === 'run')).toBe(false);
      }
    });

    it('refuses extraRunArgs that would override the network policy', () => {
      const { exec } = fakeDocker({});
      for (const flag of [['--network', 'host'], ['--network=bridge'], ['--net', 'host'], ['--net=host']]) {
        expect(() => makeFrontierSweCloneGradeSeam({ version: 'v', exec, extraRunArgs: ['--cpus', '8', ...flag] })).toThrow(/network/);
      }
      // A non-network flag that merely contains the substring is fine.
      expect(() => makeFrontierSweCloneGradeSeam({ version: 'v', exec, extraRunArgs: ['--network-alias', 'x'] })).not.toThrow();
    });
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

describe('checkFrontierSweIntegrity — oracle mode (the gold control, P-007)', () => {
  /** A docker stub whose `diff` reports exactly what Harbor's oracle stage writes: /solution plus the /app marker. */
  function diffExec(lines: string[]): ProcExec {
    return async (_cmd, args) =>
      args[0] === 'diff' ? { stdout: `${lines.join('\n')}\n`, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 };
  }
  const oracleWrites = ['A /solution', 'A /solution/solve.sh', 'C /app', 'A /app/.harbor_oracle_marker'];

  it('oracle mode tolerates the staged /solution (Harbor uploads it before running solve.sh)', async () => {
    const r = await checkFrontierSweIntegrity(diffExec(oracleWrites), task(), 'cid', { oracle: true });
    expect(r.verdict).toBe('clean');
    expect(r.protectedPaths).not.toContain('/solution');
  });

  it('a non-oracle run that writes /solution is still tampered', async () => {
    const r = await checkFrontierSweIntegrity(diffExec(oracleWrites), task(), 'cid');
    expect(r.verdict).toBe('tampered');
    expect(r.protectedPaths).toContain('/solution');
  });

  it('oracle mode keeps every OTHER protected path protected', async () => {
    const r = await checkFrontierSweIntegrity(diffExec([...oracleWrites, 'A /logs/verifier/reward.txt']), task(), 'cid', { oracle: true });
    expect(r.verdict).toBe('tampered');
  });
});
