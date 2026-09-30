/**
 * Guards for tool-schema-staleness (EI-21351815194031529).
 *
 * The property under test is not "does it detect a changed file" — that part is a
 * blob comparison and hard to get wrong. It is that EVERY failure degrades to
 * `unknown` and renders NOTHING, because the whole value of the stamp depends on a
 * positive verdict being rare and trustworthy. A check that emitted a hint whenever
 * git hiccupped would be strictly worse than no check: it would train triagers to
 * ignore the one line that is supposed to stop them.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  pathStaleness,
  pathsStalenessHint,
  relativizeToRepo,
  renderStalenessHint,
  toolSchemaStaleness,
} from './tool-schema-staleness';

const ROOT = '/repo';
const SRC = '/repo/packages/operator-core/lib/agent-tools/improvements/capture.ts';
const REL = 'packages/operator-core/lib/agent-tools/improvements/capture.ts';
const DEPLOYED = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const BLOB_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BLOB_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A git stub answering `rev-parse --verify <ref>:<path>` from a ref→blob map. */
function gitFrom(blobs: Record<string, string | null>) {
  return vi.fn(async (args: string[]) => {
    const spec = args[args.length - 1];
    const ref = String(spec).split(':')[0];
    return blobs[ref] ?? null;
  });
}

function deps(over: Partial<Parameters<typeof toolSchemaStaleness>[1]> = {}) {
  return {
    sourceFileFor: () => SRC,
    deployedSha: () => DEPLOYED,
    repoRoot: ROOT,
    git: gitFrom({ [DEPLOYED]: BLOB_A, staging: BLOB_A }),
    ...over,
  } as Parameters<typeof toolSchemaStaleness>[1];
}

describe('toolSchemaStaleness', () => {
  it('reports stale when the defining file differs between the serving build and the tree', async () => {
    const verdict = await toolSchemaStaleness('improvements:capture', deps({
      git: gitFrom({ [DEPLOYED]: BLOB_A, staging: BLOB_B }),
    }));
    expect(verdict).toEqual({
      state: 'stale',
      relPath: REL,
      deployedSha: DEPLOYED,
      treeRef: 'staging',
    });
  });

  it('reports current when the blobs match', async () => {
    const verdict = await toolSchemaStaleness('improvements:capture', deps());
    expect(verdict.state).toBe('current');
  });

  // ── The absence-never-reads-as-positive contract ────────────────────────────
  // Each of these is a real operating condition, not a hypothetical: a desktop
  // build has no repo, a plugin tool has no defining module, git wedges.

  it.each([
    ['the tool has no known source file', { sourceFileFor: () => null }, 'tool-source-unknown'],
    ['the process cannot report its build sha', { deployedSha: () => null }, 'build-sha-unknown'],
    ['the source lives outside the repo', { sourceFileFor: () => '/elsewhere/x.ts' }, 'source-outside-repo'],
    ['the deployed blob is unreadable', { git: gitFrom({ staging: BLOB_A }) }, 'git-unreadable'],
    ['the tree blob is unreadable', { git: gitFrom({ [DEPLOYED]: BLOB_A }) }, 'git-unreadable'],
    ['git fails entirely', { git: gitFrom({}) }, 'git-unreadable'],
  ])('degrades to unknown (%s) rather than claiming current', async (_label, over, reason) => {
    const verdict = await toolSchemaStaleness('improvements:capture', deps(over));
    expect(verdict).toEqual({ state: 'unknown', reason });
  });

  it('never renders a hint for a non-stale verdict', async () => {
    for (const over of [{}, { sourceFileFor: () => null }, { git: gitFrom({}) }]) {
      const verdict = await toolSchemaStaleness('t:v', deps(over));
      expect(renderStalenessHint(verdict, 't:v')).toBeNull();
    }
  });

  it('renders a hedged, actionable hint naming the file, the build and the next call', async () => {
    const verdict = await toolSchemaStaleness('work_items:complete', deps({
      git: gitFrom({ [DEPLOYED]: BLOB_A, staging: BLOB_B }),
    }));
    const hint = renderStalenessHint(verdict, 'work_items:complete');
    expect(hint).toContain(REL);
    expect(hint).toContain('work_items:complete');
    expect(hint).toContain(DEPLOYED);
    expect(hint).toContain('dev:pipeline_position');
    // Hedged: a differing blob proves the file moved, not that it moved for THIS
    // constraint. Asserting the hedge keeps a future edit from overclaiming.
    expect(hint).toMatch(/may already be fixed/i);
  });

  it('compares against LOCAL staging, never origin/staging', async () => {
    // The gate cuts its candidate from local `staging` and never fetches, so a
    // committed-but-unpushed fix must read as present. Comparing against
    // origin/staging would report it absent and re-create the confusion.
    const git = gitFrom({ [DEPLOYED]: BLOB_A, staging: BLOB_B });
    await toolSchemaStaleness('t:v', deps({ git }));
    const refs = git.mock.calls.map((c) => String(c[0][c[0].length - 1]).split(':')[0]);
    expect(refs).toContain('staging');
    expect(refs.some((r) => r.startsWith('origin/'))).toBe(false);
  });
});

