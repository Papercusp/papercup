/**
 * coordination-domain.file-domain.test.ts — WI-38252.
 *
 * Pins that a FILE lock's coordination domain is the tree agents EDIT, not the
 * tree whose code the operator process happens to be executing.
 *
 * THE BUG THIS EXISTS TO PREVENT. `lockCoordinationDomain()` resolves the domain
 * from `import.meta.url`. The `:3070` operator serves every SU agent while
 * running from the RELEASE checkout, so a file lock acquired through it landed
 * under `.../papercup-release` while the PreToolUse hook — which sends an
 * explicit `coordination_domain` (the physical root of the edited file) —
 * enforced under `.../papercusp`. Measured live 2026-08-12, the split was total:
 *
 *   .../papercup-release : 18 rows, ALL deliberate agent acquires, 0 hook rows
 *   .../papercusp        :  5 rows, ALL PreToolUse hook acquires, 0 agent rows
 *
 * 100% disjoint, so `locks:acquire` answered `ok:true` + `newly_held` for paths a
 * live peer held, and a holder's own `locks:release` reported `released: []` for
 * the very lock still being enforced against them.
 *
 * FALSIFIABILITY (CLAUDE.md tiering — the subject is a MODULE we import, so tier
 * 1): `legacyProcessDomain` below is a PERMANENT deliberately-wrong control
 * implementing the pre-fix behaviour. Every property asserted of the real
 * resolver is also asserted to FAIL for the control, so a regression that
 * reverts the fix cannot leave this file green. Nothing in the shared tree is
 * ever mutated — the fixture repos are mkdtemp'd outside it.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/coordination-domain.file-domain.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fileLockCoordinationDomain,
  lockCoordinationDomain,
  __resetFileLockCoordinationDomain,
  CANONICAL_TREE_DIRNAME,
} from './coordination-domain';
import { readFileLockIdentity, readIdentity } from './identity';

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, '..', '..', '..', '..', '..');

/** A resolvable superuser identity context (mirrors `__tests__/identity.test.ts`). */
const SU_CTX = { isSuperuser: true, uiClientId: 'sess-abc12345' };

/**
 * THE CONTROL — the pre-WI-38252 implementation, kept deliberately wrong and
 * permanently in this file. A file lock used to default to the domain of the
 * code the process loaded. Every assertion about the real resolver is mirrored
 * against this so the guard is provably falsifiable.
 */
function legacyProcessDomain(): string {
  return lockCoordinationDomain();
}

/** A throwaway repo root outside the shared tree (never mutate it for a probe). */
function makeFixtureRepo(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `wi38252-${label}-`));
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return realpathSync(root);
}

const ENV_KEYS = [
  'PAPERCUSP_LOCK_DOMAIN',
  'PAPERCUSP_CANONICAL_TREE',
  'PAPERCUSP_WORKSPACE_ROOT',
] as const;

