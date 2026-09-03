/**
 * WI-1702869 — the failing-files-on-the-frozen-candidate instrument.
 *
 * Every case here is a wrong answer this module was filed to stop returning. They are
 * written as the WRONG reading first, so a future change that reintroduces one fails
 * with the misreading named rather than with a bare assertion diff.
 */
import { describe, it, expect } from 'vitest';
import { assessCandidateFailures, outstandingLegIds, readGateCandidateFailures } from './gate-candidate-failures';
import type { FrozenRepairLegState } from './release/repair-leg-lifecycle';

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
    // P-003: with no leg measurement threaded in, the honest reading is `not-recorded` —
    // never a `null` that a caller can read as "measured, nothing there".
    expect(res.nonTestLegsMeasured).toBe('not-recorded');
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

  /**
   * ── THE NON-TEST-CARRIER TRAP ────────────────────────────────────────────────────
   * Measured 2026-09-02 on candidate 797454468a / repairHead 607bff8f43: the cell called
   * three files "real work" and ALL THREE were already fixed — the repairs had landed in
   * `scripts/check-resource-governor-enforcement.mjs` and `scripts/pc-heavy-jobs.mjs`,
   * which a TEST-blob comparison cannot see. Wrong 3 times out of 3, in the direction
   * that manufactures labour.
   */
  const tree = (sha: string) => `rev-parse ${sha}^{tree}`;
  const nameOnly = `diff --name-only ${CANDIDATE} ${REPAIR_HEAD}`;

  it('does NOT call a file "real work" when the fix could be riding a non-test file', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({
        filesJudged: 6936,
        failing: [{ file_path: 'packages/operator-core/lib/undrained-stdout-exit-guard.test.ts', status: 'fail', attempts: 5 }],
      }),
      git: fakeGit({
        // The test file itself never moved — the real 2026-09-02 shape.
        [revParse(CANDIDATE, 'packages/operator-core/lib/undrained-stdout-exit-guard.test.ts')]: 'd397c0ce',
        [revParse(REPAIR_HEAD, 'packages/operator-core/lib/undrained-stdout-exit-guard.test.ts')]: 'd397c0ce',
        [tree(CANDIDATE)]: 'tree-aaa',
        [tree(REPAIR_HEAD)]: 'tree-bbb',
        // ...but the script it exercises did.
        [nameOnly]: 'scripts/pc-heavy-jobs.mjs\n',
      }),
    });

    const row = res.distinctFailingFiles[0];
    // The blob fact is unchanged and stays honest.
    expect(row.fixInRepairHead).toBe(false);
    expect(res.stillBrokenCount).toBe(1);
    // But it must NOT be asserted as confirmed work, and must name the decisive next step.
    expect(res.stillBrokenNeedsRunCount).toBe(1);
    expect(row.reading).not.toMatch(/This one is real work/i);
    expect(row.reading).toMatch(/RUN THIS FILE AT repairHead/i);
    expect(res.changedBetweenRefs).toEqual({ count: 1, sample: ['scripts/pc-heavy-jobs.mjs'] });
  });

  it('KEEPS the strong "real work" reading when nothing else moved either', async () => {
    // The hedge must not swallow the instrument: with an identical tree on both sides
    // there is nowhere for a fix to hide, so `false` is decisive and says so.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 12, failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 2 }] }),
      git: fakeGit({
        [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
        [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'deadbeef',
        [tree(CANDIDATE)]: 'same-tree',
        [tree(REPAIR_HEAD)]: 'same-tree',
      }),
    });

    expect(res.stillBrokenCount).toBe(1);
    expect(res.stillBrokenNeedsRunCount).toBe(0);
    expect(res.distinctFailingFiles[0].reading).toMatch(/This one is real work/i);
    expect(res.changedBetweenRefs).toEqual({ count: 0, sample: [] });
  });

  it('reads an EMPTY diff as "nothing moved", never as an unreadable command', async () => {
    // `git diff --name-only` prints nothing both when nothing changed and when the call
    // failed, and the shared fail-soft runner collapses empty stdout to null. Deciding
    // between them from that alone would reintroduce the exact confident-wrong reading
    // this module exists to remove, so the tree ids are compared FIRST.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 12, failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 1 }] }),
      git: fakeGit({
        [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
        [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'deadbeef',
        [tree(CANDIDATE)]: 'same-tree',
        [tree(REPAIR_HEAD)]: 'same-tree',
        [nameOnly]: null, // indistinguishable from a failure at this layer
      }),
    });

    expect(res.changedBetweenRefs).toEqual({ count: 0, sample: [] });
    expect(res.stillBrokenNeedsRunCount).toBe(0);
  });

  it('hedges when it cannot tell whether anything else moved', async () => {
    // Unknown must not degrade to the confident reading. An unreadable comparison is
    // evidence of nothing, and the row has to say so rather than pick a side.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 12, failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 1 }] }),
      git: fakeGit({
        [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
        [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'deadbeef',
        // no tree ids, no diff ⇒ unknown
      }),
    });

    expect(res.distinctFailingFiles[0].reading).not.toMatch(/This one is real work/i);
    expect(res.stillBrokenNeedsRunCount).toBe(1);
    expect(res.changedBetweenRefs).toBeNull();
  });

  describe('when repairHead has not advanced from the candidate (EI-22131981911313887)', () => {
    /**
     * The ordinary state of a freshly-frozen queue: `repairHead` starts equal to `candidate`
     * and stays there until a fixer commits. Measured 2026-09-02, ALL THREE live installs
     * (papercusp / oddsmith / hello-world-3) sat in exactly this state.
     */
    const sameShaResult = () =>
      readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: CANDIDATE,
        root: '/repo',
        sql: fakeSql({
          filesJudged: 5550,
          failing: [{ file_path: 'packages/operator-core/lib/kopia-backup-guard.test.ts', status: 'fail', attempts: 4 }],
        }),
        // Deliberately EMPTY: with one ref there is nothing to compare, so a correct
        // implementation must not need a single blob lookup to answer.
        git: fakeGit({}),
      });

    it('does not render a self-comparison that reads as an implementation bug', async () => {
      // The WRONG reading first: `git rev-parse <sha>:<path> vs <sha>:<path>` names the same
      // sha twice. It was filed as "the cell compares the candidate blob against ITSELF",
      // costing a reporter's investigation and this one — the comparison string is the only
      // thing a reader has, and it described a two-ref measurement that never happened.
      const res = await sameShaResult();
      const { comparison } = res.distinctFailingFiles[0];

      expect(comparison).not.toMatch(
        new RegExp(`${CANDIDATE.slice(0, 12)}:[^\\s]+\\s+vs\\s+${CANDIDATE.slice(0, 12)}:`),
      );
      expect(comparison).toMatch(/not compared/i);
      expect(comparison).toMatch(/repairHead is still the frozen candidate/i);
    });

    it('does not claim "nothing else moved between the two refs" when there is only one ref', async () => {
      // `movesBetween` diffs a ref against itself and honestly returns `none`, which used to
      // feed the STRONGEST hedge-free reading. True by luck, but derived from a vacuous
      // comparison and phrased as though two refs had been examined.
      const res = await sameShaResult();
      const { reading } = res.distinctFailingFiles[0];

      expect(reading).not.toMatch(/nothing else moved between/i);
      expect(reading).toMatch(/repairHead has not advanced/i);
      expect(reading).toMatch(/no fixer has committed/i);
    });

    it('KEEPS the still-broken verdict — the fix must not be an over-correction to null', async () => {
      // Guards the deliberate call made when this was fixed. Nothing can have landed on a head
      // that has not moved, so these files ARE genuinely unrepaired and "go fix them" is right.
      // Downgrading them to `null` would zero `stillBrokenCount` and flip the assessment to
      // `unmeasured` exactly when a fresh queue's advice is most actionable — the
      // reassuring-degradation failure this cell exists to prevent.
      const res = await sameShaResult();

      expect(res.distinctFailingFiles[0].fixInRepairHead).toBe(false);
      expect(res.stillBrokenCount).toBe(1);
      expect(res.alreadyFixedCount).toBe(0);
      expect(res.assessment).toBe('repairs-outstanding');
    });

    it('does not presume a hidden non-test carrier when the refs are identical', async () => {
      // `stillBrokenNeedsRunCount` flags rows whose fix might ride a non-test file that moved.
      // With one ref nothing moved at all, so nothing is merely PRESUMED broken.
      const res = await sameShaResult();

      expect(res.stillBrokenNeedsRunCount).toBe(0);
    });
  });

  describe('nonTestLegs (WI-2143253)', () => {
    it('is null when the caller has no repairTickLegs measurement', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({ filesJudged: 1, failing: [] }),
      });
      expect(res.nonTestLegs).toBeNull();
    });

    it('names which non-test legs are failing, not just that something was measured', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({ filesJudged: 1, failing: [] }),
        repairTickLegs: {
          head: REPAIR_HEAD.slice(0, 12),
          atMs: 1_000,
          ok: false,
          failingSignatures: ['lint:design-primitives', 'lint:plane-integrity'],
          legs: [
            { id: 'lint:design-primitives', status: 'fail', durationMs: 420 },
            { id: 'lint:plane-integrity', status: 'errored', durationMs: 10 },
            { id: 'lint:tsc', status: 'pass', durationMs: 5000 },
          ],
        },
      });
      expect(res.nonTestLegs).not.toBeNull();
      expect(res.nonTestLegs?.current).toBe(true);
      expect(res.nonTestLegs?.all).toHaveLength(3);
      expect(res.nonTestLegs?.failing.map((l) => l.id)).toEqual(['lint:design-primitives', 'lint:plane-integrity']);
      expect(res.nonTestLegs?.reading).toMatch(/lint:design-primitives/);
      expect(res.nonTestLegs?.reading).toMatch(/lint:plane-integrity/);
    });

    it('reports current:false and hedges the reading when the measurement predates repairHead', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({ filesJudged: 1, failing: [] }),
        // A measurement taken at an EARLIER repairHead the queue has since moved past —
        // repairHeadSha does not start with this head.
        repairTickLegs: {
          head: 'ffffffffffff',
          atMs: 1_000,
          ok: false,
          failingSignatures: ['lint:tsc'],
          legs: [{ id: 'lint:tsc', status: 'fail', durationMs: 1 }],
        },
      });
      expect(res.nonTestLegs?.current).toBe(false);
      expect(res.nonTestLegs?.reading).toMatch(/STALE/);
    });

    it('says all legs passed when none are failing, distinct from "nothing was measured"', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({ filesJudged: 1, failing: [] }),
        repairTickLegs: {
          head: REPAIR_HEAD.slice(0, 12),
          atMs: 1_000,
          ok: true,
          failingSignatures: [],
          legs: [{ id: 'lint:tsc', status: 'pass', durationMs: 1 }],
        },
      });
      expect(res.nonTestLegs?.failing).toEqual([]);
      expect(res.nonTestLegs?.reading).toMatch(/passed/i);
    });

    it('survives on the unavailable path — a test_runs failure must not also lose the leg measurement', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: (() => {
          throw new Error('connection refused');
        }) as never,
        repairTickLegs: {
          head: REPAIR_HEAD.slice(0, 12),
          atMs: 1_000,
          ok: false,
          failingSignatures: ['lint:tsc'],
          legs: [{ id: 'lint:tsc', status: 'fail', durationMs: 1 }],
        },
      });
      expect(res.assessment).toBe('unmeasured');
      expect(res.nonTestLegs).not.toBeNull();
      expect(res.nonTestLegs?.failing.map((l) => l.id)).toEqual(['lint:tsc']);
    });

    it('survives on the no-frozen-candidate path', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: null,
        repairHeadSha: null,
        root: '/repo',
        repairTickLegs: {
          head: 'abc123def456',
          atMs: 1_000,
          ok: true,
          failingSignatures: [],
          legs: [],
        },
      });
      expect(res.assessment).toBe('no-frozen-candidate');
      // No live repairHead to compare against ⇒ currency is unknown, not false.
      expect(res.nonTestLegs?.current).toBeNull();
    });
  });
});

