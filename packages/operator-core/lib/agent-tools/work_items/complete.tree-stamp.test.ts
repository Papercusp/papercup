/**
 * EI-18682004530991057 (proposal 3) — `completionTreeStamp`: record WHICH COMMIT a
 * completion's verification was observed against.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `testResult: "172 passed / 0 failed"` names no particular code. Every agent here
 * edits ONE shared working tree, so an unstamped result cannot be distinguished from
 * one describing an older revision — or a tree a peer was halfway through editing when
 * the suite ran. EI-18681435059177620 measured that directly: three measurements of one
 * file were each invalidated by an edit landing on top, producing a false alarm AND a
 * false all-clear within 25 minutes.
 *
 * Measured live 2026-08-12 (EI-20275701671571753): an agent ran the prompt-weight gate
 * against a DIRTY tree holding a half-finished peer edit, read 1604 chars, and filed a
 * fleet-blocking gate red. Neither the pre-edit state (1336) nor the post-edit state
 * (1478) can produce 1604 — the number described a transient that was never committed
 * and never existed for anybody else. A stamped measurement is self-evidently anchored.
 *
 * ── HOW THIS FILE PROVES ITSELF ────────────────────────────────────────────
 * Falsifiability is structural: the suite asserts BOTH directions, so a degenerate
 * implementation cannot pass it. One that always returned `undefined` fails every
 * "RESOLVES" case; one that returned a constant sha fails every "stays SILENT" case.
 * The silent half is the fail-open contract (EI-24 record-and-warn) — absence must mean
 * "not observed", never "clean".
 *
 * Two controls carry most of the weight, because both encode a WRONG stamp rather than
 * a missing one, and a wrong stamp is worse than none (it anchors evidence to code that
 * never produced it):
 *   - the packed-refs EXACT-match control, MEASURED 2026-08-12 to kill a last-path-segment
 *     comparison (`name.split('/').pop() === ref.split('/').pop()`) — the realistic wrong
 *     implementation, since it binds `refs/heads/staging` to `refs/remotes/origin/staging`
 *     and stamps a commit the local tree is not on;
 *   - the read-budget control, which fails any implementation that resolves HEAD by
 *     spawning `git` (see the spawn-free note below).
 *
 * ⚠ What that first control does NOT constrain, established by the same probe rather than
 * assumed: a full-ref `endsWith(ref)`/`includes(ref)` matcher SURVIVES it — and correctly
 * so, because `refs/remotes/origin/staging` does not end with `refs/heads/staging`. The
 * first mutation tried here was exactly that, and it survived; the control is stated in
 * terms of the mutation actually measured, not the one that sounded dangerous. Do not
 * re-broaden this claim without re-running the probe:
 *   scripts/mutation-probe.sh --in-tree --file <complete.ts> \
 *     --mutate "s{name === ref}{name?.split('/').pop() === ref.split('/').pop()}" \
 *     --test 'npm run test:file -- <this file>' --expect caught
 *
 * ⚠ SPAWN-FREE: EI-18808838427010743 (open, CRITICAL) measures each `git` spawn from the
 * bg-host as ~165ms of blocked event loop (fork() from a multi-GB-RSS parent costs
 * ~40ms/GB). work_items:complete is a fleet-wide hot path, so this must never shell out.
 *
 * PURE: the filesystem is injected, so this never touches a real tree.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  completionRepoRootsFromRegistry,
  completionTreeStamp,
  completionTreeStampForEvidence,
} from './complete';

const ROOT = '/repo';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = '0000111122223333444455556666777788889999';
const TEMP_ROOTS: string[] = [];

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Build a probe over a pretend git dir; also records every path read. */
function probeOver(files: Record<string, string>, repoRoot: string | null = ROOT) {
  const reads: string[] = [];
  return {
    reads,
    probe: {
      repoRoot,
      readFile: (abs: string): string | undefined => {
        reads.push(abs);
        return files[abs];
      },
    },
  };
}

