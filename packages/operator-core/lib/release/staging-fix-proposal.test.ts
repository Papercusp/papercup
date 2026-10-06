/**
 * P-007 / R-6 (gate-throughput-shift-left-2026-10-06, D-003): staging fixes for failing legs are
 * PROPOSED pre-checked, never auto-admitted. Fake git history + a fake pre-check runner.
 */
import { describe, expect, it, vi } from 'vitest';

const admitSpy = vi.hoisted(() => vi.fn());
vi.mock('./repair-head-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repair-head-admission')>()),
  admitPathsOntoRepairHead: admitSpy,
}));

import type { FixPrecheckRunner } from './admission-fix-precheck';
import {
  chooseProposalPaths,
  createStagingFixProposalDeps,
  proposeStagingFixes,
  type DryRunAdmissionResult,
  type StagingCommitTouch,
  type StagingFixProposalDeps,
} from './staging-fix-proposal';

const CANDIDATE = 'a'.repeat(40);
const REPAIR_HEAD = 'c'.repeat(40);
const TIP = 'e'.repeat(40);
const BUILT = 'b'.repeat(40);
const RED = 'lib/x/red.test.ts';
const SRC = 'lib/x/red.ts';

const leg = (files: string[] = [RED], extra: Array<{ kind: 'lint-leg'; id: string }> = []) => ({
  leg: 'operator-core::test',
  signature: [...files.map((id) => ({ kind: 'test-file' as const, id })), ...extra],
});

function fakeDeps(over: {
  commits?: StagingCommitTouch[];
  build?: (paths: readonly string[]) => DryRunAdmissionResult;
  precheck?: FixPrecheckRunner;
}): StagingFixProposalDeps & { admitPublish: ReturnType<typeof vi.fn> } {
  const admitPublish = vi.fn();
  return {
    commitsTouching: vi.fn(async () => over.commits ?? [{ sha: '1'.repeat(40), paths: [RED, SRC] }]),
    buildDryRunAdmission: vi.fn(async ({ paths }) =>
      over.build ? over.build(paths) : { ok: true as const, commit: BUILT, diff: [...paths] },
    ),
    precheck:
      over.precheck ??
      (async ({ commit, files }) => ({ ran: true, commit, results: files.map((path) => ({ path, status: 'pass' as const })) })),
    // Not part of the seam on purpose: present only so a test can prove nothing ever reaches it.
    admitPublish,
  };
}

const input = (legs = [leg()]) => ({ candidate: CANDIDATE, repairHead: REPAIR_HEAD, tip: TIP, legs });

