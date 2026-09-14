import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  committedBlobProbes,
  diffProvenanceSnapshots,
  fileFingerprint,
  formatProvenanceBanner,
  formatProvenanceDrift,
  main,
  provenanceResultFields,
  snapshotProvenance,
  REPO_ROOT,
  // The .mjs CLI has no declaration file; the diagnostic lands on the `from`
  // line of this multi-line import, so the suppression directive must be the
  // LAST comment line immediately above that line.
  // @ts-expect-error
} from '../../../../scripts/test-files.mjs';

/**
 * EI-18681435059177620 — a test result must name the file state it describes.
 *
 * The suite is written against the PURE decision functions (the half that can be wrong in a costly
 * way) plus one end-to-end assertion through the real `main()`, matching the split the router's
 * sibling suites already use.
 */

const entry = (over: Record<string, unknown> = {}) => ({
  absolute: '/repo/a.test.ts',
  path: 'a.test.ts',
  state: 'clean',
  fingerprint: 'aaaaaaaaaaaa',
  added: null,
  deleted: null,
  ...over,
});

describe('provenance banner', () => {
  it('stamps HEAD and reports a clean path as clean', () => {
    const banner = formatProvenanceBanner({ head: 'a452179fbf', entries: [entry()] }, 'pre-run');
    expect(banner).toContain(
      'TEST_FILE_PROVENANCE head=a452179fbf testedPaths=1 uncommitted=0 unknown=0 phase=pre-run',
    );
    expect(banner).toContain('a.test.ts  [clean]');
    // The scope disclaimer is load-bearing: without it the stamp silently implies whole-import-graph
    // coverage, which would be a more confident version of the very overclaim this item is about.
    expect(banner).toContain('NAMED paths above only');
  });

  it('names the uncommitted line counts and warns the result is not reproducible by anyone else', () => {
    const banner = formatProvenanceBanner(
      { head: 'a452179fbf', entries: [entry({ state: 'dirty', added: 30, deleted: 0 })] },
      'pre-run',
    );
    expect(banner).toContain('a.test.ts  [DIRTY +30/-0]');
    expect(banner).toContain('not reproducible by anyone else');
    expect(banner).toContain('uncommitted=1');
  });

  it('marks an untracked path as existing only on this box', () => {
    const banner = formatProvenanceBanner({ head: 'abc', entries: [entry({ state: 'untracked' })] }, 'pre-run');
    expect(banner).toContain('[UNTRACKED — exists only on this box]');
    expect(banner).toContain('uncommitted=1');
  });

  /**
   * The failure mode this guards is the whole point: an unmeasurable state reported as `clean` is
   * indistinguishable from a measured clean, and manufactures exactly the false confidence the
   * stamp exists to remove.
   */
  it('reports an unmeasurable path as UNKNOWN and never as clean', () => {
    const banner = formatProvenanceBanner({ head: null, entries: [entry({ state: 'unknown' })] }, 'pre-run');
    expect(banner).toContain('[state UNKNOWN — git could not be read]');
    expect(banner).toContain('treat their state as UNKNOWN, not as clean');
    expect(banner).not.toContain('[clean]');
    expect(banner).toContain('head=unknown');
  });
});

/**
 * EI-19385411226259421 — the MIRROR of every containment trap CLAUDE.md documents.
 *
 * The documented ones all run one way: a check wrongly says your change is MISSING from the
 * candidate. This one runs the other way — `test:file` executes the WORKING TREE, so on this shared
 * checkout a peer's uncommitted fix is silently included, the named file passes, and the reader
 * records "the verdict was stale". That is the direction that makes you STOP looking, and it is the
 * direction with no instrument. Measured 2026-08-02: 7 files named by a red verdict, all 7 passed at
 * tip, 6 genuinely stale and the 7th green only on an uncommitted peer fix.
 */
