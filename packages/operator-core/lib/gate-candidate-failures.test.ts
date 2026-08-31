/**
 * WI-1702869 — the failing-files-on-the-frozen-candidate instrument.
 *
 * Every case here is a wrong answer this module was filed to stop returning. They are
 * written as the WRONG reading first, so a future change that reintroduces one fails
 * with the misreading named rather than with a bare assertion diff.
 */
import { describe, it, expect } from 'vitest';
import { readGateCandidateFailures } from './gate-candidate-failures';

const CANDIDATE = 'adbf27530285830455f8d8df32a45752cfaff332';
const REPAIR_HEAD = 'e7bffeac00000000000000000000000000000000';

type Row = Record<string, unknown>;

/**
 * A fake `sql` tagged template. The module fires exactly two queries; they are told
 * apart by the census aggregate, which is the ONLY thing that distinguishes them
 * structurally — matching on it here means a future refactor that drops the census
 * breaks this fake loudly instead of silently answering the wrong query.
 */
function fakeSql(opts: { filesJudged: number; failing: Row[] }) {
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (/count\(DISTINCT file_path\)/.test(text)) {
      return Promise.resolve([{ files_judged: opts.filesJudged }]);
    }
    return Promise.resolve(opts.failing);
  }) as never;
  return sql;
}

/** A git stub keyed by the exact argv the module builds. */
function fakeGit(table: Record<string, string | null>) {
  return async (_cwd: string, args: string[]) => {
    const key = args.join(' ');
    return key in table ? table[key] : null;
  };
}

const revParse = (sha: string, p: string) => `rev-parse --verify --quiet ${sha}:${p}`;