describe('P-003 — the named per-leg surface that replaced postSuiteMeasured', () => {
  const legsSnap = {
    head: REPAIR_HEAD.slice(0, 12),
    atMs: 1_800_000_000_000,
    ok: false,
    failingSignatures: ['lint:design-primitives'],
    legs: [
      { id: 'lint:design-primitives', status: 'fail' as const, durationMs: 120 },
      { id: 'lint:tsc', status: 'pass' as const, durationMs: 90 },
    ],
  };

  /** A cycle that still has `lint:plane-ratchet` failing — which THIS tick did not measure. */
  const queueLegs: FrozenRepairLegState[] = [
    {
      id: 'lint:plane-ratchet',
      state: 'failing' as const,
      admittedRound: 1,
      admittedHead: REPAIR_HEAD.slice(0, 12),
      admittedAtMs: 1_799_999_000_000,
      lastMeasuredHead: REPAIR_HEAD.slice(0, 12),
      lastMeasuredAtMs: 1_799_999_000_000,
      lastMeasuredRound: 1,
      failingRounds: 1,
    },
    {
      id: 'lint:design-primitives',
      state: 'failing' as const,
      admittedRound: 1,
      admittedHead: REPAIR_HEAD.slice(0, 12),
      admittedAtMs: 1_799_999_000_000,
      lastMeasuredHead: REPAIR_HEAD.slice(0, 12),
      lastMeasuredAtMs: 1_800_000_000_000,
      lastMeasuredRound: 1,
      failingRounds: 1,
    },
  ];

  async function read(opts: { queueLegs?: readonly FrozenRepairLegState[] } = {}) {
    return readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: [] }),
      git: fakeGit({}),
      repairTickLegs: legsSnap,
      ...(opts.queueLegs ? { queueLegs: opts.queueLegs } : {}),
    });
  }

  it('CALIBRATION: a leg measurement makes the answer "measured" and names the failing leg', async () => {
    const res = await read();
    expect(res.nonTestLegsMeasured).toBe('measured');
    expect(res.nonTestLegs?.failing.map((l) => l.id)).toEqual(['lint:design-primitives']);
  });

  it('LOAD-BEARING: no leg measurement reads as NOT-RECORDED, never as "no legs failing"', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: [] }),
      git: fakeGit({}),
    });
    // The old `postSuiteMeasured: null` was indistinguishable from "measured, came back
    // empty" — and it resolved null forever, because no caller ever supplied it.
    expect(res.nonTestLegsMeasured).toBe('not-recorded');
    expect(res.nonTestLegs).toBeNull();
    // ...and the scope sentence must still refuse the green reading.
    expect(res.scope).toMatch(/BY NAME/);
  });

  it('LOAD-BEARING: a leg the tick did NOT measure is still NAMED, not dropped', async () => {
    // The union is the whole point. Intersecting would silently drop lint:plane-ratchet
    // because this tick did not run it — rendering "we did not look" as "not on the list".
    const res = await read({ queueLegs });
    const ids = res.nonTestLegs!.perLeg.map((l) => l.id);
    expect(ids).toContain('lint:plane-ratchet');
    const ratchet = res.nonTestLegs!.perLeg.find((l) => l.id === 'lint:plane-ratchet')!;
    expect(ratchet.measuredNow).toBe('not-measured');
    expect(ratchet.lifecycle).toBe('failing');
    expect(ratchet.reading).toMatch(/not a pass/i);

    // The control: an intersection-shaped answer loses it entirely.
    const intersected = legsSnap.legs.filter((l) => queueLegs.some((q) => q.id === l.id)).map((l) => l.id);
    expect(intersected).not.toContain('lint:plane-ratchet');
  });

  it('LOAD-BEARING: "did its fix land" is answered with a HEAD, never a bare boolean', async () => {
    const fixed: FrozenRepairLegState[] = [
      {
        ...queueLegs[0]!,
        id: 'lint:tsc',
        state: 'fixed',
        resolvedHead: REPAIR_HEAD.slice(0, 12),
        resolvedAtMs: 1_800_000_000_000,
      },
    ];
    const res = await read({ queueLegs: fixed });
    const tsc = res.nonTestLegs!.perLeg.find((l) => l.id === 'lint:tsc')!;
    expect(tsc.lifecycle).toBe('fixed');
    // A bare `true` invites "the fix is in the CURRENT head". The sha is the claim.
    expect(tsc.fixedAtHead).toBe(REPAIR_HEAD.slice(0, 12));
    expect(tsc.reading).toMatch(/Do NOT go fix it/);
  });

  it('a leg measured but never admitted reads as never-admitted, not as repair work', async () => {
    const res = await read();
    const tsc = res.nonTestLegs!.perLeg.find((l) => l.id === 'lint:tsc')!;
    expect(tsc.lifecycle).toBe('never-admitted');
    expect(tsc.admittedRound).toBeNull();
    expect(tsc.fixedAtHead).toBeNull();
  });

  it('the leg shrink reading carries its own scope, so it is never differenced against file counts', async () => {
    const res = await read({ queueLegs });
    expect(res.nonTestLegs!.shrink.measured).toBe(true);
    expect(res.nonTestLegs!.shrink.failingLegIds).toEqual(['lint:design-primitives', 'lint:plane-ratchet']);
    expect(res.nonTestLegs!.shrink.scope).toMatch(/do not subtract them/i);
    // Unmeasured legs: null shrink, never a reassuring zero.
    const noLifecycle = await read();
    expect(noLifecycle.nonTestLegs!.shrink.measured).toBe(false);
    expect(noLifecycle.nonTestLegs!.shrink.shrinkTotal).toBeNull();
  });
});

