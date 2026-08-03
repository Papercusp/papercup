import { describe, expect, it, vi } from 'vitest';
import {
  createGitGrepDeps,
  gitGrepFiles,
  isEvidencePath,
  type ExecRunner,
} from './code-search-deps';
import { probeCodeExistence } from './code-existence-probe';

function runner(outcome: { stdout?: string; code: number }): ExecRunner {
  return async () => ({ stdout: outcome.stdout ?? '', code: outcome.code });
}

const CWD = '/repo';

describe('gitGrepFiles exit-code semantics', () => {
  it('exit 0 with paths is a hit', async () => {
    const files = await gitGrepFiles('watchdogKey', {
      cwd: CWD,
      exec: runner({ stdout: 'a.ts\nb.ts\n', code: 0 }),
    });
    expect(files).toEqual(['a.ts', 'b.ts']);
  });

  it('THE CORE DISTINCTION: exit 1 is an honest MISS, not a failure', async () => {
    // git grep exits 1 when it finds nothing. Reporting that as an error would
    // turn every genuine miss into a phantom probe outage.
    await expect(
      gitGrepFiles('nothingHere', { cwd: CWD, exec: runner({ code: 1 }) }),
    ).resolves.toEqual([]);
  });

  it('THE CORE DISTINCTION: exit 2 is a real FAILURE and must throw', async () => {
    // Returning [] here would report an outage as "no prior art exists" — the
    // exact false negative the probe exists to prevent.
    await expect(
      gitGrepFiles('anything', { cwd: CWD, exec: runner({ code: 2 }) }),
    ).rejects.toThrow(/exit 2/);
  });

  it('propagates a runner rejection (timeout / killed) rather than swallowing it', async () => {
    const killed: ExecRunner = async () => {
      throw new Error('ETIMEDOUT');
    };
    await expect(gitGrepFiles('x', { cwd: CWD, exec: killed })).rejects.toThrow(/ETIMEDOUT/);
  });

  it('does not search for a blank term', async () => {
    const exec = vi.fn(runner({ code: 0 }));
    await expect(gitGrepFiles('   ', { cwd: CWD, exec })).resolves.toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('caps the returned path count', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `f${i}.ts`).join('\n');
    const files = await gitGrepFiles('common', {
      cwd: CWD,
      maxFiles: 5,
      exec: runner({ stdout: many, code: 0 }),
    });
    expect(files).toHaveLength(5);
  });
});

describe('isEvidencePath — every exclusion is a measured false positive', () => {
  it('rejects the screening module\'s OWN files (self-contamination)', () => {
    // The worst mode: documenting an idea id as an example inside this module
    // made the module report that idea as already-implemented. EI-7650 and
    // EI-7652 were recommended DROP when these were the only two files citing
    // them. A screen must not be able to manufacture its own evidence.
    expect(isEvidencePath('packages/operator-core/lib/scout/idea-cluster-screen.ts')).toBe(false);
    expect(isEvidencePath('packages/operator-core/lib/scout/idea-cluster-screen.test.ts')).toBe(false);
    expect(isEvidencePath('packages/operator-core/lib/scout/code-existence-probe.ts')).toBe(false);
  });

  it('keeps OTHER scout files admissible — the exclusion is surgical, not a blanket', () => {
    // Blanket-excluding lib/scout would hide genuine Scout implementations.
    expect(isEvidencePath('packages/operator-core/lib/scout/novelty-precheck.ts')).toBe(true);
    expect(isEvidencePath('packages/operator-core/lib/scout/success-metrics.ts')).toBe(true);
  });

  it('rejects agent memory dumps, scratchpads and generated docs', () => {
    expect(isEvidencePath('.papercusp/memory/raw.md')).toBe(false); // WI-2497's only hit
    expect(isEvidencePath('scratchpad/lexicon-audit-2026-07-09/REPORT.md')).toBe(false); // WI-2890's
    expect(isEvidencePath('apps/operator/public/internal/docs/llms-full.txt')).toBe(false);
  });

  it('rejects prose but keeps real source', () => {
    // An idea DISCUSSED in a doc is not an idea BUILT — the distinction the
    // whole self-id leg turns on.
    expect(isEvidencePath('docs/plans/some-plan.md')).toBe(false);
    expect(isEvidencePath('packages/operator-core/lib/plan-items/assignments.ts')).toBe(true);
    expect(isEvidencePath('apps/operator-vite/src/components/adv/Thing.tsx')).toBe(true);
  });

  it('filters non-evidence paths out of a real search result', async () => {
    const files = await gitGrepFiles('EI-7650', {
      cwd: CWD,
      exec: runner({
        stdout: [
          'packages/operator-core/lib/scout/idea-cluster-screen.ts',
          '.papercusp/memory/raw.md',
          'packages/operator-core/lib/plan-items/assignments.ts',
        ].join('\n'),
        code: 0,
      }),
    });
    expect(files).toEqual(['packages/operator-core/lib/plan-items/assignments.ts']);
  });

  it('a result that is ENTIRELY non-evidence becomes an empty hit, not a false positive', async () => {
    const files = await gitGrepFiles('WI-2497', {
      cwd: CWD,
      exec: runner({ stdout: '.papercusp/memory/raw.md\n', code: 0 }),
    });
    expect(files).toEqual([]);
  });
});