describe('readGateCandidateFailures', () => {
  it('reports a DIFFERENT blob at repairHead as "already fixed", not as an open failure', async () => {
    // The measured 2026-08-31 case: one failing row on the frozen candidate whose fix
    // had already landed. Reading that row as work is what cost five hours.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({
        filesJudged: 223,
        failing: [{ file_path: 'apps/x/LearningTab.lens-guard.test.tsx', status: 'fail', attempts: 3 }],
      }),
      git: fakeGit({
        [revParse(CANDIDATE, 'apps/x/LearningTab.lens-guard.test.tsx')]: 'ab5e43a6',
        [revParse(REPAIR_HEAD, 'apps/x/LearningTab.lens-guard.test.tsx')]: '36734ba9',
      }),
    });

    expect(res.distinctFailingFiles[0].fixInRepairHead).toBe(true);
    expect(res.alreadyFixedCount).toBe(1);
    expect(res.stillBrokenCount).toBe(0);
    // The headline is the STILL-BROKEN count, so a fixed-but-unverified file does not
    // read as outstanding work.
    expect(res.assessment).toBe('all-fixes-contained');
    expect(res.distinctFailingFiles[0].reading).toMatch(/Do NOT re-fix/i);
  });

  it('reports an IDENTICAL blob at repairHead as still broken — the real repair queue', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 1 }] }),
      git: fakeGit({
        [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
        [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'deadbeef',
      }),
    });

    expect(res.distinctFailingFiles[0].fixInRepairHead).toBe(false);
    expect(res.stillBrokenCount).toBe(1);
    expect(res.assessment).toBe('repairs-outstanding');
  });

  it('a single still-broken file OUTRANKS any number of already-fixed siblings', async () => {
    // First-match ordering. Reporting `all-fixes-contained` while real work remains is
    // the reassuring-degradation failure the cell exists to end.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({
        filesJudged: 223,
        failing: [
          { file_path: 'a.test.ts', status: 'fail', attempts: 1 },
          { file_path: 'b.test.ts', status: 'fail', attempts: 1 },
          { file_path: 'c.test.ts', status: 'error', attempts: 1 },
        ],
      }),
      git: fakeGit({
        [revParse(CANDIDATE, 'a.test.ts')]: 'aaa1',
        [revParse(REPAIR_HEAD, 'a.test.ts')]: 'aaa2', // fixed
        [revParse(CANDIDATE, 'b.test.ts')]: 'bbb1',
        [revParse(REPAIR_HEAD, 'b.test.ts')]: 'bbb2', // fixed
        [revParse(CANDIDATE, 'c.test.ts')]: 'ccc1',
        [revParse(REPAIR_HEAD, 'c.test.ts')]: 'ccc1', // STILL BROKEN
      }),
    });

    expect(res.alreadyFixedCount).toBe(2);
    expect(res.stillBrokenCount).toBe(1);
    expect(res.assessment).toBe('repairs-outstanding');
  });

  it('compares a SUBMODULE-backed path by gitlink, never by blob', async () => {
    // ⚠ THE TRAP THIS EXISTS FOR: `git rev-parse <ref>:<path>` inside a submodule
    // compares content that is IDENTICAL in both refs while the gitlink moved
    // underneath. A blob compare would answer "unchanged" — confidently, and wrongly,
    // in the false-negative direction that sends an agent to re-fix a fixed file.
    const blobsAreIdentical = {
      [revParse(CANDIDATE, 'libs/papercusp/x.test.ts')]: 'same',
      [revParse(REPAIR_HEAD, 'libs/papercusp/x.test.ts')]: 'same',
      [`diff --raw ${CANDIDATE} ${REPAIR_HEAD} -- libs/papercusp`]:
        ':160000 160000 1111111 2222222 M\tlibs/papercusp',
    };
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      submodulePaths: ['libs/papercusp'],
      sql: fakeSql({
        filesJudged: 10,
        failing: [{ file_path: 'libs/papercusp/x.test.ts', status: 'fail', attempts: 1 }],
      }),
      git: fakeGit(blobsAreIdentical),
    });

    const file = res.distinctFailingFiles[0];
    // The blob compare available to it would have said `false`. The gitlink says `true`.
    expect(file.fixInRepairHead).toBe(true);
    expect(file.comparison).toMatch(/gitlink/);
    expect(file.candidateBlob).toBeNull();
  });

  it('an unchanged gitlink is still-broken, and an unreadable one is UNKNOWN', async () => {
    const unchanged = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      submodulePaths: ['libs/papercusp'],
      sql: fakeSql({ filesJudged: 10, failing: [{ file_path: 'libs/papercusp/x.test.ts', status: 'fail', attempts: 1 }] }),
      // An EMPTY diff means the gitlink did not move — distinct from an unreadable one.
      git: fakeGit({ [`diff --raw ${CANDIDATE} ${REPAIR_HEAD} -- libs/papercusp`]: '' }),
    });
    expect(unchanged.distinctFailingFiles[0].fixInRepairHead).toBe(false);

    const unreadable = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      submodulePaths: ['libs/papercusp'],
      sql: fakeSql({ filesJudged: 10, failing: [{ file_path: 'libs/papercusp/x.test.ts', status: 'fail', attempts: 1 }] }),
      git: fakeGit({}), // every call fails ⇒ null
    });
    // UNKNOWN must not collapse into either verdict.
    expect(unreadable.distinctFailingFiles[0].fixInRepairHead).toBeNull();
    expect(unreadable.stillBrokenCount).toBe(0);
    expect(unreadable.alreadyFixedCount).toBe(0);
    expect(unreadable.assessment).toBe('unmeasured');
  });

  it('an unresolvable blob on EITHER side is UNKNOWN, not "fixed"', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 5, failing: [{ file_path: 'gone.test.ts', status: 'fail', attempts: 1 }] }),
      // Only the candidate side resolves. `a !== b` would read `true` ("fixed") if the
      // null were not checked first — the exact false-positive this guards.
      git: fakeGit({ [revParse(CANDIDATE, 'gone.test.ts')]: 'aaa' }),
    });
    expect(res.distinctFailingFiles[0].fixInRepairHead).toBeNull();
  });

  it('NO frozen candidate is a measured ABSENCE, never a count of zero failures', async () => {
    const res = await readGateCandidateFailures({ candidateSha: null, repairHeadSha: null, root: '/repo' });
    expect(res.assessment).toBe('no-frozen-candidate');
    expect(res.unavailable).toMatch(/not "zero failures"/);
    // The zeroes are shape, not evidence — `unavailable` is what says so.
    expect(res.unavailable).not.toBeNull();
  });

  it('an unreachable test_runs is UNMEASURED, and never degrades to a green-looking zero', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: (() => {
        throw new Error('connection refused');
      }) as never,
    });
    expect(res.assessment).toBe('unmeasured');
    expect(res.unavailable).toMatch(/connection refused/);
  });

  it('carries the scope sentence so filesJudged is never quoted as the full suite', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: [] }),
    });
    expect(res.filesJudged).toBe(223);
    expect(res.assessment).toBe('none-failing');
    // An empty failing list must not be readable as "the gate is green".
    expect(res.scope).toMatch(/AFFECTED RADIUS/);
    expect(res.scope).toMatch(/NOT "repairHead is green"|NOT\s+"repairHead is green"/);
    expect(res.postSuiteMeasured).toBeNull();
  });

  it('scopes the census to ONE population: ci, clean tree, this candidate', async () => {
    // The original defect was aggregating three populations. Assert the predicates are
    // actually in the SQL, so a future edit cannot silently widen it back.
    const seen: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      seen.push(strings.join(' '));
      return Promise.resolve(/count\(DISTINCT file_path\)/.test(strings.join(' ')) ? [{ files_judged: 1 }] : []);
    }) as never;

    await readGateCandidateFailures({ candidateSha: CANDIDATE, repairHeadSha: REPAIR_HEAD, root: '/repo', sql });

    for (const q of seen) {
      expect(q).toMatch(/source\s*=/);
      expect(q).toMatch(/worktree_dirty\s*=\s*false/);
      expect(q).toMatch(/commit_sha\s*=/);
    }
    // The failing-file query must collapse retries to the latest attempt, or a
    // retried-and-passed file reads as red forever.
    expect(seen.some((q) => /DISTINCT ON \(file_path\)/.test(q))).toBe(true);
  });
});