describe('proposeStagingFixes — R-6', () => {
  it('passing fix: surfaces a ready one-call admission pinned to the tip, naming what it fixes', async () => {
    const deps = fakeDeps({});
    const r = await proposeStagingFixes(input(), deps);
    expect(r.notSurfaced).toEqual([]);
    expect(r.ready).toHaveLength(1);
    expect(r.ready[0]).toMatchObject({
      leg: 'operator-core::test',
      paths: [RED, SRC],
      fixes: [RED],
      stillFailing: [],
      builtCommit: BUILT,
      admitCall: {
        op: 'admit',
        paths: [RED, SRC],
        wholeBlob: true,
        sourceCommit: TIP,
        expectedCandidate: CANDIDATE,
        expectedRepairHead: REPAIR_HEAD,
        confirm: true,
      },
    });
    expect(r.ready[0]!.admitCall.reason).toMatch(/pre-check passed/);
    // The pre-check measured the built (unpublished) admission commit.
    expect(deps.buildDryRunAdmission).toHaveBeenCalledWith({ paths: [RED, SRC], sourceCommit: TIP });
  });

  it('failing fix: a deliberately bad fix (signature still red) is NOT surfaced', async () => {
    const deps = fakeDeps({
      precheck: async ({ commit, files }) => ({
        ran: true,
        commit,
        results: files.map((path) => ({ path, status: 'fail' as const })),
      }),
    });
    const r = await proposeStagingFixes(input(), deps);
    expect(r.ready).toEqual([]);
    expect(r.notSurfaced).toEqual([expect.objectContaining({ reason: 'precheck-failed', paths: [RED, SRC] })]);
  });

  it('failing fix: a fix that imports a new red test file is NOT surfaced', async () => {
    const OTHER = 'lib/x/other.test.ts';
    const deps = fakeDeps({
      commits: [{ sha: '1'.repeat(40), paths: [RED, OTHER] }],
      precheck: async ({ commit, files }) => ({
        ran: true,
        commit,
        results: files.map((path) => ({ path, status: path === OTHER ? ('fail' as const) : ('pass' as const) })),
      }),
    });
    const r = await proposeStagingFixes(input(), deps);
    expect(r.ready).toEqual([]);
    expect(r.notSurfaced[0]).toMatchObject({ reason: 'precheck-failed' });
    expect(r.notSurfaced[0]!.detail).toMatch(/admission-imports-red/);
  });

  it('unmeasured pre-check: an unmeasured file is never surfaced as passing', async () => {
    const SECOND = 'lib/x/second.test.ts';
    const deps = fakeDeps({
      commits: [{ sha: '1'.repeat(40), paths: [RED, SECOND] }],
      precheck: async ({ commit, files }) => ({
        ran: true,
        commit,
        results: files.map((path) =>
          path === SECOND ? { path, status: 'unmeasured' as const, detail: 'matched=0' } : { path, status: 'pass' as const },
        ),
      }),
    });
    const r = await proposeStagingFixes(input([leg([RED, SECOND])]), deps);
    expect(r.ready).toEqual([]);
    expect(r.notSurfaced[0]).toMatchObject({ reason: 'precheck-unmeasured' });
  });

  it('unmeasured pre-check: a runner that did not run (busy tree / runner failure) is not surfaced', async () => {
    for (const run of [
      { ran: false as const, reason: 'checkpoint-tree-busy' as const, detail: 'gate running' },
      { ran: false as const, reason: 'runner-failed' as const, detail: 'spawn ENOENT' },
    ]) {
      const r = await proposeStagingFixes(input(), fakeDeps({ precheck: async () => run }));
      expect(r.ready).toEqual([]);
      expect(r.notSurfaced[0]).toMatchObject({ reason: 'precheck-not-run' });
    }
  });

  it('no candidate commits: nothing touched the failing files since the freeze', async () => {
    const deps = fakeDeps({ commits: [] });
    const r = await proposeStagingFixes(input(), deps);
    expect(r.ready).toEqual([]);
    expect(r.notSurfaced).toEqual([expect.objectContaining({ reason: 'no-candidate-commits' })]);
    expect(deps.buildDryRunAdmission).not.toHaveBeenCalled();
  });

  it('a leg with no test-file signature cannot be proved by a pre-check and is not surfaced', async () => {
    const deps = fakeDeps({});
    const r = await proposeStagingFixes(input([{ leg: 'lint:tsc', signature: [{ kind: 'lint-leg', id: 'lint:tsc' }] }]), deps);
    expect(r.notSurfaced).toEqual([expect.objectContaining({ reason: 'no-measurable-signature' })]);
    expect(deps.commitsTouching).not.toHaveBeenCalled();
  });

  it('admission-incomplete adds the named imports present at the tip and rebuilds (bounded)', async () => {
    const DEP = 'lib/x/helper.ts';
    const build = vi.fn((paths: readonly string[]): DryRunAdmissionResult =>
      paths.includes(DEP)
        ? { ok: true, commit: BUILT, diff: [...paths] }
        : { ok: false, code: 'admission-incomplete', detail: 'missing helper', missing: [{ wanted: DEP, atProbeRef: 'present' }] },
    );
    const r = await proposeStagingFixes(input(), fakeDeps({ build }));
    expect(build).toHaveBeenCalledTimes(2);
    expect(r.ready[0]!.paths).toEqual([RED, SRC, DEP]);
  });

  it('an admission refusal that cannot be completed is reported, not surfaced', async () => {
    const r = await proposeStagingFixes(
      input(),
      fakeDeps({ build: () => ({ ok: false, code: 'admission-incomplete', detail: 'x', missing: [{ wanted: 'gone.ts', atProbeRef: 'absent' }] }) }),
    );
    expect(r.ready).toEqual([]);
    expect(r.notSurfaced[0]).toMatchObject({ reason: 'admission-refused' });
  });

  it('a proposal over the path cap is reported too-wide and never built', async () => {
    const many = Array.from({ length: 5 }, (_, i) => `lib/x/f${i}.ts`);
    const deps = fakeDeps({ commits: [{ sha: '1'.repeat(40), paths: [RED, ...many] }] });
    const r = await proposeStagingFixes({ ...input(), maxPaths: 3, sweepThreshold: 100 }, deps);
    expect(r.notSurfaced[0]).toMatchObject({ reason: 'too-wide' });
    expect(deps.buildDryRunAdmission).not.toHaveBeenCalled();
  });

  it('no admission side effect: the seam has no publishing method and the result is data only', async () => {
    const deps = fakeDeps({});
    const r = await proposeStagingFixes(input(), deps);
    expect(r.ready).toHaveLength(1);
    expect(deps.admitPublish).not.toHaveBeenCalled();
    expect(Object.keys(deps).sort()).toEqual(['admitPublish', 'buildDryRunAdmission', 'commitsTouching', 'precheck']);
  });
});