describe('gitGrepFiles argv safety', () => {
  it('passes the term as a literal after -e, never as a flag', async () => {
    // Terms come from idea PROSE. A term starting with "-" must not be parsed
    // as an option, and must not be treated as a regex.
    let seen: string[] = [];
    const exec: ExecRunner = async (_file, args) => {
      seen = args;
      return { stdout: '', code: 1 };
    };
    await gitGrepFiles('--output=/tmp/pwned', { cwd: CWD, exec });

    expect(seen).toContain('-F'); // fixed string, not a regex
    const eIdx = seen.indexOf('-e');
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(seen[eIdx + 1]).toBe('--output=/tmp/pwned'); // the term, as a value
    expect(seen[seen.length - 1]).toBe('--'); // nothing after can be read as a path/flag
  });

  it('invokes git via argv, never a shell string', async () => {
    let file = '';
    const exec: ExecRunner = async (f) => {
      file = f;
      return { stdout: '', code: 1 };
    };
    await gitGrepFiles('term', { cwd: CWD, exec });
    expect(file).toBe('git');
  });
});

describe('createGitGrepDeps memoisation', () => {
  it('greps a repeated term only once', async () => {
    // Cluster members are near-duplicates, so terms recur heavily within one
    // cluster; without this a 10-member cluster runs 10x the greps.
    const exec = vi.fn(runner({ stdout: 'a.ts', code: 0 }));
    const deps = createGitGrepDeps({ cwd: CWD, exec });

    await Promise.all([deps.search('term'), deps.search('term'), deps.search('term')]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('caches the FAILURE too, so one report cannot see two different answers', async () => {
    const exec = vi.fn(runner({ code: 2 }));
    const deps = createGitGrepDeps({ cwd: CWD, exec });

    await expect(deps.search('t')).rejects.toThrow();
    await expect(deps.search('t')).rejects.toThrow();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('only exposes searchSemantic when one was supplied', () => {
    expect(createGitGrepDeps({ cwd: CWD }).searchSemantic).toBeUndefined();
    expect(
      createGitGrepDeps({ cwd: CWD, searchSemantic: async () => [] }).searchSemantic,
    ).toBeTypeOf('function');
  });
});

describe('END-TO-END with the probe: an outage never reads as "no prior art"', () => {
  const BODY = 'The proposed dedup key lives in `watchdogSignature`, see lib/scout/x.ts.';

  it('a git-grep FAILURE yields searched:false', async () => {
    const deps = createGitGrepDeps({ cwd: CWD, exec: runner({ code: 128 }) });
    const report = await probeCodeExistence(BODY, deps);

    expect(report.searched).toBe(false);
    expect(report.matches).toEqual([]);
    expect(report.unavailableReason).toMatch(/exit 128/);
  });

  it('a genuine MISS yields searched:true with no matches — distinguishable from the above', async () => {
    const deps = createGitGrepDeps({ cwd: CWD, exec: runner({ code: 1 }) });
    const report = await probeCodeExistence(BODY, deps);

    expect(report.searched).toBe(true);
    expect(report.matches).toEqual([]);
  });

  it('CALIBRATION: the two cases above really are distinguishable', async () => {
    // If `searched` ever became a constant, both tests above would still pass
    // individually. This asserts the field actually discriminates.
    const fail = await probeCodeExistence(BODY, createGitGrepDeps({ cwd: CWD, exec: runner({ code: 128 }) }));
    const miss = await probeCodeExistence(BODY, createGitGrepDeps({ cwd: CWD, exec: runner({ code: 1 }) }));
    expect(fail.searched).not.toBe(miss.searched);
  });
});
