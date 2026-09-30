import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

// WI-6824: runGitSync's `log` sink defaults to console.warn. It used to default to a no-op,
// which is why an unrelated-history merge failure alarmed the fleet for ~10h while leaving
// ZERO trace in journald — and why this suite passed in silence despite driving the
// conflict/error/oversized/quarantine paths, all of which narrate. The narration is
// EXPECTED here, so capture it rather than letting vitest-fail-on-console reject it.
let gitSyncWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  gitSyncWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  gitSyncWarnSpy?.mockRestore();
  gitSyncWarnSpy = undefined;
});
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  existsSync,
  openSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  runGitSync,
  classifyProtectedPathExclusions,
  addFailureIgnoredPaths,
  addFailureStrayPaths,
  discoverSubmodulesRecursive,
  isIndexLockFailure,
  isConfigLockFailure,
  isPathspecBeyondSymbolicLinkFailure,
  isTransientStatFailure,
  preflightInvalidIndex,
  MIN_VALID_GIT_INDEX_BYTES,
  clearStaleIndexLock,
  clearStaleConfigLock,
  scavengeStaleTempPacks,
  STALE_TEMP_PACK_MS,
  GIT_SYNC_BOT_EMAIL,
  GIT_SYNC_BOT_NAME,
  affectsToolRouting,
  affectsGeneratedDeclarations,
  checkToolRoutingBeforeCommit,
  generatedDeclarationPair,
  DECLARATION_STATUS_MAX_RETRIES,
  regenerateGeneratedDeclarationsBeforeCommit,
  regenerateToolCatalogBeforeCommit,
  expandAtomicLiveLockExclusions,
  expandNpmManifestClosure,
  summarizeFetchFailure,
  isNpmManifestPath,
  runGitBounded,
  censusStrandedSubmodules,
  type RunGit,
} from './run-git-sync';
import type { FileAttribution } from './git-sync-attribution';
import type { ContentDetector } from '../../content-lint/registry';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { requireHiveEffectAuthority } from '../../sync/pot-git/hive-effect-authority';

/** A test content detector that quarantines any matched file whose text contains BROKEN. */
const brokenDetector: ContentDetector = {
  key: 'fake-broken',
  glob: '**/*.md',
  matches: (f) => f.endsWith('.md'),
  detect: (_f, text) => (text.includes('BROKEN') ? 'contains BROKEN' : null),
  fixerRole: 'content-fixer',
};

/** Run git synchronously for test setup; throws on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}
function configUser(repo: string): void {
  git(repo, 'config', 'user.email', 'test@papercusp.local');
  git(repo, 'config', 'user.name', 'git-sync test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

/** Avoid the production spawner sidecar in this focused real-git regression. */
const directRunGit: RunGit = async (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? result.error ?? ''),
  };
};

// The production sidecar is selected through the shared enable flag. Tests in
// this file create disposable repositories and must exercise the injected/local
// runner regardless of the host's inherited sidecar setting. Preserve an
// explicit caller override so the suite remains non-destructive to its process.
let savedGitSyncSidecarOverride: string | undefined;
beforeAll(() => {
  savedGitSyncSidecarOverride = process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR;
  process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR = '0';
});
afterAll(() => {
  if (savedGitSyncSidecarOverride === undefined) delete process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR;
  else process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR = savedGitSyncSidecarOverride;
  savedGitSyncSidecarOverride = undefined;
});

const REPO_ROOT = resolve(__dirname, '../../../../..');

describe('expandAtomicLiveLockExclusions — staggered edit-lock protection', () => {
  it('expands one live-held file to every dirty file in its attributed work-item cohort', () => {
    const attribution = new Map<string, FileAttribution>([
      ['source.ts', { agent: 'su-peer', workItems: ['WI-1834529'] }],
      ['source.test.ts', { agent: 'su-peer', workItems: ['WI-1834529'] }],
      ['unrelated.ts', { agent: 'su-peer', workItems: ['WI-other'] }],
    ]);

    expect(
      expandAtomicLiveLockExclusions(
        ['source.ts', 'source.test.ts', 'unrelated.ts'],
        [{ path: 'source.ts', owner: 'su-peer', intent: 'editing source', goalRef: ' WI-1834529 ' }],
        attribution,
      ),
    ).toEqual({
      paths: ['source.test.ts', 'source.ts'],
      groups: [{
        key: JSON.stringify(['su-peer', 'WI-1834529']),
        owner: 'su-peer',
        goalRef: 'WI-1834529',
        paths: ['source.test.ts', 'source.ts'],
      }],
    });
  });

  it('keeps legacy/null-goal locks at per-path granularity instead of grouping by owner', () => {
    const attribution = new Map<string, FileAttribution>([
      ['source.ts', { agent: 'su-peer', workItems: ['WI-legacy'] }],
      ['source.test.ts', { agent: 'su-peer', workItems: ['WI-legacy'] }],
    ]);

    expect(
      expandAtomicLiveLockExclusions(
        ['source.ts', 'source.test.ts'],
        [{ path: 'source.ts', owner: 'su-peer', intent: 'editing source' }],
        attribution,
      ),
    ).toEqual({ paths: ['source.ts'], groups: [] });
  });

  it('requires both the lock owner and work-item to match before expanding a cohort', () => {
    const attribution = new Map<string, FileAttribution>([
      ['source.ts', { agent: 'su-peer', workItems: ['WI-atomic'] }],
      ['source.test.ts', { agent: 'su-peer', workItems: ['WI-atomic'] }],
      ['other-work.ts', { agent: 'su-peer', workItems: ['WI-other'] }],
      ['other-owner.ts', { agent: 'su-other', workItems: ['WI-atomic'] }],
    ]);

    expect(
      expandAtomicLiveLockExclusions(
        ['source.ts', 'source.test.ts', 'other-work.ts', 'other-owner.ts'],
        [{ path: 'source.ts', owner: 'su-peer', intent: 'editing source', goalRef: 'WI-atomic' }],
        attribution,
      ),
    ).toEqual({
      paths: ['source.test.ts', 'source.ts'],
      groups: [{
        key: JSON.stringify(['su-peer', 'WI-atomic']),
        owner: 'su-peer',
        goalRef: 'WI-atomic',
        paths: ['source.test.ts', 'source.ts'],
      }],
    });
  });
});

// EI-24649116564770033 / WI-10004077: a withheld manifest must not let the rest of an npm
// dependency change land alone (observed: operator-core's dep without root entry + lockfile).
describe('summarizeFetchFailure — a failed fetch keeps its reason (WI-10004103)', () => {
  it('prefers the disk-headroom refusal over surrounding git noise', () => {
    const stderr =
      'remote: Enumerating objects: 5\n' +
      'git fetch stopped for disk headroom at /home/u/repo/.git/objects: 30064771072 bytes available; critical reserve 43249416192 bytes\n' +
      'error: some trailing line\n';
    expect(summarizeFetchFailure(stderr)).toBe(
      'git fetch stopped for disk headroom at /home/u/repo/.git/objects: 30064771072 bytes available; critical reserve 43249416192 bytes',
    );
  });

  it('otherwise uses the last non-empty line, whitespace collapsed', () => {
    expect(summarizeFetchFailure("From x\n  fatal:   unable to access 'https://github.com/o/r/':  Could not resolve host\n\n")).toBe(
      "fatal: unable to access 'https://github.com/o/r/': Could not resolve host",
    );
  });

  it('is empty for empty stderr and caps a runaway line', () => {
    expect(summarizeFetchFailure('')).toBe('');
    expect(summarizeFetchFailure(undefined)).toBe('');
    const long = summarizeFetchFailure(`fatal: ${'x'.repeat(1000)}`);
    expect(long.length).toBe(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('expandNpmManifestClosure — npm manifests land together', () => {
  const dirty = [
    'package.json',
    'package-lock.json',
    'packages/operator-core/package.json',
    'packages/operator-core/lib/x.ts',
  ];

  it('withholds every other dirty manifest when the root package.json is withheld', () => {
    expect(expandNpmManifestClosure(dirty, ['package.json'])).toEqual({
      paths: ['package-lock.json', 'packages/operator-core/package.json'],
      triggers: ['package.json'],
    });
  });

  it('is triggered by a withheld workspace manifest too, and by a directory exclusion', () => {
    expect(expandNpmManifestClosure(dirty, ['packages/operator-core']).paths).toEqual([
      'package-lock.json',
      'package.json',
    ]);
  });

  it('does nothing when no dirty manifest is withheld, including a lock on a CLEAN manifest', () => {
    expect(expandNpmManifestClosure(dirty, ['packages/operator-core/lib/x.ts'])).toEqual({ paths: [], triggers: [] });
    expect(expandNpmManifestClosure(['packages/a/package.json'], ['package.json'])).toEqual({ paths: [], triggers: [] });
  });

  it('never treats node_modules or look-alike names as manifests', () => {
    expect(isNpmManifestPath('node_modules/x/package.json')).toBe(false);
    expect(isNpmManifestPath('docs/package.json.md')).toBe(false);
    expect(isNpmManifestPath('npm-shrinkwrap.json')).toBe(true);
    expect(
      expandNpmManifestClosure(['package.json', 'node_modules/x/package.json'], ['package.json']).paths,
    ).toEqual([]);
  });
});

describe('git-sync commit identity', () => {
  it('uses a verified GitHub no-reply email for automated pushes', () => {
    expect(GIT_SYNC_BOT_NAME).toBe('papercusp-git-sync');
    expect(GIT_SYNC_BOT_EMAIL).toBe('papercupai@users.noreply.github.com');
    expect(GIT_SYNC_BOT_EMAIL).not.toMatch(/@papercusp\.local$/);
  });
});

describe('EI-217286 action abort propagation', () => {
  it('terminates a signal-bearing local git child instead of leaving it running after lease cleanup', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'git-sync-abort-'));
    execFileSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    const savedMode = process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE;
    const controller = new AbortController();
    process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE = '1'; // force the cancellable local runner
    const abortTimer = setTimeout(() => controller.abort(new Error('test action timeout')), 25);
    abortTimer.unref?.();
    try {
      const result = await runGitBounded(
        ['-c', 'alias.wait=!exec sleep 30', 'wait'],
        repo,
        5_000,
        { signal: controller.signal },
      );

      expect(result.code).toBe(-1);
      expect(result.stderr).toContain('aborted by the git-sync stall guard');
    } finally {
      clearTimeout(abortTimer);
      if (savedMode === undefined) delete process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE;
      else process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE = savedMode;
    }
  });
});

describe('WI-39922 tool-catalog pre-commit regeneration', () => {
  it('runs the generator for a catalog-affecting dirty source when the canonical surfaces are tracked', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: ' M packages/operator-core/lib/agent-tools/example.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout: 'scripts/gen-tool-catalog.ts\n.papercusp/tool-catalog.json\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: 'wrote catalog', stderr: '' }));
    const logs: string[] = [];

    await regenerateToolCatalogBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      runGenerator,
    );

    expect(runGenerator).toHaveBeenCalledOnce();
    expect(calls.map((args) => args[0])).toEqual(['status', 'ls-files']);
    expect(logs.join('\n')).toMatch(/regenerated \.papercusp\/tool-catalog\.json before commit/);
  });

  it('does nothing for irrelevant dirty paths, including adjacent tool test files', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: ' M README.md\0 M packages/operator-core/lib/agent-tools/example.test.ts\0',
        stderr: '',
      };
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    await regenerateToolCatalogBeforeCommit({ runGit, repoPath: '/fake', log: () => {} }, runGenerator);

    expect(runGenerator).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('status');
  });

  it('does not run the papercusp-specific generator when its tracked surfaces are absent', async () => {
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: ' M packages/operator-core/lib/agent-tools/example.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    await regenerateToolCatalogBeforeCommit({ runGit, repoPath: '/unrelated-repo', log: () => {} }, runGenerator);

    expect(runGenerator).not.toHaveBeenCalled();
  });
});