describe('stale-verdict trap', () => {
  it('does NOT warn when every tested path is clean', () => {
    // The negative control. Without it a banner that emitted the warning unconditionally — i.e. one
    // that measured nothing at all — would pass every other assertion in this block.
    const banner = formatProvenanceBanner({ head: 'abc', entries: [entry()] }, 'post-run');
    expect(banner).not.toContain('STALE-VERDICT TRAP');
    expect(banner).not.toContain('git show <candidate>:');
  });

  it('warns that a pass on an uncommitted path does not make a gate verdict stale', () => {
    const banner = formatProvenanceBanner(
      { head: 'abc', entries: [entry({ state: 'dirty', added: 12, deleted: 3 })] },
      'post-run',
    );
    expect(banner).toContain('STALE-VERDICT TRAP');
    expect(banner).toContain('COMMITTED blob the gate judged still fails');
    expect(banner).toContain('git show <candidate>:a.test.ts');
  });

  it('warns on an UNTRACKED path too — not only a modified one', () => {
    // Untracked is the strictly worse case (the file is not in git at all), so a warning scoped to
    // `dirty` would exempt exactly the least reproducible state.
    const banner = formatProvenanceBanner({ head: 'abc', entries: [entry({ state: 'untracked' })] }, 'post-run');
    expect(banner).toContain('STALE-VERDICT TRAP');
  });

  it('gives a submodule path the `git -C <sub>` form and names the gitlink blindness', () => {
    const banner = formatProvenanceBanner(
      {
        head: 'abc',
        entries: [
          entry({
            path: 'papercusp-desktop/test/dev-operator-ifneeded-reaper.test.js',
            state: 'dirty',
            repoPath: 'papercusp-desktop',
            repoRelativePath: 'test/dev-operator-ifneeded-reaper.test.js',
          }),
        ],
      },
      'post-run',
    );
    expect(banner).toContain(
      'git -C papercusp-desktop show <candidate-pin-for-papercusp-desktop>:test/dev-operator-ifneeded-reaper.test.js',
    );
    expect(banner).toContain('answer about the gitlink, not this file');
    // The superproject form would answer about the wrong object here, so it must not be offered.
    expect(banner).not.toContain('git show <candidate>:papercusp-desktop/');
  });

  it('emits one probe per REPO, not per path, and covers both shapes in a mixed set', () => {
    const probes = committedBlobProbes([
      entry({ path: 'packages/operator-core/lib/a.test.ts', state: 'dirty' }),
      entry({ path: 'packages/operator-core/lib/b.test.ts', state: 'dirty' }),
      entry({
        path: 'papercusp-desktop/test/c.test.js',
        state: 'dirty',
        repoPath: 'papercusp-desktop',
        repoRelativePath: 'test/c.test.js',
      }),
      entry({
        path: 'papercusp-desktop/test/d.test.js',
        state: 'untracked',
        repoPath: 'papercusp-desktop',
        repoRelativePath: 'test/d.test.js',
      }),
    ]);
    expect(probes).toHaveLength(2);
    expect(probes[0]).toContain('git show <candidate>:packages/operator-core/lib/a.test.ts');
    expect(probes[1]).toContain('git -C papercusp-desktop show');
  });

  it('treats an explicit `.` repoPath as the superproject', () => {
    // `gitRepoDetails` writes `repoPath: '.'` for a superproject path; reading that as a submodule
    // would print a `git -C .` form that is correct-looking and needlessly wrong.
    expect(committedBlobProbes([entry({ state: 'dirty', repoPath: '.' })])).toEqual([
      'git show <candidate>:a.test.ts',
    ]);
  });

  it('never fabricates a candidate sha', () => {
    // This process does not know which sha the gate is judging; a guessed one would re-create,
    // inside the fix, the same confidently-wrong-object error the fix exists to prevent.
    const banner = formatProvenanceBanner(
      { head: 'a452179fbf', entries: [entry({ state: 'dirty' })] },
      'post-run',
    );
    expect(banner).toContain('<candidate>');
    expect(banner).not.toContain('show a452179fbf:');
  });
});