describe('chooseProposalPaths', () => {
  it('a narrow commit contributes every co-changed path; a sweep only the failing file and same-directory siblings', () => {
    const sweep = { sha: '2'.repeat(40), paths: [RED, 'lib/x/near.ts', ...Array.from({ length: 20 }, (_, i) => `apps/far/f${i}.ts`)] };
    const narrow = { sha: '3'.repeat(40), paths: [RED, 'lib/y/fix.ts'] };
    expect(chooseProposalPaths({ failing: [RED], commits: [sweep, narrow], sweepThreshold: 12 })).toEqual([
      RED,
      'lib/x/near.ts',
      'lib/y/fix.ts',
    ]);
  });
});

describe('createStagingFixProposalDeps — real wiring', () => {
  it('builds every admission as a DRY RUN (never publishes) from the pinned source', async () => {
    admitSpy.mockReturnValue({ ok: true, commit: BUILT, tree: 't'.repeat(40), diff: [RED], unchanged: [], lineageRef: 'r', published: false, entry: {} });
    const deps = createStagingFixProposalDeps({
      root: '/repo',
      candidate: CANDIDATE,
      repairHead: REPAIR_HEAD,
      actor: 'su-test',
      precheck: async () => ({ ran: false, reason: 'runner-failed', detail: 'n/a' }),
      git: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const out = await deps.buildDryRunAdmission({ paths: [RED], sourceCommit: TIP });
    expect(out).toEqual({ ok: true, commit: BUILT, diff: [RED] });
    expect(admitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, source: { ref: TIP, recordAsRef: 'staging' }, paths: [RED] }),
    );
  });

  it('commitsTouching lists candidate..tip restricted to the paths, then each commit’s full changed set', async () => {
    const calls: string[][] = [];
    const deps = createStagingFixProposalDeps({
      root: '/repo',
      candidate: CANDIDATE,
      repairHead: REPAIR_HEAD,
      actor: 'su-test',
      precheck: async () => ({ ran: false, reason: 'runner-failed', detail: 'n/a' }),
      git: (argv) => {
        calls.push([...argv]);
        if (argv[0] === 'log') return { status: 0, stdout: `${'1'.repeat(40)}\n`, stderr: '' };
        return { status: 0, stdout: `${RED}\n${SRC}\n`, stderr: '' };
      },
    });
    const commits = await deps.commitsTouching({ candidate: CANDIDATE, tip: TIP, paths: [RED] });
    expect(commits).toEqual([{ sha: '1'.repeat(40), paths: [RED, SRC] }]);
    expect(calls[0]).toEqual(['log', '--format=%H', `${CANDIDATE}..${TIP}`, '--', RED]);
  });
});