/**
 * main-green-status-visible-2026-09-03 P-007 — THE FALSIFIER THAT MATTERS MOST.
 *
 * Before this block the verdict was `files.length === 0 ? 'none-failing' : …`: it counted
 * TEST FILES only, so a gate wedged on a red lint/perf/desktop/delta leg with zero failing
 * test files read `none-failing` on the one cell whose job is to say what is failing. That
 * is "measured empty renders as nothing failing" (P-012) one leg over. The deliberately
 * wrong control is kept in this file so the property, not just today's code, is what is
 * being tested.
 */
describe('P-007 — a red non-test leg is NEVER none-failing on any reading of this cell', () => {
  const SHORT = REPAIR_HEAD.slice(0, 12);
  const tick = (legs: Array<{ id: string; status: 'pass' | 'fail' | 'errored' }>, head = SHORT) => ({
    head,
    atMs: 1_800_000_000_000,
    ok: legs.every((l) => l.status === 'pass'),
    failingSignatures: legs.filter((l) => l.status !== 'pass').map((l) => l.id),
    legs: legs.map((l) => ({ ...l, durationMs: 10 })),
  });
  const lifecycle = (id: string, state: 'failing' | 'fixed'): FrozenRepairLegState => ({
    id,
    state,
    admittedRound: 1,
    admittedHead: SHORT,
    admittedAtMs: 1_799_999_000_000,
    lastMeasuredHead: SHORT,
    lastMeasuredAtMs: 1_799_999_500_000,
    lastMeasuredRound: 1,
    failingRounds: state === 'failing' ? 1 : 0,
    ...(state === 'fixed' ? { resolvedHead: SHORT, resolvedAtMs: 1_800_000_000_000 } : {}),
  });
  const read = (opts: {
    repairTickLegs?: ReturnType<typeof tick>;
    queueLegs?: readonly FrozenRepairLegState[];
    failing?: Row[];
    git?: Record<string, string | null>;
  }) =>
    readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: opts.failing ?? [] }),
      git: fakeGit(opts.git ?? {}),
      ...(opts.repairTickLegs ? { repairTickLegs: opts.repairTickLegs } : {}),
      ...(opts.queueLegs ? { queueLegs: opts.queueLegs } : {}),
    });

  /** The pre-P-007 rule, verbatim in shape — kept as the control that must NOT be what ships. */
  const preP007Rule = (fileCount: number, stillBroken: number, alreadyFixed: number) =>
    fileCount === 0 ? 'none-failing' : stillBroken > 0 ? 'repairs-outstanding' : alreadyFixed === fileCount ? 'all-fixes-contained' : 'unmeasured';

  it('THE FALSIFIER: zero failing test files + a red lint leg is non-test-leg-failing, and the leg is NAMED', async () => {
    const res = await read({ repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }]) });
    expect(res.stillBrokenCount).toBe(0);
    expect(res.nonTestLegsMeasured).toBe('measured');
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
    expect(res.assessment).toBe('non-test-leg-failing');
    expect(res.assessment).not.toBe('none-failing');
    // The control reproduces the defect on the same inputs — so this test discriminates.
    expect(preP007Rule(0, 0, 0)).toBe('none-failing');
  });

  it('CALIBRATION: every leg passing with zero failing files IS none-failing', async () => {
    const res = await read({ repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }, { id: 'perf', status: 'pass' }]) });
    expect(res.nonTestLegs!.outstanding).toEqual([]);
    expect(res.assessment).toBe('none-failing');
  });

  it('an errored leg is red, not "not a fail"', async () => {
    const res = await read({ repairTickLegs: tick([{ id: 'desktop', status: 'errored' }]) });
    expect(res.assessment).toBe('non-test-leg-failing');
    expect(res.nonTestLegs!.outstanding).toEqual(['desktop']);
  });

  it('NOT MEASURING a leg the cycle has FAILING is not a pass — it stays outstanding', async () => {
    const res = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }]),
      queueLegs: [lifecycle('lint:plane-ratchet', 'failing')],
    });
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:plane-ratchet']);
    expect(res.assessment).toBe('non-test-leg-failing');
  });

  it('a leg whose own re-run PASSED reads all-fixes-contained — never none-failing, never outstanding', async () => {
    const res = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }]),
      queueLegs: [lifecycle('lint:tsc', 'fixed')],
    });
    expect(res.nonTestLegs!.outstanding).toEqual([]);
    // "Nothing failing" would erase the fact that something WAS red and is awaiting
    // re-verification; the converging code is the honest one.
    expect(res.assessment).toBe('all-fixes-contained');
  });

  it('a fixed leg measured RED again is a regression — outstanding, not "already fixed"', async () => {
    const res = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }]),
      queueLegs: [lifecycle('lint:tsc', 'fixed')],
    });
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
    expect(res.assessment).toBe('non-test-leg-failing');
  });

  it('a STALE tick (measured at an earlier repairHead) is not evidence either way — only the lifecycle counts', async () => {
    const stalePass = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }], '0123456789ab'),
      queueLegs: [lifecycle('lint:tsc', 'failing')],
    });
    expect(stalePass.nonTestLegs!.current).toBe(false);
    expect(stalePass.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
    expect(stalePass.assessment).toBe('non-test-leg-failing');

    const staleFail = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }], '0123456789ab'),
      queueLegs: [lifecycle('lint:tsc', 'fixed')],
    });
    expect(staleFail.nonTestLegs!.outstanding).toEqual([]);
    expect(staleFail.assessment).toBe('all-fixes-contained');
  });

  it('a red leg OUTRANKS "every file already fixed" — all-fixes-contained is reserved for nothing left to do', async () => {
    const p = 'lib/a.test.ts';
    const res = await read({
      failing: [{ file_path: p, status: 'fail', attempts: 1 }],
      git: { [revParse(CANDIDATE, p)]: 'blob-old', [revParse(REPAIR_HEAD, p)]: 'blob-new' },
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }]),
    });
    expect(res.alreadyFixedCount).toBe(1);
    expect(res.stillBrokenCount).toBe(0);
    expect(res.assessment).toBe('non-test-leg-failing');
    // …and the control would have called it converging.
    expect(preP007Rule(1, 0, 1)).toBe('all-fixes-contained');
  });

  it('a still-broken FILE still outranks the leg — but the leg stays named beside it', async () => {
    const p = 'lib/a.test.ts';
    const res = await read({
      failing: [{ file_path: p, status: 'fail', attempts: 1 }],
      git: { [revParse(CANDIDATE, p)]: 'blob-same', [revParse(REPAIR_HEAD, p)]: 'blob-same' },
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }]),
    });
    expect(res.assessment).toBe('repairs-outstanding');
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
  });

  it('no leg measurement at all leaves the file-only verdict alone (the P-012 flag says the legs were not looked at)', async () => {
    const res = await read({});
    expect(res.nonTestLegsMeasured).toBe('not-recorded');
    expect(res.nonTestLegs).toBeNull();
    expect(res.assessment).toBe('none-failing');
  });

  describe('the pure rules, so a future reorder of the branches fails HERE with the case named', () => {
    it('assessCandidateFailures — first match, in this order', () => {
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 1, alreadyFixedCount: 1, outstandingLegs: 1, fixedLegs: 0 })).toBe('repairs-outstanding');
      expect(assessCandidateFailures({ fileCount: 0, stillBrokenCount: 0, alreadyFixedCount: 0, outstandingLegs: 1, fixedLegs: 0 })).toBe('non-test-leg-failing');
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 0, alreadyFixedCount: 2, outstandingLegs: 1, fixedLegs: 0 })).toBe('non-test-leg-failing');
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 0, alreadyFixedCount: 1, outstandingLegs: 0, fixedLegs: 0 })).toBe('unmeasured');
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 0, alreadyFixedCount: 2, outstandingLegs: 0, fixedLegs: 0 })).toBe('all-fixes-contained');
      expect(assessCandidateFailures({ fileCount: 0, stillBrokenCount: 0, alreadyFixedCount: 0, outstandingLegs: 0, fixedLegs: 1 })).toBe('all-fixes-contained');
      expect(assessCandidateFailures({ fileCount: 0, stillBrokenCount: 0, alreadyFixedCount: 0, outstandingLegs: 0, fixedLegs: 0 })).toBe('none-failing');
    });

    it('outstandingLegIds — the one rule the assessment and the readings share', () => {
      const row = (id: string, measuredNow: 'pass' | 'fail' | 'errored' | 'not-measured', lifecycle: 'failing' | 'fixed' | 'never-admitted') => ({ id, measuredNow, lifecycle });
      // current head (true or unknown): this tick's result decides when it exists
      expect(outstandingLegIds([row('a', 'fail', 'never-admitted'), row('b', 'pass', 'failing'), row('c', 'not-measured', 'failing'), row('d', 'not-measured', 'never-admitted'), row('e', 'errored', 'fixed')], true)).toEqual(['a', 'c', 'e']);
      expect(outstandingLegIds([row('a', 'fail', 'never-admitted')], null)).toEqual(['a']);
      // stale head: only the lifecycle
      expect(outstandingLegIds([row('a', 'fail', 'fixed'), row('b', 'pass', 'failing'), row('c', 'fail', 'never-admitted')], false)).toEqual(['b']);
    });
  });
});