describe('completionTreeStamp (EI-18682004530991057)', () => {
  describe('RESOLVES the head sha', () => {
    it('follows a symbolic HEAD to a loose ref', () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/refs/heads/staging': `${SHA}\n`,
      });
      expect(completionTreeStamp(probe)).toEqual({ headSha: SHA });
    });

    it('reads a detached HEAD directly', () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': `${SHA}\n` });
      expect(completionTreeStamp(probe)).toEqual({ headSha: SHA });
    });

    it('falls back to packed-refs when the loose ref has been packed away', () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/packed-refs':
          '# pack-refs with: peeled fully-peeled sorted\n' +
          `${OTHER_SHA} refs/heads/main\n` +
          `${SHA} refs/heads/staging\n`,
      });
      expect(completionTreeStamp(probe)).toEqual({ headSha: SHA });
    });

    it('follows a `.git` FILE to its gitdir (a worktree or submodule checkout)', () => {
      const { probe } = probeOver({
        '/repo/.git': 'gitdir: /elsewhere/worktrees/wt1\n',
        '/elsewhere/worktrees/wt1/HEAD': 'ref: refs/heads/feature\n',
        '/elsewhere/worktrees/wt1/refs/heads/feature': `${SHA}\n`,
      });
      expect(completionTreeStamp(probe)).toEqual({ headSha: SHA });
    });

    it('accepts a 64-char sha256 object id', () => {
      const sha256 = 'f'.repeat(64);
      const { probe } = probeOver({ '/repo/.git/HEAD': `${sha256}\n` });
      expect(completionTreeStamp(probe)).toEqual({ headSha: sha256 });
    });
  });

  describe('stays SILENT when it cannot observe (fail-open — absence never means "clean")', () => {
    it('when there is no repo root', () => {
      const { probe } = probeOver({}, null);
      expect(completionTreeStamp(probe)).toBeUndefined();
    });

    it('when HEAD is absent', () => {
      const { probe } = probeOver({});
      expect(completionTreeStamp(probe)).toBeUndefined();
    });

    it('when HEAD is present but empty', () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': '   \n' });
      expect(completionTreeStamp(probe)).toBeUndefined();
    });

    it('when HEAD holds neither a sha nor a ref', () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': 'something unexpected\n' });
      expect(completionTreeStamp(probe)).toBeUndefined();
    });

    it('when the ref resolves nowhere — no loose ref and no packed-refs', () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': 'ref: refs/heads/staging\n' });
      expect(completionTreeStamp(probe)).toBeUndefined();
    });

    it('when the loose ref exists but is not shaped like a sha', () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/refs/heads/staging': 'not-a-sha\n',
      });
      expect(completionTreeStamp(probe)).toBeUndefined();
    });

    it('when a truncated/short sha is offered — a partial id must not be stamped as full', () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': 'a1b2c3d\n' });
      expect(completionTreeStamp(probe)).toBeUndefined();
    });

    it('when `.git` is a readable FILE that is not a gitdir pointer', () => {
      const { probe } = probeOver({ '/repo/.git': 'total nonsense\n' });
      expect(completionTreeStamp(probe)).toBeUndefined();
    });

    it('when the probe throws — evidence-stamping must never fail a close', () => {
      expect(
        completionTreeStamp({
          repoRoot: ROOT,
          readFile: () => {
            throw new Error('EIO');
          },
        }),
      ).toBeUndefined();
    });

    it('when repoRoot is EXPLICITLY null, without falling back to detection', () => {
      // Distinct from omitting the key: an explicit null means "I could not resolve a
      // root, do not guess". Collapsing the two would judge against the wrong tree.
      const { probe, reads } = probeOver({ '/repo/.git/HEAD': `${SHA}\n` }, null);
      expect(completionTreeStamp(probe)).toBeUndefined();
      expect(reads).toEqual([]);
    });
  });

  describe('controls — a WRONG stamp is worse than none', () => {
    it('matches packed-refs by EXACT ref name, never by suffix', () => {
      // The killer case: a suffix/`includes` matcher binds refs/heads/staging to the
      // REMOTE-tracking ref and stamps a commit the local tree is not on. origin/staging
      // is listed FIRST so a naive scan hits it before any correct entry.
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/packed-refs':
          `${OTHER_SHA} refs/remotes/origin/staging\n` + `${SHA} refs/heads/staging\n`,
      });
      expect(completionTreeStamp(probe)).toEqual({ headSha: SHA });
    });

    it('does NOT stamp the remote ref when the local branch is absent entirely', () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/packed-refs': `${OTHER_SHA} refs/remotes/origin/staging\n`,
      });
      expect(completionTreeStamp(probe)).toBeUndefined();
    });

    it('prefers the loose ref over a stale packed-refs entry for the same name', () => {
      // Git's own precedence. Inverting it stamps the commit the branch used to be on.
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/refs/heads/staging': `${SHA}\n`,
        '/repo/.git/packed-refs': `${OTHER_SHA} refs/heads/staging\n`,
      });
      expect(completionTreeStamp(probe)).toEqual({ headSha: SHA });
    });

    it('ignores the peeled-tag (`^`) continuation lines in packed-refs', () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/packed-refs':
          `${OTHER_SHA} refs/tags/v1\n` + `^${'b'.repeat(40)}\n` + `${SHA} refs/heads/staging\n`,
      });
      expect(completionTreeStamp(probe)).toEqual({ headSha: SHA });
    });

    it('resolves within a tight read budget — the spawn-free contract', () => {
      // Not a style preference: EI-18808838427010743 measures each `git` spawn from the
      // bg-host at ~165ms of BLOCKED event loop, and this runs on every completion
      // fleet-wide. An implementation that shelled out would resolve HEAD without
      // reading these files at all, failing this assertion.
      const { probe, reads } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/refs/heads/staging': `${SHA}\n`,
      });
      expect(completionTreeStamp(probe)).toEqual({ headSha: SHA });
      expect(reads).toEqual(['/repo/.git', '/repo/.git/HEAD', '/repo/.git/refs/heads/staging']);
      expect(reads.length).toBeLessThanOrEqual(3);
    });
  });
});