describe('pathStaleness (capture subject paths)', () => {
  it('reports the commits touching a path after the serving build', async () => {
    const git = gitFrom({});
    // Call 1 is the `.gitmodules` probe (EI-23812772755803731): an empty answer means
    // "no submodules", which routes this path down the plain superproject branch.
    // Kept explicit rather than loosened — the ORDER is part of the contract now.
    git.mockResolvedValueOnce('');
    git.mockResolvedValueOnce(`${BLOB_B}\n${BLOB_A}`);
    const verdict = await pathStaleness('packages/operator-core/lib/x.ts', {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git,
    });
    expect(verdict).toEqual({
      state: 'stale',
      relPath: 'packages/operator-core/lib/x.ts',
      deployedSha: DEPLOYED,
      treeRef: 'staging',
      newerCommits: [BLOB_B, BLOB_A],
    });
    expect(git).toHaveBeenCalledWith(['log', '--format=%H', `${DEPLOYED}..staging`, '--', 'packages/operator-core/lib/x.ts']);
  });

  /**
   * EI-23762020538736279. `notBefore` is what lets a caller ask "did this move SINCE
   * A MOMENT" instead of "is the running build behind the tree". The unset case must
   * stay BYTE-IDENTICAL: `pathsStalenessHint` depends on the unbounded range, and a
   * stray `--since` there would silently narrow a correct consumer.
   */
  it('bounds the range by commit time when notBefore is set, and omits --since when it is not', async () => {
    const bounded = vi.fn(async () => '');
    await pathStaleness('a.ts', {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git: bounded,
      notBefore: '2026-09-20T05:25:17.000Z',
    });
    expect(bounded).toHaveBeenCalledWith([
      'log',
      '--format=%H',
      '--since=2026-09-20T05:25:17.000Z',
      `${DEPLOYED}..staging`,
      '--',
      'a.ts',
    ]);

    const unbounded = vi.fn(async () => '');
    await pathStaleness('a.ts', { repoRoot: ROOT, deployedSha: () => DEPLOYED, git: unbounded });
    expect(unbounded).toHaveBeenCalledWith(['log', '--format=%H', `${DEPLOYED}..staging`, '--', 'a.ts']);
  });

  /**
   * A fake git that models the two reads `pathStaleness` makes on a non-submodule tree:
   * `git log <range> -- <path>` (empty when nothing newer touched it, OR when the path does
   * not exist at all — the two are indistinguishable from the log alone) and
   * `git ls-tree <ref> -- <path>` (one entry when present, EMPTY with exit 0 when absent).
   */
  function plainGit(over: { present?: string[]; log?: string } = {}) {
    const present = over.present ?? [];
    return vi.fn(async (args: string[]) => {
      if (args[0] === 'ls-tree') {
        const path = String(args[args.length - 1]);
        return present.includes(path) ? `100644 blob ${BLOB_A}\t${path}` : '';
      }
      if (args[0] === 'log') return over.log ?? '';
      return ''; // the `.gitmodules` probe: no submodules
    });
  }

  it('keeps a successful empty range current for a path that exists, and git failures unknown', async () => {
    const current = await pathStaleness('a.ts', {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git: plainGit({ present: ['a.ts'] }),
    });
    expect(current).toEqual({ state: 'current', relPath: 'a.ts', deployedSha: DEPLOYED, treeRef: 'staging' });
    const unknown = await pathStaleness('a.ts', {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git: vi.fn(async () => null),
    });
    expect(unknown).toEqual({ state: 'unknown', relPath: 'a.ts', reason: 'git-unreadable' });
  });

  /**
   * WI-10002100 — the non-submodule half of the empty-log-as-measured-zero bug.
   *
   * `git log <range> -- NOPE.ts` returns '' for a path that is not in the tree at all (a
   * typo, a rename, an untracked file, a path from another checkout), and the code turned
   * that empty string into a confident `current`. Measured at the time:
   * `git ls-tree staging -- packages/operator-core/lib/NOPE-does-not-exist.ts` returned 0
   * entries while the log range returned ''. The verdict must be UNKNOWN: there is nothing
   * there to be current OR stale. Revert the fix and this flips back to `current`, which is a
   * MISSING WARNING that raises no error of its own — hence a falsifiable guard.
   */
  it('reports UNKNOWN, not current, for a path absent from the tree entirely', async () => {
    const git = plainGit({ present: ['a.ts'] });
    const relPath = 'packages/operator-core/lib/NOPE-does-not-exist.ts';
    const verdict = await pathStaleness(relPath, { repoRoot: ROOT, deployedSha: () => DEPLOYED, git });
    expect(verdict).toEqual({ state: 'unknown', relPath, reason: 'path-absent-from-tree' });
    // The existence probe asks the TREE ref (local staging, never origin) about that path.
    expect(git).toHaveBeenCalledWith(['ls-tree', 'staging', '--', relPath]);
  });

  it('treats a directory with no newer commits as current (ls-tree lists it as one entry)', async () => {
    const verdict = await pathStaleness('libs/generic', {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git: plainGit({ present: ['libs/generic'] }),
    });
    expect(verdict.state).toBe('current');
  });

  it('keeps an unreadable existence probe unknown rather than a measured zero', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'ls-tree') return null; // the probe itself fails
      return ''; // `.gitmodules` probe and the log range succeed, empty
    });
    const verdict = await pathStaleness('a.ts', { repoRoot: ROOT, deployedSha: () => DEPLOYED, git });
    expect(verdict).toEqual({ state: 'unknown', relPath: 'a.ts', reason: 'git-unreadable' });
  });

  it('does not probe existence when newer commits already prove the path is tracked', async () => {
    const git = plainGit({ log: BLOB_B });
    const verdict = await pathStaleness('a.ts', { repoRoot: ROOT, deployedSha: () => DEPLOYED, git });
    expect(verdict.state).toBe('stale');
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(['ls-tree']));
  });

  it('renders only positive stale paths and remains bounded', async () => {
    const git = vi.fn(async (args: string[]) => (String(args.at(-1)) === 'new.ts' ? BLOB_B : ''));
    const hint = await pathsStalenessHint(['new.ts', 'same.ts'], {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git,
    });
    expect(hint).toContain('new.ts');
    expect(hint).toContain(DEPLOYED);
    expect(hint).toContain('staging');
    expect(hint).not.toContain('same.ts');
    expect(hint!.length).toBeLessThan(600);
    expect(hint).not.toContain('\n');
  });
});