describe('mid-run drift', () => {
  const before = { head: 'aaa', entries: [entry({ fingerprint: 'v1' })] };

  it('detects a content change while the run was executing', () => {
    const diff = diffProvenanceSnapshots(before, { head: 'aaa', entries: [entry({ fingerprint: 'v2' })] });
    expect(diff.drifted).toBe(true);
    expect(diff.changed).toEqual([{ path: 'a.test.ts' }]);
    const marker = formatProvenanceDrift(diff);
    expect(marker).toContain('TEST_FILE_PROVENANCE_DRIFT changed=1');
    expect(marker).toContain('describes NEITHER the state it started on nor the state on disk now');
    expect(marker).toContain('a.test.ts — content changed mid-run');
  });

  /**
   * THE CALIBRATION CASE — this is the measurement the incident actually got wrong, and the reason
   * the snapshot carries a content fingerprint rather than a clean/dirty bit.
   *
   * In the reported run the file was DIRTY BEFORE and DIRTY AFTER; what changed was its content
   * (`runGatedDelivery` was written 4 minutes after the run that "tested" it). The `statusOnlyDrift`
   * control below is the naive implementation that compares only the git state — it is kept here
   * permanently so the test cannot pass for the wrong reason: it MISSES this case, and the real
   * subject must catch it. Without this pair, a status-only rewrite would satisfy every other
   * assertion in this file.
   */
  it('catches a dirty→dirty content change that a status-only comparison provably misses', () => {
    const dirtyBefore = { head: 'aaa', entries: [entry({ state: 'dirty', fingerprint: 'v1' })] };
    const dirtyAfter = { head: 'aaa', entries: [entry({ state: 'dirty', fingerprint: 'v2' })] };

    const statusOnlyDrift = (a: typeof dirtyBefore, b: typeof dirtyAfter) =>
      a.entries.some((prior, i) => prior.state !== b.entries[i]!.state);

    expect(statusOnlyDrift(dirtyBefore, dirtyAfter)).toBe(false); // the control is blind here
    expect(diffProvenanceSnapshots(dirtyBefore, dirtyAfter).drifted).toBe(true); // the real subject is not
  });

  it('does not invent drift when nothing moved', () => {
    const diff = diffProvenanceSnapshots(before, { head: 'aaa', entries: [entry({ fingerprint: 'v1' })] });
    expect(diff.drifted).toBe(false);
    expect(formatProvenanceDrift(diff)).toBeNull();
  });

  it('treats an unreadable fingerprint as UNKNOWN drift, never as unchanged', () => {
    const diff = diffProvenanceSnapshots(before, { head: 'aaa', entries: [entry({ fingerprint: null })] });
    expect(diff.changed).toEqual([]);
    expect(diff.uncomparable).toEqual([{ path: 'a.test.ts', reason: 'unreadable after the run' }]);
    expect(formatProvenanceDrift(diff)).toContain('drift UNKNOWN');
  });

  /**
   * EI-21378916947744802: the named test path is not the whole measurement radius. In the reported
   * run git-sync committed an imported production module while the named test file stayed byte-for-
   * byte identical. A moved HEAD therefore must not bless the result merely because this deliberately
   * shallow snapshot cannot see what changed.
   */
  it('reports a moved HEAD as unknown when only the named test paths were measured', () => {
    const diff = diffProvenanceSnapshots(before, { head: 'bbb', entries: [entry({ fingerprint: 'v1' })] });
    expect(diff.drifted).toBe(false);
    expect(diff.headMoved).toEqual({ from: 'aaa', to: 'bbb' });
    const marker = formatProvenanceDrift(diff);
    expect(marker).toContain('TEST_FILE_PROVENANCE_HEAD_MOVED from=aaa to=bbb');
    expect(marker).toContain('imported source/change radius was not measured');
    expect(marker).toContain('provenance is UNKNOWN');
    expect(marker).toContain('re-run at settled HEAD');
    expect(marker).not.toContain('still describes the files it measured');
    expect(marker).not.toContain('TEST_FILE_PROVENANCE_DRIFT');
    expect(provenanceResultFields(before, diff)).toContain('provenance=unknown');
  });
});

