/**
 * WI-42441 — the HEAD-side blob lookup must never answer a RESOLUTION FAILURE with a
 * statement about the commit's contents.
 *
 * The class this pins has been filed three times against three different consumers
 * (EI-21215681517579616 `git show HEAD:<submodule path>` writing an empty file;
 * EI-20881147405154343 gate blob-containment reading a false "not stale";
 * WI-42441 this prover). Every instance failed in the SAME direction: the superproject
 * answered *plausibly* rather than erroring, so the caller read a failure to resolve as
 * a substantive finding. For this prover the cost was concrete — a close naming a path
 * inside `libs/papercusp` could never reach `authority:'committed'`, so the work was
 * absent from burn-down and its closer kept phantom ownership, while the warning text
 * blamed their tree hygiene for a server-side bug.
 *
 * These tests use a REAL git submodule rather than a stub, because the defect lives in
 * what git actually does with a gitlink — a stub of the lookup would encode the very
 * assumption under test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completionHeadBlobMap,
  headBlobShaOf,
  unresolvableContentIdentityPaths,
  type HeadBlobResolution,
} from './completion-freshness';

const ROOTS: string[] = [];
afterEach(() => {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    // A sync spawn blocks the worker's event loop, so vitest cannot time it out, and the
    // pure lane shares one fork across ~2,740 files — an unbounded block here wedges all
    // of them until the batch watchdog fires 45 minutes later (WI-41180 ratchet).
    timeout: 120_000,
    killSignal: 'SIGKILL',
    // Local-path submodules are refused by default since the CVE-2022-39253 fix.
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'fixture@example.test');
  git(dir, 'config', 'user.name', 'Submodule Fixture');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'protocol.file.allow', 'always');
}

/** A superproject whose `sub/` is a real submodule carrying `sub/inner.ts`. */
function buildSuperprojectWithSubmodule(): {
  root: string;
  superSha: string;
  innerPath: string;
  innerBlob: string;
} {
  const base = mkdtempSync(join(tmpdir(), 'wi42441-'));
  ROOTS.push(base);
  const subOrigin = join(base, 'sub-origin');
  const root = join(base, 'super');

  initRepo(subOrigin);
  writeFileSync(join(subOrigin, 'inner.ts'), 'export const inner = 1;\n');
  git(subOrigin, 'add', 'inner.ts');
  git(subOrigin, 'commit', '-qm', 'inner');
  const innerBlob = git(subOrigin, 'rev-parse', 'HEAD:inner.ts');

  initRepo(root);
  writeFileSync(join(root, 'top.ts'), 'export const top = 1;\n');
  git(root, 'add', 'top.ts');
  git(root, 'commit', '-qm', 'top');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOrigin, 'sub');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'add submodule');

  return { root, superSha: git(root, 'rev-parse', 'HEAD'), innerPath: 'sub/inner.ts', innerBlob };
}