/**
 * EI-23812772755803731 — the submodule false-negative.
 *
 * The superproject tracks a submodule as ONE gitlink, so `git log` on a path INSIDE one
 * is ALWAYS empty, however many commits that submodule really has. That empty string is
 * indistinguishable from a genuine "no newer commit", and the code recorded it as exactly
 * that: a confident `current`. It failed in the dangerous direction — never over-warning,
 * silently under-warning — across the whole `libs/generic/*` borrowable tier and EVERY db
 * migration under `libs/papercusp/libs/db/sql`.
 *
 * Measured at the time: `git log -- libs/generic/tooldef/src/corrected-call.ts` from the
 * superproject returned 0 commits; the same file inside the submodule returned 8; and a
 * superproject control path returned 29 — so the instrument worked and failed only here.
 *
 * The stubs below model that real behaviour: a bare `log` (args[0] === 'log') answers ''.
 * That is what makes these guards falsifiable — revert the fix and the verdict silently
 * becomes `current` again, which is a MISSING WARNING and produces no error of its own.
 */
describe('pathStaleness (submodule-backed paths)', () => {
  const SUB = 'libs/generic/tooldef';
  const PIN_OLD = '1111111111111111111111111111111111111111';
  const PIN_NEW = '2222222222222222222222222222222222222222';

  function submoduleGit(
    over: {
      lsTree?: Record<string, string>;
      subLog?: string | null;
      /** Superproject paths present at the tree ref (WI-10002100 existence probe). */
      present?: string[];
      /** Whether the submodule-relative path exists at the submodule's tree pin. Default true. */
      subPresent?: boolean;
    } = {},
  ) {
    const lsTree = over.lsTree ?? {
      [DEPLOYED]: `160000 commit ${PIN_OLD}\t${SUB}`,
      staging: `160000 commit ${PIN_NEW}\t${SUB}`,
    };
    const present = over.present ?? ['packages/operator-core/lib/x.ts'];
    return vi.fn(async (args: string[]) => {
      if (args[0] === 'config') return `submodule.tooldef.path ${SUB}`;
      if (args[0] === 'ls-tree') {
        const path = String(args[args.length - 1]);
        // The gitlink lookup is keyed by REF; the existence probe is keyed by PATH.
        if (path === SUB) return lsTree[String(args[1])] ?? '';
        return present.includes(path) ? `100644 blob ${BLOB_A}\t${path}` : '';
      }
      if (args[0] === 'log') return ''; // the superproject log: always empty here
      if (args[0] === '-C') {
        // `-C <sub> ls-tree <pin> -- <relPath>` is the in-submodule existence probe;
        // `-C <sub> log …` is the range read.
        if (args[2] === 'ls-tree') return over.subPresent === false ? '' : `100644 blob ${BLOB_A}\t${args[args.length - 1]}`;
        return over.subLog === undefined ? `${BLOB_B}\n${BLOB_A}` : over.subLog;
      }
      return '';
    });
  }

  it('measures the range INSIDE the submodule instead of reporting a false current', async () => {
    const git = submoduleGit();
    const relPath = `${SUB}/src/corrected-call.ts`;
    const verdict = await pathStaleness(relPath, { repoRoot: ROOT, deployedSha: () => DEPLOYED, git });

    expect(verdict).toEqual({
      state: 'stale',
      relPath,
      deployedSha: DEPLOYED,
      treeRef: 'staging',
      newerCommits: [BLOB_B, BLOB_A],
    });
    // Bounded by the two GITLINK PINS, run with `-C <submodule>`, and asking for a
    // submodule-RELATIVE path. All three are load-bearing: drop any one and the read
    // silently answers about the wrong object.
    expect(git).toHaveBeenCalledWith([
      '-C',
      SUB,
      'log',
      '--format=%H',
      `${PIN_OLD}..${PIN_NEW}`,
      '--',
      'src/corrected-call.ts',
    ]);
    // The superproject range must never be what decides a submodule-backed path — that
    // is the exact read whose empty answer caused the false `current`.
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining([`${DEPLOYED}..staging`]));
  });

  it('treats equal gitlink pins as a genuine current', async () => {
    const git = submoduleGit({
      lsTree: {
        [DEPLOYED]: `160000 commit ${PIN_OLD}\t${SUB}`,
        staging: `160000 commit ${PIN_OLD}\t${SUB}`,
      },
      subLog: '',
    });
    const verdict = await pathStaleness(`${SUB}/src/x.ts`, {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git,
    });
    // The serving build and the tree pin the SAME submodule commit, so nothing the build
    // runs is behind. A later commit in the submodule that the superproject has not
    // pinned yet is outside `deployedSha..treeRef` by construction.
    expect(verdict.state).toBe('current');
  });

  it('keeps an absent gitlink unknown rather than a measured zero', async () => {
    const git = submoduleGit({ lsTree: {} }); // ls-tree succeeds but finds no entry
    const verdict = await pathStaleness(`${SUB}/src/x.ts`, {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git,
    });
    expect(verdict).toEqual({
      state: 'unknown',
      relPath: `${SUB}/src/x.ts`,
      reason: 'submodule-pin-unresolved',
    });
  });

  it('separates an unreadable git read from a definitively absent pin', async () => {
    const git = vi.fn(async (args: string[]) =>
      args[0] === 'config' ? `submodule.tooldef.path ${SUB}` : null,
    );
    const verdict = await pathStaleness(`${SUB}/src/x.ts`, {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git,
    });
    expect(verdict).toEqual({
      state: 'unknown',
      relPath: `${SUB}/src/x.ts`,
      reason: 'git-unreadable',
    });
  });

  it('reports UNKNOWN for a path absent inside the submodule, not a measured current', async () => {
    const git = submoduleGit({ subLog: '', subPresent: false });
    const relPath = `${SUB}/src/NOPE-does-not-exist.ts`;
    const verdict = await pathStaleness(relPath, { repoRoot: ROOT, deployedSha: () => DEPLOYED, git });
    expect(verdict).toEqual({ state: 'unknown', relPath, reason: 'path-absent-from-tree' });
    // The probe runs INSIDE the submodule, at its tree pin, for the submodule-relative path.
    expect(git).toHaveBeenCalledWith(['-C', SUB, 'ls-tree', PIN_NEW, '--', 'src/NOPE-does-not-exist.ts']);
  });

  it('leaves a path OUTSIDE every submodule on the plain superproject range', async () => {
    const git = submoduleGit({ subLog: null });
    const verdict = await pathStaleness('packages/operator-core/lib/x.ts', {
      repoRoot: ROOT,
      deployedSha: () => DEPLOYED,
      git,
    });
    // `.gitmodules` lists a submodule, but this path is not inside it, so the behaviour
    // must be byte-identical to before: the superproject range, and an empty log is then
    // a legitimately measured `current`.
    expect(verdict.state).toBe('current');
    expect(git).toHaveBeenCalledWith([
      'log',
      '--format=%H',
      `${DEPLOYED}..staging`,
      '--',
      'packages/operator-core/lib/x.ts',
    ]);
  });
});