describe('EI-21444216858331991 generated declarations pre-commit regeneration', () => {
  it('maps both halves of a generated declaration pair and ignores unrelated paths', () => {
    expect(generatedDeclarationPair('apps/operator/scripts/psu-launcher.mjs')).toEqual({
      source: 'apps/operator/scripts/psu-launcher.mjs',
      artifact: 'apps/operator/scripts/psu-launcher.d.mts',
    });
    expect(generatedDeclarationPair('apps/operator/scripts/psu-launcher.d.mts')).toEqual({
      source: 'apps/operator/scripts/psu-launcher.mjs',
      artifact: 'apps/operator/scripts/psu-launcher.d.mts',
    });
    expect(affectsGeneratedDeclarations('tsconfig.declarations.json')).toBe(true);
    expect(affectsGeneratedDeclarations('package-lock.json')).toBe(true);
    expect(affectsGeneratedDeclarations('README.md')).toBe(false);
  });

  it('regenerates an enrolled dirty source and returns the pair as one atomic commit group', async () => {
    const source = 'apps/operator/scripts/psu-launcher.mjs';
    const artifact = 'apps/operator/scripts/psu-launcher.d.mts';
    let statusReads = 0;
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') {
        statusReads += 1;
        return {
          code: 0,
          stdout: statusReads === 1 ? ` M ${source}\0` : ` M ${source}\0 M ${artifact}\0`,
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout: `scripts/gen-declarations.ts\ntsconfig.declarations.json\npackage.json\npackage-lock.json\n${source}\n${artifact}\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: 'emitted 1 declaration', stderr: '' }));
    const logs: string[] = [];

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      runGenerator,
    );

    expect(runGenerator).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'regenerated', atomicPaths: [source, artifact] });
    expect(logs.join('\n')).toMatch(/regenerated tracked declarations before commit/);
  });

  it('retries a transient status-read failure before running declaration repair', async () => {
    const source = 'apps/operator/scripts/psu-launcher.mjs';
    const artifact = 'apps/operator/scripts/psu-launcher.d.mts';
    let statusReads = 0;
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') {
        statusReads += 1;
        if (statusReads === 1) return { code: 128, stdout: '', stderr: 'temporary admission failure' };
        return { code: 0, stdout: ` M ${source}\0`, stderr: '' };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout: `scripts/gen-declarations.ts\ntsconfig.declarations.json\n${source}\n${artifact}\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runGenerator = vi.fn(async () => ({ code: 0, stdout: 'emitted declaration', stderr: '' }));

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: () => {} },
      runGenerator,
    );

    expect(statusReads).toBe(3); // initial failed read + successful retry + post-emit census
    expect(runGenerator).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'regenerated', atomicPaths: [source, artifact] });
  });

  it('fails closed when the writer cannot produce a coherent projection', async () => {
    const source = 'apps/operator/scripts/psu-launcher.mjs';
    const artifact = 'apps/operator/scripts/psu-launcher.d.mts';
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') return { code: 0, stdout: ` M ${source}\0`, stderr: '' };
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout: `scripts/gen-declarations.ts\ntsconfig.declarations.json\n${source}\n${artifact}\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const logs: string[] = [];

    const result = await regenerateGeneratedDeclarationsBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      async () => ({ code: 1, stdout: '', stderr: 'declaration emit failed' }),
    );

    expect(result).toEqual({
      status: 'blocked',
      atomicPaths: [source, artifact],
      detail: 'declaration emit failed',
    });
    expect(logs.join('\n')).toMatch(/deferring the superproject commit/);
  });
});

describe('EI-20428405431869483 generated tool-routing pre-commit check', () => {
  it('limits the dirty-path trigger to routing sources, excluding pair tests', () => {
    expect(affectsToolRouting('packages/operator-core/lib/bash-substitution/pairs/dependency-install.ts')).toBe(true);
    expect(affectsToolRouting('packages/operator-core/lib/bash-substitution/pairs/model-drift.test.ts')).toBe(false);
    expect(affectsToolRouting('packages/operator-core/lib/bash-substitution/routing-table.ts')).toBe(true);
    expect(affectsToolRouting('scripts/gen-tool-routing.ts')).toBe(true);
    expect(affectsToolRouting('packages/operator-core/lib/bash-substitution/routing-table.test.ts')).toBe(false);
    expect(affectsToolRouting('README.md')).toBe(false);
  });

  it('runs the bounded check for an affected dirty source when canonical surfaces are tracked', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: ' M packages/operator-core/lib/bash-substitution/pairs/dependency-install.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout:
            'scripts/gen-tool-routing.ts\npackages/operator-core/lib/bash-substitution/routing-table.ts\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const runCheck = vi.fn(async () => ({ code: 0, stdout: 'routing clean', stderr: '' }));
    const logs: string[] = [];

    await checkToolRoutingBeforeCommit({ runGit, repoPath: '/fake', log: (message) => logs.push(message) }, runCheck);

    expect(runCheck).toHaveBeenCalledOnce();
    expect(calls.map((args) => args[0])).toEqual(['status', 'ls-files']);
    expect(logs.join('\n')).toMatch(/generated tool-routing check passed before commit/);
  });

  it('does nothing for irrelevant dirty paths and pair test files', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout:
          ' M README.md\0 M packages/operator-core/lib/bash-substitution/pairs/model-drift.test.ts\0 M packages/operator-core/lib/bash-substitution/routing-table.test.ts\0',
        stderr: '',
      };
    };
    const runCheck = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    await checkToolRoutingBeforeCommit({ runGit, repoPath: '/fake', log: () => {} }, runCheck);

    expect(runCheck).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('status');
  });

  it('keeps a failed check fail-soft so the git-sync commit can continue', async () => {
    const runGit: RunGit = async (args) => {
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: ' M scripts/gen-tool-routing.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'ls-files') {
        return {
          code: 0,
          stdout:
            'scripts/gen-tool-routing.ts\npackages/operator-core/lib/bash-substitution/routing-table.ts\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    const logs: string[] = [];

    await checkToolRoutingBeforeCommit(
      { runGit, repoPath: '/fake', log: (message) => logs.push(message) },
      async () => ({ code: 1, stdout: '', stderr: 'canonical routing part is stale' }),
    );

    expect(logs.join('\n')).toMatch(/generated tool-routing check failed.*continuing with the commit fail-soft/);
  });
});

describe('runGitSync (real git, no submodule)', () => {
  let root: string;
  let originDir: string; // bare origin
  let repo: string; // the "harness" working clone

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-'));
    originDir = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', originDir);
    // seed an initial commit onto origin/main
    const seed = join(root, 'seed');
    git(root, 'clone', originDir, seed);
    configUser(seed);
    writeFileSync(join(seed, 'file.txt'), 'line1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'main');
    // the harness working clone
    repo = join(root, 'repo');
    git(root, 'clone', originDir, repo);
    configUser(repo);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cfg = { pushSubmodules: false } as const;
  // WI-38594: read FULL messages (%B), not subjects — diff-derived subjects demote the
  // sweep message stem ('auto-commit test') and per-agent intent lines to the commit BODY,
  // so marker assertions must scan the whole message to keep their meaning.
  const originLog = () => git(originDir, 'log', '--format=%B', 'main');

  it('commits a dirty tree and pushes it to origin (happy path)', async () => {
    writeFileSync(join(repo, 'new.txt'), 'hello\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    // origin received the auto-commit
    expect(originLog()).toMatch(/auto-commit test/);
    // working tree is clean after sync
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('reports a sidecar admission refusal during merge without treating it as a Git conflict or aborting an unstarted merge', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args, cwd) => {
      calls.push(args);
      if (args.includes('merge') && args.includes('--no-edit')) {
        return {
          code: -1, stdout: '',
          stderr: 'spawner sidecar admission failed: resource_governor_admissions_time_chk',
        };
      }
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
      return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    };
    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((error) => error.message).join('\n'))
        .toContain('sidecar infrastructure refusal before Git dispatch');
      expect(out.errors.map((error) => error.message).join('\n')).not.toContain('merge failed');
    }
    expect(calls.some((args) => args.includes('--abort'))).toBe(false);
  });

  it('bridges a fully represented release main into staging ancestry without changing the staging tree', async () => {
    git(repo, 'checkout', '-b', 'staging');
    writeFileSync(join(repo, 'repair.txt'), 'fixed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'canonical staging repair');
    writeFileSync(join(repo, 'later.txt'), 'later staging work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'later staging work');
    git(repo, 'push', '-u', 'origin', 'staging');
    const stagingBefore = git(repo, 'rev-parse', 'HEAD');
    const stagingTree = git(repo, 'rev-parse', 'HEAD^{tree}');

    const isolated = join(root, 'isolated-repair');
    git(root, 'clone', originDir, isolated);
    configUser(isolated);
    writeFileSync(join(isolated, 'repair.txt'), 'fixed\n');
    git(isolated, 'add', '-A');
    git(isolated, 'commit', '--no-verify', '-m', 'isolated frozen repair');
    const isolatedMain = git(isolated, 'rev-parse', 'HEAD');
    git(isolated, 'push', 'origin', 'main');

    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: { ...cfg, branch: 'staging' },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.merged).toContain('superproject');
    const bridged = git(originDir, 'rev-parse', 'refs/heads/staging');
    expect(bridged).not.toBe(stagingBefore);
    expect(git(originDir, 'rev-parse', `${bridged}^{tree}`)).toBe(stagingTree);
    expect(git(originDir, 'show', '-s', '--format=%P', bridged).split(' ')).toEqual([
      stagingBefore,
      isolatedMain,
    ]);
    expect(git(originDir, 'merge-base', '--is-ancestor', isolatedMain, bridged)).toBe('');
    expect(logs.join('\n')).toMatch(/bridged fully-represented origin\/main into current ancestry/);
  });

  it('WI-40066: bridges release main in commit-only bridged mode without reconciling or pushing origin/staging', async () => {
    git(repo, 'checkout', '-b', 'staging');
    writeFileSync(join(repo, 'repair.txt'), 'fixed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'canonical staging repair');
    writeFileSync(join(repo, 'later.txt'), 'later staging work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'later staging work');
    git(repo, 'push', '-u', 'origin', 'staging');
    const stagingBefore = git(repo, 'rev-parse', 'HEAD');
    const stagingTree = git(repo, 'rev-parse', 'HEAD^{tree}');

    const isolated = join(root, 'isolated-commit-only-repair');
    git(root, 'clone', originDir, isolated);
    configUser(isolated);
    writeFileSync(join(isolated, 'repair.txt'), 'fixed\n');
    git(isolated, 'add', '-A');
    git(isolated, 'commit', '--no-verify', '-m', 'isolated frozen repair');
    const isolatedMain = git(isolated, 'rev-parse', 'HEAD');
    git(isolated, 'push', 'origin', 'main');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: {
        ...cfg,
        branch: 'staging',
        push: false,
        reconcileSuperprojectOrigin: false,
        bridgeContainedReleaseMainOnCommitOnly: true,
      },
    });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') {
      expect(out.pushed).toEqual([]);
      expect(out.merged).toEqual(['superproject']);
    }
    const bridged = git(repo, 'rev-parse', 'HEAD');
    expect(bridged).not.toBe(stagingBefore);
    expect(git(repo, 'rev-parse', 'HEAD^{tree}')).toBe(stagingTree);
    expect(git(repo, 'show', '-s', '--format=%P', bridged).split(' ')).toEqual([
      stagingBefore,
      isolatedMain,
    ]);
    expect(git(repo, 'merge-base', '--is-ancestor', isolatedMain, bridged)).toBe('');
    expect(git(originDir, 'rev-parse', 'refs/heads/staging')).toBe(stagingBefore);
  });

  it('declines the release-main ancestry bridge when a main-only blob is not identical on staging', async () => {
    git(repo, 'checkout', '-b', 'staging');
    writeFileSync(join(repo, 'repair.txt'), 'staging version\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'different staging change');
    git(repo, 'push', '-u', 'origin', 'staging');
    const stagingBefore = git(repo, 'rev-parse', 'HEAD');

    const isolated = join(root, 'isolated-mismatch');
    git(root, 'clone', originDir, isolated);
    configUser(isolated);
    writeFileSync(join(isolated, 'repair.txt'), 'main version\n');
    git(isolated, 'add', '-A');
    git(isolated, 'commit', '--no-verify', '-m', 'unrepresented main repair');
    const isolatedMain = git(isolated, 'rev-parse', 'HEAD');
    git(isolated, 'push', 'origin', 'main');

    const logs: string[] = [];
    await runGitSync('test', {
      repoPath: repo,
      config: { ...cfg, branch: 'staging' },
      log: (message) => logs.push(message),
    });

    expect(git(originDir, 'rev-parse', 'refs/heads/staging')).toBe(stagingBefore);
    expect(() => git(originDir, 'merge-base', '--is-ancestor', isolatedMain, stagingBefore)).toThrow();
    expect(logs.join('\n')).toMatch(/release-main ancestry bridge declined/);
    expect(logs.join('\n')).toMatch(/repair\.txt.*not represented exactly on HEAD/);
  });

  it('EI-20744916065879285: excludes a protected tracked path while committing the rest of the tree', async () => {
    // Model a live peer edit: the protected file already exists in the index, while a
    // separate file is ordinary shared-tree work that this tick should still publish.
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['file.txt'],
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('deliberately-protected mutation\n');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toMatch(/file\.txt/);
  });

  it('EI-22494259338317391: removes a pre-staged protected path from the commit index without touching its working tree', async () => {
    // `git checkout <sha> -- <path>` stages the selected blob as well as writing it.
    // Reproduce the lock incident with a repair-head blob staged before git-sync
    // receives the protected path.
    git(repo, 'checkout', '-q', '-b', 'repair-source');
    writeFileSync(join(repo, 'file.txt'), 'repair-head blob\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'repair-head');
    const repairHead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', repairHead, '--', 'file.txt');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');

    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('file.txt');

    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['file.txt'],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('repair-head blob\n');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toBe('M file.txt');
    expect(logs.join('\n')).toContain('removed 1 pre-staged protected path(s) from the commit index');
  });

  it('WI-10001350: refuses an unreserved migration before staging or committing it', async () => {
    const migration = 'libs/db/sql/999-unreserved-migration.sql';
    mkdirSync(join(repo, 'libs/db/sql'), { recursive: true });
    writeFileSync(join(repo, migration), '-- intentionally unreserved\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const checker = vi.fn(async (_dirtyPaths: readonly string[]) => {
      throw new Error('[migration-reservation-guard] 999-unreserved-migration.sql has no reservation row');
    });
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      migrationReservationChecker: checker,
      log: (message) => logs.push(message),
    });

    expect(checker).toHaveBeenCalledOnce();
    expect(checker.mock.calls[0]?.[0]).toEqual([migration]);
    if (out.status !== 'error') throw new Error(`expected error outcome, got ${out.status}`);
    expect(out.errors?.[0]?.message).toContain('migration reservation preflight failed');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(migration);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', migration, 'normal.txt')).toMatch(/normal\.txt/);
    expect(git(repo, 'status', '--porcelain', '--', migration, 'normal.txt')).toMatch(/999-unreserved-migration\.sql/);
    expect(logs.join('\n')).toContain('migration reservation preflight refused');
  });

  it('WI-10001350: rechecks staged migrations and selectively unstages a reservation race', async () => {
    const migration = 'libs/db/sql/999-raced-migration.sql';
    mkdirSync(join(repo, 'libs/db/sql'), { recursive: true });
    writeFileSync(join(repo, migration), '-- reservation removed after preflight\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    let checks = 0;
    const checker = vi.fn(async (_dirtyPaths: readonly string[]) => {
      checks += 1;
      if (checks === 2) {
        throw new Error('[migration-reservation-guard] 999-raced-migration.sql reservation disappeared');
      }
    });
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      migrationReservationChecker: checker,
      log: (message) => logs.push(message),
    });

    expect(checker).toHaveBeenCalledTimes(2);
    expect(checker.mock.calls[0]?.[0]).toEqual([migration]);
    expect(checker.mock.calls[1]?.[0]).toEqual([migration]);
    if (out.status !== 'error') throw new Error(`expected error outcome, got ${out.status}`);
    expect(out.errors?.[0]?.message).toContain('migration reservation check after staging failed');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(migration);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('normal.txt');
    expect(git(repo, 'status', '--porcelain', '--', migration)).toMatch(/999-raced-migration\.sql/);
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toMatch(/normal\.txt/);
    expect(logs.join('\n')).toContain('post-stage migration reservation check refused');
  });

  it('EI-22435583452728403: refreshes live locks at the commit seam before staging', async () => {
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const refreshLiveLockHoldings = vi.fn(async () => [{
      path: 'file.txt',
      owner: 'su-peer',
      intent: 'lock acquired after the initial git-sync census',
    }]);

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      refreshLiveLockHoldings,
    });

    expect(refreshLiveLockHoldings).toHaveBeenCalledOnce();
    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toEqual([{
      scope: 'superproject',
      path: 'file.txt',
      owner: 'su-peer',
      intent: 'lock acquired after the initial git-sync census',
    }]);
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('deliberately-protected mutation\n');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toMatch(/file\.txt/);
  });

  it('EI-24356165312897992: commits released locks while retaining current locks and explicit exclusions', async () => {
    writeFileSync(join(repo, 'file.txt'), 'completed edit\n');
    writeFileSync(join(repo, 'explicit.txt'), 'explicitly excluded\n');
    writeFileSync(join(repo, 'new-lock.txt'), 'still being edited\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const currentLock = { path: 'new-lock.txt', owner: 'su-current', intent: 'editing now' };

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['explicit.txt'],
      liveLockHoldings: ['file.txt', 'explicit.txt'].map((path) => ({
        path, owner: 'su-finished', intent: 'released during the preflight',
      })),
      refreshLiveLockHoldings: async () => {
        // This path became dirty after the initial census. It still needs a
        // staging exclusion even though it cannot appear in skippedPaths yet.
        writeFileSync(join(repo, 'late-lock.txt'), 'new edit during preflight\n');
        return [currentLock, { path: 'late-lock.txt', owner: 'su-late', intent: 'editing now' }];
      },
    });

    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toEqual([{ scope: 'superproject', ...currentLock }]);
    expect(git(originDir, 'show', 'main:file.txt')).toBe('completed edit');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    const committedPaths = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(committedPaths).not.toContain('explicit.txt');
    expect(committedPaths).not.toContain('new-lock.txt');
    expect(committedPaths).not.toContain('late-lock.txt');
    expect(readFileSync(join(repo, 'explicit.txt'), 'utf8')).toBe('explicitly excluded\n');
    expect(readFileSync(join(repo, 'new-lock.txt'), 'utf8')).toBe('still being edited\n');
  });

  it('EI-22435583452728403: fails closed when the commit-time live-lock refresh rejects', async () => {
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const refreshLiveLockHoldings = vi.fn(async () => {
      throw new Error('live lock store unavailable during staging');
    });

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      refreshLiveLockHoldings,
    });

    expect(refreshLiveLockHoldings).toHaveBeenCalledOnce();
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((error) => error.message).join('\n')).toContain(
        'live lock refresh failed (fail-closed): live lock store unavailable during staging',
      );
    }
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('normal.txt');
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toMatch(/normal\.txt/);
  });

  it('EI-21267378554087084: an ignored scratch exclusion does not strand legitimate tracked work', async () => {
    const ignoredPath = '.papercusp/scratch';
    const ignoredArtifact = join(repo, ignoredPath, 'transient-artifact');
    writeFileSync(join(repo, '.gitignore'), `${ignoredPath}/\n`);
    mkdirSync(join(repo, ignoredPath), { recursive: true });
    writeFileSync(ignoredArtifact, 'must remain local and untracked\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: [ignoredPath],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(
      `${ignoredPath}/transient-artifact`,
    );
    expect(readFileSync(ignoredArtifact, 'utf8')).toBe('must remain local and untracked\n');
    expect(logs.join('\n')).toContain('pre-filtering ignored untracked protected path');
  });

  it('EI-24369292425690265: checks protected paths with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const paths = Array.from({ length: 24 }, (_, i) => `protected-${i}`);
    const runGit: RunGit = async (args) => {
      const path = args[2];
      seen.push(path);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (path === 'protected-3') return { code: 0, stdout: `${path}\n`, stderr: '' };
      if (path === 'protected-9') {
        return { code: 128, stdout: '', stderr: `fatal: pathspec '${path}' is beyond a symbolic link` };
      }
      return { code: 1, stdout: '', stderr: '' };
    };

    const result = await classifyProtectedPathExclusions(runGit, repo, paths);

    expect(new Set(seen)).toEqual(new Set(paths));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(result.ignoredUntracked).toEqual(new Set(['protected-3']));
    expect(result.beyondSymlink).toEqual(new Set(['protected-9']));
  });

  it('EI-21635845150755039: a protected symlink descendant does not strand stageable work', async () => {
    const protectedPath = 'src-tauri/target/release/bundle/deb/Papercusp Server_0.0.18_amd64.deb';
    const relocatedTarget = join(root, 'relocated-builds', 'papercusp-desktop-src-tauri-target');
    const relocatedArtifact = join(
      relocatedTarget,
      'release',
      'bundle',
      'deb',
      'Papercusp Server_0.0.18_amd64.deb',
    );
    mkdirSync(join(relocatedTarget, 'release', 'bundle', 'deb'), { recursive: true });
    writeFileSync(relocatedArtifact, 'relocated build artifact — never stage this\n');
    mkdirSync(join(repo, 'src-tauri'), { recursive: true });
    symlinkSync(relocatedTarget, join(repo, 'src-tauri', 'target'));
    writeFileSync(join(repo, '.gitignore'), 'src-tauri/target\n');
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: [protectedPath, 'file.txt'],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(protectedPath);
    expect(readFileSync(relocatedArtifact, 'utf8')).toBe('relocated build artifact — never stage this\n');
    expect(git(repo, 'ls-files', '--', 'src-tauri/target')).toBe('');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toMatch(/file\.txt/);
    expect(logs.join('\n')).toContain('pre-filtering protected path(s) beyond a symbolic link');
    expect(
      isPathspecBeyondSymbolicLinkFailure(
        `fatal: pathspec '${protectedPath}' is beyond a symbolic link`,
      ),
    ).toBe(true);
  });

  it('EI-21371380265465702: git-sync ignores in-progress dependency-generation build markers', async () => {
    // The production integration tree uses the canonical root policy. Copy it
    // into the throwaway clone so this test fails if the policy ever stops
    // excluding a build marker, rather than merely testing a duplicated fixture
    // pattern.
    writeFileSync(join(repo, '.gitignore'), readFileSync(join(REPO_ROOT, '.gitignore')));
    const markerPaths = [
      '.papercusp/dependency-generations/.build-pending-host-123-456/tree/file',
      'packages/mock/.papercusp/dependency-generations/.build-pending-host-123-456/tree/file',
    ];
    for (const markerPath of markerPaths) {
      mkdirSync(join(repo, markerPath, '..'), { recursive: true });
      writeFileSync(join(repo, markerPath), 'in-progress generation\n');
    }
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    for (const markerPath of markerPaths) {
      expect(originFiles).not.toContain(markerPath);
      expect(git(repo, 'check-ignore', '-v', '--no-index', markerPath)).toContain(
        '.papercusp/dependency-generations/',
      );
    }
    expect(git(repo, 'status', '--porcelain', '--', 'normal.txt')).toBe('');
  });

  it('EI-22737671025165479: untracks legacy dependency-generation runtime state without deleting it', async () => {
    const selector = '.papercusp/dependency-generations/.inputs/legacy-selector';
    const selectorPath = join(repo, selector);
    mkdirSync(join(selectorPath, '..'), { recursive: true });
    writeFileSync(selectorPath, 'schema=1\ncreated=1\n');
    git(repo, 'add', '-f', selector);
    git(repo, 'commit', '--no-verify', '-m', 'legacy tracked runtime state');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, '.papercusp/dependency-generations/.gitignore'), '*\n');
    writeFileSync(selectorPath, 'schema=1\ncreated=2\n');
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(selector);
    expect(readFileSync(selectorPath, 'utf8')).toBe('schema=1\ncreated=2\n');
    expect(git(repo, 'check-ignore', '-v', '--no-index', selector)).toContain(
      '.papercusp/dependency-generations/.gitignore',
    );
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(logs.join('\n')).toContain(
      'legacy tracked dependency-generation runtime path(s) from the index',
    );
  });

  it('WI-40770: a live-held dirty path stays excluded while the unlocked remainder syncs', async () => {
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');
    writeFileSync(join(repo, 'normal.txt'), 'ordinary work\n');

    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      excludePaths: ['file.txt'],
      liveLockHoldings: [{
        path: 'file.txt',
        owner: 'su-peer',
        intent: 'editing the source half of an atomic change',
      }],
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toEqual([{
      scope: 'superproject',
      path: 'file.txt',
      owner: 'su-peer',
      intent: 'editing the source half of an atomic change',
    }]);
    expect(logs.join('\n')).toContain('committing the unlocked remainder');

    // The protected edit remains local, while unrelated finished work reaches origin.
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(originDir, 'show', 'main:normal.txt')).toBe('ordinary work');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt', 'normal.txt')).toMatch(/file\.txt/);
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt', 'normal.txt')).not.toMatch(/normal\.txt/);
  });

  it('WI-1834529: a staggered lock defers the whole attributed source/test cohort', async () => {
    const sourcePath = 'source.ts';
    const testPath = 'source.test.ts';
    const normalPath = 'normal.txt';
    writeFileSync(join(repo, sourcePath), 'export const value = 1;\n');
    writeFileSync(join(repo, testPath), "import { value } from './source';\nexport const observed = value;\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed atomic edit cohort');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, sourcePath), 'export const value = 2;\n');
    writeFileSync(join(repo, testPath), "import { value } from './source';\nexport const observed = value + 1;\n");
    writeFileSync(join(repo, normalPath), 'unrelated work\n');

    const workItem = 'WI-1834529';
    const roster = [{
      agent: 'su-peer',
      intent: 'finish the source and test together',
      files: [sourcePath, testPath],
      workItems: [workItem],
    }];
    const logs: string[] = [];
    const first = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      excludePaths: [sourcePath],
      liveLockHoldings: [{
        path: sourcePath,
        owner: 'su-peer',
        intent: 'editing source',
        goalRef: workItem,
      }],
      loadRoster: async () => roster,
      log: (message) => logs.push(message),
    });

    expect(first.status).toBe('synced');
    expect(git(originDir, 'show', `main:${sourcePath}`)).toBe('export const value = 1;');
    expect(git(originDir, 'show', `main:${testPath}`)).toContain('observed = value;');
    expect(git(originDir, 'show', `main:${normalPath}`)).toBe('unrelated work');
    expect(git(repo, 'status', '--porcelain', '--', sourcePath, testPath)).toMatch(/source(?:\.test)?\.ts/);
    expect(logs.join('\n')).toContain('keeping 1 live edit cohort(s) atomic');

    // Once the staggered source lock is gone, both dirty files can publish together;
    // the first pass must not have left a source/test split in the remote tree.
    const second = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      loadRoster: async () => roster,
    });

    expect(second.status).toBe('synced');
    expect(git(originDir, 'show', `main:${sourcePath}`)).toBe('export const value = 2;');
    expect(git(originDir, 'show', `main:${testPath}`)).toContain('observed = value + 1;');
    expect(git(repo, 'status', '--porcelain', '--', sourcePath, testPath)).toBe('');
    expect(git(originDir, 'log', '--format=%B', 'main')).toContain(`Papercusp-Work-Item: ${workItem}`);
  });

  it('EI-22485648475962061: a locked untracked dependency holds back its dirty importer while unrelated work syncs', async () => {
    const dependencyPath = 'new-dep.ts';
    const importerPath = 'importer.ts';
    const controlPath = 'control.ts';

    // Seed the importer so the first pass exercises a dirty tracked importer,
    // matching the production failure rather than only an all-new pair.
    writeFileSync(join(repo, importerPath), 'export const value = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed importer');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, dependencyPath), 'export const dep = 42;\n');
    writeFileSync(join(repo, importerPath), "import { dep } from './new-dep';\nexport const value = dep;\n");
    writeFileSync(join(repo, controlPath), 'export const control = true;\n');

    const logs: string[] = [];
    const first = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      liveLockHoldings: [{
        path: dependencyPath,
        owner: 'su-peer',
        intent: 'PreToolUse:Write',
      }],
      log: (message) => logs.push(message),
    });

    expect(first.status).toBe('synced');
    expect(git(originDir, 'show', `main:${importerPath}`)).toBe('export const value = 1;');
    expect(git(originDir, 'show', `main:${controlPath}`)).toBe('export const control = true;');
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain(dependencyPath);
    expect(first.contentErrors).toEqual([
      expect.objectContaining({
        file: importerPath,
        detectorKey: 'quarantined-importer',
        error: expect.stringContaining('live-lock exclusion'),
      }),
    ]);
    expect(git(repo, 'status', '--porcelain', '--', dependencyPath, importerPath)).toMatch(
      /(?:new-dep|importer)\.ts/,
    );
    expect(git(repo, 'status', '--porcelain', '--', controlPath)).toBe('');

    // Once the lock is gone, the dependency and importer publish together and
    // the previous pass has not left a broken remote tree behind.
    const second = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
    });

    expect(second.status).toBe('synced');
    expect(git(originDir, 'show', `main:${dependencyPath}`)).toBe('export const dep = 42;');
    expect(git(originDir, 'show', `main:${importerPath}`)).toContain('export const value = dep;');
    expect(git(repo, 'status', '--porcelain', '--', dependencyPath, importerPath)).toBe('');
  });

  it('EI-24269368801794879: a locked tracked exporter holds back a dirty importer of its new symbol', async () => {
    const exporterPath = 'exporter.ts';
    const importerPath = 'importer.ts';
    const controlPath = 'control.ts';
    writeFileSync(join(repo, exporterPath), 'export const oldValue = 1;\n');
    writeFileSync(join(repo, importerPath), "import { oldValue } from './exporter';\nexport const value = oldValue;\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed exporter and importer');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(join(repo, exporterPath), 'export const oldValue = 1;\nexport const newValue = 2;\n');
    writeFileSync(join(repo, importerPath), "import { newValue } from './exporter';\nexport const value = newValue;\n");
    writeFileSync(join(repo, controlPath), 'export const control = true;\n');

    const first = await runGitSync('test', {
      repoPath: repo,
      runGit: directRunGit,
      config: cfg,
      liveLockHoldings: [{ path: exporterPath, owner: 'su-peer', intent: 'editing exporter' }],
    });

    expect(first.status).toBe('synced');
    expect(first.contentErrors).toContainEqual(expect.objectContaining({
      file: importerPath,
      detectorKey: 'quarantined-importer',
      error: expect.stringContaining('live-lock exclusion'),
    }));
    expect(git(originDir, 'show', `main:${exporterPath}`)).not.toContain('newValue');
    expect(git(originDir, 'show', `main:${importerPath}`)).not.toContain('newValue');
    expect(git(originDir, 'show', `main:${controlPath}`)).toBe('export const control = true;');

    const second = await runGitSync('test', { repoPath: repo, runGit: directRunGit, config: cfg });
    expect(second.status).toBe('synced');
    expect(git(originDir, 'show', `main:${exporterPath}`)).toContain('newValue');
    expect(git(originDir, 'show', `main:${importerPath}`)).toContain('newValue');
    expect(git(repo, 'status', '--porcelain', '--', exporterPath, importerPath)).toBe('');
  });

  it('WI-40770: a repo with only live-held dirty paths still reports skipped-locked', async () => {
    writeFileSync(join(repo, 'file.txt'), 'deliberately-protected mutation\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      // Holder provenance alone is sufficient to protect the path; callers cannot
      // accidentally omit the parallel exclusion projection and commit through a lock.
      liveLockHoldings: [{
        path: 'file.txt',
        owner: 'su-peer',
        intent: 'editing the source half of an atomic change',
      }],
    });

    expect(out.status).toBe('skipped-locked');
    expect(out.skippedPaths).toEqual([{
      scope: 'superproject',
      path: 'file.txt',
      owner: 'su-peer',
      intent: 'editing the source half of an atomic change',
    }]);
    expect(git(originDir, 'show', 'main:file.txt')).toBe('line1');
    expect(git(repo, 'status', '--porcelain', '--', 'file.txt')).toMatch(/file\.txt/);
  });

  it('EI-21444216858331991: regenerates and commits an attributed source with its declaration atomically', async () => {
    const generator = join(repo, 'scripts', 'gen-declarations.ts');
    const config = join(repo, 'tsconfig.declarations.json');
    const sourceRel = 'apps/operator/scripts/psu-launcher.mjs';
    const artifactRel = 'apps/operator/scripts/psu-launcher.d.mts';
    const source = join(repo, sourceRel);
    const artifact = join(repo, artifactRel);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'apps', 'operator', 'scripts'), { recursive: true });
    writeFileSync(generator, '// declaration generator fixture\n');
    writeFileSync(config, '{"files":["apps/operator/scripts/psu-launcher.mjs"]}\n');
    writeFileSync(join(repo, 'package.json'), '{"private":true}\n');
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFileSync(source, 'export const version = 1;\n');
    writeFileSync(artifact, 'export declare const version = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed declaration fixture');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(source, 'export const version = 2;\n');
    const runGenerator = vi.fn(async (repoPath: string) => {
      expect(readFileSync(join(repoPath, sourceRel), 'utf8')).toContain('version = 2');
      writeFileSync(join(repoPath, artifactRel), 'export declare const version = 2;\n');
      return { code: 0, stdout: 'emitted declaration', stderr: '' };
    });
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      generatedDeclarationsRegenerator: (context) => regenerateGeneratedDeclarationsBeforeCommit(context, runGenerator),
      loadRoster: async () => [
        {
          agent: 'cup-declarations',
          agentLabel: 'Declaration Author',
          intent: 'change the launcher source',
          files: [sourceRel],
        },
      ],
    });

    expect(out.status).toBe('synced');
    expect(runGenerator).toHaveBeenCalledOnce();
    expect(git(originDir, 'show', `main:${sourceRel}`)).toContain('version = 2');
    expect(git(originDir, 'show', `main:${artifactRel}`)).toContain('version = 2');
    const sourceCommit = git(originDir, 'log', '-1', '--format=%H', 'main', '--', sourceRel);
    const artifactCommit = git(originDir, 'log', '-1', '--format=%H', 'main', '--', artifactRel);
    expect(sourceCommit).toBe(artifactCommit);
    expect(originLog()).not.toMatch(/change the launcher source/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('EI-21444216858331991: a failed declaration emit leaves the source uncommitted', async () => {
    const generator = join(repo, 'scripts', 'gen-declarations.ts');
    const config = join(repo, 'tsconfig.declarations.json');
    const sourceRel = 'apps/operator/scripts/psu-launcher.mjs';
    const artifactRel = 'apps/operator/scripts/psu-launcher.d.mts';
    const source = join(repo, sourceRel);
    const artifact = join(repo, artifactRel);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'apps', 'operator', 'scripts'), { recursive: true });
    writeFileSync(generator, '// declaration generator fixture\n');
    writeFileSync(config, '{"files":["apps/operator/scripts/psu-launcher.mjs"]}\n');
    writeFileSync(source, 'export const version = 1;\n');
    writeFileSync(artifact, 'export declare const version = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed declaration fixture');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(source, 'export const version = 2;\n');
    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
      generatedDeclarationsRegenerator: (context) =>
        regenerateGeneratedDeclarationsBeforeCommit(context, async () => ({
          code: 1,
          stdout: '',
          stderr: 'fixture emit failed',
        })),
    });

    expect(out.status).toBe('error');
    expect(git(originDir, 'show', `main:${sourceRel}`)).toContain('version = 1');
    expect(git(originDir, 'show', `main:${artifactRel}`)).toContain('version = 1');
    expect(git(repo, 'status', '--porcelain', '--', sourceRel)).toMatch(/psu-launcher\.mjs/);
    expect(logs.join('\n')).toMatch(/deferring the superproject commit/);
  });

  it('WI-39922: a generator failure remains fail-soft and the tool source still commits', async () => {
    const generator = join(repo, 'scripts', 'gen-tool-catalog.ts');
    const catalog = join(repo, '.papercusp', 'tool-catalog.json');
    const tool = join(repo, 'packages', 'operator-core', 'lib', 'agent-tools', 'example.ts');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, '.papercusp'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'operator-core', 'lib', 'agent-tools'), { recursive: true });
    writeFileSync(generator, '// generator fixture\n');
    writeFileSync(catalog, '{"count":0}\n');
    writeFileSync(tool, 'export const version = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed catalog fixture');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(tool, 'export const version = 2;\n');
    const logs: string[] = [];
    const runGenerator = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'registry import failed on a half-written peer module',
    }));
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
      toolCatalogRegenerator: (context) => regenerateToolCatalogBeforeCommit(context, runGenerator),
    });

    expect(runGenerator).toHaveBeenCalledOnce();
    expect(out.status).toBe('synced');
    expect(logs.join('\n')).toMatch(/tool-catalog regeneration failed.*continuing with the commit fail-soft/);
    expect(git(originDir, 'show', 'main:packages/operator-core/lib/agent-tools/example.ts')).toContain('version = 2');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('EI-20428405431869483: a failed routing check remains fail-soft and the affected pair still commits', async () => {
    const generator = join(repo, 'scripts', 'gen-tool-routing.ts');
    const routingTable = join(repo, 'packages', 'operator-core', 'lib', 'bash-substitution', 'routing-table.ts');
    const pair = join(repo, 'packages', 'operator-core', 'lib', 'bash-substitution', 'pairs', 'dependency-install.ts');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'operator-core', 'lib', 'bash-substitution', 'pairs'), { recursive: true });
    writeFileSync(generator, '// routing generator fixture\n');
    writeFileSync(routingTable, '// routing table fixture\n');
    writeFileSync(pair, 'export const version = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--no-verify', '-m', 'seed routing fixture');
    git(repo, 'push', 'origin', 'main');

    writeFileSync(pair, 'export const version = 2;\n');
    const logs: string[] = [];
    const runCheck = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'canonical routing part is stale',
    }));
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
      toolRoutingChecker: (context) => checkToolRoutingBeforeCommit(context, runCheck),
    });

    expect(runCheck).toHaveBeenCalledOnce();
    expect(out.status).toBe('synced');
    expect(logs.join('\n')).toMatch(/generated tool-routing check failed.*continuing with the commit fail-soft/);
    expect(git(originDir, 'show', 'main:packages/operator-core/lib/bash-substitution/pairs/dependency-install.ts')).toContain('version = 2');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it.each([false, true])('F6/EI-20349517520985072: HTTPS fallback reauthorizes its push (revoked=%s)', async (revoked) => {
    writeFileSync(join(repo, 'https-fallback.txt'), 'credential-plane fallback\n');
    const rewrite = 'url.https://github.com/.insteadOf=git@github.com:';
    const calls: string[][] = [];
    const failedOnce = new Set<string>();
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      const command = args[0];
      if ((command === 'fetch' || command === 'push') && !failedOnce.has(command)) {
        failedOnce.add(command);
        return { code: 128, stdout: '', stderr: 'git@github.com: Permission denied (publickey).\n' };
      }
      return realRunGit(args, cwd);
    };

    const beforePush = vi.fn(async (args: readonly string[]) => {
      if (revoked && args[0] === '-c') throw new Error('owner key no longer available');
    });
    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg, beforePush });

    expect(beforePush.mock.calls.map(([args]) => args)).toEqual([
      ['push', 'origin', 'HEAD:main'],
      ['-c', rewrite, 'push', 'origin', 'HEAD:main'],
    ]);
    expect(failedOnce).toEqual(new Set(['fetch', 'push']));
    expect(calls.filter((args) => args[0] === '-c' && args[1] === rewrite)).toEqual([
      ['-c', rewrite, 'fetch', 'origin', 'main'],
      ...(!revoked ? [['-c', rewrite, 'push', 'origin', 'HEAD:main']] : []),
    ]);
    if (revoked) {
      expect(out.status).toBe('error');
      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('https-fallback.txt');
      expect(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('https-fallback.txt');
    } else {
      expect(out.status).toBe('synced');
      if (out.status === 'synced') expect(out.pushed).toContain('superproject');
      expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('https-fallback.txt');
    }
  });

  it('WI-2144358: retries an unresolved GitHub SSH account alias through configured HTTPS credentials', async () => {
    writeFileSync(join(repo, 'ssh-alias-fallback.txt'), 'account-alias transport fallback\n');
    const aliasUrl = 'git@github.com-git-graph:papercupai/git-graph.git';
    const rewrite = 'url.https://github.com/.insteadOf=git@github.com-git-graph:';
    const calls: string[][] = [];
    const failedOnce = new Set<string>();
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      const command = args[0];
      if (command === 'remote' && args[1] === 'get-url') {
        return { code: 0, stdout: `${aliasUrl}\n`, stderr: '' };
      }
      if ((command === 'fetch' || command === 'push') && !failedOnce.has(command)) {
        failedOnce.add(command);
        return {
          code: 128,
          stdout: '',
          stderr: 'ssh: Could not resolve hostname github.com-git-graph: Name or service not known\n',
        };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    expect(failedOnce).toEqual(new Set(['fetch', 'push']));
    expect(calls.filter((args) => args[0] === '-c' && args[1] === rewrite)).toEqual([
      ['-c', rewrite, 'fetch', 'origin', 'main'],
      ['-c', rewrite, 'push', 'origin', 'HEAD:main'],
    ]);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('ssh-alias-fallback.txt');
  });

  it('EI-20378687739683215: retries a GitHub SSH email-verification rejection through HTTPS', async () => {
    writeFileSync(join(repo, 'email-verification-fallback.txt'), 'verified automation account\n');
    const rewrite = 'url.https://github.com/.insteadOf=git@github.com:';
    const calls: string[][] = [];
    let rejectedPush = false;
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { code: 0, stdout: 'git@github.com:Papercusp/papercup.git\n', stderr: '' };
      }
      if (args[0] === 'push' && !rejectedPush) {
        rejectedPush = true;
        return { code: 1, stdout: '', stderr: 'remote: You must verify your email address.\n' };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    expect(calls).toContainEqual(['remote', 'get-url', 'origin']);
    expect(calls.filter((args) => args[0] === '-c' && args[1] === rewrite)).toEqual([
      ['-c', rewrite, 'push', 'origin', 'HEAD:main'],
    ]);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain(
      'email-verification-fallback.txt',
    );
  });

  it('EI-20378687739683215: does not rewrite a non-GitHub email-verification rejection', async () => {
    writeFileSync(join(repo, 'no-email-fallback.txt'), 'retain the original error\n');
    const calls: string[][] = [];
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      if (args[0] === 'push') {
        return { code: 1, stdout: '', stderr: 'remote: You must verify your email address.\n' };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    expect(out.status).toBe('error');
    expect(calls).toContainEqual(['remote', 'get-url', 'origin']);
    expect(calls.some((args) => args.some((arg) => arg.includes('insteadOf=')))).toBe(false);
  });

  it('EI-20349517520985072: does not rewrite unrelated SSH publickey failures', async () => {
    writeFileSync(join(repo, 'no-fallback.txt'), 'keep the original failure\n');
    const calls: string[][] = [];
    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      calls.push([...args]);
      if (args[0] === 'fetch') {
        return { code: 128, stdout: '', stderr: 'git@gitlab.com: Permission denied (publickey).\n' };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    expect(out.status).toBe('error');
    expect(calls.filter((args) => args.includes('fetch'))).toHaveLength(1);
    expect(calls.some((args) => args.some((arg) => arg.includes('insteadOf=')))).toBe(false);
  });

  it('STRANDING GUARD (2026-06-30 root cause): a nested embedded git repo with NO commit does NOT strand the tree — excludes it + retries + commits the real work', async () => {
    // The file that MUST reach origin.
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    // A stray embedded git repo with NO commit — exactly what a green-checkpoint test tmpdir
    // left under .papercusp/.vitest-tmpdir. A naive `git add -A` FATALs on it (exit 128,
    // "does not have a commit checked out") → stages NOTHING → the whole tree strands.
    const stray = join(repo, '.papercusp', '.vitest-tmpdir', 'green-STRAY');
    mkdirSync(stray, { recursive: true });
    git(stray, 'init', '-b', 'main'); // nested .git, NO commit

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    // Before the fix: status 'nothing', real-work.txt stranded forever. After: it recovers.
    expect(out.status).toBe('synced');
    expect(originLog()).toMatch(/auto-commit test/);
    // the real file reached origin (was NOT stranded)
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('real-work.txt');
  });

  it('STALE-LOCK SELF-HEAL (2026-07-04 incident): an ORPHANED .git/index.lock (dead writer, old mtime) is cleared + the tick still syncs', async () => {
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    // Exactly what a git process killed mid-`add -A` leaves behind: a lock file
    // nobody holds. Backdate it past STALE_INDEX_LOCK_MS so it is provably stale.
    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(lockPath, 'partial index the dead writer was building');
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    // Before the fix: EVERY tick failed "Unable to create '….index.lock': File exists"
    // until a human deleted the file. After: self-heals + commits this tick.
    expect(out.status).toBe('synced');
    expect(existsSync(lockPath)).toBe(false);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('real-work.txt');
  });

  it('STALE-LOCK SELF-HEAL: a FRESH index.lock (live writer) is NOT touched — the tick fails instead of robbing the holder', async () => {
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(lockPath, 'a live git process is writing this'); // mtime = now

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).not.toBe('synced'); // the failure still surfaces (watchdog sees it)
    expect(existsSync(lockPath)).toBe(true); // the live writer keeps its lock
  });

  it('WI-10003529: a CLEAN repo behind origin reclaims an orphaned index.lock at the MERGE (its first index writer) instead of failing "merge failed (no conflicted paths)" every tick', async () => {
    // Upstream advances while the working clone has nothing to commit, so no
    // `git add`/`git commit` ever runs — the merge is the first operation that
    // needs the index lock (the P-203 Mac VM's libs/papercusp-db, 2026-09-27).
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'upstream.txt'), 'from a peer\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'upstream advance');
    git(seed, 'push', 'origin', 'main');
    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(lockPath, ''); // what a git killed by a restart leaves: empty, unheld
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);

    const metLock: string[] = [];
    const runGit: RunGit = async (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      const res = { code: r.status ?? -1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
      if (res.code !== 0 && isIndexLockFailure(`${res.stdout}\n${res.stderr}`)) metLock.push(args.join(' '));
      return res;
    };

    const out = await runGitSync('test', { repoPath: repo, runGit, config: cfg });

    // Pin the scenario: the MERGE met the orphan (not an add/commit path, which
    // has had recovery since 2026-07-04) — otherwise this test guards nothing new.
    expect(metLock.length).toBeGreaterThan(0);
    expect(metLock[0]).toMatch(/\bmerge\b/);
    // Before the fix: status 'error' ("merge failed (no conflicted paths)") on every
    // tick until a human deleted the lock. After: reclaimed once, merge proceeds.
    expect(out.status).not.toBe('error');
    expect(existsSync(lockPath)).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(originDir, 'rev-parse', 'main'));
  });

  it('EI-21872458801896676: repairs a truncated canonical index before the dirty census and still commits the working tree', async () => {
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    const indexPath = join(repo, '.git', 'index');
    writeFileSync(indexPath, Buffer.alloc(0));
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(readFileSync(indexPath).length).toBeGreaterThanOrEqual(MIN_VALID_GIT_INDEX_BYTES);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('real-work.txt');
    expect(logs.join('\n')).toMatch(/repaired invalid Git index.*read-tree HEAD/i);
  });

  it('refuses invalid-index repair while a real process holds its descriptor open', async () => {
    const indexPath = join(repo, '.git', 'index');
    writeFileSync(indexPath, Buffer.alloc(0));
    const fd = openSync(indexPath, 'r');
    try {
      const result = await preflightInvalidIndex(directRunGit, repo, () => {});
      expect(result).toMatchObject({ status: 'refused', indexPath });
      if (result.status === 'refused') expect(result.reason).toContain('open by a live writer');
      expect(readFileSync(indexPath).length).toBe(0);
    } finally {
      closeSync(fd);
    }
  });

  it.each([
    ['live writer', true],
    ['unknown writer state', null],
  ] as const)(
    'EI-21872458801896676: refuses a truncated index when the %s cannot be ruled out',
    async (_label, open) => {
      const indexPath = join(repo, '.git', 'index');
      writeFileSync(indexPath, Buffer.alloc(0));
      const calls: string[][] = [];
      const logs: string[] = [];
      const runGit: RunGit = async (args) => {
        calls.push([...args]);
        if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
          return { code: 0, stdout: `${join(repo, '.git')}\n`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      };

      const result = await preflightInvalidIndex(runGit, repo, (message) => logs.push(message), {
        isOpen: async () => open,
      });

      expect(result.status).toBe('refused');
      expect(calls.some((args) => args[0] === 'read-tree')).toBe(false);
      expect(readFileSync(indexPath).length).toBe(0);
      expect(logs.join('\n')).toMatch(/refusing invalid Git index preflight/i);
    },
  );

  it('EI-21872458801896676: refuses a truncated index when index.lock appears during the re-stat window', async () => {
    const indexPath = join(repo, '.git', 'index');
    const lockPath = join(repo, '.git', 'index.lock');
    writeFileSync(indexPath, Buffer.alloc(0));
    let indexReads = 0;
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        return { code: 0, stdout: `${join(repo, '.git')}\n`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await preflightInvalidIndex(runGit, repo, () => {}, {
      isOpen: async () => false,
      inspectFile: async (path) => {
        if (path === indexPath) {
          indexReads++;
          return { size: 0, mtimeMs: 1, dev: 1, ino: 1, isFile: true };
        }
        if (path === lockPath && indexReads >= 2) {
          return { size: 0, mtimeMs: 1, dev: 1, ino: 2, isFile: true };
        }
        return null;
      },
    });

    expect(result.status).toBe('refused');
    expect(calls.some((args) => args[0] === 'read-tree')).toBe(false);
  });

  it('EI-20345390379109755: an orphaned config.lock is cleared before canonical submodule URL sync retries', async () => {
    writeFileSync(join(repo, 'real-work.txt'), 'agents work here\n');
    const lockPath = join(repo, '.git', 'config.lock');
    writeFileSync(lockPath, '');
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);

    let urlSyncAttempts = 0;
    const runGit: RunGit = async (args, cwd) => {
      if (args.join(' ') === 'submodule sync --recursive' && urlSyncAttempts++ === 0) {
        return {
          code: 1,
          stdout: '',
          stderr: `error: could not lock config file ${join(repo, '.git', 'config')}: File exists`,
        };
      }
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

    const out = await runGitSync('test', {
      repoPath: repo,
      runGit,
      submodulePaths: [],
      config: { ...cfg, pushSubmodules: true, pushSubmoduleOrigins: false },
    });

    expect(out.status).toBe('synced');
    expect(urlSyncAttempts).toBe(2);
    expect(existsSync(lockPath)).toBe(false);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('real-work.txt');
  }, 30_000);

  it('isIndexLockFailure matches the git fatal (and only it)', () => {
    expect(
      isIndexLockFailure(
        "fatal: Unable to create '/x/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running",
      ),
    ).toBe(true);
    expect(isIndexLockFailure("error: 'x/' does not have a commit checked out")).toBe(false);
    expect(isIndexLockFailure('')).toBe(false);
  });

  it('isConfigLockFailure matches the git fatal (and only it)', () => {
    expect(isConfigLockFailure('error: could not lock config file /x/repo/.git/config: File exists')).toBe(true);
    expect(isConfigLockFailure("fatal: Unable to create '/x/repo/.git/index.lock': File exists")).toBe(false);
    expect(isConfigLockFailure('')).toBe(false);
  });

  it('clearStaleIndexLock unit edges: already-gone lock ⇒ retry ok; unlink failure ⇒ no retry', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const logs: string[] = [];
    // lock vanished between the failure and the heal (holder finished) — retry is safe
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        statMtimeMs: async () => null,
        hasLiveHolder: async () => false,
      }),
    ).toBe(true);
    // stale but unlink throws (permissions) — do NOT claim healed
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        statMtimeMs: async () => Date.now() - 10 * 60_000,
        hasLiveHolder: async () => false,
        unlinkFile: async () => {
          throw new Error('EACCES');
        },
      }),
    ).toBe(false);
  });

  it('clearStaleIndexLock LIVE-HOLDER guard (EI-22703121889295786): an mtime-stale index.lock still held open by a live process is NEVER unlinked', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const logs: string[] = [];
    const unlinked: string[] = [];
    // mtime says stale (staleMs:0 makes ANY age stale), but a live writer holds the fd —
    // this is the exact shape that truncated the canonical index to 0 bytes.
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        statMtimeMs: async () => Date.now() - 10 * 60_000,
        staleMs: 0,
        hasLiveHolder: async () => true,
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    ).toBe(false);
    expect(unlinked).toEqual([]);
    expect(logs.some((m) => m.includes('FRESH-BY-HOLDER'))).toBe(true);
    // same lock, same age, but no live holder ⇒ the stale-orphan path unlinks as before
    expect(
      await clearStaleIndexLock(fakeRunGit, '/fake', (m) => logs.push(m), {
        statMtimeMs: async () => Date.now() - 10 * 60_000,
        staleMs: 0,
        hasLiveHolder: async () => false,
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    ).toBe(true);
    expect(unlinked).toEqual(['/fake/.git/index.lock']);
  });

  it('clearStaleConfigLock removes only an old empty holderless lock', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const unlinked: string[] = [];
    // One STABLE snapshot, like the it.each cases below: clearStaleConfigLock
    // inspects twice and bails if the two disagree. Recomputing Date.now()
    // inside the mock made `after` differ from `before` by the elapsed
    // millisecond, so this read as a replaced lock and returned false — a flake
    // that only showed up under lane load, where the two calls straddle a tick.
    const snapshot = { mtimeMs: Date.now() - 10 * 60_000, size: 0, dev: 1, ino: 2 };
    expect(
      await clearStaleConfigLock(fakeRunGit, '/fake', () => {}, {
        inspectLock: async (p) => (p.endsWith('/config.lock') ? snapshot : null),
        isOpen: async () => false,
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    ).toBe(true);
    expect(unlinked).toEqual(['/fake/.git/config.lock']);
  });

  it.each([
    {
      name: 'nonempty',
      snapshot: { mtimeMs: Date.now() - 10 * 60_000, size: 12, dev: 1, ino: 2 },
      open: false,
    },
    {
      name: 'held open',
      snapshot: { mtimeMs: Date.now() - 10 * 60_000, size: 0, dev: 1, ino: 2 },
      open: true,
    },
    {
      name: 'holder state unknown',
      snapshot: { mtimeMs: Date.now() - 10 * 60_000, size: 0, dev: 1, ino: 2 },
      open: null,
    },
  ])('clearStaleConfigLock leaves an old $name lock untouched', async ({ snapshot, open }) => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const unlinkFile = vi.fn(async () => {});

    expect(
      await clearStaleConfigLock(fakeRunGit, '/fake', () => {}, {
        inspectLock: async () => snapshot,
        isOpen: async () => open,
        unlinkFile,
      }),
    ).toBe(false);
    expect(unlinkFile).not.toHaveBeenCalled();
  });

  it('clearStaleConfigLock leaves a replaced lock untouched after holder inspection', async () => {
    const fakeRunGit: RunGit = async () => ({ code: 0, stdout: '/fake/.git\n', stderr: '' });
    const unlinkFile = vi.fn(async () => {});
    let inspection = 0;

    expect(
      await clearStaleConfigLock(fakeRunGit, '/fake', () => {}, {
        inspectLock: async () => ({
          mtimeMs: Date.now() - 10 * 60_000,
          size: 0,
          dev: 1,
          ino: ++inspection,
        }),
        isOpen: async () => false,
        unlinkFile,
      }),
    ).toBe(false);
    expect(unlinkFile).not.toHaveBeenCalled();
  });

  it('addFailureStrayPaths parses the embedded-repo fatal path(s) + strips trailing slash', () => {
    const out =
      "error: '.papercusp/.vitest-tmpdir/green-oQOrHU/' does not have a commit checked out\n" +
      "error: 'other/nested/' does not have a commit checked out\nfatal: adding files failed";
    expect(addFailureStrayPaths(out)).toEqual(['.papercusp/.vitest-tmpdir/green-oQOrHU', 'other/nested']);
    expect(addFailureStrayPaths('nothing wrong here')).toEqual([]);
  });

  it('isTransientStatFailure matches the git ENOENT-race fatal (and only it)', () => {
    expect(
      isTransientStatFailure(
        "fatal: unable to stat 'apps/operator/app/_components/chat/curator-card-drill-in.test.ts.tmp.210675.fe78c436a08e': No such file or directory",
      ),
    ).toBe(true);
    // a DIFFERENT fatal must not false-positive into the wrong retry path
    expect(isTransientStatFailure("error: 'x/' does not have a commit checked out")).toBe(false);
    expect(isTransientStatFailure("fatal: Unable to create '/x/repo/.git/index.lock': File exists")).toBe(false);
    expect(isTransientStatFailure('')).toBe(false);
  });

  it('P-004 flag-ON (loadRoster supplied): peels a per-agent commit (intent + Co-Authored-By) before the catch-all', async () => {
    writeFileSync(join(repo, 'mine.txt'), 'a\n'); // attributed to cup-7
    writeFileSync(join(repo, 'other.txt'), 'b\n'); // unattributed → catch-all
    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      loadRoster: async () => [
        { agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'wire the parser', files: ['mine.txt'] },
      ],
    });
    expect(out.status).toBe('synced');
    // origin received BOTH the per-agent commit (intent subject) AND the catch-all auto-commit.
    const subjects = originLog();
    expect(subjects).toMatch(/wire the parser \(Cup Seven\)/);
    expect(subjects).toMatch(/auto-commit test/);
    // the per-agent commit carries a Co-Authored-By trailer crediting the agent (DERIVED attribution).
    const bodies = git(originDir, 'log', '--format=%B', 'main');
    expect(bodies).toContain('Co-Authored-By: Cup Seven <cup-7@agents.papercusp>');
    // both files landed; the tree is clean.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('STRANDING GUARD (WI-1316 / 8186adfb5): a FAILED attributed commit (index.lock race) must NOT skip the catch-all — the remainder still commits', async () => {
    // mine.txt is attributed to cup-7 (peeled into its OWN commit first); other.txt is
    // unattributed (the catch-all remainder). We force the ONE attributed commit to fail
    // like the index.lock race that bit 2026-06-30. PRE-fix, syncOneRepo `return`-ed on
    // res.error and BOTH files stranded (mine.txt staged-uncommitted, other.txt untracked)
    // → an unbuildable tree ("Cannot find module"). POST-fix it logs + falls through to the
    // catch-all `git add -A`, so nothing strands. This is the deterministic guard WI-1316 asks
    // for: inject a runGit that fails the attributed commit but runs everything else for real.
    writeFileSync(join(repo, 'mine.txt'), 'a\n'); // attributed → cup-7
    writeFileSync(join(repo, 'other.txt'), 'b\n'); // unattributed → catch-all

    // A real-git runner (non-throwing: returns {code} instead of throwing on non-zero).
    const realGit: RunGit = async (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    // Fail ONLY the first attributed commit — the one carrying a `Papercusp-Agent:` trailer
    // (the catch-all auto-commit never does, so it runs for real). Do NOT execute it, exactly
    // like an index.lock race that never wrote the commit.
    let attributedCommitFailed = false;
    const runGit: RunGit = async (args, cwd) => {
      // WI-5111: commit calls now carry a leading `-c user.name=... -c
      // user.email=...` bot-identity override before the `commit` subcommand
      // (run-git-sync.ts GIT_SYNC_IDENTITY_ARGS) — match on inclusion, not
      // args[0], so this injected fault still targets the right call.
      const isAttributedCommit = args.includes('commit') && args.some((a) => a.startsWith('Papercusp-Agent:'));
      if (isAttributedCommit && !attributedCommitFailed) {
        attributedCommitFailed = true;
        return { code: 1, stdout: '', stderr: "fatal: Unable to create '.git/index.lock': File exists." };
      }
      return realGit(args, cwd);
    };

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      loadRoster: async () => [
        { agent: 'cup-7', agentLabel: 'Cup Seven', intent: 'wire the parser', files: ['mine.txt'] },
      ],
      runGit,
    });

    // The injected failure MUST have fired — else the test proves nothing.
    expect(attributedCommitFailed).toBe(true);
    // The catch-all recovered: the tree synced + pushed DESPITE the attributed-commit error.
    expect(out.status).toBe('synced');
    // BOTH files reached origin — the remainder did NOT strand (the core regression).
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('mine.txt');
    expect(originFiles).toContain('other.txt');
    // The attributed subject never landed (that commit failed); only the catch-all auto-commit did.
    const subjects = originLog();
    expect(subjects).not.toMatch(/wire the parser/);
    expect(subjects).toMatch(/auto-commit test/);
    // working tree clean after the catch-all swept the failed group's files + the remainder.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('returns "nothing" on a clean, up-to-date tree', async () => {
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('nothing');
  });

  // EI-438 content guard (P-001/P-002/P-008): the broken file is EXCLUDED from the
  // commit + left dirty (quarantine, don't stall) while every clean file still syncs.
  it('content guard: commits the clean files, EXCLUDES + reports a broken one (quarantine, dont stall)', async () => {
    writeFileSync(join(repo, 'good.txt'), 'fine\n');
    writeFileSync(join(repo, 'bad.md'), 'this is BROKEN\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out.status).toBe('synced'); // the clean file synced despite the broken sibling
    expect(out.contentErrors).toEqual([
      {
        scope: 'superproject',
        file: 'bad.md',
        detectorKey: 'fake-broken',
        error: 'contains BROKEN',
        fixerRole: 'content-fixer',
        contentHash: '0bec6cfbbb9c9e24fe0b0d0898eece375bfde10840e87aa2ed9a0b4293f94260',
        detectorResultHash: '1056f0bdc70c0c0ffadd4e0742c00323a07e7ae989c1bde9ca544f8615970720',
      },
    ]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('good.txt'); // the clean file reached origin…
    expect(originFiles).not.toContain('bad.md'); // …but the broken one did NOT (excluded)
    // the broken file is left dirty/uncommitted in the working tree for the content-fixer
    expect(git(repo, 'status', '--porcelain')).toContain('bad.md');
  });

  it('content guard: the NEXT tick commits the file once it passes the detector (self-heal)', async () => {
    writeFileSync(join(repo, 'bad.md'), 'this is BROKEN\n');
    await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('bad.md');

    // the content-fixer repairs the file (no longer BROKEN) → the next tick commits it
    writeFileSync(join(repo, 'bad.md'), 'this is fine now\n');
    const out2 = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out2.status).toBe('synced');
    expect(out2.contentErrors).toEqual([]);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('bad.md'); // now it reaches origin
    expect(git(repo, 'status', '--porcelain')).toBe(''); // tree clean
  });

  it('content guard: production commit path auto-repairs raw NUL bytes before quarantine', async () => {
    const nul = String.fromCharCode(0);
    writeFileSync(join(repo, 'keys.ts'), `export const key = \`${'${a}'}${nul}${'${b}'}\`;\n`, 'utf8');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(out.contentErrors).toEqual([]);
    expect(readFileSync(join(repo, 'keys.ts'), 'utf8')).toBe('export const key = `${a}\\x00${b}`;\n');
    expect(git(originDir, 'show', 'main:keys.ts')).toBe('export const key = `${a}\\x00${b}`;');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('content guard is a no-op when no detector matches the dirty files (clean tree commits as today)', async () => {
    writeFileSync(join(repo, 'plain.txt'), 'no detector targets .txt\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });
    expect(out.status).toBe('synced');
    expect(out.contentErrors).toEqual([]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  // EI-19932544083689229 remedy #1 (ATOMICITY): reproduces the live incident —
  // content-guard quarantines a broken SOURCE file; its clean *.test.* SIBLING
  // (which imports it via a relative specifier) must be held back TOO, not
  // committed alone. Pre-fix this test fails: the sibling test lands in HEAD
  // while its subject never does, and an isolated checkout gets an unresolvable
  // import forever.
  it('EI-19932544083689229: a dirty sibling that IMPORTS a content-guard-quarantined file is ALSO excluded (quarantine the pair, not just the broken half)', async () => {
    writeFileSync(join(repo, 'good.txt'), 'fine\n');
    writeFileSync(join(repo, 'watchdog.md'), 'this is BROKEN\n'); // content-guard quarantines this
    // The sibling "test" — clean text, but imports the quarantined file. Using a
    // real resolvable extension (.ts) + a relative specifier so the quarantine-import
    // guard's specifier scan actually fires (brokenDetector only targets *.md).
    writeFileSync(join(repo, 'watchdog.test.ts'), `import './watchdog.md';\nit('ok', () => {});\n`);

    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out.status).toBe('synced'); // the unrelated clean file still syncs
    const files = out.contentErrors.map((c) => c.file).sort();
    expect(files).toEqual(['watchdog.md', 'watchdog.test.ts']);
    const importerOffender = out.contentErrors.find((c) => c.file === 'watchdog.test.ts');
    expect(importerOffender?.detectorKey).toBe('quarantined-importer');
    expect(importerOffender?.error).toContain('watchdog.md');

    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('good.txt');
    expect(originFiles).not.toContain('watchdog.md'); // subject excluded (as before)
    expect(originFiles).not.toContain('watchdog.test.ts'); // NEW: importer excluded too — the fix
    // both the subject AND its importer are left dirty for the content-fixer
    const dirty = git(repo, 'status', '--porcelain');
    expect(dirty).toContain('watchdog.md');
    expect(dirty).toContain('watchdog.test.ts');
  });

  it('EI-21031600248610340: a tracked-but-modified quarantined dependency does not infect its importer', async () => {
    writeFileSync(join(repo, 'watchdog.md'), 'initial and committed\n');
    git(repo, 'add', 'watchdog.md');
    git(repo, 'commit', '--no-verify', '-m', 'seed tracked dependency');
    git(repo, 'push', 'origin', 'HEAD:main');

    writeFileSync(join(repo, 'watchdog.md'), 'this is BROKEN\n');
    writeFileSync(join(repo, 'watchdog.test.ts'), `import './watchdog.md';\nit('ok', () => {});\n`);

    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out.status).toBe('synced');
    expect(out.contentErrors.map((c) => c.file)).toEqual(['watchdog.md']);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('watchdog.md');
    expect(originFiles).toContain('watchdog.test.ts');
    expect(git(originDir, 'show', 'main:watchdog.md')).toBe('initial and committed');
    expect(git(repo, 'status', '--porcelain')).toContain('watchdog.md');
    expect(git(repo, 'status', '--porcelain')).not.toContain('watchdog.test.ts');
  });

  it('EI-19932544083689229: once the subject is fixed, the previously-held-back importer commits too (self-heal, no residual quarantine)', async () => {
    writeFileSync(join(repo, 'watchdog.md'), 'this is BROKEN\n');
    writeFileSync(join(repo, 'watchdog.test.ts'), `import './watchdog.md';\nit('ok', () => {});\n`);
    await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('watchdog.test.ts');

    // content-fixer repairs the subject (no longer BROKEN) — the NEXT tick commits both.
    writeFileSync(join(repo, 'watchdog.md'), 'this is fine now\n');
    const out2 = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out2.status).toBe('synced');
    expect(out2.contentErrors).toEqual([]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('watchdog.md');
    expect(originFiles).toContain('watchdog.test.ts');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  // G20: the joiner-side push:false runtime invariant — a dirty tree COMMITS
  // locally but origin/main must be byte-for-byte UNCHANGED. Asserts via the
  // origin tip SHA (not just the commit-subject log) and proves the fresh local
  // commit is genuinely absent from origin.
  it('commits locally but does not push when push:false (origin/main SHA unchanged)', async () => {
    writeFileSync(join(repo, 'local.txt'), 'x\n');
    const originTipBefore = git(originDir, 'rev-parse', 'main');
    const localTipBefore = git(repo, 'rev-parse', 'HEAD');

    const out = await runGitSync('test', { repoPath: repo, config: { push: false, pushSubmodules: false } });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toEqual([]);

    // a NEW local commit exists (HEAD advanced) and carries the auto-commit subject
    const localTipAfter = git(repo, 'rev-parse', 'HEAD');
    expect(localTipAfter).not.toBe(localTipBefore);
    expect(git(repo, 'log', '--format=%B', '-1')).toMatch(/auto-commit test/);

    // origin/main is UNCHANGED — same tip SHA, and the commit-subject log is identical
    expect(git(originDir, 'rev-parse', 'main')).toBe(originTipBefore);
    expect(originLog()).not.toMatch(/auto-commit test/);
    // and the bare origin does NOT have the fresh local commit object reachable on main
    expect(() => git(originDir, 'merge-base', '--is-ancestor', localTipAfter, 'main')).toThrow();
  });

  // p2p-git-live-activation P-306 (Leg E bridged/commit-only false-alarm question): on a
  // BRIDGED hive, member git-sync runs with push:false (decideGitSyncPush) and the bridge
  // writer is the sole origin pusher — so a member's `fetch` to origin can legitimately fail
  // (offline bridge writer, transient network) on every single tick. GAP-4's push:true branch
  // would classify that as `status: 'error'` (unpushed HEAD, cannot reconcile) — which, if it
  // ever happened here, would persist across ticks and eventually trip the git-sync-stall
  // watchdog's errorStall signal. Proves it CANNOT: with push:false, an unreachable origin
  // still yields a local commit + `status: 'synced'` (never 'error'), so a commit-only member
  // can never accumulate the watchdog's errorStall streak from its own (expected) push-less
  // state — the false alarm this leg exists to rule out.
  it('bridged/commit-only (push:false): an UNREACHABLE origin still commits locally and never reports "error" (git-sync-stall false-alarm guard)', async () => {
    writeFileSync(join(repo, 'local.txt'), 'x\n');
    const localTipBefore = git(repo, 'rev-parse', 'HEAD');
    // simulate the bridge writer being unreachable: point origin at a path with no repo there.
    git(repo, 'remote', 'set-url', 'origin', join(root, 'no-such-remote.git'));

    const out = await runGitSync('test', { repoPath: repo, config: { push: false, pushSubmodules: false } });

    expect(out.status).not.toBe('error');
    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toEqual([]);
    // HEAD still advanced — the local commit landed despite the unreachable remote.
    const localTipAfter = git(repo, 'rev-parse', 'HEAD');
    expect(localTipAfter).not.toBe(localTipBefore);
  });

  // Same fetch-unreachable scenario on a CLEAN tree (no dirty files): the commit-only member
  // reports 'nothing', which the watchdog's commitNotAttemptable exemption already treats as
  // never head-stale — confirms the quiet-idle path holds under bridged mode too.
  it('bridged/commit-only (push:false): an unreachable origin on a CLEAN tree reports "nothing", never "error"', async () => {
    git(repo, 'remote', 'set-url', 'origin', join(root, 'no-such-remote.git'));
    const out = await runGitSync('test', { repoPath: repo, config: { push: false, pushSubmodules: false } });
    expect(out.status).toBe('nothing');
  });

  it('EI-21025944774670342: zero-byte loose objects fail closed with a specific corruption diagnosis before fetch', async () => {
    const fanoutDir = join(repo, '.git', 'objects', 'aa');
    const objectName = '0'.repeat(38);
    const objectPath = join(fanoutDir, objectName);
    mkdirSync(fanoutDir, { recursive: true });
    writeFileSync(objectPath, '');

    const broken = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(broken.status).toBe('error');
    if (broken.status === 'error') {
      const messages = broken.errors.map((error) => error.message).join('\n');
      expect(messages).toContain('local Git object database corrupt: 1 zero-byte loose object(s)');
      expect(messages).toContain(`aa${objectName}`);
      expect(messages).toContain('repair required before fetch');
      expect(messages).not.toContain('fetch failed; HEAD has unpushed commits');
    }

    rmSync(objectPath);
    const recovered = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(recovered.status).toBe('nothing');
  });

  it('EI-20232774599730947: P2P commit-only skips direct superproject reconciliation, so a retained installer seed is not transplanted again', async () => {
    // Model the physical Mac after restore: a retained synthetic seed marker,
    // an unrelated GitHub main, and new local work that belongs in the P2P
    // namespace rather than a direct origin/main rebase.
    git(repo, 'checkout', '--orphan', 'seeded');
    git(repo, 'rm', '-rf', '.');
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git(repo, 'add', 'seed.txt');
    git(repo, 'commit', '--no-verify', '-m', 'papercusp seed snapshot HEAD');
    const seedRoot = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/papercusp-seed-snapshot-test', seedRoot);
    writeFileSync(join(repo, 'local-p2p.txt'), 'local P2P work\n');

    const originTipBefore = git(originDir, 'rev-parse', 'main');
    const out = await runGitSync('test', {
      repoPath: repo,
      config: {
        push: false,
        pushSubmodules: false,
        reconcileSuperprojectOrigin: false,
      },
    });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') {
      expect(out.pushed).toEqual([]);
      expect(out.merged).toEqual([]);
    }
    expect(git(originDir, 'rev-parse', 'main')).toBe(originTipBefore);
    expect(() => git(repo, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).toThrow();
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/papercusp/seed-recovery/')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('WI-10003527: a shallow clone whose HEAD and origin/main are both depth-1 deepens to a merge-base and fast-forwards instead of "refusing to merge unrelated histories"', async () => {
    // Model the P-203 VM submodule: HEAD is a depth-1 older remote commit, and
    // origin/main was later fetched at depth 1, so no merge-base exists locally
    // and a plain `git fetch` (tip already present) never supplies one.
    const seed = join(root, 'seed');
    const commit = (name: string) => {
      writeFileSync(join(seed, `${name}.txt`), `${name}\n`);
      git(seed, 'add', '-A');
      git(seed, 'commit', '--no-verify', '-m', name);
    };
    commit('c2');
    git(seed, 'push', 'origin', 'main');
    const shallowRepo = join(root, 'shallow');
    git(root, 'clone', '--depth', '1', `file://${originDir}`, shallowRepo);
    configUser(shallowRepo);
    for (const n of ['c3', 'c4', 'c5', 'c6']) commit(n);
    git(seed, 'push', 'origin', 'main');
    git(shallowRepo, 'fetch', '--depth', '1', 'origin', 'main');
    const originTip = git(originDir, 'rev-parse', 'main');
    expect(git(shallowRepo, 'rev-parse', 'origin/main')).toBe(originTip);
    expect(git(shallowRepo, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(() => git(shallowRepo, 'merge-base', 'HEAD', 'origin/main')).toThrow();

    const out = await runGitSync('test', { repoPath: shallowRepo, config: cfg });

    if (out.status === 'error') throw new Error(out.errors.map((e) => e.message).join('\n'));
    expect(git(shallowRepo, 'rev-parse', 'HEAD')).toBe(originTip);
    expect(git(shallowRepo, 'status', '--porcelain')).toBe('');
  });

  it('EI-20216304202023591: failed fetch removes only its fresh interrupted tmp_pack and reports reclaimed bytes', async () => {
    const packDir = join(repo, '.git', 'objects', 'pack');
    mkdirSync(packDir, { recursive: true });
    const existingTmpPack = join(packDir, 'tmp_pack_existing-from-before-fetch');
    const interruptedTmpPack = join(packDir, 'tmp_pack_interrupted-index-pack');
    writeFileSync(existingTmpPack, Buffer.alloc(64, 1));
    const reclaimedBytes = 8 * 1024 * 1024;
    const logs: string[] = [];
    const realRunGit: RunGit = async (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: r.status ?? -1,
        stdout: String(r.stdout ?? ''),
        stderr: `${String(r.stderr ?? '')}${r.error ? `\n${r.error.message}` : ''}`,
      };
    };
    const runGit: RunGit = async (args, cwd) => {
      if (args.includes('fetch')) {
        // Simulate index-pack being interrupted after writing a large partial pack.
        writeFileSync(interruptedTmpPack, Buffer.alloc(reclaimedBytes, 7));
        return { code: 128, stdout: '', stderr: 'fatal: early EOF\n' };
      }
      return realRunGit(args, cwd);
    };

    const out = await runGitSync('test', {
      repoPath: repo,
      runGit,
      config: { pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('nothing');
    expect(existsSync(interruptedTmpPack)).toBe(false);
    expect(existsSync(existingTmpPack)).toBe(true);
    expect(logs).toContain(
      `[git-sync] ${repo}: failed fetch cleanup; pruned 1 newly-created unreferenced tmp_pack file(s), reclaimed ${reclaimedBytes} bytes`,
    );
  });

  it('EI-20224214315801764: pre-fetch scavenger removes only old unopened unreferenced tmp_pack leftovers', async () => {
    const packDir = join(repo, '.git', 'objects', 'pack');
    mkdirSync(packDir, { recursive: true });
    const now = Date.now();
    const staleTmpPack = join(packDir, 'tmp_pack_crash-left');
    const freshTmpPack = join(packDir, 'tmp_pack_live-fetch');
    const openTmpPack = join(packDir, 'tmp_pack_open-by-fetch');
    const referencedTmpPack = join(packDir, 'tmp_pack_has-index');
    const directoryTmpPack = join(packDir, 'tmp_pack_directory');
    writeFileSync(staleTmpPack, Buffer.alloc(4096, 1));
    writeFileSync(freshTmpPack, Buffer.alloc(4096, 2));
    writeFileSync(openTmpPack, Buffer.alloc(4096, 3));
    writeFileSync(referencedTmpPack, Buffer.alloc(4096, 4));
    writeFileSync(`${referencedTmpPack}.idx`, 'index sidecar');
    mkdirSync(directoryTmpPack);
    const oldSeconds = (now - 10 * 60_000) / 1000;
    for (const path of [staleTmpPack, openTmpPack, referencedTmpPack]) utimesSync(path, oldSeconds, oldSeconds);
    const logs: string[] = [];

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      staleTempPackMs: 60_000,
      isTempPackOpen: async (path) => path === openTmpPack,
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('nothing');
    expect(existsSync(staleTmpPack)).toBe(false);
    expect(existsSync(freshTmpPack)).toBe(true); // below the age floor
    expect(existsSync(openTmpPack)).toBe(true); // open-state proof is required
    expect(existsSync(referencedTmpPack)).toBe(true); // the index sidecar is a reference
    expect(existsSync(directoryTmpPack)).toBe(true); // regular-file proof is required
    expect(logs).toContain(
      `[git-sync] ${repo}: stale tmp_pack cleanup; pruned 1 unopened unreferenced file(s), reclaimed 4096 bytes`,
    );
  });

  it('stale tmp_pack scavenger fails closed when open-state is unknown', async () => {
    const packDir = join(repo, '.git', 'objects', 'pack');
    mkdirSync(packDir, { recursive: true });
    const staleTmpPack = join(packDir, 'tmp_pack_unknown-open-state');
    writeFileSync(staleTmpPack, Buffer.alloc(32, 5));
    const oldSeconds = (Date.now() - STALE_TEMP_PACK_MS - 60_000) / 1000;
    utimesSync(staleTmpPack, oldSeconds, oldSeconds);

    const realRunGit: RunGit = async (args, cwd) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      return {
        code: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    };
    const out = await scavengeStaleTempPacks(realRunGit, repo, () => {}, {
      staleMs: 60_000,
      isOpen: async () => null,
    });

    expect(out).toEqual({ removed: [], bytesReclaimed: 0 });
    expect(existsSync(staleTmpPack)).toBe(true);
  });

  it('on a divergent conflict: aborts to a CLEAN tree and reports conflicted files', async () => {
    // a second clone pushes a conflicting change to origin/main
    const other = join(root, 'other');
    git(root, 'clone', originDir, other);
    configUser(other);
    writeFileSync(join(other, 'file.txt'), 'OTHER-EDIT\n');
    git(other, 'add', '-A');
    git(other, 'commit', '--no-verify', '-m', 'other change');
    git(other, 'push', 'origin', 'main');

    // the harness repo edits the SAME line, then syncs → merge conflict
    writeFileSync(join(repo, 'file.txt'), 'LOCAL-EDIT\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('conflict');
    if (out.status === 'conflict') {
      expect(out.conflicts.map((c) => c.scope)).toContain('superproject');
      expect(out.conflicts.find((c) => c.scope === 'superproject')?.conflictedFiles).toContain('file.txt');
    }
    // tree must be clean (not mid-merge) — agents must never see a conflicted tree
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // no merge in progress
    let inMerge = false;
    try {
      git(repo, 'rev-parse', '--verify', 'MERGE_HEAD');
      inMerge = true;
    } catch {
      inMerge = false;
    }
    expect(inMerge).toBe(false);
    // local commit is preserved
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('LOCAL-EDIT\n');
  });
});

describe('runGitSync (real git, with a submodule) — P-007 submodule-push-first', () => {
  let root: string;
  let superOrigin: string; // bare superproject origin
  let subOrigin: string; // bare submodule origin
  let repo: string; // the "harness" working clone (with submodule checked out)

  // file:// submodule add/update is blocked by default (CVE) — allow it in setup.
  const allowFile = ['-c', 'protocol.file.allow=always'];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-sub-'));
    superOrigin = join(root, 'super-origin.git');
    subOrigin = join(root, 'sub-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subOrigin);

    // seed the submodule's origin/main
    const subseed = join(root, 'subseed');
    git(root, 'clone', subOrigin, subseed);
    configUser(subseed);
    writeFileSync(join(subseed, 'sub.txt'), 'sub-v1\n');
    git(subseed, 'add', '-A');
    git(subseed, 'commit', '--no-verify', '-m', 'sub init');
    git(subseed, 'push', '-u', 'origin', 'main');

    // seed the superproject with the submodule at libs/sub
    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subOrigin, 'libs/sub');
    configUser(join(superseed, 'libs/sub'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + submodule');
    git(superseed, 'push', '-u', 'origin', 'main');

    // the harness working clone, with the submodule checked out
    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/sub'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('pushes the submodule branch to origin FIRST, then bumps+pushes the superproject pointer', () => {
    // dirty the submodule AND the superproject
    writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo }).then((out) => {
      expect(out.status).toBe('synced');
      if (out.status === 'synced') {
        expect(out.pushed).toContain('superproject');
        expect(out.pushed).toContain('libs/sub');
      }

      // submodule origin received the sub commit (pushed to main from detached HEAD)
      expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
      // The commit is now anchored to a local branch before it is pushed.
      expect(git(join(repo, 'libs/sub'), 'branch', '--show-current')).toBe('main');
      // superproject origin received the super commit
      expect(git(superOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);

      // the committed superproject pointer == the submodule's pushed HEAD (fresh clone resolves the pin)
      const subHead = git(join(repo, 'libs/sub'), 'rev-parse', 'HEAD');
      const pointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
      expect(pointer).toBe(subHead);
      // and that submodule commit exists on the submodule's origin (pin is reachable remotely)
      expect(() => git(subOrigin, 'cat-file', '-e', `${subHead}^{commit}`)).not.toThrow();
    });
  });

  it('EI-21234208817497976: clears an orphaned submodule .git/modules/**/index.lock and publishes the recovered gitlink', async () => {
    const subRepo = join(repo, 'libs/sub');
    writeFileSync(join(subRepo, 'sub-stale-lock-recovered.txt'), 'submodule work survived\n');

    // A checked-out submodule has a `.git` file in its worktree; the real index
    // lives under the superproject's `.git/modules/<path>` directory. Reproduce
    // the fleet incident at that actual path, not at the superproject index.
    const subGitDir = git(subRepo, 'rev-parse', '--absolute-git-dir');
    const lockPath = join(subGitDir, 'index.lock');
    writeFileSync(lockPath, 'partial index from a dead submodule writer');
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lockPath, tenMinAgo, tenMinAgo);

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status, JSON.stringify(out)).toBe('synced');
    expect(existsSync(lockPath)).toBe(false);
    expect(git(subOrigin, 'ls-tree', '-r', '--name-only', 'main')).toContain('sub-stale-lock-recovered.txt');

    // The parent must point at the submodule commit that was actually published,
    // so a fresh clone can resolve the pin rather than receiving a broken gitlink.
    const subHead = git(subRepo, 'rev-parse', 'HEAD');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(subHead);
    expect(() => git(subOrigin, 'cat-file', '-e', `${subHead}^{commit}`)).not.toThrow();
  });

  it('EI-20611320499473924: attaches a detached submodule to an existing same-tip default branch before committing', async () => {
    const subRepo = join(repo, 'libs/sub');
    // `git submodule update` leaves HEAD detached. Pre-create the default branch at
    // that exact tip, then leave HEAD detached so the attach-only-if-same-tip path runs.
    git(subRepo, 'branch', '-f', 'main', 'HEAD');
    expect(git(subRepo, 'branch', '--show-current')).toBe('');
    writeFileSync(join(subRepo, 'sub-same-tip.txt'), 'same-tip\n');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('synced');
    expect(git(subRepo, 'branch', '--show-current')).toBe('main');
    expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
  });

  it('WI-1871750: fast-forwards a dormant local branch to its descendant detached HEAD without losing dirty work', async () => {
    const subRepo = join(repo, 'libs/sub');
    git(subRepo, 'branch', '-f', 'main', 'HEAD');

    // Reproduce the SideStage failure: a submodule update/peer integration advanced
    // detached HEAD while the dormant local branch stayed at its ancestor. The
    // committed descendant and the still-dirty work must both survive attachment.
    writeFileSync(join(subRepo, 'detached-descendant.txt'), 'committed while detached\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'detached descendant work');
    writeFileSync(join(subRepo, 'dirty-after-descendant.txt'), 'must survive branch attachment\n');
    expect(git(subRepo, 'branch', '--show-current')).toBe('');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('synced');
    expect(git(subRepo, 'branch', '--show-current')).toBe('main');
    expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/detached descendant work/);
    expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
    expect(git(subOrigin, 'show', 'main:detached-descendant.txt')).toBe('committed while detached');
    expect(git(subOrigin, 'show', 'main:dirty-after-descendant.txt')).toBe('must survive branch attachment');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(git(subRepo, 'rev-parse', 'HEAD'));
  });

  it('WI-2144358: continues a unique exact-tip remote preservation branch instead of divergent local main', async () => {
    const subRepo = join(repo, 'libs/sub');
    const originMain = git(subRepo, 'rev-parse', 'origin/main');

    git(subRepo, 'switch', '--detach', 'HEAD');
    writeFileSync(join(subRepo, 'pin-basis.txt'), 'preserved remotely\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'preserved detached work');
    const preservedHead = git(subRepo, 'rev-parse', 'HEAD');
    git(subRepo, 'push', 'origin', 'HEAD:refs/heads/restart-pin-fixture');

    git(subRepo, 'switch', 'main');
    writeFileSync(join(subRepo, 'local-main-only.txt'), 'must not be moved\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'divergent local main work');
    const divergentMain = git(subRepo, 'rev-parse', 'main');

    git(subRepo, 'switch', '--detach', preservedHead);
    writeFileSync(join(subRepo, 'dirty-after-pin.txt'), 'must continue on the preserved branch\n');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status, JSON.stringify(out)).toBe('synced');
    expect(git(subRepo, 'branch', '--show-current')).toBe('restart-pin-fixture');
    expect(git(subRepo, 'rev-parse', 'main')).toBe(divergentMain);
    expect(git(subOrigin, 'rev-parse', 'main')).toBe(originMain);
    expect(git(subOrigin, 'show', 'restart-pin-fixture:pin-basis.txt')).toBe('preserved remotely');
    expect(git(subOrigin, 'show', 'restart-pin-fixture:dirty-after-pin.txt')).toBe(
      'must continue on the preserved branch',
    );
  });

  it('WI-2144358: a clean local branch can reconcile through another exact-tip remote branch', async () => {
    const subRepo = join(repo, 'libs/sub');
    git(subRepo, 'switch', '--create', 'merge-local');
    writeFileSync(join(subRepo, 'preserved-local-head.txt'), 'reachable on the remote pin\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'local named branch preserved remotely');
    git(subRepo, 'push', 'origin', 'HEAD:restart-pin-fixture');
    const preservedHead = git(subRepo, 'rev-parse', 'HEAD');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status, JSON.stringify(out)).toBe('synced');
    expect(git(subRepo, 'branch', '--show-current')).toBe('merge-local');
    expect(git(subOrigin, 'rev-parse', 'restart-pin-fixture')).toBe(preservedHead);
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(preservedHead);
  });

  it('WI-2144358: ambiguous exact-tip preservation branches keep divergent attachment fail-closed', async () => {
    const subRepo = join(repo, 'libs/sub');
    git(subRepo, 'switch', '--detach', 'HEAD');
    writeFileSync(join(subRepo, 'ambiguous-pin-basis.txt'), 'two possible continuation branches\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'ambiguous preserved detached work');
    const preservedHead = git(subRepo, 'rev-parse', 'HEAD');
    git(subRepo, 'push', 'origin', 'HEAD:refs/heads/restart-pin-a');
    git(subRepo, 'push', 'origin', 'HEAD:refs/heads/restart-pin-b');

    git(subRepo, 'switch', 'main');
    writeFileSync(join(subRepo, 'ambiguous-local-main.txt'), 'must stay untouched\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'ambiguous divergent main work');
    const divergentMain = git(subRepo, 'rev-parse', 'main');
    git(subRepo, 'switch', '--detach', preservedHead);
    writeFileSync(join(subRepo, 'ambiguous-dirty.txt'), 'must not choose arbitrarily\n');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((error) => error.message).join('\n')).toMatch(/divergent local branch 'main'/i);
    }
    expect(git(subRepo, 'branch', '--show-current')).toBe('');
    expect(git(subRepo, 'rev-parse', 'main')).toBe(divergentMain);
    expect(git(subOrigin, 'rev-parse', 'restart-pin-a')).toBe(preservedHead);
    expect(git(subOrigin, 'rev-parse', 'restart-pin-b')).toBe(preservedHead);
  });

  it('EI-20611320499473924: refuses a detached submodule whose local default branch diverges', async () => {
    const subRepo = join(repo, 'libs/sub');
    git(subRepo, 'branch', '-f', 'main', 'HEAD');
    // Advance the local main branch, then return to the old tip detached. Git-sync
    // must refuse to move/overwrite that divergent branch rather than strand work.
    git(subRepo, 'switch', 'main');
    writeFileSync(join(subRepo, 'sub-branch-only.txt'), 'branch-only\n');
    git(subRepo, 'add', '-A');
    git(subRepo, 'commit', '--no-verify', '-m', 'branch-only local work');
    git(subRepo, 'switch', '--detach', 'HEAD~1');
    writeFileSync(join(subRepo, 'sub-divergent.txt'), 'divergent\n');
    expect(git(subRepo, 'branch', '--show-current')).toBe('');

    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors.map((e) => e.message).join('\n')).toMatch(/divergent local branch 'main'/i);
    }
    expect(git(subRepo, 'branch', '--show-current')).toBe('');
    expect(git(subOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
  });

  it('EI-20329530284626235: restores a drifted initialized-submodule origin from canonical .gitmodules before push', async () => {
    const subRepo = join(repo, 'libs/sub');
    const staleOrigin = join(root, 'stale-https-equivalent.git');
    git(subRepo, 'remote', 'set-url', 'origin', staleOrigin);
    expect(git(subRepo, 'remote', 'get-url', 'origin')).toBe(staleOrigin);
    expect(git(repo, 'config', '-f', '.gitmodules', '--get', 'submodule.libs/sub.url')).toBe(subOrigin);

    writeFileSync(join(subRepo, 'sub-new.txt'), 'sub-v2\n');
    const out = await runGitSync('test', { repoPath: repo });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('libs/sub');
    expect(git(subRepo, 'remote', 'get-url', 'origin')).toBe(subOrigin);
    expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
  });

  it('EI-18689553108460319: superproject push:false (bridged-hive commit-only) does NOT strand the submodule — it still pushes to its own origin', () => {
    // Simulates git-sync-action's hive-mode override — the bridge writer is meant to
    // become the SOLE pusher of the superproject's canonical refs, never of an
    // unrelated, independently-hosted submodule library.
    //
    // WI-6016: that override now sets BOTH flags (`cfg.push = false` +
    // `cfg.pushSubmoduleOrigins = true`), so this simulation passes both to stay
    // faithful to production. A BARE `push:false` can no longer mean "still push
    // submodules": it is ambiguous — a JOINER (decideGitSyncPush joinerSide) carries
    // push:false for an entirely different reason and must push NOTHING, ANYWHERE
    // (the S0 no-direct-push invariant, AH-6 in code-plane-federation.test.ts, which
    // this test's original bare-push:false form directly contradicted at the same
    // input). Splitting the knob stays supported; it is now opt-IN rather than
    // fail-open.
    writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo, config: { push: false, pushSubmoduleOrigins: true } }).then((out) => {
      expect(out.status).toBe('synced');
      if (out.status === 'synced') {
        // the submodule still pushed to ITS OWN origin ...
        expect(out.pushed).toContain('libs/sub');
        // ... but the superproject did NOT (push:false is commit-only for it)
        expect(out.pushed).not.toContain('superproject');
      }
      // submodule origin received the sub commit
      expect(git(subOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
      // superproject origin did NOT receive the super commit — still local-only
      expect(git(superOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
      // the local superproject DOES have the pointer bump + local commit (commit-only, not skipped)
      expect(git(repo, 'log', '--format=%B', 'HEAD')).toMatch(/auto-commit test/);
    });
  });

  it.each(['missing', 'device', 'owner'] as const)('F6: independent submodule publication requires the owner key (%s)', async (signer) => {
    const subRepo = join(repo, 'libs/sub');
    const remoteBefore = git(subOrigin, 'rev-parse', 'main');
    const owner = generateEd25519KeypairDer();
    const device = generateEd25519KeypairDer();
    const scope = { hive_id: owner.pubkeyBase64, repo_key: 'parent-repo' };
    const beforePush = vi.fn(async (args: readonly string[], cwd: string) => {
      await requireHiveEffectAuthority(signer === 'missing' ? null : {
        ...scope,
        sign: async bytes => signWithPrivateKeyDer(signer === 'owner' ? owner.privateKeyDer : device.privateKeyDer, bytes),
      }, scope, ['git-sync-push', cwd, ...args]);
    });
    writeFileSync(join(subRepo, 'owner-fenced.txt'), 'local work survives refusal\n');

    const out = await runGitSync('test', {
      repoPath: repo, runGit: directRunGit,
      config: { push: false, pushSubmoduleOrigins: true }, beforePush,
    });

    expect(beforePush).toHaveBeenCalledWith(['push', 'origin', 'HEAD:main'], subRepo);
    expect(git(subRepo, 'rev-parse', 'HEAD')).not.toBe(remoteBefore);
    expect(git(subRepo, 'status', '--porcelain')).toBe('');
    if (signer === 'owner') {
      expect(out.status).toBe('synced');
      expect(git(subOrigin, 'rev-parse', 'main')).toBe(git(subRepo, 'rev-parse', 'HEAD'));
    } else {
      expect(out.status).toBe('error');
      if (out.status === 'error') expect(out.errors.map(e => e.message).join('\n')).toContain('owning hive key');
      expect(git(subOrigin, 'rev-parse', 'main')).toBe(remoteBefore);
    }
    expect(git(superOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
  });

  it('F6: submodule non-fast-forward retry reauthorizes before another push', async () => {
    const subRepo = join(repo, 'libs/sub');
    const remoteBefore = git(subOrigin, 'rev-parse', 'main');
    let pushes = 0;
    const beforePush = vi.fn(async () => {
      if (beforePush.mock.calls.length > 1) throw new Error('owner key no longer available');
    });
    const runGit: RunGit = async (args, cwd) => {
      if (args[0] === 'push') {
        pushes++;
        return { code: 1, stdout: '', stderr: '! [rejected] main -> main (non-fast-forward)' };
      }
      return directRunGit(args, cwd);
    };
    writeFileSync(join(subRepo, 'retry-fenced.txt'), 'preserved\n');
    const out = await runGitSync('test', {
      repoPath: repo, runGit, beforePush,
      config: { push: false, pushSubmoduleOrigins: true },
    });
    expect(out.status).toBe('error');
    expect(beforePush).toHaveBeenCalledTimes(2);
    expect(pushes).toBe(1);
    expect(git(subOrigin, 'rev-parse', 'main')).toBe(remoteBefore);
    expect(git(subRepo, 'rev-parse', 'HEAD')).not.toBe(remoteBefore);
  });

  it('EI-18689553108460319: `pushSubmoduleOrigins: false` opts a submodule back OUT of pushing too (explicit override still honored)', () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo, config: { pushSubmoduleOrigins: false } }).then((out) => {
      expect(out.status).toBe('synced');
      if (out.status === 'synced') {
        expect(out.pushed).not.toContain('libs/sub');
        expect(out.pushed).toContain('superproject');
      }
      // submodule origin did NOT receive the sub commit — still local-only
      expect(git(subOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
    });
  });

  it('reconciles a DIVERGED submodule (behind its origin) via fetch+merge+push instead of erroring', () => {
    // a peer advances the submodule's origin → the harness submodule is now behind
    const subOther = join(root, 'subother');
    git(root, 'clone', subOrigin, subOther);
    configUser(subOther);
    writeFileSync(join(subOther, 'peer.txt'), 'peer-sub-change\n');
    git(subOther, 'add', '-A');
    git(subOther, 'commit', '--no-verify', '-m', 'peer sub change');
    git(subOther, 'push', 'origin', 'main');

    // local change in the submodule → diverged (local commit on a now-behind base)
    writeFileSync(join(repo, 'libs/sub', 'local-sub.txt'), 'local-sub-change\n');

    return runGitSync('test', { repoPath: repo }).then((out) => {
      // the OLD pipeline returned {status:'error'} (non-fast-forward); now it merges
      expect(out.status).toBe('synced');
      if (out.status === 'synced') expect(out.pushed).toContain('libs/sub');
      // both the peer's and the local submodule commit are now on the submodule origin
      const subOriginFiles = git(subOrigin, 'ls-tree', '-r', '--name-only', 'main');
      expect(subOriginFiles).toContain('peer.txt');
      expect(subOriginFiles).toContain('local-sub.txt');
    });
  });

  it('GAP-4: a submodule unreachable while ahead → errors + defers the superproject PUSH (no broken gitlink) but still COMMITS it locally', () => {
    // dirty the submodule (→ ahead after its local commit) and the superproject
    writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');
    // Break the canonical URL as well as the initialized copy. EI-20329530284626235
    // deliberately heals copy-only drift from `.gitmodules`, so this test must model
    // a genuinely unreachable canonical origin rather than stale local configuration.
    const goneOrigin = join(root, 'gone.git');
    git(repo, 'config', '-f', '.gitmodules', 'submodule.libs/sub.url', goneOrigin);
    git(join(repo, 'libs/sub'), 'remote', 'set-url', 'origin', goneOrigin);

    return runGitSync('test', { repoPath: repo }).then((out) => {
      expect(out.status).toBe('error');
      if (out.status === 'error') {
        expect(out.errors.map((e) => e.scope)).toContain('libs/sub');
        // the superproject must NOT be pushed — its gitlink would point at an unpushed
        // submodule commit a fresh clone can't resolve.
        expect(out.pushed).not.toContain('superproject');
      }
      expect(git(superOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);

      // EI-20182436053613562: the deferral is PUSH-ONLY. The superproject's own dirty
      // file has no relationship to any submodule pointer, and a local commit publishes
      // nothing, so it must still land. Gating the commit on this same condition is what
      // let ONE permanently-failing submodule push (a GitHub 403 no retry can clear)
      // freeze every agent's work in the shared tree for 12h — including untracked files
      // that existed on no other disk.
      expect(git(repo, 'log', '--format=%B', 'HEAD')).toMatch(/auto-commit test/);
      expect(git(repo, 'status', '--porcelain', 'super-new.txt')).toBe('');
    });
  });
});

describe('runGitSync (real git, two submodules) — GAP-1 continue-past-conflict', () => {
  let root: string;
  let superOrigin: string;
  let subAOrigin: string; // will be made to conflict
  let subBOrigin: string; // clean, ahead → must still push despite A's conflict
  let repo: string;
  const allowFile = ['-c', 'protocol.file.allow=always'];

  const seedSub = (origin: string, name: string): void => {
    const seed = join(root, `${name}seed`);
    git(root, 'clone', origin, seed);
    configUser(seed);
    writeFileSync(join(seed, `${name}.txt`), `${name}-v1\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', `${name} init`);
    git(seed, 'push', '-u', 'origin', 'main');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-2sub-'));
    superOrigin = join(root, 'super-origin.git');
    subAOrigin = join(root, 'subA-origin.git');
    subBOrigin = join(root, 'subB-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subAOrigin);
    git(root, 'init', '--bare', '-b', 'main', subBOrigin);
    seedSub(subAOrigin, 'subA');
    seedSub(subBOrigin, 'subB');

    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subAOrigin, 'libs/subA');
    git(superseed, ...allowFile, 'submodule', 'add', subBOrigin, 'libs/subB');
    configUser(join(superseed, 'libs/subA'));
    configUser(join(superseed, 'libs/subB'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + 2 submodules');
    git(superseed, 'push', '-u', 'origin', 'main');

    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/subA'));
    configUser(join(repo, 'libs/subB'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a conflict in one submodule does NOT block the sibling push, and defers the superproject PUSH (but still commits it locally)', () => {
    // subA: a peer pushes a conflicting line to origin; local edits the SAME line → conflict
    const aOther = join(root, 'subAother');
    git(root, 'clone', subAOrigin, aOther);
    configUser(aOther);
    writeFileSync(join(aOther, 'subA.txt'), 'PEER-EDIT\n');
    git(aOther, 'add', '-A');
    git(aOther, 'commit', '--no-verify', '-m', 'peer conflicting change');
    git(aOther, 'push', 'origin', 'main');
    writeFileSync(join(repo, 'libs/subA', 'subA.txt'), 'LOCAL-EDIT\n'); // same line → will conflict

    // subB: a clean local change → must be pushed despite subA conflicting
    writeFileSync(join(repo, 'libs/subB', 'subB-new.txt'), 'subB-v2\n');
    // dirty the superproject too → must NOT be pushed while subA is unreconciled
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo }).then((out) => {
      // overall: conflict, but the sibling + nothing-after is reported precisely
      expect(out.status).toBe('conflict');
      if (out.status === 'conflict') {
        expect(out.conflicts.map((c) => c.scope)).toContain('libs/subA');
        expect(out.conflicts.find((c) => c.scope === 'libs/subA')?.conflictedFiles).toContain('subA.txt');
        // GAP-1: the clean sibling pushed despite subA's conflict
        expect(out.pushed).toContain('libs/subB');
        // GAP-1: the superproject was DEFERRED (a submodule is unreconciled)
        expect(out.pushed).not.toContain('superproject');
      }
      // subB origin actually received the push
      expect(git(subBOrigin, 'log', '--format=%B', 'main')).toMatch(/auto-commit test/);
      // superproject origin was NOT advanced (would publish an unresolvable subA pointer)
      expect(git(superOrigin, 'log', '--format=%B', 'main')).not.toMatch(/auto-commit test/);
      // subA tree is clean (merge aborted) — local edit preserved
      expect(git(join(repo, 'libs/subA'), 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(readFileSync(join(repo, 'libs/subA', 'subA.txt'), 'utf8')).toBe('LOCAL-EDIT\n');
      // EI-20182436053613562: the DEFERRAL IS PUSH-ONLY — the superproject's own dirty
      // file was still committed LOCALLY. Deferring the local commit too is what stranded
      // every agent's work for 12h behind one unreconcilable submodule.
      expect(git(repo, 'log', '--format=%B', 'HEAD')).toMatch(/auto-commit test/);
      expect(git(repo, 'status', '--porcelain', 'super-new.txt')).toBe('');
    });
  });

  it('EI-20744916065879285: maps protected superproject paths into submodule coordinates', async () => {
    // The caller speaks in superproject-root-relative paths. Both a root file and a
    // submodule file must remain unpublished, while unrelated work in each repo still
    // advances normally.
    writeFileSync(join(repo, 'super-protected.txt'), 'protected root mutation\n');
    writeFileSync(join(repo, 'super-normal.txt'), 'normal root work\n');
    writeFileSync(join(repo, 'libs/subA', 'subA.txt'), 'protected submodule mutation\n');
    writeFileSync(join(repo, 'libs/subB', 'subB-new.txt'), 'normal submodule work\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      excludePaths: [' super-protected.txt ', 'libs/subA/subA.txt'],
    });

    expect(out.status).toBe('synced');
    expect(git(superOrigin, 'show', 'main:super-normal.txt')).toBe('normal root work');
    expect(git(superOrigin, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('super-protected.txt');
    expect(git(subBOrigin, 'show', 'main:subB-new.txt')).toBe('normal submodule work');
    expect(git(subAOrigin, 'show', 'main:subA.txt')).toBe('subA-v1');
    expect(readFileSync(join(repo, 'super-protected.txt'), 'utf8')).toBe('protected root mutation\n');
    expect(readFileSync(join(repo, 'libs/subA', 'subA.txt'), 'utf8')).toBe('protected submodule mutation\n');
    expect(git(repo, 'status', '--porcelain', '--', 'super-protected.txt')).toMatch(/super-protected\.txt/);
    expect(git(join(repo, 'libs/subA'), 'status', '--porcelain', '--', 'subA.txt')).toMatch(/subA\.txt/);
  });

  it('EI-22435583452728403: maps refreshed root-relative locks into each submodule before staging', async () => {
    writeFileSync(join(repo, 'super-normal.txt'), 'normal root work\n');
    writeFileSync(join(repo, 'libs/subA', 'subA.txt'), 'protected submodule mutation\n');
    writeFileSync(join(repo, 'libs/subB', 'subB-new.txt'), 'normal submodule work\n');
    const refreshedHoldings = [{
      path: 'libs/subA/subA.txt',
      owner: 'su-peer',
      intent: 'submodule lock acquired after the initial census',
    }];
    const refreshLiveLockHoldings = vi.fn(async () => refreshedHoldings);

    const out = await runGitSync('test', {
      repoPath: repo,
      refreshLiveLockHoldings,
    });

    expect(refreshLiveLockHoldings).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('synced');
    expect(out.skippedPaths).toContainEqual({
      scope: 'libs/subA',
      path: 'subA.txt',
      owner: 'su-peer',
      intent: 'submodule lock acquired after the initial census',
    });
    expect(git(subAOrigin, 'show', 'main:subA.txt')).toBe('subA-v1');
    expect(git(subBOrigin, 'show', 'main:subB-new.txt')).toBe('normal submodule work');
    expect(git(superOrigin, 'show', 'main:super-normal.txt')).toBe('normal root work');
    expect(readFileSync(join(repo, 'libs/subA', 'subA.txt'), 'utf8')).toBe('protected submodule mutation\n');
    expect(git(join(repo, 'libs/subA'), 'status', '--porcelain', '--', 'subA.txt')).toMatch(/subA\.txt/);
  });
});

describe('runGitSync — EI-18 oversized-blob guard', () => {
  let root: string;
  let originDir: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-oversized-'));
    originDir = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', originDir);
    const seed = join(root, 'seed');
    git(root, 'clone', originDir, seed);
    configUser(seed);
    writeFileSync(join(seed, 'file.txt'), 'line1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'main');
    repo = join(root, 'repo');
    git(root, 'clone', originDir, repo);
    configUser(repo);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // A tiny limit so tests don't write real 95MB files.
  const cfg = { pushSubmodules: false, maxBlobBytes: 1024 } as const;

  it('EXCLUDES an oversized file from the auto-commit, still syncs the rest, and reports it', async () => {
    writeFileSync(join(repo, 'small.txt'), 'ok\n');
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(2048, 1));

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'big.bin', sizeBytes: 2048 }]);

    // origin received small.txt but NOT the unpushable blob
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('small.txt');
    expect(originFiles).not.toContain('big.bin');

    // the file is untouched on disk, just left uncommitted (untracked)
    expect(readFileSync(join(repo, 'big.bin')).length).toBe(2048);
    expect(git(repo, 'status', '--porcelain')).toContain('?? big.bin');
  });

  it('an oversized-ONLY dirty tree commits nothing ("nothing") but still reports the file', async () => {
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(4096, 1));
    const before = git(originDir, 'log', '--format=%B', 'main');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('nothing');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'big.bin', sizeBytes: 4096 }]);
    expect(git(originDir, 'log', '--format=%B', 'main')).toBe(before); // origin untouched
  });

  it('a clean tree under the limit reports no oversized files', async () => {
    writeFileSync(join(repo, 'fits.txt'), 'small enough\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('synced');
    expect(out.oversized).toEqual([]);
  });

  it('P-001: EXCLUDES an oversized file inside an UNTRACKED directory (-uall; the EI-18 bypass)', async () => {
    // A brand-new directory: without `-uall`, `git status --porcelain` collapses it to a
    // single `?? newdir/` entry whose lstat is a directory and is skipped — so the
    // oversized file inside is invisible, gets committed by `add -A`, and wedges the push
    // forever (the original EI-18 incident class). With `-uall` each file is listed.
    mkdirSync(join(repo, 'newdir'));
    writeFileSync(join(repo, 'newdir', 'big.bin'), Buffer.alloc(2048, 1));
    writeFileSync(join(repo, 'small.txt'), 'ok\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'newdir/big.bin', sizeBytes: 2048 }]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('small.txt');
    expect(originFiles).not.toContain('newdir/big.bin'); // the oversized blob never reached origin
  });

  it('oversized paths with spaces are excluded correctly (-z parsing + literal pathspec)', async () => {
    writeFileSync(join(repo, 'big file with spaces.bin'), Buffer.alloc(2048, 1));
    writeFileSync(join(repo, 'small.txt'), 'ok\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'big file with spaces.bin', sizeBytes: 2048 }]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('small.txt');
    expect(originFiles).not.toContain('big file with spaces.bin');
  });
});

describe('runGitSync — EI-18 oversized in a SUBMODULE does not defer the superproject', () => {
  const allowFile = ['-c', 'protocol.file.allow=always'];
  let root: string;
  let superOrigin: string;
  let subOrigin: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-oversized-sub-'));
    superOrigin = join(root, 'super-origin.git');
    subOrigin = join(root, 'sub-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subOrigin);

    const subseed = join(root, 'subseed');
    git(root, 'clone', subOrigin, subseed);
    configUser(subseed);
    writeFileSync(join(subseed, 'sub.txt'), 'sub-v1\n');
    git(subseed, 'add', '-A');
    git(subseed, 'commit', '--no-verify', '-m', 'sub init');
    git(subseed, 'push', '-u', 'origin', 'main');

    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subOrigin, 'libs/sub');
    configUser(join(superseed, 'libs/sub'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + submodule');
    git(superseed, 'push', '-u', 'origin', 'main');

    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/sub'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('submodule syncs WITHOUT the big file; superproject pointer still bumps + pushes', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-small.txt'), 'sub ok\n');
    writeFileSync(join(repo, 'libs/sub', 'sub-big.bin'), Buffer.alloc(2048, 1));
    writeFileSync(join(repo, 'super-new.txt'), 'super ok\n');

    const out = await runGitSync('test', { repoPath: repo, config: { maxBlobBytes: 1024 } });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') {
      expect(out.pushed).toContain('libs/sub');
      expect(out.pushed).toContain('superproject'); // NOT deferred by the exclusion
    }
    expect(out.oversized).toEqual([{ scope: 'libs/sub', path: 'sub-big.bin', sizeBytes: 2048 }]);

    // the submodule's origin got the small file, never the big one
    const subFiles = git(subOrigin, 'ls-tree', '-r', '--name-only', 'main');
    expect(subFiles).toContain('sub-small.txt');
    expect(subFiles).not.toContain('sub-big.bin');

    // the pushed superproject pointer resolves on the submodule origin (no broken gitlink)
    const pointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
    expect(() => git(subOrigin, 'cat-file', '-e', `${pointer}^{commit}`)).not.toThrow();
  });
});

describe('runGitSync — P-002 failure classification (injected git)', () => {
  /** A stub RunGit driven by a per-call decision fn — deterministic, no real git.
   *  WI-5111: commit/merge calls now carry a leading `-c user.name=... -c
   *  user.email=...` bot-identity override (run-git-sync.ts GIT_SYNC_IDENTITY_ARGS)
   *  BEFORE the subcommand — strip those global-flag pairs first (mirrors the
   *  production `gitSubcommand` skip-logic) so `handle`'s `args.join(' ').startsWith(...)`
   *  matchers still see the subcommand first, unaffected by the identity prefix. */
  const stripGitCFlags = (args: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '-C') {
        i++;
        continue;
      }
      out.push(args[i]!);
    }
    return out;
  };
  const fakeGit =
    (handle: (args: string[]) => { code: number; stdout?: string; stderr?: string }): RunGit =>
    async (args) => {
      const r = handle(stripGitCFlags(args));
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

  it('WI-10003100: overlaps sibling submodules but finishes children before parents', async () => {
    let releaseNested!: () => void;
    let releaseSibling!: () => void;
    let nestedEntered!: () => void;
    const nestedGate = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const enteredNested = new Promise<void>((resolve) => {
      nestedEntered = resolve;
    });
    const seen = new Set<string>();
    let siblingAWaiting = false;
    let siblingBEnteredWhileAWaiting = false;
    const run: RunGit = async (args, cwd) => {
      if (cwd !== '/fake' && !seen.has(cwd)) {
        seen.add(cwd);
        if (cwd === '/fake/libs/a/nested') {
          nestedEntered();
          await nestedGate;
        } else if (cwd === '/fake/libs/a') {
          siblingAWaiting = true;
          await siblingGate;
          siblingAWaiting = false;
        } else if (cwd === '/fake/libs/b') {
          siblingBEnteredWhileAWaiting = siblingAWaiting;
          releaseSibling();
        }
      }
      const command = stripGitCFlags(args).join(' ');
      if (command.startsWith('symbolic-ref')) return { code: 0, stdout: 'main', stderr: '' };
      if (command.startsWith('rev-parse HEAD')) return { code: 0, stdout: 'abc123', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const timeout = setTimeout(() => {
      releaseNested();
      releaseSibling();
    }, 2_000);
    try {
      const syncing = runGitSync('test', {
        repoPath: '/fake',
        runGit: run,
        submodulePaths: ['libs/a', 'libs/a/nested', 'libs/b'],
        config: { push: false, pushSubmoduleOrigins: false },
      });
      await enteredNested;
      expect(seen.has('/fake/libs/a')).toBe(false);
      expect(seen.has('/fake/libs/b')).toBe(false);
      releaseNested();
      await syncing;
      expect(siblingBEnteredWhileAWaiting).toBe(true);
      expect(seen).toEqual(new Set(['/fake/libs/a/nested', '/fake/libs/a', '/fake/libs/b']));
    } finally {
      clearTimeout(timeout);
      releaseNested();
      releaseSibling();
    }
  });

  it('P-002a: a commit failure is reported as error, NOT a phantom conflict', async () => {
    let commitAttempts = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' }; // no oversized
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' }; // dirty
      if (j.startsWith('add')) return { code: 0 };
      if (j.startsWith('rev-parse --absolute-git-dir')) return { code: 1, stderr: 'not a git directory' };
      if (j.startsWith('commit')) {
        commitAttempts++;
        return { code: 1, stderr: "fatal: Unable to create '.git/index.lock': File exists" };
      }
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });
    expect(out.status).toBe('error'); // NOT 'conflict' — no merge-resolver dispatched at a phantom
    if (out.status === 'error') {
      expect(out.errors.map((e) => e.scope)).toContain('superproject');
      expect(out.errors[0].message).toMatch(/commit failed/i);
    }
    expect(commitAttempts).toBe(1 + 3); // initial attempt + bounded live-contention retries
  });

  it('EI-21210284687094143: catch-all commit retries a transient live index.lock instead of red-sticking git-sync', async () => {
    let commitAttempts = 0;
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('add')) return { code: 0 };
      if (j.startsWith('rev-parse --absolute-git-dir')) return { code: 1, stderr: 'live holder' };
      if (j.startsWith('commit')) {
        commitAttempts++;
        if (commitAttempts === 1) {
          return {
            code: 128,
            stderr:
              "fatal: Unable to create '/fake/.git/index.lock': File exists.\n\nAnother git process seems to be running",
          };
        }
        return { code: 0 };
      }
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(commitAttempts).toBe(2);
    expect(logs.join('\n')).toContain("'git commit' hit live index.lock contention");
  });

  it('EI-20329530284626235: a failed canonical submodule URL sync is loud and blocks pushes', async () => {
    let fetchOrPushCalls = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j === 'submodule sync --recursive') return { code: 1, stderr: 'fatal: malformed .gitmodules URL' };
      if (j.startsWith('fetch') || j.startsWith('push')) fetchOrPushCalls++;
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('rev-parse HEAD')) return { code: 0, stdout: 'abc123' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', { repoPath: '/fake', runGit: run, submodulePaths: ['libs/sub'] });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors).toEqual([
        { scope: 'submodule-config', message: 'canonical submodule URL sync failed: fatal: malformed .gitmodules URL' },
      ]);
    }
    expect(fetchOrPushCalls).toBe(0);
  });

  it('EI-20347384139844425: live config.lock contention retries before failing the tick', async () => {
    let urlSyncAttempts = 0;
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j === 'submodule sync --recursive') {
        urlSyncAttempts++;
        if (urlSyncAttempts < 3) {
          return {
            code: 1,
            stderr: 'error: could not lock config file /fake/.git/config: File exists',
          };
        }
        return { code: 0 };
      }
      // Fail the stale-lock probe closed: this fixture represents a live writer,
      // never an orphan that git-sync is allowed to unlink.
      if (j === 'rev-parse --absolute-git-dir') return { code: 1, stderr: 'not a git directory' };
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count')) return { code: 0, stdout: '0' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: true, pushSubmoduleOrigins: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('nothing');
    expect(urlSyncAttempts).toBe(3);
    expect(logs.filter((message) => message.includes('live config.lock contention'))).toHaveLength(2);
  });

  it('P-002a: a commit that simply had nothing to commit (all-oversized) is NOT an error', async () => {
    // every dirty file was excluded as oversized → `git commit` exits non-zero with
    // "nothing to commit" — benign, must fall through to fetch/merge, not error.
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('add')) return { code: 0 };
      if (j.startsWith('commit')) return { code: 1, stdout: 'nothing to commit, working tree clean' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: false },
    });
    expect(out.status).toBe('nothing'); // benign — not an error
  });

  it('P-002b: a failed merge with NO conflicted paths is classified error, not conflict', async () => {
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' }; // clean tree
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge --no-edit'))
        return {
          code: 1,
          stderr: 'error: Your local changes to the following files would be overwritten by merge:\n  file.txt',
        };
      if (j.startsWith('diff --name-only --diff-filter=U')) return { code: 0, stdout: '' }; // NO unmerged paths
      if (j.startsWith('merge --abort')) return { code: 0 };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });
    expect(out.status).toBe('error'); // NOT 'conflict' — nothing for a merge-resolver to merge
    if (out.status === 'error') {
      expect(out.errors[0].message).toMatch(/merge failed \(no conflicted paths\)/);
      // A failed merge is not positive evidence that the merge stage completed.
      expect(out.mergeCompleted).toEqual([]);
    }
  });

  it('EI-20328688606935149: skips an authenticated no-op push when fetched origin already contains HEAD', async () => {
    let pushCalls = 0;
    let aheadChecks = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count origin/main..HEAD')) {
        aheadChecks++;
        return { code: 0, stdout: '0' };
      }
      if (j.startsWith('push')) {
        pushCalls++;
        return { code: 1, stderr: 'remote: You must verify your email address.' };
      }
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });

    expect(out.status).toBe('nothing');
    expect(aheadChecks).toBe(1);
    expect(pushCalls).toBe(0);
  });

  it('EI-20328688606935149: still pushes and reports a failure when HEAD is genuinely ahead', async () => {
    let pushCalls = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count origin/main..HEAD')) return { code: 0, stdout: '2' };
      if (j.startsWith('push')) {
        pushCalls++;
        return { code: 1, stderr: 'remote: You must verify your email address.' };
      }
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });

    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.errors[0]?.message).toMatch(/verify your email address/i);
      // The merge stage completed cleanly before the authenticated push failed. That
      // positive evidence must survive the error outcome so the action can retire an
      // earlier merge-conflict escalation without pretending the push succeeded.
      expect(out.mergeCompleted).toEqual(['superproject']);
    }
    expect(pushCalls).toBe(1);
  });

  it('EI-20328688606935149: fails open to the push when the ahead comparison is unavailable', async () => {
    let pushCalls = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count origin/main..HEAD')) return { code: 1, stderr: 'cannot resolve ref' };
      if (j.startsWith('push')) {
        pushCalls++;
        return { code: 0, stderr: 'Everything up-to-date' };
      }
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });

    expect(out.status).toBe('nothing');
    expect(pushCalls).toBe(1);
  });

  it('EI-18094449017685490: a transient ENOENT on `git add -A` (concurrent atomic-write race) is retried, not surfaced as an error', async () => {
    let addAttempts = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' }; // no oversized
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' }; // dirty
      if (j.startsWith('add')) {
        addAttempts++;
        // vanishes on the first two attempts (a concurrent atomic-write race), lands on the third
        if (addAttempts < 3) {
          return {
            code: 128,
            stderr: "fatal: unable to stat 'some/file.tmp.210675.abc': No such file or directory",
          };
        }
        return { code: 0 };
      }
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });
    expect(out.status).toBe('synced'); // NOT stranded on the transient race
    expect(addAttempts).toBe(3); // the original attempt + 2 retries before it resolved
  });

  it('WI-40170: an ignored protected path drops only its redundant exclusion pathspec and retries', async () => {
    const ignoredPath = 'tools/perf-test/wdio/package-lock.json';
    const stageableProtectedPath = 'tracked-protected.txt';
    const addCalls: string[][] = [];
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      // This case exercises the post-add stderr recovery path, so model the
      // preflight truthfully as "neither protected path is ignored" first.
      if (j.startsWith('check-ignore --')) return { code: 1, stdout: '' };
      if (j.startsWith('add')) {
        addCalls.push(args);
        if (addCalls.length === 1) {
          return {
            code: 1,
            stderr:
              'The following paths are ignored by one of your .gitignore files:\n' +
              `${ignoredPath}\n` +
              'hint: Use -f if you really want to add them.\n',
          };
        }
        return { code: 0 };
      }
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count')) return { code: 0, stdout: '0' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      excludePaths: [ignoredPath, stageableProtectedPath],
      config: { pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(addCalls).toHaveLength(2);
    expect(addCalls[0]).toContain(`:(exclude,literal)${ignoredPath}`);
    expect(addCalls[0]).toContain(`:(exclude,literal)${stageableProtectedPath}`);
    expect(addCalls[1]).not.toContain(`:(exclude,literal)${ignoredPath}`);
    expect(addCalls[1]).toContain(`:(exclude,literal)${stageableProtectedPath}`);
    expect(logs.join('\n')).toContain('retrying without force-adding ignored files');
    expect(
      addFailureIgnoredPaths(
        `The following paths are ignored by one of your .gitignore files:\n${ignoredPath}\nhint: Use -f`,
      ),
    ).toEqual([ignoredPath]);
  });

  it('WI-2144346: an ignored ancestor drops only protected descendant exclusions and retries', async () => {
    const ignoredAncestor = 'apps/shop/.astro';
    const ignoredDescendants = [
      `${ignoredAncestor}/collections/blog.schema.json`,
      `${ignoredAncestor}/content-modules.mjs`,
    ];
    const unrelatedProtectedPath = 'apps/shop/src/content/config.ts';
    const addCalls: string[][] = [];
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('check-ignore --')) return { code: 1, stdout: '' };
      if (j.startsWith('add')) {
        addCalls.push(args);
        if (addCalls.length === 1) {
          return {
            code: 1,
            stderr:
              'The following paths are ignored by one of your .gitignore files:\n' +
              `${ignoredAncestor}/\n` +
              'hint: Use -f if you really want to add them.\n',
          };
        }
        return { code: 0 };
      }
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count')) return { code: 0, stdout: '0' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      excludePaths: [...ignoredDescendants, unrelatedProtectedPath],
      config: { pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(addCalls).toHaveLength(2);
    for (const path of ignoredDescendants) {
      expect(addCalls[0]).toContain(`:(exclude,literal)${path}`);
      expect(addCalls[1]).not.toContain(`:(exclude,literal)${path}`);
    }
    expect(addCalls[1]).toContain(`:(exclude,literal)${unrelatedProtectedPath}`);
    expect(logs.join('\n')).toContain(`[${ignoredDescendants.join(', ')}]`);
    expect(logs.join('\n')).toContain('retrying without force-adding ignored files');
  });

  it('EI-21025874195651806: filters an ignored untracked protected path before the first add', async () => {
    const ignoredPath = 'tools/perf-test/wdio/package-lock.json';
    const stageableProtectedPath = 'tracked-protected.txt';
    const addCalls: string[][] = [];
    const checkIgnoreCalls: string[][] = [];
    const logs: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('check-ignore --')) {
        checkIgnoreCalls.push(args);
        // Default `git check-ignore` suppresses tracked files. The fake models
        // that contract: only the ignored-untracked path is returned, so the
        // tracked protected path must remain in the exclusion pathspec.
        const queried = args.at(-1);
        return queried === ignoredPath ? { code: 0, stdout: `${ignoredPath}\n` } : { code: 1, stdout: '' };
      }
      if (j.startsWith('add')) {
        addCalls.push(args);
        return { code: 0 };
      }
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      if (j.startsWith('rev-list --count')) return { code: 0, stdout: '0' };
      return { code: 0, stdout: '' };
    });

    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      excludePaths: [ignoredPath, stageableProtectedPath],
      config: { pushSubmodules: false },
      log: (message) => logs.push(message),
    });

    expect(out.status).toBe('synced');
    expect(checkIgnoreCalls).toEqual([
      ['check-ignore', '--', ignoredPath],
      ['check-ignore', '--', stageableProtectedPath],
    ]);
    expect(addCalls).toHaveLength(1); // no red first attempt + recovery retry
    expect(addCalls[0]).not.toContain(`:(exclude,literal)${ignoredPath}`);
    expect(addCalls[0]).toContain(`:(exclude,literal)${stageableProtectedPath}`);
    expect(logs.join('\n')).toContain('pre-filtering ignored untracked protected path');
  });

  it('EI-20201578457434474: live index.lock contention retries with bounded backoff before surfacing an error', async () => {
    let addAttempts = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('add')) {
        addAttempts++;
        if (addAttempts < 3) {
          return {
            code: 128,
            stderr:
              "fatal: Unable to create '/fake/.git/index.lock': File exists.\n\nAnother git process seems to be running",
          };
        }
        return { code: 0 };
      }
      // Make the stale-lock probe fail closed in this injected case: the lock is
      // live contention, not an orphan we are allowed to unlink.
      if (j.startsWith('rev-parse --absolute-git-dir')) return { code: 1, stderr: 'not a git directory' };
      if (j.startsWith('commit')) return { code: 0 };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: false },
    });
    expect(out.status).toBe('synced');
    expect(addAttempts).toBe(3); // original attempt + 2 bounded contention retries
  });

  it('EI-18094449017685490: exhausting the transient-ENOENT retry budget still surfaces a real error (never a silent strand)', async () => {
    let addAttempts = 0;
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('add')) {
        addAttempts++;
        return { code: 128, stderr: "fatal: unable to stat 'some/file.tmp.210675.abc': No such file or directory" };
      }
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { pushSubmodules: false },
    });
    expect(out.status).toBe('error'); // a REAL, persistent failure still surfaces loudly
    if (out.status === 'error') expect(out.errors[0].message).toMatch(/git add -A failed/i);
    expect(addAttempts).toBe(4); // 1 original + TRANSIENT_STAT_FAILURE_MAX_RETRIES(3) retries, then give up
  });

  it('P-004: a detached HEAD syncs to its OWN remote default (origin/HEAD → main), not cfg.branch', async () => {
    const fetched: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 1, stderr: 'fatal: ref HEAD is not a symbolic ref' }; // detached
      if (j.startsWith('rev-parse --abbrev-ref origin/HEAD')) return { code: 0, stdout: 'origin/main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' }; // clean
      if (j.startsWith('fetch')) {
        fetched.push(args.join(' '));
        return { code: 0 };
      }
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    // cfg.branch='staging' (the superproject's branch) must NOT be used for this detached repo.
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: run,
      submodulePaths: [],
      config: { push: false, pushSubmodules: false, branch: 'staging' },
    });
    expect(out.status).toBe('nothing'); // clean + up-to-date on main
    // it fetched origin MAIN (the remote default), never origin staging (cfg.branch)
    expect(fetched.join('|')).toContain('fetch origin main');
    expect(fetched.join('|')).not.toContain('staging');
  });
});

describe('discoverSubmodulesRecursive — stray-gitlink fallback (2026-07-01)', () => {
  // The incident: ONE index gitlink with no .gitmodules mapping (a test's temp repo swept
  // in by an auto-commit) makes `git submodule status --recursive` exit 128 — the old
  // silent-[] return then stranded EVERY submodule's commits, every tick, while the
  // routine kept reporting "synced". The fallback must (a) SAY SO and (b) still discover
  // the top-level submodules from .gitmodules.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gitsync-discover-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fakeGit =
    (onStatus: { code: number; stdout: string; stderr: string }): RunGit =>
    async (args: string[], _cwd: string) => {
      if (args[0] === 'submodule') return onStatus;
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        return {
          code: 0,
          stdout:
            'submodule.libs/a.path libs/a\nsubmodule.libs/deep/b.path libs/deep/b\nsubmodule.libs/uninit.path libs/uninit\n',
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

  it('healthy path: parses recursive status, deepest-first, skipping uninitialized', async () => {
    const runGit = fakeGit({
      code: 0,
      stdout: ' abc123 libs/a (v1)\n def456 libs/deep/b (v2)\n-000000 libs/uninit\n',
      stderr: '',
    });
    expect(await discoverSubmodulesRecursive(runGit, dir)).toEqual(['libs/deep/b', 'libs/a']);
  });

  it('recursive status failure falls back to .gitmodules (initialized only) and logs loudly', async () => {
    // Simulate initialized worktrees for libs/a + libs/deep/b (a .git file), NOT libs/uninit.
    mkdirSync(join(dir, 'libs', 'a'), { recursive: true });
    mkdirSync(join(dir, 'libs', 'deep', 'b'), { recursive: true });
    writeFileSync(join(dir, 'libs', 'a', '.git'), 'gitdir: ../../.git/modules/libs/a\n');
    writeFileSync(join(dir, 'libs', 'deep', 'b', '.git'), 'gitdir: ../../../.git/modules/libs/deep/b\n');
    const logs: string[] = [];
    const runGit = fakeGit({
      code: 128,
      stdout: '',
      stderr: "fatal: no submodule mapping found in .gitmodules for path '.papercusp/scratch/tmp/relgit-XYZ'",
    });
    const paths = await discoverSubmodulesRecursive(runGit, dir, (m) => logs.push(m));
    expect(paths).toEqual(['libs/deep/b', 'libs/a']); // deepest-first, uninit skipped
    expect(logs.join('\n')).toContain('submodule discovery FAILED');
    expect(logs.join('\n')).toContain('relgit-XYZ'); // the stray path is NAMED for the operator
    expect(logs.join('\n')).toContain('git rm --cached'); // ...with the fix command
  });

  // EI-20402093158205519: a '-' row means only that `submodule.<name>.url` is missing from
  // .git/config — NOT that the worktree is empty. On the sidestage tree 7 of 8 submodules
  // were '-'-prefixed yet fully populated, so discovery returned 1 path and three tracked
  // files sat uncommitted for days with no error on any tick. Discovery must not stay
  // silent about a populated worktree it is skipping while that worktree holds real work.
  it('POPULATED but unregistered submodule holding tracked changes is reported, not silently skipped', async () => {
    // libs/uninit is '-' (never `git submodule init`-ed) but its worktree is on disk with
    // a real .git AND two tracked modifications — exactly the silent-strand shape.
    mkdirSync(join(dir, 'libs', 'uninit', '.git'), { recursive: true });
    const logs: string[] = [];
    const runGit: RunGit = async (args: string[], cwd: string) => {
      if (args[0] === 'submodule') {
        return { code: 0, stdout: ' abc123 libs/a (v1)\n-000000 libs/uninit\n', stderr: '' };
      }
      if (args[0] === 'status' && cwd.endsWith(join('libs', 'uninit'))) {
        return { code: 0, stdout: ' M grid-core/src/RichGrid.tsx\n M grid-core/src/index.ts\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    const paths = await discoverSubmodulesRecursive(runGit, dir, (m) => logs.push(m));

    // Behavior is unchanged — reporting only. These worktrees commonly sit on deliberate
    // detached pins, so auto-syncing them would fetch/merge/push and UNPIN them.
    expect(paths).toEqual(['libs/a']);
    const out = logs.join('\n');
    expect(out).toContain('STRANDED WORK');
    expect(out).toContain('libs/uninit'); // the at-risk path is NAMED
    expect(out).toContain('2 tracked file(s)'); // ...with how much is at risk
    expect(out).toContain('git submodule init'); // ...and the operator fix command
  });

  it('unregistered submodule with NO tracked changes stays quiet (scratch churn must not cry wolf)', async () => {
    // Same shape, but the only dirt is untracked scratch (.vitest-tmp/ during a test run).
    // `--untracked-files=no` must make this a non-event, or the warning fires on every tick
    // that any suite happens to be running and is quickly learned to be noise.
    mkdirSync(join(dir, 'libs', 'uninit', '.git'), { recursive: true });
    const logs: string[] = [];
    const runGit: RunGit = async (args: string[]) =>
      args[0] === 'submodule'
        ? { code: 0, stdout: ' abc123 libs/a (v1)\n-000000 libs/uninit\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }; // tracked-only status → clean

    expect(await discoverSubmodulesRecursive(runGit, dir, (m) => logs.push(m))).toEqual(['libs/a']);
    expect(logs.join('\n')).not.toContain('STRANDED WORK');
  });

  it('fallback with no .gitmodules yields [] without throwing', async () => {
    const runGit: RunGit = async (args) =>
      args[0] === 'submodule'
        ? { code: 128, stdout: '', stderr: 'fatal: broken' }
        : { code: 1, stdout: '', stderr: 'no such file' };
    expect(await discoverSubmodulesRecursive(runGit, dir, () => {})).toEqual([]);
  });
});

/**
 * EI-20459175302238839 — `censusStrandedSubmodules`, the census extracted from
 * `discoverSubmodulesRecursive` so a release/deploy preflight can measure the SAME
 * condition without running a sync pass (one copy of the logic, never two).
 *
 * The contract that matters to every consumer is the THREE-VALUED result:
 *   null → NOT MEASURED (`git submodule status` failed)
 *   []   → measured, nothing stranded  (a real all-clear)
 *   [..] → measured, work is stranded
 *
 * A consumer that collapses `null` into `[]` reintroduces exactly the silence this
 * census exists to break, so both are asserted here rather than left implicit. Each
 * case is driven through a stub `RunGit` over a real temp dir — no network, no
 * submodules, and no dependency on this repo's own submodule layout.
 */
describe('censusStrandedSubmodules — the measured/unmeasured contract (EI-20459175302238839)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strand-census-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Mark `<dir>/<p>` as a POPULATED-but-unregistered submodule (the census lstats `.git`). */
  const populate = (p: string) => mkdirSync(join(dir, p, '.git'), { recursive: true });

  /** A stub git: `submodule status` returns `statusOut`, `status --porcelain` returns `dirty`. */
  const stub = (
    statusOut: { code: number; stdout: string },
    dirty: Record<string, string> = {},
  ): RunGit => {
    return async (args, cwd) => {
      if (args[0] === 'submodule') return { ...statusOut, stderr: '' };
      const rel = cwd.startsWith(dir) ? cwd.slice(dir.length + 1) : cwd;
      return { code: 0, stdout: dirty[rel] ?? '', stderr: '' };
    };
  };

  it('returns NULL when `git submodule status` fails — NOT MEASURED, never an all-clear', async () => {
    const logs: string[] = [];
    // ONE stray gitlink anywhere in the tree makes `submodule status --recursive` exit
    // non-zero, which is why this is a real and recurring case rather than a corner.
    const got = await censusStrandedSubmodules(
      stub({ code: 128, stdout: '' }),
      dir,
      (m) => logs.push(m),
    );

    expect(got).toBeNull();
    // Explicitly NOT `[]` — the whole point of the three-valued result.
    expect(got).not.toEqual([]);
    expect(logs.join('\n')).toMatch(/NOT MEASURED/);
    expect(logs.join('\n')).toMatch(/not an all-clear/i);
  });

  it('returns [] when measured with nothing stranded — a real all-clear', async () => {
    const got = await censusStrandedSubmodules(
      stub({ code: 0, stdout: ' abc123 libs/registered (v1)\n' }),
      dir,
    );
    expect(got).toEqual([]);
    expect(got).not.toBeNull();
  });

  it('reports a POPULATED but unregistered submodule holding uncommitted tracked work', async () => {
    populate('libs/token-kit');
    const got = await censusStrandedSubmodules(
      stub({ code: 0, stdout: '-000000 libs/token-kit\n' }, {
        'libs/token-kit': ' M package.json\n M src/index.ts\n',
      }),
      dir,
    );

    // This is the WI-38933 shape: a patch that exists on exactly one box and in no history.
    expect(got).toEqual([
      { path: 'libs/token-kit', trackedFiles: 2, files: ['package.json', 'src/index.ts'] },
    ]);
  });

  it('ignores a genuinely UNINITIALIZED submodule — nothing on disk can be stranded', async () => {
    // '-' means only that `submodule.<name>.url` is absent from .git/config; it says
    // nothing about whether the worktree exists. No `.git` on disk → no work to lose.
    const got = await censusStrandedSubmodules(
      stub({ code: 0, stdout: '-000000 libs/never-cloned\n' }, {
        'libs/never-cloned': ' M ghost.ts\n', // must not be reached
      }),
      dir,
    );
    expect(got).toEqual([]);
  });

  it('ignores a populated, unregistered submodule that is CLEAN', async () => {
    populate('libs/pinned');
    const got = await censusStrandedSubmodules(stub({ code: 0, stdout: '-000000 libs/pinned\n' }), dir);
    // Parked on a deliberate detached pin with no local edits — reporting it would cry
    // wolf on every tick, which is how a real warning gets tuned out.
    expect(got).toEqual([]);
  });

  it('counts TRACKED modifications only — untracked scratch must never cry wolf', async () => {
    populate('libs/pinned');
    const seen: string[][] = [];
    const runGit: RunGit = async (args, cwd) => {
      seen.push(args);
      if (args[0] === 'submodule') return { code: 0, stdout: '-000000 libs/pinned\n', stderr: '' };
      void cwd;
      return { code: 0, stdout: '', stderr: '' };
    };
    await censusStrandedSubmodules(runGit, dir);

    // The exclusion is structural, not a post-filter: a test run leaving .vitest-tmp/ in
    // a submodule would otherwise strand-flag it on every single tick.
    const statusArgs = seen.find((a) => a[0] === 'status');
    expect(statusArgs).toContain('--untracked-files=no');
  });

  it('a dirty-status failure inside one submodule does not strand-flag it or throw', async () => {
    populate('libs/broken');
    const runGit: RunGit = async (args) =>
      args[0] === 'submodule'
        ? { code: 0, stdout: '-000000 libs/broken\n', stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    // An unreadable submodule yields no ROWS, so it is reported as not-stranded rather
    // than crashing the census (and with it every caller, including the deploy gate).
    expect(await censusStrandedSubmodules(runGit, dir)).toEqual([]);
  });
});