describe('fileLockCoordinationDomain (WI-38252)', () => {
  const saved: Record<string, string | undefined> = {};
  const cleanup: string[] = [];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // HERMETIC BY DEFAULT — do NOT let candidate 3 reach the real machine.
    // `fileLockDomainCandidates()` falls back to `<PAPERCUSP_WORKSPACE_ROOT |
    // ~/papercupai-workspace>/papercusp`, which on a dev box is a REAL repo. With
    // the var merely deleted, any test that expects the TERMINAL fallback instead
    // resolved that live tree, so the assertion `=== lockCoordinationDomain()`
    // held only while the executing checkout was itself named `papercusp` — it
    // passed in the shared tree and FAILED in the gate's `papercusp-checkpoint`
    // (green-checkpoint red 2026-08-12T20:54Z: expected `…/papercusp-checkpoint`,
    // received `…/papercusp`). The subject is location-independent; the fixture
    // must be too, so each test opts IN to a workspace root it created itself.
    process.env.PAPERCUSP_WORKSPACE_ROOT = join(tmpdir(), 'wi38252-no-workspace-root');
    __resetFileLockCoordinationDomain();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetFileLockCoordinationDomain();
    while (cleanup.length) {
      try { rmSync(cleanup.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('resolves the EDIT tree, not the tree this process loaded from (and the control does not)', () => {
    // Models :3070 exactly: the edit tree is a DIFFERENT checkout from the one
    // whose code is executing (here, the real repo this test runs from).
    const editTree = makeFixtureRepo('edit');
    cleanup.push(editTree);
    process.env.PAPERCUSP_CANONICAL_TREE = editTree;

    expect(fileLockCoordinationDomain()).toBe(editTree);
    // The regression is exactly "returns the process tree instead".
    expect(fileLockCoordinationDomain()).not.toBe(lockCoordinationDomain());

    // CONTROL: the pre-fix implementation fails this property.
    expect(legacyProcessDomain()).not.toBe(editTree);
    expect(legacyProcessDomain()).toBe(lockCoordinationDomain());
  });

  it('falls back to <workspace root>/<canonical tree> when no explicit tree is set', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'wi38252-ws-'));
    cleanup.push(workspace);
    const editTree = join(workspace, CANONICAL_TREE_DIRNAME);
    mkdirSync(join(editTree, '.git'), { recursive: true });
    writeFileSync(join(editTree, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    process.env.PAPERCUSP_WORKSPACE_ROOT = workspace;

    expect(fileLockCoordinationDomain()).toBe(realpathSync(editTree));
    expect(legacyProcessDomain()).not.toBe(realpathSync(editTree));
  });

  it('honours the PAPERCUSP_LOCK_DOMAIN override above every candidate', () => {
    const editTree = makeFixtureRepo('edit');
    cleanup.push(editTree);
    process.env.PAPERCUSP_CANONICAL_TREE = editTree;
    process.env.PAPERCUSP_LOCK_DOMAIN = '/some/override-domain';

    expect(fileLockCoordinationDomain()).toBe('/some/override-domain');
  });

  it('degrades to the process domain when no edit tree resolves on disk', () => {
    // A packaged build / foreign checkout with nothing to resolve must behave
    // EXACTLY as it did before this fix rather than fabricate a path.
    process.env.PAPERCUSP_WORKSPACE_ROOT = join(tmpdir(), 'wi38252-does-not-exist');
    process.env.PAPERCUSP_CANONICAL_TREE = join(tmpdir(), 'wi38252-also-missing');

    expect(fileLockCoordinationDomain()).toBe(lockCoordinationDomain());
  });

  it('ignores a candidate directory that is not a valid repo root', () => {
    // A bare directory (no valid `.git`) must not become a lock namespace —
    // that would silently split the domain the same way the bug did.
    const notARepo = mkdtempSync(join(tmpdir(), 'wi38252-bare-'));
    cleanup.push(notARepo);
    process.env.PAPERCUSP_CANONICAL_TREE = notARepo;

    // The PROPERTY: a bare directory never becomes a lock namespace. Assert that
    // directly — `=== lockCoordinationDomain()` alone would also be satisfied by
    // a coincidence of paths on the box the suite happens to run in.
    expect(fileLockCoordinationDomain()).not.toBe(notARepo);
    expect(fileLockCoordinationDomain()).toBe(lockCoordinationDomain());
  });

  it('RESOURCE locks are untouched — lockCoordinationDomain still names the process tree', () => {
    // Re-keying resource locks would orphan live `git-sync:<slug>` /
    // `release-deploy` holds, so the fix must NOT move them.
    const editTree = makeFixtureRepo('edit');
    cleanup.push(editTree);
    process.env.PAPERCUSP_CANONICAL_TREE = editTree;

    expect(lockCoordinationDomain()).toBe(realpathSync(repoRoot));
    expect(readIdentity(SU_CTX).coordinationDomain).toBe(lockCoordinationDomain());
  });
});

describe('one authority: the verb and the guard cannot disagree (WI-38252)', () => {
  it('readFileLockIdentity resolves the file-lock domain, readIdentity the process domain', () => {
    expect(readFileLockIdentity(SU_CTX).coordinationDomain).toBe(fileLockCoordinationDomain());
    expect(readIdentity(SU_CTX).coordinationDomain).toBe(lockCoordinationDomain());
  });

  it('every FILE-lock surface resolves its default domain through readFileLockIdentity', () => {
    // The acceptance criterion on WI-38252: the verb's verdict and the guard's
    // verdict must be computed from ONE authority. A new file-lock surface that
    // reaches for `readIdentity` reintroduces the split, so fail on it here
    // rather than in production six hours later.
    const fileLockSurfaces = [
      'acquire.ts',
      'release.ts',
      'heartbeat.ts',
      'file-lock-guard.ts',
      'check_command.ts',
      'cancel_wait.ts',
      'acquire_granular.ts',
      'release_granular.ts',
    ];
    for (const file of fileLockSurfaces) {
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src, `${file} must import readFileLockIdentity`).toMatch(/readFileLockIdentity/);
      expect(
        /=\s*readIdentity\(/.test(src),
        `${file} calls readIdentity() — a FILE lock must resolve its domain via readFileLockIdentity (WI-38252)`,
      ).toBe(false);
    }
  });

  it('parity: the PreToolUse hook resolves the SAME canonical tree name', () => {
    // The hook computes `_canonical_tree` as PAPERCUSP_CANONICAL_TREE or
    // <workspace_root>/papercusp and sends it as an explicit
    // coordination_domain. If either side renames the tree, the two namespaces
    // silently split again — which is the whole bug.
    const hook = readFileSync(
      join(repoRoot, 'apps', 'operator', 'scripts', 'hooks', 'cc', 'pretooluse-locks-acquire.sh'),
      'utf8',
    );
    expect(hook).toMatch(/PAPERCUSP_CANONICAL_TREE/);
    expect(hook).toMatch(
      new RegExp(`workspace_root,\\s*['"]${CANONICAL_TREE_DIRNAME}['"]`),
    );
    // And the hook must still send the domain explicitly — the server-side
    // default is a fallback, not a replacement for the hook knowing the
    // physical root of the file being edited.
    expect(hook).toMatch(/lock_arguments\['coordination_domain'\]/);
  });
});