describe('hint length', () => {
  // capture.ts reserves `hint.length` characters out of the body budget before
  // appending. That reservation is only safe while the hint stays SHORT relative to
  // the 16k body limit — a future edit that grows it into a paragraph would start
  // eating real report content instead of the slack it was meant to use.
  it('stays a single short line, so reserving room for it cannot displace the report', async () => {
    const verdict = await toolSchemaStaleness('work_items:complete', deps({
      git: gitFrom({ [DEPLOYED]: BLOB_A, staging: BLOB_B }),
    }));
    const hint = renderStalenessHint(verdict, 'work_items:complete');
    expect(hint).not.toBeNull();
    expect(hint!.length).toBeLessThan(600);
    expect(hint).not.toContain('\n');
  });
});

describe('relativizeToRepo', () => {
  it('strips the root prefix', () => {
    expect(relativizeToRepo(SRC, ROOT)).toBe(REL);
  });

  it('tolerates a trailing slash on the root', () => {
    expect(relativizeToRepo(SRC, '/repo/')).toBe(REL);
  });

  it('rejects a path outside the root', () => {
    expect(relativizeToRepo('/elsewhere/x.ts', ROOT)).toBeNull();
  });

  it('rejects the root itself', () => {
    expect(relativizeToRepo(ROOT, ROOT)).toBeNull();
  });

  // The sibling-prefix trap, and the reason this is a function rather than a
  // `startsWith`: `papercup-release` sits directly beside `papercusp` on this box
  // and IS the checkout a deployed operator runs from. A naive prefix test would
  // relativize a release-checkout path against the staging root and then ask git
  // about a path that does not exist there — producing a confident wrong answer.
  it('does not treat a sibling directory sharing a name prefix as inside the root', () => {
    expect(relativizeToRepo('/w/papercusp-release/packages/x.ts', '/w/papercusp')).toBeNull();
    expect(relativizeToRepo('/w/papercusp/packages/x.ts', '/w/papercusp')).toBe('packages/x.ts');
  });
});