describe('provenance fields on the terminal marker line', () => {
  it('is three-state: stamped, drifted, unknown', () => {
    const clean = { head: 'aaa', entries: [entry()] };
    expect(provenanceResultFields(clean, { drifted: false, uncomparable: [] })).toBe(
      'head=aaa uncommittedPaths=0/1 provenance=stamped',
    );
    expect(provenanceResultFields(clean, { drifted: true, uncomparable: [] })).toContain('provenance=drifted');
    expect(
      provenanceResultFields(clean, {
        drifted: false,
        uncomparable: [],
        headMoved: { from: 'aaa', to: 'bbb' },
      }),
    ).toContain('provenance=unknown');
    expect(provenanceResultFields({ head: null, entries: [entry({ state: 'unknown' })] }, null)).toContain(
      'provenance=unknown',
    );
  });

  it('counts uncommitted paths so a pasted verdict carries its own reproducibility caveat', () => {
    const fields = provenanceResultFields(
      { head: 'aaa', entries: [entry({ state: 'dirty' }), entry({ path: 'b.test.ts', absolute: '/repo/b.test.ts' })] },
      null,
    );
    expect(fields).toContain('uncommittedPaths=1/2');
  });

  it('an unreadable git state degrades to unknown rather than a clean bill', () => {
    expect(provenanceResultFields({ head: null, entries: [] }, null)).toContain('provenance=unknown');
  });
});