describe('completionTreeStampForEvidence (EI-20460682854560939)', () => {
  const OPERATOR_ROOT = '/operator';
  const SIDESTAGE_ROOT = '/sidestage';
  const OPERATOR_SHA = '1111111111111111111111111111111111111111';
  const SIDESTAGE_SHA = '2222222222222222222222222222222222222222';
  const files = {
    '/operator/.git/HEAD': OPERATOR_SHA,
    '/sidestage/.git/HEAD': SIDESTAGE_SHA,
  };
  const readFile = (abs: string): string | undefined => files[abs as keyof typeof files];

  it('discovers and stamps an unregistered independent sibling checkout', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'completion-tree-stamp-sibling-'));
    TEMP_ROOTS.push(workspaceRoot);
    const operatorRoot = join(workspaceRoot, 'papercusp');
    const sidestageRoot = join(workspaceRoot, 'sidestage');
    mkdirSync(join(operatorRoot, '.git'), { recursive: true });
    mkdirSync(join(sidestageRoot, '.git'), { recursive: true });
    mkdirSync(join(sidestageRoot, 'apps', 'web', 'src'), { recursive: true });
    writeFileSync(join(operatorRoot, '.git', 'HEAD'), `${OPERATOR_SHA}\n`);
    writeFileSync(join(sidestageRoot, '.git', 'HEAD'), `${SIDESTAGE_SHA}\n`);
    writeFileSync(join(sidestageRoot, 'apps', 'web', 'src', 'BuyerTab.thumbnail.test.tsx'), 'test\n');

    const roots = completionRepoRootsFromRegistry(operatorRoot, { projects: [] });
    expect(roots).toEqual([operatorRoot, sidestageRoot]);
    expect(
      completionTreeStampForEvidence(
        { filesChanged: ['apps/web/src/BuyerTab.thumbnail.test.tsx'] },
        roots,
      ),
    ).toEqual({ headSha: SIDESTAGE_SHA });
  });

  it('stamps the registered sibling checkout that owns the declared changed file', () => {
    expect(
      completionTreeStampForEvidence(
        { filesChanged: ['apps/web/src/BuyerTab.thumbnail.test.tsx'] },
        [OPERATOR_ROOT, SIDESTAGE_ROOT],
        {
          exists: (abs) => abs === '/sidestage/apps/web/src/BuyerTab.thumbnail.test.tsx',
          readFile,
        },
      ),
    ).toEqual({ headSha: SIDESTAGE_SHA });
  });

  it('stamps the owning checkout when filesChanged uses an absolute path', () => {
    const absolutePath = `${SIDESTAGE_ROOT}/apps/web/src/BuyerTab.thumbnail.test.tsx`;
    expect(
      completionTreeStampForEvidence(
        { filesChanged: [absolutePath] },
        [OPERATOR_ROOT, SIDESTAGE_ROOT],
        { exists: (abs) => abs === absolutePath, readFile },
      ),
    ).toEqual({ headSha: SIDESTAGE_SHA });
  });

  it('keeps the primary checkout on a tie so legacy completions do not change repositories', () => {
    expect(
      completionTreeStampForEvidence(
        { filesChanged: ['shared/path.ts'] },
        [OPERATOR_ROOT, SIDESTAGE_ROOT],
        {
          exists: (abs) => abs.endsWith('/shared/path.ts'),
          readFile,
        },
      ),
    ).toEqual({ headSha: OPERATOR_SHA });
  });

  it('keeps the primary checkout when the completion declares no resolvable files', () => {
    expect(
      completionTreeStampForEvidence(
        { filesChanged: ['missing.ts'] },
        [OPERATOR_ROOT, SIDESTAGE_ROOT],
        { exists: () => false, readFile },
      ),
    ).toEqual({ headSha: OPERATOR_SHA });
  });
});