describe('completionHeadBlobMap — submodule-interior paths (WI-42441)', () => {
  it('resolves a path inside a submodule to the blob the pinned commit carries', async () => {
    const { root, superSha, innerPath, innerBlob } = buildSuperprojectWithSubmodule();

    // CONTROL — the exact read the prover used to do, and why it could never succeed:
    // in the superproject that path is not a blob, it is a gitlink. This control is
    // permanent: if it ever starts succeeding, the premise of this whole file changed.
    expect(() => git(root, 'rev-parse', '--verify', `${superSha}:${innerPath}`)).toThrow();

    const map = await completionHeadBlobMap(root, superSha, [innerPath, 'top.ts']);
    expect(map?.get(innerPath)).toEqual({ status: 'resolved', sha: innerBlob });
    expect(headBlobShaOf(map?.get(innerPath))).toBe(innerBlob);
    // CALIBRATION — an ordinary superproject path must still work, or a resolver that
    // simply returned `resolved` for everything would pass the assertion above.
    expect(headBlobShaOf(map?.get('top.ts'))).toBe(git(root, 'rev-parse', `${superSha}:top.ts`));
  });

  it('reports an UNREADABLE submodule as unresolvable, never as absent from the commit', async () => {
    const { root, superSha, innerPath } = buildSuperprojectWithSubmodule();
    // Exactly the state `git worktree add` leaves behind (WI-40231): the gitlink is still
    // committed, but nothing can be read out of the submodule in THIS checkout.
    rmSync(join(root, 'sub'), { recursive: true, force: true });
    rmSync(join(root, '.git', 'modules', 'sub'), { recursive: true, force: true });

    const entry = (await completionHeadBlobMap(root, superSha, [innerPath]))?.get(innerPath);

    expect(entry?.status).toBe('unresolvable');
    // The reason must NAME the submodule, or a reader cannot act on it.
    expect(entry?.status === 'unresolvable' && entry.reason).toMatch(/submodule 'sub'/);
    // The whole point: this is NOT a claim that the commit lacks the path.
    expect(entry).not.toEqual({ status: 'absent' });
    expect(headBlobShaOf(entry)).toBeNull();
  });

  it('reports a path the commit genuinely lacks as absent — the case that IS a verdict', async () => {
    const { root, superSha } = buildSuperprojectWithSubmodule();

    const map = await completionHeadBlobMap(root, superSha, ['never/written.ts']);

    expect(map?.get('never/written.ts')).toEqual({ status: 'absent' });
  });

  it('answers EVERY requested path, so absence from the map is never a verdict', async () => {
    const { root, superSha, innerPath } = buildSuperprojectWithSubmodule();
    const paths = [innerPath, 'top.ts', 'never/written.ts'];

    const map = await completionHeadBlobMap(root, superSha, paths);

    // The pre-fix contract signalled "not in the commit" by OMITTING the path, which is
    // what let an unreadable submodule masquerade as a missing file downstream.
    for (const path of paths) expect(map?.has(path)).toBe(true);
  });

  it('keeps the event loop responsive while a bounded Git tree read is in flight', async () => {
    const { root, superSha } = buildSuperprojectWithSubmodule();
    const slowGit = join(root, 'slow-git');
    writeFileSync(slowGit, '#!/bin/sh\nsleep 0.15\nexec git "$@"\n');
    chmodSync(slowGit, 0o755);

    let timerFired = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 10);
    });
    const lookup = completionHeadBlobMap(root, superSha, ['top.ts'], { gitBinary: slowGit, timeoutMs: 2_000 });
    await timer;

    expect(timerFired).toBe(true);
    expect((await lookup)?.get('top.ts')?.status).toBe('resolved');
  });
});

describe('the three states stay distinguishable (permanent controls)', () => {
  /**
   * A deliberately-wrong resolver kept in the test file forever, per the repo's
   * falsifiability rule — production code is never mutated to prove a guard bites.
   * This is the PRE-FIX shape: absence carries both meanings.
   */
  const conflatingResolver = (present: Map<string, string>) =>
    (paths: readonly string[]): Map<string, HeadBlobResolution> => {
      const out = new Map<string, HeadBlobResolution>();
      for (const path of paths) {
        const sha = present.get(path);
        // The bug: everything not present is reported as a fact about the commit.
        out.set(path, sha ? { status: 'resolved', sha } : { status: 'absent' });
      }
      return out;
    };

  it('the conflating resolver cannot tell the two failures apart — the fixed one can', () => {
    const paths = ['sub/inner.ts'];
    const conflated = conflatingResolver(new Map())(paths).get('sub/inner.ts');
    // Both real-world causes collapse onto one answer, which is the defect.
    expect(conflated).toEqual({ status: 'absent' });

    const fixed: HeadBlobResolution = { status: 'unresolvable', reason: "submodule 'sub' could not be read" };
    expect(fixed).not.toEqual(conflated);
  });

  it('unresolvableContentIdentityPaths reports only the server-side failures', () => {
    const surfaced = unresolvableContentIdentityPaths({
      contentIdentity: [
        { path: 'ok.ts', workingTreeBlobSha: 'a'.repeat(40), headBlobSha: 'a'.repeat(40) },
        // CONTROL: a genuine mismatch is the CLOSER's to fix and must NOT be surfaced as
        // a server failure — otherwise the specific message would replace correct advice.
        { path: 'mismatch.ts', workingTreeBlobSha: 'b'.repeat(40), headBlobSha: 'c'.repeat(40) },
        // CONTROL: a plain missing HEAD side, with no reason, is likewise not ours.
        { path: 'missing.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: null },
        {
          path: 'sub/inner.ts',
          workingTreeBlobSha: 'e'.repeat(40),
          headBlobSha: null,
          headBlobUnresolvable: "submodule 'sub' could not be read at abc123456789",
        },
      ],
    });

    expect(surfaced).toEqual([
      { path: 'sub/inner.ts', headBlobUnresolvable: "submodule 'sub' could not be read at abc123456789" },
    ]);
  });

  it('surfaces nothing for a stamp with no content identity at all', () => {
    expect(unresolvableContentIdentityPaths(undefined)).toEqual([]);
    expect(unresolvableContentIdentityPaths({})).toEqual([]);
  });
});