describe('fingerprint + snapshot against the real filesystem', () => {
  it('changes when the bytes change and is null for a file that does not exist', () => {
    // Mutating a COPY outside the tree — never the shared checkout (CLAUDE.md § proving a guard is
    // falsifiable: an in-tree mutation can be committed by a git-sync sweep even when nothing fails).
    const dir = mkdtempSync(join(tmpdir(), 'provenance-'));
    try {
      const file = join(dir, 'subject.txt');
      writeFileSync(file, 'before');
      const first = fileFingerprint(file);
      writeFileSync(file, 'after');
      expect(fileFingerprint(file)).not.toBe(first);
      expect(fileFingerprint(join(dir, 'missing.txt'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a real HEAD and a real per-path state from the repo', () => {
    const snapshot = snapshotProvenance([resolve(REPO_ROOT, 'package.json')]);
    expect(snapshot.head).toMatch(/^[0-9a-f]{7,40}$/);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].path).toBe('package.json');
    expect(['clean', 'dirty', 'untracked', 'unknown']).toContain(snapshot.entries[0].state);
    expect(snapshot.entries[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  /**
   * REGRESSION: the superproject stores `libs/test-config` as a gitlink, so its own `git ls-files`
   * cannot answer for a file inside that submodule. The provenance reader must use the nested repo
   * and carry both its HEAD and the superproject pin into the human-readable stamp.
   */
  it('resolves a tracked file inside a submodule and reports its commit/pointer state', () => {
    const snapshot = snapshotProvenance([resolve(REPO_ROOT, 'libs/test-config/src/lane-split.test.ts')]);
    const file = snapshot.entries[0];
    expect(file.state).not.toBe('untracked');
    expect(file.repoPath).toBe('libs/test-config');
    expect(file.repoHead).toMatch(/^[0-9a-f]{7,40}$/);
    expect(file.superprojectPin).toMatch(/^[0-9a-f]{40}$/);
    expect(['matched', 'mismatch']).toContain(file.pointerState);

    const banner = formatProvenanceBanner(snapshot, 'pre-run');
    expect(banner).toContain('libs/test-config/src/lane-split.test.ts');
    expect(banner).toContain('repo=libs/test-config');
    expect(banner).toContain(`repoHead=${file.repoHead}`);
    expect(banner).toContain(`superprojectPin=${file.superprojectPin}`);
    expect(banner).toContain(`pointer=${file.pointerState}`);
  });

  it('dedupes a path named twice so the before/after snapshots stay comparable entry-for-entry', () => {
    const p = resolve(REPO_ROOT, 'package.json');
    expect(snapshotProvenance([p, p]).entries).toHaveLength(1);
  });

  /**
   * REGRESSION: a GITIGNORED file must never read as `clean`.
   *
   * `git status` collapses an ignored file to its ignored DIRECTORY (`!! .papercusp/scratch/`) even
   * under `--ignored=matching -uall`, so no exact-path record ever matches it. The first version of
   * this snapshot inferred `clean` from "git named nothing for this path" and therefore reported a
   * file that is not in git AT ALL as reproducible by anyone — which is why tracked-ness is now
   * decided by `ls-files` instead. Verified live before the fix (reported `clean`) and after
   * (reports `untracked`).
   *
   * `.papercusp/scratch/` is gitignored, so writing here cannot be picked up by a git-sync sweep —
   * the in-tree mutation hazard CLAUDE.md warns about does not apply to an ignored path.
   */
  it('never reports a gitignored file as clean', () => {
    const ignored = resolve(REPO_ROOT, '.papercusp/scratch/provenance-ignored-fixture.test.ts');
    try {
      // A FRESH checkout (the green-checkpoint tree) has no .papercusp/scratch/ yet, so the
      // write ENOENT'd there while passing in every long-lived working tree — a red that
      // looked like a provenance regression but was only an unprovisioned fixture dir.
      // The pattern `**/.papercusp/scratch/` ignores this path by name, so creating it here
      // keeps the ignored-ness the assertion depends on (WI-39362).
      mkdirSync(dirname(ignored), { recursive: true });
      writeFileSync(ignored, 'export const fixture = true;\n');
      expect(snapshotProvenance([ignored]).entries[0].state).toBe('untracked');
    } finally {
      rmSync(ignored, { force: true });
    }
    // Calibration: the same probe must still say `clean` for a genuinely tracked, unmodified file,
    // or the assertion above would pass for a snapshot that simply calls everything untracked.
    expect(['clean', 'dirty']).toContain(snapshotProvenance([resolve(REPO_ROOT, 'package.json')]).entries[0].state);
  });
});

describe('end-to-end through the real router', () => {
  it('prints the banner and stamps the terminal marker line', async () => {
    const lines: string[] = [];
    let sawListProgress = false;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (args.join(' ').startsWith('TEST_FILE_LIST_PROGRESS ')) sawListProgress = true;
    });
    const spy = (...args: unknown[]) => void lines.push(args.join(' '));
    const realLog = console.log;
    console.log = spy as typeof console.log;
    let code: number;
    try {
      code = await main(['--dry', 'packages/operator-core/lib/__tests__/test-file-provenance.test.ts']);
    } finally {
      console.log = realLog;
      errorSpy.mockRestore();
    }

    expect(code).toBe(0);
    expect(sawListProgress).toBe(true);
    const banner = lines.find((l) => l.startsWith('TEST_FILE_PROVENANCE '));
    expect(banner).toBeDefined();
    expect(banner).toContain('phase=pre-run');

    const terminal = lines.find((l) => l.startsWith('TEST_FILE_DRYRUN'));
    expect(terminal).toBeDefined();
    // The stamp rides on the line a `| tail -N` actually reads, which is the placement that makes
    // it impossible to paste the verdict without its scope.
    expect(terminal).toMatch(/head=[0-9a-f]{7,40}/);
    expect(terminal).toMatch(/provenance=(stamped|drifted|unknown)/);
  });

  /**
   * REGRESSION GUARD for the compatibility promise this change rests on: the new fields are
   * APPENDED, so `TEST_FILE_RESULT`'s first field stays `requested=` (pinned by the doc-claims
   * anchor registry in machine-line-grep-anchors.ts) and every existing consumer keeps tokenising
   * `status=` unchanged.
   */
  it('keeps the existing marker-line contract intact', async () => {
    const lines: string[] = [];
    let sawListProgress = false;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (args.join(' ').startsWith('TEST_FILE_LIST_PROGRESS ')) sawListProgress = true;
    });
    const realLog = console.log;
    console.log = ((...args: unknown[]) => void lines.push(args.join(' '))) as typeof console.log;
    try {
      await main(['--dry', 'packages/operator-core/lib/__tests__/test-file-provenance.test.ts']);
    } finally {
      console.log = realLog;
      errorSpy.mockRestore();
    }
    expect(sawListProgress).toBe(true);
    const terminal = lines.find((l) => l.startsWith('TEST_FILE_DRYRUN'))!;
    expect(terminal).toMatch(/^TEST_FILE_DRYRUN requested=\d+ /);
    expect(/\bstatus=([a-z-]+)/.exec(terminal)?.[1]).toBe('dry-run');
  });
});
